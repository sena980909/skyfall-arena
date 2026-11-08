import {
  AdditiveBlending, BoxGeometry, BufferGeometry, CanvasTexture, Color, DoubleSide, Float32BufferAttribute, Line, LineBasicMaterial,
  Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, PointLight, Scene, Sprite, SpriteMaterial, Texture, Vector3,
} from 'three';
import type { VfxTextures } from '@/core/Assets';

interface Tracer { line: Line; mat: LineBasicMaterial; dieAt: number; life: number }
interface Spark { mesh: Sprite; mat: SpriteMaterial; dieAt: number; life: number; vel: Vector3; size: number }
interface Bolt { mesh: Mesh; mat: MeshBasicMaterial; from: Vector3; to: Vector3; dist: number; t: number; speed: number; hitColor: number; sparkCount: number }
interface Flash { sprite: Sprite; mat: SpriteMaterial; dieAt: number; life: number; grow?: number }
interface ImpactAnim { sprite: Sprite; mat: SpriteMaterial; tex: Texture; start: number; life: number }
interface Fade { obj: Object3D; mats: { m: MeshBasicMaterial | import('three').MeshStandardMaterial; }[]; dieAt: number; life: number; onDone?: () => void }

/** 임시 VFX: 트레이서, 히트 스파크, 머즐 플래시, 봇 사망 페이드 */
export class Fx {
  private tracers: Tracer[] = [];
  private sparkList: Spark[] = [];
  private fades: Fade[] = [];
  private bolts: Bolt[] = [];
  private flashes: Flash[] = [];
  private readonly boltGeo = new BoxGeometry(0.05, 0.05, 1);
  /** 텍스처 볼트: Z 방향으로 뻗은 두 장의 교차 평면 */
  private readonly boltPlaneGeo: BufferGeometry;
  private readonly flashTex: CanvasTexture;
  private readonly dotTex: CanvasTexture;
  private vfx: VfxTextures | null = null;
  private impacts: ImpactAnim[] = [];
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
    const pg = new PlaneGeometry(1, 0.22);
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
  bolt(from: Vector3, to: Vector3, color: number, hitColor: number, sparkCount: number, speed = 160): void {
    const dist = from.distanceTo(to);
    const len = Math.min(1.6, Math.max(0.4, dist * 0.5));
    let mesh: Mesh;
    let mat: MeshBasicMaterial;
    if (this.vfx?.bolt) {
      mat = new MeshBasicMaterial({ map: this.vfx.bolt, color, transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
      mesh = new Mesh(this.boltPlaneGeo, mat);
      const cross = new Mesh(this.boltPlaneGeo, mat);
      cross.rotation.z = Math.PI / 2;
      mesh.add(cross);
      mesh.scale.set(1, 1, len);
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
    this.bolts.push({ mesh, mat, from: from.clone(), to: to.clone(), dist, t: 0, speed, hitColor, sparkCount });
    if (dist < 1.5) {
      // 아주 가까우면 바로 도착 처리
      this.sparks(to, hitColor, sparkCount);
    }
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
    this.muzzleLight.intensity = 0;
    renderer.compile(this.scene, camera);
    this.clear();
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

  update(dt: number): void {
    const now = performance.now() / 1000;
    if (now > this.muzzleOff) this.muzzleLight.intensity = 0;

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t += b.speed * dt;
      if (b.t >= b.dist) {
        this.scene.remove(b.mesh);
        b.mat.dispose();
        for (const c of b.mesh.children) {
          const cm = (c as Mesh).material as MeshBasicMaterial;
          if (cm !== b.mat) cm.dispose();
        }
        this.bolts.splice(i, 1);
        if (b.dist >= 1.5) this.sparks(b.to, b.hitColor, b.sparkCount);
        continue;
      }
      const len = b.mesh.scale.z;
      const head = Math.min(b.dist, b.t + len * 0.5);
      const k = (head - len * 0.5) / b.dist;
      b.mesh.position.lerpVectors(b.from, b.to, Math.max(0, k));
      // 끝에 가까워지면 페이드
      b.mat.opacity = 0.95 * Math.min(1, (b.dist - b.t) / 2 + 0.2);
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
          const sc = 3 + (1 - r) * f.grow;
          f.sprite.scale.set(sc, sc, 1);
        }
      }
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
    for (const b of this.bolts) this.scene.remove(b.mesh);
    for (const f of this.flashes) this.scene.remove(f.sprite);
    for (const im of this.impacts) this.scene.remove(im.sprite);
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
