/** Growable typed arrays (doubling) for streaming parsers. */

export class GrowF32 {
  /** @type {Float32Array} */
  buf;
  len = 0;
  constructor(cap = 1 << 16) {
    this.buf = new Float32Array(Math.max(16, cap));
  }
  /**
   * @param {number} extra
   * @returns {void}
   */
  ensure(extra) {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < need) cap = cap < 1 << 26 ? cap * 2 : Math.ceil(cap * 1.5);
    const nb = new Float32Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  /**
   * @param {number} a
   * @param {number} b
   * @param {number} c
   * @returns {void}
   */
  push3(a, b, c) {
    if (this.len + 3 > this.buf.length) this.ensure(3);
    const i = this.len;
    this.buf[i] = a;
    this.buf[i + 1] = b;
    this.buf[i + 2] = c;
    this.len = i + 3;
  }
  /**
   * Exact-length result (copies only if there is slack).
   * @returns {Float32Array}
   */
  finish() {
    const out = this.len === this.buf.length ? this.buf : this.buf.slice(0, this.len);
    this.buf = new Float32Array(16);
    this.len = 0;
    return out;
  }
}

export class GrowU32 {
  /** @type {Uint32Array} */
  buf;
  len = 0;
  constructor(cap = 1 << 16) {
    this.buf = new Uint32Array(Math.max(16, cap));
  }
  /**
   * @param {number} extra
   * @returns {void}
   */
  ensure(extra) {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < need) cap = cap < 1 << 26 ? cap * 2 : Math.ceil(cap * 1.5);
    const nb = new Uint32Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  /**
   * @param {number} a
   * @param {number} b
   * @param {number} c
   * @returns {void}
   */
  push3(a, b, c) {
    if (this.len + 3 > this.buf.length) this.ensure(3);
    const i = this.len;
    this.buf[i] = a;
    this.buf[i + 1] = b;
    this.buf[i + 2] = c;
    this.len = i + 3;
  }
  /** @returns {Uint32Array} */
  finish() {
    const out = this.len === this.buf.length ? this.buf : this.buf.slice(0, this.len);
    this.buf = new Uint32Array(16);
    this.len = 0;
    return out;
  }
}

export class GrowU8 {
  /** @type {Uint8Array} */
  buf;
  len = 0;
  constructor(cap = 1 << 16) {
    this.buf = new Uint8Array(Math.max(16, cap));
  }
  /**
   * @param {number} v
   * @returns {void}
   */
  push(v) {
    if (this.len >= this.buf.length) {
      const nb = new Uint8Array(this.buf.length < 1 << 26 ? this.buf.length * 2 : Math.ceil(this.buf.length * 1.5));
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.len++] = v;
  }
  /** @returns {Uint8Array} */
  finish() {
    const out = this.len === this.buf.length ? this.buf : this.buf.slice(0, this.len);
    this.buf = new Uint8Array(16);
    this.len = 0;
    return out;
  }
}
