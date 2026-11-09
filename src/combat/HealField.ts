import {
  AdditiveBlending, CanvasTexture, CircleGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, RingGeometry, Vector3,
} from 'three';
import { RAVEN } from '@/data/heroes';
import type { GameContext } from '@/core/Context';
import type { Projectile } from './Projectile';

let fieldTex: CanvasTexture | null = null;

/** 바닥 원판용 방사형 텍스처: 가장자리는 밝은 테두리, 안쪽은 옅은 동심원 */
function getFieldTexture(): CanvasTexture {
  if (fieldTex) return fieldTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 4, 128, 128, 126);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.18)');
  grad.addColorStop(0.9, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 2;
  for (const rr of [40, 75, 105]) {
    g.beginPath();
    g.arc(128, 128, rr, 0, Math.PI * 2);
    g.stroke();
  }
  fieldTex = new CanvasTexture(c);
  return fieldTex;
}

/**
 * 치유 필드 (E) — 발밑에 설치하는 회복 구역. 지속 시간 동안 반경 안의 플레이어를 초당 회복.
 * 봇(적)은 회복하지 않는다.
 */
export class HealField implements Projectile {
  done = false;
  private readonly def = RAVEN.abilities.field;
  private readonly group = new Group();
  private readonly center: Vector3;
  private readonly startTime: number;
  private readonly endTime: number;
  private readonly discMat: MeshBasicMaterial;
  private readonly ringMat: MeshBasicMaterial;
  private readonly puck: Mesh;
  private healAccum = 0;
  private nextHealNumber = 0;
  private nextMote = 0;

  constructor(private readonly ctx: GameContext, feet: Vector3) {
    const ground = ctx.map.groundHeightAt(feet.x, feet.z, feet.y + 0.1);
    this.center = new Vector3(feet.x, ground, feet.z);
    this.startTime = ctx.now;
    this.endTime = ctx.now + this.def.duration;
    const r = this.def.radius;
    const color = 0x7dffb0;

    this.discMat = new MeshBasicMaterial({ map: getFieldTexture(), color, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    const disc = new Mesh(new CircleGeometry(r, 64), this.discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.03;
    this.ringMat = new MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    const ring = new Mesh(new RingGeometry(r - 0.1, r, 96), this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    this.puck = new Mesh(
      new CylinderGeometry(0.16, 0.2, 0.1, 24),
      new MeshStandardMaterial({ color: 0x2a3340, emissive: color, emissiveIntensity: 1.2, roughness: 0.4, metalness: 0.6 }),
    );
    this.puck.position.y = 0.05;
    this.group.add(disc, ring, this.puck);
    this.group.position.copy(this.center);
    ctx.scene.add(this.group);
    ctx.sfx.healField();
  }

  update(dt: number): void {
    if (this.done) return;
    const ctx = this.ctx;
    const now = ctx.now;
    const fadeIn = Math.min(1, (now - this.startTime) / 0.2);
    const fadeOut = Math.min(1, Math.max(0, (this.endTime - now) / 0.4));
    const alpha = fadeIn * fadeOut;
    const pulse = 0.85 + Math.sin(now * 6) * 0.15;
    this.discMat.opacity = 0.5 * alpha * pulse;
    this.ringMat.opacity = 0.9 * alpha;
    this.puck.rotation.y += dt * 2;
    if (now >= this.endTime) {
      this.dispose();
      return;
    }

    // 피어오르는 입자
    if (now >= this.nextMote) {
      this.nextMote = now + 0.07;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * this.def.radius;
      const p = new Vector3(this.center.x + Math.cos(a) * rr, this.center.y + 0.1, this.center.z + Math.sin(a) * rr);
      ctx.fx.mote(p, 0x9affc0, new Vector3(0, 1.2 + Math.random() * 0.8, 0), 0.9, 0.12);
    }

    // 플레이어 회복
    const pl = ctx.player;
    if (!pl.alive) return;
    const dx = pl.position.x - this.center.x;
    const dz = pl.position.z - this.center.z;
    const dy = pl.position.y - this.center.y;
    const inside = dx * dx + dz * dz <= this.def.radius * this.def.radius && dy > -1 && dy < 2.5;
    if (inside && pl.hp < pl.maxHp) {
      const amount = Math.min(pl.maxHp - pl.hp, this.def.hps * dt);
      pl.hp += amount;
      this.healAccum += amount;
      ctx.hud.setHp(pl.hp, pl.maxHp);
    }
    if (now >= this.nextHealNumber && this.healAccum >= 1) {
      this.nextHealNumber = now + 0.5;
      ctx.hud.healNumber(Math.round(this.healAccum));
      this.healAccum = 0;
    }
  }

  dispose(): void {
    if (!this.done) this.ctx.scene.remove(this.group);
    this.done = true;
  }
}
