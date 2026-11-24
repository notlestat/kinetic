// The motion pass: fires the component's states with real input over CDP while
// the MAIN world records every animation that starts.
//
// SPEC.md names the CDP Animation domain for this, but Chrome does not expose
// that domain to extensions: chrome.debugger answers Animation.enable with
// "'Animation.enable' wasn't found" (-32601). So this module drives the pass with
// the domains extensions do get (Input, DOM, Page, Runtime), and the MAIN world's
// animation watcher records each new animation with effect.getKeyframes() and
// getTiming(), the same data the Animation domain would give.

import { type CdpSession, sleep } from "./cdp.ts";
import type { MotionPassTrigger } from "./messages.ts";
import type { MainWorldMotion } from "./motion-records.ts";

/** How long to let a hover or focus animation run before reading what started. */
export const SETTLE_MS = 600;
/** How long to let the reverse animation finish after leaving a state. */
export const RESET_MS = 450;
/** How long after the load event to keep recording load animations. */
export const LOAD_WINDOW_MS = 2500;

/** Motion the MAIN world reported for one step of the pass, with the trigger that was firing. */
export interface PassResult {
  trigger: MotionPassTrigger;
  motion: MainWorldMotion | undefined;
}

export interface PassHooks {
  /** Starts recording new animations in the page, labelled with this trigger. */
  arm(trigger: MotionPassTrigger): Promise<void>;
  /** Stops recording and returns what started since arm(), plus the GSAP tweens now running. */
  collect(): Promise<MainWorldMotion | undefined>;
}

/** The sessionStorage flag that tells the reloaded page's MAIN world to record load motion from the start. */
export const LOAD_CAPTURE_FLAG = "kinetic:load-capture";

export class MotionPass {
  constructor(
    private readonly session: CdpSession,
    private readonly hooks: PassHooks,
  ) {}

  private async nodeId(selector: string): Promise<number | undefined> {
    try {
      const { root } = await this.session.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
      const { nodeId } = await this.session.send<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector });
      return nodeId || undefined;
    } catch {
      return undefined;
    }
  }

  /** Centre of the element in viewport coordinates, after scrolling it into view. */
  private async centre(nodeId: number): Promise<{ x: number; y: number } | undefined> {
    try {
      await this.session.send("DOM.scrollIntoViewIfNeeded", { nodeId });
      const { quads } = await this.session.send<{ quads: number[][] }>("DOM.getContentQuads", { nodeId });
      const quad = quads[0];
      if (!quad || quad.length < 8) return undefined;
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0, x4 = 0, y4 = 0] = quad;
      return { x: (x1 + x2 + x3 + x4) / 4, y: (y1 + y2 + y3 + y4) / 4 };
    } catch {
      return undefined;
    }
  }

  private async moveMouse(x: number, y: number): Promise<void> {
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  }

  /** Hovers each interactive element with real mouse events, then focuses it, recording what each step starts. */
  async fireStates(interactive: readonly string[]): Promise<PassResult[]> {
    const results: PassResult[] = [];
    // Park the mouse in the corner so the first hover starts from outside the component.
    await this.moveMouse(0, 0);
    await sleep(RESET_MS);

    for (const selector of interactive) {
      const nodeId = await this.nodeId(selector);
      if (!nodeId) continue;
      const point = await this.centre(nodeId);
      if (point) {
        await this.hooks.arm("hover");
        await this.moveMouse(point.x, point.y);
        await sleep(SETTLE_MS);
        results.push({ trigger: "hover", motion: await this.hooks.collect() });
        await this.moveMouse(0, 0);
        await sleep(RESET_MS);
      }

      await this.hooks.arm("focus");
      let focused = true;
      try {
        await this.session.send("DOM.focus", { nodeId });
        await sleep(SETTLE_MS);
      } catch {
        focused = false; // Not focusable.
      }
      const motion = await this.hooks.collect();
      if (focused) results.push({ trigger: "focus", motion });
      await this.session.send("Runtime.evaluate", { expression: "document.activeElement?.blur?.()" });
      await sleep(RESET_MS);
    }
    return results;
  }

  /**
   * Reloads the page and records motion until shortly after the load event.
   * Only runs when the user opts in, because it reloads the page they are on.
   */
  async reloadForLoadAnimations(): Promise<PassResult[]> {
    await this.session.send("Page.enable");
    await this.session.send("Runtime.evaluate", {
      expression: `sessionStorage.setItem(${JSON.stringify(LOAD_CAPTURE_FLAG)}, "1")`,
    });
    const loaded = new Promise<void>((resolve) => {
      const off = this.session.on("Page.loadEventFired", () => {
        off();
        resolve();
      });
      setTimeout(resolve, 15_000);
    });
    await this.session.send("Page.reload", {});
    await loaded;
    await sleep(LOAD_WINDOW_MS);
    return [{ trigger: "load", motion: await this.hooks.collect() }];
  }
}
