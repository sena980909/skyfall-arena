import { Camera, Vector3 } from 'three';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`HUD element missing: #${id}`);
  return el as T;
};

export type OverlayId = 'ov-menu' | 'ov-pause' | 'ov-dead' | 'ov-end';

/** DOM 기반 HUD/오버레이 */
export class Hud {
  private readonly root = $('hud');
  private readonly wave = $('hud-wave');
  private readonly bots = $('hud-bots');
  private readonly rest = $('hud-rest');
  private readonly score = $('hud-score');
  private readonly lives = $('hud-lives');
  private readonly hpFill = $('hud-hpfill');
  private readonly hpText = $('hud-hp');
  private readonly ammo = $('hud-ammo');
  private readonly reload = $('hud-reload');
  private readonly ult = $('hud-ult');
  private readonly crosshair = $('crosshair');
  private readonly hitmarker = $('hitmarker');
  private readonly dmgdir = $('dmgdir');
  private readonly vignette = $('vignette');
  private readonly dmgnums = $('dmgnums');
  private readonly killfeed = $('killfeed');
  private readonly botlabels = $('botlabels');
  private readonly lockmarks = $('lockmarks');
  private readonly skills = [$('skill-0'), $('skill-1')];
  private readonly flashWhite = $('flashwhite');
  private readonly ultTint = $('ulttint');
  private readonly bossbar = $('bossbar');
  private readonly bossname = $('bossname');
  private readonly bossfill = $('bossfill');
  private readonly objmark = $('objmark');
  private readonly objmarkText = $('objmark-text');
  private readonly interact = $('interact');
  private readonly interactText = $('interact-text');
  private readonly interactFill = $('interact-fill');
  private hmTimer = 0;
  private readonly tmp = new Vector3();

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  setHp(hp: number, max: number): void {
    const r = Math.max(0, hp / max);
    this.hpFill.style.width = `${r * 100}%`;
    this.hpFill.classList.toggle('low', r < 0.3);
    this.hpText.textContent = String(Math.max(0, Math.ceil(hp)));
    this.vignette.style.opacity = r < 0.5 ? String((0.5 - r) * 1.6) : '0';
  }

  setAmmo(ammo: number | string, mag: number, reloadText = ''): void {
    this.ammo.textContent = String(ammo);
    this.ammo.style.color = typeof ammo === 'string' ? '#8ec5ff' : ammo === 0 ? '#ff5a2f' : ammo <= mag * 0.25 ? '#ffd166' : '';
    this.reload.textContent = reloadText;
  }

  setUlt(pct: number, active = false, remaining = 0): void {
    this.ult.textContent = active ? `${remaining.toFixed(1)}s` : `${Math.floor(pct)}%`;
    this.ult.classList.toggle('ready', !active && pct >= 100);
    this.ult.classList.toggle('active', active);
    this.ultTint.style.opacity = active ? '1' : '0';
  }

  /** 스킬 쿨다운 표시. remaining 0이면 준비됨 */
  setSkill(index: number, remaining: number, cooldown: number): void {
    const el = this.skills[index];
    if (!el) return;
    const cooling = remaining > 0.01;
    el.classList.toggle('cooling', cooling);
    el.classList.toggle('ready', !cooling);
    const cd = el.querySelector<HTMLElement>('.cd');
    if (cd) cd.style.height = cooling ? `${(remaining / cooldown) * 100}%` : '0%';
    const label = el.querySelector<HTMLElement>('.label');
    if (label) label.dataset.sec = cooling ? remaining.toFixed(1) : '';
  }

  /** 섬광 피격 (강도 0..1) */
  flash(intensity: number): void {
    this.flashWhite.style.transition = 'none';
    this.flashWhite.style.opacity = String(Math.min(1, intensity));
    requestAnimationFrame(() => {
      this.flashWhite.style.transition = 'opacity 1.2s ease-out';
      this.flashWhite.style.opacity = '0';
    });
  }

  setWave(n: number, total: number): void {
    this.wave.textContent = `WAVE ${n} / ${total}`;
  }

  /** 임무 목표 표시(상단 제목·부제) */
  setObjective(title: string, detail: string): void {
    this.wave.textContent = title;
    this.bots.textContent = detail;
  }

  /** 목표 지점 마커. 화면 밖이거나 뒤에 있으면 가장자리에 붙는다. null이면 숨김 */
  setObjectiveMarker(world: Vector3 | null, camera: Camera, label = ''): void {
    this.objmark.classList.toggle('hidden', !world);
    if (!world) return;
    this.tmp.copy(world).project(camera);
    let x = this.tmp.x;
    let y = this.tmp.y;
    const behind = this.tmp.z > 1;
    if (behind) {
      x = -x;
      y = -0.86;
    }
    const m = 0.86;
    const edge = behind || Math.abs(x) > m || Math.abs(y) > m;
    x = Math.max(-m, Math.min(m, x));
    y = Math.max(-m, Math.min(0.74, y));
    this.objmark.classList.toggle('edge', edge);
    this.objmark.style.left = `${(x * 0.5 + 0.5) * window.innerWidth}px`;
    this.objmark.style.top = `${(-y * 0.5 + 0.5) * window.innerHeight}px`;
    this.objmarkText.textContent = label;
  }

  /** 상호작용 안내와 진행 막대. null이면 숨김 */
  setInteract(text: string | null, progress = 0): void {
    this.interact.classList.toggle('hidden', text === null);
    if (text === null) return;
    this.interactText.textContent = text;
    this.interactFill.style.width = `${Math.round(progress * 100)}%`;
  }

  setBots(n: number): void {
    this.bots.textContent = `남은 봇 ${n}`;
  }

  setRest(text: string): void {
    this.rest.textContent = text;
  }

  /** 보스 HP 바. null이면 숨김 */
  setBoss(info: { name: string; hp: number; max: number } | null): void {
    this.bossbar.classList.toggle('hidden', !info);
    if (!info) return;
    this.bossname.textContent = info.name;
    this.bossfill.style.width = `${Math.max(0, (info.hp / info.max) * 100)}%`;
  }

  healNumber(amount: number): void {
    const el = document.createElement('div');
    el.className = 'healnum';
    el.textContent = `+${amount}`;
    this.dmgnums.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  setScore(n: number): void {
    this.score.textContent = String(n);
  }

  setLives(n: number): void {
    this.lives.textContent = '♥'.repeat(Math.max(0, n)) + '♡'.repeat(Math.max(0, 3 - n));
  }

  /** 크로스헤어 벌어짐 (px) */
  setCrosshair(gapPx: number): void {
    const g = Math.round(gapPx);
    const ls = this.crosshair.querySelectorAll<HTMLElement>('.l');
    ls.forEach((l) => {
      if (l.classList.contains('n')) l.style.top = `${-g - 9}px`;
      if (l.classList.contains('s')) l.style.top = `${g}px`;
      if (l.classList.contains('w')) l.style.left = `${-g - 9}px`;
      if (l.classList.contains('e')) l.style.left = `${g}px`;
    });
  }

  hitmarkerFlash(kind: 'hit' | 'hs' | 'kill'): void {
    this.hitmarker.className = kind === 'hit' ? '' : kind;
    void this.hitmarker.offsetWidth; // 애니메이션 리스타트
    this.hitmarker.classList.add('show');
    clearTimeout(this.hmTimer);
    this.hmTimer = window.setTimeout(() => this.hitmarker.classList.remove('show'), 200);
  }

  /** 피격 방향 호 표시. angleRad: 화면 위(전방) 기준 시계방향 */
  damageDirection(angleRad: number): void {
    const el = document.createElement('div');
    el.className = 'dmg-arc';
    el.style.transform = `rotate(${angleRad}rad)`;
    this.dmgdir.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  killFeed(text: string, cls = ''): void {
    const el = document.createElement('div');
    el.textContent = text;
    if (cls) el.classList.add(cls);
    this.killfeed.prepend(el);
    while (this.killfeed.children.length > 5) this.killfeed.lastElementChild?.remove();
    setTimeout(() => el.remove(), 4000);
  }

  damageNumber(world: Vector3, camera: Camera, amount: number, headshot: boolean): void {
    this.tmp.copy(world).project(camera);
    if (this.tmp.z > 1) return;
    const x = (this.tmp.x * 0.5 + 0.5) * window.innerWidth + (Math.random() - 0.5) * 24;
    const y = (-this.tmp.y * 0.5 + 0.5) * window.innerHeight + (Math.random() - 0.5) * 16;
    const el = document.createElement('div');
    el.className = 'dmgnum' + (headshot ? ' hs' : '');
    el.textContent = String(amount);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.dmgnums.appendChild(el);
    setTimeout(() => el.remove(), 700);
  }

  /** 디버그 봇 라벨 (매 프레임 갱신) */
  setBotLabels(items: { world: Vector3; text: string }[], camera: Camera): void {
    while (this.botlabels.children.length > items.length) this.botlabels.lastElementChild?.remove();
    while (this.botlabels.children.length < items.length) {
      const el = document.createElement('div');
      el.className = 'botlabel';
      this.botlabels.appendChild(el);
    }
    items.forEach((it, i) => {
      const el = this.botlabels.children[i] as HTMLElement;
      this.tmp.copy(it.world).project(camera);
      if (this.tmp.z > 1 || Math.abs(this.tmp.x) > 1.2 || Math.abs(this.tmp.y) > 1.2) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.left = `${(this.tmp.x * 0.5 + 0.5) * window.innerWidth}px`;
      el.style.top = `${(-this.tmp.y * 0.5 + 0.5) * window.innerHeight}px`;
      el.textContent = it.text;
    });
  }

  /** 전술 조준 락온 마커: 첫 번째가 현재 사격 대상 */
  setLockMarkers(points: Vector3[], camera: Camera): void {
    while (this.lockmarks.children.length > points.length) this.lockmarks.lastElementChild?.remove();
    while (this.lockmarks.children.length < points.length) {
      const el = document.createElement('div');
      el.className = 'lockmark';
      this.lockmarks.appendChild(el);
    }
    points.forEach((p, i) => {
      const el = this.lockmarks.children[i] as HTMLElement;
      this.tmp.copy(p).project(camera);
      el.style.left = `${(this.tmp.x * 0.5 + 0.5) * window.innerWidth}px`;
      el.style.top = `${(-this.tmp.y * 0.5 + 0.5) * window.innerHeight}px`;
      el.classList.toggle('primary', i === 0);
    });
  }

  clearBotLabels(): void {
    this.botlabels.replaceChildren();
  }

  showOverlay(id: OverlayId | null): void {
    for (const o of ['ov-menu', 'ov-pause', 'ov-dead', 'ov-end'] as OverlayId[]) {
      $(o).classList.toggle('hidden', o !== id);
    }
  }

  setDead(by: string, count: number): void {
    $('dead-by').textContent = `${by}에게 처치됨`;
    $('dead-count').textContent = String(count);
  }

  setEnd(victory: boolean, sub: string, stats: [string, string][]): void {
    const t = $('end-title');
    t.textContent = victory ? 'VICTORY' : 'DEFEAT';
    t.style.color = victory ? '#8ec5ff' : '#ff5a2f';
    $('end-sub').textContent = sub;
    const s = $('end-stats');
    s.replaceChildren();
    for (const [k, v] of stats) {
      const a = document.createElement('span');
      a.textContent = k;
      const b = document.createElement('span');
      b.textContent = v;
      s.append(a, b);
    }
  }

  resetFeeds(): void {
    this.killfeed.replaceChildren();
    this.dmgnums.replaceChildren();
    this.dmgdir.replaceChildren();
    this.clearBotLabels();
    this.lockmarks.replaceChildren();
  }
}
