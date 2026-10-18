/**
 * Finding a picked structure on other kinds of piece.
 *
 * The picked structure (a set of faces on a reference piece) is used as a
 * template: it is placed on every raised feature of another piece that is about
 * as high above the plate, turned about Z until it lies on that piece's surface,
 * and accepted when nearly all of it does. The faces of the other piece under the
 * placed template become the structure there, so the copy has the same outline
 * as the original (including any parts cut out of it), on a simplified mesh as
 * well as a full one. Two copies on one piece (two segments fused into one by a
 * simplifier, or a piece that carries two roses) are found separately.
 */
/** @typedef {import('./piece-analysis.js').Analysis} Analysis */
/** @typedef {import('./region-growing.js').RegionGrower} RegionGrower */
/** @typedef {import('./piece-matching.js').ZTransform} ZTransform */
import { makeShape, shapeGrid, TriangleGrid, refineOnSurface, surfaceFit, applyZ, invertZ, matchTolerance } from './piece-matching.js?v=f6f03e4619';
import { structureTop } from './structure-cut.js?v=7dc0dc41d9';

/** a placement counts when this fraction of the template lies on the other piece's surface */
const SIMILAR = 0.9;
/** rotations tried for each placement (then refined) */
const TURNS = 12;
/** keep at most this many piece grids (triangles) between searches */
const GRID_CACHE_TRIANGLES = 1500000;

/**
 * @typedef {object} SimilarMatch
 * @property {number} group
 * @property {number} anchor top face of the feature it was found on (on the group's reference piece)
 * @property {number[]} faces faces of the group's reference piece covered by the placed template
 * @property {number} inside fraction of the template on that piece's surface
 */

export class SimilarFinder {
  /** @type {Float32Array} */
  positions;
  /** @type {Uint32Array} */
  indices;
  /** @type {Analysis} */
  analysis;
  /** @type {RegionGrower} */
  grower;
  /** @type {Map<number, TriangleGrid>} surface grids of reference pieces, most recently used last */
  grids = new Map();

  /**
   * @param {Float32Array} positions
   * @param {Uint32Array} indices
   * @param {Analysis} analysis
   * @param {RegionGrower} grower
   */
  constructor(positions, indices, analysis, grower) {
    this.positions = positions;
    this.indices = indices;
    this.analysis = analysis;
    this.grower = grower;
  }

  /**
   * Surface grid of a piece (cached).
   * @param {number} piece
   * @returns {TriangleGrid}
   */
  pieceGrid(piece) {
    let g = this.grids.get(piece);
    if (g) {
      this.grids.delete(piece);
      this.grids.set(piece, g);
      return g;
    }
    const pt = this.analysis.pieces;
    g = new TriangleGrid(this.positions, this.indices, pt.pieceFaces.subarray(pt.pieceStart[piece], pt.pieceStart[piece + 1]));
    this.grids.set(piece, g);
    let total = 0;
    for (const x of this.grids.values()) total += x.faces.length;
    for (const [k, x] of this.grids) {
      if (total <= GRID_CACHE_TRIANGLES || k === piece) break;
      total -= x.faces.length;
      this.grids.delete(k);
    }
    return g;
  }

  /**
   * Tops of the raised features of a piece whose height above the plate is
   * within `tol` mm of `height`: faces spread over the piece each climb to their
   * local top; tops closer than `spacing` to an earlier one are dropped.
   * @param {number} piece
   * @param {number} height
   * @param {number} tol
   * @param {number} spacing
   * @param {number} reach climbing reach (mm)
   * @returns {number[]}
   */
  featureTops(piece, height, tol, spacing, reach) {
    const pt = this.analysis.pieces;
    const minZ = this.analysis.stats[piece].min[2];
    const s = pt.pieceStart[piece], e = pt.pieceStart[piece + 1];
    const step = Math.max(1, Math.floor((e - s) / 64));
    /** @type {number[]} */
    const tops = [];
    /** @type {[number, number, number][]} */
    const at = [];
    for (let k = s; k < e; k += step) {
      const f = pt.pieceFaces[k];
      if (this.grower.centroid(f)[2] - minZ < height - tol) continue; // too low to climb to the height
      const top = structureTop(this.grower, f, reach);
      const c = this.grower.centroid(top);
      if (Math.abs(c[2] - minZ - height) > tol) continue;
      if (at.some((o) => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) < spacing)) continue;
      tops.push(top);
      at.push(c);
    }
    return tops;
  }

  /**
   * Find the structure `region` (faces on one reference piece) on the reference
   * pieces of the other groups. Resolves to every placement found; `stop` is
   * polled between pieces so a newer request can cancel this one.
   * @param {number[]} region
   * @param {number} size the size setting (mm)
   * @param {Set<number>} skip groups not to search
   * @param {() => boolean} stop
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<SimilarMatch[] | null>} null when stopped
   */
  async find(region, size, skip, stop, onProgress) {
    const a = this.analysis;
    const P = this.positions, I = this.indices;
    /** @type {SimilarMatch[]} */
    const found = [];
    if (region.length < 10) return found;
    const target = makeShape(P, I, Uint32Array.from(region));
    const targetGrid = shapeGrid(target, P, I);
    /** @type {{ samples: Float32Array; grid: TriangleGrid } | null} mirror image, made when first needed */
    let mirror = null;
    // the template's top: where it is placed on each feature
    let top = region[0];
    let topZ = -Infinity;
    for (const f of region) {
      const z = this.grower.centroid(f)[2];
      if (z > topZ) {
        topZ = z;
        top = f;
      }
    }
    const tp = this.grower.centroid(top);
    const ownPiece = a.pieces.pieceOfFace[region[0]];
    const ownGroup = a.groupOfPiece[ownPiece];
    const height = topZ - a.stats[ownPiece].min[2];
    // The template is placed by the centre of the raised feature it sits on,
    // found the same way on both pieces (a structure can have several nearly
    // equal high points, so its top alone is not a reliable handle).
    let reach = 0, depth = 0;
    for (const f of region) {
      const c = this.grower.centroid(f);
      reach = Math.max(reach, Math.hypot(c[0] - target.cx, c[1] - target.cy));
      depth = Math.max(depth, topZ - c[2]);
    }
    // upper part of the feature only, so a neighbouring copy close by does not pull the centre
    const ballR = 0.6 * reach, ballDepth = 0.5 * depth;
    const tc = featureCenter(this.pieceGrid(ownPiece), tp, ballR, topZ - ballDepth);
    const own = new Set(region);
    /** @type {number[]} */
    const todo = [];
    a.groups.forEach((g, i) => {
      if (!skip.has(i) && a.stats[g.ref].area >= target.area * 0.5) todo.push(i);
    });
    for (let k = 0; k < todo.length; k++) {
      onProgress?.(k, todo.length);
      await new Promise((r) => setTimeout(r, 0));
      if (stop()) return null;
      const gi = todo[k];
      const piece = a.groups[gi].ref;
      const grid = this.pieceGrid(piece);
      const tol = matchTolerance(targetGrid, grid);
      /** @type {Set<number>[]} */
      const taken = [];
      for (const anchor of this.featureTops(piece, height, Math.max(1.5, 0.2 * height), 0.5 * size, 0.7 * size)) {
        const at = this.grower.centroid(anchor);
        const ca = featureCenter(grid, at, ballR, at[2] - ballDepth);
        let t = this.place(target.samples, tc, ca, grid, tol, size);
        let under = targetGrid;
        if (!t) {
          // left and right sides of a model carry mirror images
          mirror ??= mirrored(P, I, region, tc[0], target.samples);
          t = this.place(mirror.samples, tc, ca, grid, tol, size);
          under = mirror.grid;
        }
        if (!t) continue;
        const faces = this.facesUnder(piece, t, under, Math.max(tol, 0.6 * grid.edge));
        if (faces.length < 10) continue;
        const set = new Set(faces);
        // the picked structure itself, or a placement already found on this piece
        if (gi === ownGroup && overlap(set, own) > 0.3) continue;
        if (taken.some((o) => overlap(set, o) > 0.3)) continue;
        taken.push(set);
        found.push({ group: gi, anchor, faces, inside: t.inside });
      }
    }
    onProgress?.(todo.length, todo.length);
    return found;
  }

  /**
   * Turn the template (feature centre `tp`) about Z on the feature centred at
   * `ca` and keep the best fit; null when it does not lie on the surface.
   * @param {Float32Array} samples
   * @param {[number, number, number]} tp
   * @param {[number, number, number]} ca
   * @param {TriangleGrid} grid
   * @param {number} tol
   * @param {number} size
   * @returns {(ZTransform & { inside: number }) | null}
   */
  place(samples, tp, ca, grid, tol, size) {
    /** @type {{ t: ZTransform; inside: number; mean: number }[]} */
    const tries = [];
    for (let k = 0; k < TURNS; k++) {
      const th = (k / TURNS) * 2 * Math.PI;
      /** @type {ZTransform} */
      const t0 = { cos: Math.cos(th), sin: Math.sin(th), fx: tp[0], fy: tp[1], tx: ca[0], ty: ca[1], dz: ca[2] - tp[2] };
      const t = refineOnSurface(samples, t0, grid, Math.max(1.5, 0.25 * size), 250, 6);
      const fit = surfaceFit(samples, t, grid, tol, 250);
      tries.push({ t, inside: fit.inside, mean: fit.mean });
    }
    tries.sort((x, y) => y.inside - x.inside || x.mean - y.mean);
    // refine the two best turns fully
    /** @type {(ZTransform & { inside: number }) | null} */
    let best = null;
    for (const c of tries.slice(0, 2)) {
      if (c.inside < 0.5) break;
      const t = refineOnSurface(samples, c.t, grid, 4 * tol, 1000, 10);
      const fit = surfaceFit(samples, t, grid, tol, 1500);
      if (!best || fit.inside > best.inside) best = { ...t, inside: fit.inside };
    }
    return best && best.inside >= SIMILAR ? best : null;
  }

  /**
   * Faces of `piece` whose centre, moved back into the template's place, lies
   * within `tol` of the template's surface.
   * @param {number} piece
   * @param {ZTransform} t template -> piece
   * @param {TriangleGrid} targetGrid
   * @param {number} tol
   * @returns {number[]}
   */
  facesUnder(piece, t, targetGrid, tol) {
    const pt = this.analysis.pieces;
    const back = invertZ(t);
    const P = this.positions, I = this.indices;
    const p = [0, 0, 0];
    const hit = [0, 0, 0, 0];
    // only faces near the placed template can be under it
    const box = targetBox(targetGrid, t, tol);
    /** @type {number[]} */
    const out = [];
    for (let k = pt.pieceStart[piece]; k < pt.pieceStart[piece + 1]; k++) {
      const f = pt.pieceFaces[k];
      const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
      const x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      if (x < box[0] || x > box[3] || y < box[1] || y > box[4] || z < box[2] || z > box[5]) continue;
      applyZ(back, x, y, z, p);
      if (targetGrid.closest(p[0], p[1], p[2], tol, hit) >= 0) out.push(f);
    }
    return out;
  }
}

/**
 * Centre of the raised feature around `start`: the mean of the triangle centres
 * within `r` (horizontally) that lie above `zMin`, moved there repeatedly until it
 * settles (mean shift), so any start on the feature ends at the same centre.
 * @param {TriangleGrid} grid
 * @param {[number, number, number]} start
 * @param {number} r
 * @param {number} zMin
 * @returns {[number, number, number]}
 */
function featureCenter(grid, start, r, zMin) {
  const S = grid.spheres;
  let cx = start[0], cy = start[1], cz = start[2];
  const r2 = r * r;
  for (let iter = 0; iter < 10; iter++) {
    let n = 0, sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < grid.faces.length; i++) {
      const z = S[i * 4 + 2];
      if (z < zMin) continue;
      const dx = S[i * 4] - cx, dy = S[i * 4 + 1] - cy;
      if (dx * dx + dy * dy > r2) continue;
      // weight by triangle size so coarse and fine meshes agree
      const w = S[i * 4 + 3] * S[i * 4 + 3];
      n += w;
      sx += w * S[i * 4];
      sy += w * S[i * 4 + 1];
      sz += w * z;
    }
    if (!n) break;
    const nx = sx / n, ny = sy / n;
    const moved = Math.hypot(nx - cx, ny - cy);
    cx = nx;
    cy = ny;
    cz = sz / n;
    if (moved < 0.02) break;
  }
  return [cx, cy, cz];
}

/**
 * The template reflected in the plane x = mx (its samples and its surface grid).
 * @param {Float32Array} P
 * @param {Uint32Array} I
 * @param {number[]} region
 * @param {number} mx
 * @param {Float32Array} samples
 * @returns {{ samples: Float32Array; grid: TriangleGrid }}
 */
function mirrored(P, I, region, mx, samples) {
  const ms = samples.slice();
  for (let i = 0; i < ms.length; i += 3) ms[i] = 2 * mx - ms[i];
  const pos = new Float32Array(region.length * 9);
  const idx = new Uint32Array(region.length * 3);
  region.forEach((f, i) => {
    for (let j = 0; j < 3; j++) {
      const v = I[f * 3 + j] * 3;
      pos[i * 9 + j * 3] = 2 * mx - P[v];
      pos[i * 9 + j * 3 + 1] = P[v + 1];
      pos[i * 9 + j * 3 + 2] = P[v + 2];
      idx[i * 3 + j] = i * 3 + j;
    }
  });
  const faces = Uint32Array.from(region, (_f, i) => i);
  return { samples: ms, grid: new TriangleGrid(pos, idx, faces) };
}

/**
 * Fraction of the smaller set that is also in the other one.
 * @param {Set<number>} a
 * @param {Set<number>} b
 * @returns {number}
 */
function overlap(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const f of small) if (large.has(f)) n++;
  return small.size ? n / small.size : 0;
}

/**
 * Bounding box (min xyz, max xyz) of the template's triangles after moving them
 * by t, grown by `pad`.
 * @param {TriangleGrid} grid
 * @param {ZTransform} t
 * @param {number} pad
 * @returns {number[]}
 */
function targetBox(grid, t, pad) {
  const T = grid.tris;
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const p = [0, 0, 0];
  for (let i = 0; i < T.length; i += 3) {
    applyZ(t, T[i], T[i + 1], T[i + 2], p);
    for (let d = 0; d < 3; d++) {
      if (p[d] < box[d]) box[d] = p[d];
      if (p[d] > box[d + 3]) box[d + 3] = p[d];
    }
  }
  for (let d = 0; d < 3; d++) {
    box[d] -= pad;
    box[d + 3] += pad;
  }
  return box;
}
