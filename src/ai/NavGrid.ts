import { Vector3 } from 'three';
import type { GreyboxMap } from '@/world/GreyboxMap';

const STEP_UP = 0.55;
const DROP_MAX = 4.5;
const MAX_WALK_HEIGHT = 4.6;

/**
 * 0.5m 셀 높이필드 내비 그리드 + A* + LOS 스무딩.
 * 각 셀은 지면 높이를 가지며, 인접 셀은 오르막 ≤ 0.55m / 내리막 ≤ 4.5m일 때 연결된다.
 * → 봇이 계단을 오르고 플랫폼에서 뛰어내릴 수 있다.
 */
export class NavGrid {
  readonly cell = 0.5;
  readonly w: number;
  readonly h: number;
  readonly ox: number;
  readonly oz: number;
  private readonly height: Float32Array;
  private readonly blocked: Uint8Array;
  /** 플레이어 스폰에서 도달 가능한 셀 (고립된 컨테이너 상단 등 제외) */
  private readonly reachable: Uint8Array;
  private readonly walkable: number[] = [];
  // A* 재사용 버퍼
  private readonly gBuf: Float32Array;
  private readonly fBuf: Float32Array;
  private readonly cameBuf: Int32Array;
  private readonly closedBuf: Uint8Array;

  constructor(map: GreyboxMap, agentRadius = 0.45) {
    this.ox = map.bounds.min.x;
    this.oz = map.bounds.min.z;
    this.w = Math.ceil((map.bounds.max.x - map.bounds.min.x) / this.cell);
    this.h = Math.ceil((map.bounds.max.z - map.bounds.min.z) / this.cell);
    this.height = new Float32Array(this.w * this.h);
    this.blocked = new Uint8Array(this.w * this.h);
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const x = this.ox + (i + 0.5) * this.cell;
        const z = this.oz + (j + 0.5) * this.cell;
        const g = map.groundHeightAt(x, z, MAX_WALK_HEIGHT);
        const idx = j * this.w + i;
        this.height[idx] = g;
        const b = map.isBlockedXZ(x, z, agentRadius, g + STEP_UP, g + 1.8);
        this.blocked[idx] = b ? 1 : 0;
      }
    }
    const n = this.w * this.h;
    this.gBuf = new Float32Array(n);
    this.fBuf = new Float32Array(n);
    this.cameBuf = new Int32Array(n);
    this.closedBuf = new Uint8Array(n);
    this.reachable = new Uint8Array(n);
    this.floodReachable(map.playerSpawn);
    for (let idx = 0; idx < n; idx++) if (this.reachable[idx]) this.walkable.push(idx);
  }

  /** 시작점에서 passable 규칙으로 도달 가능한 셀 표시 (BFS) */
  private floodReachable(from: Vector3): void {
    const [si0, sj0] = this.toCell(from);
    let si = si0;
    let sj = sj0;
    outer: for (let r = 0; r < 12 && this.isBlocked(si, sj); r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (!this.isBlocked(si0 + di, sj0 + dj)) { si = si0 + di; sj = sj0 + dj; break outer; }
      }
    }
    const queue: number[] = [sj * this.w + si];
    this.reachable[queue[0]] = 1;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const ci = cur % this.w;
      const cj = Math.floor(cur / this.w);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ni = ci + di;
        const nj = cj + dj;
        if (!this.passable(ci, cj, ni, nj)) continue;
        if (di !== 0 && dj !== 0 && (!this.passable(ci, cj, ci + di, cj) || !this.passable(ci, cj, ci, cj + dj))) continue;
        const nidx = nj * this.w + ni;
        if (this.reachable[nidx]) continue;
        this.reachable[nidx] = 1;
        queue.push(nidx);
      }
    }
  }

  isReachable(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return false;
    return this.reachable[j * this.w + i] === 1;
  }

  toCell(p: Vector3): [number, number] {
    return [
      Math.max(0, Math.min(this.w - 1, Math.floor((p.x - this.ox) / this.cell))),
      Math.max(0, Math.min(this.h - 1, Math.floor((p.z - this.oz) / this.cell))),
    ];
  }

  toWorld(i: number, j: number, out = new Vector3()): Vector3 {
    return out.set(this.ox + (i + 0.5) * this.cell, this.heightAt(i, j), this.oz + (j + 0.5) * this.cell);
  }

  heightAt(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 0;
    return this.height[j * this.w + i];
  }

  isBlocked(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return true;
    return this.blocked[j * this.w + i] === 1;
  }

  /** from → to 셀로 한 칸 이동 가능한지 (높이 차 포함) */
  private passable(fi: number, fj: number, ti: number, tj: number): boolean {
    if (this.isBlocked(ti, tj)) return false;
    const dh = this.heightAt(ti, tj) - this.heightAt(fi, fj);
    return dh <= STEP_UP && dh >= -DROP_MAX;
  }

  randomWalkable(out = new Vector3()): Vector3 {
    const idx = this.walkable[Math.floor(Math.random() * this.walkable.length)];
    return this.toWorld(idx % this.w, Math.floor(idx / this.w), out);
  }

  /** 중심 기준 반경 내 랜덤 걷기 가능 지점 (최대 tries회 시도, 실패 시 null) */
  randomWalkableNear(center: Vector3, radius: number, tries = 30, out = new Vector3()): Vector3 | null {
    for (let t = 0; t < tries; t++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const x = center.x + Math.cos(a) * r;
      const z = center.z + Math.sin(a) * r;
      const i = Math.floor((x - this.ox) / this.cell);
      const j = Math.floor((z - this.oz) / this.cell);
      if (this.isReachable(i, j)) return this.toWorld(i, j, out);
    }
    return null;
  }

  private nearestWalkable(i: number, j: number): [number, number] {
    const ok = (a: number, b: number): boolean => this.isReachable(a, b);
    if (ok(i, j)) return [i, j];
    for (let r = 1; r < 12; r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        if (ok(i + di, j + dj)) return [i + di, j + dj];
      }
    }
    return [i, j];
  }

  /** 두 셀 사이 직선 통과 가능 여부 (샘플링 + 높이 연속성) */
  private losCells(a: [number, number], b: [number, number]): boolean {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const steps = Math.max(Math.abs(dx), Math.abs(dz)) * 2;
    if (steps === 0) return true;
    let prevH = this.heightAt(a[0], a[1]);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const i = Math.round(a[0] + dx * t);
      const j = Math.round(a[1] + dz * t);
      if (this.isBlocked(i, j)) return false;
      const hh = this.heightAt(i, j);
      const dh = hh - prevH;
      if (dh > STEP_UP || dh < -DROP_MAX) return false;
      prevH = hh;
      const i2 = Math.floor(a[0] + dx * t + 0.5 * Math.sign(dx));
      const j2 = Math.floor(a[1] + dz * t + 0.5 * Math.sign(dz));
      if (this.isBlocked(i2, j) || this.isBlocked(i, j2)) return false;
    }
    return true;
  }

  /** A* 경로. 월드 좌표(지면 높이 포함) 리스트, 시작 셀 제외. 실패 시 빈 배열 */
  findPath(from: Vector3, to: Vector3): Vector3[] {
    const [si0, sj0] = this.toCell(from);
    const [gi0, gj0] = this.toCell(to);
    const [si, sj] = this.nearestWalkable(si0, sj0);
    const [gi, gj] = this.nearestWalkable(gi0, gj0);
    const start = sj * this.w + si;
    const goal = gj * this.w + gi;
    if (start === goal) return [this.toWorld(gi, gj)];
    if (!this.reachable[start] || !this.reachable[goal]) return [];

    const g = this.gBuf.fill(Infinity);
    const f = this.fBuf.fill(Infinity);
    const came = this.cameBuf.fill(-1);
    const closed = this.closedBuf.fill(0);
    // 이진 힙
    const heap: number[] = [];
    const push = (idx: number): void => {
      heap.push(idx);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (f[heap[p]] <= f[heap[k]]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = (): number => {
      const top = heap[0];
      const last = heap.pop() as number;
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = k * 2 + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l;
          if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };

    g[start] = 0;
    f[start] = this.heur(si, sj, gi, gj);
    push(start);

    const dirs: [number, number, number][] = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];

    let iter = 0;
    while (heap.length && iter++ < 60000) {
      const cur = pop();
      if (cur === goal) return this.reconstruct(came, cur, start);
      if (closed[cur]) continue;
      closed[cur] = 1;
      const ci = cur % this.w;
      const cj = Math.floor(cur / this.w);
      for (const [di, dj, cost] of dirs) {
        const ni = ci + di;
        const nj = cj + dj;
        if (!this.passable(ci, cj, ni, nj)) continue;
        if (di !== 0 && dj !== 0 && (!this.passable(ci, cj, ci + di, cj) || !this.passable(ci, cj, ci, cj + dj))) continue;
        const nidx = nj * this.w + ni;
        if (closed[nidx]) continue;
        // 높이 변화에 약간의 비용 (계단은 가능하지만 평지 선호)
        const dh = Math.abs(this.heightAt(ni, nj) - this.heightAt(ci, cj));
        const ng = g[cur] + cost + dh * 0.5;
        if (ng < g[nidx]) {
          g[nidx] = ng;
          f[nidx] = ng + this.heur(ni, nj, gi, gj);
          came[nidx] = cur;
          push(nidx);
        }
      }
    }
    return [];
  }

  private heur(i: number, j: number, gi: number, gj: number): number {
    const dx = Math.abs(i - gi);
    const dz = Math.abs(j - gj);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  }

  private reconstruct(came: Int32Array, cur: number, start: number): Vector3[] {
    const cells: [number, number][] = [];
    let c = cur;
    while (c !== -1 && c !== start) {
      cells.push([c % this.w, Math.floor(c / this.w)]);
      c = came[c];
    }
    cells.push([start % this.w, Math.floor(start / this.w)]);
    cells.reverse();
    const out: Vector3[] = [];
    let anchor = 0;
    while (anchor < cells.length - 1) {
      let far = anchor + 1;
      // 스무딩 탐색 창을 40셀(20m)로 제한해 긴 경로의 O(L²) 비용을 막는다
      for (let k = Math.min(cells.length - 1, anchor + 40); k > anchor + 1; k--) {
        if (this.losCells(cells[anchor], cells[k])) { far = k; break; }
      }
      out.push(this.toWorld(cells[far][0], cells[far][1]));
      anchor = far;
    }
    return out;
  }
}
