import { describe, expect, it } from "vitest";
import sample from "../fixtures/sample-capture.json" with { type: "json" };
import { type MotionEntry, MotionEntrySchema, MotionSummarySchema } from "./capture.ts";
import { summariseMotion } from "./motion-summary.ts";

const base = MotionEntrySchema.parse(sample.motion.entries[0]);
const entry = (source: MotionEntry["source"], trigger: MotionEntry["trigger"] = "hover"): MotionEntry => ({
  ...base,
  source,
  trigger,
});

describe("summariseMotion", () => {
  it("counts by source and lists the triggers", () => {
    const summary = summariseMotion([entry("css-transition"), entry("css-transition", "focus"), entry("waapi", "loop")]);
    expect(summary).toEqual({
      total: 3,
      bySource: { "css-transition": 2, waapi: 1 },
      triggers: ["focus", "hover", "loop"],
      primary: "css",
      suggestedLibrary: "framer-motion",
    });
    expect(MotionSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("picks GSAP when GSAP and ScrollTrigger entries outnumber CSS ones", () => {
    const summary = summariseMotion([entry("gsap"), entry("scrolltrigger", "scroll"), entry("css-transition")]);
    expect(summary.primary).toBe("gsap");
    expect(summary.suggestedLibrary).toBe("gsap");
  });

  it("lets GSAP win a tie with CSS", () => {
    expect(summariseMotion([entry("gsap"), entry("css-transition")]).primary).toBe("gsap");
  });

  it("suggests React Three Fiber whenever three.js motion exists", () => {
    const summary = summariseMotion([entry("gsap"), entry("gsap"), entry("three", "loop")]);
    expect(summary.primary).toBe("gsap");
    expect(summary.suggestedLibrary).toBe("react-three-fiber");
  });

  it("handles no motion", () => {
    expect(summariseMotion([])).toMatchObject({ total: 0, primary: "none", suggestedLibrary: "framer-motion" });
  });
});
