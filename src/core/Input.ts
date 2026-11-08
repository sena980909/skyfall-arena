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
  /** Pointer Lock 요청이 실패했을 때 (지원 안 함 등) */
  onLockFailed?: () => void;

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'Tab' || e.code === 'F3' || e.code === 'F8') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
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
      if (!this.locked) {
        this.keys.clear();
        this.mouseDown.fill(false);
      }
      this.onLockChange?.(this.locked);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown.fill(false);
    });
  }

  requestLock(): void {
    if (this.locked) return;
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
