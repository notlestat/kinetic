import { describe, expect, it } from "vitest";
import { isMinifiedName, isSecretKey, looksSecret, sanitizeProps, sanitizeValue } from "./component-props.ts";

describe("isSecretKey", () => {
  it("matches credential words without catching ordinary names", () => {
    for (const key of ["apiToken", "token", "api_key", "x-api-key", "clientSecret", "password", "sessionId", "authorization", "privateKey"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ["author", "authorName", "keyboard", "tokenizer", "sessions_count_label", "title", "monkey"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe("looksSecret", () => {
  it("flags JWTs, key prefixes, bearer headers and long random runs", () => {
    expect(looksSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toBe(true);
    expect(looksSecret("sk_live_abcdefgh12345678")).toBe(true);
    expect(looksSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
    expect(looksSecret("Bearer abcdef123456789")).toBe(true);
    expect(looksSecret("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")).toBe(true);
    expect(looksSecret("Choose the plan that fits your team")).toBe(false);
    expect(looksSecret("https://example.com/images/hero.png")).toBe(false);
  });
});

describe("sanitizeValue and sanitizeProps", () => {
  it("replaces functions and React elements and cuts off big values", () => {
    const element = { $$typeof: Symbol.for("react.transitional.element"), type: "div", props: {} };
    const big = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const out = sanitizeValue({ fn: () => 0, element, big, list: Array.from({ length: 15 }, (_, i) => i), deep: { a: { b: { c: 1 } } } }) as Record<string, unknown>;
    expect(out.fn).toBe("[function]");
    expect(out.element).toBe("[element]");
    expect(Object.keys(out.big as object)).toHaveLength(21);
    expect((out.big as Record<string, unknown>)["…"]).toBe("10 more keys");
    expect((out.list as unknown[]).at(-1)).toBe("… 5 more");
    expect(out.deep).toEqual({ a: { b: "[object]" } });
  });

  it("drops children and credentials from props", () => {
    expect(
      sanitizeProps({ children: ["x"], apiToken: "abc", label: "Go", config: { secretKey: "x", size: 2 }, hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b" }),
    ).toEqual({ label: "Go", config: { size: 2 } });
  });

  it("uses the caller's describe hook for host values", () => {
    const node = { nodeType: 1 };
    expect(sanitizeProps({ anchor: node }, (v) => (v === node ? "div.anchor" : undefined))).toEqual({ anchor: "div.anchor" });
  });
});

describe("isMinifiedName", () => {
  it("flags short and generated names", () => {
    for (const name of [undefined, "", "t", "Xe", "a1", "_e", "Anonymous"]) expect(isMinifiedName(name), String(name)).toBe(true);
    for (const name of ["Card", "PlanCard", "motion.div", "Row"]) expect(isMinifiedName(name), name).toBe(false);
  });
});
