/** 영웅/무기 데이터 — GDD 4장 수치. 밸런스는 여기서만 조정한다. */

export interface WeaponDef {
  name: string;
  damage: number;
  /** 초당 발사 수 */
  fireRate: number;
  magSize: number;
  reloadTime: number;
  /** 정지 시 탄퍼짐 (deg, 반각) */
  spreadMin: number;
  spreadMax: number;
  /** 발당 탄퍼짐 증가량 (deg) */
  spreadPerShot: number;
  /** 초당 탄퍼짐 회복 (deg/s) */
  spreadRecover: number;
  range: number;
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  headshotMult: number;
}

export interface RavenAbilities {
  blink: { range: number; cooldown: number; duration: number };
  /** 달리기(Shift 유지): 속도 배율, 탄퍼짐 추가(deg), FOV 추가 */
  sprint: { speedMult: number; spreadAdd: number; fovAdd: number };
  flash: { cooldown: number; speed: number; fuse: number; radius: number; blindDuration: number };
  ult: { duration: number; fireRateMult: number; speedMult: number; chargeNeeded: number; chargePerDamage: number; chargePerSecond: number };
}

export interface HeroDef {
  id: string;
  name: string;
  hp: number;
  moveSpeed: number;
  jumpHeight: number;
  weapon: WeaponDef;
  color: number;
  abilities: RavenAbilities;
}

export const RAVEN: HeroDef = {
  id: 'raven',
  name: 'RAVEN',
  hp: 200,
  moveSpeed: 5.5,
  jumpHeight: 1.2,
  color: 0x2f80ff,
  weapon: {
    name: '펄스 라이플',
    damage: 18,
    fireRate: 9,
    magSize: 30,
    reloadTime: 1.4,
    spreadMin: 1.5,
    spreadMax: 3.5,
    spreadPerShot: 0.35,
    spreadRecover: 6,
    range: 120,
    falloffStart: 20,
    falloffEnd: 40,
    falloffMin: 0.5,
    headshotMult: 2,
  },
  abilities: {
    blink: { range: 8, cooldown: 5, duration: 0.12 },
    sprint: { speedMult: 1.4, spreadAdd: 1.5, fovAdd: 6 },
    flash: { cooldown: 10, speed: 22, fuse: 1.5, radius: 5, blindDuration: 2 },
    ult: { duration: 8, fireRateMult: 1.5, speedMult: 1.3, chargeNeeded: 100, chargePerDamage: 0.25, chargePerSecond: 1 },
  },
};

export const GRAVITY = 20;
