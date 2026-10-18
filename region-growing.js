/**
 * Region growing on the triangle mesh: from a seed face across smooth or convex
 * edges, stopping at concave creases and at a distance from the seed. Used for
 * the parts cut out of a structure (Alt+click) and to find a structure's top;
 * whole structures are picked by structure-cut.js.
 */

/**
 * @typedef {object} GrowParams
 * @property {number} angle crease angle (degrees): concave edges sharper than this stop the growth
 * @property {number} radius size (mm): maximum distance from the seed
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
  /** @type {Int32Array | null} */
  local = null;
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
   * A face -> local index table, all -1. Callers must set entries back to -1
   * when they are done.
   * @returns {Int32Array}
   */
  localIndex() {
    if (!this.local) this.local = new Int32Array(this.indices.length / 3).fill(-1);
    return this.local;
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
}
