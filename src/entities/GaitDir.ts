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

/** 이 걸음으로 갈 때 이동 방향이 걸음의 진행 방향에서 벗어난 각(라디안, + = 왼쪽으로). legsYaw = 지금 다리가 실제로 향하는 방향 */
export function gaitResidual(moveYaw: number, legsYaw: number, dir: GaitDir): number {
  return wrap(moveYaw - legsYaw - LOCAL[dir]);
}

/** residual 쪽으로 90° 옆에 있는 걸음 (전진에서 왼쪽으로 벗어나면 왼쪽 옆걸음) */
export function neighborDir(dir: GaitDir, residual: number): GaitDir {
  const target = wrap(LOCAL[dir] + (residual >= 0 ? Math.PI / 2 : -Math.PI / 2));
  let best: GaitDir = 'fwd';
  let bd = Infinity;
  for (const d of GAIT_ALL) {
    const e = Math.abs(wrap(LOCAL[d] - target));
    if (e < bd) {
      bd = e;
      best = d;
    }
  }
  return best;
}

/**
 * 대각선 이동: 주 걸음(클립 속도 v1 m/s, 길이 T1 초)과 옆 걸음(v2, T2)을 섞어, 다리를 돌리지 않고도 발이 실제 이동 방향으로 디디게 한다.
 * 두 클립을 같은 주기로 맞춰 재생하면(같은 보폭 위상) 접지한 발의 속도는 두 클립 속도의 가중합이 된다:
 *   w1·v1·ts1 = speed·cos(r),  w2·v2·ts2 = speed·sin|r|,  ts2 = ts1·T2/T1
 * 반환: 옆 걸음 가중치 w2, 두 클립의 재생 배율.
 */
export function solveGaitBlend(speed: number, residual: number, v1: number, T1: number, v2: number, T2: number): { w2: number; ts1: number; ts2: number } {
  const r = Math.max(-1.4, Math.min(1.4, residual));
  const c = speed * Math.cos(r);
  const sn = speed * Math.abs(Math.sin(r));
  const b = (v2 * T2) / T1;
  const ts1 = c / v1 + sn / b;
  if (ts1 < 1e-4) return { w2: 0, ts1: 0, ts2: 0 };
  return { w2: sn / b / ts1, ts1, ts2: (ts1 * T2) / T1 };
}

/** 옆걸음 클립의 접지 비율(tools/blender/build_bot_rig.py의 STRAFE beta와 같은 값) */
const STRAFE_BETA: Record<string, number> = {
  strafeL: 0.42, strafeR: 0.42, strafeFastL: 0.3, strafeFastR: 0.3, crouchStrafeL: 0.46, crouchStrafeR: 0.46,
};

/**
 * 반대쪽 옆걸음으로 바꿀 때(좌↔우) 새 클립을 시작할 위상(0..1). 아니면 null.
 * 좌우 옆걸음은 발의 좌우 움직임만 반대라서, 위상을 (접지 비율 − 지금 위상)으로 뒤집으면 두 발의 위치가 그대로 이어진다.
 * 같은 위상에서 섞으면 두 클립의 발 움직임이 서로 지워져 방향을 뒤집는 동안 발이 미끄러진다.
 */
export function mirroredStrafePhase(from: string, to: string, phase: number): number | null {
  const bt = STRAFE_BETA[to];
  if (STRAFE_BETA[from] === undefined || bt === undefined || from.slice(-1) === to.slice(-1)) return null;
  return (((bt - phase) % 1) + 1) % 1;
}

/**
 * 제자리 돌기 한 걸음. 서 있을 때 다리를 조준 쪽으로 계속 돌리면 디딘 두 발이 턴테이블처럼 바닥에서 돈다.
 * 대신 다리는 그대로 두고 상체만 조준을 따라가다가, 비틀림이 커지면 발을 떼어 한 걸음에 돈다.
 * turnL/turnR 클립(tools/blender/build_bot_rig.py)은 90° 도는 동안 디딘 발이 제자리에 있도록 구운 것이고,
 * 더 작은 각은 idle과 섞어서 쓴다(가중치 w).
 */
export interface TurnStep {
  /** 시작할 때 다리가 향한 방향 */
  from: number;
  /** 이번 걸음에 도는 각(+ = 왼쪽) */
  angle: number;
  /** 진행 0..1 */
  u: number;
  dur: number;
  clip: 'turnL' | 'turnR';
  /** 돌기 클립 가중치(나머지는 idle) */
  w: number;
}

/** 클립이 도는 각 (build_bot_rig.py의 TURN_ANGLE) */
export const TURN_CLIP_ANGLE = Math.PI / 2;

/** 클립 진행 u(0..1)에서 몸이 돈 비율. build_bot_rig.py의 turn_progress와 같은 식이어야 디딘 발이 미끄러지지 않는다 */
export function turnYawProgress(u: number): number {
  const k = Math.max(0, Math.min(1, (u - 0.06) / 0.88));
  return k * k * (3 - 2 * k);
}

/** want(라디안)만큼 도는 걸음을 시작한다. 한 걸음은 90°까지이고, 작은 각은 조금 더 빨리 끝난다. dur = 90° 걸음의 길이(초) */
export function startTurnStep(from: number, want: number, dur: number): TurnStep {
  const angle = Math.max(-TURN_CLIP_ANGLE, Math.min(TURN_CLIP_ANGLE, want));
  const w = Math.abs(angle) / TURN_CLIP_ANGLE;
  return { from, angle, u: 0, dur: dur * (0.65 + 0.35 * w), clip: angle >= 0 ? 'turnL' : 'turnR', w };
}

/** 걸음 진행에 맞는 다리 방향 */
export function turnStepYaw(st: TurnStep): number {
  return st.from + st.angle * turnYawProgress(st.u);
}
