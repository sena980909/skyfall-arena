import {
  AnimationClip, EquirectangularReflectionMapping, Group, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader,
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
  strafe: 'models/raven_strafe.glb',
  aim: 'models/raven_aim.glb',
};

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
  const [ravenBase, rifleGltf, fpArmsGltf, ...clipGltfs] = await Promise.all([
    loadGltf(gl, BASE + 'models/raven.glb'),
    loadGltf(gl, BASE + 'models/pulse_rifle.glb'),
    loadGltf(gl, BASE + 'models/fp_arms.glb'),
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
  const fpArms = fpArmsGltf ? fpArmsGltf.scene : null;

  return { sky, floor, container, raven, rifle, fpArms, vfx: { muzzle, bolt, impact, flashBurst } };
}
