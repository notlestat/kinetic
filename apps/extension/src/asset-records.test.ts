import { MotionEntrySchema } from "@kinetic/schema";
import { describe, expect, it } from "vitest";
import { type AssetRecord, assetFileName, assetKindForUrl, fromAssetRecords, isLottieJson, lottieTiming, mergeAssetRecords, toAssetsBlock } from "./asset-records.ts";
import { networkCandidateKind, resolveNetworkAssets } from "./cdp-network.ts";
import { mergeMotion } from "./motion-normalise.ts";

const lottie = { v: "5.7.4", fr: 30, ip: 0, op: 60, w: 200, h: 200, nm: "Pulse", layers: [{}], markers: [{ tm: 0, cm: "start" }] };

describe("asset helpers", () => {
  it("classifies URLs and recognises Lottie JSON", () => {
    expect(assetKindForUrl("https://cdn.example.com/a/hero.lottie?v=2")).toBe("dotlottie");
    expect(assetKindForUrl("https://cdn.example.com/a/hero.riv")).toBe("rive");
    expect(assetKindForUrl("https://prod.spline.design/abc/scene.splinecode")).toBe("spline");
    expect(assetKindForUrl("https://example.com/data.json")).toBe("json");
    expect(assetKindForUrl("https://example.com/app.js")).toBeUndefined();
    expect(assetKindForUrl("not a url")).toBeUndefined();
    expect(isLottieJson(lottie)).toBe(true);
    expect(isLottieJson({ v: "1", fr: 30 })).toBe(false);
    expect(lottieTiming(lottie)).toEqual({ frameRate: 30, inPoint: 0, outPoint: 60, width: 200, height: 200, layers: 1, markers: ["start"], name: "Pulse" });
  });

  it("names files safely in assets/", () => {
    expect(assetFileName("http://127.0.0.1:5180/lottie/pulse.json", "lottie", 0)).toBe("assets/pulse-1.json");
    expect(assetFileName("https://x.test/a/My%20Hero..riv", "rive", 1)).toBe("assets/my-20hero-2.riv");
    expect(assetFileName("https://x.test/page#kinetic-inline-lottie-1", "lottie", 2)).toBe("assets/lottie-3.json");
    expect(assetFileName("https://x.test/", "spline", 0)).toBe("assets/spline-1.splinecode");
  });

  it("merges records by URL and builds the assets block", () => {
    const merged = mergeAssetRecords(
      [{ kind: "lottie", url: "https://x.test/a.json", target: null, foundBy: "resource-timing" }],
      [{ kind: "lottie", url: "https://x.test/a.json", target: "div.a", foundBy: "network", file: "assets/a-1.json" }],
    );
    expect(merged).toEqual([{ kind: "lottie", url: "https://x.test/a.json", target: "div.a", foundBy: "resource-timing", file: "assets/a-1.json" }]);
    expect(toAssetsBlock(merged)).toEqual([{ kind: "lottie", url: "https://x.test/a.json", file: "assets/a-1.json" }]);
  });
});

describe("fromAssetRecords", () => {
  it("gives Lottie entries exact timing from the file and the player's playback", () => {
    const records: AssetRecord[] = [
      { kind: "lottie", url: "https://x.test/a.json", target: "div.a", foundBy: "lottie-player", timing: lottieTiming(lottie), playback: { loop: true, autoplay: true, speed: 2 } },
      { kind: "lottie", url: "https://x.test/b.json", target: "div.b", foundBy: "resource-timing", timing: lottieTiming(lottie) },
      { kind: "dotlottie", url: "https://x.test/c.lottie", target: "div.c", foundBy: "dotlottie-player", playback: { hover: true, loop: false } },
      { kind: "rive", url: "https://x.test/d.riv", target: "canvas", foundBy: "resource-timing" },
      { kind: "spline", url: "https://x.test/e.splinecode", target: null, foundBy: "network" },
    ];
    const entries = mergeMotion(fromAssetRecords(records));
    for (const entry of entries) expect(MotionEntrySchema.safeParse(entry).success).toBe(true);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ source: "lottie", trigger: "load", duration: 1000, iterations: "infinite", confidence: "exact" });
    // Unknown playback: lottie-web's defaults (loop, autoplay), so near.
    expect(entries[1]).toMatchObject({ duration: 2000, iterations: "infinite", confidence: "near" });
    expect(entries[2]).toMatchObject({ source: "lottie", trigger: "hover", iterations: 1, properties: [], confidence: "approximate" });
    expect(entries[3]).toMatchObject({ source: "rive", target: "canvas", trigger: "load" });
  });
});

describe("network assets", () => {
  it("picks candidates by extension, or JSON from fetch and XHR", () => {
    expect(networkCandidateKind("https://x.test/a.riv", "application/octet-stream", "Other")).toBe("rive");
    expect(networkCandidateKind("https://x.test/api/anim", "application/json", "Fetch")).toBe("json");
    expect(networkCandidateKind("https://x.test/api/anim", "application/json", "Script")).toBeUndefined();
    expect(networkCandidateKind("data:application/json,{}", "application/json", "Fetch")).toBeUndefined();
  });

  it("adds files to known URLs and fills unresolved players of the same kind", () => {
    const { records, files } = resolveNetworkAssets(
      [{ kind: "lottie", url: "https://x.test/a.json", target: "div.a", foundBy: "lottie-web" }],
      [{ kind: "rive", target: "canvas.hero" }],
      [
        { record: { kind: "lottie", url: "https://x.test/a.json", target: null, foundBy: "network", file: "assets/a-2.json", timing: lottieTiming(lottie) }, base64: "e30=" },
        { record: { kind: "rive", url: "https://x.test/hero.riv", target: null, foundBy: "network", file: "assets/hero-3.riv" }, base64: "AAAA" },
        { record: { kind: "spline", url: "https://x.test/s.splinecode", target: null, foundBy: "network", file: "assets/s-4.splinecode" }, base64: "AAAA" },
      ],
    );
    expect(records).toEqual([
      { kind: "lottie", url: "https://x.test/a.json", target: "div.a", foundBy: "lottie-web", file: "assets/a-2.json", timing: lottieTiming(lottie) },
      { kind: "rive", url: "https://x.test/hero.riv", target: "canvas.hero", foundBy: "network", file: "assets/hero-3.riv" },
    ]);
    expect(files.map((f) => f.path)).toEqual(["assets/a-2.json", "assets/hero-3.riv"]);
  });
});
