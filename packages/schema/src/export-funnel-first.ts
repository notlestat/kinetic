// Export a capture's design tokens for funnel-first.
//
// PLACEHOLDER: funnel-first's token format file has not been provided yet. This
// adapter writes a neutral, documented shape so the library's export button works
// end to end. When the format file arrives, replace FunnelFirstTokens and
// toFunnelFirstTokens below with its real shape; the call sites stay the same.

import type { Capture, Font, Tokens } from "./capture.ts";

export const FUNNEL_FIRST_FORMAT = "kinetic/funnel-first-placeholder";
export const FUNNEL_FIRST_VERSION = 0;

export interface FunnelFirstTokens {
  /** Marks the file as the placeholder until the real format replaces it. */
  format: typeof FUNNEL_FIRST_FORMAT;
  version: typeof FUNNEL_FIRST_VERSION;
  source: { url: string; site: string; slug: string; capturedAt: string };
  /** Token groups keyed by token name, with CSS values exactly as captured. */
  tokens: { color: Record<string, string>; fontSize: Record<string, string>; space: Record<string, string>; radius: Record<string, string>; shadow: Record<string, string> };
  fonts: { family: string; weight: string; style: string }[];
}

const EMPTY_TOKENS: Tokens = { colors: {}, fontSizes: {}, spacing: {}, radii: {}, shadows: {} };

/** One entry per family, weight and style; font file URLs stay out of the export. */
function uniqueFonts(fonts: readonly Font[]): FunnelFirstTokens["fonts"] {
  const seen = new Map<string, FunnelFirstTokens["fonts"][number]>();
  for (const { family, weight, style } of fonts) seen.set(`${family}|${weight}|${style}`, { family, weight, style });
  return [...seen.values()];
}

export function toFunnelFirstTokens(capture: Capture): FunnelFirstTokens {
  const tokens = capture.styles?.tokens ?? EMPTY_TOKENS;
  return {
    format: FUNNEL_FIRST_FORMAT,
    version: FUNNEL_FIRST_VERSION,
    source: { url: capture.meta.url, site: capture.meta.site, slug: capture.meta.slug, capturedAt: capture.meta.timestamp },
    tokens: {
      color: { ...tokens.colors },
      fontSize: { ...tokens.fontSizes },
      space: { ...tokens.spacing },
      radius: { ...tokens.radii },
      shadow: { ...tokens.shadows },
    },
    fonts: uniqueFonts(capture.styles?.fonts ?? []),
  };
}

/** The file name the library downloads the export as. */
export function funnelFirstFileName(capture: Capture): string {
  return `${capture.meta.site}-${capture.meta.slug}.funnel-first.json`;
}
