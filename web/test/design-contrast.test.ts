// @vitest-environment node
// Plan P1.5, redone for the dark theme (AA 00047 P8.1, spec FR-006b: "contrast is WCAG AA on dark"):
// every text colour the Night Market design puts on a background meets WCAG 2.2 AA (4.5:1 for text;
// 3:1 for large text and for the parts of a control, 1.4.11). The pairs are read from
// web/src/design/tokens.css, so a colour change that breaks contrast fails here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/design/tokens.css', import.meta.url)), 'utf8');
const tokens = new Map<string, string>();
for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) tokens.set(m[1]!, m[2]!.toLowerCase());

const hex = (name: string): string => {
  const v = tokens.get(name);
  if (!v) throw new Error(`no colour token --${name}`);
  return v;
};

/** WCAG 2.x relative luminance of an sRGB colour. */
function luminance(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

export function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

// [foreground, background, minimum ratio, where it is used]
const TEXT = 4.5;
const LARGE_OR_UI = 3;
export const PAIRS: ReadonlyArray<readonly [string, string, number, string]> = [
  // Text on every surface step (AA 00047 P8.1: the dark theme).
  ['ink', 'bg', TEXT, 'body text on the page'],
  ['ink', 'surface', TEXT, 'text in cards'],
  ['ink', 'surface-2', TEXT, 'text in raised cards, menus, toasts'],
  ['ink', 'surface-3', TEXT, 'the selected line, chips'],
  ['ink', 'surface-hover', TEXT, 'a hovered secondary button'],
  ['ink', 'field', TEXT, 'typed text in a field'],
  ['slate', 'bg', TEXT, 'ledes'],
  ['slate', 'surface', TEXT, 'secondary text in cards'],
  ['slate', 'surface-2', TEXT, 'secondary text in raised cards'],
  ['slate', 'surface-3', TEXT, 'grey badges, kind chips'],
  ['muted', 'bg', TEXT, 'captions on the page, the footer'],
  ['muted', 'surface', TEXT, 'table heads, notes, hints'],
  ['muted', 'surface-2', TEXT, 'labels on the price tiles, the dock'],
  ['muted', 'surface-3', TEXT, 'a caption on the selected line'],
  ['muted', 'field', TEXT, 'unit suffixes, placeholders'],
  // Accents as text.
  ['violet-ink', 'surface', TEXT, 'the current tab icon, eyebrows'],
  ['violet-ink', 'violet-soft', TEXT, 'violet badges, step numbers'],
  ['slate', 'violet-soft', TEXT, 'the fingerprint line'],
  ['link', 'bg', TEXT, 'links on the page'],
  ['link', 'surface', TEXT, 'links in cards'],
  ['link', 'surface-2', TEXT, 'links in raised cards'],
  ['link', 'info-soft', TEXT, 'links in an info notice'],
  // Buy, sell and states.
  ['buy', 'surface', TEXT, 'bids, "Live", success'],
  ['buy', 'surface-3', TEXT, 'a bid on the selected line'],
  ['buy', 'buy-soft', TEXT, 'green badges, the chosen Buy side'],
  ['sell', 'surface', TEXT, 'asks, errors'],
  ['sell', 'surface-3', TEXT, 'an ask on the selected line'],
  ['sell', 'sell-soft', TEXT, 'red badges, the chosen Sell side'],
  ['warn', 'surface', TEXT, 'the current stage, "in progress"'],
  ['warn', 'warn-soft', TEXT, 'warning notices, "Your offer"'],
  ['danger', 'danger-soft', TEXT, 'danger notices, error toasts'],
  ['danger', 'surface-2', TEXT, 'field errors'],
  ['ink', 'buy-soft', TEXT, 'body text in a success notice'],
  ['ink', 'sell-soft', TEXT, 'body text in an error toast'],
  ['ink', 'warn-soft', TEXT, 'body text in a warning notice'],
  ['ink', 'danger-soft', TEXT, 'body text in a danger notice'],
  ['ink', 'info-soft', TEXT, 'body text in an info notice'],
  ['muted', 'buy-soft', TEXT, 'a caption in a success notice'],
  ['muted', 'sell-soft', TEXT, 'a caption in an error toast'],
  // Button labels (both ends of the primary gradient; filled Buy and Sell carry dark text).
  ['on-accent', 'primary', TEXT, 'primary buttons (gradient start)'],
  ['on-accent', 'primary-2', TEXT, 'primary buttons (gradient end)'],
  ['on-accent', 'primary-hover', TEXT, 'primary buttons, hovered'],
  ['on-buy', 'buy-strong', TEXT, 'a Buy button'],
  ['on-buy', 'buy', TEXT, 'a Buy button, hovered'],
  ['on-sell', 'sell-strong', TEXT, 'a Sell button'],
  ['on-sell', 'sell', TEXT, 'a Sell button, hovered'],
  ['on-accent', 'danger-strong', TEXT, 'the Clear all data button'],
  ['on-accent', 'danger-hover', TEXT, 'the Clear all data button, hovered'],
  ['disabled-ink', 'disabled-bg', TEXT, 'a disabled button (exempt in WCAG; kept legible anyway)'],
  // Non-text contrast (WCAG 1.4.11): control borders, focus rings, indicators.
  ['field-border', 'field', LARGE_OR_UI, 'input borders'],
  ['field-border', 'surface', LARGE_OR_UI, 'input borders in a card'],
  ['field-border', 'surface-2', LARGE_OR_UI, 'input borders in a raised card'],
  ['field-border', 'surface-3', LARGE_OR_UI, 'input borders on the selected line'],
  ['cyan', 'bg', LARGE_OR_UI, 'the focus ring on the page'],
  ['cyan', 'surface', LARGE_OR_UI, 'the focus ring in a card'],
  ['cyan', 'surface-3', LARGE_OR_UI, 'the focus ring on a chip'],
  ['violet', 'bg', LARGE_OR_UI, 'the current tab bar marker, the current step ring'],
  ['violet', 'surface', LARGE_OR_UI, 'the selected card border'],
];

describe('the Night Market colour tokens (WCAG 2.2 AA)', () => {
  it('parses every token the pairs use', () => {
    for (const [fg, bg] of PAIRS) expect([hex(fg), hex(bg)]).toHaveLength(2);
  });

  it('computes contrast the WCAG way', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it.each(PAIRS.map(([fg, bg, min, use]) => ({ fg, bg, min, use })))(
    '--$fg on --$bg ≥ $min:1 ($use)',
    ({ fg, bg, min }) => {
      expect(contrast(hex(fg), hex(bg))).toBeGreaterThanOrEqual(min);
    },
  );

  it('keeps the brand violet for indicators and borders, and a lighter violet for text', () => {
    // --violet on a card is fine for a 3:1 indicator but below 4.5:1: text in violet uses --violet-ink.
    expect(contrast(hex('violet'), hex('surface'))).toBeLessThan(TEXT);
    expect(contrast(hex('violet-ink'), hex('surface'))).toBeGreaterThanOrEqual(TEXT);
  });
});
