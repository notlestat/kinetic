// Picker UI. Lives in a shadow root on its own host element, so site CSS cannot reach it.
//
// Hover highlights the element under the cursor. Arrow Up and Arrow Down move the
// selection to the parent or the first child. Click (or Enter) captures. Shift with
// either also reloads the page once to record load animations. Esc exits.

export const PICKER_HOST_TAG = "kinetic-picker";

export interface PickOptions {
  /** Shift was held: reload the page once to record load animations. */
  reloadForLoadAnimations: boolean;
}

const STYLES = `
:host { all: initial; }
.box {
  position: fixed; box-sizing: border-box; pointer-events: none; display: none;
  outline: 2px solid #ff4f00; outline-offset: -1px; background: rgba(255, 79, 0, 0.08);
}
.label {
  position: fixed; pointer-events: none; display: none; max-width: 360px;
  padding: 4px 8px; border-radius: 4px; background: #111; color: #fff;
  font: 500 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-line;
}
.label[data-tone="error"] { background: #b00020; }
.label[data-tone="ok"] { background: #0b6b3a; }
`;

export type StatusTone = "info" | "ok" | "error";

export class Picker {
  private host: HTMLElement | undefined;
  private box: HTMLDivElement | undefined;
  private label: HTMLDivElement | undefined;
  private selected: Element | undefined;
  private status = "";
  private busy = false;

  constructor(private readonly onPick: (el: Element, options: PickOptions) => Promise<void>) {}

  get active(): boolean {
    return this.host !== undefined;
  }

  get selection(): Element | undefined {
    return this.selected;
  }

  toggle(): void {
    if (this.active) this.stop();
    else this.start();
  }

  start(): void {
    if (this.active) return;
    const host = document.createElement(PICKER_HOST_TAG);
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    const box = document.createElement("div");
    box.className = "box";
    const label = document.createElement("div");
    label.className = "label";
    label.setAttribute("role", "status");
    label.setAttribute("aria-live", "polite");
    shadow.append(style, box, label);
    document.documentElement.appendChild(host);
    this.host = host;
    this.box = box;
    this.label = label;
    this.status = "";

    window.addEventListener("mousemove", this.onMove, true);
    window.addEventListener("click", this.onClick, true);
    window.addEventListener("mousedown", this.block, true);
    window.addEventListener("mouseup", this.block, true);
    window.addEventListener("pointerdown", this.block, true);
    window.addEventListener("pointerup", this.block, true);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("scroll", this.onScroll, true);
    window.addEventListener("resize", this.onScroll, true);
  }

  stop(): void {
    window.removeEventListener("mousemove", this.onMove, true);
    window.removeEventListener("click", this.onClick, true);
    window.removeEventListener("mousedown", this.block, true);
    window.removeEventListener("mouseup", this.block, true);
    window.removeEventListener("pointerdown", this.block, true);
    window.removeEventListener("pointerup", this.block, true);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("resize", this.onScroll, true);
    this.host?.remove();
    this.host = this.box = this.label = this.selected = undefined;
  }

  /** Hides the overlay so it never appears in screenshots. */
  setHidden(hidden: boolean): void {
    if (this.host) this.host.style.display = hidden ? "none" : "";
  }

  setStatus(text: string, tone: StatusTone = "info"): void {
    this.status = text;
    if (this.label) this.label.dataset.tone = tone;
    this.render();
  }

  select(el: Element | undefined): void {
    if (!el || el === this.host || el === document.documentElement) return;
    this.selected = el;
    this.render();
  }

  private readonly onMove = (e: MouseEvent) => {
    if (this.busy) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== this.selected) {
      this.status = "";
      if (this.label) this.label.dataset.tone = "info";
      this.select(el);
    }
  };

  private readonly block = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  private readonly onClick = (e: MouseEvent) => {
    this.block(e);
    void this.pick(e.shiftKey);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      this.block(e);
      this.stop();
    } else if (e.key === "ArrowUp" && this.selected) {
      this.block(e);
      const parent = this.selected.parentElement;
      if (parent && parent !== document.documentElement) this.select(parent);
    } else if (e.key === "ArrowDown" && this.selected) {
      this.block(e);
      this.select(this.selected.firstElementChild ?? undefined);
    } else if (e.key === "Enter" && this.selected) {
      this.block(e);
      void this.pick(e.shiftKey);
    }
  };

  private readonly onScroll = () => this.render();

  private async pick(reloadForLoadAnimations: boolean): Promise<void> {
    const el = this.selected;
    if (!el || this.busy) return;
    this.busy = true;
    try {
      await this.onPick(el, { reloadForLoadAnimations });
    } finally {
      this.busy = false;
    }
  }

  private render(): void {
    const { box, label, selected } = this;
    if (!box || !label) return;
    if (!selected || !selected.isConnected) {
      box.style.display = label.style.display = "none";
      return;
    }
    const r = selected.getBoundingClientRect();
    Object.assign(box.style, {
      display: "block",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    const id = selected.id ? `#${selected.id}` : "";
    const size = `${Math.round(r.width)}×${Math.round(r.height)}`;
    label.textContent = `${selected.localName}${id}  ${size}\n${this.status || "Click to copy. Shift+click also records load animations."}`;
    label.style.display = "block";
    // The label is two lines or more, so place it by its real height.
    const height = label.offsetHeight || 44;
    const above = r.top - height - 4;
    label.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - 200))}px`;
    label.style.top = `${above > 4 ? above : Math.min(r.bottom + 4, window.innerHeight - height - 4)}px`;
  }
}
