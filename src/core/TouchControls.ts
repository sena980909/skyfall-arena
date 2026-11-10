import type { Input } from './Input';

/** 터치 기기 여부. 주소에 ?touch=1 을 붙이면 강제로 켠다(데스크톱에서 화면 확인용) */
export function isTouchDevice(): boolean {
  if (/[?&]touch=1/.test(location.search)) return true;
  const touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  return touch && (coarse || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));
}

interface ButtonDef {
  id: string;
  label: string;
  /** 누르는 동안 눌린 것으로 치는 키 코드 */
  key?: string;
  /** 누르는 동안 눌린 것으로 치는 마우스 버튼(0 = 사격, 2 = 로켓) */
  mouse?: number;
  size: number;
  right: number;
  bottom: number;
  /** 누른 채 끌면 시점도 같이 돈다(사격 버튼) */
  look?: boolean;
  color?: string;
}

/** 오른쪽 아래 버튼 배치 (가로 화면 기준, px) */
const BUTTONS: ButtonDef[] = [
  { id: 'fire', label: '사격', mouse: 0, size: 84, right: 96, bottom: 64, look: true, color: 'rgba(255, 170, 90, .30)' },
  { id: 'jump', label: '점프', key: 'Space', size: 58, right: 18, bottom: 28 },
  { id: 'rocket', label: '로켓', mouse: 2, size: 58, right: 20, bottom: 108 },
  { id: 'reload', label: '장전', key: 'KeyR', size: 52, right: 196, bottom: 22 },
  { id: 'heal', label: '치유', key: 'KeyE', size: 52, right: 110, bottom: 164 },
  { id: 'ult', label: '궁', key: 'KeyQ', size: 52, right: 196, bottom: 110 },
  { id: 'use', label: 'F', key: 'KeyF', size: 56, right: 268, bottom: 62, color: 'rgba(127, 240, 255, .28)' },
];

const STICK_RADIUS = 56;
const STICK_DEAD = 14;
/** 터치 끌기 1px당 시점 이동량(마우스 1카운트 대비 배율) */
const LOOK_SCALE = 2.2;

type Track =
  | { kind: 'stick'; ox: number; oy: number }
  | { kind: 'look'; x: number; y: number }
  | { kind: 'btn'; def: ButtonDef; el: HTMLElement; x: number; y: number };

/**
 * 터치 조작: 왼쪽은 이동 스틱(손가락을 댄 자리에 생김), 오른쪽은 끌어서 시점, 오른쪽 아래는 버튼.
 * 실제 키보드·마우스 입력과 같은 통로(Input의 가상 키·버튼·시점 이동)로 넣어 게임 로직은 그대로 쓴다.
 */
export class TouchControls {
  private readonly root: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly tracks = new Map<number, Track>();
  private moveKeys: string[] = [];
  private active = false;

  constructor(private readonly input: Input, private readonly onPause: () => void, private readonly onToggleView: () => void) {
    const style = document.createElement('style');
    style.textContent = `
      #touch { position: fixed; inset: 0; z-index: 5; touch-action: none; display: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
      #touch.on { display: block; }
      #touch .tbtn { position: absolute; border-radius: 50%; border: 2px solid rgba(255,255,255,.45); background: rgba(20, 30, 48, .38); color: #fff; font-weight: 700; font-size: 13px; letter-spacing: 1px; display: flex; align-items: center; justify-content: center; text-shadow: 0 1px 4px rgba(0,0,0,.8); }
      #touch .tbtn.down { background: rgba(255,255,255,.34); border-color: #fff; }
      #touch .tsmall { position: absolute; top: 10px; height: 34px; min-width: 44px; padding: 0 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.4); background: rgba(20, 30, 48, .5); color: #fff; font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
      #touch .stick { position: absolute; width: ${STICK_RADIUS * 2}px; height: ${STICK_RADIUS * 2}px; margin: -${STICK_RADIUS}px 0 0 -${STICK_RADIUS}px; border-radius: 50%; border: 2px solid rgba(255,255,255,.35); background: rgba(20, 30, 48, .25); display: none; }
      #touch .stick .knob { position: absolute; left: 50%; top: 50%; width: 52px; height: 52px; margin: -26px 0 0 -26px; border-radius: 50%; background: rgba(255,255,255,.4); }
    `;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.stick = document.createElement('div');
    this.stick.className = 'stick';
    this.knob = document.createElement('div');
    this.knob.className = 'knob';
    this.stick.appendChild(this.knob);
    this.root.appendChild(this.stick);
    for (const def of BUTTONS) {
      const el = document.createElement('div');
      el.className = 'tbtn';
      el.dataset.btn = def.id;
      el.textContent = def.label;
      el.style.width = el.style.height = `${def.size}px`;
      el.style.right = `calc(${def.right}px + env(safe-area-inset-right))`;
      el.style.bottom = `calc(${def.bottom}px + env(safe-area-inset-bottom))`;
      if (def.color) el.style.background = def.color;
      this.root.appendChild(el);
    }
    const pause = this.small('Ⅱ', 'calc(50% + 150px)');
    pause.dataset.act = 'pause';
    const view = this.small('시점', 'calc(50% + 204px)');
    view.dataset.act = 'view';
    document.body.appendChild(this.root);

    const opt: AddEventListenerOptions = { passive: false };
    this.root.addEventListener('touchstart', (e) => this.onStart(e), opt);
    this.root.addEventListener('touchmove', (e) => this.onMove(e), opt);
    this.root.addEventListener('touchend', (e) => this.onEnd(e), opt);
    this.root.addEventListener('touchcancel', (e) => this.onEnd(e), opt);
  }

  private small(label: string, left: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tsmall';
    el.textContent = label;
    el.style.left = left;
    this.root.appendChild(el);
    return el;
  }

  /** 플레이 중에만 보이고 입력을 받는다 */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.root.classList.toggle('on', on);
    if (!on) this.releaseAll();
  }

  private releaseAll(): void {
    for (const t of this.tracks.values()) if (t.kind === 'btn') this.setButton(t.def, t.el, false);
    this.tracks.clear();
    this.setMove([]);
    this.stick.style.display = 'none';
  }

  private setButton(def: ButtonDef, el: HTMLElement, down: boolean): void {
    el.classList.toggle('down', down);
    if (def.key) this.input.setVirtualKey(def.key, down);
    if (def.mouse !== undefined) this.input.setVirtualButton(def.mouse, down);
  }

  private setMove(keys: string[]): void {
    for (const k of this.moveKeys) if (!keys.includes(k)) this.input.setVirtualKey(k, false);
    for (const k of keys) if (!this.moveKeys.includes(k)) this.input.setVirtualKey(k, true);
    this.moveKeys = keys;
  }

  private onStart(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const target = t.target as HTMLElement;
      const act = target.dataset?.act;
      if (act === 'pause') {
        this.onPause();
        continue;
      }
      if (act === 'view') {
        this.onToggleView();
        continue;
      }
      const id = target.dataset?.btn;
      const def = id ? BUTTONS.find((b) => b.id === id) : undefined;
      if (def) {
        this.tracks.set(t.identifier, { kind: 'btn', def, el: target, x: t.clientX, y: t.clientY });
        this.setButton(def, target, true);
      } else if (t.clientX < window.innerWidth * 0.42 && ![...this.tracks.values()].some((k) => k.kind === 'stick')) {
        this.tracks.set(t.identifier, { kind: 'stick', ox: t.clientX, oy: t.clientY });
        this.stick.style.display = 'block';
        this.stick.style.left = `${t.clientX}px`;
        this.stick.style.top = `${t.clientY}px`;
        this.knob.style.transform = 'translate(0px, 0px)';
      } else this.tracks.set(t.identifier, { kind: 'look', x: t.clientX, y: t.clientY });
    }
  }

  private onMove(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const tr = this.tracks.get(t.identifier);
      if (!tr) continue;
      if (tr.kind === 'stick') {
        let dx = t.clientX - tr.ox;
        let dy = t.clientY - tr.oy;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) {
          dx *= STICK_RADIUS / len;
          dy *= STICK_RADIUS / len;
        }
        this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
        const keys: string[] = [];
        if (len > STICK_DEAD) {
          // 8방향: 축 성분이 전체의 38% 이상이면 그 방향 키를 누른 것으로 본다
          const nx = dx / len;
          const ny = dy / len;
          if (ny < -0.38) keys.push('KeyW');
          if (ny > 0.38) keys.push('KeyS');
          if (nx < -0.38) keys.push('KeyA');
          if (nx > 0.38) keys.push('KeyD');
          // 끝까지 앞으로 밀면 달리기
          if (len >= STICK_RADIUS * 0.92 && ny < -0.8) keys.push('ShiftLeft');
        }
        this.setMove(keys);
      } else if (tr.kind === 'look' || tr.def.look) {
        this.input.addLook((t.clientX - tr.x) * LOOK_SCALE, (t.clientY - tr.y) * LOOK_SCALE);
        tr.x = t.clientX;
        tr.y = t.clientY;
      }
    }
  }

  private onEnd(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const tr = this.tracks.get(t.identifier);
      if (!tr) continue;
      this.tracks.delete(t.identifier);
      if (tr.kind === 'btn') this.setButton(tr.def, tr.el, false);
      else if (tr.kind === 'stick') {
        this.setMove([]);
        this.stick.style.display = 'none';
      }
    }
  }
}
