import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";

/** True while the user asks for reduced motion. Follows changes without a reload. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(REDUCED);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

export type Route = { page: "grid" } | { page: "detail"; site: string; slug: string };

/** "#/c/<site>/<slug>" is a capture; anything else is the grid. Hash routes work on any static server. */
export function parseHash(hash: string): Route {
  const m = /^#\/c\/([^/]+)\/([^/]+)\/?$/.exec(hash);
  if (!m?.[1] || !m[2]) return { page: "grid" };
  try {
    return { page: "detail", site: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) };
  } catch {
    return { page: "grid" };
  }
}

export function detailHref(site: string, slug: string): string {
  return `#/c/${encodeURIComponent(site)}/${encodeURIComponent(slug)}`;
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("hashchange", onChange);
      return () => window.removeEventListener("hashchange", onChange);
    },
    () => window.location.hash,
    () => "",
  );
  return parseHash(hash);
}

export type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; error: string };

/** Runs a fetch on mount and whenever `key` changes; `reload` runs it again without a spinner. */
export function useLoad<T>(key: string, load: (signal: AbortSignal) => Promise<T>): [Load<T>, () => void] {
  const [result, setResult] = useState<Load<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => setResult({ state: "ready", data }),
      (error: Error) => {
        if (error.name !== "AbortError") setResult({ state: "error", error: error.message });
      },
    );
    return () => controller.abort();
    // `load` is a fresh closure every render; `key` and `tick` decide when to run it again.
  }, [key, tick]);
  useEffect(() => setResult({ state: "loading" }), [key]);
  return [result, useCallback(() => setTick((t) => t + 1), [])];
}

/** Copies text, falling back to a hidden textarea where the Clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
