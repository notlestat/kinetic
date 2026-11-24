// A small TSX tokenizer for showing Component.tsx as highlighted text. The result
// is rendered as React text nodes inside <span>s, never as HTML, so the rebuild's
// source cannot inject markup or run in the library.

export type TokenKind = "comment" | "string" | "keyword" | "number" | "tag" | "attr" | "punct" | "plain";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set(
  "as async await break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of return satisfies static super switch this throw true try type typeof undefined var void while yield".split(
    " ",
  ),
);

// Order matters: comments and strings first, so their contents are not tokenized again.
const RULES: [TokenKind, RegExp][] = [
  ["comment", /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
  ["string", /`(?:\\[\s\S]|[^\\`])*`?|"(?:\\.|[^\\"\n])*"?|'(?:\\.|[^\\'\n])*'?/y],
  ["tag", /<\/?[A-Za-z][\w.:-]*|\/?>/y],
  ["number", /\b(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b/y],
  ["attr", /[A-Za-z_$][\w$-]*(?==[{"'])/y],
  ["plain", /[A-Za-z_$][\w$]*/y],
  // "<" and ">" are left to the tag rule, except in arrows.
  ["punct", /=>|[{}()[\];,.:?!=+\-*/%&|^~@#]+?(?==>)|[{}()[\];,.:?!=+\-*/%&|^~@#]+/y],
  ["plain", /\s+|./y],
];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    for (const [kind, rule] of RULES) {
      rule.lastIndex = i;
      const m = rule.exec(source);
      if (!m || m[0] === "") continue;
      const text = m[0];
      const resolved: TokenKind = kind === "plain" && KEYWORDS.has(text) ? "keyword" : kind;
      const last = tokens.at(-1);
      if (last && last.kind === resolved && (resolved === "plain" || resolved === "punct")) last.text += text;
      else tokens.push({ kind: resolved, text });
      i += text.length;
      break;
    }
  }
  return tokens;
}
