/**
 * Structure types ("Rose", "Spike"...): each is a list of selections made on a
 * group's reference piece (a picked structure, minus excluded parts, or the faces
 * a match on another kind of piece covers), mapped onto every identical piece of
 * that group, and coloured by a rule. The result is a paint layer (one byte per
 * face) shown over the manual paint.
 */
/** @typedef {import('./piece-analysis.js').Analysis} Analysis */
import { RegionGrower } from './region-growing.js?v=5d033f3571';
import { cutStructure } from './structure-cut.js?v=7dc0dc41d9';
/** @typedef {import('./region-growing.js').GrowParams} GrowParams */
import { SimilarFinder } from './structure-match.js?v=29e28ec441';
/** @typedef {import('./structure-match.js').SimilarMatch} SimilarMatch */

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
 * @property {number[]} [faces] for matches: the faces of the reference piece it covers
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
  /** @type {SimilarFinder} */
  finder;
  /** @type {Map<string, number[]>} picked structures by seed and settings */
  cache = new Map();
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
    this.finder = new SimilarFinder(positions, indices, analysis, this.grower);
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
    this.finder = new SimilarFinder(positions, indices, this.analysis, this.grower);
  }

  /**
   * @param {number} face
   * @returns {number}
   */
  groupOfFace(face) {
    return this.analysis.groupOfPiece[this.analysis.pieces.pieceOfFace[face]];
  }

  /**
   * Region of a selection on its group's reference piece, after removing excluded parts.
   * @param {Selection} s
   * @returns {number[]}
   */
  selectionRegion(s) {
    const region = s.faces ?? this.structureAt(s.seedRef, s.params);
    if (!s.excludes.length) return region;
    const cut = new Set();
    for (const ex of s.excludes) for (const f of this.grower.grow(ex.seedRef, ex.params)) cut.add(f);
    return region.filter((f) => !cut.has(f));
  }

  /**
   * Faces to highlight while hovering `face`: the grown region mapped onto every
   * identical piece. Returns a view into an internal buffer (valid until the next call)
   * and the reference region (for caching by the caller).
   * @param {number} face
   * @param {GrowParams} params
   * @returns {{ faces: Uint32Array; refRegion: number[]; group: number; copies: number; seedRef: number }}
   */
  preview(face, params, cut = false) {
    const a = this.analysis;
    const g = this.groupOfFace(face);
    const group = a.groups[g];
    const seedRef = a.corr[face];
    const refRegion = cut ? this.grower.grow(seedRef, params) : this.structureAt(seedRef, params);
    const n = this.mapRegion(refRegion, group.members);
    return { faces: this.buffer.subarray(0, n), refRegion, group: g, copies: group.members.length, seedRef };
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
      if (this.selectionRegion(s).includes(r)) return i;
    }
    return -1;
  }

  /**
   * @param {StructureType} t
   * @param {number} face
   * @param {GrowParams} params
   * @param {number} [seedRef] the reference face the highlighted structure was picked from
   * @returns {boolean}
   */
  addSelection(t, face, params, seedRef = this.analysis.corr[face]) {
    if (this.selectionAt(t, face) >= 0) return false;
    t.selections.push({ group: this.groupOfFace(face), seedRef, params: { ...params }, excludes: [] });
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
        const region = this.selectionRegion(s);
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
   * The structure under a face of a reference piece (remembered per seed and settings).
   * @param {number} seed
   * @param {GrowParams} params
   * @returns {number[]}
   */
  structureAt(seed, params) {
    const key = `${seed}|${params.angle}|${params.radius}`;
    let region = this.cache.get(key);
    if (!region) {
      region = cutStructure(this.grower, seed, params);
      if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, region);
    }
    return region;
  }

  /**
   * Look for a structure (faces on a reference piece) on the other kinds of
   * piece, and elsewhere on its own piece. See structure-match.js.
   * @param {number[]} region
   * @param {GrowParams} params
   * @param {() => boolean} stop
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<SimilarMatch[] | null>} null when stopped
   */
  findSimilar(region, params, stop, onProgress) {
    return this.finder.find(region, params.radius, new Set(), stop, onProgress);
  }

  /**
   * Faces to highlight for matches: each match mapped onto every identical piece of its group.
   * @param {SimilarMatch[]} matches
   * @returns {Uint32Array}
   */
  mapMatches(matches) {
    /** @type {Uint32Array[]} */
    const parts = [];
    let total = 0;
    for (const m of matches) {
      const n = this.mapRegion(m.faces, this.analysis.groups[m.group].members);
      parts.push(this.buffer.slice(0, n));
      total += n;
    }
    const out = new Uint32Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /**
   * Add matches of selection `sel` to type t (skipping places t already has).
   * Searches first unless the matches are given. Returns how many places were
   * added and how many pieces they cover.
   * @param {StructureType} t
   * @param {Selection} sel
   * @param {() => boolean} stop
   * @param {(done: number, total: number) => void} [onProgress]
   * @param {SimilarMatch[]} [known] matches found while hovering
   * @returns {Promise<{ kinds: number; pieces: number }>}
   */
  async autoMatch(t, sel, stop, onProgress, known) {
    const a = this.analysis;
    const matches = known ?? (await this.findSimilar(this.selectionRegion(sel), sel.params, stop, onProgress));
    if (!matches) return { kinds: 0, pieces: 0 };
    let kinds = 0, pieces = 0;
    for (const m of matches) {
      // already part of this type?
      const mine = new Set(m.faces);
      const dup = t.selections.some((s) => {
        if (s.group !== m.group) return false;
        let n = 0;
        const r = this.selectionRegion(s);
        for (const f of r) if (mine.has(f)) n++;
        return n > 0.3 * Math.min(r.length, mine.size);
      });
      if (dup) continue;
      t.selections.push({ group: m.group, seedRef: m.anchor, params: { ...sel.params }, excludes: [], auto: true, faces: m.faces });
      kinds++;
      pieces += a.groups[m.group].members.length;
    }
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
