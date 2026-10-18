/**
 * The 11 basic colour terms, with filament-like values (close to common PLA Basic colours).
 * @type {{ name: string; hex: string }[]}
 */
export const BASIC_COLORS = [
  { name: 'Black', hex: '#1A1A1A' },
  { name: 'White', hex: '#F4F4F2' },
  { name: 'Red', hex: '#C8281E' },
  { name: 'Green', hex: '#00A63F' },
  { name: 'Yellow', hex: '#F4E22A' },
  { name: 'Blue', hex: '#1D45B5' },
  { name: 'Brown', hex: '#8A4A2B' },
  { name: 'Orange', hex: '#FF6A13' },
  { name: 'Pink', hex: '#F45C8A' },
  { name: 'Purple', hex: '#6A3FB8' },
  { name: 'Gray', hex: '#8E9089' },
];

/**
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
export function rgbToHex(r, g, b) {
  /** @param {number} x */
  const c = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {[number, number, number]}
 */
export function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

/**
 * @param {number} h
 * @param {number} s
 * @param {number} v
 * @returns {[number, number, number]}
 */
export function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * Closest basic colour term for any colour (used to name imported filaments).
 * @param {string} hex
 * @returns {string}
 */
export function nearestColorName(hex) {
  const [r, g, b] = hexToRgb(hex);
  let best = BASIC_COLORS[0].name;
  let bestD = Infinity;
  // compare against canonical term colours (not the filament values) for better naming
  /** @type {[string, number, number, number][]} */
  const canon = [
    ['Black', 0, 0, 0], ['White', 255, 255, 255], ['Red', 220, 30, 30], ['Green', 30, 170, 60], ['Yellow', 250, 230, 40],
    ['Blue', 30, 80, 220], ['Brown', 130, 75, 40], ['Orange', 255, 130, 20], ['Pink', 250, 120, 170], ['Purple', 120, 60, 180], ['Gray', 140, 140, 140],
  ];
  for (const [name, cr, cg, cb] of canon) {
    const d = (r - cr) ** 2 * 0.3 + (g - cg) ** 2 * 0.59 + (b - cb) ** 2 * 0.11;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/**
 * Readable ink (black/white) on a given background colour.
 * @param {string} hex
 * @returns {string}
 */
export function inkFor(hex) {
  const [r, g, b] = hexToRgb(hex);
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return l > 0.6 ? '#141414' : '#FFFFFF';
}
