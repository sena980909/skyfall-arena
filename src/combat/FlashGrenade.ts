import { Box3, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import { GRAVITY, RAVEN } from '@/data/heroes';
import { losBlocked } from '@/combat/Hitscan';
import type { GameContext } from '@/core/Context';

/** 레이븐 섬광탄 — 투사체. 벽/바닥 충돌 또는 퓨즈 만료 시 폭발, 반경 내 시야가 닿는 봇 실명 */
export class FlashGrenade {
  readonly mesh: Mesh;
  readonly pos: Vector3;
  readonly vel: Vector3;
  done = false;
  private readonly spawnTime: number;
  private readonly def = RAVEN.abilities.flash;
  private readonly prev = new Vector3();

  constructor(private readonly ctx: GameContext, origin: Vector3, dir: Vector3) {
    this.pos = origin.clone();
    this.vel = dir.clone().normalize().multiplyScalar(this.def.speed);
    this.vel.y += 2; // 살짝 위로 던지는 느낌
    this.spawnTime = ctx.now;
    this.mesh = new Mesh(
      new SphereGeometry(0.12, 10, 8),
      new MeshStandardMaterial({ color: 0xdddddd, emissive: 0x8ec5ff, emissiveIntensity: 1.2, roughness: 0.3, metalness: 0.6 }),
    );
    this.mesh.position.copy(this.pos);
    // 조명은 씬에 상시 존재하는 풀 조명을 빌려 쓴다 (조명 개수가 바뀌면 모든 셰이더가 재컴파일되어 렉이 생김)
    ctx.fx.grenadeLightOn(this.pos);
    ctx.scene.add(this.mesh);
  }

  private hitsCollider(p: Vector3): Box3 | null {
    for (const b of this.ctx.map.colliders) {
      if (p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z) return b;
    }
    return null;
  }

  update(dt: number): void {
    if (this.done) return;
    this.prev.copy(this.pos);
    this.vel.y -= GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);
    const hit = this.hitsCollider(this.pos);
    if (hit) {
      // 충돌 지점에서 살짝 되돌려 폭발
      this.pos.copy(this.prev);
      this.explode();
      return;
    }
    if (this.ctx.now - this.spawnTime >= this.def.fuse) {
      this.explode();
      return;
    }
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.x += dt * 12;
    this.ctx.fx.grenadeLightOn(this.pos);
  }

  private explode(): void {
    const ctx = this.ctx;
    this.done = true;
    ctx.scene.remove(this.mesh);
    ctx.fx.grenadeLightOff();
    ctx.sfx.flashBang();
    ctx.fx.flashBurst(this.pos);
    const r = this.def.radius;
    let blinded = 0;
    for (const b of ctx.bots) {
      if (!b.alive) continue;
      const eye = b.position.clone().setY(b.position.y + b.eyeHeight);
      if (eye.distanceTo(this.pos) > r) continue;
      if (losBlocked(this.pos, eye, ctx.map.meshes)) continue;
      b.blind(this.def.blindDuration);
      blinded++;
    }
    // 플레이어 자신도 가까우면 눈부심 (시야 방향 가중)
    const p = ctx.player;
    if (p.alive) {
      const pEye = p.camera.position;
      const d = pEye.distanceTo(this.pos);
      if (d < r * 1.3 && !losBlocked(this.pos, pEye, ctx.map.meshes)) {
        const toFlash = this.pos.clone().sub(pEye).normalize();
        const fwd = p.camera.getWorldDirection(new Vector3());
        const facing = Math.max(0, fwd.dot(toFlash));
        const intensity = (1 - d / (r * 1.3)) * (0.3 + 0.7 * facing);
        if (intensity > 0.08) ctx.hud.flash(intensity);
      }
    }
    if (blinded > 0) ctx.hud.killFeed(`섬광탄 — 봇 ${blinded}체 실명`, 'hs');
  }

  dispose(): void {
    if (!this.done) {
      this.ctx.scene.remove(this.mesh);
      this.ctx.fx.grenadeLightOff();
    }
    this.done = true;
  }
}
