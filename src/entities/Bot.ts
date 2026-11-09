import {
  AnimationAction, AnimationClip, AnimationMixer, Box3, BoxGeometry, BufferGeometry, CapsuleGeometry, Color,
  Euler, Float32BufferAttribute, Group, Line, LineBasicMaterial, LoopOnce, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion,
  SkinnedMesh, SphereGeometry, Vector3,
} from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { buildAlignedGun } from '@/render/GunAlign';
import { CharacterController } from './CharacterController';
import { Weapon } from '@/combat/Weapon';
import { RAVEN } from '@/data/heroes';
import { computeDamage, hitscan, losBlocked, tagHitMesh, type DamageInfo, type Hittable } from '@/combat/Hitscan';
import { angleBetweenDeg, DEG2RAD, gaussian, jitterDirection, randInt, randRange, rotateTowards, yawOf } from '@/core/MathUtil';
import type { GameContext } from '@/core/Context';
import type { Healable } from '@/world/HealthPack';
import type { HealthPack } from '@/world/HealthPack';

export type BotState = 'patrol' | 'chase' | 'combat' | 'retreat' | 'dead';
/** 교전 중 세부 모드 */
export type CombatMode = 'engage' | 'toCover' | 'hiding' | 'peeking';

export interface BotOptions {
  hpMult?: number;
  scale?: number;
  boss?: boolean;
}

/** 봇 손 라이플 오프셋 (월드 미터/라디안). 브라우저에서 튜닝 후 반영 */
export const BOT_RIFLE_OFFSET = { pos: [0.02, -0.04, 0.12] as [number, number, number], rot: [0.08, -Math.PI / 2, 0] as [number, number, number], forwardShift: 0.16 };

const SIGHT_RANGE = 60;
const FOV_HALF_DEG = 55;
const MEMORY_SECONDS = 3;
const ENGAGE_MAX = 20;
const ENGAGE_MIN = 10;
const RETREAT_COOLDOWN = 15;

/** AI 봇 (레이븐). 플레이어와 같은 무기/컨트롤러를 공유하고 입력만 AI가 공급 */
export class Bot implements Hittable, Healable {
  readonly hero = RAVEN;
  readonly group = new Group();
  readonly hitMeshes: Mesh[] = [];
  readonly ctrl: CharacterController;
  readonly weapon = new Weapon(RAVEN.weapon);
  readonly maxHp: number;
  readonly isBoss: boolean;
  readonly scale: number;
  hp: number;
  alive = true;
  state: BotState = 'patrol';
  mode: CombatMode = 'engage';
  /** 공격 토큰: Game이 매 스텝 배분. 없으면 조준만 하고 사격하지 않는다 */
  hasAttackToken = false;

  // 지각
  private canSee = false;
  private blindUntil = 0;
  private readonly lastSeenPos = new Vector3();
  private lastSeenTime = -Infinity;
  private firstSeenTime = Infinity;
  private nextPerception = 0;
  // 조준
  readonly aimDir = new Vector3(0, 0, 1);
  private noiseYaw = 0;
  private noisePitch = 0;
  private nextNoise = 0;
  private aimHead = false;
  private burstLeft = 4;
  private burstPauseUntil = 0;
  private burstJustEnded = false;
  private readonly aimSigmaMult: number;
  private readonly reactionMult: number;
  // 이동
  private path: Vector3[] = [];
  private pathIdx = 0;
  private nextRepath = 0;
  private strafeDir = 1;
  private nextStrafeFlip = 0;
  private stuckTimer = 0;
  private patrolTarget: Vector3 | null = null;
  private readonly moveDir = new Vector3(0, 0, 1);
  // 엄폐
  private coverTimeout = 0;
  private hideUntil = 0;
  // 후퇴
  private retreatUntil = 0;
  private lastRetreatTime = -Infinity;
  private retreatPack: HealthPack | null = null;
  // 비주얼
  private readonly bodyMat: MeshStandardMaterial;
  private readonly headMat: MeshStandardMaterial;
  private readonly visorMat: MeshStandardMaterial;
  private readonly visorColor: number;
  private flashUntil = 0;
  // M3 모델/애니메이션
  private mixer: AnimationMixer | null = null;
  private actions: Record<string, AnimationAction> = {};
  private currentAnim = '';
  private shootUntil = 0;
  private readonly skinMats: MeshStandardMaterial[] = [];
  private readonly lastPos = new Vector3();
  private readonly velocity = new Vector3();
  private facingYaw = 0;
  /** 손에 든 라이플의 총구 (모델 적용 시) */
  private rifleMuzzle: Object3D | null = null;
  /** 라이플 홀더(그룹 자식) + 오른손 본: 위치는 손, 방향은 조준 방향 */
  private rifleHolder: Group | null = null;
  private handBone: Object3D | null = null;
  private rifleKick = 0;
  private stepTimer = 0;
  /** 0 = 총구를 내린 이동 자세(로우레디), 1 = 조준 */
  private rifleEngage = 0;
  private rifleBob = 0;
  private readonly tmpE = new Euler();
  private readonly tmpQ2 = new Quaternion();
  private readonly tmpQ = new Quaternion();
  private readonly tmpM = new Matrix4();
  private static readonly UP = new Vector3(0, 1, 0);
  private static readonly ZERO = new Vector3(0, 0, 0);
  readonly debugLine: Line;
  private readonly debugMat: LineBasicMaterial;

  private readonly eye = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly tmp3 = new Vector3();
  private readonly wish = new Vector3();
  private readonly desired = new Vector3();

  get position(): Vector3 {
    return this.ctrl.pos;
  }

  get eyeHeight(): number {
    return 1.6 * this.scale;
  }

  constructor(private readonly ctx: GameContext, readonly displayName: string, spawn: Vector3, opts: BotOptions = {}) {
    const scale = opts.scale ?? 1;
    this.scale = scale;
    this.isBoss = opts.boss ?? false;
    this.ctrl = new CharacterController(ctx.map.colliders);
    this.ctrl.radius = 0.4 * scale;
    this.ctrl.height = 1.8 * scale;
    this.ctrl.teleport(spawn);
    this.maxHp = Math.round(RAVEN.hp * (opts.hpMult ?? 1) * ctx.difficulty.hpMult);
    this.hp = this.maxHp;
    this.aimSigmaMult = this.isBoss ? 0.7 : 1;
    this.reactionMult = this.isBoss ? 0.8 : 1;

    const bodyColor = this.isBoss ? 0xc0202a : 0xff5a2f;
    this.bodyMat = new MeshStandardMaterial({ color: bodyColor, roughness: 0.6, emissive: 0x000000 });
    this.headMat = new MeshStandardMaterial({ color: this.isBoss ? 0x3a0a10 : 0x7a2a14, roughness: 0.5, emissive: 0x000000 });
    const body = tagHitMesh(new Mesh(new CapsuleGeometry(0.35, 0.8, 4, 10), this.bodyMat), this, 'body');
    body.position.y = 0.75;
    const head = tagHitMesh(new Mesh(new SphereGeometry(0.22, 12, 10), this.headMat), this, 'head');
    head.position.y = 1.68;
    const visorColor = this.isBoss ? 0xff3b3b : 0xffd166;
    this.visorMat = new MeshStandardMaterial({ color: visorColor, emissive: visorColor, emissiveIntensity: 0.9 });
    this.visorColor = visorColor;
    const visor = new Mesh(new BoxGeometry(0.26, 0.07, 0.1), this.visorMat);
    visor.position.set(0, 1.7, 0.18);
    const gun = new Mesh(new BoxGeometry(0.1, 0.12, 0.6), new MeshStandardMaterial({ color: 0x222a33, roughness: 0.6 }));
    gun.position.set(0.3, 1.2, 0.35);
    body.castShadow = head.castShadow = true;
    this.group.add(body, head, visor, gun);
    if (this.isBoss) {
      // 어깨 장갑
      const pad = new MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.5, metalness: 0.5 });
      for (const sx of [-1, 1]) {
        const shoulder = new Mesh(new BoxGeometry(0.3, 0.2, 0.4), pad);
        shoulder.position.set(sx * 0.45, 1.35, 0);
        this.group.add(shoulder);
      }
    }
    this.group.scale.setScalar(scale);
    this.hitMeshes.push(body, head);
    this.group.position.copy(spawn);

    this.debugMat = new LineBasicMaterial({ color: 0xffd166 });
    this.debugLine = new Line(new BufferGeometry(), this.debugMat);
    this.debugLine.visible = false;
    this.debugLine.frustumCulled = false;

    this.burstLeft = randInt(...ctx.difficulty.burstLength);
    this.aimDir.copy(ctx.player.position).sub(spawn).setY(0).normalize();
    if (this.aimDir.lengthSq() < 0.5) this.aimDir.set(0, 0, 1);
    this.moveDir.copy(this.aimDir);
    this.facingYaw = yawOf(this.aimDir);
    this.lastPos.copy(spawn);
    if (ctx.assets?.raven) this.applyModel(ctx.assets.raven.scene, ctx.assets.raven.clips, [visor, gun], [body, head]);
  }

  /** 힉스필드 레이븐 GLB로 비주얼 교체. 히트박스(캡슐/구)는 보이지 않게 유지 */
  private applyModel(source: Group, clips: Record<string, AnimationClip>, hideMeshes: Mesh[], hitboxes: Mesh[]): void {
    const model = skeletonClone(source) as Group;
    // 스킨드 메시는 본 행렬이 적용된 실제 정점 위치로 바운딩 박스를 재야 한다 (precise=true)
    const measure = (): Box3 => {
      model.updateMatrixWorld(true);
      model.traverse((o) => {
        const sm = o as SkinnedMesh;
        if (sm.isSkinnedMesh) sm.skeleton.update();
      });
      return new Box3().setFromObject(model, true);
    };
    let bbox = measure();
    const size = bbox.getSize(new Vector3());
    const scale = 1.8 / (size.y || 1);
    model.scale.setScalar(scale);
    bbox = measure();
    const center = bbox.getCenter(new Vector3());
    model.position.set(-center.x, -bbox.min.y, -center.z);
    const tint = new Color(this.isBoss ? 0xff2a2a : 0xff6a3a);
    model.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const tinted = mats.map((orig) => {
        const mm = (orig as MeshStandardMaterial).clone();
        // 팀 가독성: 봇은 확실한 주황/빨강 계열로 (원본 텍스처는 명암만 남김)
        mm.color.copy(tint).multiplyScalar(this.isBoss ? 1.0 : 1.05);
        mm.emissive = new Color(0x000000);
        mm.roughness = Math.min(1, (mm.roughness ?? 0.8) + 0.1);
        this.skinMats.push(mm);
        return mm;
      });
      m.material = tinted.length === 1 ? tinted[0] : tinted;
      m.castShadow = true;
      m.frustumCulled = false;
    });
    for (const h of hideMeshes) h.visible = false;
    for (const h of hitboxes) {
      const mat = h.material as MeshStandardMaterial;
      mat.colorWrite = false;
      mat.depthWrite = false;
    }
    this.group.add(model);
    this.attachRifle(model);
    if (Object.keys(clips).length) {
      this.mixer = new AnimationMixer(model);
      for (const [name, clip] of Object.entries(clips)) {
        const a = this.mixer.clipAction(clip);
        if (name === 'death') {
          a.setLoop(LoopOnce, 1);
          a.clampWhenFinished = true;
        }
        this.actions[name] = a;
      }
      this.playAnim(this.actions.idle ? 'idle' : Object.keys(this.actions)[0]);
    }
  }

  /**
   * 라이플 GLB를 봇 그룹에 붙인다. 위치는 매 프레임 오른손 본을 따라가고,
   * 방향은 손 회전이 아니라 봇의 조준 방향을 향한다 (애니메이션마다 총이 들리거나 비틀리지 않음).
   */
  private attachRifle(model: Group): void {
    const rifleSrc = this.ctx.assets?.rifle;
    if (!rifleSrc) return;
    let hand: Object3D | null = null;
    model.traverse((o) => {
      if (!hand && /right.*hand/i.test(o.name)) hand = o;
    });
    if (!hand) return;
    this.handBone = hand;
    const { group: holder, muzzle } = buildAlignedGun(rifleSrc, 0.78);
    const rifle = holder.children[0];
    // 그립(총 뒤쪽 1/3)이 손 위치에 오도록 총을 앞으로
    const shift = BOT_RIFLE_OFFSET.forwardShift;
    rifle.position.z -= shift;
    const mz = new Object3D();
    mz.position.copy(muzzle);
    mz.position.z -= shift;
    holder.add(mz);
    this.rifleMuzzle = mz;
    // 팀 색 틴트 (플레이어 파랑과 구분)
    const tint = new Color(this.isBoss ? 0xff3030 : 0xff7a3a);
    rifle.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      m.material = mats.map((orig) => {
        const mm = (orig as MeshStandardMaterial).clone();
        mm.color.lerp(tint, 0.7);
        if (mm.emissive) mm.emissive.copy(tint).multiplyScalar(0.35);
        mm.emissiveIntensity = 1;
        return mm;
      }) as unknown as MeshStandardMaterial;
      if (!Array.isArray(m.material) || m.material.length === 1) m.material = (m.material as unknown as MeshStandardMaterial[])[0];
      m.castShadow = true;
    });
    this.rifleHolder = holder;
    this.group.add(holder);
    this.updateRifleTransform();
  }

  /**
   * 라이플: 위치 = 오른손 본, 방향 = 조준 방향 (그룹 로컬)
   * + 비교전 시 총구를 내리고 안쪽으로 돌린 로우레디 자세, 이동 중 걸음에 맞춘 흔들림
   */
  private updateRifleTransform(dt = 0, speed = 0): void {
    if (!this.rifleHolder || !this.handBone) return;
    const holder = this.rifleHolder;
    this.handBone.getWorldPosition(this.tmp);
    this.group.worldToLocal(this.tmp);
    holder.position.copy(this.tmp);
    // 조준 방향을 그룹 로컬로 (그룹은 Y축 facingYaw 회전)
    this.tmp2.copy(this.aimDir).normalize();
    const c = Math.cos(-this.facingYaw);
    const sn = Math.sin(-this.facingYaw);
    const lx = this.tmp2.x * c + this.tmp2.z * sn;
    const lz = -this.tmp2.x * sn + this.tmp2.z * c;
    this.tmp2.set(lx, this.tmp2.y, lz).normalize();
    // 카메라 규약 lookAt: -Z가 목표 방향, up=Y → 롤 없이 총이 뒤집히지 않는다
    this.tmpM.lookAt(Bot.ZERO, this.tmp2, Bot.UP);
    this.tmpQ.setFromRotationMatrix(this.tmpM);
    holder.quaternion.copy(this.tmpQ);
    const engaged = this.canSee || this.ctx.now < this.shootUntil || (this.state === 'combat' && this.mode === 'hiding');
    this.rifleEngage += ((engaged ? 1 : 0) - this.rifleEngage) * Math.min(1, dt * 6);
    const low = 1 - this.rifleEngage;
    this.rifleBob += dt * speed * 2.3;
    const mv = Math.min(1, speed / 4) * (1 - 0.55 * this.rifleEngage);
    const ph = this.rifleBob;
    this.tmpE.set(
      -0.55 * low + Math.sin(ph * 2) * 0.06 * mv,
      0.4 * low + Math.sin(ph) * 0.05 * mv,
      0.3 * low + Math.sin(ph) * 0.1 * mv,
    );
    this.tmpQ2.setFromEuler(this.tmpE);
    holder.quaternion.multiply(this.tmpQ2);
    // 파지 보정: 개머리판이 어깨에 오도록 뒤로·아래로, 반동은 뒤로, 걸음마다 상하
    holder.translateZ(0.06 + this.rifleKick);
    holder.translateY(-0.1 - Math.abs(Math.cos(ph)) * 0.03 * mv);
    this.rifleKick *= 0.8;
  }

  private playAnim(name: string, fade = 0.15): void {
    if (!this.mixer || this.currentAnim === name) return;
    const next = this.actions[name];
    if (!next) return;
    const prev = this.actions[this.currentAnim];
    next.reset().fadeIn(fade).play();
    if (prev) prev.fadeOut(fade);
    this.currentAnim = name;
  }

  /**
   * 이동 속도/방향/상태에 따라 클립 선택.
   * - 몸통은 교전 중이면 조준 방향, 아니면 이동 방향을 본다 (옆걸음 땐 strafe 클립)
   * - 클립 재생 속도를 실제 이동 속도에 연동해 발 미끄러짐을 줄인다
   */
  private updateAnimation(dt: number): void {
    if (!this.mixer) return;
    const now = this.ctx.now;
    this.velocity.copy(this.ctrl.pos).sub(this.lastPos).divideScalar(Math.max(dt, 1e-4));
    this.lastPos.copy(this.ctrl.pos);
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const shooting = now < this.shootUntil;
    const engaged = this.canSee || shooting || (this.state === 'combat' && this.mode === 'hiding');

    // 몸통 방향: 교전 중 조준, 그 외 이동 방향
    let wantYaw: number;
    if (engaged || speed < 0.5) wantYaw = yawOf(this.aimDir);
    else wantYaw = Math.atan2(this.velocity.x, this.velocity.z);
    let d = wantYaw - this.facingYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const maxTurn = 9 * dt; // ≈ 515°/s
    this.facingYaw += Math.max(-maxTurn, Math.min(maxTurn, d));
    this.group.rotation.y = this.facingYaw;

    // 몸통 기준 이동 방향 분해
    const fwd = Math.cos(this.facingYaw) * this.velocity.z + Math.sin(this.facingYaw) * this.velocity.x;
    const lat = Math.cos(this.facingYaw) * this.velocity.x - Math.sin(this.facingYaw) * this.velocity.z;

    if (speed < 0.5) {
      if (shooting && this.actions.aim) {
        this.playAnim('aim', 0.1);
        this.actions.aim.timeScale = 1;
      } else if (shooting && this.actions.shoot) {
        this.playAnim('shoot', 0.1);
        this.actions.shoot.timeScale = 0.25;
      } else if (this.rifleMuzzle && this.actions.aim) {
        // 라이플을 든 대기: 팔을 내린 기본 idle 대신 조준 자세를 아주 느리게 재생 (총이 옆으로 뻗지 않음)
        this.playAnim('aim', 0.2);
        this.actions.aim.timeScale = 0.12;
      } else if (this.actions.idle) this.playAnim('idle');
    } else if (Math.abs(lat) > Math.abs(fwd) * 1.2 && this.actions.strafe) {
      this.playAnim('strafe', 0.12);
      // 왼쪽 걷기 클립: 오른쪽 이동이면 역재생으로 근사
      this.actions.strafe.timeScale = (lat > 0 ? -1 : 1) * Math.max(0.6, speed / 2.6);
    } else if (shooting && this.actions.shoot && fwd > 0) {
      this.playAnim('shoot', 0.1);
      this.actions.shoot.timeScale = Math.max(0.6, speed / 2.2);
    } else if (this.actions.run) {
      this.playAnim('run', 0.12);
      this.actions.run.timeScale = (fwd < -0.3 ? -1 : 1) * Math.max(0.5, speed / 4.8);
    }
    this.mixer.update(dt);
    this.group.updateMatrixWorld(true);
    this.updateRifleTransform(dt, speed);
    if (speed > 1.0 && this.ctrl.onGround) {
      this.stepTimer += dt * speed;
      if (this.stepTimer > 2.2) {
        this.stepTimer = 0;
        this.ctx.sfx.footstep(this.ctrl.pos, 0.5);
      }
    }
  }

  // ---------- 외부 이벤트 ----------

  /** 소리(총성)를 들음 */
  hear(pos: Vector3): void {
    if (!this.alive || this.canSee) return;
    this.lastSeenPos.copy(pos);
    this.lastSeenTime = this.ctx.now;
  }

  /** 섬광탄 실명: 지정 시간 동안 시야 상실 + 조준 정지 */
  blind(duration: number): void {
    if (!this.alive) return;
    this.blindUntil = Math.max(this.blindUntil, this.ctx.now + duration);
    this.canSee = false;
    this.firstSeenTime = Infinity;
    this.visorMat.emissive.setHex(0xffffff);
    this.visorMat.emissiveIntensity = 3;
  }

  get blinded(): boolean {
    return this.ctx.now < this.blindUntil;
  }

  /** 플레이어가 보이는 상태인지 (토큰 배분용) */
  get seesPlayer(): boolean {
    return this.canSee;
  }

  takeDamage(info: DamageInfo): void {
    if (!this.alive) return;
    this.hp -= info.amount;
    this.flashUntil = this.ctx.now + 0.08;
    this.bodyMat.emissive.setHex(0xffffff);
    this.headMat.emissive.setHex(0xffffff);
    for (const m of this.skinMats) m.emissive.setHex(0x888888);
    if (info.attacker) {
      this.lastSeenPos.copy(info.attacker.position);
      this.lastSeenTime = this.ctx.now;
      if (!this.canSee) this.firstSeenTime = this.ctx.now;
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.die(info.headshot);
    }
  }

  private die(headshot: boolean): void {
    this.alive = false;
    this.state = 'dead';
    this.debugLine.visible = false;
    this.ctx.sfx.botDeath(this.ctrl.pos);
    // 피격 발광이 시체에 남지 않도록
    this.bodyMat.emissive.setHex(0x000000);
    this.headMat.emissive.setHex(0x000000);
    for (const m of this.skinMats) m.emissive.setHex(0x000000);
    if (this.mixer && this.actions.death) {
      // 사망 애니메이션 재생 후 디졸브 (봇 update는 멈추므로 자체 타이머로 진행)
      this.playAnim('death', 0.05);
      const mixer = this.mixer;
      const group = this.group;
      const fx = this.ctx.fx;
      const dur = Math.min(2.0, this.actions.death.getClip().duration);
      let last = performance.now();
      let t = 0;
      const tick = (): void => {
        const nowMs = performance.now();
        const step = Math.min(0.05, (nowMs - last) / 1000);
        last = nowMs;
        mixer.update(step);
        t += step;
        if (t >= dur) fx.dissolve(group, 0.6);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } else {
      this.ctx.fx.dissolve(this.group, this.isBoss ? 1.2 : 0.6);
    }
    this.ctx.onBotKilled(this, headshot);
  }

  // ---------- 업데이트 ----------

  update(dt: number): void {
    if (!this.alive) return;
    const ctx = this.ctx;
    const now = ctx.now;
    this.weapon.update(now, dt);

    if (now >= this.flashUntil && this.bodyMat.emissive.getHex() !== 0) {
      this.bodyMat.emissive.setHex(0x000000);
      this.headMat.emissive.setHex(0x000000);
      for (const m of this.skinMats) m.emissive.setHex(0x000000);
    }
    if (!this.blinded && this.visorMat.emissiveIntensity !== 0.9) {
      this.visorMat.emissive.setHex(this.visorColor);
      this.visorMat.emissiveIntensity = 0.9;
    }
    if (this.blinded) {
      // 실명: 제자리에서 비틀거림
      this.wish.set(Math.sin(now * 7) * 1.2, 0, Math.cos(now * 5) * 1.2);
      this.ctrl.moveAndSlide(dt, this.wish);
      this.group.position.copy(this.ctrl.pos);
      return;
    }

    if (now >= this.nextPerception) {
      this.nextPerception = now + 0.1;
      this.perceive();
    }
    const alert = now - this.lastSeenTime < MEMORY_SECONDS;

    // 힐팩 후퇴 판단
    const d = ctx.difficulty;
    if (
      d.retreatHpRatio > 0 && !this.isBoss && this.state !== 'retreat' && now - this.lastRetreatTime > RETREAT_COOLDOWN &&
      this.hp / this.maxHp < d.retreatHpRatio
    ) {
      this.enterRetreat();
    }

    switch (this.state) {
      case 'patrol':
        if (this.canSee) this.enter('combat');
        else if (alert) this.enter('chase');
        else this.patrol(dt);
        break;
      case 'chase':
        if (this.canSee) this.enter('combat');
        else if (!alert) this.enter('patrol');
        else this.chase(dt);
        break;
      case 'combat':
        this.combat(dt, alert);
        break;
      case 'retreat':
        this.retreat(dt);
        break;
      case 'dead':
        return;
    }

    if (this.canSee && this.state !== 'retreat') this.aimAndFire(dt);
    else if (this.state === 'combat' && this.mode === 'hiding') {
      rotateTowards(this.aimDir, this.tmp.copy(this.lastSeenPos).sub(this.ctrl.pos).setY(0).normalize(), 240 * dt);
    } else rotateTowards(this.aimDir, this.tmp.copy(this.moveDir).setY(0).normalize(), 180 * dt);

    this.group.position.copy(this.ctrl.pos);
    this.group.position.y += this.ctrl.visualYOffset;
    if (this.mixer) this.updateAnimation(dt);
    else this.group.rotation.y = yawOf(this.aimDir);
    this.syncHitboxMatrices();
  }

  /** 렌더와 무관하게 히트박스 월드 행렬을 최신으로 (레이캐스트 정확도, 저프레임/헤드리스 시뮬레이션 대비) */
  private syncHitboxMatrices(): void {
    this.group.updateMatrix();
    this.group.matrixWorld.copy(this.group.matrix);
    for (const h of this.hitMeshes) h.updateMatrixWorld();
  }

  private enter(s: BotState): void {
    if (this.state === s) return;
    this.state = s;
    this.nextRepath = 0;
    this.stuckTimer = 0;
    if (s === 'combat') {
      this.mode = 'engage';
      this.burstLeft = randInt(...this.ctx.difficulty.burstLength);
    }
    if (s === 'patrol') this.patrolTarget = null;
  }

  // ---------- 지각 ----------

  private perceive(): void {
    const ctx = this.ctx;
    const player = ctx.player;
    const wasSeeing = this.canSee;
    if (!player.alive || this.blinded) {
      this.canSee = false;
      return;
    }
    this.eye.copy(this.ctrl.pos).setY(this.ctrl.pos.y + this.eyeHeight);
    const pEye = this.tmp.copy(player.position).setY(player.position.y + 1.5);
    const dist = this.eye.distanceTo(pEye);
    if (dist > SIGHT_RANGE) {
      this.canSee = false;
      return;
    }
    const alert = ctx.now - this.lastSeenTime < MEMORY_SECONDS;
    const toP = this.tmp2.copy(pEye).sub(this.eye).setY(0);
    const facing = this.tmp3.set(this.aimDir.x, 0, this.aimDir.z);
    const inFov = angleBetweenDeg(toP, facing) < FOV_HALF_DEG;
    if (!inFov && !alert) {
      this.canSee = false;
      return;
    }
    const chest = this.tmp2.copy(player.position).setY(player.position.y + 1.0);
    const visible = !losBlocked(this.eye, pEye, ctx.map.meshes) || !losBlocked(this.eye, chest, ctx.map.meshes);
    this.canSee = visible;
    if (visible) {
      if (!wasSeeing && ctx.now - this.lastSeenTime > 1) this.firstSeenTime = ctx.now;
      else if (!wasSeeing) this.firstSeenTime = Math.min(this.firstSeenTime, ctx.now);
      this.lastSeenPos.copy(player.position);
      this.lastSeenTime = ctx.now;
    } else if (wasSeeing) {
      this.firstSeenTime = Infinity;
    }
  }

  // ---------- 조준/사격 ----------

  private aimAndFire(dt: number): void {
    const ctx = this.ctx;
    const d = ctx.difficulty;
    const now = ctx.now;
    const player = ctx.player;
    if (now >= this.nextNoise) {
      this.nextNoise = now + 0.35;
      const sigma = d.aimSigmaDeg * this.aimSigmaMult * DEG2RAD;
      this.noiseYaw = gaussian() * sigma;
      this.noisePitch = gaussian() * sigma;
      this.aimHead = Math.random() < d.headshotChance;
    }
    this.eye.copy(this.ctrl.pos).setY(this.ctrl.pos.y + this.eyeHeight);
    const target = this.tmp.copy(player.position);
    target.y += this.aimHead ? 1.62 : 1.0;
    this.desired.copy(target).sub(this.eye);
    const dist = this.desired.length();
    this.desired.divideScalar(dist || 1);
    const right = this.tmp2.set(-this.desired.z, 0, this.desired.x).normalize();
    target.addScaledVector(right, Math.tan(this.noiseYaw) * dist);
    target.y += Math.tan(this.noisePitch) * dist;
    const noisy = this.tmp2.copy(target).sub(this.eye).normalize();
    rotateTowards(this.aimDir, noisy, d.aimSpeedDeg * dt);

    if (now < this.firstSeenTime + d.reactionTime * this.reactionMult) return;
    if (this.weapon.ammo === 0) {
      if (this.weapon.startReload(now)) this.onReloadStarted();
      return;
    }
    if (this.weapon.reloading || now < this.burstPauseUntil) return;
    if (angleBetweenDeg(this.aimDir, this.desired) > 8) return;
    if (!this.weapon.canFire(now)) return;
    if (!this.hasAttackToken && !this.isBoss) return;

    this.fire();
    if (--this.burstLeft <= 0) {
      this.burstPauseUntil = now + randRange(...d.burstPause);
      this.burstLeft = randInt(...d.burstLength);
      this.burstJustEnded = true;
    }
  }

  private onReloadStarted(): void {
    const d = this.ctx.difficulty;
    if (this.state !== 'combat' || this.mode !== 'engage') return;
    if (d.cover === 'always' || (d.cover === 'lowhp' && this.hp / this.maxHp < 0.5)) this.tryCover();
  }

  private fire(): void {
    const ctx = this.ctx;
    if (!this.weapon.fire(ctx.now)) return;
    this.shootUntil = ctx.now + 0.35;
    this.rifleKick = 0.06;
    const dir = jitterDirection(this.aimDir, this.weapon.spread);
    const res = hitscan(this.eye, dir, this.weapon.def.range, ctx.map.meshes, ctx.hittables(), this);
    const muzzle = this.tmp;
    if (this.rifleMuzzle) this.rifleMuzzle.getWorldPosition(muzzle);
    else {
      muzzle.copy(this.eye).addScaledVector(dir, 0.7);
      muzzle.y -= 0.35 * this.scale;
    }
    ctx.fx.bolt(muzzle, res.point, this.isBoss ? 0xff4040 : 0xff8a5a, res.target === ctx.player ? 0xff4040 : 0xffb27a, res.target ? 4 : 2, 140);
    ctx.fx.muzzleSprite(muzzle, 0.22);
    const distToPlayer = this.ctrl.pos.distanceTo(ctx.player.position);
    ctx.sfx.shootFar(Math.max(0.05, 0.35 - distToPlayer * 0.006), muzzle);
    if (res.target === ctx.player) {
      const headshot = res.part === 'head';
      const dmg = Math.max(1, Math.round(computeDamage(this.weapon.def, res.distance, headshot) * ctx.difficulty.damageMult));
      ctx.player.takeDamage({ amount: dmg, headshot, from: this.ctrl.pos, attacker: this });
    }
  }

  // ---------- 이동 ----------

  private setPathTo(target: Vector3): void {
    this.path = this.ctx.nav.findPath(this.ctrl.pos, target);
    this.pathIdx = 0;
    this.stuckTimer = 0;
    this.updateDebugLine();
  }

  private pathArrived(): boolean {
    return this.pathIdx >= this.path.length;
  }

  /** 경로 따라 이동. 도착 시 true */
  private followPath(dt: number, speed: number): boolean {
    if (this.pathArrived()) {
      this.ctrl.moveAndSlide(dt, this.wish.set(0, 0, 0));
      return true;
    }
    const target = this.path[this.pathIdx];
    const dir = this.tmp.copy(target).sub(this.ctrl.pos).setY(0);
    const dist = dir.length();
    if (dist < 0.5) {
      this.pathIdx++;
      return this.pathArrived();
    }
    dir.divideScalar(dist);
    this.moveDir.copy(dir);
    this.wish.copy(dir).multiplyScalar(speed);
    const moved = this.ctrl.moveAndSlide(dt, this.wish);
    if (moved < speed * dt * 0.25 && this.ctrl.onGround) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.5) {
        this.nextRepath = 0;
        this.stuckTimer = 0;
        this.ctrl.moveAndSlide(dt, this.wish.set(-dir.z, 0, dir.x).multiplyScalar(speed));
      }
    } else this.stuckTimer = 0;
    return false;
  }

  private stand(dt: number): void {
    this.ctrl.moveAndSlide(dt, this.wish.set(0, 0, 0));
  }

  private patrol(dt: number): void {
    if (!this.patrolTarget || this.pathArrived()) {
      this.patrolTarget = this.ctx.nav.randomWalkable();
      this.setPathTo(this.patrolTarget);
    }
    this.followPath(dt, this.hero.moveSpeed * 0.6);
  }

  private chase(dt: number): void {
    if (this.ctx.now >= this.nextRepath) {
      this.nextRepath = this.ctx.now + 0.6;
      this.setPathTo(this.lastSeenPos);
    }
    this.followPath(dt, this.hero.moveSpeed);
  }

  // ---------- 교전 ----------

  private combat(dt: number, alert: boolean): void {
    const ctx = this.ctx;
    const now = ctx.now;
    switch (this.mode) {
      case 'engage': {
        if (!this.canSee) {
          this.enter(alert ? 'chase' : 'patrol');
          return;
        }
        // 버스트 종료 → 엄폐 판단
        if (this.burstJustEnded) {
          this.burstJustEnded = false;
          const d = ctx.difficulty;
          if (d.cover === 'always' || (d.cover === 'lowhp' && this.hp / this.maxHp < 0.5)) {
            if (this.tryCover()) return;
          }
        }
        this.engage(dt);
        return;
      }
      case 'toCover': {
        const arrived = this.followPath(dt, this.hero.moveSpeed * 1.05);
        if (arrived || now >= this.coverTimeout) {
          this.mode = 'hiding';
          const reloadLeft = this.weapon.reloading ? (1 - this.weapon.reloadProgress(now)) * this.weapon.def.reloadTime : 0;
          this.hideUntil = now + Math.max(reloadLeft + 0.3, randRange(0.7, 1.4));
        }
        return;
      }
      case 'hiding': {
        this.stand(dt);
        if (!this.weapon.reloading && this.weapon.ammo < this.weapon.def.magSize) this.weapon.startReload(now);
        // 너무 오래 적을 못 봤으면 추적으로
        if (now - this.lastSeenTime > 6) {
          this.enter('chase');
          return;
        }
        if (now >= this.hideUntil) {
          this.mode = 'peeking';
          this.setPathTo(this.lastSeenPos);
          this.nextRepath = now + 1.0;
        }
        return;
      }
      case 'peeking': {
        if (this.canSee) {
          this.mode = 'engage';
          this.burstLeft = randInt(...ctx.difficulty.burstLength);
          return;
        }
        if (now >= this.nextRepath) {
          this.nextRepath = now + 0.8;
          this.setPathTo(this.lastSeenPos);
        }
        const arrived = this.followPath(dt, this.hero.moveSpeed);
        if (arrived) this.enter(alert ? 'chase' : 'patrol');
        return;
      }
    }
  }

  private engage(dt: number): void {
    const ctx = this.ctx;
    const toP = this.tmp.copy(ctx.player.position).sub(this.ctrl.pos).setY(0);
    const dist = toP.length();
    toP.divideScalar(dist || 1);
    const speed = this.hero.moveSpeed * (this.isBoss ? 0.75 : 0.85);
    const heightGap = ctx.player.position.y - this.ctrl.pos.y;

    // 멀거나, 플레이어가 높은 곳에 있으면 경로로 접근
    if (dist > ENGAGE_MAX || heightGap > 1.5) {
      if (ctx.now >= this.nextRepath) {
        this.nextRepath = ctx.now + 0.5;
        this.setPathTo(ctx.player.position);
      }
      this.followPath(dt, speed);
      return;
    }
    if (dist < ENGAGE_MIN && !this.isBoss) {
      this.wish.copy(toP).multiplyScalar(-speed * 0.8);
      this.moveDir.copy(toP).negate();
      const moved = this.ctrl.moveAndSlide(dt, this.wish);
      if (moved < speed * dt * 0.2) this.strafe(dt, toP, speed);
      return;
    }
    this.strafe(dt, toP, speed);
  }

  private strafe(dt: number, toP: Vector3, speed: number): void {
    const now = this.ctx.now;
    if (now >= this.nextStrafeFlip) {
      this.nextStrafeFlip = now + randRange(1.2, 2.2);
      this.strafeDir *= -1;
    }
    // 옆걸음은 느리게 (크라우치 사이드스텝 클립과 맞고, 맞히기도 쉬워짐)
    this.wish.set(toP.z, 0, -toP.x).multiplyScalar(this.strafeDir * speed * 0.55);
    this.moveDir.copy(this.wish).normalize();
    const moved = this.ctrl.moveAndSlide(dt, this.wish);
    if (moved < speed * dt * 0.2) {
      this.strafeDir *= -1;
      this.nextStrafeFlip = now + randRange(1.0, 1.8);
    }
  }

  /** 엄폐 지점 탐색: 반경 10m 내 걷기 가능 지점 중 플레이어 시야가 막힌 가장 가까운 곳 */
  private tryCover(): boolean {
    const ctx = this.ctx;
    const pEye = this.tmp3.copy(ctx.player.position).setY(ctx.player.position.y + 1.5);
    const candidates: { p: Vector3; d: number }[] = [];
    for (let i = 0; i < 24; i++) {
      const p = ctx.nav.randomWalkableNear(this.ctrl.pos, 10, 1);
      if (!p) continue;
      const d = p.distanceTo(this.ctrl.pos);
      if (d < 1.5) continue;
      candidates.push({ p, d });
    }
    candidates.sort((a, b) => a.d - b.d);
    let pathTries = 0;
    for (const c of candidates) {
      const standEye = this.tmp.copy(c.p).setY(c.p.y + this.eyeHeight);
      if (!losBlocked(pEye, standEye, ctx.map.meshes)) continue;
      if (++pathTries > 3) break;
      const path = ctx.nav.findPath(this.ctrl.pos, c.p);
      if (path.length === 0) continue;
      this.path = path;
      this.pathIdx = 0;
      this.updateDebugLine();
      this.mode = 'toCover';
      this.coverTimeout = ctx.now + 3;
      return true;
    }
    return false;
  }

  // ---------- 후퇴 (힐팩) ----------

  private enterRetreat(): void {
    const ctx = this.ctx;
    this.lastRetreatTime = ctx.now;
    // 가장 가까운 활성 힐팩
    let best: HealthPack | null = null;
    let bestD = Infinity;
    for (const pk of ctx.packs) {
      if (!pk.active) continue;
      const d = pk.position.distanceTo(this.ctrl.pos);
      if (d < bestD) {
        bestD = d;
        best = pk;
      }
    }
    if (best && bestD < 45) {
      this.retreatPack = best;
      this.setPathTo(best.position);
      this.state = 'retreat';
      this.retreatUntil = ctx.now + 10;
      return;
    }
    // 힐팩 없음: 플레이어에게서 먼 곳으로 잠시 이탈
    let far: Vector3 | null = null;
    let farD = 0;
    for (let i = 0; i < 8; i++) {
      const p = ctx.nav.randomWalkable();
      const d = p.distanceTo(ctx.player.position);
      if (d > farD) {
        farD = d;
        far = p;
      }
    }
    if (!far) return;
    this.retreatPack = null;
    this.setPathTo(far);
    this.state = 'retreat';
    this.retreatUntil = ctx.now + 4;
  }

  private retreat(dt: number): void {
    const ctx = this.ctx;
    if (this.retreatPack && (!this.retreatPack.active || this.hp >= this.maxHp * 0.9)) {
      // 먹었거나 누가 가져감
      this.retreatPack = null;
      this.enter('chase');
      return;
    }
    if (this.retreatPack && ctx.now >= this.nextRepath) {
      this.nextRepath = ctx.now + 1.0;
      this.setPathTo(this.retreatPack.position);
    }
    const arrived = this.followPath(dt, this.hero.moveSpeed);
    if ((arrived && !this.retreatPack) || ctx.now >= this.retreatUntil) {
      this.retreatPack = null;
      this.enter('chase');
    }
  }

  // ---------- 디버그 ----------

  private updateDebugLine(): void {
    const pts: number[] = [this.ctrl.pos.x, this.ctrl.pos.y + 0.3, this.ctrl.pos.z];
    for (const p of this.path) pts.push(p.x, p.y + 0.3, p.z);
    this.debugLine.geometry.dispose();
    this.debugLine.geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pts, 3));
  }

  setDebug(on: boolean): void {
    this.debugLine.visible = on && this.alive;
    const c: Record<BotState, number> = { patrol: 0x8ec5ff, chase: 0xffd166, combat: 0xff5a2f, retreat: 0xb5ff8e, dead: 0x555555 };
    this.debugMat.color = new Color(c[this.state]);
  }

  debugText(): string {
    const mode = this.state === 'combat' && this.mode !== 'engage' ? `/${this.mode}` : '';
    const blind = this.blinded ? ' · BLIND' : '';
    return `${this.displayName} · ${this.state.toUpperCase()}${mode}${blind} · ${this.hp}/${this.maxHp}${this.canSee ? ' · 👁' : ''}`;
  }
}
