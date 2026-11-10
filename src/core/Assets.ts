import {
  AnimationClip, EquirectangularReflectionMapping, Group, Mesh, MeshStandardMaterial, MirroredRepeatWrapping,
  Object3D, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface CharacterAsset {
  /** 리깅된 원본 씬 (복제해서 사용) */
  scene: Group;
  /** 이름별 애니메이션 클립 */
  clips: Record<string, AnimationClip>;
}

/** 에셋 매니페스트: 존재하지 않으면 해당 항목은 null (프리미티브 폴백) */
export interface VfxTextures {
  muzzle: Texture | null;
  bolt: Texture | null;
  /** 4x4 임팩트 스프라이트 시트 */
  impact: Texture | null;
  flashBurst: Texture | null;
}

export interface LoadedAssets {
  sky: Texture | null;
  floor: Texture | null;
  container: Texture | null;
  raven: CharacterAsset | null;
  rifle: Group | null;
  /** 1인칭 팔+라이플 일체형 뷰모델 (힉스필드 생성). 없으면 라이플 단독 뷰모델 */
  fpArms: Group | null;
  /** Blender로 직접 만든 1인칭 팔+라이플 리그(스킨 메시 + idle/reload 클립). 있으면 fpArms 대신 쓴다 */
  fpRig: { scene: Group; clips: AnimationClip[] } | null;
  /** Blender로 직접 만든 적 봇 리그(이동 클립 포함). 있으면 raven·pulse_rifle 대신 쓴다 */
  botRig: { scene: Group; clips: AnimationClip[] } | null;
  /** Blender로 만든 맵 모듈 키트(컨테이너·크레이트·플랫폼·외벽 등). 있으면 그레이박스 외형을 대체한다 */
  mapKit: Group | null;
  detail: DetailTextures;
  vfx: VfxTextures;
}

export const ASSET_BASE = import.meta.env.BASE_URL.replace(/\/$/, '') + '/assets/';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '') + '/assets/';

/** 레이븐 애니메이션 클립 파일 (M3: 힉스필드 리깅 결과) */
export const RAVEN_CLIPS: Record<string, string> = {
  idle: 'models/raven_idle.glb',
  run: 'models/raven_run.glb',
  shoot: 'models/raven_shoot.glb',
  death: 'models/raven_death.glb',
  walk: 'models/raven_walk.glb',
  back: 'models/raven_back.glb',
};

/**
 * 제자리(in-place)가 아닌 클립의 루트 이동 제거: Hips 위치 트랙의 수평(x,z) 선형 이동분만 빼고 좌우 흔들림·상하는 남긴다.
 * 루트가 앞으로 나아가는 클립을 그대로 반복 재생하면 매 루프마다 캐릭터가 뒤로 순간이동한다.
 */
function stripRootMotion(clip: AnimationClip): void {
  const track = clip.tracks.find((tr) => /hips\.position$/i.test(tr.name));
  if (!track || track.times.length < 2) return;
  const v = track.values;
  const n = track.times.length;
  const dx = v[(n - 1) * 3] - v[0];
  const dz = v[(n - 1) * 3 + 2] - v[2];
  if (Math.hypot(dx, dz) < 0.15) return;
  const t0 = track.times[0];
  const dur = track.times[n - 1] - t0 || 1;
  for (let i = 0; i < n; i++) {
    const k = (track.times[i] - t0) / dur;
    v[i * 3] -= dx * k;
    v[i * 3 + 2] -= dz * k;
  }
}

/** 디테일 텍스처(힉스필드 생성 → tools/tex-prep.mjs로 회색조·밝기 보정): 색 위에 곱해 입힌다 */
export interface DetailTextures {
  panel: Texture | null;
  /** 검은 재질용: 패널 선이 밝게 나오도록 뒤집은 패널 텍스처 */
  panelDark: Texture | null;
  suit: Texture | null;
  worn: Texture | null;
}

/** 거의 검은 재질(총 몸통·총열, 봇 관절). 어두운 선을 곱해도 보이지 않아 뒤집은 텍스처를 쓴다 */
const DARK_MATERIAL = /dark|gun_metal/;
/** detail_panel_dark.jpg의 바탕 밝기(sRGB 약 140 = 선형 0.26)를 되돌리는 배율 */
const DARK_GAIN = 3.8;

/**
 * 재질 이름으로 디테일 텍스처를 입힌다. 모델은 Blender에서 상자 투영 UV(1칸 = 고정 길이)를 넣어 두었고,
 * 텍스처는 거울 반복이라 이음새가 없다. map은 재질 색·정점 색에 곱해지고, 같은 텍스처를 bumpMap으로도 써서 패널 선에 음영이 생긴다.
 */
export function applyDetailTextures(root: Object3D, d: DetailTextures): void {
  const pick = (name: string): [Texture | null, number] => {
    if (/glow|visor/.test(name)) return [null, 0];
    if (name === 'kit_paint') return [d.worn, 0.8];
    if (/suit|glove/.test(name)) return [d.suit, 0.4];
    if (DARK_MATERIAL.test(name) && d.panelDark) return [d.panelDark, -0.9]; // 뒤집힌 텍스처라 범프 방향도 뒤집어 선이 홈으로 보이게
    return [d.panel, 0.9];
  };
  const seen = new Set<unknown>();
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      const sm = mat as MeshStandardMaterial;
      const [tex, bump] = pick(sm.name);
      if (!tex) continue;
      // 검은 재질: 뒤집은 텍스처의 바탕이 어두운 만큼 색을 밝혀 바탕 밝기는 그대로 두고 패널 선만 밝게 띄운다
      if (tex === d.panelDark) sm.color.multiplyScalar(DARK_GAIN);
      sm.map = tex;
      sm.bumpMap = tex;
      sm.bumpScale = bump;
      sm.needsUpdate = true;
    }
  });
}

async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    // 개발 서버의 SPA 폴백(index.html)을 존재로 오인하지 않도록
    const ct = r.headers.get('content-type') ?? '';
    return r.ok && !ct.includes('text/html');
  } catch {
    return false;
  }
}

async function loadTexture(loader: TextureLoader, url: string, repeat?: [number, number]): Promise<Texture | null> {
  if (!(await exists(url))) return null;
  try {
    const t = await loader.loadAsync(url);
    t.colorSpace = SRGBColorSpace;
    if (repeat) {
      t.wrapS = t.wrapT = RepeatWrapping;
      t.repeat.set(repeat[0], repeat[1]);
    }
    t.anisotropy = 8;
    return t;
  } catch (e) {
    console.warn('[Assets] texture failed', url, e);
    return null;
  }
}

async function loadGltf(loader: GLTFLoader, url: string): Promise<GLTF | null> {
  if (!(await exists(url))) return null;
  try {
    return await loader.loadAsync(url);
  } catch (e) {
    console.warn('[Assets] gltf failed', url, e);
    return null;
  }
}

/** 모든 에셋을 병렬 로드. 없는 파일은 null로 두어 그레이박스 폴백을 유지 */
export async function loadAssets(onProgress?: (msg: string) => void): Promise<LoadedAssets> {
  const tl = new TextureLoader();
  const gl = new GLTFLoader();
  onProgress?.('텍스처 로딩');
  const [sky, floor, container] = await Promise.all([
    loadTexture(tl, BASE + 'textures/sky_panorama.jpg'),
    loadTexture(tl, BASE + 'textures/floor_plates.jpg', [20, 15]),
    loadTexture(tl, BASE + 'textures/container_panel.jpg', [2, 1]),
  ]);
  if (sky) sky.mapping = EquirectangularReflectionMapping;
  const [muzzle, bolt, impact, flashBurst] = await Promise.all([
    loadTexture(tl, BASE + 'vfx/muzzle_flash.png'),
    loadTexture(tl, BASE + 'vfx/bolt.png'),
    loadTexture(tl, BASE + 'vfx/impact_sheet.png'),
    loadTexture(tl, BASE + 'vfx/flash_burst.png'),
  ]);
  for (const t of [muzzle, bolt, impact, flashBurst]) if (t) t.anisotropy = 1;

  onProgress?.('모델 로딩');
  const [fpRigGltf, botRigGltf, mapKitGltf] = await Promise.all([
    loadGltf(gl, BASE + 'models/fp_rig.glb'),
    loadGltf(gl, BASE + 'models/bot_rig.glb'),
    loadGltf(gl, BASE + 'models/map_kit.glb'),
  ]);
  // 이전 방식 에셋(이미지→3D 캐릭터·라이브러리 클립·라이플)은 새 봇 리그가 없을 때만 내려받는다
  const [ravenBase, rifleGltf, ...clipGltfs] = botRigGltf
    ? [null, null]
    : await Promise.all([
        loadGltf(gl, BASE + 'models/raven.glb'),
        loadGltf(gl, BASE + 'models/pulse_rifle.glb'),
        ...Object.values(RAVEN_CLIPS).map((f) => loadGltf(gl, BASE + f)),
      ]);

  let raven: CharacterAsset | null = null;
  if (ravenBase) {
    const clips: Record<string, AnimationClip> = {};
    Object.keys(RAVEN_CLIPS).forEach((name, i) => {
      const g = clipGltfs[i];
      if (g && g.animations.length) {
        const c = g.animations[0].clone();
        c.name = name;
        stripRootMotion(c);
        clips[name] = c;
      }
    });
    // 기본 GLB 자체에 애니메이션이 있으면 idle로
    if (!clips.idle && ravenBase.animations.length) {
      const c = ravenBase.animations[0].clone();
      c.name = 'idle';
      clips.idle = c;
    }
    ravenBase.scene.traverse((o) => {
      o.castShadow = true;
      o.frustumCulled = false;
    });
    raven = { scene: ravenBase.scene, clips };
  }

  const rifle = rifleGltf ? rifleGltf.scene : null;
  rifle?.traverse((o) => (o.castShadow = true));
  // 이전 방식(이미지→3D 덩어리 메시)은 새 리그가 없을 때만 내려받는다
  const fpArmsGltf = fpRigGltf ? null : await loadGltf(gl, BASE + 'models/fp_arms.glb');
  const fpArms = fpArmsGltf ? fpArmsGltf.scene : null;

  const fpRig = fpRigGltf ? { scene: fpRigGltf.scene, clips: fpRigGltf.animations } : null;
  const botRig = botRigGltf ? { scene: botRigGltf.scene, clips: botRigGltf.animations } : null;
  const mapKit = mapKitGltf ? mapKitGltf.scene : null;
  const [dPanel, dPanelDark, dSuit, dWorn] = await Promise.all([
    loadTexture(tl, BASE + 'textures/detail_panel.jpg'),
    loadTexture(tl, BASE + 'textures/detail_panel_dark.jpg'),
    loadTexture(tl, BASE + 'textures/detail_suit.jpg'),
    loadTexture(tl, BASE + 'textures/detail_worn.jpg'),
  ]);
  for (const t of [dPanel, dPanelDark, dSuit, dWorn]) {
    if (!t) continue;
    t.wrapS = t.wrapT = MirroredRepeatWrapping;
    t.repeat.set(1, 1);
    t.anisotropy = 4;
    t.needsUpdate = true;
  }
  const detail: DetailTextures = { panel: dPanel, panelDark: dPanelDark, suit: dSuit, worn: dWorn };
  for (const root of [fpRigGltf?.scene, botRigGltf?.scene, mapKit]) if (root) applyDetailTextures(root, detail);
  return { sky, floor, container, raven, rifle, fpArms, fpRig, botRig, mapKit, detail, vfx: { muzzle, bolt, impact, flashBurst } };
}
