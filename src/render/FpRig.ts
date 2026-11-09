import {
  AnimationAction, AnimationMixer, Box3, BufferAttribute, BufferGeometry, Group, Matrix4, Object3D, Quaternion, SkinnedMesh, Vector3,
} from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CharacterAsset } from '@/core/Assets';

/** 팔로 취급할 본 이름 (어깨 제외: 가슴 조각이 화면 가장자리에 남지 않도록) */
const ARM_BONE = /^(Left|Right)(Arm|ForeArm|Hand)$/;

/**
 * 1인칭 팔 리그 — 레이븐 캐릭터 모델을 카메라에 붙이고 팔 삼각형만 남긴다.
 * - 스킨 가중치가 팔 본에 50% 이상 실린 정점으로만 이루어진 삼각형을 유지 (인덱스 필터)
 * - 머리 본을 카메라 원점에 맞춰 모델을 배치, 캐릭터는 -Z(카메라 전방)를 본다
 * - 조준 클립 = 기본 자세, 질주 클립 = 달리기. 총은 오른손 본 위치에 붙이고 왼손이 총열에 오도록 앞뒤 조정
 */
export class FpRig {
  readonly root = new Group();
  readonly model: Group;
  private readonly mixer: AnimationMixer;
  private readonly actions: Record<string, AnimationAction> = {};
  private current = '';
  private readonly head: Object3D | null;
  private readonly rightHand: Object3D | null;
  private readonly leftHand: Object3D | null;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  /** 머리 본이 놓일 카메라 로컬 위치. 실제 눈 위치보다 뒤·아래로 두어 손·총이 카메라에서 적당히 떨어지게 한다 */
  readonly headOffset = new Vector3(0.02, -0.17, 0.27);
  /** 달리기 중 리그를 끌어올리는 오프셋 (질주 클립은 손이 허리 높이라 화면 밖으로 나간다) */
  readonly sprintLift = new Vector3(-0.06, 0.24, -0.42);
  /** 달리기 중 총 방향 (아래·안쪽·앞) */
  private static readonly SPRINT_DIR = new Vector3(-0.45, -0.3, -0.85).normalize();
  private readonly qHands = new Quaternion();
  private readonly qSprint = new Quaternion();
  private readonly tmp3 = new Vector3();
  /** 전신 대비 1인칭 팔 축소 비율 (가까운 팔이 너무 굵어 보이지 않게) */
  readonly armScale = 0.88;
  /** 총 홀더 추가 오프셋(오른손 기준) */
  readonly gunOffset = new Vector3(0.0, -0.01, 0.0);
  /** 총 중심이 오른손보다 앞으로 나가는 거리 (그립이 오른손에 오도록) */
  readonly gripShift = 0.14;
  private readonly lookM = new Matrix4();
  private static readonly UP = new Vector3(0, 1, 0);
  private rifle: Object3D | null = null;
  private holder: Group | null = null;

  constructor(asset: CharacterAsset, layer: number) {
    this.model = skeletonClone(asset.scene) as Group;
    // 팔만 남기기
    this.model.traverse((o) => {
      const sm = o as SkinnedMesh;
      if (!sm.isSkinnedMesh) return;
      sm.geometry = FpRig.filterToArms(sm);
      sm.frustumCulled = false;
      sm.castShadow = false;
      sm.receiveShadow = false;
    });
    // 높이 1.8m 정규화 (봇과 동일 측정 방식)
    const measure = (): Box3 => {
      this.model.updateMatrixWorld(true);
      this.model.traverse((o) => {
        const sm = o as SkinnedMesh;
        if (sm.isSkinnedMesh) sm.skeleton.update();
      });
      return new Box3().setFromObject(this.model, true);
    };
    // 필터 전 전체 높이를 알 수 없으므로 원본 에셋으로 1회 측정
    const probe = skeletonClone(asset.scene) as Group;
    probe.updateMatrixWorld(true);
    probe.traverse((o) => {
      const sm = o as SkinnedMesh;
      if (sm.isSkinnedMesh) sm.skeleton.update();
    });
    const full = new Box3().setFromObject(probe, true);
    const height = full.getSize(new Vector3()).y || 1.8;
    const scale = (1.8 / height) * this.armScale;
    this.model.scale.setScalar(scale);
    measure();
    this.model.rotation.y = Math.PI; // 캐릭터가 카메라 전방(-Z)을 보도록
    this.root.add(this.model);
    this.root.traverse((o) => o.layers.set(layer));

    this.head = this.findBone(/^Head$/);
    this.rightHand = this.findBone(/^RightHand$/);
    this.leftHand = this.findBone(/^LeftHand$/);

    this.mixer = new AnimationMixer(this.model);
    for (const [name, clip] of Object.entries(asset.clips)) this.actions[name] = this.mixer.clipAction(clip);
    // 기본 자세: 'shoot'(전방 조준 보행) — 양손이 총열 선상에 안정적으로 놓인다
    this.play(this.actions.shoot ? 'shoot' : this.actions.aim ? 'aim' : 'idle', 0);
    if (this.actions.shoot) this.actions.shoot.timeScale = 0.25;
    this.mixer.update(0.5);
  }

  private findBone(re: RegExp): Object3D | null {
    let found: Object3D | null = null;
    this.model.traverse((o) => {
      if (!found && re.test(o.name)) found = o;
    });
    return found;
  }

  /** 팔 본 가중치가 우세한 정점만 포함하는 삼각형으로 인덱스를 재구성 */
  private static filterToArms(sm: SkinnedMesh): BufferGeometry {
    const src = sm.geometry;
    const geo = src.clone();
    const bones = sm.skeleton.bones;
    const armIdx = new Set<number>();
    bones.forEach((b, i) => {
      if (ARM_BONE.test(b.name)) armIdx.add(i);
    });
    const si = src.getAttribute('skinIndex') as BufferAttribute;
    const sw = src.getAttribute('skinWeight') as BufferAttribute;
    const n = si.count;
    const keep = new Uint8Array(n);
    for (let v = 0; v < n; v++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (armIdx.has(si.getComponent(v, k))) w += sw.getComponent(v, k);
      keep[v] = w >= 0.5 ? 1 : 0;
    }
    const index = src.getIndex();
    const out: number[] = [];
    if (index) {
      for (let t = 0; t < index.count; t += 3) {
        const a = index.getX(t);
        const b = index.getX(t + 1);
        const c = index.getX(t + 2);
        if (keep[a] && keep[b] && keep[c]) out.push(a, b, c);
      }
    } else {
      for (let t = 0; t < n; t += 3) if (keep[t] && keep[t + 1] && keep[t + 2]) out.push(t, t + 1, t + 2);
    }
    geo.setIndex(out);
    geo.clearGroups();
    return geo;
  }

  private play(name: string, fade = 0.15): void {
    if (this.current === name) return;
    const next = this.actions[name];
    if (!next) return;
    const prev = this.actions[this.current];
    next.reset().fadeIn(fade).play();
    if (prev) prev.fadeOut(fade);
    this.current = name;
  }

  /** 총 홀더(총열 -Z, 중심 원점)를 리그에 연결. 매 프레임 오른손에 따라간다 */
  attachGun(holder: Group, rifle: Object3D): void {
    this.holder = holder;
    this.rifle = rifle;
    this.root.add(holder);
  }

  /**
   * @param sprintBlend 0..1 달리기 블렌드
   * @param firing 사격 중이면 조준 클립을 정속 재생
   */
  update(dt: number, sprintBlend: number, firing: boolean): void {
    if (sprintBlend > 0.5 && this.actions.run) {
      this.play('run', 0.2);
      this.actions.run.timeScale = 1.1;
    } else if (this.actions.shoot) {
      this.play('shoot', 0.25);
      this.actions.shoot.timeScale = firing ? 0.9 : 0.25;
    }
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);

    // 머리 본 → 카메라 기준 위치 정렬 (달리기 중엔 위로 끌어올림)
    if (this.head) {
      this.head.getWorldPosition(this.tmp);
      this.root.worldToLocal(this.tmp);
      this.tmp3.copy(this.headOffset).addScaledVector(this.sprintLift, sprintBlend);
      this.model.position.add(this.tmp3.sub(this.tmp));
      this.root.updateMatrixWorld(true);
    }

    // 총: 오른손 위치에서 왼손 방향으로 총열을 맞춘다 (양손이 총 위에 놓임). 그립은 오른손에
    if (this.holder && this.rightHand && this.rifle) {
      this.rightHand.getWorldPosition(this.tmp);
      this.root.worldToLocal(this.tmp);
      this.holder.position.copy(this.tmp).add(this.gunOffset);
      if (this.leftHand) {
        this.leftHand.getWorldPosition(this.tmp2);
        this.root.worldToLocal(this.tmp2);
        // 조준: -Z가 왼손 방향 (양손이 총 위에). 달리기: 고정된 하향 전방 캐리 자세. 둘을 블렌드
        this.lookM.lookAt(this.tmp, this.tmp2, FpRig.UP);
        this.qHands.setFromRotationMatrix(this.lookM);
        this.tmp3.copy(this.tmp).add(FpRig.SPRINT_DIR);
        this.lookM.lookAt(this.tmp, this.tmp3, FpRig.UP);
        this.qSprint.setFromRotationMatrix(this.lookM);
        this.holder.quaternion.copy(this.qHands).slerp(this.qSprint, sprintBlend);
      } else this.holder.rotation.set(0, 0, 0);
      this.rifle.position.z = -this.gripShift;
    }
  }
}
