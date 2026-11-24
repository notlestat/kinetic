import { describe, expect, it } from "vitest";
import { tokenize } from "./highlight.ts";
import { parseInline, parseMarkdown } from "./markdown.ts";
import { followerTime, formatClock, needsSeek } from "./sync.ts";

describe("tokenize", () => {
  const source = `import { motion } from "framer-motion";
// The lift on hover
export default function Card({ label = 'Go' }: { label?: string }) {
  return <motion.button whileHover={{ y: -4 }} className="rounded-[16px]">{label} {1.5}</motion.button>;
}
const evil = "<img src=x onerror=alert(1)>";`;

  it("keeps every character, in order", () => {
    expect(tokenize(source).map((t) => t.text).join("")).toBe(source);
  });

  it("marks keywords, strings, comments, numbers, tags and attributes", () => {
    const tokens = tokenize(source);
    const of = (kind: string) => tokens.filter((t) => t.kind === kind).map((t) => t.text);
    expect(of("keyword")).toEqual(expect.arrayContaining(["import", "from", "export", "default", "function", "return", "const"]));
    expect(of("string")).toEqual(expect.arrayContaining(['"framer-motion"', "'Go'", '"rounded-[16px]"', '"<img src=x onerror=alert(1)>"']));
    expect(of("comment")).toEqual(["// The lift on hover"]);
    expect(of("number")).toEqual(expect.arrayContaining(["4", "1.5"]));
    expect(of("tag")).toEqual(expect.arrayContaining(["<motion.button", "</motion.button", ">"]));
    expect(of("attr")).toEqual(["whileHover", "className"]);
  });

  it("copes with unterminated strings and comments", () => {
    for (const broken of ['const a = "open', "/* never closed", "`tpl ${x}"]) {
      expect(tokenize(broken).map((t) => t.text).join("")).toBe(broken);
    }
  });
});

describe("parseMarkdown", () => {
  it("reads headings, paragraphs, lists, quotes and code fences", () => {
    const md = "# Taste\n\nSoft lift,\nspringy press.\n\n- one\n- two\n  continued\n\n1. first\n2. second\n\n> quoted\n\n```tsx\n<b>raw</b>\n```\n";
    expect(parseMarkdown(md)).toEqual([
      { kind: "heading", level: 1, text: "Taste" },
      { kind: "paragraph", text: "Soft lift, springy press." },
      { kind: "list", ordered: false, items: ["one", "two continued"] },
      { kind: "list", ordered: true, items: ["first", "second"] },
      { kind: "quote", text: "quoted" },
      { kind: "code", text: "<b>raw</b>" },
    ]);
  });

  it("splits inline code, strong, em and link text", () => {
    expect(parseInline("Use `ease-out` for **lift**, *not* [docs](http://x).")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "code", text: "ease-out" },
      { kind: "text", text: " for " },
      { kind: "strong", text: "lift" },
      { kind: "text", text: ", " },
      { kind: "em", text: "not" },
      { kind: "text", text: " " },
      { kind: "text", text: "docs" },
      { kind: "text", text: "." },
    ]);
  });
});

describe("video sync", () => {
  it("follows the leader, holding the follower's last frame when it is shorter", () => {
    expect(followerTime(2, 5)).toBe(2);
    expect(followerTime(6, 5)).toBeCloseTo(4.999);
    expect(followerTime(-1, 5)).toBe(0);
    expect(followerTime(3, Number.NaN)).toBe(3);
  });

  it("seeks only past the drift tolerance", () => {
    expect(needsSeek(2, 2.05, 5)).toBe(false);
    expect(needsSeek(2, 2.2, 5)).toBe(true);
    expect(needsSeek(6, 4.99, 5)).toBe(false);
    expect(formatClock(63.25)).toBe("1:03.3");
    expect(formatClock(Number.NaN)).toBe("0:00.0");
  });
});
