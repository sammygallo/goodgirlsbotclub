/**
 * The light presets' secondary text colors (D-T4). Contrast is computed with the
 * WCAG 2.x relative-luminance formula, written out here so the test needs no dependency.
 */
import { describe, expect, it } from 'vitest';
import { getPresetColors } from './themePreferences';

const ACCENT_PRESETS = ['purple', 'blue', 'green', 'red', 'amber'] as const;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('light preset secondary text', () => {
  it.each(ACCENT_PRESETS)('%s: textSecondary and textQuote are #52525b', (preset) => {
    const colors = getPresetColors(preset, 'light');
    expect(colors.textSecondary).toBe('#52525b');
    expect(colors.textQuote).toBe('#52525b');
  });

  it('cyberpunk keeps its own light textSecondary', () => {
    expect(getPresetColors('cyberpunk', 'light').textSecondary).toBe('#6b21a8');
  });

  it.each(ACCENT_PRESETS)('%s: textSecondary is at least 6.5:1 on bgSecondary and 5.5:1 on bgTertiary', (preset) => {
    const colors = getPresetColors(preset, 'light');
    expect(contrastRatio(colors.textSecondary, colors.bgSecondary)).toBeGreaterThanOrEqual(6.5);
    expect(contrastRatio(colors.textSecondary, colors.bgTertiary)).toBeGreaterThanOrEqual(5.5);
  });

  it('the contrast formula gives 21:1 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
});
