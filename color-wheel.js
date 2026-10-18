import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from './colors.js?v=0dda646d26';

/** HSV colour wheel (hue = angle, saturation = radius) with a brightness slider and RGB/hex inputs. */
export class ColorWheel {
  /** @type {HTMLElement} */
  el;
  /** @type {HTMLCanvasElement} */
  canvas;
  /** @type {HTMLElement} */
  marker;
  /** @type {HTMLInputElement} */
  bright;
  /** @type {HTMLInputElement} */
  inR;
  /** @type {HTMLInputElement} */
  inG;
  /** @type {HTMLInputElement} */
  inB;
  /** @type {HTMLInputElement} */
  inHex;
  h = 0;
  s = 0;
  v = 1;
  drawnV = -1;
  size = 168;
  /** @type {(hex: string) => void} */
  onInput;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'wheel';
    this.el.innerHTML = `
      <div class="wheel-disc">
        <canvas width="10" height="10" aria-label="Hue and saturation wheel" role="img"></canvas>
        <div class="wheel-marker" aria-hidden="true"></div>
      </div>
      <label class="wheel-bright"><span>Brightness</span><input id="wheel-bright" type="range" min="0" max="100" step="1" value="100"></label>
      <div class="wheel-fields">
        <label><span>R</span><input id="wheel-r" type="number" min="0" max="255" step="1" inputmode="numeric"></label>
        <label><span>G</span><input id="wheel-g" type="number" min="0" max="255" step="1" inputmode="numeric"></label>
        <label><span>B</span><input id="wheel-b" type="number" min="0" max="255" step="1" inputmode="numeric"></label>
        <label class="wheel-hex"><span>Hex</span><input id="wheel-hex" type="text" maxlength="7" spellcheck="false" autocomplete="off"></label>
      </div>`;
    this.canvas = this.el.querySelector('canvas');
    this.marker = this.el.querySelector('.wheel-marker');
    this.bright = this.el.querySelector('#wheel-bright');
    this.inR = this.el.querySelector('#wheel-r');
    this.inG = this.el.querySelector('#wheel-g');
    this.inB = this.el.querySelector('#wheel-b');
    this.inHex = this.el.querySelector('#wheel-hex');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.canvas.height = Math.round(this.size * dpr);
    this.canvas.style.width = this.canvas.style.height = `${this.size}px`;

    /** @param {PointerEvent} e */
    const pickAt = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left - r.width / 2;
      const y = e.clientY - r.top - r.height / 2;
      const R = r.width / 2;
      this.h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
      this.s = Math.min(1, Math.hypot(x, y) / R);
      if (this.v < 0.05) this.v = 1;
      this.sync('wheel');
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      pickAt(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.buttons & 1) pickAt(e);
    });
    this.bright.addEventListener('input', () => {
      this.v = Number(this.bright.value) / 100;
      this.sync('bright');
    });
    const fromRgb = () => {
      const r = clamp255(this.inR.value), g = clamp255(this.inG.value), b = clamp255(this.inB.value);
      [this.h, this.s, this.v] = rgbToHsv(r, g, b);
      this.sync('rgb');
    };
    for (const i of [this.inR, this.inG, this.inB]) i.addEventListener('input', fromRgb);
    this.inHex.addEventListener('input', () => {
      const t = this.inHex.value.trim();
      if (/^#?[0-9a-fA-F]{6}$/.test(t)) {
        const [r, g, b] = hexToRgb(t.startsWith('#') ? t : '#' + t);
        [this.h, this.s, this.v] = rgbToHsv(r, g, b);
        this.sync('hex');
      }
    });
  }

  /**
   * @param {string} hex
   * @returns {void}
   */
  setColor(hex) {
    const [r, g, b] = hexToRgb(hex);
    [this.h, this.s, this.v] = rgbToHsv(r, g, b);
    this.sync('external');
  }

  /**
   * @param {'wheel' | 'bright' | 'rgb' | 'hex' | 'external'} from
   * @returns {void}
   */
  sync(from) {
    const [r, g, b] = hsvToRgb(this.h, this.s, this.v);
    const hex = rgbToHex(r, g, b);
    if (from !== 'rgb') {
      this.inR.value = String(Math.round(r));
      this.inG.value = String(Math.round(g));
      this.inB.value = String(Math.round(b));
    }
    if (from !== 'hex') this.inHex.value = hex;
    if (from !== 'bright') this.bright.value = String(Math.round(this.v * 100));
    if (Math.abs(this.drawnV - this.v) > 0.004) this.draw();
    const R = this.size / 2;
    const a = (this.h * Math.PI) / 180;
    this.marker.style.transform = `translate(${R + Math.cos(a) * this.s * R}px, ${R + Math.sin(a) * this.s * R}px)`;
    this.marker.style.background = hex;
    if (from !== 'external') this.onInput?.(hex);
  }

  /** @returns {void} */
  draw() {
    const ctx = this.canvas.getContext('2d');
    const W = this.canvas.width;
    const img = ctx.createImageData(W, W);
    const R = W / 2;
    const d = img.data;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x + 0.5 - R;
        const dy = y + 0.5 - R;
        const dist = Math.hypot(dx, dy);
        const o = (y * W + x) * 4;
        if (dist > R) {
          d[o + 3] = 0;
          continue;
        }
        const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const [r, g, b] = hsvToRgb(h, dist / R, this.v);
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = dist > R - 1 ? Math.round((R - dist) * 255) : 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.drawnV = this.v;
  }
}

/**
 * @param {string} v
 * @returns {number}
 */
function clamp255(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(255, n)) : 0;
}
