/** 키보드/마우스 입력 + Pointer Lock 관리 */
export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  readonly mouseDown = [false, false, false];
  readonly mousePressed = [false, false, false];
  locked = false;
  onLockChange?: (locked: boolean) => void;
  /** 잠금 직후 이 시각까지의 마우스 이동은 버린다 (Chrome이 잠금 순간 커서 거리만큼 튀는 값을 보냄) */
  private ignoreMouseUntil = 0;
  /** 한 이벤트의 이동량 상한(px). 이보다 크면 스파이크로 보고 버린다 */
  private static readonly SPIKE_PX = 400;
  private static readonly CLAMP_PX = 160;
  /** Pointer Lock 요청이 실패했을 때 (지원 안 함 등) */
  onLockFailed?: () => void;
  /** 터치 조작 모드: 포인터 잠금이 없으므로 '잠금'을 플레이 중 여부로만 쓴다 */
  touchMode = false;

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'Tab' || e.code === 'F3' || e.code === 'F8') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      if (performance.now() < this.ignoreMouseUntil) return;
      const ax = Math.abs(e.movementX);
      const ay = Math.abs(e.movementY);
      // 비정상 스파이크(순간이동처럼 화면이 홱 도는 원인) 제거
      if (ax > Input.SPIKE_PX || ay > Input.SPIKE_PX) return;
      this.mouseDX += Math.max(-Input.CLAMP_PX, Math.min(Input.CLAMP_PX, e.movementX));
      this.mouseDY += Math.max(-Input.CLAMP_PX, Math.min(Input.CLAMP_PX, e.movementY));
    });
    window.addEventListener('mousedown', (e) => {
      if (!this.locked || e.button > 2) return;
      this.mouseDown[e.button] = true;
      this.mousePressed[e.button] = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button > 2) return;
      this.mouseDown[e.button] = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      // 잠금 전환 직후 누적값과 첫 이벤트들을 버린다
      this.mouseDX = 0;
      this.mouseDY = 0;
      this.ignoreMouseUntil = performance.now() + 150;
      if (!this.locked) {
        this.keys.clear();
        this.mouseDown.fill(false);
      }
      this.onLockChange?.(this.locked);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown.fill(false);
      this.mouseDX = 0;
      this.mouseDY = 0;
    });
    window.addEventListener('focus', () => {
      this.ignoreMouseUntil = performance.now() + 150;
    });
  }

  /** 터치 버튼이 누르는 가상 키 */
  setVirtualKey(code: string, down: boolean): void {
    if (down) {
      if (!this.keys.has(code)) this.pressed.add(code);
      this.keys.add(code);
    } else this.keys.delete(code);
  }

  /** 터치 버튼이 누르는 가상 마우스 버튼 */
  setVirtualButton(button: number, down: boolean): void {
    this.mouseDown[button] = down;
    if (down) this.mousePressed[button] = true;
  }

  /** 터치 끌기로 들어온 시점 이동 */
  addLook(dx: number, dy: number): void {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  /** 터치 모드에서 일시정지로 나갈 때 */
  releaseTouch(): void {
    if (!this.touchMode || !this.locked) return;
    this.locked = false;
    this.keys.clear();
    this.mouseDown.fill(false);
    this.onLockChange?.(false);
  }

  requestLock(): void {
    if (this.locked) return;
    if (this.touchMode) {
      this.locked = true;
      this.mouseDX = 0;
      this.mouseDY = 0;
      this.onLockChange?.(true);
      return;
    }
    try {
      // 일부 임베디드 브라우저는 Pointer Lock을 지원하지 않는다 (Promise reject 또는 throw)
      const r = (this.el.requestPointerLock as () => Promise<void> | void).call(this.el);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err: unknown) => {
          console.warn('[Input] pointer lock unavailable:', err);
          this.onLockFailed?.();
        });
      }
    } catch (err) {
      console.warn('[Input] pointer lock unavailable:', err);
      this.onLockFailed?.();
    }
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  justPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** 프레임에 누적된 마우스 이동량을 가져오고 0으로 리셋 */
  consumeMouse(): { dx: number; dy: number } {
    const r = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return r;
  }

  endFrame(): void {
    this.pressed.clear();
    this.mousePressed.fill(false);
  }
}
