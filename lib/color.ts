type RGB = { r: number; g: number; b: number };

function normalizeHex(input: string): string | null {
  if (!input) return null;
  const hex = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return hex
      .split("")
      .map((char) => char + char)
      .join("")
      .toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return hex.toLowerCase();
  }
  return null;
}

function hexToRgb(hexColor: string): RGB | null {
  const hex = normalizeHex(hexColor);
  if (!hex) return null;
  return {
    r: parseInt(hex.substring(0, 2), 16),
    g: parseInt(hex.substring(2, 4), 16),
    b: parseInt(hex.substring(4, 6), 16),
  };
}

function srgbToLinear(value: number): number {
  const channel = value / 255;
  if (channel <= 0.03928) {
    return channel / 12.92;
  }
  return Math.pow((channel + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }: RGB): number {
  const linearR = srgbToLinear(r);
  const linearG = srgbToLinear(g);
  const linearB = srgbToLinear(b);
  return 0.2126 * linearR + 0.7152 * linearG + 0.0722 * linearB;
}

export function getReadableTextColor(background: string, light = "#ffffff", dark = "#111827"): string {
  const rgb = hexToRgb(background);
  if (!rgb) return dark;
  const luminance = relativeLuminance(rgb);
  const contrastWithLight = (1.05) / (luminance + 0.05);
  const contrastWithDark = (luminance + 0.05) / 0.05;
  return contrastWithLight >= contrastWithDark ? light : dark;
}

export function toRgba(color: string, alpha: number): string {
  const clampAlpha = Number.isFinite(alpha) ? Math.min(Math.max(alpha, 0), 1) : 1;
  const rgb = hexToRgb(color);
  if (!rgb) {
    return `rgba(17, 24, 39, ${clampAlpha})`;
  }
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clampAlpha})`;
}
