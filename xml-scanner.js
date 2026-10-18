/**
 * Minimal streaming XML tag scanner working on raw bytes.
 * It reports start/empty tags with their attributes and end tags; text content is
 * ignored. Designed for multi-hundred-MB 3MF model files: no DOM, no per-tag
 * strings unless the handler asks for one.
 */

const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

/**
 * Parse a decimal number (optionally with exponent) from bytes.
 * @param {Uint8Array} b
 * @param {number} s
 * @param {number} e
 * @returns {number}
 */
export function parseNumber(b, s, e) {
  let i = s;
  while (i < e && b[i] <= 32) i++;
  let neg = false;
  if (b[i] === 45) {
    neg = true;
    i++;
  } else if (b[i] === 43) i++;
  let mant = 0;
  let digits = 0;
  let exp10 = 0;
  while (i < e) {
    const c = b[i] - 48;
    if (c < 0 || c > 9) break;
    if (digits < 16) {
      mant = mant * 10 + c;
      if (mant !== 0) digits++;
    } else exp10++;
    i++;
  }
  if (i < e && b[i] === 46) {
    i++;
    while (i < e) {
      const c = b[i] - 48;
      if (c < 0 || c > 9) break;
      if (digits < 16) {
        mant = mant * 10 + c;
        if (mant !== 0) digits++;
        exp10--;
      }
      i++;
    }
  }
  if (i < e && (b[i] === 101 || b[i] === 69)) {
    i++;
    let eneg = false;
    if (b[i] === 45) {
      eneg = true;
      i++;
    } else if (b[i] === 43) i++;
    let ev = 0;
    while (i < e) {
      const c = b[i] - 48;
      if (c < 0 || c > 9) break;
      ev = ev * 10 + c;
      i++;
    }
    exp10 += eneg ? -ev : ev;
  }
  let v = mant;
  if (exp10 > 0) v = exp10 <= 22 ? v * POW10[exp10] : v * Math.pow(10, exp10);
  else if (exp10 < 0) v = -exp10 <= 22 ? v / POW10[-exp10] : v / Math.pow(10, -exp10);
  return neg ? -v : v;
}

/**
 * @param {Uint8Array} b
 * @param {number} s
 * @param {number} e
 * @returns {number}
 */
export function parseIntBytes(b, s, e) {
  let i = s;
  while (i < e && b[i] <= 32) i++;
  let neg = false;
  if (b[i] === 45) {
    neg = true;
    i++;
  }
  let v = 0;
  while (i < e) {
    const c = b[i] - 48;
    if (c < 0 || c > 9) break;
    v = v * 10 + c;
    i++;
  }
  return neg ? -v : v;
}

const utf8 = new TextDecoder('utf-8');

/**
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, g) => {
    if (g === 'amp') return '&';
    if (g === 'lt') return '<';
    if (g === 'gt') return '>';
    if (g === 'quot') return '"';
    if (g === 'apos') return "'";
    if (g[1] === 'x') return String.fromCodePoint(parseInt(g.slice(2), 16));
    return String.fromCodePoint(parseInt(g.slice(1), 10));
  });
}

export class Attrs {
  /** @type {Uint8Array} */
  buf = new Uint8Array(0);
  count = 0;
  ns = new Int32Array(64);
  ne = new Int32Array(64);
  vs = new Int32Array(64);
  ve = new Int32Array(64);

  /**
   * @param {Uint8Array} buf
   * @returns {void}
   */
  reset(buf) {
    this.buf = buf;
    this.count = 0;
  }
  /**
   * @param {number} ns
   * @param {number} ne
   * @param {number} vs
   * @param {number} ve
   * @returns {void}
   */
  add(ns, ne, vs, ve) {
    if (this.count >= this.ns.length) return; // ignore absurd attribute counts
    const i = this.count++;
    this.ns[i] = ns;
    this.ne[i] = ne;
    this.vs[i] = vs;
    this.ve[i] = ve;
  }
  /**
   * Index of attribute whose full name equals `name` (bytes), or -1.
   * @param {Uint8Array} name
   * @returns {number}
   */
  find(name) {
    const b = this.buf;
    const L = name.length;
    for (let i = 0; i < this.count; i++) {
      const s = this.ns[i];
      if (this.ne[i] - s !== L) continue;
      let k = 0;
      while (k < L && b[s + k] === name[k]) k++;
      if (k === L) return i;
    }
    return -1;
  }
  /**
   * Index of attribute whose local name (after any 'prefix:') equals `local`.
   * @param {Uint8Array} local
   * @returns {number}
   */
  findLocal(local) {
    const b = this.buf;
    const L = local.length;
    for (let i = 0; i < this.count; i++) {
      const e = this.ne[i];
      const s = e - L;
      if (s < this.ns[i]) continue;
      if (s > this.ns[i] && b[s - 1] !== 58) continue; // must be preceded by ':'
      let k = 0;
      while (k < L && b[s + k] === local[k]) k++;
      if (k === L) return i;
    }
    return -1;
  }
  /**
   * @param {number} i
   * @returns {number}
   */
  num(i, def = 0) {
    return i < 0 ? def : parseNumber(this.buf, this.vs[i], this.ve[i]);
  }
  /**
   * @param {number} i
   * @returns {number}
   */
  int(i, def = 0) {
    return i < 0 ? def : parseIntBytes(this.buf, this.vs[i], this.ve[i]);
  }
  /**
   * @param {number} i
   * @returns {string}
   */
  str(i, def = '') {
    if (i < 0) return def;
    const s = this.vs[i];
    const e = this.ve[i];
    let ascii = true;
    for (let k = s; k < e; k++)
      if (this.buf[k] > 127) {
        ascii = false;
        break;
      }
    /** @type {string} */
    let out;
    if (ascii && e - s < 4096) {
      out = String.fromCharCode.apply(null, /** @type {number[]} */ (/** @type {unknown} */ (this.buf.subarray(s, e))));
    } else out = utf8.decode(this.buf.subarray(s, e));
    return decodeEntities(out);
  }
  /**
   * All attributes as a plain object (for small config files).
   * @returns {Record<string, string>}
   */
  toObject() {
    /** @type {Record<string, string>} */
    const o = {};
    for (let i = 0; i < this.count; i++) o[utf8.decode(this.buf.subarray(this.ns[i], this.ne[i]))] = this.str(i);
    return o;
  }
}

/**
 * @typedef {object} XmlHandler
 * @property {(tag: number, attrs: Attrs, selfClosing: boolean) => void} open `tag` is the index into the scanner's name list, or -1 for other tags.
 * @property {(tag: number) => void} close
 */

const enc = new TextEncoder();
/**
 * @param {string} s
 * @returns {Uint8Array}
 */
export const bytes = (s) => enc.encode(s);

/**
 * @param {number} c
 * @returns {boolean}
 */
function isWs(c) {
  return c === 32 || c === 10 || c === 13 || c === 9;
}

export class XmlScanner {
  /** @type {Uint8Array | null} */
  carry = null;
  attrs = new Attrs();
  /** @type {Map<number, { b: Uint8Array; id: number }[]>} */
  byLen = new Map();
  /** @type {XmlHandler} */
  handler;
  /**
   * Tag names are matched on their local part ("p:component" matches "component").
   * @param {string[]} names
   * @param {XmlHandler} handler
   */
  constructor(names, handler) {
    this.handler = handler;
    names.forEach((n, id) => {
      const b = bytes(n);
      const list = this.byLen.get(b.length) ?? [];
      list.push({ b, id });
      this.byLen.set(b.length, list);
    });
  }

  /**
   * @param {Uint8Array} b
   * @param {number} s
   * @param {number} e
   * @returns {number}
   */
  tagId(b, s, e) {
    // strip namespace prefix
    for (let k = s; k < e; k++)
      if (b[k] === 58) {
        s = k + 1;
        break;
      }
    const list = this.byLen.get(e - s);
    if (!list) return -1;
    outer: for (const { b: nb, id } of list) {
      for (let k = 0; k < nb.length; k++) if (b[s + k] !== nb[k]) continue outer;
      return id;
    }
    return -1;
  }

  /**
   * @param {Uint8Array} chunk
   * @returns {void}
   */
  push(chunk) {
    /** @type {Uint8Array} */
    let buf;
    if (this.carry && this.carry.length) {
      buf = new Uint8Array(this.carry.length + chunk.length);
      buf.set(this.carry, 0);
      buf.set(chunk, this.carry.length);
    } else buf = chunk;
    this.carry = null;
    const used = this.scan(buf);
    if (used < buf.length) this.carry = buf.slice(used);
  }

  /**
   * Returns true if everything was consumed.
   * @returns {boolean}
   */
  end() {
    const rest = this.carry;
    this.carry = null;
    if (!rest || rest.length === 0) return true;
    const used = this.scan(rest);
    return used >= rest.length || rest.subarray(used).every((c) => isWs(c));
  }

  /**
   * Scan complete tags; return number of bytes consumed.
   * @param {Uint8Array} b
   * @returns {number}
   */
  scan(b) {
    const n = b.length;
    const attrs = this.attrs;
    const h = this.handler;
    let i = 0;
    while (i < n) {
      const lt = b.indexOf(60, i);
      if (lt < 0) return n;
      if (lt + 1 >= n) return lt;
      const c1 = b[lt + 1];
      if (c1 === 47) {
        // end tag
        const gt = b.indexOf(62, lt + 2);
        if (gt < 0) return lt;
        let ne = lt + 2;
        while (ne < gt && !isWs(b[ne])) ne++;
        h.close(this.tagId(b, lt + 2, ne));
        i = gt + 1;
        continue;
      }
      if (c1 === 63) {
        // <? ... ?>
        let q = b.indexOf(62, lt + 2);
        while (q >= 0 && b[q - 1] !== 63) q = b.indexOf(62, q + 1);
        if (q < 0) return lt;
        i = q + 1;
        continue;
      }
      if (c1 === 33) {
        // comment, CDATA or DOCTYPE
        if (lt + 3 >= n) return lt;
        if (b[lt + 2] === 45 && b[lt + 3] === 45) {
          let q = b.indexOf(62, lt + 4);
          while (q >= 0 && !(b[q - 1] === 45 && b[q - 2] === 45)) q = b.indexOf(62, q + 1);
          if (q < 0) return lt;
          i = q + 1;
          continue;
        }
        if (b[lt + 2] === 91) {
          let q = b.indexOf(62, lt + 3);
          while (q >= 0 && !(b[q - 1] === 93 && b[q - 2] === 93)) q = b.indexOf(62, q + 1);
          if (q < 0) return lt;
          i = q + 1;
          continue;
        }
        const q = b.indexOf(62, lt + 2);
        if (q < 0) return lt;
        i = q + 1;
        continue;
      }
      // start tag
      let p = lt + 1;
      while (p < n && !isWs(b[p]) && b[p] !== 62 && b[p] !== 47) p++;
      if (p >= n) return lt;
      const tag = this.tagId(b, lt + 1, p);
      attrs.reset(b);
      let self = false;
      let complete = false;
      while (p < n) {
        const c = b[p];
        if (isWs(c)) {
          p++;
          continue;
        }
        if (c === 62) {
          complete = true;
          p++;
          break;
        }
        if (c === 47) {
          if (p + 1 >= n) break;
          if (b[p + 1] === 62) {
            self = true;
            complete = true;
            p += 2;
            break;
          }
          p++;
          continue;
        }
        const an = p;
        while (p < n && b[p] !== 61 && !isWs(b[p]) && b[p] !== 62 && b[p] !== 47) p++;
        if (p >= n) break;
        const ae = p;
        while (p < n && isWs(b[p])) p++;
        if (p >= n) break;
        if (b[p] !== 61) continue; // attribute without value
        p++;
        while (p < n && isWs(b[p])) p++;
        if (p >= n) break;
        const q = b[p];
        if (q !== 34 && q !== 39) {
          p++;
          continue;
        }
        const vs = p + 1;
        const ve = b.indexOf(q, vs);
        if (ve < 0) {
          p = n;
          break;
        }
        attrs.add(an, ae, vs, ve);
        p = ve + 1;
      }
      if (!complete) return lt;
      h.open(tag, attrs, self);
      if (self) h.close(tag);
      i = p;
    }
    return n;
  }
}
