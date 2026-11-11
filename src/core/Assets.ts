import {
  AnimationClip, EquirectangularReflectionMapping, Group, Mesh, MeshStandardMaterial, MirroredRepeatWrapping,
  Object3D, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { FpDirectParts } from '@/render/FpDirect';
import type { FxModels } from '@/render/Fx';
import { buildKit, KIT_FILES } from '@/world/KitDirect';

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
  /** 바닥 요철(노멀맵): 판 사이 홈과 볼트. tools/make_floor_maps.py가 색 그림에서 만든다 */
  floorN: Texture | null;
  /** 실내(관제동) 바닥의 무늬 강판과 그 요철 */
  deck: Texture | null;
  deckN: Texture | null;
  container: Texture | null;
  raven: CharacterAsset | null;
  rifle: Group | null;
  /** 1인칭 팔+라이플 일체형 뷰모델 (힉스필드 생성). 없으면 라이플 단독 뷰모델 */
  fpArms: Group | null;
  /** Blender로 직접 만든 1인칭 팔+라이플 리그(스킨 메시 + idle/reload 클립). 있으면 fpArms 대신 쓴다 */
  fpRig: { scene: Group; clips: AnimationClip[] } | null;
  /** 힉스필드 상세 모델(파란색)의 팔·총만 잘라낸 1인칭 모델. 눈이 원점. 있으면 fpRig 대신 쓴다 */
  fpDetail: { scene: Group; clips: AnimationClip[] } | null;
  /** 힉스필드에서 받은 1인칭 모델(총, 탄창, 리깅된 몸). 셋 다 있으면 fpDetail 대신 쓴다(render/FpDirect.ts) */
  fpDirect: FpDirectParts | null;
  /** 힉스필드에서 받은 이펙트 모델(총구 화염, 탄, 피격 섬광) */
  fxModels: FxModels;
  /** Player third-person body: Higgsfield model, rig and clips as generated (entities/PlayerBody.ts) */
  player: CharacterAsset | null;
  /** Blender로 직접 만든 적 봇 리그(이동 클립 포함). 있으면 raven·pulse_rifle 대신 쓴다 */
  botRig: { scene: Group; clips: AnimationClip[] } | null;
  /** Blender로 만든 맵 모듈 키트(컨테이너·크레이트·플랫폼·외벽 등). 있으면 그레이박스 외형을 대체한다 */
  mapKit: Group | null;
  detail: DetailTextures;
  vfx: VfxTextures;
}

export const ASSET_BASE = import.meta.env.BASE_URL.replace(/\/$/, '') + '/assets/';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '') + '/assets/';
/**
 * Asset files keep their names across deploys and the host caches them for 10 minutes, so right after a deploy the new
 * code could run with an old model (e.g. a rig without the clips the code expects). The build stamp makes each deploy
 * fetch its own copy.
 */
export const ASSET_VER = '?v=' + __BUILD__.replace(/\D/g, '');

/** 레이븐 애니메이션 클립 파일 (M3: 힉스필드 리깅 결과) */
/** Player body clips (Higgsfield 3D Rigging on the player model) */
export const PLAYER_CLIPS: Record<string, string> = {
  idle: 'models/player_idle.glb',
  run: 'models/player_run.glb',
  crouch: 'models/player_crouch.glb',
  air: 'models/player_air.glb',
  death: 'models/player_death.glb',
};

export const RAVEN_CLIPS: Record<string, string> = {
  idle: 'models/enemy_idle.glb',
  run: 'models/enemy_run.glb',
  shoot: 'models/enemy_shoot.glb',
  death: 'models/enemy_death.glb',
  walk: 'models/enemy_walk.glb',
  back: 'models/enemy_back.glb',
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
    if (/glow|visor|cap|mag/.test(name)) return [null, 0];
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
      // 자체 텍스처가 있는 재질(힉스필드 상세 모델)은 그대로 둔다
      if (sm.map) continue;
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
    const r = await fetch(url + ASSET_VER, { method: 'HEAD' });
    // 개발 서버의 SPA 폴백(index.html)을 존재로 오인하지 않도록
    const ct = r.headers.get('content-type') ?? '';
    return r.ok && !ct.includes('text/html');
  } catch {
    return false;
  }
}

async function loadTexture(loader: TextureLoader, url: string, repeat?: [number, number], srgb = true): Promise<Texture | null> {
  if (!(await exists(url))) return null;
  try {
    const t = await loader.loadAsync(url + ASSET_VER);
    // 노멀맵은 색이 아니라 방향 값이다: 색 공간 변환을 하지 않는다
    if (srgb) t.colorSpace = SRGBColorSpace;
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
    return await loader.loadAsync(url + ASSET_VER);
  } catch (e) {
    console.warn('[Assets] gltf failed', url, e);
    return null;
  }
}

/** 모든 에셋을 병렬 로드. 없는 파일은 null로 두어 그레이박스 폴백을 유지 */
export async function loadAssets(onProgress?: (msg: string) => void): Promise<LoadedAssets> {
  const tl = new TextureLoader();
  const gl = new GLTFLoader();
  // 생성 모델은 정점 자료를 meshopt로 압축해 싣는다(tools/pack-generated.mjs)
  gl.setMeshoptDecoder(MeshoptDecoder);
  onProgress?.('텍스처 로딩');
  const [sky, floor, container, floorN, deck, deckN] = await Promise.all([
    loadTexture(tl, BASE + 'textures/sky_panorama.jpg'),
    loadTexture(tl, BASE + 'textures/floor_plates.jpg', [20, 15]),
    loadTexture(tl, BASE + 'textures/container_panel.jpg', [2, 1]),
    loadTexture(tl, BASE + 'textures/floor_plates_n.jpg', [20, 15], false),
    loadTexture(tl, BASE + 'textures/floor_deck.jpg', [1, 1]),
    loadTexture(tl, BASE + 'textures/floor_deck_n.jpg', [1, 1], false),
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
  const [fpGun, fpMag, fpBody] = await Promise.all(['fp_gun', 'fp_mag', 'fp_body'].map((n) => loadGltf(gl, BASE + `models/${n}.glb`)));
  const fxGltfs = await Promise.all(['fx_flash', 'fx_bolt', 'fx_impact'].map((n) => loadGltf(gl, BASE + `models/${n}.glb`)));
  const fxModels: FxModels = { flash: fxGltfs[0]?.scene ?? null, bolt: fxGltfs[1]?.scene ?? null, impact: fxGltfs[2]?.scene ?? null };
  const fpParts = fpGun && fpMag && fpBody ? { gun: fpGun.scene, mag: fpMag.scene, body: fpBody.scene } : null;
  const [fpDetailGltf, botRigGltf, ...kitGltfs] = await Promise.all([
    fpParts ? Promise.resolve(null) : loadGltf(gl, BASE + 'models/fp_detail.glb'),
    // 적의 몸은 힉스필드 리깅 모델(enemy.glb + 동작 클립)을 쓴다. Blender 리그(bot_rig.glb)는 없앤다
    Promise.resolve(null as GLTF | null),
    // 맵 소품: 힉스필드에서 받은 모델을 하나씩 그대로 불러 모듈 묶음을 만든다(world/KitDirect.ts)
    ...KIT_FILES.map((n) => loadGltf(gl, BASE + `models/kit/${n}.glb`)),
  ]);
  // 직접 만든 1인칭 리그는 상세 1인칭 모델이 없을 때만 내려받는다
  const fpRigGltf = fpDetailGltf || fpParts ? null : await loadGltf(gl, BASE + 'models/fp_rig.glb');
  // 이전 방식 에셋(이미지→3D 캐릭터·라이브러리 클립·라이플)은 새 봇 리그가 없을 때만 내려받는다
  const [ravenBase, rifleGltf, ...clipGltfs] = botRigGltf
    ? [null, null]
    : await Promise.all([
        loadGltf(gl, BASE + 'models/enemy.glb'),
        loadGltf(gl, BASE + 'models/enemy_rifle.glb'),
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
  const fpArmsGltf = fpRigGltf || fpDetailGltf || fpParts ? null : await loadGltf(gl, BASE + 'models/fp_arms.glb');
  const fpArms = fpArmsGltf ? fpArmsGltf.scene : null;

  const fpRig = fpRigGltf ? { scene: fpRigGltf.scene, clips: fpRigGltf.animations } : null;
  const botRig = botRigGltf ? { scene: botRigGltf.scene, clips: botRigGltf.animations } : null;
  const fpDetail = fpDetailGltf ? { scene: fpDetailGltf.scene, clips: fpDetailGltf.animations } : null;
  const [playerBase, ...playerClipGltfs] = await Promise.all([
    loadGltf(gl, BASE + 'models/player.glb'),
    ...Object.values(PLAYER_CLIPS).map((f) => loadGltf(gl, BASE + f)),
  ]);
  let player: CharacterAsset | null = null;
  if (playerBase) {
    const clips: Record<string, AnimationClip> = {};
    Object.keys(PLAYER_CLIPS).forEach((name, i) => {
      const g = playerClipGltfs[i];
      if (!g || !g.animations.length) return;
      const c = g.animations[0].clone();
      c.name = name;
      stripRootMotion(c);
      clips[name] = c;
    });
    player = { scene: playerBase.scene, clips };
  }
  const fpDirect = fpParts;
  const kitModels = Object.fromEntries(KIT_FILES.map((n, i) => [n, kitGltfs[i]?.scene ?? null]));
  const mapKit = kitGltfs.some((k) => k) ? buildKit(kitModels) : null;
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
  return { sky, floor, floorN, deck, deckN, container, raven, rifle, fpArms, fpRig, fpDetail, fpDirect, fxModels, player, botRig, mapKit, detail, vfx: { muzzle, bolt, impact, flashBurst } };
}
