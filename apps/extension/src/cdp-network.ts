// The CDP Network domain during a capture: catches the animation files (Lottie
// JSON, .lottie, .riv, .splinecode) the page fetches while the debugger is
// attached, which covers the motion pass and the optional reload for load
// animations. Files fetched before the capture are found by the MAIN world.

import { type AnimationAssetKind, type AssetRecord, assetFileName, assetKindForUrl, isLottieJson, lottieTiming } from "./asset-records.ts";
import type { CdpSession } from "./cdp.ts";
import { bytesToBase64, type CaptureFile, textToBase64 } from "./messages.ts";

const MAX_BODY_BYTES = 15 * 1024 * 1024;
const MAX_CANDIDATES = 20;

interface Candidate {
  url: string;
  kind: AnimationAssetKind | "json";
  finished: boolean;
}

/** A file the Network domain caught: the decoded body, and a record without a target yet. */
export interface NetworkAsset {
  record: AssetRecord;
  /** The response body as base64, ready for POST /capture/file. */
  base64: string;
}

/** True for responses that may be an animation file: by extension, or JSON from fetch or XHR. */
export function networkCandidateKind(url: string, mimeType: string, resourceType: string): AnimationAssetKind | "json" | undefined {
  const byUrl = assetKindForUrl(url);
  if (byUrl) return byUrl;
  if (/json/i.test(mimeType) && (resourceType === "Fetch" || resourceType === "XHR")) {
    try {
      const protocol = new URL(url).protocol;
      return protocol === "http:" || protocol === "https:" ? "json" : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class NetworkRecorder {
  private readonly candidates = new Map<string, Candidate>();
  private readonly offs: (() => void)[] = [];
  private enabled = false;

  constructor(private readonly session: CdpSession) {}

  async start(): Promise<void> {
    try {
      await this.session.send("Network.enable", { maxResourceBufferSize: MAX_BODY_BYTES, maxTotalBufferSize: MAX_BODY_BYTES * 4 });
      this.enabled = true;
    } catch {
      return; // The page cannot be debugged at this level; the MAIN world still finds cached files.
    }
    this.offs.push(
      this.session.on("Network.responseReceived", (params) => {
        const { requestId, response, type } = params as { requestId: string; response: { url: string; mimeType: string }; type: string };
        if (this.candidates.size >= MAX_CANDIDATES) return;
        const kind = networkCandidateKind(response.url, response.mimeType, type);
        if (kind) this.candidates.set(requestId, { url: response.url, kind, finished: false });
      }),
      this.session.on("Network.loadingFinished", (params) => {
        const candidate = this.candidates.get((params as { requestId: string }).requestId);
        if (candidate) candidate.finished = true;
      }),
    );
  }

  /** Reads the bodies of finished candidates. JSON only counts when it is a Lottie file. */
  async finish(firstIndex: number): Promise<NetworkAsset[]> {
    for (const off of this.offs.splice(0)) off();
    const assets: NetworkAsset[] = [];
    if (!this.enabled) return assets;
    const seen = new Set<string>();
    for (const [requestId, candidate] of this.candidates) {
      if (!candidate.finished || seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      let body: { body: string; base64Encoded: boolean };
      try {
        body = await this.session.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId });
      } catch {
        continue; // Evicted from the buffer, or a redirect.
      }
      if (body.body.length > MAX_BODY_BYTES * 1.4) continue;
      const index = firstIndex + assets.length;
      if (candidate.kind === "json") {
        const text = body.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(body.body), (c) => c.charCodeAt(0))) : body.body;
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          continue;
        }
        if (!isLottieJson(json)) continue;
        assets.push({
          record: { kind: "lottie", url: candidate.url, target: null, foundBy: "network", timing: lottieTiming(json), file: assetFileName(candidate.url, "lottie", index) },
          base64: textToBase64(text),
        });
      } else {
        const base64 = body.base64Encoded ? body.body : bytesToBase64(new TextEncoder().encode(body.body));
        assets.push({
          record: { kind: candidate.kind, url: candidate.url, target: null, foundBy: "network", file: assetFileName(candidate.url, candidate.kind, index) },
          base64,
        });
      }
    }
    try {
      await this.session.send("Network.disable");
    } catch {
      // Already detached.
    }
    return assets;
  }
}

/**
 * Adds network assets to the MAIN world's: a URL the MAIN world already has gets
 * the file if it had none, and the rest fill unresolved players of the same kind
 * in order. Network files that match nothing in the selection are dropped.
 */
export function resolveNetworkAssets(
  records: readonly AssetRecord[],
  unresolved: readonly { kind: AssetRecord["kind"]; target: string }[],
  network: readonly NetworkAsset[],
): { records: AssetRecord[]; files: CaptureFile[] } {
  const out = records.map((r) => ({ ...r }));
  const files: CaptureFile[] = [];
  const open = [...unresolved];
  for (const asset of network) {
    const existing = out.find((r) => r.url === asset.record.url);
    if (existing) {
      if (!existing.file && asset.record.file) {
        existing.file = asset.record.file;
        if (!existing.timing && asset.record.timing) existing.timing = asset.record.timing;
        files.push({ path: asset.record.file, contentBase64: asset.base64 });
      }
      continue;
    }
    const slotIndex = open.findIndex((u) => u.kind === asset.record.kind || (u.kind === "lottie" && asset.record.kind === "dotlottie"));
    if (slotIndex < 0) continue;
    const [slot] = open.splice(slotIndex, 1);
    out.push({ ...asset.record, target: slot?.target ?? null });
    if (asset.record.file) files.push({ path: asset.record.file, contentBase64: asset.base64 });
  }
  return { records: out, files };
}
