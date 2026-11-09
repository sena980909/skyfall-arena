import { Group, Matrix4, Mesh, Object3D, Quaternion, Vector3 } from 'three';

/**
 * 생성된 총기 GLB의 방향을 정점 분포로 추정해 "총열 = -Z, 위 = +Y"로 정렬한다.
 * 이미지→3D 변환은 컨셉이 3/4 뷰면 모델이 비스듬히 틀어져 나오므로 바운딩 박스 축 정렬만으론 부족하다.
 *
 * 방법: 정점 공분산의 1주성분 = 총열 축. 양 끝 단면 두께가 얇은 쪽 = 총구.
 *       2주성분 = 수직 축. 더 멀리 뻗은 쪽(탄창/그립) = 아래.
 */
export interface GunAlignment {
  /** 모델에 적용할 회전 (model.quaternion) */
  quaternion: Quaternion;
  /** 정렬 후 로컬 좌표의 총구 위치 */
  muzzleLocal: Vector3;
  /** 정렬 후 로컬 좌표의 중심 */
  centerLocal: Vector3;
  /** 원래 총열 축이 -Z에서 벗어난 각도 (deg) — 진단용 */
  yawErrorDeg: number;
  /** 총열 길이 (정렬 후) */
  length: number;
}

function collectPoints(root: Object3D, maxPoints = 6000): Vector3[] {
  root.updateMatrixWorld(true);
  const pts: Vector3[] = [];
  const meshes: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh) meshes.push(o as Mesh);
  });
  let total = 0;
  for (const m of meshes) total += m.geometry.getAttribute('position')?.count ?? 0;
  const stride = Math.max(1, Math.floor(total / maxPoints));
  const v = new Vector3();
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position');
    if (!pos) continue;
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      pts.push(v.clone());
    }
  }
  return pts;
}

/** 3x3 대칭행렬의 최대 고유벡터 (멱승법) */
function principalAxis(cov: number[], iterations = 60): Vector3 {
  let v = new Vector3(1, 0.3, 0.2).normalize();
  const out = new Vector3();
  for (let i = 0; i < iterations; i++) {
    out.set(
      cov[0] * v.x + cov[1] * v.y + cov[2] * v.z,
      cov[1] * v.x + cov[3] * v.y + cov[4] * v.z,
      cov[2] * v.x + cov[4] * v.y + cov[5] * v.z,
    );
    if (out.lengthSq() < 1e-12) break;
    v = out.clone().normalize();
  }
  return v;
}

export function alignGun(root: Object3D): GunAlignment | null {
  const pts = collectPoints(root);
  if (pts.length < 50) return null;
  const mean = new Vector3();
  for (const p of pts) mean.add(p);
  mean.divideScalar(pts.length);
  // 공분산 (xx, xy, xz, yy, yz, zz)
  const c = [0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const x = p.x - mean.x;
    const y = p.y - mean.y;
    const z = p.z - mean.z;
    c[0] += x * x; c[1] += x * y; c[2] += x * z; c[3] += y * y; c[4] += y * z; c[5] += z * z;
  }
  const axis = principalAxis(c);

  // 축 투영 범위 및 양 끝 두께 → 총구 결정
  let minP = Infinity;
  let maxP = -Infinity;
  const proj = new Float32Array(pts.length);
  const d = new Vector3();
  for (let i = 0; i < pts.length; i++) {
    const pr = d.copy(pts[i]).sub(mean).dot(axis);
    proj[i] = pr;
    if (pr < minP) minP = pr;
    if (pr > maxP) maxP = pr;
  }
  const span = maxP - minP;
  const perp = new Vector3();
  const thickness = (lo: number, hi: number): number => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < pts.length; i++) {
      if (proj[i] < lo || proj[i] > hi) continue;
      perp.copy(pts[i]).sub(mean).addScaledVector(axis, -proj[i]);
      sum += perp.length();
      n++;
    }
    return n ? sum / n : Infinity;
  };
  const tMin = thickness(minP, minP + span * 0.18);
  const tMax = thickness(maxP - span * 0.18, maxP);
  const forward = axis.clone();
  if (tMin < tMax) forward.negate(); // 얇은 쪽이 총구: forward는 총구 방향
  // 2주성분: forward에 수직인 성분으로 공분산을 축소(deflation)한 뒤 다시 멱승법
  const f = forward;
  const lambda = f.x * (c[0] * f.x + c[1] * f.y + c[2] * f.z) + f.y * (c[1] * f.x + c[3] * f.y + c[4] * f.z) + f.z * (c[2] * f.x + c[4] * f.y + c[5] * f.z);
  const c2 = [
    c[0] - lambda * f.x * f.x, c[1] - lambda * f.x * f.y, c[2] - lambda * f.x * f.z,
    c[3] - lambda * f.y * f.y, c[4] - lambda * f.y * f.z, c[5] - lambda * f.z * f.z,
  ];
  let vert = principalAxis(c2);
  vert.addScaledVector(f, -vert.dot(f)).normalize();
  // 수직축 부호: 더 멀리 뻗은 쪽(탄창/그립)이 아래
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of pts) {
    const pr = d.copy(p).sub(mean).dot(vert);
    if (pr < vMin) vMin = pr;
    if (pr > vMax) vMax = pr;
  }
  const up = Math.abs(vMin) > Math.abs(vMax) ? vert.clone() : vert.clone().negate();
  const right = new Vector3().crossVectors(up, forward.clone().negate()).normalize(); // right = up × back
  up.crossVectors(forward.clone().negate(), right).normalize();

  // 모델 기저 (right, up, back=-forward) → 표준 기저 (X, Y, Z)
  const basis = new Matrix4().makeBasis(right, up, forward.clone().negate());
  const q = new Quaternion().setFromRotationMatrix(basis).invert();

  const muzzleWorld = mean.clone().addScaledVector(forward, tMin < tMax ? -minP : maxP);
  const toLocal = (p: Vector3): Vector3 => p.clone().applyQuaternion(q);
  const yawErrorDeg = (Math.acos(Math.min(1, Math.abs(forward.z))) * 180) / Math.PI;
  return { quaternion: q, muzzleLocal: toLocal(muzzleWorld), centerLocal: toLocal(mean), yawErrorDeg, length: span };
}

/**
 * 팔이 붙은 1인칭 모델용 정렬: 모델의 +Y를 그대로 "위"로 믿고(이미지→3D는 이미지의 위가 +Y),
 * 총열 방향(요)만 -Z로 맞춘다. 롤/피치는 건드리지 않아 팔 때문에 총이 기울어지는 일이 없다.
 * 총은 모델 위쪽 절반(팔·손은 아래)으로 보고, 수평면(XZ) 주축을 총열로 삼는다. 얇은 끝 = 총구.
 * 중심은 총 부분의 중심(팔 제외)이라 팔 길이와 무관하게 총 위치가 일정하다.
 */
export function alignGunUpright(root: Object3D): GunAlignment | null {
  const pts = collectPoints(root, 12000);
  if (pts.length < 50) return null;
  let yMin = Infinity, yMax = -Infinity;
  for (const p of pts) { if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y; }
  const gun = pts.filter((p) => p.y > yMin + (yMax - yMin) * 0.5);
  if (gun.length < 50) return null;
  const mean = new Vector3();
  for (const p of gun) mean.add(p);
  mean.divideScalar(gun.length);
  // XZ 평면 2x2 공분산 → 수평 주축
  let sxx = 0, sxz = 0, szz = 0;
  for (const p of gun) { const x = p.x - mean.x, z = p.z - mean.z; sxx += x * x; sxz += x * z; szz += z * z; }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const axis = new Vector3(Math.cos(theta), 0, Math.sin(theta));
  let minP = Infinity, maxP = -Infinity;
  const proj = new Float32Array(gun.length);
  const d = new Vector3();
  for (let i = 0; i < gun.length; i++) {
    const pr = d.copy(gun[i]).sub(mean).dot(axis);
    proj[i] = pr;
    if (pr < minP) minP = pr;
    if (pr > maxP) maxP = pr;
  }
  const span = maxP - minP;
  const perp = new Vector3();
  const thickness = (lo: number, hi: number): number => {
    let sum = 0, n = 0;
    for (let i = 0; i < gun.length; i++) {
      if (proj[i] < lo || proj[i] > hi) continue;
      perp.copy(gun[i]).sub(mean).addScaledVector(axis, -proj[i]);
      sum += perp.length(); n++;
    }
    return n ? sum / n : Infinity;
  };
  const tMin = thickness(minP, minP + span * 0.18);
  const tMax = thickness(maxP - span * 0.18, maxP);
  const forward = axis.clone();
  if (tMin < tMax) forward.negate();
  // 수평 회전만: forward → -Z
  const q = new Quaternion().setFromUnitVectors(forward, new Vector3(0, 0, -1));
  const muzzleWorld = mean.clone().addScaledVector(forward, tMin < tMax ? -minP : maxP);
  const toLocal = (p: Vector3): Vector3 => p.clone().applyQuaternion(q);
  const yawErrorDeg = (Math.acos(Math.min(1, Math.abs(forward.z))) * 180) / Math.PI;
  return { quaternion: q, muzzleLocal: toLocal(muzzleWorld), centerLocal: toLocal(mean), yawErrorDeg, length: span };
}

/**
 * 정렬·정규화된 총기 그룹 생성: 총열 -Z, 위 +Y, 중심 원점, 총열 길이 = length.
 * 반환 muzzle은 그룹 로컬의 총구 위치. upright=true면 alignGunUpright(모델 Y업 유지, 요만 보정) 사용.
 */
export function buildAlignedGun(src: Object3D, length: number, upright = false): { group: Group; muzzle: Vector3; yawErrorDeg: number } {
  const rifle = src.clone();
  const a = upright ? alignGunUpright(rifle) : alignGun(rifle);
  const group = new Group();
  if (!a) {
    group.add(rifle);
    return { group, muzzle: new Vector3(0, 0, -length / 2), yawErrorDeg: 0 };
  }
  const scale = length / (a.length || 1);
  rifle.quaternion.copy(a.quaternion);
  rifle.scale.setScalar(scale);
  rifle.position.copy(a.centerLocal).multiplyScalar(-scale);
  group.add(rifle);
  const muzzle = a.muzzleLocal.clone().sub(a.centerLocal).multiplyScalar(scale);
  return { group, muzzle, yawErrorDeg: a.yawErrorDeg };
}
