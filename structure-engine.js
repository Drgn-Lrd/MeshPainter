/**
 * Structure types ("Rose", "Spike"...): each is a list of selections made on a
 * group's reference piece (seed face + growth settings, minus excluded parts),
 * mapped onto every identical piece of that group, and coloured by a rule.
 * The result is a paint layer (one byte per face) shown over the manual paint.
 */
/** @typedef {import('./piece-analysis.js').Analysis} Analysis */
import { RegionGrower, growStructure, climbSeed } from './region-growing.js?v=8d4da38962';
/** @typedef {import('./region-growing.js').GrowParams} GrowParams */
import { PointGrid, registerPieces, angularHistogram } from './piece-matching.js?v=7ec7bd113b';
/** @typedef {import('./piece-matching.js').PieceStats} PieceStats */

/**
 * @typedef {| { kind: 'single'; filament: number }
 *   | { kind: 'sequence'; filaments: number[] }
 *   | { kind: 'random'; filaments: number[]; seed: number; spacing: number }} Rule
 */

/**
 * @typedef {object} Exclusion
 * @property {number} seedRef
 * @property {GrowParams} params
 */

/**
 * @typedef {object} Selection
 * @property {number} group
 * @property {number} seedRef seed face on the group's reference piece
 * @property {GrowParams} params
 * @property {Exclusion[]} excludes
 * @property {boolean} [auto] found by shape matching rather than clicked
 */

/**
 * @typedef {object} StructureType
 * @property {number} id
 * @property {string} name
 * @property {Selection[]} selections
 * @property {Rule} rule
 */

/**
 * @typedef {object} Instance
 * @property {number} type
 * @property {number} piece
 * @property {Uint32Array} faces
 * @property {number} cx
 * @property {number} cy
 * @property {number} cz
 * @property {number} filament
 */

export const EXCLUDE_ANGLE = 12;

/**
 * Small deterministic PRNG (mulberry32).
 * @param {number} seed
 * @returns {() => number}
 */
function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class StructureEngine {
  /** @type {StructureType[]} */
  types = [];
  /** @type {Instance[]} */
  instances = [];
  /**
   * filament per face from structures (0 = none)
   * @type {Uint8Array}
   */
  layer;
  /** @type {Analysis} */
  analysis;
  /** @type {RegionGrower} */
  grower;
  /** @type {Uint8Array} */
  mask;
  /** @type {Float32Array} */
  positions;
  /** @type {Uint32Array} */
  indices;
  /** @type {Uint32Array} */
  buffer;
  nextId = 1;

  /**
   * @param {Float32Array} positions
   * @param {Uint32Array} indices
   * @param {Analysis} analysis
   */
  constructor(positions, indices, analysis) {
    this.positions = positions;
    this.indices = indices;
    this.analysis = analysis;
    const F = indices.length / 3;
    this.grower = new RegionGrower(positions, indices, analysis.neighbors, analysis.pieces.pieceOfFace);
    this.mask = new Uint8Array(F);
    this.layer = new Uint8Array(F);
    this.buffer = new Uint32Array(F);
  }

  /**
   * The model's arrays travelled to the worker and back: use the returned ones.
   * @param {Float32Array} positions
   * @param {Uint32Array} indices
   * @returns {void}
   */
  rebind(positions, indices) {
    this.positions = positions;
    this.indices = indices;
    this.grower = new RegionGrower(positions, indices, this.analysis.neighbors, this.analysis.pieces.pieceOfFace);
  }

  /**
   * @param {number} face
   * @returns {number}
   */
  groupOfFace(face) {
    return this.analysis.groupOfPiece[this.analysis.pieces.pieceOfFace[face]];
  }

  /**
   * Region on the reference piece, after removing excluded parts.
   * @param {number} seedRef
   * @param {GrowParams} params
   * @param {Exclusion[]} [excludes]
   * @returns {number[]}
   */
  refRegion(seedRef, params, excludes = []) {
    const region = growStructure(this.grower, seedRef, params);
    if (!excludes.length) return region;
    const cut = new Set();
    for (const ex of excludes) for (const f of this.grower.grow(ex.seedRef, ex.params)) cut.add(f);
    return region.filter((f) => !cut.has(f));
  }

  /**
   * Faces to highlight while hovering `face`: the grown region mapped onto every
   * identical piece. Returns a view into an internal buffer (valid until the next call)
   * and the reference region (for caching by the caller).
   * @param {number} face
   * @param {GrowParams} params
   * @returns {{ faces: Uint32Array; refRegion: number[]; group: number; copies: number }}
   */
  preview(face, params, cut = false) {
    const a = this.analysis;
    const g = this.groupOfFace(face);
    const group = a.groups[g];
    const refRegion = cut ? this.grower.grow(a.corr[face], params) : growStructure(this.grower, a.corr[face], params);
    const n = this.mapRegion(refRegion, group.members);
    return { faces: this.buffer.subarray(0, n), refRegion, group: g, copies: group.members.length };
  }

  /**
   * Map a reference-piece region onto member pieces into the internal buffer; returns the count.
   * @param {number[]} refRegion
   * @param {number[]} members
   * @returns {number}
   */
  mapRegion(refRegion, members) {
    const a = this.analysis;
    const mask = this.mask;
    for (const f of refRegion) mask[f] = 1;
    let n = 0;
    const pt = a.pieces;
    const corr = a.corr;
    const buf = this.buffer;
    for (const p of members) {
      for (let k = pt.pieceStart[p]; k < pt.pieceStart[p + 1]; k++) {
        const f = pt.pieceFaces[k];
        if (mask[corr[f]]) buf[n++] = f;
      }
    }
    for (const f of refRegion) mask[f] = 0;
    return n;
  }

  /**
   * @param {string} name
   * @param {Rule} rule
   * @returns {StructureType}
   */
  newType(name, rule) {
    /** @type {StructureType} */
    const t = { id: this.nextId++, name, selections: [], rule };
    this.types.push(t);
    return t;
  }

  /**
   * Selection of type t (in group g) whose region contains reference face r, or -1.
   * @param {StructureType} t
   * @param {number} face
   * @returns {number}
   */
  selectionAt(t, face) {
    const a = this.analysis;
    const g = this.groupOfFace(face);
    const r = a.corr[face];
    for (let i = 0; i < t.selections.length; i++) {
      const s = t.selections[i];
      if (s.group !== g) continue;
      if (this.refRegion(s.seedRef, s.params, s.excludes).includes(r)) return i;
    }
    return -1;
  }

  /**
   * @param {StructureType} t
   * @param {number} face
   * @param {GrowParams} params
   * @returns {boolean}
   */
  addSelection(t, face, params) {
    if (this.selectionAt(t, face) >= 0) return false;
    t.selections.push({ group: this.groupOfFace(face), seedRef: this.analysis.corr[face], params: { ...params }, excludes: [] });
    return true;
  }

  /**
   * @param {StructureType} t
   * @param {number} face
   * @param {number} radius
   * @returns {boolean}
   */
  addExclusion(t, face, radius) {
    const i = this.selectionAt(t, face);
    if (i < 0) return false;
    t.selections[i].excludes.push({ seedRef: this.analysis.corr[face], params: { angle: EXCLUDE_ANGLE, radius } });
    return true;
  }

  /**
   * @param {StructureType} t
   * @param {number} face
   * @returns {boolean}
   */
  removeSelectionAt(t, face) {
    const i = this.selectionAt(t, face);
    if (i < 0) return false;
    t.selections.splice(i, 1);
    return true;
  }

  /**
   * Groups that already have a selection of type t.
   * @param {StructureType} t
   * @returns {Set<number>}
   */
  coveredGroups(t) {
    return new Set(t.selections.map((s) => s.group));
  }

  /** @returns {void} */
  reverseChain() {
    const a = this.analysis;
    const L = a.chainOrder.length;
    a.chainOrder.reverse();
    for (let p = 0; p < a.chainPosition.length; p++) if (a.chainPosition[p] >= 0) a.chainPosition[p] = L - 1 - a.chainPosition[p];
  }

  /**
   * Rebuild every instance, apply the rules and refill the paint layer.
   * @returns {void}
   */
  recompute() {
    const a = this.analysis;
    this.layer.fill(0);
    this.instances = [];
    const head = a.chainOrder.length ? a.stats[a.chainOrder[0]] : null;
    const P = this.positions;
    const I = this.indices;
    for (const t of this.types) {
      /** @type {Instance[]} */
      const list = [];
      for (const s of t.selections) {
        const group = a.groups[s.group];
        const region = this.refRegion(s.seedRef, s.params, s.excludes);
        for (const p of group.members) {
          const n = this.mapRegion(region, [p]);
          if (!n) continue;
          const faces = this.buffer.slice(0, n);
          let cx = 0, cy = 0, cz = 0;
          for (let i = 0; i < n; i++) {
            const f = faces[i];
            const va = I[f * 3] * 3;
            cx += P[va];
            cy += P[va + 1];
            cz += P[va + 2];
          }
          list.push({ type: t.id, piece: p, faces, cx: cx / n, cy: cy / n, cz: cz / n, filament: 0 });
        }
      }
      // head-to-tail order (pieces off the chain go last, in piece order)
      /** @param {Instance} inst */
      const pos = (inst) => (a.chainPosition[inst.piece] >= 0 ? a.chainPosition[inst.piece] : 1e6 + inst.piece);
      /** @param {Instance} inst */
      const dHead = (inst) => (head ? Math.hypot(inst.cx - head.cx, inst.cy - head.cy, inst.cz - head.cz) : 0);
      list.sort((x, y) => pos(x) - pos(y) || dHead(x) - dHead(y));
      this.colour(t.rule, list);
      for (const inst of list) for (const f of inst.faces) this.layer[f] = inst.filament;
      this.instances.push(...list);
    }
  }

  /**
   * @param {Rule} rule
   * @param {Instance[]} list
   * @returns {void}
   */
  colour(rule, list) {
    if (rule.kind === 'single') {
      for (const i of list) i.filament = rule.filament;
      return;
    }
    const set = rule.filaments.length ? rule.filaments : [1];
    if (rule.kind === 'sequence') {
      list.forEach((inst, i) => (inst.filament = set[i % set.length]));
      return;
    }
    // random, avoiding the previous instance along the chain and anything within `spacing` mm
    const rand = rng(rule.seed);
    const sp2 = rule.spacing * rule.spacing;
    list.forEach((inst, i) => {
      const banned = new Set();
      if (i > 0) banned.add(list[i - 1].filament);
      if (sp2 > 0)
        for (let j = 0; j < i; j++) {
          const o = list[j];
          const d2 = (o.cx - inst.cx) ** 2 + (o.cy - inst.cy) ** 2 + (o.cz - inst.cz) ** 2;
          if (d2 <= sp2) banned.add(o.filament);
        }
      let options = set.filter((f) => !banned.has(f));
      if (!options.length && i > 0) options = set.filter((f) => f !== list[i - 1].filament);
      if (!options.length) options = set;
      inst.filament = options[Math.floor(rand() * options.length)];
    });
  }

  /**
   * Face centroids, areas and summary stats of a set of faces.
   * @param {number[]} faces
   * @returns {{ pts: Float32Array; area: Float32Array; stats: PieceStats }}
   */
  cloud(faces) {
    const P = this.positions, I = this.indices;
    const pts = new Float32Array(faces.length * 3);
    const area = new Float32Array(faces.length);
    let A = 0, cx = 0, cy = 0, cz = 0, mz = Infinity;
    faces.forEach((f, i) => {
      const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
      const x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      pts[i * 3] = x;
      pts[i * 3 + 1] = y;
      pts[i * 3 + 2] = z;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const ar = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      area[i] = ar;
      A += ar;
      cx += ar * x;
      cy += ar * y;
      cz += ar * z;
      if (z < mz) mz = z;
    });
    A = A || 1;
    return { pts, area, stats: { faces: faces.length, area: A, volume: 0, cx: cx / A, cy: cy / A, cz: cz / A, min: [0, 0, mz], max: [0, 0, 0], ixx: 0, iyy: 0 } };
  }

  /**
   * Highest face of a piece (where decorations usually are on flat-lying pieces).
   * @param {number} piece
   * @returns {number}
   */
  topFace(piece) {
    const pt = this.analysis.pieces;
    const P = this.positions, I = this.indices;
    let best = pt.pieceFaces[pt.pieceStart[piece]];
    let bz = -Infinity;
    for (let k = pt.pieceStart[piece]; k < pt.pieceStart[piece + 1]; k++) {
      const f = pt.pieceFaces[k];
      const z = P[I[f * 3] * 3 + 2] + P[I[f * 3 + 1] * 3 + 2] + P[I[f * 3 + 2] * 3 + 2];
      if (z > bz) {
        bz = z;
        best = f;
      }
    }
    return best;
  }

  /**
   * Look for the structure of `sel` on every kind of piece that does not have
   * this structure type yet: grow from the top of each piece and accept it when
   * the shape lines up with the selection (rotation about Z + translation).
   * Adds the matches to `t` and returns how many pieces they cover.
   * @param {StructureType} t
   * @param {Selection} sel
   * @param {() => boolean} stop
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<{ kinds: number; pieces: number }>}
   */
  async autoMatch(t, sel, stop, onProgress) {
    const a = this.analysis;
    const region = this.refRegion(sel.seedRef, sel.params, sel.excludes);
    if (region.length < 20) return { kinds: 0, pieces: 0 };
    const rc = this.cloud(region);
    const grid = new PointGrid(rc.pts, 0.3);
    const hist = angularHistogram(rc.pts, rc.area, rc.stats.cx, rc.stats.cy);
    const covered = this.coveredGroups(t);
    /** @type {number[]} */
    const todo = [];
    a.groups.forEach((g, i) => {
      if (!covered.has(i) && a.stats[g.ref].faces >= region.length * 0.5) todo.push(i);
    });
    let kinds = 0, pieces = 0;
    for (let k = 0; k < todo.length; k++) {
      if (stop()) break;
      onProgress?.(k, todo.length);
      await new Promise((r) => setTimeout(r, 0));
      if (stop()) break;
      const gi = todo[k];
      const g = a.groups[gi];
      const seed = climbSeed(this.grower, this.topFace(g.ref), sel.params);
      const cand = growStructure(this.grower, seed, sel.params);
      const ratio = cand.length / region.length;
      if (ratio < 0.7 || ratio > 1.4) continue;
      const qc = this.cloud(cand);
      const reg = registerPieces(qc.pts, qc.area, qc.stats, grid, rc.pts, hist, rc.stats);
      if (reg.inliers < 0.85 || reg.rms > 0.25) continue;
      t.selections.push({ group: gi, seedRef: seed, params: { ...sel.params }, excludes: [], auto: true });
      kinds++;
      pieces += g.members.length;
    }
    onProgress?.(todo.length, todo.length);
    return { kinds, pieces };
  }

  /**
   * Copy of the structure definitions (for undo).
   * @returns {StructureType[]}
   */
  snapshot() {
    return JSON.parse(JSON.stringify(this.types));
  }
  /**
   * @param {StructureType[]} types
   * @returns {void}
   */
  restore(types) {
    this.types = JSON.parse(JSON.stringify(types));
    this.nextId = Math.max(0, ...this.types.map((t) => t.id)) + 1;
  }
}
