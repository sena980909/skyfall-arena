import {
  AnimationAction, AnimationClip, AnimationMixer, Box3, Euler, Group, LoopOnce, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion,
  SkinnedMesh, Vector3,
} from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { buildAlignedGun } from '@/render/GunAlign';
import { GAIT_FWD_BACK, legsYawFor, type GaitDir } from './GaitDir';

/** 게임 안의 몸 키(눈높이 1.6m). 힉스필드 리그와 클립은 키 1.8m로 받았다 */
const BODY_HEIGHT = 1.71;
const K = BODY_HEIGHT / 1.8;
/** 클립마다 디딘 발이 바닥을 미는 속도(m/s, 키 1.8m 기준). 클립에서 직접 잰 값 */
export const PLAYER_CLIP_SPEED: Record<string, number> = { run: 6.0, crouch: 1.63 };
/** 허리 비틀림 한계(라디안). 넘으면 다리가 조준 쪽으로 끌려온다 */
const MAX_TWIST = 1.6;
/** 총 길이와, 손잡이가 홀더 원점에 오도록 총을 앞으로 민 거리(적과 같은 값) */
const RIFLE_LENGTH = 0.78 * K;
const GRIP_SHIFT = 0.16 * K;
/** 총 위의 손 자리(홀더 기준, 총열은 -Z) */
const GRIP = new Vector3(0, -0.03, 0.04).multiplyScalar(K);
const GUARD = new Vector3(0, -0.03, -0.3).multiplyScalar(K);
const MAG = new Vector3(0, -0.13, -0.07).multiplyScalar(K);
const MAG_OUT = new Vector3(-0.06, -0.38, -0.02).multiplyScalar(K);
const CROUCH_STRAIGHTEN = 0.4;
const UP = new Vector3(0, 1, 0);
const ZERO = new Vector3(0, 0, 0);

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
  /** 질주 중(총을 내리고 달린다) */
  sprint: boolean;
  /** 앉아 있다 */
  crouch: boolean;
}

interface Arm { upper: Object3D; fore: Object3D; hand: Object3D }

function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const smooth = (t: number): number => {
  const k = clamp(t, 0, 1);
  return k * k * (3 - 2 * k);
};

/** 생성 모델에는 발광 그림이 없다: 겉그림의 청록 불빛(바이저·띠)만 빛나게 한다 */
function addCyanGlow(mat: MeshStandardMaterial, strength: number): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = { value: strength };
    sh.fragmentShader = sh.fragmentShader
      .replace('uniform float opacity;', 'uniform float opacity;\nuniform float uGlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef USE_MAP
        {
          vec3 gc = sampledDiffuseColor.rgb;
          float gcy = min(gc.g, gc.b);
          totalEmissiveRadiance += gc * smoothstep(0.5, 0.75, gcy) * smoothstep(0.12, 0.3, gcy - gc.r) * uGlow;
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => `cyanGlow${strength}`;
}

/**
 * 주인공의 3인칭 몸. 모델·뼈대·동작 모두 힉스필드에서 받은 그대로 쓴다(이미지→3D + 3D Rigging).
 * 코드는 어떤 동작을 틀지 고르고, 동작이 알 수 없는 것만 더한다: 허리는 조준 쪽으로 돌고, 총은 카메라가 보는 곳을 향하고,
 * 두 손은 총으로 간다(2본 IK). 재장전은 무기의 진행률을 그대로 따른다(1인칭·효과음과 같은 시간표).
 */
export class PlayerBody {
  readonly group = new Group();
  private readonly mixer: AnimationMixer;
  private readonly actions: Record<string, AnimationAction> = {};
  private readonly weights: Record<string, number> = {};
  private readonly spine: Object3D[] = [];
  private readonly neck: Object3D | null;
  private readonly armL: Arm | null;
  private readonly armR: Arm | null;
  private readonly poseBones: Object3D[] = [];
  private readonly clean: Quaternion[] = [];
  private holder: Group | null = null;
  private muzzle: Object3D | null = null;
  private legsYaw = 0;
  private turning = false;
  private turnWait = 0;
  private dir: GaitDir = 'fwd';
  private dirHold = 0;
  private stillT = 1;
  private moveYaw = 0;
  private airTime = 0;
  private sprintBlend = 0;
  private reloadBlend = 0;
  private reloadT = 0;
  private dying = false;
  /** 앉아 걷기 클립에서 두 발이 모두 바닥에 있는 시각: 앉아서 가만히 있을 때의 자세 */
  private crouchRest = 0;
  private readonly vel = new Vector3();
  private readonly raw = new Vector3();
  private readonly lastPos = new Vector3();
  private hasLast = false;
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly qp = new Quaternion();
  private readonly e = new Euler();
  private readonly m = new Matrix4();
  private readonly axis = new Vector3();
  private readonly v = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];

  constructor(source: Group, clips: Record<string, AnimationClip>, rifleSrc: Object3D | null) {
    const model = skeletonClone(source) as Group;
    // 스킨드 메시는 본이 적용된 실제 정점으로 크기를 재야 한다
    const measure = (): Box3 => {
      model.updateMatrixWorld(true);
      model.traverse((o) => {
        const sm = o as SkinnedMesh;
        if (sm.isSkinnedMesh) sm.skeleton.update();
      });
      return new Box3().setFromObject(model, true);
    };
    let box = measure();
    model.scale.setScalar(BODY_HEIGHT / (box.getSize(new Vector3()).y || 1));
    box = measure();
    const c = box.getCenter(new Vector3());
    model.position.set(-c.x, -box.min.y, -c.z);
    model.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((orig) => {
        const mm = (orig as MeshStandardMaterial).clone();
        // 생성된 거칠기·금속 지도는 거울에 가까워 쓰지 않는다(적과 같다)
        mm.metalnessMap = null;
        mm.roughnessMap = null;
        mm.aoMap = null;
        mm.metalness = 0.3;
        mm.roughness = 0.6;
        mm.envMapIntensity = 0.4;
        addCyanGlow(mm, 1.4);
        return mm;
      });
      mesh.material = mats.length === 1 ? mats[0] : mats;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
    });
    this.group.add(model);
    this.group.rotation.order = 'YXZ';

    const depth = (o: Object3D): number => {
      let d = 0;
      for (let p = o.parent; p; p = p.parent) d++;
      return d;
    };
    const bone = (n: string): Object3D | null => model.getObjectByName(n) ?? null;
    model.traverse((o) => {
      if (/^Spine\d*$/i.test(o.name)) this.spine.push(o);
    });
    this.spine.sort((a, b) => depth(a) - depth(b));
    this.neck = bone('neck');
    const arm = (side: string): Arm | null => {
      const upper = bone(`${side}Arm`);
      const fore = bone(`${side}ForeArm`);
      const hand = bone(`${side}Hand`);
      return upper && fore && hand ? { upper, fore, hand } : null;
    };
    this.armL = arm('Left');
    this.armR = arm('Right');
    for (const b of [...this.spine, this.armL?.upper, this.armL?.fore, this.armR?.upper, this.armR?.fore]) {
      if (!b) continue;
      this.poseBones.push(b);
      this.clean.push(b.quaternion.clone());
    }

    if (rifleSrc) {
      const { group: holder, muzzle } = buildAlignedGun(rifleSrc, RIFLE_LENGTH);
      const rifle = holder.children[0];
      rifle.position.z -= GRIP_SHIFT;
      const mz = new Object3D();
      mz.position.copy(muzzle);
      mz.position.z -= GRIP_SHIFT;
      holder.add(mz);
      rifle.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((orig) => {
          const mm = (orig as MeshStandardMaterial).clone();
          mm.metalnessMap = null;
          mm.roughnessMap = null;
          mm.metalness = 0.3;
          mm.roughness = 0.55;
          mm.envMapIntensity = 0.4;
          return mm;
        });
        mesh.material = mats.length === 1 ? mats[0] : mats;
        mesh.castShadow = true;
        mesh.frustumCulled = false;
      });
      this.holder = holder;
      this.muzzle = mz;
      this.group.add(holder);
    }

    this.mixer = new AnimationMixer(model);
    for (const [name, clip] of Object.entries(clips)) {
      const a = this.mixer.clipAction(clip);
      if (name === 'death') {
        a.setLoop(LoopOnce, 1);
        a.clampWhenFinished = true;
      } else a.play();
      a.setEffectiveWeight(name === 'idle' ? 1 : 0);
      this.actions[name] = a;
      this.weights[name] = name === 'idle' ? 1 : 0;
    }
    this.crouchRest = this.findCrouchRest(model);
    this.group.visible = false;
  }

  /** 앉아 걷기 한 주기에서 두 발이 가장 낮은(둘 다 디딘) 시각 */
  private findCrouchRest(model: Group): number {
    const a = this.actions.crouch;
    const fl = model.getObjectByName('LeftFoot');
    const fr = model.getObjectByName('RightFoot');
    if (!a || !fl || !fr) return 0;
    const dur = a.getClip().duration;
    for (const k of Object.keys(this.actions)) this.actions[k].setEffectiveWeight(k === 'crouch' ? 1 : 0);
    let best = 0;
    let bestY = Infinity;
    for (let i = 0; i < 40; i++) {
      a.time = (i / 40) * dur;
      this.mixer.update(0);
      model.updateMatrixWorld(true);
      const y = Math.max(fl.getWorldPosition(this.v[0]).y, fr.getWorldPosition(this.v[1]).y);
      if (y < bestY) {
        bestY = y;
        best = a.time;
      }
    }
    a.time = best;
    for (const k of Object.keys(this.actions)) this.actions[k].setEffectiveWeight(this.weights[k]);
    this.mixer.update(0);
    return best;
  }

  reset(yaw: number): void {
    this.legsYaw = yaw + Math.PI;
    this.group.rotation.set(0, this.legsYaw, 0);
    this.reloadBlend = 0;
    this.sprintBlend = 0;
    this.turning = false;
    this.turnWait = 0;
    this.airTime = 0;
    this.dir = 'fwd';
    if (this.dying) this.actions.death?.stop();
    this.dying = false;
    for (const k of Object.keys(this.actions)) this.weights[k] = k === 'idle' ? 1 : 0;
    this.hasLast = false;
    this.vel.set(0, 0, 0);
  }

  /**
   * Forward or backward step: the one that twists the waist less and, when that is a tie (pure sidestep), the one the legs
   * already face. Switching between left and right then only reverses the stride instead of spinning the legs half a turn.
   */
  private pickDir(aimYaw: number): GaitDir {
    let best: GaitDir = 'fwd';
    let bestCost = Infinity;
    for (const d of GAIT_FWD_BACK) {
      const legs = legsYawFor(this.moveYaw, d);
      const twist = Math.abs(wrap(aimYaw - legs));
      const cost = twist + (twist > MAX_TWIST ? 2 : 0) + 0.5 * Math.abs(wrap(legs - this.legsYaw)) - (d === this.dir ? 0.2 : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = d;
      }
    }
    return best;
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
    // 좌우로 방향을 바꾸면 속도가 잠깐 0 근처를 지난다. 그동안 대기 자세로 빠졌다 돌아오지 않게 걷는 중으로 유지한다
    if (speed > 0.9) {
      this.stillT = 0;
      this.moveYaw = Math.atan2(this.vel.x, this.vel.z);
    } else this.stillT += dt;
    const moving = this.stillT < 0.18;

    if (moving) {
      // 전진과 뒷걸음 중 허리가 덜 비틀리는 쪽을 고른다. 다리는 가는 쪽을 본다(옆걸음 클립은 없다)
      let dir = this.pickDir(aimYaw);
      this.dirHold -= dt;
      if (dir !== this.dir && this.dirHold > 0) dir = this.dir;
      if (dir !== this.dir) {
        this.dir = dir;
        this.dirHold = 0.1;
      }
      let d = wrap(legsYawFor(this.moveYaw, this.dir) - this.legsYaw);
      // 거의 반대로 돌 때는 조준 쪽을 지나가는 방향으로 (반대로 돌면 상체가 한 바퀴 돈다)
      if (Math.abs(d) > 2.6) {
        const side = wrap(aimYaw - this.legsYaw);
        if (Math.abs(side) > 0.2 && Math.sign(side) !== Math.sign(d)) d = Math.sign(side) * (Math.PI * 2 - Math.abs(d));
      }
      this.legsYaw += clamp(d, -9 * dt, 9 * dt);
      this.turning = false;
      this.turnWait = 0;
    } else {
      // 서 있을 때: 상체가 조준을 따라가고, 비틀림이 크거나 한동안 비틀린 채 있으면 다리가 따라 돈다
      this.dir = 'fwd';
      const want = wrap(aimYaw - this.legsYaw);
      this.turnWait = Math.abs(want) > 0.25 ? this.turnWait + dt : 0;
      if (Math.abs(want) > 0.8 || this.turnWait > 0.7) this.turning = true;
      if (this.turning) {
        this.legsYaw += clamp(want, -6 * dt, 6 * dt);
        if (Math.abs(want) < 0.05) this.turning = false;
      }
    }
    const twist = clamp(wrap(aimYaw - this.legsYaw), -MAX_TWIST, MAX_TWIST);
    this.legsYaw = aimYaw - twist;
    this.group.position.copy(s.pos);
    this.group.rotation.set(0, this.legsYaw, 0);

    // 어떤 클립을 얼마나 빨리: 디딘 발이 몸의 속도로 바닥을 밀게 한다
    const crouch = s.crouch && !!this.actions.crouch;
    this.airTime = s.onGround ? 0 : this.airTime + dt;
    const air = this.airTime > 0.08;
    let name = 'idle';
    let ts = 1;
    if (crouch) {
      name = 'crouch';
      ts = moving ? ((this.dir === 'back' ? -1 : 1) * speed) / (PLAYER_CLIP_SPEED.crouch * K) : 0;
    } else if (moving || air) {
      if (this.actions.run) {
        name = 'run';
        ts = ((this.dir === 'back' && !air ? -1 : 1) * speed) / (PLAYER_CLIP_SPEED.run * K);
      }
      // 공중에서는 다리를 천천히 젓는다
      if (air) ts = 0.35;
    }
    if (!this.actions[name]) name = 'idle';
    let sum = 0;
    for (const k of Object.keys(this.actions)) {
      this.weights[k] += ((k === name ? 1 : 0) - this.weights[k]) * Math.min(1, dt * 10);
      sum += this.weights[k];
    }
    for (const k of Object.keys(this.actions)) {
      const a = this.actions[k];
      a.setEffectiveWeight(this.weights[k] / (sum || 1));
      if (k === name) a.timeScale = k === 'idle' ? 1 : clamp(ts, -2.6, 2.6);
    }
    const ca = this.actions.crouch;
    if (ca && crouch && !moving) {
      // 앉아서 가만히: 두 발을 디딘 자세로 모인다
      const dur = ca.getClip().duration;
      let d = this.crouchRest - ca.time;
      if (d > dur / 2) d -= dur;
      if (d < -dur / 2) d += dur;
      ca.time = (ca.time + d * Math.min(1, dt * 8) + dur) % dur;
    }
    this.reloadBlend += ((s.reload !== null ? 1 : 0) - this.reloadBlend) * Math.min(1, dt * 14);
    if (s.reload !== null) this.reloadT = s.reload;
    this.sprintBlend += ((s.sprint ? 1 : 0) - this.sprintBlend) * Math.min(1, dt * 8);

    // 믹서는 값이 그대로면 다시 쓰지 않으므로, 지난 프레임에 더한 회전을 먼저 지운다(누적 방지)
    for (let i = 0; i < this.poseBones.length; i++) this.poseBones[i].quaternion.copy(this.clean[i]);
    this.mixer.update(dt);
    for (let i = 0; i < this.poseBones.length; i++) this.clean[i].copy(this.poseBones[i].quaternion);

    const low = this.sprintBlend;
    const rb = this.reloadBlend;
    const pitch = clamp(s.pitch * (1 - 0.6 * rb) * (1 - low) + s.kick * 0.05, -1.1, 1.1);
    // 허리: 비틀림과 피치의 일부를 척추 본들에 나눠 준다
    const n = this.spine.length;
    const crouchW = (this.weights.crouch ?? 0) / (sum || 1);
    if (n) {
      this.axis.set(-Math.cos(aimYaw), 0, Math.sin(aimYaw));
      for (const b of this.spine) {
        if (Math.abs(twist) > 1e-3) this.rotateWorld(b, this.q.setFromAxisAngle(UP, twist / n));
        this.rotateWorld(b, this.q.setFromAxisAngle(this.axis, (pitch * 0.4 + CROUCH_STRAIGHTEN * crouchW) / n));
      }
    }
    this.group.updateMatrixWorld(true);
    this.placeRifle(twist, pitch, low, rb, s.kick);
    this.holdRifle(low, rb);
    this.holder?.updateMatrixWorld(true);
  }

  /**
   * 총(그룹 기준): 카메라가 보는 곳을 향한다. 견착 때는 목에서 오른쪽·아래·앞으로 뗀 자리에 두고 두 손이 총으로 간다.
   * 질주 때는 오른손을 따라가며 총구를 내린다.
   */
  private placeRifle(twist: number, pitch: number, low: number, rb: number, kick: number): void {
    const holder = this.holder;
    if (!holder || !this.armR) return;
    const [hand, anchor, dir] = this.v;
    const fx = Math.sin(twist);
    const fz = Math.cos(twist);
    dir.set(fx * Math.cos(pitch), Math.sin(pitch), fz * Math.cos(pitch));
    this.group.worldToLocal(this.armR.hand.getWorldPosition(hand));
    if (this.neck) {
      this.group.worldToLocal(this.neck.getWorldPosition(anchor));
      // 오른쪽 = (-fz, 0, fx)
      anchor.x += (-fz * 0.2 + fx * 0.14) * K;
      anchor.z += (fx * 0.2 + fz * 0.14) * K;
      anchor.y -= (0.1 + 0.05 * rb) * K;
      hand.lerp(anchor, 1 - low);
    }
    holder.position.copy(hand);
    // 카메라 규약 lookAt: -Z가 목표 방향, up = Y → 총이 뒤집히지 않는다
    this.m.lookAt(ZERO, dir, UP);
    holder.quaternion.setFromRotationMatrix(this.m);
    // 질주: 로우레디. 재장전: 총구를 조금 들고 옆으로 기울인다
    this.e.set(-0.55 * low + 0.22 * rb, 0.4 * low + 0.12 * rb, 0.3 * low + 0.45 * rb);
    holder.quaternion.multiply(this.q2.setFromEuler(this.e));
    holder.translateZ(0.06 * low * K + kick * 0.03);
    holder.translateY(-0.1 * low * K);
    holder.updateMatrixWorld(true);
  }

  /** 두 손을 총으로. 재장전 중에는 왼손이 탄창으로 가서 빼냈다가 다시 끼운다 */
  private holdRifle(low: number, rb: number): void {
    const holder = this.holder;
    if (!holder) return;
    const target = this.v[3];
    if (this.armR && low < 0.98) {
      holder.localToWorld(target.copy(GRIP));
      target.lerp(this.armR.hand.getWorldPosition(this.v[4]), low);
      this.solveArm(this.armR, target);
    }
    if (this.armL) {
      target.copy(GUARD);
      if (rb > 0.01) {
        const r = this.reloadT;
        const p = this.v[4];
        if (r < 0.2) p.lerpVectors(GUARD, MAG, smooth(r / 0.2));
        else if (r < 0.38) p.lerpVectors(MAG, MAG_OUT, smooth((r - 0.2) / 0.18));
        else if (r < 0.56) p.copy(MAG_OUT);
        else if (r < 0.76) p.lerpVectors(MAG_OUT, MAG, smooth((r - 0.56) / 0.2));
        else p.lerpVectors(MAG, GUARD, smooth((r - 0.76) / 0.24));
        target.lerp(p, rb);
      }
      holder.localToWorld(target);
      this.solveArm(this.armL, target);
    }
  }

  /** 2본 IK: 손목을 target(월드)으로. 팔꿈치는 클립이 준 굽힘 평면을 유지한다 */
  private solveArm(arm: Arm, target: Vector3): void {
    const a = this.v[5];
    const b = this.v[6];
    const h = this.v[7];
    const u = this.v[0];
    const w = this.v[1];
    arm.upper.getWorldPosition(a);
    arm.fore.getWorldPosition(b);
    arm.hand.getWorldPosition(h);
    const l1 = a.distanceTo(b);
    const l2 = b.distanceTo(h);
    if (l1 < 1e-4 || l2 < 1e-4) return;
    const d = Math.min(l1 + l2 - 0.01, Math.max(0.05, a.distanceTo(target)));
    const want = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
    u.copy(a).sub(b).normalize();
    w.copy(h).sub(b).normalize();
    const have = Math.acos(clamp(u.dot(w), -1, 1));
    this.axis.crossVectors(w, u);
    if (this.axis.lengthSq() > 1e-8) {
      this.rotateWorld(arm.fore, this.q.setFromAxisAngle(this.axis.normalize(), have - want));
      arm.fore.updateMatrixWorld(true);
    }
    arm.hand.getWorldPosition(h);
    u.copy(h).sub(a).normalize();
    w.copy(target).sub(a).normalize();
    this.rotateWorld(arm.upper, this.q.setFromUnitVectors(u, w));
    arm.upper.updateMatrixWorld(true);
  }

  /** 사망: 쓰러지는 클립을 한 번 틀고, 총은 오른손에 남는다. Player가 사망 상태 동안 매 스텝 호출 */
  updateDeath(dt: number): void {
    const death = this.actions.death;
    if (!this.dying) {
      this.dying = true;
      death?.reset().play();
    }
    const to = death ? 'death' : 'idle';
    let sum = 0;
    for (const k of Object.keys(this.actions)) {
      this.weights[k] += ((k === to ? 1 : 0) - this.weights[k]) * Math.min(1, dt * 12);
      sum += this.weights[k];
    }
    for (const k of Object.keys(this.actions)) this.actions[k].setEffectiveWeight(this.weights[k] / (sum || 1));
    for (let i = 0; i < this.poseBones.length; i++) this.poseBones[i].quaternion.copy(this.clean[i]);
    this.mixer.update(dt);
    for (let i = 0; i < this.poseBones.length; i++) this.clean[i].copy(this.poseBones[i].quaternion);
    this.group.updateMatrixWorld(true);
    if (this.holder && this.armR) {
      this.group.worldToLocal(this.armR.hand.getWorldPosition(this.v[0]));
      this.holder.position.lerp(this.v[0], Math.min(1, dt * 20));
      this.holder.updateMatrixWorld(true);
    }
  }

  /** 월드 회전 q를 본에 적용: L' = Wp⁻¹ · q · Wp · L */
  private rotateWorld(bone: Object3D, q: Quaternion): void {
    const wp = bone.parent ? bone.parent.getWorldQuaternion(this.qp) : this.qp.identity();
    const inv = wp.clone().invert();
    bone.quaternion.premultiply(inv.multiply(q).multiply(wp));
  }
}
