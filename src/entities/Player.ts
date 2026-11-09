import {
  Box3, BoxGeometry, CapsuleGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera,
  SphereGeometry, Vector3, MathUtils,
} from 'three';
import { CharacterController } from './CharacterController';
import { Weapon } from '@/combat/Weapon';
import { GRAVITY, RAVEN } from '@/data/heroes';
import { SPAWN_INVULN_SECONDS } from '@/data/waves';
import { computeDamage, hitscan, losBlocked, tagHitMesh, type DamageInfo, type Hittable } from '@/combat/Hitscan';
import { PulseRocket, type RocketHit } from '@/combat/PulseRocket';
import { HealField } from '@/combat/HealField';
import { buildAlignedGun } from '@/render/GunAlign';
import { addArmSleeves } from '@/render/ArmSleeves';
import { angleBetweenDeg, clamp, DEG2RAD, jitterDirection } from '@/core/MathUtil';
import type { PlayerInput } from '@/core/PlayerInput';
import type { GameContext } from '@/core/Context';
import type { Healable } from '@/world/HealthPack';
import type { Bot } from './Bot';

export interface PlayerStats {
  shots: number;
  hits: number;
  headshots: number;
  kills: number;
  deaths: number;
  streak: number;
  maxStreak: number;
  rockets: number;
  fields: number;
  ults: number;
  damageTaken: number;
}

/** 1인칭 팔+총 일체형 모델 배치 (뷰모델 로컬). 스크린샷으로 튜닝 */
const FP_ARMS_LENGTH = 1.1;
/** 홀더(모델 중심) 위치: 팔 절단면이 카메라 아래쪽 바깥, 총구가 약 1.1m 앞 */
const FP_ARMS_OFFSET = new Vector3(0.0, 0.0, -0.9);
/** x: 총열 피치, y: 요, z: 롤 — 모델 Y업을 믿으므로 롤은 0 */
const FP_ARMS_ROT = new Vector3(0.12, 0.06, 0.0);
/** 일체형 뷰모델일 때 뷰모델 그룹 기준 위치 (양팔이라 중앙에 가깝고 낮게) */
const FP_ARMS_VM_BASE = new Vector3(0.21, -0.26, -0.1);

const emptyStats = (): PlayerStats => ({ shots: 0, hits: 0, headshots: 0, kills: 0, deaths: 0, streak: 0, maxStreak: 0, rockets: 0, fields: 0, ults: 0, damageTaken: 0 });

interface LockTarget {
  bot: Bot;
  point: Vector3;
  angle: number;
}

/** 1인칭 플레이어 (레이븐) — 펄스 라이플 / Shift 달리기 / 우클릭 펄스 로켓 / E 치유 필드 / Q 전술 조준 */
export class Player implements Hittable, Healable {
  readonly hero = RAVEN;
  readonly displayName = 'YOU';
  readonly ctrl: CharacterController;
  readonly weapon = new Weapon(RAVEN.weapon);
  readonly camera: PerspectiveCamera;
  readonly hitMeshes: Mesh[] = [];
  /** 히트박스 컨테이너 (씬에 추가) */
  readonly hitGroup = new Group();
  readonly viewmodel = new Group();
  private readonly muzzle = new Object3D();
  private readonly coreMat: MeshStandardMaterial;
  private rifleHolder: Group | null = null;
  /** 뷰모델 그룹 기준 위치 (모션 오프셋이 더해진다) */
  private readonly vmBase = new Vector3(0.32, -0.28, -0.55);
  hp = RAVEN.hp;
  alive = true;
  invulnUntil = 0;
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022;
  ultCharge = 0;
  stats: PlayerStats = emptyStats();
  ctx!: GameContext;

  // 스킬 상태
  rocketReadyAt = 0;
  fieldReadyAt = 0;
  private ultUntil = 0;
  private ultReadyAnnounced = false;
  private lockShown = false;
  private baseFov = 80;

  // 뷰모델 모션
  private recoil = 0;
  private bob = 0;
  private bobAmp = 0;
  private swayX = 0;
  private swayY = 0;
  private strafeTilt = 0;
  private sprintBlend = 0;
  private landKick = 0;
  private wasOnGround = true;
  private prevVelY = 0;
  private rocketKick = 0;
  sprinting = false;
  /** 뷰모델 전용 렌더 레이어 (벽 뚫림 방지용 2패스) */
  static readonly VIEWMODEL_LAYER = 1;
  /** 뷰모델 전용 FOV(월드 FOV와 분리해 팔·총이 과장되지 않게) */
  static readonly VIEWMODEL_FOV = 56;
  private readonly eyeHeight = 1.6;
  /** 사망 카메라: 쓰러지는 시간(초, -1이면 비활성), 기울 방향, 처치자 쪽 요 */
  private deathT = -1;
  private deathRoll = 0;
  private deathYaw0 = 0;
  private deathYawDelta = 0;
  private deathPitch0 = 0;
  private readonly bodyHit: Mesh;
  private readonly headHit: Mesh;
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly wish = new Vector3();
  private readonly shotDir = new Vector3();
  private readonly tmp = new Vector3();
  private readonly camDir = new Vector3();
  private lastMoved = 0;

  get position(): Vector3 {
    return this.ctrl.pos;
  }

  get maxHp(): number {
    return this.hero.hp;
  }

  get ultActive(): boolean {
    return this.ctx.now < this.ultUntil;
  }

  constructor(colliders: Box3[], camera: PerspectiveCamera) {
    this.ctrl = new CharacterController(colliders);
    this.camera = camera;
    this.camera.rotation.order = 'YXZ';
    this.baseFov = camera.fov;

    const invis = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    this.bodyHit = tagHitMesh(new Mesh(new CapsuleGeometry(0.35, 0.8, 4, 8), invis), this, 'body');
    this.headHit = tagHitMesh(new Mesh(new SphereGeometry(0.22, 8, 8), invis), this, 'head');
    this.hitMeshes.push(this.bodyHit, this.headHit);
    this.hitGroup.add(this.bodyHit, this.headHit);

    this.coreMat = new MeshStandardMaterial({ color: 0x2f80ff, emissive: 0x1a4fb0, emissiveIntensity: 0.6, roughness: 0.4 });
    this.buildViewmodel();
    camera.add(this.viewmodel);
    this.viewmodel.traverse((o) => o.layers.set(Player.VIEWMODEL_LAYER));
  }

  private buildViewmodel(): void {
    const dark = new MeshStandardMaterial({ color: 0x1d2633, roughness: 0.6, metalness: 0.4 });
    const body = new Mesh(new BoxGeometry(0.11, 0.16, 0.5), dark);
    const barrel = new Mesh(new BoxGeometry(0.05, 0.05, 0.35), dark);
    barrel.position.set(0, 0.05, -0.4);
    const core = new Mesh(new BoxGeometry(0.12, 0.05, 0.2), this.coreMat);
    core.position.set(0, 0.02, -0.1);
    const grip = new Mesh(new BoxGeometry(0.06, 0.18, 0.08), dark);
    grip.position.set(0, -0.15, 0.1);
    grip.rotation.x = 0.3;
    this.muzzle.position.set(0, 0.05, -0.58);
    this.viewmodel.add(body, barrel, core, grip, this.muzzle);
    this.viewmodel.position.set(0.32, -0.28, -0.55);
  }

  /** 생성된 라이플 GLB로 뷰모델 교체 (정점 주축으로 총열을 -Z에 정렬) */
  applyRifleModel(model: Group): void {
    const { group: holder, muzzle, yawErrorDeg } = buildAlignedGun(model, 0.62);
    console.info(`[Gun] 뷰모델 정렬: 원본 총열 축이 Z에서 ${yawErrorDeg.toFixed(1)}° 틀어져 있어 보정`);
    for (const c of [...this.viewmodel.children]) if (c !== this.muzzle) c.visible = false;
    holder.position.set(0.02, -0.04, -0.02);
    holder.rotation.y = 0.035;
    this.viewmodel.add(holder);
    this.viewmodel.remove(this.muzzle);
    holder.add(this.muzzle);
    this.muzzle.position.copy(muzzle);
    this.rifleHolder = holder;
    this.viewmodel.traverse((o) => {
      o.layers.set(Player.VIEWMODEL_LAYER);
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });
  }

  /**
   * 힉스필드 생성 1인칭 팔+라이플 일체형 모델로 뷰모델 교체.
   * 주축 정렬(총열 -Z, 위 +Y) 후 총구는 맨 앞 지점. 라이플 단독 뷰모델은 숨긴다.
   */
  applyFpArmsModel(model: Group): void {
    // 모델의 Y업을 그대로 두고 총열 요만 -Z로 맞춘다(팔 때문에 롤이 생기지 않음)
    const { group: holder, muzzle, yawErrorDeg } = buildAlignedGun(model, FP_ARMS_LENGTH, true);
    console.info(`[Gun] 1인칭 팔 모델 정렬: 요 ${yawErrorDeg.toFixed(1)}° 보정 (Y업 유지)`);
    if (this.rifleHolder) this.rifleHolder.visible = false;
    for (const c of [...this.viewmodel.children]) if (c !== this.muzzle) c.visible = false;
    holder.position.copy(FP_ARMS_OFFSET);
    holder.rotation.set(FP_ARMS_ROT.x, FP_ARMS_ROT.y, FP_ARMS_ROT.z);
    this.vmBase.copy(FP_ARMS_VM_BASE);
    this.viewmodel.add(holder);
    // 전완 절단면 → 어깨(카메라 아래·뒤 양쪽) 방향으로 상완을 이어 붙여 팔이 화면 밖으로 자연스럽게 빠져나가게
    this.viewmodel.position.copy(this.vmBase);
    this.viewmodel.rotation.set(0, 0, 0);
    this.camera.updateMatrixWorld(true);
    const shoulder = (x: number) => holder.worldToLocal(this.camera.localToWorld(new Vector3(x, -0.42, 0.3)));
    const sleeves = addArmSleeves(holder, { shoulders: [shoulder(-0.26), shoulder(0.26)] });
    console.info(`[Gun] 1인칭 팔 절단부 ${sleeves.length / 2}곳에 관절·상완 연결`);
    this.muzzle.parent?.remove(this.muzzle);
    holder.add(this.muzzle);
    this.muzzle.position.copy(muzzle);
    this.viewmodel.traverse((o) => {
      o.layers.set(Player.VIEWMODEL_LAYER);
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });
  }

  spawn(pos: Vector3, now: number): void {
    this.ctrl.teleport(pos);
    this.hp = this.hero.hp;
    this.alive = true;
    this.invulnUntil = now + SPAWN_INVULN_SECONDS;
    this.weapon.reset();
    this.yaw = 0;
    this.pitch = 0;
    this.recoil = 0;
    this.ultUntil = 0;
    this.rocketReadyAt = Math.min(this.rocketReadyAt, now);
    this.fieldReadyAt = Math.min(this.fieldReadyAt, now);
    this.viewmodel.visible = true;
    this.deathT = -1;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
    this.syncCamera();
    this.syncHitboxes();
  }

  resetStats(): void {
    this.stats = emptyStats();
    this.ultCharge = 0;
    this.ultReadyAnnounced = false;
    this.rocketReadyAt = 0;
    this.fieldReadyAt = 0;
  }

  /** 사망 카메라 시작: 처치자 방향으로 천천히 고개가 돌아가며, 맞은 쪽 반대로 기울어 바닥에 쓰러진다 */
  private beginDeathCam(from: Vector3): void {
    const p = this.ctrl.pos;
    const dx = from.x - p.x;
    const dz = from.z - p.z;
    this.deathYaw0 = this.yaw;
    this.deathPitch0 = this.pitch;
    const target = Math.abs(dx) + Math.abs(dz) > 1e-3 ? Math.atan2(-dx, -dz) : this.yaw;
    let delta = target - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.deathYawDelta = delta;
    // 오른쪽에서 맞으면 왼쪽으로 쓰러진다
    const rightDot = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
    this.deathRoll = (rightDot > 0 ? 1 : -1) * 0.6;
    this.deathT = 0;
  }

  /** Game이 사망 상태 동안 매 스텝 호출. 가속하며 쓰러지고 바닥에서 살짝 튕긴 뒤 누운 채 처치자를 본다 */
  updateDeathCam(dt: number): void {
    if (this.deathT < 0) return;
    this.deathT += dt;
    const FALL = 0.75;
    const k = Math.min(1, this.deathT / FALL);
    const ease = k * k;
    const sm = k * k * (3 - 2 * k);
    let bounce = 0;
    if (k >= 1) {
      const b = (this.deathT - FALL) / 0.28;
      if (b < 1) bounce = Math.sin(b * Math.PI) * 0.06;
    }
    const eye = this.eyeHeight + (0.32 - this.eyeHeight) * ease + bounce;
    const yawK = Math.min(1, this.deathT / 1.4);
    const yaw = this.deathYaw0 + this.deathYawDelta * (yawK * yawK * (3 - 2 * yawK));
    const pitch = this.deathPitch0 + (0.3 - this.deathPitch0) * sm;
    const roll = this.deathRoll * sm + bounce * 1.5 * Math.sign(this.deathRoll);
    const p = this.ctrl.pos;
    this.camera.position.set(p.x, p.y + eye, p.z);
    this.camera.rotation.set(pitch, yaw, roll);
  }

  private syncCamera(): void {
    const p = this.ctrl.pos;
    // 카메라 상하 흔들림은 아주 작게 (멀미 방지), 총이 대부분의 움직임을 표현한다
    const camBob = Math.sin(this.bob * 2) * 0.012 * this.bobAmp;
    this.camera.position.set(p.x, p.y + this.eyeHeight + this.ctrl.visualYOffset + camBob - this.landKick * 0.4, p.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  private syncHitboxes(): void {
    const p = this.ctrl.pos;
    this.bodyHit.position.set(p.x, p.y + 0.75, p.z);
    this.headHit.position.set(p.x, p.y + 1.62, p.z);
    this.hitGroup.updateMatrixWorld(true);
  }

  update(dt: number, input: PlayerInput): void {
    const ctx = this.ctx;
    const now = ctx.now;
    if (!this.alive) return;
    const ab = this.hero.abilities;

    // 시점
    const m = input.consumeMouse();
    const maxTurn = 1.05;
    this.yaw -= clamp(m.dx * this.sensitivity, -maxTurn, maxTurn);
    this.pitch = clamp(this.pitch - clamp(m.dy * this.sensitivity, -maxTurn, maxTurn), -89 * DEG2RAD, 89 * DEG2RAD);
    const k = Math.min(1, dt * 12);
    this.swayX += (clamp(-m.dx * 0.0009, -0.06, 0.06) - this.swayX) * k;
    this.swayY += (clamp(-m.dy * 0.0009, -0.05, 0.05) - this.swayY) * k;
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // 궁 게이지
    const ultActive = this.ultActive;
    if (!ultActive) {
      this.ultCharge = Math.min(ab.ult.chargeNeeded, this.ultCharge + ab.ult.chargePerSecond * dt);
      if (this.ultCharge >= ab.ult.chargeNeeded && !this.ultReadyAnnounced) {
        this.ultReadyAnnounced = true;
        ctx.sfx.ultReady();
        ctx.hud.killFeed('전술 조준 준비 완료 (Q)', 'hs');
      }
    }

    // 스킬 입력
    if (input.mouseDown[2]) this.tryRocket();
    if (input.justPressed('KeyE')) this.tryHealField();
    if (input.justPressed('KeyQ')) this.tryUlt();

    // 이동 — Shift 유지 = 달리기 (앞으로 이동 중, 사격 중이 아닐 때만)
    const f = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    const r = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    const firing = input.mouseDown[0] || now < this.rocketKickUntil;
    this.sprinting = (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) && f > 0 && this.ctrl.onGround && !firing;
    const speed = this.hero.moveSpeed * (this.sprinting ? ab.sprint.speedMult : 1);
    this.wish.set(0, 0, 0).addScaledVector(this.forward, f).addScaledVector(this.right, r);
    if (this.wish.lengthSq() > 0) this.wish.normalize().multiplyScalar(speed);
    let jumpVel = 0;
    if (input.justPressed('Space') && this.ctrl.onGround) {
      jumpVel = Math.sqrt(2 * GRAVITY * this.hero.jumpHeight);
      ctx.sfx.jump();
    }
    this.prevVelY = this.ctrl.vel.y;
    this.lastMoved = this.ctrl.moveAndSlide(dt, this.wish, jumpVel);
    const moveSpeed = this.lastMoved / Math.max(dt, 1e-4);

    // 착지 감지 → 총·카메라가 살짝 눌린다
    if (this.ctrl.onGround && !this.wasOnGround) {
      this.landKick = Math.min(0.09, Math.abs(this.prevVelY) * 0.006);
      if (Math.abs(this.prevVelY) > 4) ctx.sfx.footstep(undefined, 0.4);
    }
    this.wasOnGround = this.ctrl.onGround;
    this.landKick = Math.max(0, this.landKick - dt * 0.35);

    // 걸음 사이클: 이동 속도에 비례한 위상·진폭
    const targetAmp = this.ctrl.onGround ? clamp(moveSpeed / this.hero.moveSpeed, 0, 1.6) : 0;
    this.bobAmp += (targetAmp - this.bobAmp) * Math.min(1, dt * 8);
    if (this.ctrl.onGround && moveSpeed > 0.3) {
      const prev = this.bob;
      this.bob += dt * (this.sprinting ? 13.5 : 10.5);
      if (Math.floor(prev / Math.PI) !== Math.floor(this.bob / Math.PI)) ctx.sfx.footstep(undefined, this.sprinting ? 0.32 : 0.25);
    }

    // 무기
    this.weapon.update(now, dt);
    if (input.justPressed('KeyR') && this.weapon.startReload(now)) ctx.sfx.reload();
    if (this.weapon.ammo === 0 && !this.weapon.reloading && this.weapon.startReload(now)) ctx.sfx.reload();
    if (input.mouseDown[0] && !this.sprinting) {
      if (this.weapon.canFire(now)) this.fire();
      else if (input.mousePressed[0] && this.weapon.ammo === 0) ctx.sfx.empty();
    }
    this.recoil = Math.max(0, this.recoil - dt * 7);
    this.rocketKick = Math.max(0, this.rocketKick - dt * 3);

    this.animateViewmodel(dt, now, r);
    this.coreMat.emissiveIntensity = ultActive ? 2.0 + Math.sin(now * 14) * 0.6 : 0.6;

    // FOV (달리기 확장)
    const targetFov = this.baseFov + (this.sprinting ? ab.sprint.fovAdd : 0);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 10);
      this.camera.updateProjectionMatrix();
    }

    this.syncCamera();
    this.syncHitboxes();
    this.fxMuzzlePosition(this.tmp);
    ctx.fx.setMuzzlePosition(this.tmp);

    // 전술 조준: 화면 안의 조준 가능한 적 표시
    if (ultActive) {
      const targets = this.lockTargets();
      ctx.hud.setLockMarkers(targets.map((t) => t.point), this.camera);
      this.lockShown = true;
    } else if (this.lockShown) {
      ctx.hud.setLockMarkers([], this.camera);
      this.lockShown = false;
    }

    // HUD
    const hud = ctx.hud;
    hud.setHp(this.hp, this.hero.hp);
    const w = this.weapon;
    hud.setAmmo(w.ammo, w.def.magSize, w.reloading ? `재장전 ${Math.round(w.reloadProgress(now) * 100)}%` : '');
    hud.setCrosshair(6 + this.totalSpread() * 7);
    hud.setUlt((this.ultCharge / ab.ult.chargeNeeded) * 100, ultActive, Math.max(0, this.ultUntil - now));
    hud.setSkill(0, Math.max(0, this.rocketReadyAt - now), ab.rocket.cooldown);
    hud.setSkill(1, Math.max(0, this.fieldReadyAt - now), ab.field.cooldown);
  }

  private rocketKickUntil = 0;

  /**
   * 1인칭 총 모션
   * - 걸음: 8자 궤적(좌우 sin, 상하 |cos|) + 걸음에 맞춘 롤
   * - 달리기: 총을 내리고 안쪽으로 돌려 드는 자세로 블렌드
   * - 옆걸음: 이동 방향으로 기울임, 시선 이동: 뒤처짐(스웨이)
   * - 점프/착지: 공중에서 살짝 올라가고 착지 때 눌림, 정지 시 숨쉬기
   * - 재장전: 내렸다 올리기, 사격/로켓: 반동
   */
  /**
   * 총구 위치를 월드 FOV 기준으로 보정해 돌려준다.
   * 뷰모델은 별도 FOV로 그리므로, 실제 총구 월드 좌표를 그대로 쓰면 궤적·섬광이
   * 화면에 보이는 총구보다 바깥(아래/오른쪽)에서 출발한다. 같은 화면 위치에 오도록 x,y를 스케일한다.
   */
  private fxMuzzlePosition(out: Vector3): Vector3 {
    this.muzzle.getWorldPosition(out);
    this.camera.worldToLocal(out);
    const k = Math.tan(MathUtils.degToRad(this.camera.fov) * 0.5) / Math.tan(MathUtils.degToRad(Player.VIEWMODEL_FOV) * 0.5);
    out.x *= k;
    out.y *= k;
    return this.camera.localToWorld(out);
  }

  private animateViewmodel(dt: number, now: number, strafeInput: number): void {
    const vm = this.viewmodel;
    const a = this.bobAmp;
    const sprintTarget = this.sprinting ? 1 : 0;
    this.sprintBlend += (sprintTarget - this.sprintBlend) * Math.min(1, dt * 9);
    this.strafeTilt += (-strafeInput * 0.07 - this.strafeTilt) * Math.min(1, dt * 7);
    const sb = this.sprintBlend;
    const bobScale = 1 + sb * 0.8;
    const bx = Math.sin(this.bob) * 0.016 * a * bobScale;
    const by = -Math.abs(Math.cos(this.bob)) * 0.018 * a * bobScale + 0.009 * a;
    const bRoll = Math.sin(this.bob) * 0.035 * a * bobScale;
    const breathe = Math.sin(now * 1.7) * 0.0035 * (1 - Math.min(1, a));
    const air = this.ctrl.onGround ? 0 : clamp(-this.ctrl.vel.y * 0.004, -0.035, 0.035);
    const reloadDip = this.weapon.reloading ? Math.sin(this.weapon.reloadProgress(now) * Math.PI) : 0;

    // 재장전: 총구를 살짝 내리고 몸쪽으로 당기며 안쪽으로 굴린다 (위로 들면 카메라 앞 전완 절단면이 화면에 올라온다)
    vm.position.x = this.vmBase.x + bx + this.swayX * 0.25 + sb * 0.03 + reloadDip * 0.04;
    vm.position.y = this.vmBase.y + by + breathe + air - this.landKick * 0.6 - reloadDip * 0.02 - sb * 0.04 - this.rocketKick * 0.03;
    vm.position.z = this.vmBase.z + this.recoil * 0.07 + this.rocketKick * 0.2 + sb * 0.03 + reloadDip * 0.05;
    // 로켓 반동은 위로 들기보다 뒤로 밀기 위주 (위로 들면 카메라 앞 전완 절단면이 보인다)
    vm.rotation.x = this.recoil * 0.12 + this.rocketKick * 0.08 + reloadDip * 0.0 + this.swayY - sb * 0.14 - this.landKick * 1.2;
    vm.rotation.y = this.swayX + sb * 0.28 + reloadDip * 0.14;
    vm.rotation.z = bRoll + this.strafeTilt + reloadDip * 0.35 + sb * 0.18;
  }

  // ---------- 스킬 ----------

  /** 우클릭: 펄스 로켓 — 조준점으로 수렴하도록 총구에서 발사 */
  private tryRocket(): void {
    const ctx = this.ctx;
    const ab = this.hero.abilities.rocket;
    if (ctx.now < this.rocketReadyAt) return;
    this.rocketReadyAt = ctx.now + ab.cooldown;
    this.stats.rockets++;
    this.sprinting = false;
    this.camera.getWorldDirection(this.camDir);
    const aim = hitscan(this.camera.position, this.camDir, ab.range, ctx.map.meshes, ctx.hittables(), this).point;
    this.fxMuzzlePosition(this.tmp);
    const dir = aim.clone().sub(this.tmp).normalize();
    ctx.spawnProjectile(new PulseRocket(ctx, this.tmp.clone(), dir, this, (h) => this.onRocketHit(h)));
    ctx.fx.muzzleSprite(this.tmp, 0.28);
    ctx.fx.muzzleFlash(10);
    ctx.sfx.rocketFire();
    ctx.onNoise(this.ctrl.pos, 30);
    this.rocketKick = 1;
    this.rocketKickUntil = ctx.now + 0.35;
  }

  private onRocketHit(h: RocketHit): void {
    const ctx = this.ctx;
    // 명중률(라이플 기준)에는 포함하지 않는다
    const ab = this.hero.abilities.ult;
    if (!this.ultActive) this.ultCharge = Math.min(ab.chargeNeeded, this.ultCharge + h.amount * ab.chargePerDamage);
    ctx.hud.damageNumber(h.point, this.camera, h.amount, false);
    ctx.hud.hitmarkerFlash(!h.target.alive ? 'kill' : 'hit');
    if (h.direct) ctx.sfx.hit();
  }

  /** E: 치유 필드 — 발밑에 설치 */
  private tryHealField(): void {
    const ctx = this.ctx;
    const ab = this.hero.abilities.field;
    if (ctx.now < this.fieldReadyAt) return;
    this.fieldReadyAt = ctx.now + ab.cooldown;
    this.stats.fields++;
    ctx.spawnProjectile(new HealField(ctx, this.ctrl.pos));
  }

  /** Q: 전술 조준 — 지속 시간 동안 화면 안의 적을 자동으로 조준해 사격 */
  private tryUlt(): void {
    const ctx = this.ctx;
    const ab = this.hero.abilities.ult;
    if (this.ultActive || this.ultCharge < ab.chargeNeeded) return;
    this.ultCharge = 0;
    this.ultReadyAnnounced = false;
    this.ultUntil = ctx.now + ab.duration;
    this.stats.ults++;
    this.weapon.reset(); // 발동 시 즉시 재장전
    ctx.sfx.ultActivate();
    ctx.hud.killFeed('전술 조준 발동!', 'hs');
    ctx.onNoise(this.ctrl.pos, 40);
  }

  /** 화면 안 + 시야선이 열린 적, 조준점에 가까운 순 */
  private lockTargets(): LockTarget[] {
    const ctx = this.ctx;
    const cam = this.camera;
    cam.getWorldDirection(this.camDir);
    const out: LockTarget[] = [];
    for (const b of ctx.bots) {
      if (!b.alive) continue;
      const point = b.position.clone();
      point.y += 1.0 * b.scale;
      const ndc = point.clone().project(cam);
      if (ndc.z > 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
      if (point.distanceTo(cam.position) > this.weapon.def.range) continue;
      if (losBlocked(cam.position, point, ctx.map.meshes)) continue;
      out.push({ bot: b, point, angle: angleBetweenDeg(this.camDir, point.clone().sub(cam.position)) });
    }
    out.sort((x, y) => x.angle - y.angle);
    return out;
  }

  // ---------- 사격 ----------

  private totalSpread(): number {
    const moving = this.lastMoved > 0.001 ? 0.8 : 0;
    const air = this.ctrl.onGround ? 0 : 1.5;
    const sprint = this.sprinting ? this.hero.abilities.sprint.spreadAdd : 0;
    return this.weapon.spread + moving + air + sprint;
  }

  private fire(): void {
    const ctx = this.ctx;
    const now = ctx.now;
    if (!this.weapon.fire(now)) return;
    this.stats.shots++;
    this.recoil = 1;

    const origin = this.camera.position;
    let locked = false;
    if (this.ultActive) {
      const t = this.lockTargets()[0];
      if (t) {
        this.shotDir.copy(t.point).sub(origin).normalize();
        locked = true;
      }
    }
    if (!locked) {
      this.camera.getWorldDirection(this.shotDir);
      jitterDirection(this.shotDir.clone(), this.totalSpread(), this.shotDir);
    }
    const res = hitscan(origin, this.shotDir, this.weapon.def.range, ctx.map.meshes, ctx.hittables(), this);

    this.fxMuzzlePosition(this.tmp);
    const hitColor = res.target ? 0xff7a4a : 0xffd27a;
    ctx.fx.bolt(this.tmp, res.point, this.ultActive ? 0xffd9a0 : 0x8ec5ff, hitColor, res.target ? 6 : 3);
    ctx.fx.muzzleFlash(6);
    ctx.fx.muzzleSprite(this.tmp, 0.26);
    ctx.sfx.shoot();
    ctx.onNoise(this.ctrl.pos, 25);

    if (res.target) {
      // 전술 조준 중에는 몸통 판정(치명타 없음)
      const headshot = res.part === 'head' && !locked;
      const dmg = computeDamage(this.weapon.def, res.distance, headshot);
      res.target.takeDamage({ amount: dmg, headshot, from: this.ctrl.pos, attacker: this });
      this.stats.hits++;
      if (headshot) this.stats.headshots++;
      if (!this.ultActive) this.ultCharge = Math.min(this.hero.abilities.ult.chargeNeeded, this.ultCharge + dmg * this.hero.abilities.ult.chargePerDamage);
      ctx.hud.hitmarkerFlash(!res.target.alive ? 'kill' : headshot ? 'hs' : 'hit');
      ctx.hud.damageNumber(res.point, this.camera, dmg, headshot);
      if (headshot) ctx.sfx.headshot();
      else ctx.sfx.hit();
    }
  }

  takeDamage(info: DamageInfo): void {
    const ctx = this.ctx;
    if (!this.alive || ctx.now < this.invulnUntil) return;
    this.hp -= info.amount;
    this.stats.damageTaken += info.amount;
    ctx.sfx.hurt();
    const ax = info.from.x - this.ctrl.pos.x;
    const az = info.from.z - this.ctrl.pos.z;
    const fwd = ax * this.forward.x + az * this.forward.z;
    const rgt = ax * this.right.x + az * this.right.z;
    ctx.hud.damageDirection(Math.atan2(rgt, fwd));
    ctx.hud.setHp(this.hp, this.hero.hp);
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.stats.deaths++;
      this.stats.streak = 0;
      this.viewmodel.visible = false;
      this.beginDeathCam(info.from);
      this.ultUntil = 0;
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
      ctx.hud.setUlt((this.ultCharge / this.hero.abilities.ult.chargeNeeded) * 100, false, 0);
      ctx.hud.setLockMarkers([], this.camera);
      ctx.sfx.death();
      ctx.onPlayerDied(info.attacker?.displayName ?? '???');
    }
  }
}
