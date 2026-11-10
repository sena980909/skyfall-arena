import {
  AnimationAction, AnimationClip, AnimationMixer, DoubleSide, Group, LoopOnce, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3,
} from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  GAIT_ALL, GAIT_FWD_BACK, gaitResidual, legsYawFor, mirroredStrafePhase, neighborDir, pickGaitDir, solveGaitBlend, startTurnStep, turnStepYaw,
  type GaitDir, type TurnStep,
} from './GaitDir';

/** 제자리 돌기: 이 각(라디안)을 넘으면 발을 떼어 돈다 / 90° 한 걸음의 길이(초). 주인공은 마우스로 빨리 돌아서 봇보다 짧게 잡는다 */
const TURN_START = 0.6;
const TURN_DUR = 0.3;

/** 보행 클립의 접지 발 속도(m/s). tools/blender/build_bot_rig.py의 GAITS와 같아야 발이 미끄러지지 않는다 */
const CLIP_SPEED: Record<string, number> = {
  walk: 1.6, jog: 2.8, run: 5.5, sprint: 8.25, back: 5.5, strafeL: 2.8, strafeR: 2.8, strafeFastL: 5.5, strafeFastR: 5.5,
};
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
  /** 질주 중(총을 내리고 달린다) */
  sprint: boolean;
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
  private readonly hips: Object3D | null;
  private readonly arms: Object3D | null;
  private readonly muzzle: Object3D | null;
  private readonly clean: Quaternion[] = [];
  private readonly poseBones: Object3D[] = [];
  private legsYaw = 0;
  /** 제자리 돌기 한 걸음(GaitDir.TurnStep), 비틀린 채 서 있은 시간, 조준이 도는 속도(rad/s) */
  private turnStep: TurnStep | null = null;
  private turnWait = 0;
  private aimRate = 0;
  private lastAim = 0;
  /** 걸음 방향(전진·뒷걸음·좌우 옆걸음)과 최소 유지 시간 */
  private dir: GaitDir = 'fwd';
  private dirHold = 0;
  /** 속도가 잠깐 0을 지나도(좌우 방향 전환) 걷는 중으로 치는 시간 */
  private stillT = 1;
  private moveYaw = 0;
  private gait = 'idle';
  private gait2 = '';
  private gaitSpeed = 0;
  private airTime = 0;
  private sprintBlend = 0;
  private dying = false;
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
          // The mesh is cut where the arms separate from the body; draw inner faces too so the cuts do not read as holes.
          mm.side = DoubleSide;
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
    this.hips = model.getObjectByName('hips') ?? null;
    this.arms = model.getObjectByName('armsgun') ?? null;
    this.muzzle = model.getObjectByName('muzzle') ?? null;
    for (const b of [this.hips, this.torso, this.arms]) {
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
        if (clip.name === 'death') {
          a.setLoop(LoopOnce, 1);
          a.clampWhenFinished = true;
        }
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
    this.dying = false;
    this.turnStep = null;
    this.turnWait = 0;
    this.aimRate = 0;
    this.lastAim = this.legsYaw;
    this.airTime = 0;
    this.sprintBlend = 0;
    for (const k of Object.keys(this.actions)) this.weights[k] = k === 'idle' ? 1 : 0;
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
    // 좌우로 방향을 바꾸면 속도가 0.1초쯤 0 근처를 지난다. 그동안 대기 자세로 빠졌다 돌아오지 않게 걷는 중으로 유지한다
    if (speed > 0.9) {
      this.stillT = 0;
      this.moveYaw = Math.atan2(this.vel.x, this.vel.z);
    } else this.stillT += dt;
    const moving = this.stillT < 0.18;
    const blend = !!(this.actions.strafeL && this.actions.strafeR);
    let target = aimYaw;
    if (moving) {
      const moveYaw = this.moveYaw;
      // 전진·뒷걸음·좌우 옆걸음 중 허리 비틀림이 가장 작은 걸음을 고른다(GaitDir.ts). 옆으로 갈 때 다리는 조준 쪽을 본 채 옆걸음한다
      const allowed = this.actions.strafeL && this.actions.strafeR ? GAIT_ALL : GAIT_FWD_BACK;
      let dir = pickGaitDir(moveYaw, blend ? this.legsYaw : aimYaw, this.dir, allowed, blend ? 0.2 : 0.3);
      this.dirHold -= dt;
      if (dir !== this.dir && this.dirHold > 0) dir = this.dir;
      if (dir !== this.dir) {
        this.dir = dir;
        this.dirHold = 0.25;
      }
      // 옆걸음 클립이 있으면 다리는 조준 쪽을 보고 대각선은 두 걸음을 섞는다. 없으면 다리를 이동 방향으로 돌린다
      target = blend ? aimYaw : legsYawFor(moveYaw, dir);
    } else this.dir = 'fwd';
    if (dt > 0) this.aimRate += (wrap(aimYaw - this.lastAim) / dt - this.aimRate) * Math.min(1, dt * 8);
    this.lastAim = aimYaw;
    const stepTurn = !moving && s.onGround && !!this.actions.turnL && !!this.actions.turnR;
    if (stepTurn) {
      // 제자리 돌기: 다리는 그대로 두고 상체만 조준을 따라가다가, 비틀림이 커지거나 비틀린 채 잠시 서 있으면 발을 떼어 한 걸음에 돈다.
      // 다리를 조준 쪽으로 계속 돌리면 디딘 두 발이 바닥에서 돈다(GaitDir.TurnStep)
      if (!this.turnStep) {
        const want = wrap(aimYaw - this.legsYaw);
        this.turnWait = Math.abs(want) > 0.25 ? this.turnWait + dt : 0;
        if (this.weights.idle > 0.95 && (Math.abs(want) > TURN_START || this.turnWait > 0.6)) {
          // 조준이 계속 돌고 있으면 그만큼 앞서 돈다(잔걸음이 줄어든다)
          const lead = Math.sign(this.aimRate) === Math.sign(want) ? Math.max(-0.5, Math.min(0.5, this.aimRate * 0.25)) : 0;
          this.turnStep = startTurnStep(this.legsYaw, want + lead, TURN_DUR);
          this.turnWait = 0;
        }
      }
      if (this.turnStep) {
        this.turnStep.u = Math.min(1, this.turnStep.u + dt / this.turnStep.dur);
        this.legsYaw = turnStepYaw(this.turnStep);
      }
    } else {
      // 도는 중에 움직이기 시작하면 돌기 클립은 그 자세로 멈춘 채 걸음 클립과 섞이며 빠진다
      this.turnStep = null;
      this.turnWait = 0;
      let d = wrap(target - this.legsYaw);
      // 거의 반대로 돌 때는 조준 쪽을 지나가는 방향으로 (반대로 돌면 상체가 한 바퀴 돈다)
      if (Math.abs(d) > 2.6) {
        const side = wrap(aimYaw - this.legsYaw);
        if (Math.abs(side) > 0.2 && Math.sign(side) !== Math.sign(d)) d = Math.sign(side) * (Math.PI * 2 - Math.abs(d));
      }
      const maxTurn = (moving ? 9 : 5) * dt;
      this.legsYaw += Math.max(-maxTurn, Math.min(maxTurn, d));
    }
    const rawTwist = wrap(aimYaw - this.legsYaw);
    const twist = Math.max(-MAX_TWIST, Math.min(MAX_TWIST, rawTwist));
    // 비틀림 한계를 넘으면 다리가 따라 돈다(도는 중이면 걸음의 기준도 함께 옮긴다)
    if (this.turnStep) this.turnStep.from += rawTwist - twist;
    this.legsYaw = aimYaw - twist;
    this.group.position.copy(s.pos);
    this.group.rotation.set(0, this.legsYaw, 0);

    // 클립 선택: 속도 구간(걷기·조깅·달리기 발 속도의 기하평균 경계)
    // 걸음 종류는 '의도한 속도'로 고른다: 올라갈 때는 즉시, 내려갈 때는 초당 6m/s씩만 따라간다.
    // 좌우로 방향을 바꾸거나 멈출 때 속도가 잠깐 떨어져도 느린 걸음 클립을 거치지 않는다
    this.gaitSpeed = moving ? Math.max(speed, this.gaitSpeed - dt * 6) : 0;
    const gs = this.gaitSpeed;
    const clipFor = (dir: GaitDir): string => {
      if (dir === 'back') return 'back';
      if (dir === 'left' || dir === 'right') {
        const fast = gs > 3.92 * (this.gait.startsWith('strafeFast') || this.gait2.startsWith('strafeFast') ? 0.85 : 1.15);
        return (fast ? 'strafeFast' : 'strafe') + (dir === 'left' ? 'L' : 'R');
      }
      return gs < 2.12 ? 'walk' : gs < 3.92 ? 'jog' : gs < 6.74 || !this.actions.sprint ? 'run' : 'sprint';
    };
    let name = 'idle';
    let name2 = '';
    let w2 = 0;
    let ts1 = 1;
    let ts2 = 1;
    if (moving) {
      name = clipFor(this.dir);
      if (!this.actions[name]) name = 'idle';
      else {
        ts1 = speed / CLIP_SPEED[name];
        // 대각선: 이동 방향이 주 걸음에서 벗어난 만큼 옆 걸음을 섞는다(GaitDir.solveGaitBlend)
        const res = blend && speed > 0.9 ? gaitResidual(this.moveYaw, this.legsYaw, this.dir) : 0;
        const sec = Math.abs(res) > 0.06 ? clipFor(neighborDir(this.dir, res)) : '';
        if (sec && sec !== name && this.actions[sec]) {
          const b = solveGaitBlend(speed, res, CLIP_SPEED[name], this.actions[name].getClip().duration, CLIP_SPEED[sec], this.actions[sec].getClip().duration);
          name2 = sec;
          w2 = b.w2;
          ts1 = b.ts1;
          ts2 = b.ts2;
        }
      }
    }
    // 공중: 달리는 동작 대신 공중 자세 (잠깐 뜨는 턱에서는 바꾸지 않는다)
    this.airTime = s.onGround ? 0 : this.airTime + dt;
    if (this.airTime > 0.08 && this.actions.air) {
      name = 'air';
      name2 = '';
      w2 = 0;
    }
    this.gait2 = name2;
    if (!this.actions[name]) name = 'idle';
    // Gait-to-gait: bring the incoming clip to the same stride phase as the outgoing one so the feet line up while blending.
    if (name !== this.gait) {
      const from = this.actions[this.gait];
      const to = this.actions[name];
      if (from && to && name !== 'idle' && this.gait !== 'idle') {
        const mirrored = mirroredStrafePhase(this.gait, name, from.time / from.getClip().duration);
        if (mirrored !== null) {
          // 좌↔우 뒤집기: 발 위치가 이어지는 위상에서 새 클립을 시작하고 가중치를 바로 넘긴다(섞는 동안 발이 미끄러지지 않게)
          to.time = mirrored * to.getClip().duration;
          this.weights[name] = Math.max(this.weights[name], this.weights[this.gait]);
          this.weights[this.gait] = 0;
        } else if (this.weights[name] < 0.05) to.time = (from.time / from.getClip().duration) * to.getClip().duration;
      }
      this.gait = name;
    }
    let sum = 0;
    for (const k of Object.keys(this.actions)) {
      const w = this.weights[k] + ((k === name ? 1 - w2 : k === name2 ? w2 : 0) - this.weights[k]) * Math.min(1, dt * 10);
      this.weights[k] = w;
      sum += w;
    }
    const st = this.turnStep;
    if (st) {
      // 돌기 클립은 가중치를 바로 준다: 처음·끝이 대기 자세와 같아 섞는 시간이 필요 없고, 천천히 올리면 디딘 발이 다리 회전을 따라가지 못한다
      for (const k of Object.keys(this.actions)) this.weights[k] = k === st.clip ? st.w : k === 'idle' ? 1 - st.w : 0;
      sum = 1;
    }
    for (const k of Object.keys(this.actions)) {
      const a = this.actions[k];
      a.setEffectiveWeight(this.weights[k] / (sum || 1));
      const cs = CLIP_SPEED[k];
      // 공중에서는 다리를 천천히 젓는다
      const t = k === name ? ts1 : k === name2 ? ts2 : speed / (cs || 1);
      // 재생 배율이 속도를 그대로 따라가게 한다(하한을 두면 방향을 뒤집는 순간처럼 속도가 0 근처일 때 발만 움직여 미끄러진다)
      a.timeScale = cs ? (s.onGround ? Math.max(0.05, Math.min(2, t)) : 0.35) : k === 'turnL' || k === 'turnR' ? 0 : 1;
    }
    if (st) {
      // 돌기 클립의 시간은 걸음 진행에 직접 맞춘다
      const a = this.actions[st.clip];
      a.time = Math.min(0.999, st.u) * a.getClip().duration;
      if (st.u >= 1) {
        this.weights[st.clip] = 0;
        this.weights.idle = 1;
        this.turnStep = null;
      }
    }
    // 섞는 두 걸음은 같은 보폭 위상으로 맞춘다
    const pa = this.actions[name];
    const sa = name2 ? this.actions[name2] : undefined;
    if (pa && sa && name !== 'idle') sa.time = (pa.time / pa.getClip().duration) * sa.getClip().duration;
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
    if (this.torso && Math.abs(twist) > 1e-3) {
      // Split the twist between pelvis and chest so strafing does not snap the body at one joint.
      const part = this.hips ? twist / 2 : twist;
      if (this.hips) {
        this.rotateWorld(this.hips, this.q.setFromAxisAngle(UP, part));
        this.group.updateMatrixWorld(true);
      }
      this.rotateWorld(this.torso, this.q.setFromAxisAngle(UP, part));
    }
    if (this.arms) {
      this.group.updateMatrixWorld(true);
      // 재장전 중에는 총을 수평 가까이 둔다
      // 질주 중에는 총을 내린다
      this.sprintBlend += ((s.sprint ? 1 : 0) - this.sprintBlend) * Math.min(1, dt * 8);
      const sb = this.sprintBlend;
      const pitch = Math.max(-0.9, Math.min(0.9, s.pitch * (1 - 0.6 * this.reloadBlend) * (1 - sb) - 0.55 * sb + s.kick * 0.05));
      this.axis.set(-Math.cos(aimYaw), 0, Math.sin(aimYaw));
      this.rotateWorld(this.arms, this.q.setFromAxisAngle(this.axis, pitch));
    }
  }

  /** 사망: 뒤로 쓰러진다. Player가 사망 상태 동안 매 스텝 호출 */
  updateDeath(dt: number): void {
    if (this.deathT < 0) this.deathT = 0;
    this.turnStep = null;
    this.deathT += dt;
    const death = this.actions.death;
    if (death) {
      // 사망 클립: 무릎이 꺾이며 뒤로 쓰러져 눕는다
      if (!this.dying) {
        this.dying = true;
        death.reset();
        death.play();
      }
      let sum = 0;
      for (const k of Object.keys(this.actions)) {
        this.weights[k] += ((k === 'death' ? 1 : 0) - this.weights[k]) * Math.min(1, dt * 12);
        sum += this.weights[k];
      }
      for (const k of Object.keys(this.actions)) this.actions[k].setEffectiveWeight(this.weights[k] / (sum || 1));
      this.reloadBlend += (0 - this.reloadBlend) * Math.min(1, dt * 12);
      this.reloadAction?.setEffectiveWeight(this.reloadBlend);
      for (let i = 0; i < this.poseBones.length; i++) this.poseBones[i].quaternion.copy(this.clean[i]);
      this.mixer.update(dt);
      for (let i = 0; i < this.poseBones.length; i++) this.clean[i].copy(this.poseBones[i].quaternion);
      return;
    }
    // 클립이 없는 모델: 몸 전체를 통째로 뒤로 넘어뜨린다
    const k = Math.min(1, this.deathT / 0.6);
    const ease = k * k;
    const bounce = k >= 1 ? Math.max(0, Math.sin(Math.min(1, (this.deathT - 0.6) / 0.25) * Math.PI)) * 0.05 : 0;
    this.group.rotation.x = -(Math.PI / 2 - 0.08) * ease + bounce;
    for (let i = 0; i < this.poseBones.length; i++) this.poseBones[i].quaternion.copy(this.clean[i]);
    if (this.arms) {
      this.group.updateMatrixWorld(true);
      this.axis.set(-Math.cos(this.legsYaw), 0, Math.sin(this.legsYaw));
      this.rotateWorld(this.arms, this.q.setFromAxisAngle(this.axis, -1.25 * ease));
    }
  }

  /** 월드 회전 q를 본에 적용: L' = Wp⁻¹ · q · Wp · L */
  private rotateWorld(bone: Object3D, q: Quaternion): void {
    const wp = bone.parent ? bone.parent.getWorldQuaternion(this.qp) : this.qp.identity();
    const inv = wp.clone().invert();
    bone.quaternion.premultiply(inv.multiply(q).multiply(wp));
  }
}
