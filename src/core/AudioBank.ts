import type { Camera, Vector3 } from 'three';

/**
 * 생성된 효과음 파일(WebAudio 버퍼) 재생기.
 * - manifest(assets/sfx/manifest.json)에 있는 클립만 로드, 없으면 Sfx가 합성음으로 폴백
 * - manifest 값은 파일명, { file, from, to }(초 단위 구간만 잘라 씀), 또는 그 배열(재생할 때마다 무작위 변주)
 * - 3D 위치 재생: PannerNode(HRTF 대신 equalpower, 거리 감쇠)
 */
export type SfxName =
  | 'shoot' | 'shoot_far' | 'hit' | 'headshot' | 'kill' | 'hurt' | 'reload' | 'empty' | 'jump' | 'dash' | 'throw'
  | 'flashbang' | 'ult_activate' | 'ult_ready' | 'heal' | 'wave_start' | 'wave_clear' | 'death' | 'footstep' | 'bot_death'
  | 'land' | 'reload_out' | 'reload_in';

/** manifest 항목: 파일 전체, 또는 [from, to] 구간(생성 클립은 앞뒤 무음과 여러 소리가 섞여 있어 필요한 소리만 자른다) */
type ClipSpec = string | { file: string; from?: number; to?: number };

interface Clip {
  buf: AudioBuffer;
  /** 정규화 게인 (RMS 기준) × 클립별 기준 음량 */
  gain: number;
}

/** 클립별 기준 음량 (정규화 후 곱해지는 배율). 1 = 기준 */
const CLIP_LEVEL: Partial<Record<SfxName, number>> = {
  shoot: 0.7, shoot_far: 0.45, hit: 0.45, headshot: 0.6, kill: 0.6, hurt: 0.6, reload: 0.5, empty: 0.4, jump: 0.35,
  dash: 0.7, throw: 0.45, flashbang: 0.9, ult_activate: 0.9, ult_ready: 0.6, heal: 0.55, wave_start: 0.7, wave_clear: 0.7,
  death: 0.8, footstep: 0.3, bot_death: 0.6, land: 0.45, reload_out: 0.4, reload_in: 0.5,
};

export class AudioBank {
  /** 이름별 클립. 여러 개면 변주로 쓴다 */
  private clips = new Map<SfxName, Clip[]>();
  /** 직전에 재생한 변주 번호 (같은 소리 연속 재생 방지) */
  private lastVariant = new Map<SfxName, number>();
  private readonly bus: GainNode;
  private listenerCam: Camera | null = null;
  /** 같은 클립 과다 중첩 방지 */
  private lastPlay = new Map<SfxName, number>();

  constructor(private readonly ctx: AudioContext, master: GainNode) {
    // 뱅크 전용 버스: 컴프레서로 피크를 눌러 시끄럽게 튀지 않게
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(comp).connect(master);
  }

  static stats(buf: AudioBuffer): { rms: number; peak: number } {
    const data = buf.getChannelData(0);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    return { rms: Math.sqrt(sum / Math.max(1, data.length)), peak };
  }

  /** 각 클립의 실제 출력 레벨(dBFS, 마스터 포함) — 가청성 점검용 */
  report(masterGain: number): Record<string, { rmsDb: number; peakDb: number }> {
    const out: Record<string, { rmsDb: number; peakDb: number }> = {};
    const db = (v: number): number => Math.round(20 * Math.log10(Math.max(1e-6, v)) * 10) / 10;
    for (const [name, list] of this.clips) {
      list.forEach((c, i) => {
        const st = AudioBank.stats(c.buf);
        const g = c.gain * masterGain;
        out[list.length > 1 ? `${name}#${i + 1}` : name] = { rmsDb: db(st.rms * g), peakDb: db(st.peak * g) };
      });
    }
    return out;
  }

  /** RMS 기반 정규화 게인 계산: 모든 클립이 비슷한 체감 음량이 되도록 */
  private static normalizeGain(buf: AudioBuffer): number {
    const { rms, peak } = AudioBank.stats(buf);
    const targetRms = 0.2; // 정규화 목표 RMS (마스터·클립 레벨 적용 전)
    let g = rms > 1e-5 ? targetRms / rms : 1;
    // 피크가 0.95를 넘지 않도록 제한
    if (peak * g > 0.95) g = 0.95 / peak;
    // 생성 클립은 음량 편차가 커서(거의 무음~풀스케일) 게인 범위를 넓게 둔다
    return Math.min(8, g);
  }

  /** 클릭 방지용 짧은 페이드 인/아웃을 버퍼에 직접 적용 */
  private static fadeEdges(buf: AudioBuffer): void {
    const n = Math.min(Math.floor(buf.sampleRate * 0.004), 256);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n && i < d.length; i++) {
        const k = i / n;
        d[i] *= k;
        d[d.length - 1 - i] *= k;
      }
    }
  }

  has(name: SfxName): boolean {
    return this.clips.has(name);
  }

  /** 클립 길이(초). 변주가 여러 개면 각각 */
  durations(name: SfxName): number[] {
    return (this.clips.get(name) ?? []).map((c) => c.buf.duration);
  }

  /**
   * [from, to] 구간만 잘라 새 버퍼로 만든다. 구간 안에서 첫 소리가 나는 지점까지 앞쪽 무음도 걷어내
   * 재생 시점과 소리가 어긋나지 않게 하고(디코더마다 mp3 앞 여백이 조금씩 다르다), 잘린 꼬리는 30ms 동안 줄인다.
   */
  private cut(buf: AudioBuffer, from = 0, to = buf.duration): AudioBuffer {
    const sr = buf.sampleRate;
    let a = Math.max(0, Math.floor(from * sr));
    const b = Math.min(buf.length, Math.ceil(to * sr));
    const d = buf.getChannelData(0);
    let peak = 0;
    for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(d[i]));
    let on = a;
    while (on < b && Math.abs(d[on]) < peak * 0.1) on++;
    a = Math.max(a, on - Math.floor(sr * 0.003));
    const n = Math.max(1, b - a);
    const out = this.ctx.createBuffer(buf.numberOfChannels, n, sr);
    const fade = Math.min(n, Math.floor(sr * 0.03));
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const o = out.getChannelData(c);
      o.set(buf.getChannelData(c).subarray(a, b));
      for (let i = 0; i < fade; i++) o[n - 1 - i] *= i / fade;
    }
    return out;
  }

  /** 재생할 클립 고르기: 변주가 여러 개면 직전과 다른 것을 무작위로 */
  private pick(name: SfxName): Clip | null {
    const list = this.clips.get(name);
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const last = this.lastVariant.get(name) ?? -1;
    let i = Math.floor(Math.random() * (list.length - 1));
    if (i >= last && last >= 0) i++;
    this.lastVariant.set(name, i);
    return list[i];
  }

  setListener(cam: Camera): void {
    this.listenerCam = cam;
  }

  async load(baseUrl: string): Promise<number> {
    // Same cache-busting stamp as the models (Assets.ASSET_VER): clips are re-cut under the same file names
    const ver = '?v=' + __BUILD__.replace(/\D/g, '');
    let manifest: Partial<Record<SfxName, ClipSpec | ClipSpec[]>>;
    try {
      const r = await fetch(`${baseUrl}sfx/manifest.json${ver}`);
      if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) return 0;
      manifest = (await r.json()) as Partial<Record<SfxName, ClipSpec | ClipSpec[]>>;
    } catch {
      return 0;
    }
    const entries: [SfxName, ClipSpec, number][] = [];
    for (const [name, v] of Object.entries(manifest) as [SfxName, ClipSpec | ClipSpec[]][]) {
      (Array.isArray(v) ? v : [v]).forEach((spec, i) => entries.push([name, spec, i]));
    }
    const loaded = new Map<SfxName, (Clip | undefined)[]>();
    await Promise.all(
      entries.map(async ([name, spec, order]) => {
        try {
          const file = typeof spec === 'string' ? spec : spec.file;
          const res = await fetch(`${baseUrl}sfx/${file}${ver}`);
          if (!res.ok) return;
          let buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
          if (typeof spec !== 'string') buf = this.cut(buf, spec.from, spec.to);
          AudioBank.fadeEdges(buf);
          const stats = AudioBank.stats(buf);
          // 구간을 지정해 잘라 쓰는 클립은 짧은 타격음이라 평균(RMS)이 낮게 나오므로 피크만 본다
          if (stats.peak < 0.12 || (typeof spec === 'string' && stats.rms < 0.02)) {
            // 사실상 무음인 생성 클립은 제외 → 합성음 폴백 (안 들리는 효과음 방지)
            console.warn(`[AudioBank] '${name}' 너무 조용해서 제외 (rms ${stats.rms.toFixed(3)}, peak ${stats.peak.toFixed(2)})`);
            return;
          }
          const list = loaded.get(name) ?? [];
          list[order] = { buf, gain: AudioBank.normalizeGain(buf) * (CLIP_LEVEL[name] ?? 0.6) };
          loaded.set(name, list);
        } catch (e) {
          console.warn('[AudioBank] decode failed', name, e);
        }
      }),
    );
    for (const [name, list] of loaded) {
      const ok = list.filter((c): c is Clip => !!c);
      if (ok.length) this.clips.set(name, ok);
    }
    return this.clips.size;
  }

  /** 2D 재생 (UI/플레이어 자신). rate로 피치 변주 */
  play(name: SfxName, volume = 1, rate = 1, minInterval = 0.02): boolean {
    const clip = this.pick(name);
    if (!clip) return false;
    const t = this.ctx.currentTime;
    if (t - (this.lastPlay.get(name) ?? -1) < minInterval) return true;
    this.lastPlay.set(name, t);
    const src = this.ctx.createBufferSource();
    src.buffer = clip.buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume * clip.gain;
    src.connect(g).connect(this.bus);
    src.start();
    return true;
  }

  /** 3D 위치 재생 (봇 총성/발소리). 리스너 = 카메라 */
  playAt(name: SfxName, pos: Vector3, volume = 1, rate = 1, refDistance = 6, maxDistance = 60): boolean {
    if (!this.clips.has(name)) return false;
    const cam = this.listenerCam;
    if (!cam) return this.play(name, volume, rate);
    this.updateListener(cam);
    const clip = this.pick(name);
    if (!clip) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = clip.buf;
    src.playbackRate.value = rate;
    const panner = this.ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = 1.2;
    panner.positionX.value = pos.x;
    panner.positionY.value = pos.y;
    panner.positionZ.value = pos.z;
    const g = this.ctx.createGain();
    g.gain.value = volume * clip.gain;
    src.connect(panner).connect(g).connect(this.bus);
    src.start();
    return true;
  }

  /** 외부(합성음 3D 재생)에서 리스너 갱신용 */
  updateListenerFrom(cam: Camera): void {
    this.updateListener(cam);
  }

  private updateListener(cam: Camera): void {
    const l = this.ctx.listener;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    // 위치
    const px = e[12];
    const py = e[13];
    const pz = e[14];
    // 전방(-Z), 상방(+Y) 월드 벡터
    const fx = -e[8];
    const fy = -e[9];
    const fz = -e[10];
    const ux = e[4];
    const uy = e[5];
    const uz = e[6];
    if (l.positionX) {
      l.positionX.value = px; l.positionY.value = py; l.positionZ.value = pz;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
    } else {
      // 구형 브라우저
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(px, py, pz);
      (l as unknown as { setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void }).setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }
}
