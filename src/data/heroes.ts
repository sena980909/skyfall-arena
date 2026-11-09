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
  /** 달리기(Shift 유지): 속도 배율, 탄퍼짐 추가(deg), FOV 추가 */
  sprint: { speedMult: number; spreadAdd: number; fovAdd: number };
  /** 펄스 로켓(우클릭): 직격 + 스플래시(중심 100% → 가장자리 50%) */
  rocket: { cooldown: number; speed: number; directDamage: number; splashDamage: number; radius: number; range: number };
  /** 치유 필드(E): 설치형 회복 구역 */
  field: { cooldown: number; duration: number; radius: number; hps: number };
  /** 전술 조준(Q): 지속 시간 동안 화면 안의 적 자동 조준 */
  ult: { duration: number; chargeNeeded: number; chargePerDamage: number; chargePerSecond: number };
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
    sprint: { speedMult: 1.5, spreadAdd: 1.5, fovAdd: 6 },
    rocket: { cooldown: 6, speed: 50, directDamage: 40, splashDamage: 80, radius: 3, range: 70 },
    field: { cooldown: 15, duration: 5, radius: 4.5, hps: 35 },
    ult: { duration: 6, chargeNeeded: 100, chargePerDamage: 0.25, chargePerSecond: 1 },
  },
};

export const GRAVITY = 20;
