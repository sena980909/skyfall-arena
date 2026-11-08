/** 웨이브 구성 — GDD 3.1. M1은 전부 레이븐 봇, 보스는 M2에서. */
export interface BossDef {
  name: string;
  hpMult: number;
  scale: number;
}

export interface WaveDef {
  /** 일반 봇 수 */
  bots: number;
  /** 보스 (있으면 일반 봇은 호위) */
  boss?: BossDef;
}

export const WAVES: WaveDef[] = [
  { bots: 3 },
  { bots: 4 },
  { bots: 5 },
  { bots: 6 },
  { bots: 4, boss: { name: '레이븐 보스', hpMult: 3, scale: 1.35 } },
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
