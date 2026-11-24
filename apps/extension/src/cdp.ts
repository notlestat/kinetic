// A small wrapper around chrome.debugger for one tab.

import { browser } from "wxt/browser";

type EventHandler = (params: Record<string, unknown>) => void;

export class CdpSession {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private attached = true;

  private constructor(readonly tabId: number) {}

  static async attach(tabId: number): Promise<CdpSession> {
    await browser.debugger.attach({ tabId }, "1.3");
    const session = new CdpSession(tabId);
    browser.debugger.onEvent.addListener(session.onEvent);
    browser.debugger.onDetach.addListener(session.onDetach);
    return session;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  async send<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    if (!this.attached) throw new Error(`debugger detached before ${method}`);
    return (await browser.debugger.sendCommand({ tabId: this.tabId }, method, params)) as T;
  }

  /** Listens for a CDP event. Returns a function that removes the listener. */
  on(method: string, handler: EventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  async detach(): Promise<void> {
    browser.debugger.onEvent.removeListener(this.onEvent);
    browser.debugger.onDetach.removeListener(this.onDetach);
    this.handlers.clear();
    if (!this.attached) return;
    this.attached = false;
    try {
      await browser.debugger.detach({ tabId: this.tabId });
    } catch {
      // Already detached (tab closed, or the user cancelled the debugging bar).
    }
  }

  private readonly onEvent = (source: { tabId?: number }, method: string, params?: object) => {
    if (source.tabId !== this.tabId) return;
    for (const handler of this.handlers.get(method) ?? []) {
      try {
        handler((params ?? {}) as Record<string, unknown>);
      } catch (error) {
        console.warn("[kinetic] CDP handler failed", method, error);
      }
    }
  };

  private readonly onDetach = (source: { tabId?: number }) => {
    if (source.tabId === this.tabId) this.attached = false;
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
