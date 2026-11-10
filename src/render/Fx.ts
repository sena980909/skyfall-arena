import {
  AdditiveBlending, BoxGeometry, BufferGeometry, CanvasTexture, Color, DoubleSide, Float32BufferAttribute, Line, LineBasicMaterial,
  Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, PointLight, Scene, Sprite, SpriteMaterial, Texture, Vector3,
} from 'three';
import type { VfxTextures } from '@/core/Assets';

const WHITE = new Color(0xffffff);

interface Tracer { line: Line; mat: LineBasicMaterial; dieAt: number; life: number }
interface Spark { mesh: Sprite; mat: SpriteMaterial; dieAt: number; life: number; vel: Vector3; size: number }
interface Bolt { mesh: Mesh; mat: MeshBasicMaterial; from: Vector3; to: Vector3; dir: Vector3; dist: number; len: number; t: number; speed: number; hitColor: number; sparkCount: number; normal: Vector3 | null; ribbon: boolean; glow: Sprite | null }
interface Decal { mesh: Mesh; mat: MeshBasicMaterial; glow: Mesh; glowMat: MeshBasicMaterial; born: number }
/** 탄흔 최대 개수(넘으면 가장 오래된 것부터 재사용), 유지 시간, 달아오른 자국이 식는 시간 */
/** 탄환 리본의 폭(m)과, 보이는 길이 대비 폭의 상한(텍스처 1024×220의 비율) */
const BOLT_WIDTH = 0.3;
const BOLT_ASPECT = 0.21;
const DECAL_MAX = 48;
const DECAL_LIFE = 9;
const DECAL_HOT = 0.7;
interface Flash { sprite: Sprite; mat: SpriteMaterial; dieAt: number; life: number; grow?: number; base?: number }
interface Mote { sprite: Sprite; mat: SpriteMaterial; vel: Vector3; dieAt: number; life: number; size: number; gravity: number }
interface ImpactAnim { sprite: Sprite; mat: SpriteMaterial; tex: Texture; start: number; life: number }
interface Fade { obj: Object3D; mats: { m: MeshBasicMaterial | import('three').MeshStandardMaterial; }[]; dieAt: number; life: number; onDone?: () => void }

/** 임시 VFX: 트레이서, 히트 스파크, 머즐 플래시, 봇 사망 페이드 */
export class Fx {
  private tracers: Tracer[] = [];
  private sparkList: Spark[] = [];
  private fades: Fade[] = [];
  private bolts: Bolt[] = [];
  /** 탄환 리본을 카메라 쪽으로 돌리기 위한 현재 카메라 위치 (Game이 매 프레임 갱신) */
  readonly camPos = new Vector3();
  private readonly tmpV = new Vector3();
  private readonly tmpV2 = new Vector3();
  private flashes: Flash[] = [];
  private readonly boltGeo = new BoxGeometry(0.05, 0.05, 1);
  /** 텍스처 볼트: Z 방향으로 뻗은 두 장의 교차 평면 */
  private readonly boltPlaneGeo: BufferGeometry;
  private readonly flashTex: CanvasTexture;
  private readonly dotTex: CanvasTexture;
  private vfx: VfxTextures | null = null;
  private impacts: ImpactAnim[] = [];
  private decals: Decal[] = [];
  private decalNext = 0;
  private readonly decalGeo = new PlaneGeometry(1, 1);
  private scorchTex: CanvasTexture | null = null;
  private motes: Mote[] = [];
  readonly muzzleLight = new PointLight(0xffd27a, 0, 8, 2);
  /** 섬광탄 비행 중 빛 — 상시 존재(강도 0)시켜 조명 개수 변화를 막는다 */
  readonly grenadeLight = new PointLight(0x8ec5ff, 0, 4, 2);
  /** 뷰모델 레이어(1)에도 빛이 닿도록 */
  enableViewmodelLayer(): void {
    this.muzzleLight.layers.enable(1);
  }
  private muzzleOff = 0;

  constructor(private readonly scene: Scene) {
    scene.add(this.muzzleLight);
    scene.add(this.grenadeLight);
    this.flashTex = Fx.makeFlashTexture();
    this.dotTex = Fx.makeDotTexture();
    const pg = new PlaneGeometry(1, BOLT_WIDTH);
    pg.rotateY(-Math.PI / 2); // 폭이 Z축을 따라가도록
    this.boltPlaneGeo = pg;
  }

  /** 힉스필드 생성 VFX 텍스처 적용 (없는 항목은 절차적 효과 유지) */
  setTextures(vfx: VfxTextures): void {
    this.vfx = vfx;
  }

  /** 스파크용 부드러운 원형 점 텍스처 (저폴리 구체의 각진 실루엣 방지) */
  private static makeDotTexture(): CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 1, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.8)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new CanvasTexture(c);
  }

  /** 총구 섬광용 방사형 텍스처 (에셋 없이 캔버스로 생성) */
  private static makeFlashTexture(): CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 2, 64, 64, 60);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,230,170,0.9)');
    grad.addColorStop(0.6, 'rgba(255,160,80,0.35)');
    grad.addColorStop(1, 'rgba(255,120,40,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    // 불규칙한 스파이크
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgba(255,240,200,0.8)';
    g.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      g.beginPath();
      g.moveTo(64, 64);
      g.lineTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62);
      g.stroke();
    }
    return new CanvasTexture(c);
  }

  /**
   * 날아가는 탄환 광선: from→to를 speed(m/s)로 이동, 도착 시 스파크.
   * 피해 판정은 즉시(히트스캔)지만 시각적으로는 짧은 광선이 날아간다.
   */
  bolt(from: Vector3, to: Vector3, color: number, hitColor: number, sparkCount: number, speed = 160, normal: Vector3 | null = null): void {
    const dist = from.distanceTo(to);
    const len = Math.min(1.6, Math.max(0.4, dist * 0.5));
    let mesh: Mesh;
    let mat: MeshBasicMaterial;
    if (this.vfx?.bolt) {
      mat = new MeshBasicMaterial({ map: this.vfx.bolt, color, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
      // 한 장의 리본: 매 프레임 카메라를 향해 축 회전(십자 평면은 총구 근처에서 세로 막대로 보임)
      mesh = new Mesh(this.boltPlaneGeo, mat);
      mesh.scale.set(1, 1, 0.05);
    } else {
      mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false });
      mesh = new Mesh(this.boltGeo, mat);
      mesh.scale.set(1, 1, len);
      const glow = new Mesh(this.boltGeo, new MeshBasicMaterial({ color, transparent: true, opacity: 0.22, blending: AdditiveBlending, depthWrite: false }));
      glow.scale.set(3.2, 3.2, 1.08);
      mesh.add(glow);
    }
    mesh.position.copy(from);
    mesh.lookAt(to);
    this.scene.add(mesh);
    const dir = to.clone().sub(from).normalize();
    // 첫 프레임부터 총구 앞에 반 길이쯤 보이도록 시작
    // 리본은 정면·후면에서 보면 납작해지므로, 머리에 둥근 발광점을 따로 둔다(멀어지는 탄은 빛나는 점으로 보인다)
    const ribbon = !!this.vfx?.bolt;
    let glow: Sprite | null = null;
    if (ribbon) {
      glow = new Sprite(new SpriteMaterial({ map: this.dotTex, color: new Color(color).lerp(WHITE, 0.35), transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false }));
      glow.scale.set(0.34, 0.34, 1);
      this.scene.add(glow);
    }
    const b: Bolt = { mesh, mat, from: from.clone(), to: to.clone(), dir, dist, len, t: len * 0.4, speed, hitColor, sparkCount, normal, ribbon, glow };
    this.placeBolt(b);
    this.bolts.push(b);
    if (dist < 1.5) {
      // 아주 가까우면 바로 도착 처리
      this.sparks(to, hitColor, sparkCount);
      if (normal) this.decal(to, normal, color);
    }
  }

  /** 탄흔용 그을음 텍스처: 가운데가 진하고 가장자리가 불규칙하게 옅어지는 검은 얼룩 */
  private static makeScorchTexture(): CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + Math.random();
      const r = i === 0 ? 0 : 5 + Math.random() * 7;
      const x = 32 + Math.cos(a) * r;
      const y = 32 + Math.sin(a) * r;
      const rad = i === 0 ? 20 : 9 + Math.random() * 8;
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, 'rgba(0,0,0,0.75)');
      grad.addColorStop(0.5, 'rgba(0,0,0,0.4)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }
    return new CanvasTexture(c);
  }

  /**
   * 탄흔: 맞은 표면에 그을음 자국을 남기고, 그 위의 달아오른 점이 잠깐 빛나다 식는다.
   * 최대 DECAL_MAX개를 돌려쓰고 DECAL_LIFE초 뒤 사라진다. 판정용 상자 표면 기준이라 장식 모델보다 몇 cm 안쪽일 수 있어 살짝 띄운다.
   */
  decal(point: Vector3, normal: Vector3, color: number): void {
    if (!this.scorchTex) this.scorchTex = Fx.makeScorchTexture();
    let d = this.decals[this.decalNext];
    if (!d) {
      const mat = new MeshBasicMaterial({ map: this.scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      const mesh = new Mesh(this.decalGeo, mat);
      const glowMat = new MeshBasicMaterial({ map: this.dotTex, transparent: true, blending: AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
      const glow = new Mesh(this.decalGeo, glowMat);
      glow.position.z = 0.004;
      mesh.add(glow);
      this.scene.add(mesh);
      d = { mesh, mat, glow, glowMat, born: 0 };
      this.decals[this.decalNext] = d;
    }
    this.decalNext = (this.decalNext + 1) % DECAL_MAX;
    d.mesh.position.copy(point).addScaledVector(normal, 0.03);
    d.mesh.lookAt(this.tmpV.copy(d.mesh.position).add(normal));
    d.mesh.rotateZ(Math.random() * Math.PI * 2);
    const size = 0.2 + Math.random() * 0.1;
    d.mesh.scale.set(size, size, 1);
    d.glow.scale.setScalar(0.55);
    d.glowMat.color.setHex(color).lerp(WHITE, 0.4);
    d.mesh.visible = true;
    d.born = performance.now() / 1000;
  }

  /** 총구 섬광 스프라이트 (짧게 번쩍) */
  muzzleSprite(pos: Vector3, size = 0.26): void {
    const tex = this.vfx?.muzzle ?? this.flashTex;
    const mat = new SpriteMaterial({ map: tex, color: this.vfx?.muzzle ? 0xffffff : 0xffe0b0, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false, rotation: Math.random() * Math.PI * 2 });
    const sprite = new Sprite(mat);
    sprite.position.copy(pos);
    const sc = size * (0.8 + Math.random() * 0.5);
    sprite.scale.set(sc, sc, 1);
    this.scene.add(sprite);
    const life = 0.055;
    this.flashes.push({ sprite, mat, dieAt: performance.now() / 1000 + life, life });
  }

  tracer(from: Vector3, to: Vector3, color: number, life = 0.07): void {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([from.x, from.y, from.z, to.x, to.y, to.z], 3));
    const mat = new LineBasicMaterial({ color, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false });
    const line = new Line(geo, mat);
    this.scene.add(line);
    this.tracers.push({ line, mat, dieAt: performance.now() / 1000 + life, life });
  }

  sparks(point: Vector3, color: number, count = 5): void {
    const now = performance.now() / 1000;
    if (this.vfx?.impact) {
      this.impactSprite(point, color, count >= 5 ? 0.9 : 0.55);
      count = Math.max(1, Math.floor(count / 2));
    }
    for (let i = 0; i < count; i++) {
      const mat = new SpriteMaterial({ map: this.dotTex, color, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false });
      const mesh = new Sprite(mat);
      mesh.position.copy(point);
      const size = 0.07 + Math.random() * 0.09;
      mesh.scale.set(size, size, 1);
      this.scene.add(mesh);
      const vel = new Vector3((Math.random() - 0.5) * 6, Math.random() * 4 + 1, (Math.random() - 0.5) * 6);
      const life = 0.18 + Math.random() * 0.15;
      this.sparkList.push({ mesh, mat, dieAt: now + life, life, vel, size });
    }
  }

  grenadeLightOn(pos: Vector3): void {
    this.grenadeLight.position.copy(pos);
    this.grenadeLight.intensity = 1.5;
  }

  grenadeLightOff(): void {
    this.grenadeLight.intensity = 0;
  }

  /**
   * 셰이더 사전 컴파일: 모든 효과를 보이지 않는 위치에 한 번 생성하고 renderer.compile로 프로그램을 만들어 둔다.
   * (첫 사격/블링크/섬광탄 때 걸리던 컴파일 멈춤 제거)
   */
  warmup(renderer: import('three').WebGLRenderer, camera: import('three').Camera): void {
    const far = new Vector3(0, -200, 0);
    const far2 = new Vector3(5, -200, 0);
    this.bolt(far, far2, 0x8ec5ff, 0xff7a4a, 3);
    this.tracer(far, far2, 0x8ec5ff, 0.3);
    this.sparks(far, 0xffd27a, 2);
    this.muzzleSprite(far);
    this.flashBurst(far);
    this.rocketExplosion(far);
    this.mote(far, 0xffffff, new Vector3(), 0.1, 0.1);
    this.muzzleLight.intensity = 0;
    renderer.compile(this.scene, camera);
    this.clear();
  }

  /** 부드러운 원형 발광 스프라이트 (로켓 탄 등) */
  glowSprite(color: number, size: number): Sprite {
    const mat = new SpriteMaterial({ map: this.dotTex, color, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false });
    const sp = new Sprite(mat);
    sp.scale.set(size, size, 1);
    return sp;
  }

  /** 떠다니는 발광 입자 (로켓 꼬리, 치유 필드) */
  mote(point: Vector3, color: number, vel: Vector3, life: number, size: number, gravity = 0): void {
    const mat = new SpriteMaterial({ map: this.dotTex, color, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false });
    const sprite = new Sprite(mat);
    sprite.position.copy(point);
    sprite.scale.set(size, size, 1);
    this.scene.add(sprite);
    this.motes.push({ sprite, mat, vel: vel.clone(), dieAt: performance.now() / 1000 + life, life, size, gravity });
  }

  /** 펄스 로켓 폭발: 임팩트 시트 + 확장 섬광 + 파편 입자 + 순간 조명 */
  rocketExplosion(point: Vector3): void {
    const now = performance.now() / 1000;
    if (this.vfx?.impact) this.impactSprite(point, 0xbfe6ff, 3.2);
    const tex = this.vfx?.flashBurst ?? this.flashTex;
    const smat = new SpriteMaterial({ map: tex, color: 0xcfe9ff, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false });
    const sp = new Sprite(smat);
    sp.position.copy(point);
    sp.scale.set(1, 1, 1);
    this.scene.add(sp);
    this.flashes.push({ sprite: sp, mat: smat, dieAt: now + 0.28, life: 0.28, grow: 5, base: 1 });
    for (let i = 0; i < 16; i++) {
      const v = new Vector3((Math.random() - 0.5) * 9, Math.random() * 6 + 1, (Math.random() - 0.5) * 9);
      this.mote(point, i % 3 === 0 ? 0xffd27a : 0x9fd8ff, v, 0.35 + Math.random() * 0.3, 0.1 + Math.random() * 0.1, 14);
    }
    this.muzzleLight.position.copy(point);
    this.muzzleLight.color.setHex(0xcfe9ff);
    this.muzzleLight.intensity = 16;
    this.muzzleOff = now + 0.12;
    setTimeout(() => this.muzzleLight.color.setHex(0xffd27a), 160);
  }

  /** 블링크 대시 궤적 */
  dashStreak(from: Vector3, dir: Vector3, range: number): void {
    const to = from.clone().addScaledVector(dir, range);
    for (let i = 0; i < 3; i++) {
      const off = new Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6 - 0.3, (Math.random() - 0.5) * 0.6);
      this.tracer(from.clone().add(off), to.clone().add(off), 0x8ec5ff, 0.25);
    }
    this.sparks(from.clone().addScaledVector(dir, 1), 0x8ec5ff, 6);
  }

  /** 섬광탄 폭발: 큰 흰 구 + 라이트 */
  flashBurst(point: Vector3): void {
    if (this.vfx?.flashBurst) {
      const smat = new SpriteMaterial({ map: this.vfx.flashBurst, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false });
      const sp = new Sprite(smat);
      sp.position.copy(point);
      sp.scale.set(3, 3, 1);
      this.scene.add(sp);
      this.flashes.push({ sprite: sp, mat: smat, dieAt: performance.now() / 1000 + 0.35, life: 0.35, grow: 9 });
    }
    if (!this.vfx?.flashBurst) {
      // 텍스처가 없으면 부드러운 섬광 스프라이트로 대체 (각진 구체 금지)
      const smat = new SpriteMaterial({ map: this.flashTex, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false });
      const sp = new Sprite(smat);
      sp.position.copy(point);
      sp.scale.set(3, 3, 1);
      this.scene.add(sp);
      this.flashes.push({ sprite: sp, mat: smat, dieAt: performance.now() / 1000 + 0.3, life: 0.3, grow: 8 });
    }
    this.sparks(point, 0xffffff, 14);
    this.muzzleLight.position.copy(point);
    this.muzzleLight.color.setHex(0xffffff);
    this.muzzleLight.intensity = 30;
    this.muzzleOff = performance.now() / 1000 + 0.25;
    setTimeout(() => this.muzzleLight.color.setHex(0xffd27a), 300);
  }

  /** 4x4 스프라이트 시트 임팩트 애니메이션 */
  private impactSprite(point: Vector3, color: number, size: number): void {
    if (!this.vfx?.impact) return;
    const tex = this.vfx.impact.clone();
    tex.repeat.set(0.25, 0.25);
    tex.offset.set(0, 0.75);
    tex.needsUpdate = true;
    const mat = new SpriteMaterial({ map: tex, color, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false, rotation: Math.random() * Math.PI * 2 });
    const sprite = new Sprite(mat);
    sprite.position.copy(point);
    sprite.scale.set(size, size, 1);
    this.scene.add(sprite);
    this.impacts.push({ sprite, mat, tex, start: performance.now() / 1000, life: 0.4 });
  }

  /** 머즐 플래시 라이트 (위치는 매 프레임 setMuzzlePosition으로) */
  muzzleFlash(intensity = 6): void {
    this.muzzleLight.intensity = intensity;
    this.muzzleOff = performance.now() / 1000 + 0.05;
  }

  setMuzzlePosition(p: Vector3): void {
    this.muzzleLight.position.copy(p);
  }

  /** 오브젝트를 life초 동안 축소+페이드 후 씬에서 제거 */
  dissolve(obj: Object3D, life = 0.6, onDone?: () => void): void {
    const mats: Fade['mats'] = [];
    obj.traverse((o) => {
      if ((o as Mesh).isMesh) {
        const mesh = o as Mesh;
        const m = (mesh.material as import('three').MeshStandardMaterial).clone();
        m.transparent = true;
        mesh.material = m;
        mats.push({ m });
      }
    });
    this.fades.push({ obj, mats, dieAt: performance.now() / 1000 + life, life, onDone });
  }

  /** 탄환 리본 배치: 꼬리는 총구에서 시작해 앞으로 자라고, 총구 근처에서는 페이드인, 도착 근처에서는 페이드아웃. 평면은 카메라를 향해 축 회전. */
  private placeBolt(b: Bolt): void {
    const head = Math.min(b.dist, b.t + b.len);
    const tail = Math.max(0, head - b.len);
    const vis = Math.max(0.05, head - tail);
    b.mesh.scale.z = vis;
    const mid = (head + tail) * 0.5;
    b.mesh.position.copy(b.from).addScaledVector(b.dir, mid);
    // lookAt의 up을 (dir × toCam)으로 주면 평면 법선(local X)이 카메라 쪽을 향한다
    this.tmpV.copy(this.camPos).sub(b.mesh.position);
    b.mesh.up.crossVectors(b.dir, this.tmpV);
    if (b.ribbon) {
      // 화면에 보이는 길이 = 길이 × sin(진행 방향과 시선 사이 각). 탄이 시선과 거의 나란하면(멀어지거나 다가올 때) 길이는 점처럼 줄어든다.
      // 폭을 그대로 두면 폭이 길이보다 길어져 진행 방향과 직각인 줄로 보이므로, 폭을 보이는 길이에 맞춰 줄인다.
      const sin = b.mesh.up.length() / (this.tmpV.length() || 1);
      b.mesh.scale.y = Math.max(0.09, Math.min(1, (vis * sin * BOLT_ASPECT) / BOLT_WIDTH));
    }
    if (b.mesh.up.lengthSq() < 1e-6) b.mesh.up.set(0, 1, 0);
    b.mesh.lookAt(this.tmpV2.copy(b.mesh.position).add(b.dir));
    const fadeIn = Math.min(1, tail / 0.4 + 0.5);
    const fadeOut = Math.min(1, (b.dist - b.t) / 2 + 0.2);
    b.mat.opacity = fadeIn * fadeOut;
    if (b.glow) {
      b.glow.position.copy(b.from).addScaledVector(b.dir, head);
      b.glow.material.opacity = fadeIn * fadeOut;
    }
  }

  update(dt: number): void {
    const now = performance.now() / 1000;
    if (now > this.muzzleOff) this.muzzleLight.intensity = 0;

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t += b.speed * dt;
      if (b.t >= b.dist) {
        this.scene.remove(b.mesh);
        b.mat.dispose();
        if (b.glow) {
          this.scene.remove(b.glow);
          b.glow.material.dispose();
        }
        for (const c of b.mesh.children) {
          const cm = (c as Mesh).material as MeshBasicMaterial;
          if (cm !== b.mat) cm.dispose();
        }
        this.bolts.splice(i, 1);
        if (b.dist >= 1.5) {
          this.sparks(b.to, b.hitColor, b.sparkCount);
          if (b.normal) this.decal(b.to, b.normal, b.mat.color.getHex());
        }
        continue;
      }
      this.placeBolt(b);
    }
    for (const d of this.decals) {
      if (!d || !d.mesh.visible) continue;
      const age = now - d.born;
      if (age >= DECAL_LIFE) {
        d.mesh.visible = false;
        continue;
      }
      d.mat.opacity = Math.min(1, (DECAL_LIFE - age) / 2.5);
      const hot = Math.max(0, 1 - age / DECAL_HOT);
      d.glow.visible = hot > 0;
      d.glowMat.opacity = hot * hot * 2.2;
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const r = (f.dieAt - now) / f.life;
      if (r <= 0) {
        this.scene.remove(f.sprite);
        f.mat.dispose();
        this.flashes.splice(i, 1);
      } else {
        f.mat.opacity = r;
        if (f.grow) {
          const sc = (f.base ?? 3) + (1 - r) * f.grow;
          f.sprite.scale.set(sc, sc, 1);
        }
      }
    }
    for (let i = this.motes.length - 1; i >= 0; i--) {
      const m = this.motes[i];
      const r = (m.dieAt - now) / m.life;
      if (r <= 0) {
        this.scene.remove(m.sprite);
        m.mat.dispose();
        this.motes.splice(i, 1);
        continue;
      }
      m.vel.y -= m.gravity * dt;
      m.sprite.position.addScaledVector(m.vel, dt);
      m.mat.opacity = r;
      const sz = m.size * (0.35 + 0.65 * r);
      m.sprite.scale.set(sz, sz, 1);
    }
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i];
      const t = (now - im.start) / im.life;
      if (t >= 1) {
        this.scene.remove(im.sprite);
        im.mat.dispose();
        im.tex.dispose();
        this.impacts.splice(i, 1);
        continue;
      }
      const frame = Math.min(15, Math.floor(t * 16));
      im.tex.offset.set((frame % 4) * 0.25, 0.75 - Math.floor(frame / 4) * 0.25);
      im.mat.opacity = t > 0.7 ? (1 - t) / 0.3 : 1;
    }

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      const r = (t.dieAt - now) / t.life;
      if (r <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        t.mat.dispose();
        this.tracers.splice(i, 1);
      } else t.mat.opacity = 0.9 * r;
    }
    for (let i = this.sparkList.length - 1; i >= 0; i--) {
      const s = this.sparkList[i];
      const r = (s.dieAt - now) / s.life;
      if (r <= 0) {
        this.scene.remove(s.mesh);
        s.mat.dispose();
        this.sparkList.splice(i, 1);
        continue;
      }
      s.vel.y -= 20 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mat.opacity = r;
      const sz = s.size * (0.4 + 0.6 * r);
      s.mesh.scale.set(sz, sz, 1);
    }
    for (let i = this.fades.length - 1; i >= 0; i--) {
      const f = this.fades[i];
      const r = (f.dieAt - now) / f.life;
      if (r <= 0) {
        this.scene.remove(f.obj);
        for (const { m } of f.mats) m.dispose();
        this.fades.splice(i, 1);
        f.onDone?.();
        continue;
      }
      for (const { m } of f.mats) {
        m.opacity = r;
        if ('emissive' in m) (m as import('three').MeshStandardMaterial).emissive = new Color(0xff5a2f).multiplyScalar(1 - r);
      }
      f.obj.scale.setScalar(0.4 + 0.6 * r);
    }
  }

  clear(): void {
    for (const b of this.bolts) {
      this.scene.remove(b.mesh);
      if (b.glow) this.scene.remove(b.glow);
    }
    for (const f of this.flashes) this.scene.remove(f.sprite);
    for (const im of this.impacts) this.scene.remove(im.sprite);
    for (const m of this.motes) this.scene.remove(m.sprite);
    for (const d of this.decals) if (d) d.mesh.visible = false;
    this.motes = [];
    this.bolts = [];
    this.flashes = [];
    this.impacts = [];
    for (const t of this.tracers) this.scene.remove(t.line);
    for (const s of this.sparkList) this.scene.remove(s.mesh);
    for (const f of this.fades) this.scene.remove(f.obj);
    this.tracers = [];
    this.sparkList = [];
    this.fades = [];
  }
}
