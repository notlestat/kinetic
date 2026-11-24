import { describe, expect, it } from "vitest";
import { MAX_ATTRIBUTE_NUMBERS, MAX_IMAGE_CHARS, shaderSlug, shadowMapTypeName, stripSceneJson, toneMappingName, uniformValue } from "./three-scene.ts";

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
