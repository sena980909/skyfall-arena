/**
 * 걸음 방향 선택 — 봇과 주인공 3인칭 몸이 함께 쓴다.
 *
 * 다리(몸통 그룹)가 향하는 방향을 이동 방향에 그대로 맞추면, 옆으로 움직이며 조준할 때 허리가 90° 가까이 비틀린다.
 * 대신 전진·뒷걸음·좌우 옆걸음 네 가지 걸음을 두고, 그중 허리 비틀림(조준 방향 − 다리 방향)이 가장 작은 것을 고른다.
 * 이동 방향이 조준과 이루는 각이 어떻든 비틀림은 45° 안팎에 머문다.
 */
export type GaitDir = 'fwd' | 'back' | 'left' | 'right';

/** 걸음별 로컬 진행각: 다리가 +Z를 볼 때 몸이 실제로 움직이는 방향(yaw = atan2(x, z)). 캐릭터의 왼쪽은 +X */
const LOCAL: Record<GaitDir, number> = { fwd: 0, left: Math.PI / 2, right: -Math.PI / 2, back: Math.PI };

export const GAIT_ALL: readonly GaitDir[] = ['fwd', 'back', 'left', 'right'];
export const GAIT_FWD_BACK: readonly GaitDir[] = ['fwd', 'back'];
export const GAIT_FWD: readonly GaitDir[] = ['fwd'];

function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** 이 걸음으로 moveYaw 방향으로 갈 때 다리가 향해야 하는 방향 */
export function legsYawFor(moveYaw: number, dir: GaitDir): number {
  return moveYaw - LOCAL[dir];
}

/**
 * 허리 비틀림이 가장 작은 걸음을 고른다. 지금 걸음에는 hysteresis(라디안)만큼 점수를 얹어 경계에서 왔다 갔다 하지 않게 한다.
 * 좌↔우, 전진↔뒷걸음은 다리 방향이 같아서(이동 방향만 반대) 바뀌어도 다리가 돌지 않는다.
 */
export function pickGaitDir(moveYaw: number, aimYaw: number, current: GaitDir, allowed: readonly GaitDir[], hysteresis = 0.3): GaitDir {
  let best: GaitDir = allowed[0];
  let bestCost = Infinity;
  for (const d of allowed) {
    const cost = Math.abs(wrap(aimYaw - legsYawFor(moveYaw, d))) - (d === current ? hysteresis : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = d;
    }
  }
  return best;
}
