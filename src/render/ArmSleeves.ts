import { CylinderGeometry, Group, Mesh, MeshStandardMaterial, Object3D, SphereGeometry, Vector3 } from 'three';

/**
 * 1인칭 팔+총 모델의 전완 끝(팔꿈치 절단부)을 관절 구로 막고, 어깨 방향으로 상완을 이어 붙인다.
 * 생성 모델은 팔꿈치에서 끝나며 끝부분이 안으로 패인 컵 모양이라, 총을 조금만 들어도 안쪽 빈 공간이 보인다.
 *
 * 절단부 위치(정렬된 그룹 로컬: 총열 -Z, 위 +Y, 사수 쪽 +Z):
 *  - 왼쪽 전완은 총열덮개 아래에서 아래로 늘어지므로 모델에서 가장 낮은 정점 덩어리의 중심
 *  - 오른쪽 전완은 권총손잡이에서 사수 쪽으로 뻗으므로 총 아래(y<-0.1) 정점 중 가장 뒤(+Z) 덩어리의 중심
 */

export interface ArmEnd { center: Vector3; radius: number; dir: Vector3 }

function collectLocalPoints(group: Group, maxPoints = 60000): Vector3[] {
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

function endFromCluster(pts: Vector3[], cluster: Vector3[]): ArmEnd | null {
  if (cluster.length < 30) return null;
  const center = cluster.reduce((s, p) => s.add(p), new Vector3()).multiplyScalar(1 / cluster.length);
  let radius = 0;
  for (const p of cluster) radius += p.distanceTo(center);
  radius /= cluster.length;
  // 팔 방향: 끝 덩어리를 제외한 근처(4r) 정점 중심 → 끝 중심
  const near = new Vector3();
  let n = 0;
  for (const p of pts) {
    const d = p.distanceTo(center);
    if (d > radius * 1.2 && d < radius * 4) { near.add(p); n++; }
  }
  const dir = n ? center.clone().sub(near.divideScalar(n)).normalize() : new Vector3(0, -1, 0);
  return { center, radius, dir };
}

export function findArmEnds(group: Group): ArmEnd[] {
  const pts = collectLocalPoints(group);
  if (pts.length < 100) return [];
  let minY = Infinity;
  for (const p of pts) if (p.y < minY) minY = p.y;
  const low = pts.filter((p) => p.y < -0.1);
  let maxZ = -Infinity;
  for (const p of low) if (p.z > maxZ) maxZ = p.z;
  const ends: ArmEnd[] = [];
  const a = endFromCluster(pts, pts.filter((p) => p.y < minY + 0.07));
  const b = endFromCluster(pts, low.filter((p) => p.z > maxZ - 0.07));
  if (a) ends.push(a);
  if (b && (!a || b.center.distanceTo(a.center) > 0.2)) ends.push(b);
  return ends;
}

export interface SleeveOptions {
  /** 그룹 로컬 좌표의 어깨 목표점들 (팔 방향과 가장 잘 맞는 것을 고른다) */
  shoulders: Vector3[];
  color?: number;
  bandColor?: number;
}

export function addArmSleeves(group: Group, opts: SleeveOptions): Object3D[] {
  const mat = new MeshStandardMaterial({ color: opts.color ?? 0x15224f, roughness: 0.6, metalness: 0.2 });
  const band = new MeshStandardMaterial({ color: opts.bandColor ?? 0x2f6fff, roughness: 0.45, metalness: 0.25 });
  const made: Object3D[] = [];
  for (const end of findArmEnds(group)) {
    const r = end.radius;
    let target = opts.shoulders[0];
    let best = -Infinity;
    for (const s of opts.shoulders) {
      const d = s.clone().sub(end.center).normalize().dot(end.dir);
      if (d > best) { best = d; target = s; }
    }
    // 관절 구: 패인 끝을 덮는다 (살짝 안쪽으로)
    const joint = new Mesh(new SphereGeometry(r * 1.08, 20, 14), mat);
    joint.position.copy(end.center).addScaledVector(end.dir, -r * 0.2);
    group.add(joint);
    made.push(joint);
    // 상완: 관절에서 어깨까지 (위로 갈수록 굵게)
    const dir = target.clone().sub(end.center);
    const len = Math.max(0.3, dir.length() + 0.15);
    dir.normalize();
    const geo = new CylinderGeometry(r * 1.0, r * 1.25, len, 20, 1, false);
    geo.translate(0, len / 2, 0);
    const sleeve = new Mesh(geo, mat);
    sleeve.position.copy(end.center);
    sleeve.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
    const ringMesh = new Mesh(new CylinderGeometry(r * 1.08, r * 1.12, r * 0.8, 20, 1, false), band);
    ringMesh.position.y = r * 1.1;
    sleeve.add(ringMesh);
    group.add(sleeve);
    made.push(sleeve);
  }
  return made;
}
