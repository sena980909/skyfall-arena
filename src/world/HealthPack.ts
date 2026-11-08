import { BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';

/** 힐팩을 먹을 수 있는 대상 */
export interface Healable {
  hp: number;
  readonly maxHp: number;
  readonly position: Vector3;
  readonly alive: boolean;
}

/** 힐팩 — GDD 6장: 대 250HP/30초, 소 75HP/15초 */
export class HealthPack {
  readonly group = new Group();
  readonly amount: number;
  readonly respawnTime: number;
  active = true;
  private respawnAt = 0;
  private readonly cross: Group;
  private readonly ring: Mesh;
  private readonly ringMat: MeshStandardMaterial;

  constructor(readonly position: Vector3, readonly big: boolean) {
    this.amount = big ? 250 : 75;
    this.respawnTime = big ? 30 : 15;
    const s = big ? 1 : 0.65;
    const mat = new MeshStandardMaterial({ color: 0x4cff88, emissive: 0x1f9a4a, emissiveIntensity: 0.9, roughness: 0.4 });
    const white = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xaaffcc, emissiveIntensity: 0.4 });
    this.cross = new Group();
    const base = new Mesh(new BoxGeometry(0.7 * s, 0.7 * s, 0.7 * s), mat);
    const barA = new Mesh(new BoxGeometry(0.5 * s, 0.14 * s, 0.75 * s), white);
    const barB = new Mesh(new BoxGeometry(0.14 * s, 0.5 * s, 0.75 * s), white);
    this.cross.add(base, barA, barB);
    this.cross.position.y = 0.9 * s;
    this.ringMat = new MeshStandardMaterial({ color: big ? 0x4cff88 : 0x9affc0, emissive: 0x1f9a4a, emissiveIntensity: 0.5, roughness: 0.6, side: DoubleSide });
    this.ring = new Mesh(new CylinderGeometry(1.0 * s, 1.0 * s, 0.05, 24, 1, true), this.ringMat);
    this.ring.position.y = 0.03;
    this.group.add(this.cross, this.ring);
    this.group.position.copy(position);
  }

  update(now: number, dt: number): void {
    if (!this.active && now >= this.respawnAt) {
      this.active = true;
      this.cross.visible = true;
    }
    if (this.active) {
      this.cross.rotation.y += dt * 1.5;
      this.cross.position.y = (this.big ? 0.9 : 0.6) + Math.sin(now * 2.5) * 0.08;
      this.ringMat.emissiveIntensity = 0.5 + Math.sin(now * 3) * 0.2;
    } else {
      this.ringMat.emissiveIntensity = 0.08;
    }
  }

  /** 리스폰까지 남은 비율 0..1 (1 = 사용 가능) */
  readiness(now: number): number {
    if (this.active) return 1;
    return 1 - Math.max(0, this.respawnAt - now) / this.respawnTime;
  }

  /** 대상이 범위 안이고 체력이 모자라면 회복. 회복량 반환 (0이면 미사용) */
  tryPickup(target: Healable, now: number): number {
    if (!this.active || !target.alive || target.hp >= target.maxHp) return 0;
    const dx = target.position.x - this.position.x;
    const dz = target.position.z - this.position.z;
    const dy = target.position.y - this.position.y;
    if (dx * dx + dz * dz > 1.3 * 1.3 || Math.abs(dy) > 1.5) return 0;
    const healed = Math.min(this.amount, target.maxHp - target.hp);
    target.hp += healed;
    this.active = false;
    this.cross.visible = false;
    this.respawnAt = now + this.respawnTime;
    return healed;
  }

  reset(): void {
    this.active = true;
    this.cross.visible = true;
    this.respawnAt = 0;
  }
}
