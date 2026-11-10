/**
 * 레이어드 신디사이즈 효과음 엔진.
 * 참고 성격: 하이퍼 FPS 돌격형 영웅(펄스 라이플)의 사운드 — 타이트한 타격 트랜지언트 + 낮은 몸통 + 약한 전자음 날.
 * 모든 소리는 여러 레이어(클릭/노이즈/톤/서브)와 엔벨로프·필터·소프트클립·짧은 잔향으로 만든다.
 * 원본 게임 오디오는 사용하지 않는다(저작권). 특징만 합성으로 재현한다.
 */
export class SynthSfx {
  private readonly noiseBuf: AudioBuffer;
  private readonly clip: WaveShaperNode;
  private readonly bus: GainNode;
  private readonly reverb: ConvolverNode;
  private readonly reverbSend: GainNode;

  constructor(private readonly ctx: AudioContext, out: AudioNode) {
    // 노이즈 버퍼 (2초)
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // 버스 → 소프트클립 → out ; 버스 → 잔향 → out
    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    this.clip = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
    }
    this.clip.curve = curve;
    this.clip.oversample = '2x';
    this.bus.connect(this.clip).connect(out);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(0.32, 2.8);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.14;
    this.bus.connect(this.reverbSend).connect(this.reverb).connect(out);
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        lp += (w - lp) * 0.35; // 고역을 죽인 잔향
        ch[i] = lp * Math.pow(1 - i / n, decay);
      }
    }
    return buf;
  }

  /** 3D 재생용 패너 생성 (dst로 사용) */
  panner(pos: { x: number; y: number; z: number }, ref = 6, max = 60): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.maxDistance = max;
    p.rolloffFactor = 1.2;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    p.connect(this.bus);
    return p;
  }

  get destination(): AudioNode {
    return this.bus;
  }

  // ---------- 기본 레이어 ----------

  /** 톤 레이어: f0→f1 지수 스윕, 어택/디케이 엔벨로프, 선택 필터 */
  private tone(dst: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, opts: { attack?: number; lp?: [number, number]; hp?: number; detune?: number; curve?: 'exp' | 'lin' } = {}): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    if (opts.detune) o.detune.value = opts.detune;
    let node: AudioNode = o;
    if (opts.lp) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 0.8;
      f.frequency.setValueAtTime(opts.lp[0], t);
      f.frequency.exponentialRampToValueAtTime(Math.max(40, opts.lp[1]), t + dur);
      node.connect(f);
      node = f;
    }
    if (opts.hp) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = opts.hp;
      node.connect(f);
      node = f;
    }
    const g = this.ctx.createGain();
    const a = opts.attack ?? 0.002;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + a);
    if (opts.curve === 'lin') g.gain.linearRampToValueAtTime(0.0001, t + dur);
    else g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g).connect(dst);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** 노이즈 레이어: 밴드패스/로우패스/하이패스 + 엔벨로프 (필터 주파수 스윕 가능) */
  private noise(dst: AudioNode, t: number, dur: number, gain: number, opts: { attack?: number; bp?: [number, number, number?]; lp?: [number, number]; hp?: number; curve?: 'exp' | 'lin' } = {}): void {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    let node: AudioNode = s;
    if (opts.bp) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = opts.bp[2] ?? 1.2;
      f.frequency.setValueAtTime(opts.bp[0], t);
      f.frequency.exponentialRampToValueAtTime(Math.max(40, opts.bp[1]), t + dur);
      node.connect(f);
      node = f;
    }
    if (opts.lp) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(opts.lp[0], t);
      f.frequency.exponentialRampToValueAtTime(Math.max(40, opts.lp[1]), t + dur);
      node.connect(f);
      node = f;
    }
    if (opts.hp) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = opts.hp;
      node.connect(f);
      node = f;
    }
    const g = this.ctx.createGain();
    const a = opts.attack ?? 0.001;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + a);
    if (opts.curve === 'lin') g.gain.linearRampToValueAtTime(0.0001, t + dur);
    else g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g).connect(dst);
    s.start(t);
    s.stop(t + dur + 0.05);
  }

  /** 금속성 클릭: 짧은 노이즈 + 공진 톤 */
  private click(dst: AudioNode, t: number, gain: number, freq = 2600, dur = 0.012): void {
    this.noise(dst, t, dur, gain, { bp: [freq, freq, 3] });
    this.tone(dst, t, 'triangle', freq * 0.6, freq * 0.5, dur * 1.6, gain * 0.5);
  }

  // ---------- 레시피 ----------

  /** 펄스 라이플 1발: 타이트한 타격 + 낮은 몸통 + 전자음 날. rate = 피치 변주 */
  pulseShot(dst: AudioNode = this.bus, rate = 1, vol = 1): void {
    const t = this.ctx.currentTime;
    // 1) 트랜지언트 클릭 (방아쇠/기계 타격)
    this.noise(dst, t, 0.014, 0.9 * vol, { hp: 2500 });
    // 2) 노이즈 몸통 (소음기 단 총성 느낌): 중역 밴드, 빠른 디케이
    this.noise(dst, t, 0.09, 0.75 * vol, { bp: [1400 * rate, 600 * rate, 0.9], attack: 0.002 });
    // 3) 전자 펄스 톤: 짧은 하강 스윕 (미래 무기 날)
    this.tone(dst, t, 'square', 820 * rate, 240 * rate, 0.06, 0.28 * vol, { lp: [3000, 900] });
    // 4) 서브 몸통: 둔탁한 저음
    this.tone(dst, t, 'sine', 150 * rate, 62 * rate, 0.13, 0.9 * vol, { attack: 0.003 });
    // 5) 짧은 꼬리
    this.noise(dst, t + 0.03, 0.16, 0.12 * vol, { lp: [1400, 300], attack: 0.01, curve: 'lin' });
  }

  /** 멀리서 들리는 펄스 라이플 (봇): 고역 깎임, 몸통 위주 */
  pulseShotFar(dst: AudioNode, rate = 1, vol = 1): void {
    const t = this.ctx.currentTime;
    this.noise(dst, t, 0.08, 0.5 * vol, { bp: [700 * rate, 350 * rate, 0.8] });
    this.tone(dst, t, 'sine', 140 * rate, 60 * rate, 0.14, 0.8 * vol, { attack: 0.004 });
    this.tone(dst, t, 'square', 600 * rate, 220 * rate, 0.05, 0.1 * vol, { lp: [1200, 500] });
  }

  /** 펄스 로켓 발사: 둔탁한 '퉁' + 분사 휙 + 지글거림 */
  rocketFire(): void {
    const t = this.ctx.currentTime;
    this.tone(this.bus, t, 'sine', 140, 55, 0.2, 0.9, { attack: 0.003 });
    this.noise(this.bus, t, 0.012, 0.6, { hp: 2000 });
    this.noise(this.bus, t, 0.34, 0.38, { bp: [900, 2800, 1.1], attack: 0.008, curve: 'lin' });
    this.noise(this.bus, t + 0.02, 0.26, 0.1, { hp: 3500, curve: 'lin' });
    this.tone(this.bus, t, 'square', 320, 760, 0.12, 0.07, { lp: [1600, 900] });
  }

  /** 펄스 로켓 폭발 (3D): 크랙 + 붐 + 서브 + 파편 클릭 */
  rocketExplode(dst: AudioNode = this.bus, vol = 1): void {
    const t = this.ctx.currentTime;
    this.noise(dst, t, 0.02, 0.9 * vol, { hp: 1500 });
    this.noise(dst, t, 0.42, 0.75 * vol, { lp: [1100, 110], attack: 0.003 });
    this.tone(dst, t, 'sine', 115, 34, 0.5, 1.0 * vol, { attack: 0.004 });
    for (const dt of [0.06, 0.11, 0.19]) this.click(dst, t + dt, 0.12 * vol, 2400 + Math.random() * 1500, 0.008);
  }

  /** 치유 필드 설치: 착지 '톡' + 따뜻한 화음 + 상승 반짝임 */
  healField(): void {
    const t = this.ctx.currentTime;
    this.click(this.bus, t, 0.35, 1800, 0.012);
    this.tone(this.bus, t, 'sine', 210, 120, 0.12, 0.45, { attack: 0.003 });
    for (const f of [392, 494, 587]) this.tone(this.bus, t + 0.05, 'triangle', f, f, 0.9, 0.07, { attack: 0.08, lp: [1600, 700], curve: 'lin' });
    for (const [i, f] of [784, 988, 1175, 1568].entries()) this.tone(this.bus, t + 0.08 + i * 0.06, 'sine', f, f, 0.25, 0.12, { attack: 0.005 });
  }

  /** 명중 틱 */
  hit(): void {
    const t = this.ctx.currentTime;
    this.tone(this.bus, t, 'sine', 1900, 1500, 0.05, 0.35);
    this.noise(this.bus, t, 0.012, 0.25, { hp: 4000 });
  }

  /** 헤드샷 '딩' (2배음 포함, 살짝 상승) */
  headshot(): void {
    const t = this.ctx.currentTime;
    this.tone(this.bus, t, 'sine', 2300, 2450, 0.16, 0.42, { attack: 0.001 });
    this.tone(this.bus, t, 'sine', 4600, 4900, 0.09, 0.14, { attack: 0.001 });
    this.noise(this.bus, t, 0.01, 0.2, { hp: 5000 });
  }

  /** 처치 확인: 둔탁한 '툭' + 짧은 쉿 + 미세 틱 */
  kill(): void {
    const t = this.ctx.currentTime;
    this.tone(this.bus, t, 'sine', 170, 85, 0.16, 0.9, { attack: 0.003 });
    this.noise(this.bus, t, 0.1, 0.35, { lp: [2200, 400] });
    this.tone(this.bus, t + 0.02, 'triangle', 3000, 2600, 0.05, 0.12);
  }

  /** 피격: 둔탁한 충격 + 보호막 지직 */
  hurt(): void {
    const t = this.ctx.currentTime;
    this.tone(this.bus, t, 'sine', 130, 70, 0.14, 0.8, { attack: 0.003 });
    this.noise(this.bus, t, 0.12, 0.3, { lp: [1800, 300] });
    this.noise(this.bus, t + 0.01, 0.07, 0.15, { bp: [2400, 1200, 2] });
  }

  /** 재장전 1단계: 탄창 멈치 클릭 두 번 → 탄창이 빠지는 슬라이드 */
  reloadOut(vol = 1): void {
    const t = this.ctx.currentTime;
    this.click(this.bus, t, 0.5 * vol, 2200);
    this.click(this.bus, t + 0.05, 0.3 * vol, 1600);
    this.noise(this.bus, t + 0.06, 0.24, 0.12 * vol, { bp: [500, 1400, 1.5], attack: 0.03, curve: 'lin' });
  }

  /** 재장전 2단계: 새 탄창이 끝까지 들어가 걸리는 소리 */
  reloadIn(vol = 1): void {
    const t = this.ctx.currentTime;
    this.click(this.bus, t, 0.55 * vol, 1900, 0.016);
    this.tone(this.bus, t, 'sine', 180, 120, 0.08, 0.3 * vol);
  }

  /** 재장전 3단계: 왼손이 총열 덮개로 돌아오며 '척', 에너지 셀 충전 힌트 */
  reloadReady(): void {
    const t = this.ctx.currentTime;
    this.click(this.bus, t, 0.45, 3200, 0.01);
    this.click(this.bus, t + 0.09, 0.55, 2700, 0.014);
    this.tone(this.bus, t + 0.09, 'square', 420, 760, 0.18, 0.06, { lp: [1800, 600], attack: 0.02 });
  }

  empty(): void {
    const t = this.ctx.currentTime;
    this.click(this.bus, t, 0.35, 1800, 0.008);
  }

  jump(): void {
    const t = this.ctx.currentTime;
    this.noise(this.bus, t, 0.12, 0.2, { lp: [900, 300], attack: 0.01 });
  }

  /** 발소리: 금속 바닥 — 저음 쿵 + 중역 노이즈 + 미세 금속 틱 */
  footstep(dst: AudioNode = this.bus, vol = 1, rate = 1): void {
    const t = this.ctx.currentTime;
    this.tone(dst, t, 'sine', 110 * rate, 55 * rate, 0.07, 0.55 * vol, { attack: 0.003 });
    this.noise(dst, t, 0.05, 0.35 * vol, { bp: [600 * rate, 350 * rate, 1] });
    this.click(dst, t + 0.004, 0.08 * vol, 3400 * rate, 0.006);
  }

  /** 블링크 대시: 공기 스윕 + 상승 톤 + 반짝임 */
  dash(): void {
    const t = this.ctx.currentTime;
    this.noise(this.bus, t, 0.26, 0.45, { bp: [500, 5200, 1.2], attack: 0.02, curve: 'lin' });
    this.tone(this.bus, t, 'sine', 520, 1900, 0.18, 0.2, { attack: 0.01 });
    for (let i = 0; i < 3; i++) this.tone(this.bus, t + 0.05 + i * 0.045, 'sine', 3200 + i * 900, 3600 + i * 900, 0.05, 0.08);
    this.tone(this.bus, t, 'sine', 120, 60, 0.12, 0.4);
  }

  /** 투척: 짧은 휙 + 무장 비프 */
  throwItem(): void {
    const t = this.ctx.currentTime;
    this.noise(this.bus, t, 0.22, 0.3, { bp: [300, 1100, 1], attack: 0.02, curve: 'lin' });
    this.tone(this.bus, t + 0.05, 'square', 1800, 1800, 0.04, 0.08, { lp: [4000, 4000] });
  }

  /** 섬광탄: 크랙 + 깊은 붐 + 길게 남는 이명 */
  flashbang(): void {
    const t = this.ctx.currentTime;
    this.noise(this.bus, t, 0.02, 1.0, { hp: 1200 });
    this.noise(this.bus, t, 0.35, 0.9, { lp: [600, 120], attack: 0.003 });
    this.tone(this.bus, t, 'sine', 130, 32, 0.5, 1.0, { attack: 0.004 });
    this.tone(this.bus, t + 0.05, 'sine', 3400, 3400, 1.3, 0.16, { attack: 0.02 });
    this.tone(this.bus, t + 0.05, 'sine', 3440, 3440, 1.3, 0.12, { attack: 0.02 });
  }

  /** 궁 발동: 상승 스윕 → 록온 더블 비프 → 베이스 히트 + 반짝임 */
  ultActivate(): void {
    const t = this.ctx.currentTime;
    this.tone(this.bus, t, 'sawtooth', 150, 900, 0.7, 0.22, { attack: 0.05, lp: [600, 4000], curve: 'lin' });
    this.noise(this.bus, t, 0.7, 0.12, { bp: [400, 3000, 1], attack: 0.1, curve: 'lin' });
    this.tone(this.bus, t + 0.62, 'square', 1200, 1200, 0.06, 0.14, { lp: [3000, 3000] });
    this.tone(this.bus, t + 0.72, 'square', 1200, 1200, 0.08, 0.16, { lp: [3000, 3000] });
    this.tone(this.bus, t + 0.8, 'sine', 220, 48, 0.45, 1.0, { attack: 0.004 });
    this.noise(this.bus, t + 0.8, 0.2, 0.5, { lp: [800, 150] });
    this.tone(this.bus, t + 0.82, 'sine', 1760, 1760, 0.8, 0.07, { attack: 0.02 });
    this.tone(this.bus, t + 0.82, 'sine', 1766, 1766, 0.8, 0.07, { attack: 0.02 });
  }

  /** 궁 준비 차임: 두 개의 벨 음 */
  ultReady(): void {
    const t = this.ctx.currentTime;
    for (const [i, f] of [880, 1174.66].entries()) {
      this.tone(this.bus, t + i * 0.16, 'sine', f, f, 0.35, 0.28, { attack: 0.004 });
      this.tone(this.bus, t + i * 0.16, 'sine', f * 2, f * 2, 0.18, 0.08, { attack: 0.004 });
    }
  }

  /** 회복: 따뜻한 화음 허밍 + 상승 반짝임 */
  heal(): void {
    const t = this.ctx.currentTime;
    for (const f of [262, 330, 392]) this.tone(this.bus, t, 'triangle', f, f, 0.5, 0.08, { attack: 0.05, lp: [1200, 600], curve: 'lin' });
    for (const [i, f] of [523, 659, 784, 1047].entries()) this.tone(this.bus, t + 0.04 + i * 0.07, 'sine', f, f, 0.22, 0.16, { attack: 0.005 });
  }

  /** 웨이브 시작: 간단한 두 음 알림 (띵-띵) + 가벼운 저음 */
  waveStart(): void {
    const t = this.ctx.currentTime;
    this.tone(this.bus, t, 'sine', 660, 660, 0.18, 0.3, { attack: 0.004 });
    this.tone(this.bus, t, 'sine', 1320, 1320, 0.1, 0.08, { attack: 0.004 });
    this.tone(this.bus, t + 0.2, 'sine', 880, 880, 0.26, 0.32, { attack: 0.004 });
    this.tone(this.bus, t + 0.2, 'sine', 1760, 1760, 0.12, 0.08, { attack: 0.004 });
    this.tone(this.bus, t + 0.2, 'sine', 110, 80, 0.18, 0.25, { attack: 0.005 });
  }

  /** 웨이브 클리어: 상승 3음 + 마무리 화음 */
  waveClear(): void {
    const t = this.ctx.currentTime;
    for (const [i, f] of [523, 659, 784].entries()) this.tone(this.bus, t + i * 0.14, 'triangle', f, f, 0.22, 0.25, { attack: 0.005 });
    for (const f of [784, 988, 1175]) this.tone(this.bus, t + 0.42, 'sine', f, f, 0.7, 0.12, { attack: 0.01 });
  }

  /** 플레이어 사망: 무거운 하강 + 닫히는 노이즈 + 정전기 */
  death(): void {
    const t = this.ctx.currentTime;
    this.tone(this.bus, t, 'sine', 160, 26, 1.4, 0.9, { attack: 0.01 });
    this.noise(this.bus, t, 1.2, 0.35, { lp: [2200, 90], attack: 0.02 });
    for (let i = 0; i < 6; i++) this.noise(this.bus, t + 0.2 + i * 0.13, 0.02, 0.12, { hp: 3000 });
  }

  /** 봇 사망: 파워다운 윙 + 글리치 */
  botDeath(dst: AudioNode = this.bus, vol = 1): void {
    const t = this.ctx.currentTime;
    this.tone(dst, t, 'sawtooth', 360, 40, 0.7, 0.35 * vol, { attack: 0.01, lp: [1600, 200] });
    for (const dt of [0.05, 0.15, 0.3]) this.tone(dst, t + dt, 'square', 820, 760, 0.025, 0.14 * vol, { lp: [3000, 3000] });
    this.noise(dst, t, 0.3, 0.2 * vol, { lp: [1200, 200] });
  }
}
