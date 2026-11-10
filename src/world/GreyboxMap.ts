import { Box3, BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, Object3D, Texture, Vector3 } from 'three';

/** 키트 모듈의 기준 크기 [x 길이, y 높이, z 깊이] — tools/blender/build_map_kit.py와 같은 값 */
const KIT_REF: Record<string, [number, number, number]> = {
  container: [6, 2.5, 2.5], crate: [2, 1, 2], crate_tall: [2, 2, 2], barrier: [6, 1.1, 0.6],
  deck: [12, 0.4, 12], pillar: [1, 3.6, 1], rail: [12, 1, 0.3], wall: [8, 6, 1],
};
interface KitTag { mesh: Mesh; kind: string; cx: number; y0: number; cz: number; sx: number; sy: number; sz: number }

/**
 * 스카이독(SKYDOCK) 그레이박스 — GDD 6장 레이아웃을 프리미티브로.
 * 모든 충돌체는 축 정렬 박스(Box3). 경사로 대신 계단(0.45m 스텝) 사용.
 */
export class GreyboxMap {
  readonly group = new Group();
  readonly meshes: Mesh[] = [];
  readonly colliders: Box3[] = [];
  /** 외형을 키트 모듈로 바꿀 상자 목록 (충돌·탄 판정은 상자 그대로) */
  private readonly kitTags: KitTag[] = [];
  readonly bounds = new Box3(new Vector3(-40, -1, -30), new Vector3(40, 10, 30));
  readonly playerSpawn = new Vector3(0, 0, 26);
  /** 힐팩 위치: [x, z, big] — GDD 6장: 대 ×2, 소 ×4 */
  readonly healthPackSpots: { pos: Vector3; big: boolean }[] = [
    { pos: new Vector3(-9, 0, -5), big: true },
    { pos: new Vector3(9, 0, 5), big: true },
    { pos: new Vector3(-30, 0, -16), big: false },
    { pos: new Vector3(30, 0, -16), big: false },
    { pos: new Vector3(-30, 0, 16), big: false },
    { pos: new Vector3(30, 0, 16), big: false },
  ];
  readonly botSpawns: Vector3[] = [
    new Vector3(-34, 0, -24),
    new Vector3(34, 0, -24),
    new Vector3(0, 0, -26),
    new Vector3(-34, 0, 8),
    new Vector3(34, 0, 8),
    new Vector3(-18, 0, -26),
  ];

  private readonly matFloor = new MeshStandardMaterial({ color: 0x3a4250, roughness: 0.95 });
  private readonly matWall = new MeshStandardMaterial({ color: 0x4a5566, roughness: 0.9 });
  private readonly matContainer = new MeshStandardMaterial({ color: 0x6b7a8f, roughness: 0.8 });
  private readonly matCrate = new MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.85 });
  private readonly matPlatform = new MeshStandardMaterial({ color: 0x55657a, roughness: 0.8 });
  private readonly matAccent = new MeshStandardMaterial({ color: 0xd8b24a, roughness: 0.7 });

  constructor() {
    this.build();
  }

  /** 박스 추가: cx,cz 중심, y0 바닥 높이, sx,sy,sz 크기 */
  private addBox(cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, mat: MeshStandardMaterial, solid = true, kind?: string): Mesh {
    const geo = new BoxGeometry(sx, sy, sz);
    const mesh = new Mesh(geo, mat);
    mesh.position.set(cx, y0 + sy / 2, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.meshes.push(mesh);
    if (kind) this.kitTags.push({ mesh, kind, cx, y0, cz, sx, sy, sz });
    if (solid) {
      this.colliders.push(new Box3(new Vector3(cx - sx / 2, y0, cz - sz / 2), new Vector3(cx + sx / 2, y0 + sy, cz + sz / 2)));
    }
    return mesh;
  }

  private build(): void {
    // 바닥 (80 x 60)
    const floor = this.addBox(0, -0.5, 0, 80, 0.5, 60, this.matFloor);
    floor.castShadow = false;
    // 바닥 격자 느낌용 라인 패널 (비충돌)
    for (let x = -36; x <= 36; x += 8) {
      const strip = this.addBox(x, 0.0, 0, 0.15, 0.02, 60, this.matAccent, false);
      strip.castShadow = false;
    }

    // 외벽 (높이 6)
    this.addBox(0, 0, -30.5, 82, 6, 1, this.matWall, true, 'wall');
    this.addBox(0, 0, 30.5, 82, 6, 1, this.matWall, true, 'wall');
    this.addBox(-40.5, 0, 0, 1, 6, 62, this.matWall, true, 'wall');
    this.addBox(40.5, 0, 0, 1, 6, 62, this.matWall, true, 'wall');

    // 중앙 크레인 플랫폼 (상단 y=4) + 기둥 4개
    this.addBox(0, 3.6, 0, 12, 0.4, 12, this.matPlatform, true, 'deck');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.addBox(sx * 5, 0, sz * 5, 1, 3.6, 1, this.matPlatform, true, 'pillar');
    // 플랫폼 난간 (낮은 벽, 엄폐)
    this.addBox(0, 4, -5.8, 12, 1.0, 0.3, this.matAccent, true, 'rail');
    this.addBox(0, 4, 5.8, 12, 1.0, 0.3, this.matAccent, true, 'rail');

    // 동/서 계단 (9단, 0.45m)
    for (const dir of [-1, 1]) {
      for (let i = 0; i < 9; i++) {
        const h = 4.0 - i * 0.45;
        const x = dir * (6 + 0.35 + i * 0.7);
        this.addBox(x, 0, 0, 0.7, h, 4, this.matPlatform, true, i === 0 ? (dir > 0 ? 'stairs_e' : 'stairs_w') : 'hide');
      }
    }

    // 컨테이너 군 (6 x 2.5 x 2.5)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this.addBox(sx * 16, 0, sz * 12, 6, 2.5, 2.5, this.matContainer, true, 'container');
    }
    // 측면 세로 컨테이너
    this.addBox(-27, 0, 0, 2.5, 2.5, 8, this.matContainer, true, 'container');
    this.addBox(27, 0, 0, 2.5, 2.5, 8, this.matContainer, true, 'container');
    // 모서리 컨테이너 (스폰 보호)
    this.addBox(-24, 0, -22, 6, 2.5, 2.5, this.matContainer, true, 'container');
    this.addBox(24, 0, -22, 6, 2.5, 2.5, this.matContainer, true, 'container');
    this.addBox(-24, 0, 22, 6, 2.5, 2.5, this.matContainer, true, 'container');
    this.addBox(24, 0, 22, 6, 2.5, 2.5, this.matContainer, true, 'container');

    // 낮은 엄폐벽 (1.1m)
    this.addBox(0, 0, -9, 6, 1.1, 0.6, this.matCrate, true, 'barrier');
    this.addBox(0, 0, 9, 6, 1.1, 0.6, this.matCrate, true, 'barrier');
    this.addBox(-14.5, 0, 0, 0.6, 1.1, 5, this.matCrate, true, 'barrier');
    this.addBox(14.5, 0, 0, 0.6, 1.1, 5, this.matCrate, true, 'barrier');

    // 크레이트 (1.0m — 점프로 올라갈 수 있음)
    const crates: [number, number][] = [
      [-8, -18], [8, 18], [-22, -8], [22, 8], [-8, 20], [8, -20], [-33, -10], [33, 10], [-14, 24], [14, -24],
    ];
    for (const [x, z] of crates) this.addBox(x, 0, z, 2, 1.0, 2, this.matCrate, true, 'crate');
    // 2단 크레이트 (컨테이너 접근용)
    this.addBox(-19.5, 0, 14.5, 2, 2.0, 2, this.matCrate, true, 'crate_tall');
    this.addBox(19.5, 0, -14.5, 2, 2.0, 2, this.matCrate, true, 'crate_tall');

    // 스폰 마커 (비충돌, 시각 참고용)
    const spawnMat = new MeshStandardMaterial({ color: new Color(0x2f80ff), emissive: 0x1a3f80, roughness: 0.5 });
    const pm = this.addBox(this.playerSpawn.x, 0, this.playerSpawn.z, 2.4, 0.05, 2.4, spawnMat, false);
    pm.castShadow = false;
  }

  /**
   * Blender 제작 모듈 키트로 외형 교체. 충돌 상자(colliders)와 탄 판정용 메시(meshes)는 그대로 두고 보이지 않게만 한다
   * (three.js 레이캐스트는 visible을 보지 않으므로 판정·시야·길찾기는 바뀌지 않는다).
   */
  applyKit(kit: Group): void {
    kit.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) (mat as MeshStandardMaterial).envMapIntensity = 0.45;
    });
    const place = (name: string, shadows = true): Object3D | null => {
      const src = kit.getObjectByName(name);
      if (!src) return null;
      const inst = src.clone(true);
      inst.traverse((o) => {
        o.castShadow = shadows;
        o.receiveShadow = shadows;
      });
      this.group.add(inst);
      return inst;
    };
    let containers = 0;
    for (const t of this.kitTags) {
      if (t.kind === 'hide') {
        t.mesh.visible = false;
        continue;
      }
      if (t.kind === 'stairs_e' || t.kind === 'stairs_w') {
        const inst = place('kit_stairs');
        if (!inst) continue;
        const east = t.kind === 'stairs_e';
        inst.position.set(east ? 6 : -6, 0, t.cz);
        inst.rotation.y = east ? 0 : Math.PI;
        t.mesh.visible = false;
        continue;
      }
      const ref = KIT_REF[t.kind];
      if (!ref) continue;
      if (t.kind === 'wall') {
        // 긴 벽은 8m 구간 모듈을 이어 붙인다
        const alongX = t.sx >= t.sz;
        const len = alongX ? t.sx : t.sz;
        const n = Math.max(1, Math.round(len / ref[0]));
        const seg = len / n;
        let ok = true;
        for (let i = 0; i < n; i++) {
          const inst = place('kit_wall');
          if (!inst) { ok = false; break; }
          const off = -len / 2 + seg * (i + 0.5);
          inst.position.set(alongX ? t.cx + off : t.cx, t.y0, alongX ? t.cz : t.cz + off);
          inst.rotation.y = alongX ? 0 : Math.PI / 2;
          inst.scale.set(seg / ref[0], t.sy / ref[1], (alongX ? t.sz : t.sx) / ref[2]);
        }
        if (ok) t.mesh.visible = false;
        continue;
      }
      let name = 'kit_' + t.kind;
      let flip = 0;
      if (t.kind === 'container') {
        name = 'kit_container_' + 'abcd'[(containers * 3 + 1) % 4];
        flip = containers % 2 ? Math.PI : 0;
        containers++;
      }
      const inst = place(name);
      if (!inst) continue;
      // 모듈은 X로 길다. 상자가 Z로 길면 90° 돌린다
      const turn = ref[0] !== ref[2] && t.sz > t.sx;
      inst.position.set(t.cx, t.y0, t.cz);
      inst.rotation.y = (turn ? Math.PI / 2 : 0) + flip;
      if (turn) inst.scale.set(t.sz / ref[0], t.sy / ref[1], t.sx / ref[2]);
      else inst.scale.set(t.sx / ref[0], t.sy / ref[1], t.sz / ref[2]);
      t.mesh.visible = false;
    }
    // 배경: 경기장 밖 타워(충돌·판정 없음)와 벽 위 조명
    const towers: [number, number, number, number][] = [
      [-70, -20, 1.4, 1.2], [-58, -50, 1.0, 0.8], [-25, -62, 1.2, 1.4], [5, -70, 1.6, 1.0], [35, -60, 1.0, 1.5], [62, -45, 1.3, 0.9],
      [72, -10, 1.0, 1.3], [66, 25, 1.5, 1.0], [45, 58, 1.0, 1.2], [10, 66, 1.3, 0.8], [-22, 62, 1.0, 1.4], [-55, 48, 1.4, 1.0], [-72, 15, 1.0, 0.9],
    ];
    for (const [x, z, sxz, sy] of towers) {
      const inst = place('kit_tower', false);
      if (!inst) break;
      inst.position.set(x, -2, z);
      inst.scale.set(sxz, sy, sxz);
    }
    for (const z of [-30.5, 30.5]) for (let x = -32; x <= 32; x += 16) place('kit_lamp', false)?.position.set(x, 6, z);
    for (const x of [-40.5, 40.5]) for (let z = -24; z <= 24; z += 16) {
      const inst = place('kit_lamp', false);
      if (!inst) break;
      inst.position.set(x, 6, z);
      inst.rotation.y = Math.PI / 2;
    }
  }

  /** M3: 생성된 텍스처 적용 (없으면 그레이박스 색 유지) */
  applyTextures(floor: Texture | null, container: Texture | null): void {
    if (floor) {
      this.matFloor.map = floor;
      this.matFloor.color.setHex(0xffffff);
      this.matFloor.roughness = 0.8;
      this.matFloor.needsUpdate = true;
      // 플랫폼도 같은 플레이트 텍스처 (반복 축소)
      const platTex = floor.clone();
      platTex.repeat.set(3, 3);
      platTex.needsUpdate = true;
      this.matPlatform.map = platTex;
      this.matPlatform.color.setHex(0xb8c4d4);
      this.matPlatform.needsUpdate = true;
    }
    if (floor) {
      // 크레이트/엄폐벽: 플레이트 텍스처를 작게 반복해 그레이박스 색을 벗어난다
      const crateTex = floor.clone();
      crateTex.repeat.set(1, 1);
      crateTex.needsUpdate = true;
      this.matCrate.map = crateTex;
      this.matCrate.color.setHex(0xc9b48a);
      this.matCrate.needsUpdate = true;
    }
    if (container) {
      this.matContainer.map = container;
      this.matContainer.color.setHex(0xffffff);
      this.matContainer.roughness = 0.75;
      this.matContainer.needsUpdate = true;
      const wallTex = container.clone();
      wallTex.repeat.set(16, 2.4);
      wallTex.needsUpdate = true;
      this.matWall.map = wallTex;
      this.matWall.color.setHex(0x9aa6b8);
      this.matWall.needsUpdate = true;
    }
  }

  /** 점 (x,z) 아래의 지면 높이: 해당 점을 포함하는 충돌체 중 가장 높은 상단 (maxHeight 이하) */
  groundHeightAt(x: number, z: number, maxHeight: number): number {
    let g = 0;
    for (const b of this.colliders) {
      if (b.max.y > maxHeight || b.max.y <= g) continue;
      if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) g = b.max.y;
    }
    return g;
  }

  /** 지정 반경으로 인플레이트된 박스와 점(발 위치)이 겹치는지 — 내비 그리드 빌드용 */
  isBlockedXZ(x: number, z: number, radius: number, yMin: number, yMax: number): boolean {
    for (const b of this.colliders) {
      if (b.max.y <= yMin || b.min.y >= yMax) continue;
      if (x + radius > b.min.x && x - radius < b.max.x && z + radius > b.min.z && z - radius < b.max.z) return true;
    }
    return false;
  }
}
