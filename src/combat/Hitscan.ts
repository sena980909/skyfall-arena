import { Mesh, Raycaster, Vector3 } from 'three';
import type { WeaponDef } from '@/data/heroes';

export type HitPart = 'head' | 'body';

export interface DamageInfo {
  amount: number;
  headshot: boolean;
  /** 공격자 위치 (피격 방향 표시용) */
  from: Vector3;
  attacker: Hittable | null;
}

/** 피격 가능한 엔티티. hitMeshes의 userData = { owner, part } */
export interface Hittable {
  readonly hitMeshes: Mesh[];
  readonly alive: boolean;
  readonly displayName: string;
  /** 중심 위치 (발) */
  readonly position: Vector3;
  takeDamage(info: DamageInfo): void;
}

export interface HitResult {
  point: Vector3;
  distance: number;
  target: Hittable | null;
  part: HitPart | null;
}

const raycaster = new Raycaster();

export function tagHitMesh(mesh: Mesh, owner: Hittable, part: HitPart): Mesh {
  mesh.userData.owner = owner;
  mesh.userData.part = part;
  return mesh;
}

/** 히트스캔 레이캐스트: 맵 + 다른 Hittable의 히트박스. shooter는 제외 */
export function hitscan(
  origin: Vector3,
  dir: Vector3,
  maxDist: number,
  mapMeshes: Mesh[],
  targets: Hittable[],
  shooter: Hittable | null,
): HitResult {
  raycaster.set(origin, dir);
  raycaster.far = maxDist;
  const objs: Mesh[] = [...mapMeshes];
  for (const t of targets) {
    if (t === shooter || !t.alive) continue;
    for (const m of t.hitMeshes) objs.push(m);
  }
  const hits = raycaster.intersectObjects(objs, false);
  if (hits.length === 0) {
    return { point: origin.clone().addScaledVector(dir, maxDist), distance: maxDist, target: null, part: null };
  }
  const h = hits[0];
  const owner = (h.object.userData.owner as Hittable | undefined) ?? null;
  const part = (h.object.userData.part as HitPart | undefined) ?? null;
  return { point: h.point.clone(), distance: h.distance, target: owner, part };
}

/** 시야선(LOS) 체크: 맵만 대상으로 두 점 사이가 막혔는지 */
export function losBlocked(from: Vector3, to: Vector3, mapMeshes: Mesh[]): boolean {
  const dir = to.clone().sub(from);
  const dist = dir.length();
  if (dist < 1e-3) return false;
  dir.divideScalar(dist);
  raycaster.set(from, dir);
  raycaster.far = dist;
  const hits = raycaster.intersectObjects(mapMeshes, false);
  return hits.length > 0;
}

/** 거리 감쇠 적용 피해량 */
export function computeDamage(w: WeaponDef, distance: number, headshot: boolean): number {
  let f = 1;
  if (distance > w.falloffStart) {
    const t = Math.min(1, (distance - w.falloffStart) / (w.falloffEnd - w.falloffStart));
    f = 1 - t * (1 - w.falloffMin);
  }
  return Math.round(w.damage * f * (headshot ? w.headshotMult : 1));
}
