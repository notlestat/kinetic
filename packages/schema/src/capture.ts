import { z } from "zod";
import { PATH_SEGMENT_PATTERN } from "./patterns.ts";

/*
 * capture.json schema: the source of truth for one captured component.
 *
 * Each section lives in its own block below. Feature branches extend only
 * their own block, which keeps merge conflicts small. Every feature section is
 * optional on the capture, because each one is filled in by a different part
 * of the pipeline (extension, companion recorder, rebuild).
 */

// ─── Shared primitives ───────────────────────────────────────────────────────

/** One path segment for library/<site>/<slug>/. Starts with a letter or digit, so "." and ".." can never match. */
export const PathSegmentSchema = z
  .string()
  .regex(PATH_SEGMENT_PATTERN, "must be a single safe path segment");

/** A file path inside the capture folder, e.g. "states/hover.png". Never absolute and never climbs out with "..". */
export const RelativeFilePathSchema = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."),
    "must be a relative path inside the capture folder",
  );

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

// ─── meta ────────────────────────────────────────────────────────────────────

export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

export const MetaSchema = z.object({
  url: z.url(),
  /** Hostname-based folder name, e.g. "stripe.com". */
  site: PathSegmentSchema,
  /** Component folder name, e.g. "hero-cta". */
  slug: PathSegmentSchema,
  /** ISO 8601 time the capture was taken. */
  timestamp: z.iso.datetime({ offset: true }),
  viewport: ViewportSchema,
  /** CSS selector that finds the captured element on the page. */
  selector: z.string().min(1),
  title: z.string().optional(),
});
export type Meta = z.infer<typeof MetaSchema>;

// ─── dom (dom.html) ──────────────────────────────────────────────────────────

export const DomSchema = z.object({
  /** Cleaned outerHTML of the component. */
  html: z.string(),
});
export type Dom = z.infer<typeof DomSchema>;

// ─── styles (styles.json) ────────────────────────────────────────────────────

export const StyledNodeSchema = z.object({
  /** Selector relative to the page, unique within the capture. */
  selector: z.string(),
  tag: z.string(),
  box: BoundingBoxSchema,
  /** Computed styles that differ from the browser default, or a token name. */
  styles: z.record(z.string(), z.string()),
});
export type StyledNode = z.infer<typeof StyledNodeSchema>;

export const FontSchema = z.object({
  family: z.string(),
  weight: z.string(),
  style: z.string(),
  src: z.url().optional(),
});
export type Font = z.infer<typeof FontSchema>;

/** Token name → raw value, e.g. { "color-1": "#0a2540" }. */
const TokenGroupSchema = z.record(z.string(), z.string());

export const TokensSchema = z.object({
  colors: TokenGroupSchema,
  fontSizes: TokenGroupSchema,
  spacing: TokenGroupSchema,
  radii: TokenGroupSchema,
  shadows: TokenGroupSchema,
});
export type Tokens = z.infer<typeof TokensSchema>;

export const StylesSchema = z.object({
  nodes: z.array(StyledNodeSchema),
  tokens: TokensSchema.optional(),
  fonts: z.array(FontSchema).optional(),
});
export type Styles = z.infer<typeof StylesSchema>;

// ─── states (states/) ────────────────────────────────────────────────────────

export const StateNameSchema = z.enum(["hover", "focus", "active", "open", "mobile"]);
export type StateName = z.infer<typeof StateNameSchema>;

export const StateSchema = z.object({
  name: StateNameSchema,
  /** The element the state was forced on. */
  target: z.string(),
  /** Selector → only the style properties that changed in this state. */
  changes: z.record(z.string(), z.record(z.string(), z.string())),
  screenshot: RelativeFilePathSchema.optional(),
});
export type State = z.infer<typeof StateSchema>;

export const StatesSchema = z.array(StateSchema);

// ─── motion (motion.json) ────────────────────────────────────────────────────
// MotionEntrySchema is the one normalised shape that every capture method
// writes, from CDP animations to GSAP to frame sampling. Do not fork it.

export const MotionSourceSchema = z.enum([
  "css-transition",
  "css-keyframes",
  "waapi",
  "gsap",
  "scrolltrigger",
  "framer-motion",
  "sampled",
  "three",
  "lottie",
  "rive",
  "spline",
]);
export type MotionSource = z.infer<typeof MotionSourceSchema>;

export const MotionTriggerSchema = z.enum(["load", "hover", "focus", "click", "scroll", "loop", "unknown"]);
export type MotionTrigger = z.infer<typeof MotionTriggerSchema>;

export const ConfidenceSchema = z.enum(["exact", "near", "approximate"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const KeyframeSchema = z.object({
  /** 0 to 1 through the animation. */
  offset: z.number().min(0).max(1),
  value: z.union([z.string(), z.number()]),
});

export const AnimatedPropertySchema = z.object({
  name: z.string(),
  keyframes: z.array(KeyframeSchema).min(1),
});

/** A CSS easing string ("ease-out", "steps(4)") or cubic-bezier control points [x1, y1, x2, y2]. */
export const EasingSchema = z.union([z.string(), z.tuple([z.number(), z.number(), z.number(), z.number()])]);
export type Easing = z.infer<typeof EasingSchema>;

export const ScrollRangeSchema = z.object({
  /** A pixel offset or a ScrollTrigger-style string such as "top center". */
  start: z.union([z.string(), z.number()]),
  end: z.union([z.string(), z.number()]),
  /** true, false, or a smoothing time in seconds, as in ScrollTrigger. */
  scrub: z.union([z.boolean(), z.number()]),
  pin: z.boolean(),
});

export const MotionEntrySchema = z.object({
  id: z.string().min(1),
  source: MotionSourceSchema,
  /** Selector of the animated element. */
  target: z.string(),
  trigger: MotionTriggerSchema,
  properties: z.array(AnimatedPropertySchema),
  /** Milliseconds. */
  duration: z.number().nonnegative(),
  /** Milliseconds. Negative delays are valid in CSS and WAAPI. */
  delay: z.number(),
  easing: EasingSchema,
  /** JSON cannot store Infinity, so an endless loop is the string "infinite". */
  iterations: z.union([z.number().nonnegative(), z.literal("infinite")]),
  direction: z.enum(["normal", "reverse", "alternate", "alternate-reverse"]),
  /** Milliseconds between each target's start. */
  stagger: z.number().optional(),
  scroll: ScrollRangeSchema.optional(),
  confidence: ConfidenceSchema,
  /** Original data from the source, kept for debugging. */
  raw: z.unknown(),
});
export type MotionEntry = z.infer<typeof MotionEntrySchema>;

/** Smooth-scroll libraries change how every scroll animation feels, so the rebuild needs their options. */
export const SmoothScrollSchema = z.object({
  library: z.enum(["lenis"]),
  /** "global" when window.lenis was readable, "class" when only the html.lenis class was found. */
  detectedBy: z.enum(["global", "class"]),
  /** The library's options. Functions are stored as "[function]". */
  options: z.record(z.string(), z.unknown()),
});
export type SmoothScroll = z.infer<typeof SmoothScrollSchema>;

export const MotionSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  bySource: z.partialRecord(MotionSourceSchema, z.number().int().nonnegative()),
  triggers: z.array(MotionTriggerSchema),
  /** The family with the most entries: css covers transitions, keyframes and WAAPI; gsap covers ScrollTrigger. */
  primary: z.enum(["css", "gsap", "framer-motion", "three", "lottie", "rive", "spline", "sampled", "none"]),
  /** The motion library the rebuild should use. */
  suggestedLibrary: z.enum(["framer-motion", "gsap", "react-three-fiber"]),
});
export type MotionSummary = z.infer<typeof MotionSummarySchema>;

export const MotionSchema = z.object({
  entries: z.array(MotionEntrySchema),
  smoothScroll: SmoothScrollSchema.optional(),
  summary: MotionSummarySchema.optional(),
  /** Motion the capture saw but could not read, in plain words. */
  warnings: z.array(z.string()).optional(),
});
export type Motion = z.infer<typeof MotionSchema>;

// ─── framework (framework.json) ──────────────────────────────────────────────
// Components are a flat list linked by parentId, which avoids a recursive schema.

export const FrameworkComponentSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  /** True when the name looks like a minified production name. */
  minified: z.boolean(),
  props: z.record(z.string(), z.unknown()),
  /** Selectors of the DOM nodes this component owns. */
  domNodes: z.array(z.string()),
});
export type FrameworkComponent = z.infer<typeof FrameworkComponentSchema>;

export const SuggestedSplitSchema = z.object({
  name: z.string(),
  domNodes: z.array(z.string()),
});

export const FrameworkSchema = z.object({
  kind: z.enum(["react", "vue", "none"]),
  components: z.array(FrameworkComponentSchema),
  suggestedSplit: z.array(SuggestedSplitSchema).optional(),
});
export type Framework = z.infer<typeof FrameworkSchema>;

// ─── three (three/) ──────────────────────────────────────────────────────────

export const ThreeSchema = z.object({
  revision: z.string().optional(),
  /** "three/scene.json". */
  sceneFile: RelativeFilePathSchema.optional(),
  /** "three/shaders/*.glsl". */
  shaderFiles: z.array(RelativeFilePathSchema),
  /** "three/camera-path.json". */
  cameraPathFile: RelativeFilePathSchema.optional(),
  postProcessing: z.array(z.string()).optional(),
});
export type Three = z.infer<typeof ThreeSchema>;

// ─── assets (assets/) ────────────────────────────────────────────────────────

export const AssetSchema = z.object({
  kind: z.enum(["lottie", "dotlottie", "rive", "spline", "font", "image", "other"]),
  /** Where the asset came from. */
  url: z.url(),
  /** The saved copy, if one was downloaded. */
  file: RelativeFilePathSchema.optional(),
});
export type Asset = z.infer<typeof AssetSchema>;

export const AssetsSchema = z.object({
  files: z.array(AssetSchema),
});
export type Assets = z.infer<typeof AssetsSchema>;

// ─── media (file paths inside the capture folder) ────────────────────────────

export const MediaSchema = z.object({
  /** Screenshot of the component in its default state, e.g. "states/default.png". */
  screenshot: RelativeFilePathSchema.optional(),
  dom: RelativeFilePathSchema.optional(),
  styles: RelativeFilePathSchema.optional(),
  motion: RelativeFilePathSchema.optional(),
  framework: RelativeFilePathSchema.optional(),
  original: RelativeFilePathSchema.optional(),
  component: RelativeFilePathSchema.optional(),
  preview: RelativeFilePathSchema.optional(),
  notes: RelativeFilePathSchema.optional(),
});
export type Media = z.infer<typeof MediaSchema>;

// ─── capture (top level) ─────────────────────────────────────────────────────

export const CAPTURE_SCHEMA_VERSION = 1;

export const CaptureSchema = z.object({
  /** Bump when a change would break existing capture.json files. */
  schemaVersion: z.literal(CAPTURE_SCHEMA_VERSION),
  meta: MetaSchema,
  dom: DomSchema.optional(),
  styles: StylesSchema.optional(),
  states: StatesSchema.optional(),
  motion: MotionSchema.optional(),
  framework: FrameworkSchema.optional(),
  three: ThreeSchema.optional(),
  assets: AssetsSchema.optional(),
  media: MediaSchema.optional(),
});
export type Capture = z.infer<typeof CaptureSchema>;
