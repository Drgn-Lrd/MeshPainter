/**
 * Shape comparison for piece analysis: per-piece statistics, spatial grids, and
 * matching of two shapes (whole pieces or picked structures) by a rigid transform
 * (rotation about Z + translation) with a surface-distance check.
 *
 * Pieces of print-in-place models lie flat on the plate, so copies differ only by
 * a rotation about Z and a translation. Their triangles can differ completely,
 * though: a simplified model gives every copy its own triangulation, so shapes
 * are compared by the distance between their surfaces, never triangle by triangle.
 */
/** @typedef {import('./mesh-topology.js').PieceTable} PieceTable */

/**
 * @typedef {object} PieceStats
 * @property {number} faces
 * @property {number} area
 * @property {number} volume
 * @property {number} cx area-weighted surface centroid
 * @property {number} cy
 * @property {number} cz
 * @property {[number, number, number]} min
 * @property {[number, number, number]} max
 * @property {number} ixx sorted eigenvalues of the XY area-weighted second moments (rotation invariant about Z)
 * @property {number} iyy
 */

/**
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {PieceTable} pt
 * @returns {PieceStats[]}
 */
export function pieceStats(positions, indices, pt) {
  /** @type {PieceStats[]} */
  const out = [];
  const P = positions;
  for (let p = 0; p < pt.count; p++) {
    let area = 0, vol = 0, sx = 0, sy = 0, sz = 0;
    /** @type {[number, number, number]} */
    const mn = [Infinity, Infinity, Infinity];
    /** @type {[number, number, number]} */
    const mx = [-Infinity, -Infinity, -Infinity];
    const s = pt.pieceStart[p], e = pt.pieceStart[p + 1];
    for (let k = s; k < e; k++) {
      const f = pt.pieceFaces[k];
      const a = indices[f * 3] * 3, b = indices[f * 3 + 1] * 3, c = indices[f * 3 + 2] * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2];
      const bx = P[b], by = P[b + 1], bz = P[b + 2];
      const cx = P[c], cy = P[c + 1], cz = P[c + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const ar = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      area += ar;
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      sx += ar * (ax + bx + cx) / 3;
      sy += ar * (ay + by + cy) / 3;
      sz += ar * (az + bz + cz) / 3;
      for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
        if (x < mn[0]) mn[0] = x;
        if (y < mn[1]) mn[1] = y;
        if (z < mn[2]) mn[2] = z;
        if (x > mx[0]) mx[0] = x;
        if (y > mx[1]) mx[1] = y;
        if (z > mx[2]) mx[2] = z;
      }
    }
    const cx = area > 0 ? sx / area : 0, cy = area > 0 ? sy / area : 0, cz = area > 0 ? sz / area : 0;
    // XY second moments about the centroid (face centroids, area weighted)
    let mxx = 0, myy = 0, mxy = 0;
    for (let k = s; k < e; k++) {
      const f = pt.pieceFaces[k];
      const a = indices[f * 3] * 3, b = indices[f * 3 + 1] * 3, c = indices[f * 3 + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const ar = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      const dx = (P[a] + P[b] + P[c]) / 3 - cx;
      const dy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - cy;
      mxx += ar * dx * dx;
      myy += ar * dy * dy;
      mxy += ar * dx * dy;
    }
    const tr = mxx + myy;
    const det = mxx * myy - mxy * mxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    out.push({ faces: e - s, area, volume: Math.abs(vol), cx, cy, cz, min: mn, max: mx, ixx: area > 0 ? l1 / area : 0, iyy: area > 0 ? l2 / area : 0 });
  }
  return out;
}

/**
 * Rigid transform about Z: p' = R(theta) * (p - from) + to, with z shift dz.
 * @typedef {object} ZTransform
 * @property {number} cos
 * @property {number} sin
 * @property {number} fx source pivot
 * @property {number} fy
 * @property {number} tx destination pivot
 * @property {number} ty
 * @property {number} dz
 */

/**
 * @param {ZTransform} t
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number[]} out
 * @returns {void}
 */
export function applyZ(t, x, y, z, out) {
  const dx = x - t.fx, dy = y - t.fy;
  out[0] = t.cos * dx - t.sin * dy + t.tx;
  out[1] = t.sin * dx + t.cos * dy + t.ty;
  out[2] = z + t.dz;
}

/**
 * @param {ZTransform} t
 * @returns {ZTransform}
 */
export function invertZ(t) {
  return { cos: t.cos, sin: -t.sin, fx: t.tx, fy: t.ty, tx: t.fx, ty: t.fy, dz: -t.dz };
}

// ---------------------------------------------------------------------------
// Spatial grid over points (for nearest-neighbour queries)
// ---------------------------------------------------------------------------

export class PointGrid {
  /** @type {number} */
  cell;
  /** @type {number} */
  ox;
  /** @type {number} */
  oy;
  /** @type {number} */
  oz;
  /** @type {number} */
  nx;
  /** @type {number} */
  ny;
  /** @type {number} */
  nz;
  /** @type {Uint32Array} */
  start;
  /** @type {Uint32Array} */
  items;
  /** @type {Float32Array} */
  pts;

  /**
   * pts: xyz triples
   * @param {Float32Array} pts
   * @param {number} cell
   */
  constructor(pts, cell) {
    this.pts = pts;
    const n = pts.length / 3;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
      if (x < mnx) mnx = x;
      if (y < mny) mny = y;
      if (z < mnz) mnz = z;
      if (x > mxx) mxx = x;
      if (y > mxy) mxy = y;
      if (z > mxz) mxz = z;
    }
    if (n === 0) mnx = mny = mnz = mxx = mxy = mxz = 0;
    // keep the cell count bounded
    const vol = Math.max(1e-9, (mxx - mnx + cell) * (mxy - mny + cell) * (mxz - mnz + cell));
    const maxCells = Math.max(1024, n * 2);
    if (vol / (cell * cell * cell) > maxCells) cell = Math.cbrt(vol / maxCells);
    this.cell = cell;
    this.ox = mnx;
    this.oy = mny;
    this.oz = mnz;
    this.nx = Math.max(1, Math.floor((mxx - mnx) / cell) + 1);
    this.ny = Math.max(1, Math.floor((mxy - mny) / cell) + 1);
    this.nz = Math.max(1, Math.floor((mxz - mnz) / cell) + 1);
    const cells = this.nx * this.ny * this.nz;
    const counts = new Uint32Array(cells + 1);
    const cellOf = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.start = counts;
    const fill = counts.slice(0, cells);
    this.items = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.items[fill[cellOf[i]]++] = i;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number}
   */
  cellIndex(x, y, z) {
    let ix = Math.floor((x - this.ox) / this.cell);
    let iy = Math.floor((y - this.oy) / this.cell);
    let iz = Math.floor((z - this.oz) / this.cell);
    ix = ix < 0 ? 0 : ix >= this.nx ? this.nx - 1 : ix;
    iy = iy < 0 ? 0 : iy >= this.ny ? this.ny - 1 : iy;
    iz = iz < 0 ? 0 : iz >= this.nz ? this.nz - 1 : iz;
    return (iz * this.ny + iy) * this.nx + ix;
  }

  /**
   * Nearest point index within maxDist (or -1). Searches expanding shells.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} maxDist
   * @returns {number}
   */
  nearest(x, y, z, maxDist) {
    const c = this.cell;
    const ix = Math.floor((x - this.ox) / c), iy = Math.floor((y - this.oy) / c), iz = Math.floor((z - this.oz) / c);
    let best = -1;
    let bestD = maxDist * maxDist;
    const maxR = Math.ceil(maxDist / c);
    for (let r = 0; r <= maxR; r++) {
      // once a hit is closer than the inner edge of this shell, stop
      if (best >= 0 && (r - 1) * c > Math.sqrt(bestD)) break;
      for (let dz = -r; dz <= r; dz++) {
        const z0 = iz + dz;
        if (z0 < 0 || z0 >= this.nz) continue;
        for (let dy = -r; dy <= r; dy++) {
          const y0 = iy + dy;
          if (y0 < 0 || y0 >= this.ny) continue;
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const x0 = ix + dx;
            if (x0 < 0 || x0 >= this.nx) continue;
            const cell = (z0 * this.ny + y0) * this.nx + x0;
            for (let k = this.start[cell]; k < this.start[cell + 1]; k++) {
              const i = this.items[k];
              const ddx = this.pts[i * 3] - x, ddy = this.pts[i * 3 + 1] - y, ddz = this.pts[i * 3 + 2] - z;
              const d = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d < bestD) {
                bestD = d;
                best = i;
              }
            }
          }
        }
      }
    }
    return best;
  }

  /**
   * Call cb(i) for every point within radius r of (x,y,z).
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} r
   * @param {(i: number) => void} cb
   * @returns {void}
   */
  within(x, y, z, r, cb) {
    const c = this.cell;
    const x0 = Math.max(0, Math.floor((x - r - this.ox) / c)), x1 = Math.min(this.nx - 1, Math.floor((x + r - this.ox) / c));
    const y0 = Math.max(0, Math.floor((y - r - this.oy) / c)), y1 = Math.min(this.ny - 1, Math.floor((y + r - this.oy) / c));
    const z0 = Math.max(0, Math.floor((z - r - this.oz) / c)), z1 = Math.min(this.nz - 1, Math.floor((z + r - this.oz) / c));
    const r2 = r * r;
    for (let iz = z0; iz <= z1; iz++)
      for (let iy = y0; iy <= y1; iy++)
        for (let ix = x0; ix <= x1; ix++) {
          const cell = (iz * this.ny + iy) * this.nx + ix;
          for (let k = this.start[cell]; k < this.start[cell + 1]; k++) {
            const i = this.items[k];
            const dx = this.pts[i * 3] - x, dy = this.pts[i * 3 + 1] - y, dz = this.pts[i * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= r2) cb(i);
          }
        }
  }
}

// ---------------------------------------------------------------------------
// Angular histogram: a rotation-about-Z fingerprint (its best circular shift gives
// the rotation between two copies)
// ---------------------------------------------------------------------------

const BINS = 360;

/**
 * @param {Float32Array} pts
 * @param {Float32Array} area
 * @param {number} cx
 * @param {number} cy
 * @returns {Float64Array}
 */
export function angularHistogram(pts, area, cx, cy) {
  const h = new Float64Array(BINS);
  const n = area.length;
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 3] - cx, dy = pts[i * 3 + 1] - cy;
    const r = Math.hypot(dx, dy);
    let a = Math.atan2(dy, dx);
    if (a < 0) a += 2 * Math.PI;
    const b = Math.floor((a / (2 * Math.PI)) * BINS) % BINS;
    h[b] += area[i] * r;
  }
  // smooth (circular box blur of width 5)
  const s = new Float64Array(BINS);
  for (let i = 0; i < BINS; i++) {
    let v = 0;
    for (let k = -2; k <= 2; k++) v += h[(i + k + BINS) % BINS];
    s[i] = v;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Distance to a piece's surface (triangles), for tessellation-independent fits
// ---------------------------------------------------------------------------

/**
 * Squared distance from p to triangle abc; writes the closest point to out.
 * (Real-Time Collision Detection, Ericson, 5.1.5)
 * @param {Float32Array} T triangle corner coordinates, 9 per triangle
 * @param {number} o offset of the triangle in T
 * @param {number} px
 * @param {number} py
 * @param {number} pz
 * @param {number[]} out
 * @returns {number}
 */
function closestOnTriangle(T, o, px, py, pz, out) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const abx = T[o + 3] - ax, aby = T[o + 4] - ay, abz = T[o + 5] - az;
  const acx = T[o + 6] - ax, acy = T[o + 7] - ay, acz = T[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let x, y, z;
  if (d1 <= 0 && d2 <= 0) {
    x = ax; y = ay; z = az;
  } else {
    const bpx = px - T[o + 3], bpy = py - T[o + 4], bpz = pz - T[o + 5];
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - T[o + 6], cpy = py - T[o + 7], cpz = pz - T[o + 8];
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2;
    const vb = d5 * d2 - d1 * d6;
    const va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) {
      x = T[o + 3]; y = T[o + 4]; z = T[o + 5];
    } else if (d6 >= 0 && d5 <= d6) {
      x = T[o + 6]; y = T[o + 7]; z = T[o + 8];
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      x = ax + v * abx; y = ay + v * aby; z = az + v * abz;
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      x = ax + w * acx; y = ay + w * acy; z = az + w * acz;
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      x = T[o + 3] + w * (T[o + 6] - T[o + 3]);
      y = T[o + 4] + w * (T[o + 7] - T[o + 4]);
      z = T[o + 5] + w * (T[o + 8] - T[o + 5]);
    } else {
      const den = 1 / (va + vb + vc);
      const v = vb * den, w = vc * den;
      x = ax + abx * v + acx * w;
      y = ay + aby * v + acy * w;
      z = az + abz * v + acz * w;
    }
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return (px - x) * (px - x) + (py - y) * (py - y) + (pz - z) * (pz - z);
}

/**
 * The triangles of one piece in a uniform grid; answers "closest point on the
 * surface" queries. Each triangle is listed in every cell its box overlaps.
 */
export class TriangleGrid {
  /** @type {Float32Array} corner coordinates, 9 per triangle */
  tris;
  /** @type {Float32Array} bounding sphere of each triangle: centre xyz, radius */
  spheres;
  /** @type {Uint32Array} mesh face index of each triangle */
  faces;
  /** @type {number} median edge length (mm) */
  edge;
  /** @type {number} */
  cell;
  /** @type {number} */
  ox;
  /** @type {number} */
  oy;
  /** @type {number} */
  oz;
  /** @type {number} */
  nx;
  /** @type {number} */
  ny;
  /** @type {number} */
  nz;
  /** @type {Uint32Array} */
  start;
  /** @type {Uint32Array} */
  items;
  /** @type {Uint32Array} */
  stamp;
  /** @type {number} */
  query = 0;

  /**
   * @param {Float32Array} positions
   * @param {Uint32Array} indices
   * @param {Uint32Array} faces faces of the piece
   */
  constructor(positions, indices, faces) {
    const n = faces.length;
    const T = new Float32Array(n * 9);
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    const edges = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = faces[i];
      for (let j = 0; j < 3; j++) {
        const v = indices[f * 3 + j] * 3;
        const x = positions[v], y = positions[v + 1], z = positions[v + 2];
        T[i * 9 + j * 3] = x;
        T[i * 9 + j * 3 + 1] = y;
        T[i * 9 + j * 3 + 2] = z;
        if (x < mnx) mnx = x;
        if (y < mny) mny = y;
        if (z < mnz) mnz = z;
        if (x > mxx) mxx = x;
        if (y > mxy) mxy = y;
        if (z > mxz) mxz = z;
      }
      edges[i] = Math.hypot(T[i * 9 + 3] - T[i * 9], T[i * 9 + 4] - T[i * 9 + 1], T[i * 9 + 5] - T[i * 9 + 2]);
    }
    if (n === 0) mnx = mny = mnz = mxx = mxy = mxz = 0;
    edges.sort();
    this.edge = n ? edges[n >> 1] : 1;
    this.tris = T;
    const S = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const o = i * 9;
      const x = (T[o] + T[o + 3] + T[o + 6]) / 3, y = (T[o + 1] + T[o + 4] + T[o + 7]) / 3, z = (T[o + 2] + T[o + 5] + T[o + 8]) / 3;
      S[i * 4] = x;
      S[i * 4 + 1] = y;
      S[i * 4 + 2] = z;
      S[i * 4 + 3] = Math.sqrt(
        Math.max(
          (T[o] - x) ** 2 + (T[o + 1] - y) ** 2 + (T[o + 2] - z) ** 2,
          (T[o + 3] - x) ** 2 + (T[o + 4] - y) ** 2 + (T[o + 5] - z) ** 2,
          (T[o + 6] - x) ** 2 + (T[o + 7] - y) ** 2 + (T[o + 8] - z) ** 2,
        ),
      );
    }
    this.spheres = S;
    this.faces = faces;
    // cells a bit smaller than a typical triangle edge, but at most 4 cells per triangle
    let cell = Math.max(this.edge * 0.7, 0.05);
    const vol = (mxx - mnx + cell) * (mxy - mny + cell) * (mxz - mnz + cell);
    const maxCells = Math.max(1024, n * 4);
    if (vol / (cell * cell * cell) > maxCells) cell = Math.cbrt(vol / maxCells);
    this.cell = cell;
    this.ox = mnx;
    this.oy = mny;
    this.oz = mnz;
    this.nx = Math.max(1, Math.floor((mxx - mnx) / cell) + 1);
    this.ny = Math.max(1, Math.floor((mxy - mny) / cell) + 1);
    this.nz = Math.max(1, Math.floor((mxz - mnz) / cell) + 1);
    const cells = this.nx * this.ny * this.nz;
    const counts = new Uint32Array(cells + 1);
    // two passes: count, then fill
    for (let pass = 0; pass < 2; pass++) {
      const fill = pass ? counts.slice(0, cells) : null;
      for (let i = 0; i < n; i++) {
        const o = i * 9;
        const x0 = this.ix(Math.min(T[o], T[o + 3], T[o + 6])), x1 = this.ix(Math.max(T[o], T[o + 3], T[o + 6]));
        const y0 = this.iy(Math.min(T[o + 1], T[o + 4], T[o + 7])), y1 = this.iy(Math.max(T[o + 1], T[o + 4], T[o + 7]));
        const z0 = this.iz(Math.min(T[o + 2], T[o + 5], T[o + 8])), z1 = this.iz(Math.max(T[o + 2], T[o + 5], T[o + 8]));
        for (let z = z0; z <= z1; z++)
          for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++) {
              const c = (z * this.ny + y) * this.nx + x;
              if (pass) this.items[fill[c]++] = i;
              else counts[c + 1]++;
            }
      }
      if (!pass) {
        for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
        this.items = new Uint32Array(counts[cells]);
      }
    }
    this.start = counts;
    this.stamp = new Uint32Array(n);
  }

  /** @param {number} x */
  ix(x) {
    const i = Math.floor((x - this.ox) / this.cell);
    return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
  }
  /** @param {number} y */
  iy(y) {
    const i = Math.floor((y - this.oy) / this.cell);
    return i < 0 ? 0 : i >= this.ny ? this.ny - 1 : i;
  }
  /** @param {number} z */
  iz(z) {
    const i = Math.floor((z - this.oz) / this.cell);
    return i < 0 ? 0 : i >= this.nz ? this.nz - 1 : i;
  }

  /**
   * Closest point on the surface within maxDist of (x, y, z). Returns the
   * triangle (index into `faces`) or -1; out receives the point and, in out[3],
   * the distance.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} maxDist
   * @param {number[]} out
   * @returns {number}
   */
  closest(x, y, z, maxDist, out) {
    if (++this.query === 0xffffffff) {
      this.stamp.fill(0);
      this.query = 1;
    }
    const q = this.query;
    const c = this.cell;
    // position in cell units
    const gx = (x - this.ox) / c, gy = (y - this.oy) / c, gz = (z - this.oz) / c;
    const cx = Math.floor(gx), cy = Math.floor(gy), cz = Math.floor(gz);
    const tmp = [0, 0, 0];
    const sph = this.spheres;
    let best = -1;
    let bestD = maxDist * maxDist;
    let bestDist = maxDist;
    const maxR = Math.ceil(maxDist / c);
    for (let r = 0; r <= maxR; r++) {
      const z0 = Math.max(0, cz - r), z1 = Math.min(this.nz - 1, cz + r);
      const y0 = Math.max(0, cy - r), y1 = Math.min(this.ny - 1, cy + r);
      const x0 = Math.max(0, cx - r), x1 = Math.min(this.nx - 1, cx + r);
      for (let iz = z0; iz <= z1; iz++) {
        const dz = iz > cz ? iz - gz : iz < cz ? gz - iz - 1 : 0;
        for (let iy = y0; iy <= y1; iy++) {
          const dy = iy > cy ? iy - gy : iy < cy ? gy - iy - 1 : 0;
          for (let ix = x0; ix <= x1; ix++) {
            if (Math.max(Math.abs(ix - cx), Math.abs(iy - cy), Math.abs(iz - cz)) !== r) continue;
            // skip cells farther away than the best hit so far
            const dx = ix > cx ? ix - gx : ix < cx ? gx - ix - 1 : 0;
            if ((dx * dx + dy * dy + dz * dz) * c * c >= bestD) continue;
            const cell = (iz * this.ny + iy) * this.nx + ix;
            for (let k = this.start[cell]; k < this.start[cell + 1]; k++) {
              const i = this.items[k];
              if (this.stamp[i] === q) continue;
              this.stamp[i] = q;
              // cheap rejection by the triangle's bounding sphere
              const sx = sph[i * 4] - x, sy = sph[i * 4 + 1] - y, sz = sph[i * 4 + 2] - z;
              const reach = sph[i * 4 + 3] + bestDist;
              if (sx * sx + sy * sy + sz * sz >= reach * reach) continue;
              const d = closestOnTriangle(this.tris, i * 9, x, y, z, tmp);
              if (d < bestD) {
                bestD = d;
                bestDist = Math.sqrt(d);
                best = i;
                out[0] = tmp[0];
                out[1] = tmp[1];
                out[2] = tmp[2];
              }
            }
          }
        }
      }
      // all cells up to ring r are done; stop when the hit is closer than any cell beyond
      if (best >= 0) {
        const wall = Math.min(gx - (cx - r), cx + r + 1 - gx, gy - (cy - r), cy + r + 1 - gy, gz - (cz - r), cz + r + 1 - gz) * c;
        if (wall > 0 && bestD <= wall * wall) break;
      }
    }
    out[3] = best >= 0 ? Math.sqrt(bestD) : Infinity;
    return best;
  }
}

/**
 * Points spread over a piece: its vertices (they lie on the true surface even on a
 * simplified mesh), thinned to at most `max` points.
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {Uint32Array} faces
 * @param {number} max
 * @returns {Float32Array}
 */
export function surfaceSamples(positions, indices, faces, max) {
  /** @type {Set<number>} */
  const seen = new Set();
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    seen.add(indices[f * 3]);
    seen.add(indices[f * 3 + 1]);
    seen.add(indices[f * 3 + 2]);
  }
  const verts = [...seen];
  const step = Math.max(1, verts.length / max);
  const n = Math.floor(verts.length / step);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = verts[Math.floor(i * step)] * 3;
    out[i * 3] = positions[v];
    out[i * 3 + 1] = positions[v + 1];
    out[i * 3 + 2] = positions[v + 2];
  }
  return out;
}

/**
 * Refine a transform so that `pts` (moved by t) lie on the surface in `grid`:
 * ICP against closest surface points, rotation about Z + XY translation.
 * @param {Float32Array} pts
 * @param {ZTransform} t0
 * @param {TriangleGrid} grid
 * @param {number} reach starting search distance (mm); shrinks every iteration
 * @param {number} [maxPoints] points used per iteration
 * @param {number} [iterations]
 * @returns {ZTransform}
 */
export function refineOnSurface(pts, t0, grid, reach, maxPoints = 1200, iterations = 8) {
  const n = pts.length / 3;
  const step = Math.max(1, Math.floor(n / maxPoints));
  let t = { ...t0 };
  const p = [0, 0, 0];
  const c = [0, 0, 0, 0];
  const a = [0, 0, 0], b = [0, 0, 0];
  for (let iter = 0; iter < iterations; iter++) {
    const maxD = Math.max(reach * Math.pow(0.6, iter), 4 * grid.edge, 0.3);
    let sqx = 0, sqy = 0, srx = 0, sry = 0, m = 0;
    /** @type {number[]} */
    const pairs = [];
    for (let i = 0; i < n; i += step) {
      applyZ(t, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], p);
      if (grid.closest(p[0], p[1], p[2], maxD, c) < 0) continue;
      pairs.push(pts[i * 3], pts[i * 3 + 1], c[0], c[1]);
      sqx += pts[i * 3];
      sqy += pts[i * 3 + 1];
      srx += c[0];
      sry += c[1];
      m++;
    }
    if (m < 10) break;
    const mqx = sqx / m, mqy = sqy / m, mrx = srx / m, mry = sry / m;
    let sxx = 0, sxy = 0;
    for (let k = 0; k < pairs.length; k += 4) {
      const ax = pairs[k] - mqx, ay = pairs[k + 1] - mqy;
      const bx = pairs[k + 2] - mrx, by = pairs[k + 3] - mry;
      sxx += ax * bx + ay * by;
      sxy += ax * by - ay * bx;
    }
    const th = Math.atan2(sxy, sxx);
    const next = { cos: Math.cos(th), sin: Math.sin(th), fx: mqx, fy: mqy, tx: mrx, ty: mry, dz: t.dz };
    // stop when a point 10 mm from the centre no longer moves
    applyZ(t, mqx + 10, mqy, 0, a);
    applyZ(next, mqx + 10, mqy, 0, b);
    t = next;
    if (iter >= 2 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-4) break;
  }
  return t;
}

/**
 * @typedef {object} SurfaceFit
 * @property {number} inside fraction of points within `tol` of the surface
 * @property {number} rms RMS distance of those points (mm)
 * @property {number} mean mean distance, each point capped at 4 x tol (mm)
 */

/**
 * How well `pts`, moved by t, lie on the surface in `grid`.
 * @param {Float32Array} pts
 * @param {ZTransform} t
 * @param {TriangleGrid} grid
 * @param {number} tol
 * @param {number} [maxPoints]
 * @returns {SurfaceFit}
 */
export function surfaceFit(pts, t, grid, tol, maxPoints = Infinity) {
  const n = pts.length / 3;
  const step = Math.max(1, Math.floor(n / maxPoints));
  const p = [0, 0, 0];
  const c = [0, 0, 0, 0];
  const cap = 4 * tol;
  let used = 0, inside = 0, sum = 0, total = 0;
  for (let i = 0; i < n; i += step) {
    applyZ(t, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], p);
    grid.closest(p[0], p[1], p[2], cap, c);
    const dist = Math.min(c[3], cap);
    used++;
    total += dist;
    if (dist <= tol) {
      inside++;
      sum += dist * dist;
    }
  }
  return { inside: used ? inside / used : 0, rms: inside ? Math.sqrt(sum / inside) : Infinity, mean: used ? total / used : Infinity };
}

// ---------------------------------------------------------------------------
// Matching two shapes (whole pieces or structures) independent of tessellation
// ---------------------------------------------------------------------------

/**
 * What matching needs to know about a set of faces.
 * @typedef {object} Shape
 * @property {Uint32Array} faces
 * @property {number} area surface area (mm²)
 * @property {number} cx area-weighted centre
 * @property {number} cy
 * @property {number} minZ
 * @property {Float64Array} hist angular histogram about the centre
 * @property {Float32Array} samples points on the surface (vertices)
 * @property {TriangleGrid | null} grid built on first use
 */

/**
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {Uint32Array} faces
 * @returns {Shape}
 */
export function makeShape(positions, indices, faces) {
  const n = faces.length;
  const pts = new Float32Array(n * 3);
  const area = new Float32Array(n);
  const P = positions;
  let A = 0, sx = 0, sy = 0, minZ = Infinity;
  for (let i = 0; i < n; i++) {
    const f = faces[i];
    const a = indices[f * 3] * 3, b = indices[f * 3 + 1] * 3, c = indices[f * 3 + 2] * 3;
    pts[i * 3] = (P[a] + P[b] + P[c]) / 3;
    pts[i * 3 + 1] = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    pts[i * 3 + 2] = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area[i] = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    A += area[i];
    sx += area[i] * pts[i * 3];
    sy += area[i] * pts[i * 3 + 1];
    minZ = Math.min(minZ, P[a + 2], P[b + 2], P[c + 2]);
  }
  const cx = A > 0 ? sx / A : 0, cy = A > 0 ? sy / A : 0;
  return {
    faces,
    area: A,
    cx,
    cy,
    minZ: n ? minZ : 0,
    hist: angularHistogram(pts, area, cx, cy),
    samples: surfaceSamples(positions, indices, faces, 3000),
    grid: null,
  };
}

/**
 * @param {Shape} s
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @returns {TriangleGrid}
 */
export function shapeGrid(s, positions, indices) {
  if (!s.grid) s.grid = new TriangleGrid(positions, indices, s.faces);
  return s.grid;
}

/**
 * Distance a point may be off the other surface and still count as matching:
 * 0.25 mm, more on coarse (simplified) meshes whose triangles cut corners.
 * @param {TriangleGrid} a
 * @param {TriangleGrid} b
 * @returns {number}
 */
export function matchTolerance(a, b) {
  return Math.max(0.25, 0.25 * Math.max(a.edge, b.edge));
}

/**
 * @typedef {object} ShapeMatch
 * @property {ZTransform} t maps q onto r
 * @property {number} inside worst of the two directions: fraction of points within tolerance
 * @property {number} rms worst of the two directions (mm)
 * @property {number} tol tolerance used (mm)
 */

/**
 * Align shape q onto shape r (rotation about Z + translation) and measure how
 * well the surfaces agree, both ways (q's points on r's surface and r's points
 * on q's surface), so a missing or extra feature on either side counts.
 * @param {Shape} q
 * @param {Shape} r
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {{ bothWays?: boolean; minInside?: number }} [opts] minInside: give up early below this
 * @returns {ShapeMatch}
 */
export function matchShapes(q, r, positions, indices, opts = {}) {
  const rg = shapeGrid(r, positions, indices);
  const qg = opts.bothWays === false ? rg : shapeGrid(q, positions, indices);
  const tol = matchTolerance(qg, rg);
  const reach = Math.max(1.5, 3 * rg.edge);
  // rotation candidates from the angular histograms, each briefly refined;
  // the first one is nearly always right, the others are tried only if it fits badly
  /** @type {{ t: ZTransform; score: number } | null} */
  let best = null;
  for (const shift of histogramPeaks(q.hist, r.hist, 3)) {
    const theta = (shift / BINS) * 2 * Math.PI;
    /** @type {ZTransform} */
    const t0 = { cos: Math.cos(theta), sin: Math.sin(theta), fx: q.cx, fy: q.cy, tx: r.cx, ty: r.cy, dz: r.minZ - q.minZ };
    const t = refineOnSurface(q.samples, t0, rg, reach, 300, 5);
    const score = surfaceFit(q.samples, t, rg, tol, 300).mean;
    if (!best || score < best.score) best = { t, score };
    if (best.score < 0.5 * tol) break;
  }
  const t = refineOnSurface(q.samples, best.t, rg, 4 * tol, 800, 8);
  const there = surfaceFit(q.samples, t, rg, tol, 1500);
  if (opts.bothWays === false || there.inside < (opts.minInside ?? 0)) return { t, inside: there.inside, rms: there.rms, tol };
  const back = surfaceFit(r.samples, invertZ(t), qg, tol, 1500);
  return { t, inside: Math.min(there.inside, back.inside), rms: Math.max(there.rms, back.rms), tol };
}

/**
 * The best few distinct rotations (in histogram bins) that turn q's angular
 * histogram into r's.
 * @param {Float64Array} qHist
 * @param {Float64Array} rHist
 * @param {number} count
 * @returns {number[]}
 */
function histogramPeaks(qHist, rHist, count) {
  const score = new Float64Array(BINS);
  for (let sh = 0; sh < BINS; sh++) {
    let sc = 0;
    for (let i = 0; i < BINS; i++) sc += qHist[i] * rHist[(i + sh) % BINS];
    score[sh] = sc;
  }
  const order = Array.from({ length: BINS }, (_, i) => i).sort((a, b) => score[b] - score[a]);
  /** @type {number[]} */
  const out = [];
  for (const sh of order) {
    if (out.some((s) => Math.min(Math.abs(s - sh), BINS - Math.abs(s - sh)) < 15)) continue;
    out.push(sh);
    if (out.length >= count) break;
  }
  return out;
}

