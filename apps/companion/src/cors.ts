// Which routes the library UI (a Vite app on 127.0.0.1:5173) may call from the browser.
//
// The extension reaches every route. The library gets CORS only on the read routes
// and on starting a rebuild or a preview. POST /capture, /capture/file and /record
// stay extension-only, so the library page can never write capture content.

/** Origins of the library UI's dev and preview servers. */
export const LIBRARY_ORIGINS: ReadonlySet<string> = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);

const SEGMENT = "[^/]+";
const READ_ROUTES = [new RegExp(`^/captures$`), new RegExp(`^/captures/${SEGMENT}/${SEGMENT}$`), new RegExp(`^/files/${SEGMENT}/${SEGMENT}/.+$`)];
const JOB_ROUTES = [new RegExp(`^/captures/${SEGMENT}/${SEGMENT}/(rebuild|preview)$`)];

/** The methods the library may use on a path. Empty when the path is extension-only. */
export function libraryMethods(path: string): readonly string[] {
  if (READ_ROUTES.some((r) => r.test(path))) return ["GET", "HEAD"];
  if (JOB_ROUTES.some((r) => r.test(path))) return ["POST"];
  return [];
}

/** True when the library origin may make this request, including a preflight for an allowed method. */
export function libraryMayCall(method: string, path: string, preflightMethod: string | undefined): boolean {
  const allowed = libraryMethods(path);
  if (method === "OPTIONS") return preflightMethod !== undefined && allowed.includes(preflightMethod.toUpperCase());
  return allowed.includes(method);
}

/** CORS headers for an allowed library request. Vary: Origin keeps caches from mixing origins. */
export function corsHeaders(origin: string, path: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": libraryMethods(path).join(", "),
    "Access-Control-Allow-Headers": "content-type, range",
    "Access-Control-Expose-Headers": "content-length, content-range, accept-ranges",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
