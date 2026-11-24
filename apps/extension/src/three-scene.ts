// three.js scene data as it goes into three/scene.json, three/shaders/ and the
// three block. Pure: tests pass plain objects shaped like three.js output.

/** Typed-array data longer than this (in numbers, about 100 kB of JSON) is left out of scene.json. */
export const MAX_ATTRIBUTE_NUMBERS = 10_000;
/** Embedded images (data URLs) longer than this (in characters) are left out of scene.json. */
export const MAX_IMAGE_CHARS = 200_000;

export interface StrippedItem {
  /** Where in scene.json the data was, e.g. "geometries[2].data.attributes.position". */
  path: string;
  reason: string;
  /** How many numbers or characters were left out. */
  size: number;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replaces a big attribute's array with nothing but its shape: count, item size and type stay. */
function stripAttribute(attribute: Json, path: string, stripped: StrippedItem[]): void {
  const array = attribute.array;
  if (!Array.isArray(array) || array.length <= MAX_ATTRIBUTE_NUMBERS) return;
  const itemSize = typeof attribute.itemSize === "number" ? attribute.itemSize : 1;
  attribute.count = Math.floor(array.length / itemSize);
  attribute.array = [];
  attribute.stripped = true;
  stripped.push({ path, reason: `attribute data above ${MAX_ATTRIBUTE_NUMBERS} numbers`, size: array.length });
}

/**
 * Leaves big binary data out of scene.toJSON() output in place: geometry
 * attributes and index arrays above MAX_ATTRIBUTE_NUMBERS, and embedded images
 * above MAX_IMAGE_CHARS. Geometry type, parameters and counts stay.
 */
export function stripSceneJson(json: Json): StrippedItem[] {
  const stripped: StrippedItem[] = [];
  const geometries = Array.isArray(json.geometries) ? json.geometries : [];
  geometries.forEach((geometry, i) => {
    if (!isObject(geometry) || !isObject(geometry.data)) return;
    const data = geometry.data;
    if (isObject(data.attributes)) {
      for (const [name, attribute] of Object.entries(data.attributes)) {
        if (isObject(attribute)) stripAttribute(attribute, `geometries[${i}].data.attributes.${name}`, stripped);
      }
    }
    if (isObject(data.morphAttributes)) {
      for (const [name, list] of Object.entries(data.morphAttributes)) {
        if (!Array.isArray(list)) continue;
        list.forEach((attribute, j) => {
          if (isObject(attribute)) stripAttribute(attribute, `geometries[${i}].data.morphAttributes.${name}[${j}]`, stripped);
        });
      }
    }
    if (isObject(data.index)) stripAttribute(data.index, `geometries[${i}].data.index`, stripped);
  });
  const images = Array.isArray(json.images) ? json.images : [];
  images.forEach((image, i) => {
    if (!isObject(image)) return;
    const strip = (url: unknown, path: string): unknown => {
      if (typeof url === "string" && url.length > MAX_IMAGE_CHARS) {
        stripped.push({ path, reason: `embedded image above ${MAX_IMAGE_CHARS} characters`, size: url.length });
        return "[stripped]";
      }
      return url;
    };
    if (Array.isArray(image.url)) image.url = image.url.map((u, j) => strip(u, `images[${i}].url[${j}]`));
    else image.url = strip(image.url, `images[${i}].url`);
  });
  return stripped;
}

// three.js constants (src/constants.js), by value.
const TONE_MAPPINGS: Record<number, string> = {
  0: "NoToneMapping",
  1: "LinearToneMapping",
  2: "ReinhardToneMapping",
  3: "CineonToneMapping",
  4: "ACESFilmicToneMapping",
  5: "CustomToneMapping",
  6: "AgXToneMapping",
  7: "NeutralToneMapping",
};
const SHADOW_MAP_TYPES: Record<number, string> = {
  0: "BasicShadowMap",
  1: "PCFShadowMap",
  2: "PCFSoftShadowMap",
  3: "VSMShadowMap",
};

export function toneMappingName(value: unknown): string {
  return typeof value === "number" ? (TONE_MAPPINGS[value] ?? `ToneMapping(${value})`) : "unknown";
}

export function shadowMapTypeName(value: unknown): string {
  return typeof value === "number" ? (SHADOW_MAP_TYPES[value] ?? `ShadowMap(${value})`) : "unknown";
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * A uniform value as plain JSON: numbers and booleans as they are, vectors as
 * arrays, colours as hex strings, matrices as their elements, textures by name.
 */
export function uniformValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? round(value) : String(value);
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value !== "object" || depth > 2) return String(value);
  const v = value as Json & { isColor?: boolean; isTexture?: boolean; isVector2?: boolean; isVector3?: boolean; isVector4?: boolean };
  if (v.isColor && typeof (v as { getHexString?: unknown }).getHexString === "function") {
    return `#${(v as unknown as { getHexString(): string }).getHexString()}`;
  }
  if (v.isTexture) {
    const image = v.image as { width?: unknown; height?: unknown } | null | undefined;
    return {
      texture: typeof v.name === "string" && v.name ? v.name : (v.uuid ?? "texture"),
      ...(image && typeof image.width === "number" ? { width: image.width, height: image.height } : {}),
    };
  }
  if (v.isVector2) return [round(Number(v.x)), round(Number(v.y))];
  if (v.isVector3) return [round(Number(v.x)), round(Number(v.y)), round(Number(v.z))];
  if (v.isVector4 || (v as { isQuaternion?: boolean }).isQuaternion) return [round(Number(v.x)), round(Number(v.y)), round(Number(v.z)), round(Number(v.w))];
  if (Array.isArray((v as { elements?: unknown }).elements)) return ((v as { elements: number[] }).elements).map(round);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>).slice(0, 64).map(round);
  if (Array.isArray(value)) return value.slice(0, 64).map((x) => uniformValue(x, depth + 1));
  const out: Json = {};
  for (const [key, inner] of Object.entries(v).slice(0, 20)) out[key] = uniformValue(inner, depth + 1);
  return out;
}

/** A file-name-safe slug for a material: its name, or its type and position. */
export function shaderSlug(name: unknown, type: string, index: number): string {
  const base = typeof name === "string" && name.trim() ? name : type;
  const slug = base
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "material"}-${index + 1}`;
}

/** An outline keeps at most this many objects. */
export const MAX_OUTLINE_NODES = 2000;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The parts of a three.js object an outline reads. */
export interface OutlineSource {
  type: string;
  name?: string;
  visible?: boolean;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  geometry?: { type: string; parameters?: unknown };
  material?: { type: string; name?: string } | readonly { type: string; name?: string }[];
  children: readonly OutlineSource[];
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const vec = (v: Vec3): [number, number, number] => [r4(v.x), r4(v.y), r4(v.z)];

/** Geometry parameters with plain values only: radius, segments and the like. */
function plainParameters(parameters: unknown): Json | undefined {
  if (!isObject(parameters)) return undefined;
  const out: Json = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * scene.json when three.js cannot serialise the scene, which happens when a site's own
 * classes override toJSON. Objects with their transforms, geometry type and parameters
 * and material names, read field by field so nothing the site overrides is called.
 */
export function sceneOutline(root: OutlineSource, reason: string): Json {
  let count = 0;
  const visit = (object: OutlineSource): Json | undefined => {
    if (count >= MAX_OUTLINE_NODES) return undefined;
    count++;
    const node: Json = { type: object.type, position: vec(object.position), rotation: vec(object.rotation), scale: vec(object.scale) };
    if (object.name) node.name = object.name;
    if (object.visible === false) node.visible = false;
    if (object.geometry) {
      const parameters = plainParameters(object.geometry.parameters);
      node.geometry = { type: object.geometry.type, ...(parameters ? { parameters } : {}) };
    }
    if (object.material) {
      const list = Array.isArray(object.material) ? object.material : [object.material];
      node.materials = list.map((m: { type: string; name?: string }) => (m.name ? { type: m.type, name: m.name } : { type: m.type }));
    }
    const children = object.children.map(visit).filter((child): child is Json => child !== undefined);
    if (children.length > 0) node.children = children;
    return node;
  };
  const object = visit(root);
  return {
    metadata: {
      type: "KineticSceneOutline",
      note: "three.js could not serialise this scene, so this is an outline: objects, transforms, geometry and material names.",
      reason,
      ...(count >= MAX_OUTLINE_NODES ? { truncatedAt: MAX_OUTLINE_NODES } : {}),
    },
    object,
  };
}

/**
 * A scene holding nothing but one childless mesh: a full-screen post-processing pass.
 * The postprocessing library wraps each pass's quad in its own Scene, and a blur
 * draws that scene several times per frame, more often than the real scene.
 */
export function isFullScreenPass(scene: { children: readonly { isMesh?: boolean; children: readonly unknown[] }[] }): boolean {
  const [only] = scene.children;
  return scene.children.length === 1 && only?.isMesh === true && only.children.length === 0;
}

export interface SceneTally {
  count: number;
  pass: boolean;
}

/** Whether a scene should replace the current main scene: a real scene beats any pass, then the most drawn wins. */
export function beatsMainScene(candidate: SceneTally, current: SceneTally | undefined): boolean {
  if (!current) return true;
  if (candidate.pass !== current.pass) return !candidate.pass;
  return candidate.count > current.count;
}

/** A transform recorded from one render: position, rotation (Euler XYZ, radians) and scale. */
export interface TransformSample {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface CameraSample {
  position: [number, number, number];
  rotation: [number, number, number];
  fov?: number;
  zoom?: number;
}

export interface CameraPath {
  /** Selector of the renderer's canvas. */
  canvas: string;
  durationMs: number;
  /** One sample per render while nothing scrolled. t is ms from the first render. */
  frames: { t: number; camera: CameraSample; objects: Record<string, TransformSample> }[];
  /** Samples taken after scrolling the page in steps. */
  scroll?: {
    maxScroll: number;
    steps: { scrollY: number; progress: number; camera: CameraSample; objects: Record<string, TransformSample> }[];
  };
}
