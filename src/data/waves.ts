/** 웨이브 구성 — GDD 3.1. M1은 전부 레이븐 봇, 보스는 M2에서. */
export interface BossDef {
  name: string;
  hpMult: number;
  scale: number;
}

export interface WaveDef {
  /** 봇 수(돌입병·저격병 포함) */
  bots: number;
  /** 그중 돌입병 수 */
  rushers?: number;
  /** 그중 저격병 수 */
  marksmen?: number;
  /** 보스 (있으면 일반 봇은 호위) */
  boss?: BossDef;
}

export const WAVES: WaveDef[] = [
  { bots: 3 },
  { bots: 4, rushers: 1 },
  { bots: 5, rushers: 1, marksmen: 1 },
  { bots: 6, rushers: 2, marksmen: 1 },
  { bots: 4, rushers: 1, marksmen: 1, boss: { name: '레이븐 보스', hpMult: 3, scale: 1.35 } },
];

export const WAVE_REST_SECONDS = 8;
export const PLAYER_LIVES = 3;
export const RESPAWN_SECONDS = 3;
export const SPAWN_INVULN_SECONDS = 1.5;

export const SCORE = {
  kill: 100,
  headshotKill: 150,
  waveNoDeath: 300,
  bossKill: 500,
};
