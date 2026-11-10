import {
  AnimationAction, AnimationClip, AnimationMixer, Group, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3,
} from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** 보행 클립의 접지 발 속도(m/s). tools/blender/build_bot_rig.py의 GAITS와 같아야 발이 미끄러지지 않는다 */
const CLIP_SPEED: Record<string, number> = { walk: 1.6, jog: 2.8, run: 5.5, sprint: 8.25, back: 5.5 };
/** 허리 비틀림 한계(라디안). 넘으면 다리가 조준 쪽으로 끌려온다. 옆걸음 때 몸이 과하게 꼬이지 않게 봇(1.9)보다 작게 둔다 */
const MAX_TWIST = 1.57;
/** 재장전 클립이 움직이는 본(팔·총·탄창). 보행 클립에서는 이 트랙을 빼고, 재장전 클립에는 이 트랙만 남긴다 */
const ARM_TRACK = /^(gun|mag|muzzle|upper[LR]|fore[LR]|hand[LR])\./;
const UP = new Vector3(0, 1, 0);
/** 몸 모델(키 1.8m)을 플레이어 눈높이 1.6m에 맞추는 배율 */
const BODY_SCALE = 0.95;

export interface PlayerBodyState {
  pos: Vector3;
  /** 카메라 요(라디안). 정면 = (-sin, 0, -cos) */
  yaw: number;
  /** 카메라 피치(위가 +) */
  pitch: number;
  onGround: boolean;
  /** 재장전 진행률 0..1, 재장전 중이 아니면 null */
  reload: number | null;
  /** 사격 반동 0..1 */
  kick: number;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * 주인공의 3인칭 몸. 적 봇과 같은 리그·보행 클립에 팔 관절과 재장전 클립이 더해진 player_rig.glb를 쓴다.
 * 다리는 이동 방향을, 상체는 조준 방향을 향하고(허리 비틀림), 팔·총은 조준 피치만큼 어깨 축으로 돈다.
 * 재장전은 무기의 진행률에 클립 시간을 직접 맞춘다(1인칭·효과음과 같은 시간표).
 */
export class PlayerBody {
  readonly group = new Group();
  private readonly mixer: AnimationMixer;
  private readonly actions: Record<string, AnimationAction> = {};
  private readonly weights: Record<string, number> = {};
  private reloadAction: AnimationAction | null = null;
  private reloadBlend = 0;
  private readonly torso: Object3D | null;
  private readonly arms: Object3D | null;
  private readonly muzzle: Object3D | null;
  private readonly clean: Quaternion[] = [];
  private readonly poseBones: Object3D[] = [];
  private legsYaw = 0;
  private backpedal = false;
  private gait = 'idle';
  private readonly vel = new Vector3();
  private readonly raw = new Vector3();
  private readonly lastPos = new Vector3();
  private hasLast = false;
  private deathT = -1;
  private readonly q = new Quaternion();
  private readonly qp = new Quaternion();
  private readonly axis = new Vector3();

  constructor(source: Group, clips: AnimationClip[]) {
    const model = skeletonClone(source) as Group;
    model.rotation.y = Math.PI; // glTF 정면(-Z)을 그룹의 +Z 정면으로
    model.scale.setScalar(BODY_SCALE);
    const cache = new Map<unknown, MeshStandardMaterial>();
    model.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((orig) => {
        let mm = cache.get(orig);
        if (!mm) {
          mm = (orig as MeshStandardMaterial).clone();
          mm.envMapIntensity = 0.4;
          if (mm.name === 'bot_visor') {
            mm.emissive.setHex(0x7fe0ff);
            mm.emissiveIntensity = 0.9;
          }
          cache.set(orig, mm);
        }
        return mm;
      });
      m.material = mats.length === 1 ? mats[0] : mats;
      m.castShadow = true;
      m.frustumCulled = false;
    });
    this.group.add(model);
    this.group.rotation.order = 'YXZ';
    this.torso = model.getObjectByName('torso') ?? null;
    this.arms = model.getObjectByName('armsgun') ?? null;
    this.muzzle = model.getObjectByName('muzzle') ?? null;
    for (const b of [this.torso, this.arms]) {
      if (!b) continue;
      this.poseBones.push(b);
      this.clean.push(b.quaternion.clone());
    }
    this.mixer = new AnimationMixer(model);
    for (const clip of clips) {
      const isReload = clip.name === 'reload';
      const c = clip.clone();
      c.tracks = c.tracks.filter((t) => ARM_TRACK.test(t.name) === isReload);
      const a = this.mixer.clipAction(c);
      a.play();
      a.setEffectiveWeight(0);
      if (isReload) {
        a.timeScale = 0; // 시간은 진행률로 직접 맞춘다
        this.reloadAction = a;
      } else {
        this.actions[clip.name] = a;
        this.weights[clip.name] = clip.name === 'idle' ? 1 : 0;
      }
    }
    this.group.visible = false;
  }

  reset(yaw: number): void {
    this.legsYaw = yaw + Math.PI;
    this.deathT = -1;
    this.group.rotation.set(0, this.legsYaw, 0);
    this.reloadBlend = 0;
    this.hasLast = false;
    this.vel.set(0, 0, 0);
  }

  /** 총구 월드 위치 (탄환·섬광 출발점) */
  getMuzzle(out: Vector3): Vector3 {
    if (this.muzzle) return this.muzzle.getWorldPosition(out);
    return out.copy(this.group.position).setY(this.group.position.y + 1.35);
  }

  update(dt: number, s: PlayerBodyState): void {
    const aimYaw = s.yaw + Math.PI;
    // 실제 이동량에서 속도를 구한다 (컨트롤러의 vel은 수평 이동을 담지 않는다)
    if (this.hasLast && dt > 0) {
      this.raw.copy(s.pos).sub(this.lastPos).multiplyScalar(1 / dt);
      if (this.raw.lengthSq() > 30 * 30) this.raw.set(0, 0, 0); // 순간이동(부활·대시)은 걸음으로 치지 않는다
      this.vel.lerp(this.raw, Math.min(1, dt * 18));
    }
    this.lastPos.copy(s.pos);
    this.hasLast = true;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const moving = speed > 0.9;
    let target = aimYaw;
    if (moving) {
      const moveYaw = Math.atan2(this.vel.x, this.vel.z);
      const rel = Math.abs(wrap(moveYaw - aimYaw));
      // 뒤로 가는 중이면 다리를 뒤집고 뒷걸음 클립 (경계에서 떨지 않게 여유를 둔다)
      this.backpedal = this.backpedal ? rel > 1.4 : rel > 1.92;
      target = this.backpedal ? moveYaw + Math.PI : moveYaw;
    } else this.backpedal = false;
    let d = wrap(target - this.legsYaw);
    // 거의 반대로 돌 때는 조준 쪽을 지나가는 방향으로 (반대로 돌면 상체가 한 바퀴 돈다)
    if (Math.abs(d) > 2.6) {
      const side = wrap(aimYaw - this.legsYaw);
      if (Math.abs(side) > 0.2 && Math.sign(side) !== Math.sign(d)) d = Math.sign(side) * (Math.PI * 2 - Math.abs(d));
    }
    const maxTurn = (moving ? 9 : 5) * dt;
    this.legsYaw += Math.max(-maxTurn, Math.min(maxTurn, d));
    const twist = Math.max(-MAX_TWIST, Math.min(MAX_TWIST, wrap(aimYaw - this.legsYaw)));
    // 비틀림 한계를 넘으면 다리가 따라 돈다
    this.legsYaw = aimYaw - twist;
    this.group.position.copy(s.pos);
    this.group.rotation.set(0, this.legsYaw, 0);

    // 클립 선택: 속도 구간(걷기·조깅·달리기 발 속도의 기하평균 경계)
    let name = 'idle';
    if (moving) name = this.backpedal ? 'back' : speed < 2.12 ? 'walk' : speed < 3.92 ? 'jog' : speed < 6.74 || !this.actions.sprint ? 'run' : 'sprint';
    if (!this.actions[name]) name = 'idle';
    // Gait-to-gait: bring the incoming clip to the same stride phase as the outgoing one so the feet line up while blending.
    if (name !== this.gait) {
      const from = this.actions[this.gait];
      const to = this.actions[name];
      if (from && to && name !== 'idle' && this.gait !== 'idle' && this.weights[name] < 0.05) {
        to.time = (from.time / from.getClip().duration) * to.getClip().duration;
      }
      this.gait = name;
    }
    let sum = 0;
    for (const k of Object.keys(this.actions)) {
      const w = this.weights[k] + ((k === name ? 1 : 0) - this.weights[k]) * Math.min(1, dt * 10);
      this.weights[k] = w;
      sum += w;
    }
    for (const k of Object.keys(this.actions)) {
      const a = this.actions[k];
      a.setEffectiveWeight(this.weights[k] / (sum || 1));
      const cs = CLIP_SPEED[k];
      // 공중에서는 다리를 천천히 젓는다
      a.timeScale = cs ? (s.onGround ? Math.max(0.4, speed / cs) : 0.35) : 1;
    }
    this.reloadBlend += ((s.reload !== null ? 1 : 0) - this.reloadBlend) * Math.min(1, dt * 14);
    if (this.reloadAction) {
      if (s.reload !== null) this.reloadAction.time = s.reload * this.reloadAction.getClip().duration;
      this.reloadAction.setEffectiveWeight(this.reloadBlend);
    }

    // 믹서는 값이 그대로면 다시 쓰지 않으므로, 지난 프레임의 절차적 회전을 먼저 지운다(누적 방지)
    for (let i = 0; i < this.poseBones.length; i++) this.poseBones[i].quaternion.copy(this.clean[i]);
    this.mixer.update(dt);
    for (let i = 0; i < this.poseBones.length; i++) this.clean[i].copy(this.poseBones[i].quaternion);

    this.group.updateMatrixWorld(true);
    if (this.torso && Math.abs(twist) > 1e-3) this.rotateWorld(this.torso, this.q.setFromAxisAngle(UP, twist));
    if (this.arms) {
      this.group.updateMatrixWorld(true);
      // 재장전 중에는 총을 수평 가까이 둔다
      const pitch = Math.max(-0.9, Math.min(0.9, s.pitch * (1 - 0.6 * this.reloadBlend) + s.kick * 0.05));
      this.axis.set(-Math.cos(aimYaw), 0, Math.sin(aimYaw));
      this.rotateWorld(this.arms, this.q.setFromAxisAngle(this.axis, pitch));
    }
  }

  /** 사망: 뒤로 쓰러진다. Player가 사망 상태 동안 매 스텝 호출 */
  updateDeath(dt: number): void {
    if (this.deathT < 0) this.deathT = 0;
    this.deathT += dt;
    const k = Math.min(1, this.deathT / 0.6);
    const ease = k * k;
    const bounce = k >= 1 ? Math.max(0, Math.sin(Math.min(1, (this.deathT - 0.6) / 0.25) * Math.PI)) * 0.05 : 0;
    this.group.rotation.x = -(Math.PI / 2 - 0.08) * ease + bounce;
    this.mixer.update(0);
  }

  /** 월드 회전 q를 본에 적용: L' = Wp⁻¹ · q · Wp · L */
  private rotateWorld(bone: Object3D, q: Quaternion): void {
    const wp = bone.parent ? bone.parent.getWorldQuaternion(this.qp) : this.qp.identity();
    const inv = wp.clone().invert();
    bone.quaternion.premultiply(inv.multiply(q).multiply(wp));
  }
}
