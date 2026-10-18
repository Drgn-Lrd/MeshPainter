/**
 * Per-triangle multi-material paint codec, compatible with OrcaSlicer / Bambu Studio
 * (`paint_color`) and PrusaSlicer (`slic3rpe:mmu_segmentation`).
 *
 * The string is a hex bit tree read from the LAST character to the first; each
 * character is one 4-bit code.
 *   code & 3  = number of split sides (0 = leaf)
 *   leaf:  if (code & 0b1100) != 0b1100 -> state = code >> 2
 *          else read nibble n: state = n + 3, or if n == 15 read m: state = m + 18
 *   split: special side = code >> 2 (ignored for a 3-side split, which always uses 0);
 *          children follow depth-first, stored LAST CHILD FIRST (child order as
 *          produced by splitTriangle()).
 *
 * Verified against brush strokes in a Bambu Studio 2.0 project: decoded this way,
 * every 1- and 2-side split satisfies the slicer's edge-length rule (split side
 * longest / kept side shortest): 417 of 417. Reading children first-to-last
 * gives 172 of 417.
 * State 0 = unpainted (prints with the object's filament), state k = filament k (1-based).
 * @typedef {object} PaintLeaf
 * @property {number} s
 */
/**
 * @typedef {object} PaintSplit
 * @property {number} split number of split sides, 1..3 (children = split + 1)
 * @property {number} special special side as stored in the file (geometry uses 0 when split === 3)
 * @property {PaintNode[]} c children in geometric order (child 0 .. child split)
 */
/** @typedef {PaintLeaf | PaintSplit} PaintNode */

export const MAX_STATE = 33;
const HEX = '0123456789ABCDEF';

/**
 * @param {PaintNode} n
 * @returns {n is PaintLeaf}
 */
export function isLeaf(n) {
  return (/** @type {PaintLeaf} */ (n)).s !== undefined;
}

/**
 * @param {number} ch
 * @returns {number}
 */
function hexValue(ch) {
  if (ch >= 48 && ch <= 57) return ch - 48; // 0-9
  if (ch >= 65 && ch <= 70) return ch - 55; // A-F
  if (ch >= 97 && ch <= 102) return ch - 87; // a-f
  throw new Error(`invalid character '${String.fromCharCode(ch)}' in paint string`);
}

export class PaintDecodeError extends Error {}

/**
 * Decode a paint string into a tree. Throws PaintDecodeError on malformed input.
 * @param {string} str
 * @returns {PaintNode}
 */
export function decodePaint(str) {
  let pos = str.length - 1;
  /** @returns {number} */
  const nib = () => {
    if (pos < 0) throw new PaintDecodeError(`paint string "${str}" ended early`);
    return hexValue(str.charCodeAt(pos--));
  };
  /**
   * @param {number} depth
   * @returns {PaintNode}
   */
  const rec = (depth) => {
    if (depth > 40) throw new PaintDecodeError('paint tree too deep');
    const code = nib();
    const split = code & 3;
    if (split === 0) {
      if ((code & 12) !== 12) return { s: code >> 2 };
      const n = nib();
      if (n !== 15) return { s: n + 3 };
      return { s: nib() + 18 };
    }
    const count = split + 1;
    /** @type {PaintNode[]} */
    const c = new Array(count);
    for (let i = count - 1; i >= 0; i--) c[i] = rec(depth + 1);
    return { split, special: code >> 2, c };
  };
  const root = rec(0);
  if (pos >= 0) {
    // Trailing characters: slicers ignore them too, but flag clearly malformed data.
    for (let i = 0; i <= pos; i++) if (str.charCodeAt(i) !== 48) throw new PaintDecodeError(`paint string "${str}" has ${pos + 1} unused characters`);
  }
  return root;
}

/**
 * Encode a tree to a paint string (exact reverse of decodePaint).
 * @param {PaintNode} node
 * @returns {string}
 */
export function encodePaint(node) {
  /** @type {number[]} */
  const out = [];
  /**
   * @param {PaintNode} n
   * @returns {void}
   */
  const rec = (n) => {
    if (isLeaf(n)) {
      const s = n.s;
      if (s < 0 || s > MAX_STATE || !Number.isInteger(s)) throw new Error(`invalid paint state ${s}`);
      if (s < 3) out.push(s << 2);
      else if (s - 3 < 15) out.push(12, s - 3);
      else out.push(12, 15, s - 18);
      return;
    }
    out.push((n.split & 3) | ((n.special & 3) << 2));
    for (let i = n.split; i >= 0; i--) rec(n.c[i]);
  };
  rec(node);
  let s = '';
  for (let i = out.length - 1; i >= 0; i--) s += HEX[out[i]];
  return s;
}

/**
 * Whole-triangle code for a filament state (1-based). State 0 = "" (no attribute).
 * @param {number} state
 * @returns {string}
 */
export function wholeCode(state) {
  return state === 0 ? '' : encodePaint({ s: state });
}

/** @type {string[]} */
const WHOLE_CODES = [];
for (let s = 0; s <= MAX_STATE; s++) WHOLE_CODES.push(wholeCode(s));
/**
 * @param {number} state
 * @returns {string}
 */
export function wholeCodeCached(state) {
  return WHOLE_CODES[state];
}

/**
 * Fast path for attribute bytes: returns the state if the code is a whole
 * (unsplit) triangle, or -1 if it is subdivided / not recognised.
 * @param {Uint8Array} buf
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
export function wholeStateFromBytes(buf, start, end) {
  const len = end - start;
  if (len === 0) return 0;
  const last = buf[end - 1];
  if (len === 1) {
    if (last === 48) return 0; // '0'
    if (last === 52) return 1; // '4'
    if (last === 56) return 2; // '8'
    return -1;
  }
  if (last !== 67 && last !== 99) return -1; // 'C' / 'c' -> leaf with extended state
  if (len === 2) {
    const n = hexValueSafe(buf[start]);
    if (n < 0 || n === 15) return -1;
    return n + 3;
  }
  if (len === 3) {
    const mid = buf[start + 1];
    if (mid !== 70 && mid !== 102) return -1; // 'F'
    const m = hexValueSafe(buf[start]);
    return m < 0 ? -1 : m + 18;
  }
  return -1;
}

/**
 * @param {number} ch
 * @returns {number}
 */
function hexValueSafe(ch) {
  if (ch >= 48 && ch <= 57) return ch - 48;
  if (ch >= 65 && ch <= 70) return ch - 55;
  if (ch >= 97 && ch <= 102) return ch - 87;
  return -1;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** @typedef {[number, number, number]} Vec3 */

/**
 * @param {Vec3} a
 * @param {Vec3} b
 * @returns {Vec3}
 */
function mid(a, b) {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
}

/**
 * Child triangles of a split node, in geometric child order. Matches
 * TriangleSelector::perform_split in PrusaSlicer / OrcaSlicer.
 * @param {number} split
 * @param {number} special
 * @param {Vec3} v0
 * @param {Vec3} v1
 * @param {Vec3} v2
 * @returns {Vec3[][]}
 */
export function splitTriangle(split, special, v0, v1, v2) {
  const v = [v0, v1, v2];
  const sp = split === 3 ? 0 : special % 3;
  const w0 = v[sp];
  const w1 = v[(sp + 1) % 3];
  const w2 = v[(sp + 2) % 3];
  if (split === 1) {
    const m = mid(w2, w1);
    return [
      [w0, w1, m],
      [m, w2, w0],
    ];
  }
  if (split === 2) {
    const a = mid(w1, w0);
    const b = mid(w0, w2);
    return [
      [w0, a, b],
      [a, w1, b],
      [w1, w2, b],
    ];
  }
  const a = mid(w1, w0);
  const b = mid(w2, w1);
  const c = mid(w0, w2);
  return [
    [w0, a, c],
    [a, w1, b],
    [b, w2, c],
    [a, b, c],
  ];
}

/**
 * Visit every leaf with its triangle.
 * @param {PaintNode} node
 * @param {Vec3} v0
 * @param {Vec3} v1
 * @param {Vec3} v2
 * @param {(state: number, a: Vec3, b: Vec3, c: Vec3, depth: number) => void} cb
 * @returns {void}
 */
export function forEachLeaf(
  node,
  v0,
  v1,
  v2,
  cb,
  depth = 0,
) {
  if (isLeaf(node)) {
    cb(node.s, v0, v1, v2, depth);
    return;
  }
  const kids = splitTriangle(node.split, node.special, v0, v1, v2);
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    forEachLeaf(node.c[i], k[0], k[1], k[2], cb, depth + 1);
  }
}

/**
 * @param {Vec3} a
 * @param {Vec3} b
 * @param {Vec3} c
 * @returns {number}
 */
export function triangleArea(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/**
 * @param {PaintNode} node
 * @returns {number}
 */
export function countLeaves(node) {
  if (isLeaf(node)) return 1;
  let n = 0;
  for (const c of node.c) n += countLeaves(c);
  return n;
}

/**
 * @param {PaintNode} a
 * @param {PaintNode} b
 * @returns {boolean}
 */
export function treesEqual(a, b) {
  if (isLeaf(a) || isLeaf(b)) return isLeaf(a) && isLeaf(b) && a.s === b.s;
  if (a.split !== b.split || a.c.length !== b.c.length) return false;
  if (a.split !== 3 && a.special !== b.special) return false;
  for (let i = 0; i < a.c.length; i++) if (!treesEqual(a.c[i], b.c[i])) return false;
  return true;
}

/**
 * Collapse split nodes whose children are all leaves with the same state.
 * @param {PaintNode} node
 * @returns {PaintNode}
 */
export function normalizePaint(node) {
  if (isLeaf(node)) return node;
  const c = node.c.map(normalizePaint);
  const first = c[0];
  if (isLeaf(first) && c.every((k) => isLeaf(k) && k.s === first.s)) return { s: first.s };
  return { split: node.split, special: node.special, c };
}

/**
 * Replace state 0 leaves with `fallback` (used when baking a part's default filament).
 * @param {PaintNode} node
 * @param {number} fallback
 * @returns {PaintNode}
 */
export function resolveUnpainted(node, fallback) {
  if (isLeaf(node)) return node.s === 0 ? { s: fallback } : node;
  return { split: node.split, special: node.special, c: node.c.map((k) => resolveUnpainted(k, fallback)) };
}

/**
 * Add every state used by a tree to `out`.
 * @param {PaintNode} node
 * @param {Set<number>} out
 * @returns {Set<number>}
 */
export function collectStates(node, out) {
  if (isLeaf(node)) out.add(node.s);
  else for (const c of node.c) collectStates(c, out);
  return out;
}

/**
 * Largest state used (for palette sizing).
 * @param {PaintNode} node
 * @returns {number}
 */
export function maxState(node) {
  if (isLeaf(node)) return node.s;
  let m = 0;
  for (const c of node.c) m = Math.max(m, maxState(c));
  return m;
}

/**
 * Paint the leaf of `node` that contains point p (given in barycentric
 * coordinates of the root triangle), subdividing 4-way until `depth`.
 * Returns the new (normalized) tree.
 * @param {PaintNode} node
 * @param {Vec3} bary
 * @param {number} state
 * @param {number} depth
 * @returns {PaintNode}
 */
export function paintAtBarycentric(node, bary, state, depth) {
  // Work in a 2D barycentric frame: root triangle = (1,0,0),(0,1,0),(0,0,1).
  /**
   * @param {PaintNode} n
   * @param {Vec3} v0
   * @param {Vec3} v1
   * @param {Vec3} v2
   * @param {number} d
   * @returns {PaintNode}
   */
  const rec = (n, v0, v1, v2, d) => {
    if (isLeaf(n)) {
      if (d >= depth) return { s: state };
      // split 4-way, recurse into the child containing p
      n = { split: 3, special: 0, c: [{ s: n.s }, { s: n.s }, { s: n.s }, { s: n.s }] };
    }
    const sn = /** @type {PaintSplit} */ (n);
    const kids = splitTriangle(sn.split, sn.special, v0, v1, v2);
    const idx = containingChild(kids, bary);
    const c = sn.c.slice();
    c[idx] = rec(c[idx], kids[idx][0], kids[idx][1], kids[idx][2], d + 1);
    return { split: sn.split, special: sn.special, c };
  };
  return normalizePaint(rec(node, [1, 0, 0], [0, 1, 0], [0, 0, 1], 0));
}

/**
 * Index of the child triangle (in barycentric space) that best contains p.
 * @param {Vec3[][]} kids
 * @param {Vec3} p
 * @returns {number}
 */
function containingChild(kids, p) {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < kids.length; i++) {
    const w = barycentricIn(kids[i][0], kids[i][1], kids[i][2], p);
    const score = Math.min(w[0], w[1], w[2]);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Barycentric coordinates of p with respect to triangle (a,b,c) (all in 3D).
 * @param {Vec3} a
 * @param {Vec3} b
 * @param {Vec3} c
 * @param {Vec3} p
 * @returns {Vec3}
 */
export function barycentricIn(a, b, c, p) {
  const v0x = b[0] - a[0], v0y = b[1] - a[1], v0z = b[2] - a[2];
  const v1x = c[0] - a[0], v1y = c[1] - a[1], v1z = c[2] - a[2];
  const v2x = p[0] - a[0], v2y = p[1] - a[1], v2z = p[2] - a[2];
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z;
  const d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const den = d00 * d11 - d01 * d01;
  if (den === 0) return [1 / 3, 1 / 3, 1 / 3];
  const v = (d11 * d20 - d01 * d21) / den;
  const w = (d00 * d21 - d01 * d20) / den;
  return [1 - v - w, v, w];
}
