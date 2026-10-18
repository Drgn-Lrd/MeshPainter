/**
 * Structure regions: grow from a seed face across smooth or convex edges, stop at
 * concave creases (where a modelled flower meets the body) and at a radius.
 * Regions are defined on a group's reference piece and mapped onto every copy
 * through a precomputed face correspondence.
 */
/** @typedef {import('./mesh-topology.js').PieceTable} PieceTable */

/**
 * @typedef {object} GrowParams
 * @property {number} angle concave edges sharper than this stop the growth (degrees)
 * @property {number} radius maximum distance from the seed (mm)
 */

export class RegionGrower {
  /** @type {Uint32Array} */
  visit;
  epoch = 0;
  /** @type {Float32Array} */
  positions;
  /** @type {Uint32Array} */
  indices;
  /** @type {Int32Array} */
  neighbors;
  /** @type {Uint32Array} */
  pieceOfFace;
  /**
   * @param {Float32Array} positions
   * @param {Uint32Array} indices
   * @param {Int32Array} neighbors
   * @param {Uint32Array} pieceOfFace
   */
  constructor(positions, indices, neighbors, pieceOfFace) {
    this.positions = positions;
    this.indices = indices;
    this.neighbors = neighbors;
    this.pieceOfFace = pieceOfFace;
    this.visit = new Uint32Array(indices.length / 3);
  }

  /**
   * @param {number} f
   * @param {Float64Array} out
   * @param {number} o
   * @returns {void}
   */
  normal(f, out, o) {
    const P = this.positions, I = this.indices;
    const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    out[o] = nx;
    out[o + 1] = ny;
    out[o + 2] = nz;
  }

  /**
   * @param {number} f
   * @returns {[number, number, number]}
   */
  centroid(f) {
    const P = this.positions, I = this.indices;
    const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
    return [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3];
  }

  /**
   * Faces of the grown region (global indices), seed first. The size limit is
   * measured from `center` (default: the seed's centroid).
   * @param {number} seed
   * @param {GrowParams} params
   * @param {[number, number, number]} [center]
   * @returns {number[]}
   */
  grow(seed, params, center, maxFaces = 400000) {
    if (++this.epoch >= 0xfffff000) {
      this.visit.fill(0);
      this.epoch = 1;
    }
    const ep = this.epoch;
    const P = this.positions, I = this.indices, NB = this.neighbors;
    const piece = this.pieceOfFace[seed];
    const [sx, sy, sz] = center ?? this.centroid(seed);
    const r2 = params.radius * params.radius;
    const cosLimit = Math.cos((params.angle * Math.PI) / 180);
    const n = new Float64Array(6);
    const out = [seed];
    this.visit[seed] = ep;
    for (let i = 0; i < out.length && out.length < maxFaces; i++) {
      const f = out[i];
      this.normal(f, n, 0);
      for (let k = 0; k < 3; k++) {
        const g = NB[f * 3 + k];
        if (g < 0 || this.visit[g] === ep || this.pieceOfFace[g] !== piece) continue;
        // radius test on the neighbour's centroid
        const ga = I[g * 3] * 3, gb = I[g * 3 + 1] * 3, gc = I[g * 3 + 2] * 3;
        const cx = (P[ga] + P[gb] + P[gc]) / 3 - sx, cy = (P[ga + 1] + P[gb + 1] + P[gc + 1]) / 3 - sy, cz = (P[ga + 2] + P[gb + 2] + P[gc + 2]) / 3 - sz;
        if (cx * cx + cy * cy + cz * cz > r2) continue;
        this.normal(g, n, 3);
        const cos = n[0] * n[3] + n[1] * n[4] + n[2] * n[5];
        if (cos < cosLimit) {
          // sharper than the limit: only cross if the edge is convex
          // (g's far vertex lies below f's plane)
          const ea = I[f * 3 + k], eb = I[f * 3 + ((k + 1) % 3)];
          let far = I[g * 3];
          if (far === ea || far === eb) far = I[g * 3 + 1];
          if (far === ea || far === eb) far = I[g * 3 + 2];
          const d = (P[far * 3] - P[ea * 3]) * n[0] + (P[far * 3 + 1] - P[ea * 3 + 1]) * n[1] + (P[far * 3 + 2] - P[ea * 3 + 2]) * n[2];
          if (d > 0) continue; // concave crease: stop
        }
        this.visit[g] = ep;
        out.push(g);
      }
    }
    return out;
  }

  /**
   * Add enclosed gaps to a region: connected runs of non-region faces that stay
   * within `reach` mm of the seed and have at most `maxRun` triangles.
   * Must be called right after grow() (uses its visit marks).
   * @param {number[]} region
   * @param {number} seed
   * @param {number} reach
   * @param {number} maxRun
   * @returns {number[]}
   */
  fillHoles(region, seed, reach, maxRun) {
    if (this.epoch > 0xfffff000) return region; // epoch space nearly used up; skip filling
    const inRegion = this.epoch;
    const outside = ++this.epoch; // runs known to connect to the outside
    const NB = this.neighbors;
    const piece = this.pieceOfFace[seed];
    const [sx, sy, sz] = this.centroid(seed);
    const reach2 = reach * reach;
    const limit = maxRun;
    for (const f of region) this.visit[f] = inRegion;
    const out = region.slice();
    /** @type {number[]} */
    const stack = [];
    /** @type {number[]} */
    const run = [];
    for (let i = 0; i < region.length; i++) {
      const f = region[i];
      for (let k = 0; k < 3; k++) {
        const g0 = NB[f * 3 + k];
        if (g0 < 0 || this.visit[g0] === inRegion || this.visit[g0] === outside || this.pieceOfFace[g0] !== piece) continue;
        // flood the non-region faces from g0
        const current = ++this.epoch;
        run.length = 0;
        stack.length = 0;
        stack.push(g0);
        this.visit[g0] = current;
        let escaped = false;
        while (stack.length && !escaped) {
          const g = stack.pop();
          run.push(g);
          const [x, y, z] = this.centroid(g);
          if ((x - sx) ** 2 + (y - sy) ** 2 + (z - sz) ** 2 > reach2 || run.length > limit) {
            escaped = true;
            break;
          }
          for (let kk = 0; kk < 3; kk++) {
            const h = NB[g * 3 + kk];
            if (h < 0 || this.pieceOfFace[h] !== piece) continue;
            const v = this.visit[h];
            if (v === inRegion || v === current) continue;
            if (v === outside) {
              escaped = true;
              break;
            }
            this.visit[h] = current;
            stack.push(h);
          }
        }
        if (escaped) {
          for (const g of run) this.visit[g] = outside;
          for (const g of stack) this.visit[g] = outside;
          continue;
        }
        for (const g of run) {
          this.visit[g] = inRegion;
          out.push(g);
        }
      }
    }
    return out;
  }
}

/**
 * Move the seed to the top of the structure it is on: repeatedly grow a small
 * region (half the size limit, same crease rule) and step to its highest face.
 * Pieces lie flat on the plate, so decorations face up; this makes the selection
 * the same wherever on the structure the mouse is.
 * @param {RegionGrower} grower
 * @param {number} seed
 * @param {GrowParams} params
 * @returns {number}
 */
export function climbSeed(grower, seed, params) {
  const small = { angle: params.angle, radius: params.radius * 0.5 };
  let s = seed;
  for (let iter = 0; iter < 8; iter++) {
    let best = s;
    let bestZ = grower.centroid(s)[2];
    for (const f of grower.grow(s, small)) {
      const z = grower.centroid(f)[2];
      if (z > bestZ + 1e-4) {
        bestZ = z;
        best = f;
      }
    }
    if (best === s) break;
    s = best;
  }
  return s;
}

/**
 * Structure selection used by the app: climb to the top of the structure, grow
 * across smooth or convex edges within the size limit (measured from that top),
 * then fill tiny enclosed specks the crease rule skipped.
 * (Centring the limit on the structure's axis was tried on the Rosewing and
 * reached into the body under every rose, so the limit stays at the top.)
 * @param {RegionGrower} grower
 * @param {number} seed
 * @param {GrowParams} params
 * @returns {number[]}
 */
export function growStructure(grower, seed, params) {
  seed = climbSeed(grower, seed, params);
  const region = grower.grow(seed, params);
  return grower.fillHoles(region, seed, params.radius * 1.2, Math.min(200, Math.ceil(region.length * 0.03)));
}

/**
 * Mark the faces of every member piece whose reference face is in `refMask`.
 * @param {Uint8Array} refMask
 * @param {Uint32Array} corr
 * @param {PieceTable} pt
 * @param {number[]} members
 * @param {(face: number) => void} cb
 * @returns {void}
 */
export function mapToMembers(
  refMask,
  corr,
  pt,
  members,
  cb,
) {
  for (const p of members) {
    for (let k = pt.pieceStart[p]; k < pt.pieceStart[p + 1]; k++) {
      const f = pt.pieceFaces[k];
      if (refMask[corr[f]]) cb(f);
    }
  }
}
