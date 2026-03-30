/**
 * Generate N evenly-spaced hue-shifted colors from the theme's --accent color.
 * Returns hex strings. Local user gets index 0.
 */
export function generateUserPalette(count: number): string[] {
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue("--accent").trim() || "#3b82f6";

  // Parse hex to HSL
  const r = parseInt(accent.slice(1, 3), 16) / 255;
  const g = parseInt(accent.slice(3, 5), 16) / 255;
  const b = parseInt(accent.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  // Boost saturation slightly for better visual distinction
  const baseSat = Math.max(s, 0.5);
  const baseLit = Math.min(Math.max(l, 0.45), 0.65);

  const colors: string[] = [];
  for (let i = 0; i < count; i++) {
    const hue = (h + i / Math.max(count, 1)) % 1;
    // HSL to hex
    const c = (1 - Math.abs(2 * baseLit - 1)) * baseSat;
    const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
    const m = baseLit - c / 2;
    let r1: number, g1: number, b1: number;
    const seg = Math.floor(hue * 6);
    if (seg === 0) { r1 = c; g1 = x; b1 = 0; }
    else if (seg === 1) { r1 = x; g1 = c; b1 = 0; }
    else if (seg === 2) { r1 = 0; g1 = c; b1 = x; }
    else if (seg === 3) { r1 = 0; g1 = x; b1 = c; }
    else if (seg === 4) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }
    const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
    colors.push(`#${toHex(r1)}${toHex(g1)}${toHex(b1)}`);
  }
  return colors;
}
