import { describe, expect, it } from "vitest";
import { beatsMainScene, isFullScreenPass, MAX_ATTRIBUTE_NUMBERS, MAX_IMAGE_CHARS, MAX_OUTLINE_NODES, sceneOutline, shaderSlug, shadowMapTypeName, stripSceneJson, toneMappingName, uniformValue } from "./three-scene.ts";

describe("stripSceneJson", () => {
  it("leaves out big attributes and images but keeps geometry type, parameters and counts", () => {
    const big = Array.from({ length: MAX_ATTRIBUTE_NUMBERS + 3 }, (_, i) => i);
    const json = {
      geometries: [
        { uuid: "a", type: "TorusKnotGeometry", radius: 1, tube: 0.32 },
        { uuid: "b", type: "BufferGeometry", data: { attributes: { position: { itemSize: 3, type: "Float32Array", array: big }, uv: { itemSize: 2, type: "Float32Array", array: [0, 1] } }, index: { type: "Uint16Array", array: [0, 1, 2] } } },
      ],
      images: [{ uuid: "i", url: `data:image/png;base64,${"A".repeat(MAX_IMAGE_CHARS + 1)}` }, { uuid: "j", url: "data:image/png;base64,AAAA" }],
    };
    const stripped = stripSceneJson(json);
    expect(stripped).toEqual([
      { path: "geometries[1].data.attributes.position", reason: expect.stringContaining("attribute data"), size: MAX_ATTRIBUTE_NUMBERS + 3 },
      { path: "images[0].url", reason: expect.stringContaining("embedded image"), size: MAX_IMAGE_CHARS + 23 },
    ]);
    const position = (json.geometries[1] as { data: { attributes: { position: Record<string, unknown> } } }).data.attributes.position;
    expect(position).toMatchObject({ array: [], stripped: true, count: Math.floor((MAX_ATTRIBUTE_NUMBERS + 3) / 3), itemSize: 3, type: "Float32Array" });
    expect(json.geometries[0]).toEqual({ uuid: "a", type: "TorusKnotGeometry", radius: 1, tube: 0.32 });
    expect(json.images[0]?.url).toBe("[stripped]");
    expect(json.images[1]?.url).toBe("data:image/png;base64,AAAA");
  });
});

describe("constants and uniforms", () => {
  it("names tone mapping and shadow map constants", () => {
    expect(toneMappingName(4)).toBe("ACESFilmicToneMapping");
    expect(toneMappingName(6)).toBe("AgXToneMapping");
    expect(shadowMapTypeName(1)).toBe("PCFShadowMap");
    expect(toneMappingName(undefined)).toBe("unknown");
  });

  it("turns uniform values into plain JSON", () => {
    expect(uniformValue(1.234567)).toBe(1.2346);
    expect(uniformValue({ isColor: true, getHexString: () => "635bff" })).toBe("#635bff");
    expect(uniformValue({ isVector2: true, x: 1, y: 2 })).toEqual([1, 2]);
    expect(uniformValue({ isVector3: true, x: 1, y: 2, z: 3 })).toEqual([1, 2, 3]);
    expect(uniformValue({ isTexture: true, name: "noise", uuid: "t", image: { width: 64, height: 32 } })).toEqual({ texture: "noise", width: 64, height: 32 });
    expect(uniformValue({ elements: [1, 0, 0, 1] })).toEqual([1, 0, 0, 1]);
    expect(uniformValue(new Float32Array([0.5, 0.25]))).toEqual([0.5, 0.25]);
  });

  it("makes file-safe shader slugs", () => {
    expect(shaderSlug("HeroGlow", "ShaderMaterial", 0)).toBe("hero-glow-1");
    expect(shaderSlug("", "RawShaderMaterial", 2)).toBe("raw-shader-material-3");
    expect(shaderSlug("../../etc passwd", "ShaderMaterial", 0)).toBe("etc-passwd-1");
  });
});

describe("main scene choice", () => {
  const mesh = { isMesh: true, children: [] };
  const group = { children: [mesh, mesh] };

  it("treats a scene holding only one childless mesh as a full-screen pass", () => {
    expect(isFullScreenPass({ children: [mesh] })).toBe(true);
    expect(isFullScreenPass({ children: [mesh, mesh] })).toBe(false);
    expect(isFullScreenPass({ children: [{ isMesh: true, children: [mesh] }] })).toBe(false);
    expect(isFullScreenPass({ children: [group] })).toBe(false);
    expect(isFullScreenPass({ children: [] })).toBe(false);
  });

  it("prefers a real scene over a pass drawn more often, then the most drawn scene", () => {
    // A blur pass drawn five times a frame must not replace the real scene.
    expect(beatsMainScene({ count: 50, pass: true }, { count: 10, pass: false })).toBe(false);
    expect(beatsMainScene({ count: 1, pass: false }, { count: 50, pass: true })).toBe(true);
    expect(beatsMainScene({ count: 11, pass: false }, { count: 10, pass: false })).toBe(true);
    expect(beatsMainScene({ count: 10, pass: false }, { count: 10, pass: false })).toBe(false);
    // With nothing else drawn, a single full-screen shader is still the main scene.
    expect(beatsMainScene({ count: 1, pass: true }, undefined)).toBe(true);
  });
});

describe("sceneOutline", () => {
  const zero = { x: 0, y: 0, z: 0 };
  const one = { x: 1, y: 1, z: 1 };
  const object = (type: string, extra: Record<string, unknown> = {}) => ({ type, position: zero, rotation: zero, scale: one, children: [], ...extra });

  it("keeps objects, transforms, plain geometry parameters and material names", () => {
    const logo = object("Mesh", {
      name: "Logo",
      position: { x: 1.234567, y: 0, z: -2 },
      geometry: { type: "TorusGeometry", parameters: { radius: 1, tube: 0.2, buffer: new Float32Array(3), nested: { a: 1 } } },
      material: [{ type: "ShaderMaterial", name: "Glass" }, { type: "MeshBasicMaterial", name: "" }],
    });
    const hidden = object("Group", { visible: false });
    const outline = sceneOutline(object("Scene", { children: [logo, hidden] }), "toJSON returned nothing");
    expect(outline.metadata).toMatchObject({ type: "KineticSceneOutline", reason: "toJSON returned nothing" });
    expect(outline.object).toEqual({
      type: "Scene",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      children: [
        {
          type: "Mesh",
          name: "Logo",
          position: [1.2346, 0, -2],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          geometry: { type: "TorusGeometry", parameters: { radius: 1, tube: 0.2 } },
          materials: [{ type: "ShaderMaterial", name: "Glass" }, { type: "MeshBasicMaterial" }],
        },
        { type: "Group", visible: false, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      ],
    });
  });

  it("stops at the object limit and says so", () => {
    const many = Array.from({ length: MAX_OUTLINE_NODES + 5 }, () => object("Mesh"));
    const outline = sceneOutline(object("Scene", { children: many }), "x");
    expect((outline.object as { children: unknown[] }).children).toHaveLength(MAX_OUTLINE_NODES - 1);
    expect(outline.metadata).toMatchObject({ truncatedAt: MAX_OUTLINE_NODES });
  });
});
