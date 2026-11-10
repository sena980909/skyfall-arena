/** 판 전체에 걸친 규칙 수치. 임무의 단계별 수치는 world/Mission.ts, 적 종류는 data/enemies.ts */

/** 시작 직후 무적 시간(초) */
export const SPAWN_INVULN_SECONDS = 1.5;
/** 쓰러진 뒤 결과 화면이 뜨기까지(초): 쓰러지는 모습을 보여 준다. 부활은 없다 */
export const DEATH_CAM_SECONDS = 1.6;

export const SCORE = {
  kill: 100,
  headshotKill: 150,
  bossKill: 500,
};
