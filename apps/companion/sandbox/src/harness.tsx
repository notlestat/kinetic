// Mounts the rebuilt component for the preview recorder. Each run's main.tsx imports
// Component.tsx and calls mount(). The component sits between two viewport-tall
// spacers, so the recorder's scroll pass has room to bring it in and out of view.
//
// The recorder waits for window.__kineticReady, then reads window.__kineticError: an
// error thrown while rendering, or any uncaught error, fails the preview with that message.

import { type ComponentType, type ErrorInfo, type ReactNode, Component as ReactComponent, useEffect } from "react";
import { createRoot } from "react-dom/client";

declare global {
  interface Window {
    __kineticReady?: boolean;
    __kineticError?: string;
  }
}

export interface HarnessConfig {
  /** The original root's width in CSS pixels, so the rebuild lays out at the same size. Null lets it size itself. */
  rootWidth: number | null;
}

function report(message: string): void {
  window.__kineticError ??= message.slice(0, 4000);
}

class Boundary extends ReactComponent<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    report(`${message}\n${info.componentStack ?? ""}`);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Two frames after the first commit, so layout and the first animation frame have happened. */
function Ready(): null {
  useEffect(() => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.__kineticReady = true;
      }),
    );
  }, []);
  return null;
}

/** The default export, else an export named Component, else the first exported function. */
export function pickComponent(mod: Readonly<Record<string, unknown>>): ComponentType | null {
  const candidates = [mod.default, mod.Component, ...Object.values(mod)];
  const found = candidates.find((value) => typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value));
  return (found as ComponentType | undefined) ?? null;
}

export function mount(mod: Readonly<Record<string, unknown>>, config: HarnessConfig): void {
  window.addEventListener("error", (event) => report(String(event.error instanceof Error ? (event.error.stack ?? event.error.message) : event.message)));
  window.addEventListener("unhandledrejection", (event) => report(`Unhandled rejection: ${event.reason instanceof Error ? (event.reason.stack ?? event.reason.message) : String(event.reason)}`));

  // The preview's mobile pass sets ?rootWidth= to the original's width at 390 px.
  const override = Number(new URLSearchParams(window.location.search).get("rootWidth"));
  const rootWidth = Number.isFinite(override) && override > 0 ? override : config.rootWidth;
  const container = document.getElementById("app");
  const Rebuilt = pickComponent(mod);
  if (!container || !Rebuilt) {
    report("Component.tsx has no component export. Export the component as the default export.");
    window.__kineticReady = true;
    return;
  }
  createRoot(container).render(
    <>
      <div aria-hidden="true" style={{ height: "100vh" }} />
      <div id="kinetic-root" style={{ display: "flow-root", width: rootWidth ? `${rootWidth}px` : undefined, maxWidth: "100%", margin: "0 auto" }}>
        <Boundary>
          <Rebuilt />
        </Boundary>
      </div>
      <div aria-hidden="true" style={{ height: "100vh" }} />
      <Ready />
    </>,
  );
}
