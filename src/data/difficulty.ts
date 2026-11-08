/** 봇 난이도 파라미터 — GDD 5.4 */
export type DifficultyId = 'easy' | 'normal' | 'hard';

export interface DifficultyDef {
  id: DifficultyId;
  label: string;
  /** 적 발견 후 첫 발사까지 (초) */
  reactionTime: number;
  /** 조준 오차 표준편차 (deg) */
  aimSigmaDeg: number;
  /** 조준 추적 속도 (deg/s) */
  aimSpeedDeg: number;
  /** 머리를 노릴 확률 */
  headshotChance: number;
  /** 봇 HP 배율 */
  hpMult: number;
  /** 연사 버스트 길이 (발) 및 버스트 사이 휴식 (초) */
  burstLength: [number, number];
  burstPause: [number, number];
  /** HP 비율이 이 이하이면 힐팩으로 후퇴 시도. 0이면 안 함 */
  retreatHpRatio: number;
  /** 엄폐 사용: none = 안 함, lowhp = HP<50%에서 재장전/버스트 휴식 시, always = 버스트마다 Peek 패턴 */
  cover: 'none' | 'lowhp' | 'always';
  /** 동시에 사격할 수 있는 봇 수 (공격 토큰). 나머지는 조준·이동·엄폐만 한다 */
  attackTokens: number;
  /** 봇이 주는 피해 배율 */
  damageMult: number;
}

export const DIFFICULTIES: Record<DifficultyId, DifficultyDef> = {
  easy: {
    id: 'easy',
    label: 'EASY',
    reactionTime: 0.8,
    aimSigmaDeg: 7,
    aimSpeedDeg: 120,
    headshotChance: 0.05,
    hpMult: 0.8,
    burstLength: [3, 5],
    burstPause: [0.5, 0.9],
    retreatHpRatio: 0,
    cover: 'none',
    attackTokens: 1,
    damageMult: 0.6,
  },
  normal: {
    id: 'normal',
    label: 'NORMAL',
    reactionTime: 0.5,
    aimSigmaDeg: 4.5,
    aimSpeedDeg: 240,
    headshotChance: 0.15,
    hpMult: 1,
    burstLength: [4, 7],
    burstPause: [0.3, 0.6],
    retreatHpRatio: 0.3,
    cover: 'lowhp',
    attackTokens: 2,
    damageMult: 0.7,
  },
  hard: {
    id: 'hard',
    label: 'HARD',
    reactionTime: 0.3,
    aimSigmaDeg: 2.0,
    aimSpeedDeg: 400,
    headshotChance: 0.35,
    hpMult: 1,
    burstLength: [6, 10],
    burstPause: [0.15, 0.35],
    retreatHpRatio: 0.3,
    cover: 'always',
    attackTokens: 2,
    damageMult: 0.8,
  },
};
