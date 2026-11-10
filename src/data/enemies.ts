import { RAVEN, type WeaponDef } from './heroes';

/**
 * 적 종류 — 모두 같은 리그와 애니메이션을 쓰고, 색·크기·무기·교전 거리만 다르다. 밸런스는 여기서만 조정한다.
 *   trooper  돌격병: 기준. 10~20m에서 펄스 라이플을 끊어 쏜다
 *   rusher   돌입병: 작고 빠르다. 3~6m까지 파고들어 근거리 기관단총을 쏜다. 멀리서는 거의 아프지 않다
 *   marksman 저격병: 18~45m에서 멈춰 서서 조준선을 비춘 뒤 한 발을 쏜다. 쏘기 직전에는 조준이 굳으므로 옆으로 움직이거나 엄폐하면 피한다
 */
export type EnemyKind = 'trooper' | 'rusher' | 'marksman';

/** 조준선을 비춘 뒤 쏘는 한 발 */
export interface ChargedShot {
  /** 조준선이 플레이어를 따라오는 시간(초) */
  charge: number;
  /** 조준이 굳은 채 기다리는 시간(초). 이 사이에 벗어나면 빗나간다 */
  lock: number;
  /** 쏜 뒤 다음 조준까지(초) */
  cooldown: number;
  /** 피해(난이도 배율을 곱한다). 거리 감쇠·헤드샷 배율 없음 */
  damage: number;
  range: number;
}

export interface EnemyDef {
  kind: EnemyKind;
  label: string;
  hpMult: number;
  scale: number;
  speedMult: number;
  /** 교전 거리: engageMax보다 멀면 다가가고 engageMin보다 가까우면 물러난다 */
  engageMin: number;
  engageMax: number;
  /** 조준 오차 배율(난이도의 aimSigmaDeg에 곱한다). 저격병은 작게 둔다: 서 있는 상대는 맞혀야 한다 */
  aimSigmaMult: number;
  weapon: WeaponDef;
  /** 갑옷 색상: 텍스처의 색 채널을 돌린다(render/HueSwap). null이면 주황 그대로 */
  hue: 'rbg' | 'brg' | null;
  /** 그 위에 곱하는 색(0..1). null이면 그대로 */
  tint: [number, number, number] | null;
  visor: number;
  /** 몸의 발광 띠 색. null이면 모델 그대로 */
  glow: number | null;
  /** 탄 궤적 색 */
  bolt: number;
  shot?: ChargedShot;
}

/** 돌입병의 기관단총: 가까이서는 라이플과 비슷하게 아프고, 14m를 넘으면 30%만 들어간다 */
const SMG: WeaponDef = {
  ...RAVEN.weapon,
  name: '근접 기관단총',
  damage: 13,
  fireRate: 12,
  magSize: 24,
  reloadTime: 1.3,
  spreadMin: 2.5,
  spreadMax: 5.5,
  falloffStart: 6,
  falloffEnd: 14,
  falloffMin: 0.3,
};

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  trooper: {
    kind: 'trooper', label: '돌격병', hpMult: 1, scale: 1, speedMult: 1, engageMin: 10, engageMax: 20, aimSigmaMult: 1,
    weapon: RAVEN.weapon, hue: null, tint: null, visor: 0xffd166, glow: null, bolt: 0xff8a5a,
  },
  rusher: {
    kind: 'rusher', label: '돌입병', hpMult: 0.7, scale: 0.9, speedMult: 1.15, engageMin: 3, engageMax: 6, aimSigmaMult: 1,
    weapon: SMG, hue: 'brg', tint: [0.9, 0.7, 0.7], visor: 0x7dff4a, glow: 0x58ff3a, bolt: 0xa8ff5a,
  },
  marksman: {
    kind: 'marksman', label: '저격병', hpMult: 0.8, scale: 1, speedMult: 0.9, engageMin: 18, engageMax: 45, aimSigmaMult: 0.15,
    weapon: RAVEN.weapon, hue: 'rbg', tint: [0.7, 0.62, 0.7], visor: 0xff3bd0, glow: 0xff2ac0, bolt: 0xff3bd0,
    shot: { charge: 1.2, lock: 0.25, cooldown: 2.6, damage: 75, range: 120 },
  },
};
