/**
 * Streaming STL reader (binary and ASCII). Vertices are merged by exact
 * position while streaming, so a 200 MB file never exists as a triangle soup.
 */
/** @typedef {import('./byte-source.js').ByteSource} ByteSource */
/** @typedef {import('./byte-source.js').ProgressFn} ProgressFn */
/** @typedef {import('./model-data.js').ModelData} ModelData */
import { parseNumber } from './xml-scanner.js?v=00306bca48';
import { GrowU32 } from './growable-arrays.js?v=fed2e8a4dd';

/**
 * @param {number} n
 * @returns {number}
 */
function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Exact-position vertex merger (open addressing on the float bit patterns). */
export class Welder {
  /** @type {Uint32Array} */
  bits;
  count = 0;
  /** @type {Int32Array} */
  table;
  /** @type {number} */
  mask;

  /** @param {number} estimate */
  constructor(estimate) {
    const cap = nextPow2(Math.max(1024, Math.ceil(estimate * 2)));
    this.table = new Int32Array(cap);
    this.mask = cap - 1;
    this.bits = new Uint32Array(Math.max(3072, Math.ceil(estimate * 1.1) * 3));
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number}
   */
  static hash(x, y, z) {
    let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y ^ (y >>> 15), 0x85ebca77) ^ Math.imul(z ^ (z >>> 13), 0xc2b2ae3d);
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    return h >>> 0;
  }

  /**
   * Add a vertex given its float32 bit patterns; returns its index.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number}
   */
  add(x, y, z) {
    if (x === 0x80000000) x = 0; // -0 == +0
    if (y === 0x80000000) y = 0;
    if (z === 0x80000000) z = 0;
    const bits = this.bits;
    const table = this.table;
    let h = Welder.hash(x, y, z) & this.mask;
    for (;;) {
      const e = table[h];
      if (e === 0) break;
      const j = (e - 1) * 3;
      if (bits[j] === x && bits[j + 1] === y && bits[j + 2] === z) return e - 1;
      h = (h + 1) & this.mask;
    }
    const idx = this.count;
    if ((idx + 1) * 3 > this.bits.length) {
      const nb = new Uint32Array(Math.ceil(this.bits.length * 1.5) + 3);
      nb.set(this.bits);
      this.bits = nb;
    }
    const j = idx * 3;
    this.bits[j] = x;
    this.bits[j + 1] = y;
    this.bits[j + 2] = z;
    table[h] = idx + 1;
    this.count = idx + 1;
    if (this.count > this.table.length * 0.6) this.rehash();
    return idx;
  }

  /** @returns {void} */
  rehash() {
    const cap = this.table.length * 2;
    const table = new Int32Array(cap);
    const mask = cap - 1;
    const bits = this.bits;
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      let h = Welder.hash(bits[j], bits[j + 1], bits[j + 2]) & mask;
      while (table[h] !== 0) h = (h + 1) & mask;
      table[h] = i + 1;
    }
    this.table = table;
    this.mask = mask;
  }

  /**
   * Final positions (exact length copy); releases the hash table.
   * @returns {Float32Array}
   */
  positions() {
    const out = new Float32Array(this.count * 3);
    out.set(new Float32Array(this.bits.buffer, 0, this.count * 3));
    this.table = new Int32Array(0);
    this.bits = new Uint32Array(0);
    return out;
  }
}

const f32 = new Float32Array(1);
const u32v = new Uint32Array(f32.buffer);
/**
 * @param {number} v
 * @returns {number}
 */
function floatBits(v) {
  f32[0] = v;
  return u32v[0];
}

/**
 * @param {ByteSource} src
 * @param {string} name
 * @param {ProgressFn} [onProgress]
 * @returns {Promise<ModelData>}
 */
export async function readStl(src, name, onProgress) {
  const t0 = performance.now();
  const head = await src.read(0, Math.min(src.size, 84));
  if (head.length < 84) throw new Error('File is too small to be an STL.');
  const n = (head[80] | (head[81] << 8) | (head[82] << 16) | (head[83] << 24)) >>> 0;
  const startsWithSolid = String.fromCharCode(...head.subarray(0, 5)).toLowerCase() === 'solid';
  const binaryExact = 84 + 50 * n === src.size;
  const binaryPlausible = n > 0 && 84 + 50 * n <= src.size;
  /** @type {ModelData} */
  let model;
  if (binaryExact || (!startsWithSolid && binaryPlausible)) model = await readBinary(src, n, name, onProgress);
  else if (startsWithSolid) {
    model = await readAscii(src, name, onProgress);
    if (model.indices.length === 0 && binaryPlausible) model = await readBinary(src, n, name, onProgress);
  } else throw new Error('This file does not look like an STL (neither binary nor ASCII).');
  model.stats.seconds = (performance.now() - t0) / 1000;
  return model;
}

/**
 * @param {ByteSource} src
 * @param {number} n
 * @param {string} name
 * @param {ProgressFn} [onProgress]
 * @returns {Promise<ModelData>}
 */
async function readBinary(src, n, name, onProgress) {
  const indices = new Uint32Array(n * 3);
  const welder = new Welder(n * 0.55);
  const carry = new Uint8Array(50);
  const carryView = new DataView(carry.buffer);
  let carryLen = 0;
  let face = 0;
  const end = 84 + 50 * n;
  let done = 0;
  /**
   * @param {DataView} dv
   * @param {number} o
   */
  const record = (dv, o) => {
    const k = face * 3;
    indices[k] = welder.add(dv.getUint32(o + 12, true), dv.getUint32(o + 16, true), dv.getUint32(o + 20, true));
    indices[k + 1] = welder.add(dv.getUint32(o + 24, true), dv.getUint32(o + 28, true), dv.getUint32(o + 32, true));
    indices[k + 2] = welder.add(dv.getUint32(o + 36, true), dv.getUint32(o + 40, true), dv.getUint32(o + 44, true));
    face++;
  };
  for await (const chunk of src.stream(84, end, 1 << 22)) {
    let off = 0;
    if (carryLen > 0) {
      const need = 50 - carryLen;
      const take = Math.min(need, chunk.length);
      carry.set(chunk.subarray(0, take), carryLen);
      carryLen += take;
      off = take;
      if (carryLen < 50) continue;
      record(carryView, 0);
      carryLen = 0;
    }
    const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const len = chunk.length;
    while (off + 50 <= len) {
      record(dv, off);
      off += 50;
    }
    if (off < len) {
      carry.set(chunk.subarray(off), 0);
      carryLen = len - off;
    }
    done += chunk.length;
    onProgress?.('Reading STL', done, end - 84);
  }
  if (face !== n) throw new Error(`STL ended early: read ${face} of ${n} triangles.`);
  const vertexCount = welder.count;
  const positions = welder.positions();
  return makeModel(name, positions, indices, vertexCount, src.size);
}

/**
 * @param {ByteSource} src
 * @param {string} name
 * @param {ProgressFn} [onProgress]
 * @returns {Promise<ModelData>}
 */
async function readAscii(src, name, onProgress) {
  const welder = new Welder(1 << 16);
  const idx = new GrowU32(1 << 16);
  /** @type {Uint8Array | null} */
  let carry = null;
  let done = 0;
  const V = [118, 101, 114, 116, 101, 120]; // "vertex"
  /** @type {number[]} */
  const vals = [];
  /**
   * @param {Uint8Array} b
   * @param {number} s
   * @param {number} e
   */
  const handleLine = (b, s, e) => {
    while (s < e && b[s] <= 32) s++;
    if (e - s < 7) return;
    for (let k = 0; k < 6; k++) if ((b[s + k] | 32) !== V[k]) return;
    let p = s + 6;
    let got = 0;
    const xyz = [0, 0, 0];
    while (p < e && got < 3) {
      while (p < e && b[p] <= 32) p++;
      const q0 = p;
      while (p < e && b[p] > 32) p++;
      if (p > q0) xyz[got++] = parseNumber(b, q0, p);
    }
    if (got < 3) return;
    vals.push(welder.add(floatBits(xyz[0]), floatBits(xyz[1]), floatBits(xyz[2])));
    if (vals.length === 3) {
      idx.push3(vals[0], vals[1], vals[2]);
      vals.length = 0;
    }
  };
  for await (const chunk of src.stream(0, src.size, 1 << 22)) {
    /** @type {Uint8Array} */
    let b = chunk;
    if (carry) {
      b = new Uint8Array(carry.length + chunk.length);
      b.set(carry);
      b.set(chunk, carry.length);
      carry = null;
    }
    let s = 0;
    for (;;) {
      const nl = b.indexOf(10, s);
      if (nl < 0) break;
      handleLine(b, s, nl);
      s = nl + 1;
    }
    if (s < b.length) carry = b.slice(s);
    done += chunk.length;
    onProgress?.('Reading STL (text)', done, src.size);
  }
  if (carry) handleLine(carry, 0, carry.length);
  const vertexCount = welder.count;
  return makeModel(name, welder.positions(), idx.finish(), vertexCount, src.size);
}

/**
 * @param {string} name
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {number} vertexCount
 * @param {number} bytes
 * @returns {ModelData}
 */
function makeModel(name, positions, indices, vertexCount, bytes) {
  const faces = indices.length / 3;
  const base = name.replace(/\.(stl)+$/i, '');
  return {
    name,
    format: 'stl',
    positions,
    indices,
    faceState: new Uint8Array(faces),
    subdiv: new Map(),
    parts: [{ name: base, objectIndex: 0, firstFace: 0, faceCount: faces, firstVertex: 0, vertexCount, extruder: 1 }],
    objects: [{ name: base, firstPart: 0, partCount: 1 }],
    filamentColors: [],
    warnings: [],
    stats: { faces, vertices: vertexCount, paintedFaces: 0, subdividedFaces: 0, maxState: 0, seconds: 0, sourceBytes: bytes },
  };
}
