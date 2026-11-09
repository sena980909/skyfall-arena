import { Group, Raycaster, Sprite, Vector3, type Mesh } from 'three';
import { RAVEN } from '@/data/heroes';
import { losBlocked, type Hittable } from '@/combat/Hitscan';
import type { GameContext } from '@/core/Context';
import type { Projectile } from './Projectile';

const raycaster = new Raycaster();

export interface RocketHit {
  target: Hittable;
  amount: number;
  point: Vector3;
  direct: boolean;
}

/**
 * 펄스 로켓 (우클릭) — 나선으로 도는 3개의 에너지 탄이 한 묶음으로 직진.
 * 맵 또는 봇에 닿으면 폭발: 직격 피해 + 반경 스플래시(거리 감쇠, 시야선 필요). 자해 없음.
 */
export class PulseRocket implements Projectile {
  done = false;
  private readonly def = RAVEN.abilities.rocket;
  private readonly group = new Group();
  private readonly orbs: Sprite[] = [];
  private readonly pos: Vector3;
  private readonly dir: Vector3;
  private traveled = 0;
  private nextTrail = 0;
  private readonly side = new Vector3();
  private readonly up = new Vector3();

  constructor(
    private readonly ctx: GameContext,
    origin: Vector3,
    dir: Vector3,
    private readonly owner: Hittable,
    private readonly onHit: (hit: RocketHit) => void,
  ) {
    this.pos = origin.clone();
    this.dir = dir.clone().normalize();
    // 나선 회전축의 기저
    const ref = Math.abs(this.dir.y) > 0.95 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    this.side.crossVectors(this.dir, ref).normalize();
    this.up.crossVectors(this.side, this.dir).normalize();
    const core = ctx.fx.glowSprite(0xe6f4ff, 0.32);
    this.group.add(core);
    for (let i = 0; i < 3; i++) {
      const s = ctx.fx.glowSprite(0x7cc4ff, 0.2);
      this.orbs.push(s);
      this.group.add(s);
    }
    this.group.position.copy(this.pos);
    ctx.scene.add(this.group);
    ctx.fx.grenadeLightOn(this.pos);
  }

  update(dt: number): void {
    if (this.done) return;
    const ctx = this.ctx;
    const step = this.def.speed * dt;
    const objs: Mesh[] = [...ctx.map.meshes];
    for (const t of ctx.hittables()) {
      if (t === this.owner || !t.alive) continue;
      for (const m of t.hitMeshes) objs.push(m);
    }
    raycaster.set(this.pos, this.dir);
    raycaster.far = step;
    const hits = raycaster.intersectObjects(objs, false);
    if (hits.length) {
      const h = hits[0];
      const owner = (h.object.userData.owner as Hittable | undefined) ?? null;
      this.explode(h.point.clone(), owner);
      return;
    }
    this.pos.addScaledVector(this.dir, step);
    this.traveled += step;
    if (this.traveled >= this.def.range) {
      this.explode(this.pos.clone(), null);
      return;
    }
    // 나선 비주얼: 3개의 구가 진행축을 중심으로 회전 (처음엔 좁게, 점점 넓게)
    const spread = Math.min(0.16, 0.04 + this.traveled * 0.02);
    const base = this.traveled * 9;
    this.orbs.forEach((o, i) => {
      const a = base + (i * Math.PI * 2) / 3;
      o.position.copy(this.side).multiplyScalar(Math.cos(a) * spread).addScaledVector(this.up, Math.sin(a) * spread);
    });
    this.group.position.copy(this.pos);
    ctx.fx.grenadeLightOn(this.pos);
    // 꼬리 입자
    if (ctx.now >= this.nextTrail) {
      this.nextTrail = ctx.now + 0.02;
      const v = new Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6);
      ctx.fx.mote(this.pos, 0x8ec5ff, v, 0.28, 0.14);
    }
  }

  private explode(point: Vector3, directTarget: Hittable | null): void {
    const ctx = this.ctx;
    this.done = true;
    ctx.scene.remove(this.group);
    ctx.fx.grenadeLightOff();
    ctx.fx.rocketExplosion(point);
    ctx.sfx.rocketExplode(point);
    ctx.onNoise(point, 30);

    // 시야선 검사용: 표면에서 살짝 뒤로 뺀 지점
    const origin = point.clone().addScaledVector(this.dir, -0.15);
    if (directTarget && directTarget.alive) {
      directTarget.takeDamage({ amount: this.def.directDamage, headshot: false, from: origin, attacker: this.owner });
      this.onHit({ target: directTarget, amount: this.def.directDamage, point, direct: true });
    }
    const r = this.def.radius;
    const closest = new Vector3();
    for (const t of ctx.hittables()) {
      if (t === this.owner || !t.alive) continue;
      // 캡슐 근사: 발~머리 수직 선분에서 폭발점과 가장 가까운 점
      const scale = (t as unknown as { scale?: number }).scale ?? 1;
      const y0 = t.position.y + 0.3 * scale;
      const y1 = t.position.y + 1.6 * scale;
      closest.set(t.position.x, Math.max(y0, Math.min(y1, point.y)), t.position.z);
      const d = Math.max(0, closest.distanceTo(point) - 0.35 * scale);
      if (d > r) continue;
      if (losBlocked(origin, closest, ctx.map.meshes)) continue;
      // 중심 100% → 가장자리 50%
      const amount = Math.round(this.def.splashDamage * (1 - 0.5 * (d / r)));
      t.takeDamage({ amount, headshot: false, from: origin, attacker: this.owner });
      this.onHit({ target: t, amount, point: closest.clone(), direct: false });
    }
  }

  dispose(): void {
    if (!this.done) {
      this.ctx.scene.remove(this.group);
      this.ctx.fx.grenadeLightOff();
    }
    this.done = true;
  }
}
