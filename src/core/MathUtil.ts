import { Vector3 } from 'three';

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const randRange = (a: number, b: number): number => a + Math.random() * (b - a);
export const randInt = (a: number, b: number): number => Math.floor(randRange(a, b + 1));
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** 표준정규분포 난수 (Box-Muller) */
export function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 방향 벡터를 원뿔 안에서 랜덤하게 흔든다 (spreadDeg: 최대 반각) */
export function jitterDirection(dir: Vector3, spreadDeg: number, out = new Vector3()): Vector3 {
  if (spreadDeg <= 0) return out.copy(dir);
  const up = Math.abs(dir.y) > 0.99 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(dir, up).normalize();
  const realUp = new Vector3().crossVectors(right, dir).normalize();
  const angle = Math.random() * Math.PI * 2;
  const mag = Math.sqrt(Math.random()) * Math.tan(spreadDeg * DEG2RAD);
  return out
    .copy(dir)
    .addScaledVector(right, Math.cos(angle) * mag)
    .addScaledVector(realUp, Math.sin(angle) * mag)
    .normalize();
}

/** 두 방향 사이 각도 (deg) */
export function angleBetweenDeg(a: Vector3, b: Vector3): number {
  const d = clamp(a.dot(b) / (a.length() * b.length() || 1), -1, 1);
  return Math.acos(d) * RAD2DEG;
}

/** 현재 방향을 목표 방향으로 maxDeg만큼만 회전 */
export function rotateTowards(current: Vector3, target: Vector3, maxDeg: number): Vector3 {
  const ang = angleBetweenDeg(current, target);
  if (ang <= maxDeg || ang < 1e-4) return current.copy(target).normalize();
  const t = maxDeg / ang;
  return current.lerp(target, t).normalize();
}

/** XZ 평면 yaw (라디안). dir가 +Z를 볼 때 0 */
export const yawOf = (dir: Vector3): number => Math.atan2(dir.x, dir.z);
