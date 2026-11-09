import {
  Box3, BoxGeometry, CapsuleGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera,
  SphereGeometry, Vector3,
} from 'three';
import { CharacterController } from './CharacterController';
import { Weapon } from '@/combat/Weapon';
import { GRAVITY, RAVEN } from '@/data/heroes';
import { SPAWN_INVULN_SECONDS } from '@/data/waves';
import { computeDamage, hitscan, tagHitMesh, type DamageInfo, type Hittable } from '@/combat/Hitscan';
import { FlashGrenade } from '@/combat/FlashGrenade';
import { buildAlignedGun } from '@/render/GunAlign';
import { clamp, DEG2RAD, jitterDirection } from '@/core/MathUtil';
import type { PlayerInput } from '@/core/PlayerInput';
import type { GameContext } from '@/core/Context';
import type { Healable } from '@/world/HealthPack';

export interface PlayerStats {
  shots: number;
  hits: number;
  headshots: number;
  kills: number;
  deaths: number;
  streak: number;
  maxStreak: number;
  blinks: number;
  flashes: number;
  ults: number;
  damageTaken: number;
}

const emptyStats = (): PlayerStats => ({ shots: 0, hits: 0, headshots: 0, kills: 0, deaths: 0, streak: 0, maxStreak: 0, blinks: 0, flashes: 0, ults: 0, damageTaken: 0 });

/** 1인칭 플레이어 (레이븐) */
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
  blinkReadyAt = 0;
  flashReadyAt = 0;
  private dashUntil = 0;
  private readonly dashDir = new Vector3();
  private ultUntil = 0;
  private ultReadyAnnounced = false;
  private baseFov = 80;

  private recoil = 0;
  private bob = 0;
  private swayX = 0;
  private swayY = 0;
  sprinting = false;
  /** 뷰모델 전용 렌더 레이어 (벽 뚫림 방지용 2패스) */
  static readonly VIEWMODEL_LAYER = 1;
  private readonly eyeHeight = 1.6;
  private readonly bodyHit: Mesh;
  private readonly headHit: Mesh;
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly wish = new Vector3();
  private readonly shotDir = new Vector3();
  private readonly tmp = new Vector3();
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

  get dashing(): boolean {
    return this.ctx.now < this.dashUntil;
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

  /** M3: 생성된 라이플 GLB로 뷰모델 교체 (정점 주축으로 총열을 -Z에 정렬) */
  applyRifleModel(model: Group): void {
    const { group: holder, muzzle, yawErrorDeg } = buildAlignedGun(model, 0.62);
    console.info(`[Gun] 뷰모델 정렬: 원본 총열 축이 Z에서 ${yawErrorDeg.toFixed(1)}° 틀어져 있어 보정`);
    for (const c of [...this.viewmodel.children]) if (c !== this.muzzle) c.visible = false;
    holder.position.set(0.02, -0.04, -0.02);
    // 오른손 파지: 살짝 안쪽(왼쪽)으로 조준점에 수렴하도록
    holder.rotation.y = 0.035;
    this.viewmodel.add(holder);
    this.viewmodel.remove(this.muzzle);
    holder.add(this.muzzle);
    this.muzzle.position.copy(muzzle);
    // 뷰모델은 그림자를 드리우지 않고, 전용 레이어에서 깊이 버퍼를 비운 뒤 그린다 (벽 뚫림 방지)
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
    this.dashUntil = 0;
    this.ultUntil = 0;
    this.blinkReadyAt = Math.min(this.blinkReadyAt, now);
    this.flashReadyAt = Math.min(this.flashReadyAt, now);
    this.viewmodel.visible = true;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
    this.syncCamera();
    this.syncHitboxes();
  }

  resetStats(): void {
    this.stats = emptyStats();
    this.ultCharge = 0;
    this.ultReadyAnnounced = false;
    this.blinkReadyAt = 0;
    this.flashReadyAt = 0;
  }

  private syncCamera(): void {
    const p = this.ctrl.pos;
    this.camera.position.set(p.x, p.y + this.eyeHeight + this.ctrl.visualYOffset + Math.sin(this.bob) * 0.025, p.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  private syncHitboxes(): void {
    const p = this.ctrl.pos;
    this.bodyHit.position.set(p.x, p.y + 0.75, p.z);
    this.headHit.position.set(p.x, p.y + 1.62, p.z);
    // 렌더 전에도 레이캐스트가 맞도록 월드 행렬 갱신
    this.hitGroup.updateMatrixWorld(true);
  }

  update(dt: number, input: PlayerInput): void {
    const ctx = this.ctx;
    const now = ctx.now;
    if (!this.alive) return;
    const ab = this.hero.abilities;

    // 시점
    const m = input.consumeMouse();
    // 한 프레임 회전 상한 (≈ 60°) — 스파이크가 새어 들어와도 화면이 뒤집히지 않게
    const maxTurn = 1.05;
    this.yaw -= clamp(m.dx * this.sensitivity, -maxTurn, maxTurn);
    this.pitch = clamp(this.pitch - clamp(m.dy * this.sensitivity, -maxTurn, maxTurn), -89 * DEG2RAD, 89 * DEG2RAD);
    // 시선 스웨이: 마우스 이동에 뷰모델이 살짝 뒤처진다
    const k = Math.min(1, dt * 12);
    this.swayX += (clamp(-m.dx * 0.0009, -0.06, 0.06) - this.swayX) * k;
    this.swayY += (clamp(-m.dy * 0.0009, -0.05, 0.05) - this.swayY) * k;
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // 궁 상태
    const ultActive = this.ultActive;
    this.weapon.fireRateMult = ultActive ? ab.ult.fireRateMult : 1;
    this.weapon.infiniteAmmo = ultActive;
    if (!ultActive) {
      this.ultCharge = Math.min(ab.ult.chargeNeeded, this.ultCharge + ab.ult.chargePerSecond * dt);
      if (this.ultCharge >= ab.ult.chargeNeeded && !this.ultReadyAnnounced) {
        this.ultReadyAnnounced = true;
        ctx.sfx.ultReady();
        ctx.hud.killFeed('오버클럭 준비 완료 (Q)', 'hs');
      }
    }

    // 스킬 입력 (블링크 = F, Shift는 달리기)
    if (input.justPressed('KeyF')) this.tryBlink();
    if (input.justPressed('KeyE')) this.tryFlash();
    if (input.justPressed('KeyQ')) this.tryUlt();

    // 이동 (Shift 유지 = 달리기; 앞으로 움직일 때만)
    const f0 = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    this.sprinting = (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) && f0 > 0 && this.ctrl.onGround && !this.dashing;
    const speed = this.hero.moveSpeed * (ultActive ? ab.ult.speedMult : 1) * (this.sprinting ? ab.sprint.speedMult : 1);
    let jumpVel = 0;
    if (this.dashing) {
      // 대시 중: 수평 고속 이동, 중력 무시
      this.wish.copy(this.dashDir).multiplyScalar(ab.blink.range / ab.blink.duration);
      this.ctrl.vel.y = 0;
      this.lastMoved = this.ctrl.moveAndSlide(dt, this.wish);
      this.ctrl.vel.y = 0;
    } else {
      const f = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
      const r = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
      this.wish.set(0, 0, 0).addScaledVector(this.forward, f).addScaledVector(this.right, r);
      if (this.wish.lengthSq() > 0) this.wish.normalize().multiplyScalar(speed);
      if (input.justPressed('Space') && this.ctrl.onGround) {
        jumpVel = Math.sqrt(2 * GRAVITY * this.hero.jumpHeight);
        ctx.sfx.jump();
      }
      this.lastMoved = this.ctrl.moveAndSlide(dt, this.wish, jumpVel);
    }
    if (this.ctrl.onGround && this.lastMoved > 0.001 && !this.dashing) {
      const prev = this.bob;
      this.bob += dt * 11 * (ultActive ? 1.2 : 1) * (this.sprinting ? 1.3 : 1);
      // 밥 사이클 반주기마다 발소리
      if (Math.floor(prev / Math.PI) !== Math.floor(this.bob / Math.PI)) ctx.sfx.footstep(undefined, 0.25);
    }

    // 무기
    this.weapon.update(now, dt);
    if (input.justPressed('KeyR') && this.weapon.startReload(now)) ctx.sfx.reload();
    if (this.weapon.ammo === 0 && !this.weapon.reloading && !ultActive && this.weapon.startReload(now)) ctx.sfx.reload();
    if (input.mouseDown[0]) {
      if (this.weapon.canFire(now)) this.fire();
      else if (input.mousePressed[0] && this.weapon.ammo === 0) ctx.sfx.empty();
    }
    this.recoil = Math.max(0, this.recoil - dt * 7);
    // 재장전: 총을 내렸다 올리는 절차적 애니메이션
    const reloadDip = this.weapon.reloading ? Math.sin(this.weapon.reloadProgress(now) * Math.PI) : 0;
    this.viewmodel.position.z = -0.55 + this.recoil * 0.07;
    this.viewmodel.rotation.x = this.recoil * 0.12 + reloadDip * 0.5 + this.swayY;
    this.viewmodel.rotation.y = this.swayX;
    this.viewmodel.rotation.z = reloadDip * 0.22;
    this.viewmodel.position.x = 0.32 + this.swayX * 0.25;
    this.viewmodel.position.y = -0.28 + Math.sin(this.bob) * 0.006 - reloadDip * 0.12;
    this.coreMat.emissiveIntensity = ultActive ? 2.5 + Math.sin(now * 20) * 0.8 : 0.6;

    // FOV 킥 (대시/궁)
    const targetFov = this.baseFov + (this.dashing ? 12 : 0) + (ultActive ? 5 : 0) + (this.sprinting ? ab.sprint.fovAdd : 0);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 14);
      this.camera.updateProjectionMatrix();
    }

    this.syncCamera();
    this.syncHitboxes();
    this.muzzle.getWorldPosition(this.tmp);
    ctx.fx.setMuzzlePosition(this.tmp);

    // HUD
    const hud = ctx.hud;
    hud.setHp(this.hp, this.hero.hp);
    const w = this.weapon;
    hud.setAmmo(ultActive ? '∞' : w.ammo, w.def.magSize, w.reloading ? `재장전 ${Math.round(w.reloadProgress(now) * 100)}%` : '');
    hud.setCrosshair(6 + this.totalSpread() * 7);
    hud.setUlt((this.ultCharge / ab.ult.chargeNeeded) * 100, ultActive, Math.max(0, this.ultUntil - now));
    hud.setSkill(0, Math.max(0, this.blinkReadyAt - now), ab.blink.cooldown);
    hud.setSkill(1, Math.max(0, this.flashReadyAt - now), ab.flash.cooldown);
  }

  // ---------- 스킬 ----------

  private tryBlink(): void {
    const ctx = this.ctx;
    const ab = this.hero.abilities.blink;
    if (ctx.now < this.blinkReadyAt || this.dashing) return;
    // 입력 방향 우선, 없으면 전방
    const f = (ctx.input.isDown('KeyW') ? 1 : 0) - (ctx.input.isDown('KeyS') ? 1 : 0);
    const r = (ctx.input.isDown('KeyD') ? 1 : 0) - (ctx.input.isDown('KeyA') ? 1 : 0);
    this.dashDir.set(0, 0, 0).addScaledVector(this.forward, f).addScaledVector(this.right, r);
    if (this.dashDir.lengthSq() < 0.01) this.dashDir.copy(this.forward);
    this.dashDir.normalize();
    this.dashUntil = ctx.now + ab.duration;
    this.blinkReadyAt = ctx.now + ab.cooldown;
    this.stats.blinks++;
    ctx.sfx.dash();
    ctx.fx.dashStreak(this.camera.position, this.dashDir, ab.range);
  }

  private tryFlash(): void {
    const ctx = this.ctx;
    const ab = this.hero.abilities.flash;
    if (ctx.now < this.flashReadyAt) return;
    this.flashReadyAt = ctx.now + ab.cooldown;
    this.stats.flashes++;
    const dir = this.camera.getWorldDirection(new Vector3());
    const origin = this.camera.position.clone().addScaledVector(dir, 0.6);
    origin.y -= 0.15;
    ctx.spawnProjectile(new FlashGrenade(ctx, origin, dir));
    ctx.sfx.throwItem();
    this.recoil = Math.max(this.recoil, 0.5);
  }

  private tryUlt(): void {
    const ctx = this.ctx;
    const ab = this.hero.abilities.ult;
    if (this.ultActive || this.ultCharge < ab.chargeNeeded) return;
    this.ultCharge = 0;
    this.ultReadyAnnounced = false;
    this.ultUntil = ctx.now + ab.duration;
    this.stats.ults++;
    if (this.weapon.reloading) {
      // 재장전 중이었다면 즉시 완료
      this.weapon.reset();
    }
    ctx.sfx.ultActivate();
    ctx.hud.killFeed('오버클럭 발동!', 'hs');
    ctx.onNoise(this.ctrl.pos, 40);
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

    this.camera.getWorldDirection(this.shotDir);
    jitterDirection(this.shotDir.clone(), this.totalSpread(), this.shotDir);
    const origin = this.camera.position;
    const res = hitscan(origin, this.shotDir, this.weapon.def.range, ctx.map.meshes, ctx.hittables(), this);

    this.muzzle.getWorldPosition(this.tmp);
    const hitColor = res.target ? 0xff7a4a : 0xffd27a;
    ctx.fx.bolt(this.tmp, res.point, this.ultActive ? 0xbfe0ff : 0x8ec5ff, hitColor, res.target ? 6 : 3);
    ctx.fx.muzzleFlash(this.ultActive ? 9 : 6);
    ctx.fx.muzzleSprite(this.tmp, this.ultActive ? 0.34 : 0.26);
    ctx.sfx.shoot();
    ctx.onNoise(this.ctrl.pos, 25);

    if (res.target) {
      const headshot = res.part === 'head';
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
      this.ultUntil = 0;
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
      ctx.hud.setUlt((this.ultCharge / this.hero.abilities.ult.chargeNeeded) * 100, false, 0);
      ctx.sfx.death();
      ctx.onPlayerDied(info.attacker?.displayName ?? '???');
    }
  }
}
