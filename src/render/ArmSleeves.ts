import { CylinderGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';

/**
 * 1인칭 팔+총 모델의 전완 절단면에서 어깨 방향으로 상완을 이어 붙인다.
 * 생성 모델은 팔꿈치에서 끝나므로, 총을 조금만 들어도 절단면이 보이고 손·총이 공중에 뜬 것처럼 보인다.
 *
 * 가정(정렬된 그룹 로컬): 총열 -Z, 위 +Y, 팔은 총 아래(y<0)에서 손으로부터 +Z(사수 쪽)로 뻗는다.
 * 절단면 = 각 팔(좌/우) 정점 중 팔 주축 방향 끝 8%.
 */
export function collectLocalPoints(group: Group, maxPoints = 40000): Vector3[] {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const pts: Vector3[] = [];
  group.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute('position');
    if (!pos) return;
    const toLocal = m.matrixWorld.clone().premultiply(inv);
    const stride = Math.max(1, Math.ceil(pos.count / maxPoints));
    for (let i = 0; i < pos.count; i += stride) pts.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(toLocal));
  });
  return pts;
}

export interface SleeveOptions {
  /** 그룹 로컬 좌표의 어깨 목표점 [왼쪽, 오른쪽] */
  shoulders: [Vector3, Vector3];
  /** 팔로 볼 y 상한(그룹 로컬). 총 아랫면보다 약간 아래 */
  armTopY?: number;
  color?: number;
  bandColor?: number;
}

export function addArmSleeves(group: Group, pts: Vector3[], opts: SleeveOptions): Object3D[] {
  const armTopY = opts.armTopY ?? -0.12;
  const mat = new MeshStandardMaterial({ color: opts.color ?? 0x15224f, roughness: 0.6, metalness: 0.2 });
  const band = new MeshStandardMaterial({ color: opts.bandColor ?? 0x2f6fff, roughness: 0.45, metalness: 0.25 });
  const made: Object3D[] = [];

  for (const side of [-1, 1] as const) {
    const arm = pts.filter((p) => p.y < armTopY && Math.sign(p.x) === side);
    if (arm.length < 80) continue;
    const c = arm.reduce((s, p) => s.add(p), new Vector3()).multiplyScalar(1 / arm.length);
    // 주축(파워 반복), 사수 쪽(+Z)으로 향하게
    let axis = new Vector3(0, -0.2, 1).normalize();
    for (let it = 0; it < 30; it++) {
      const acc = new Vector3();
      for (const p of arm) {
        const d = p.clone().sub(c);
        acc.addScaledVector(d, d.dot(axis));
      }
      if (acc.lengthSq() < 1e-12) break;
      axis = acc.normalize();
    }
    if (axis.z < 0) axis.negate();
    const proj = arm.map((p) => p.clone().sub(c).dot(axis));
    let maxT = -Infinity, minT = Infinity;
    for (const t of proj) { if (t > maxT) maxT = t; if (t < minT) minT = t; }
    const span = maxT - minT;
    const cap = arm.filter((_, i) => proj[i] > maxT - span * 0.08);
    // 두께는 끝단 둥근 부분이 아니라 끝 25% 구간의 평균 반지름으로
    const nearEnd = arm.filter((_, i) => proj[i] > maxT - span * 0.25);
    if (cap.length < 8 || nearEnd.length < 20) continue;
    const capC = cap.reduce((s, p) => s.add(p), new Vector3()).multiplyScalar(1 / cap.length);
    let r2 = 0;
    for (const p of nearEnd) {
      const d = p.clone().sub(capC);
      d.addScaledVector(axis, -d.dot(axis));
      r2 += d.lengthSq();
    }
    const radius = Math.min(0.09, Math.max(0.04, Math.sqrt(r2 / nearEnd.length) * 1.15));

    const target = opts.shoulders[side < 0 ? 0 : 1];
    const dir = target.clone().sub(capC);
    const len = Math.max(0.3, dir.length() + 0.15);
    dir.normalize();
    // 절단면 안쪽에서 시작해 어깨 너머까지
    const start = capC.clone().addScaledVector(dir, -radius * 0.6);
    const geo = new CylinderGeometry(radius, radius * 1.3, len, 20, 1, false);
    geo.translate(0, len / 2, 0);
    const sleeve = new Mesh(geo, mat);
    sleeve.position.copy(start);
    sleeve.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
    // 팔꿈치 장갑 띠
    const ring = new Mesh(new CylinderGeometry(radius * 1.08, radius * 1.1, radius * 0.9, 20, 1, false), band);
    ring.position.y = radius * 0.9;
    sleeve.add(ring);
    group.add(sleeve);
    made.push(sleeve);
  }
  return made;
}
