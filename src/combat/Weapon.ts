import type { WeaponDef } from '@/data/heroes';

/** 무기 상태 머신: 탄약/재장전/연사 쿨다운/탄퍼짐 */
export class Weapon {
  ammo: number;
  reloading = false;
  private reloadEnd = 0;
  private nextShot = 0;
  /** 현재 탄퍼짐 (deg, 반각) */
  spread: number;
  /** 궁 등으로 바뀌는 연사 배율 */
  fireRateMult = 1;
  /** 탄약 소모 없음 (오버클럭) */
  infiniteAmmo = false;

  constructor(readonly def: WeaponDef) {
    this.ammo = def.magSize;
    this.spread = def.spreadMin;
  }

  update(now: number, dt: number): void {
    if (this.reloading && now >= this.reloadEnd) {
      this.reloading = false;
      this.ammo = this.def.magSize;
    }
    this.spread = Math.max(this.def.spreadMin, this.spread - this.def.spreadRecover * dt);
  }

  canFire(now: number): boolean {
    return !this.reloading && (this.ammo > 0 || this.infiniteAmmo) && now >= this.nextShot;
  }

  /** 발사 처리. 성공 시 true */
  fire(now: number): boolean {
    if (!this.canFire(now)) return false;
    if (!this.infiniteAmmo) this.ammo--;
    this.nextShot = now + 1 / (this.def.fireRate * this.fireRateMult);
    this.spread = Math.min(this.def.spreadMax, this.spread + this.def.spreadPerShot);
    return true;
  }

  startReload(now: number): boolean {
    if (this.reloading || this.ammo === this.def.magSize) return false;
    this.reloading = true;
    this.reloadEnd = now + this.def.reloadTime;
    return true;
  }

  /** 재장전 진행률 0..1 */
  reloadProgress(now: number): number {
    if (!this.reloading) return 1;
    return 1 - Math.max(0, this.reloadEnd - now) / this.def.reloadTime;
  }

  reset(): void {
    this.ammo = this.def.magSize;
    this.reloading = false;
    this.nextShot = 0;
    this.spread = this.def.spreadMin;
    this.fireRateMult = 1;
    this.infiniteAmmo = false;
  }
}
