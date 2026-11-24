// MAIN world hooks. Each feature adds its own clearly marked section below and
// must never throw into page code: wrap every hook in try/catch.

export function startMainWorld(): void {
  try {
    console.log("[kinetic] main world loaded");
  } catch {
    // Never break the site.
  }
}
