import type { Material } from 'three';

/** 색 채널을 바꿔 끼우는 방식. 색상만 바뀌고 회색(총·관절)은 그대로다 */
export type HueSwap = 'rbg' | 'brg' | 'bgr';

/**
 * 텍스처 색을 곱해서는 주황 갑옷을 다른 색으로 바꿀 수 없다(어두워질 뿐이다). 셰이더에서 채널을 돌린다:
 * 주황(1, 0.5, 0.15)이 rbg면 자홍(1, 0.15, 0.5), brg면 초록(0.15, 1, 0.5), bgr이면 파랑(0.15, 0.5, 1)이 된다.
 */
export function applyHueSwap(mat: Material, swap: HueSwap): void {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n\tdiffuseColor.rgb = diffuseColor.${swap};`);
  };
  mat.customProgramCacheKey = () => `hue_${swap}`;
}

/** 재질을 복제한 뒤 채널 돌리기를 이어 준다(clone은 onBeforeCompile을 옮기지 않는다) */
export function copyHueSwap(from: Material, to: Material): void {
  to.onBeforeCompile = from.onBeforeCompile;
  to.customProgramCacheKey = from.customProgramCacheKey;
}
