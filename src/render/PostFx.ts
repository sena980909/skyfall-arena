import {
  HalfFloatType, ShaderMaterial, Vector2, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * 월드와 1인칭 뷰모델을 따로 그려 합친다.
 * 한 렌더 타깃에 지우지 않고 두 번 그리면 멀티샘플 타깃에서는 첫 번째 그림이 보존된다는 보장이 없어서
 * (해상 후 색 버퍼가 무효화됨) 뷰모델은 투명 배경의 별도 타깃에 그린 뒤 셰이더로 덮는다.
 */
class ScenePass extends Pass {
  private readonly vmTarget: WebGLRenderTarget;
  private readonly quad: FullScreenQuad;
  private readonly mat: ShaderMaterial;

  constructor(
    private readonly drawWorld: () => void,
    private readonly drawViewmodel: () => void,
    width: number,
    height: number,
  ) {
    super();
    this.needsSwap = true;
    this.vmTarget = new WebGLRenderTarget(width, height, { type: HalfFloatType, samples: 4 });
    this.mat = new ShaderMaterial({
      uniforms: { tWorld: { value: null }, tVm: { value: null } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tWorld;
        uniform sampler2D tVm;
        varying vec2 vUv;
        void main() {
          vec4 w = texture2D(tWorld, vUv);
          vec4 v = texture2D(tVm, vUv);
          // 뷰모델 타깃은 (0,0,0,0)으로 지웠으므로 가장자리 색은 이미 알파가 곱해진 값이다
          gl_FragColor = vec4(v.rgb + w.rgb * (1.0 - v.a), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }

  override setSize(width: number, height: number): void {
    this.vmTarget.setSize(width, height);
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    renderer.setRenderTarget(readBuffer);
    this.drawWorld();
    const alpha = renderer.getClearAlpha();
    renderer.setClearAlpha(0);
    renderer.setRenderTarget(this.vmTarget);
    this.drawViewmodel();
    renderer.setClearAlpha(alpha);
    this.mat.uniforms.tWorld.value = readBuffer.texture;
    this.mat.uniforms.tVm.value = this.vmTarget.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.vmTarget.dispose();
    this.mat.dispose();
    this.quad.dispose();
  }
}

/** 마지막 화면 보정: 톤매핑·sRGB 변환 뒤(화면 색 공간)에서 계산한다 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    /** 피격 순간 0..1 (빠르게 감쇠) */
    uDamage: { value: 0 },
    /** 체력이 낮을수록 0..1 */
    uLowHp: { value: 0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uDamage;
    uniform float uLowHp;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      // 색수차: 평소에는 화면 가장자리에만 아주 약하게, 피격 순간에 강해진다
      vec2 off = c * r2 * (0.006 + 0.05 * uDamage);
      vec3 col = vec3(
        texture2D(tDiffuse, vUv + off).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - off).b
      );
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // 대비를 조금 올리고, 밝은 곳은 따뜻하게·어두운 곳은 차갑게 (분할 톤)
      col = (col - 0.5) * 1.08 + 0.5;
      col += (l - 0.45) * vec3(0.035, 0.008, -0.04);
      // 채도: 평소 살짝 낮추고, 체력이 낮으면 더 뺀다
      col = mix(vec3(l), col, 0.94 - 0.45 * uLowHp);
      // 비네트: 체력이 낮거나 맞는 순간 가장자리가 더 어두워지고 붉어진다
      float edge = smoothstep(0.12, 0.62, r2);
      col *= 1.0 - edge * (0.34 + 0.25 * uLowHp);
      col = mix(col, vec3(0.55, 0.03, 0.02), edge * (0.45 * uDamage + 0.22 * uLowHp * (0.6 + 0.4 * sin(uTime * 5.0))));
      // 필름 그레인 (밴딩 방지 겸)
      col += (hash(vUv * 917.0 + fract(uTime) * 61.0) - 0.5) * 0.012;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

/**
 * 후처리: (월드 + 뷰모델 합성) → 블룸 → 톤매핑·sRGB → 화면 보정(비네트·분할 톤·그레인·피격 색수차).
 * 발광 재질(총 조명, 바이저, 벽 조명, 탄환, 총구 섬광)이 번져 보이고 화면에 깊이가 생긴다.
 */
export class PostFx {
  enabled = true;
  private readonly composer: EffectComposer;
  private readonly scenePass: ScenePass;
  private readonly bloom: UnrealBloomPass;
  private readonly grade: ShaderPass;
  private readonly size = new Vector2();
  private damage = 0;
  private lowHp = 0;
  private lastTime = 0;

  constructor(private readonly renderer: WebGLRenderer, drawWorld: () => void, drawViewmodel: () => void) {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    // 렌더 타깃을 직접 주면 컴포저는 픽셀 비율 1로 동작한다 → 크기는 항상 실제 버퍼 픽셀로 넘긴다
    this.composer = new EffectComposer(renderer, new WebGLRenderTarget(w, h, { type: HalfFloatType, samples: 4 }));
    this.scenePass = new ScenePass(drawWorld, drawViewmodel, w, h);
    this.composer.addPass(this.scenePass);
    // 세기, 번짐 반경, 문턱(선형 휘도). 문턱을 1 근처로 둬서 발광체와 강한 하이라이트만 번지게 한다
    this.bloom = new UnrealBloomPass(new Vector2(w, h), 0.34, 0.5, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  /** 창 크기가 바뀌면 호출 (renderer.setSize 뒤) */
  resize(): void {
    this.renderer.getDrawingBufferSize(this.size);
    this.composer.setSize(Math.max(1, this.size.x), Math.max(1, this.size.y));
  }

  /** 피격량만큼 화면 충격을 더한다 (0..1로 누적, 자동 감쇠) */
  hit(amount01: number): void {
    this.damage = Math.min(1, this.damage + amount01);
  }

  /** 현재 체력 비율(0..1). 35% 아래에서 채도가 빠지고 가장자리가 붉게 뛴다 */
  setHealth(frac: number): void {
    this.lowHp = Math.min(1, Math.max(0, (0.35 - frac) / 0.35));
  }

  render(): void {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - this.lastTime);
    this.lastTime = now;
    this.damage = Math.max(0, this.damage - dt * 2.2);
    const u = this.grade.uniforms;
    u.uTime.value = now % 1000;
    u.uDamage.value = this.damage;
    u.uLowHp.value = this.lowHp;
    this.composer.render(dt);
  }
}
