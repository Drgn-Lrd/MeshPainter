/**
 * Piece analysis: per-piece statistics, groups of identical pieces with a rigid
 * registration (rotation about Z + translation) to the group's reference piece,
 * a face-to-face correspondence to that reference, and the joint graph / chain.
 *
 * Pieces of print-in-place models lie flat on the plate, so copies differ only by
 * a rotation about Z and a translation, but their tessellation can differ a little
 * (the Rosewing body segments vary by up to ~100 of ~20,400 triangles).
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
// Face centroids of a piece
// ---------------------------------------------------------------------------

/**
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {PieceTable} pt
 * @param {number} p
 * @returns {{ pts: Float32Array; area: Float32Array }}
 */
export function pieceCentroids(positions, indices, pt, p) {
  const s = pt.pieceStart[p], e = pt.pieceStart[p + 1];
  const pts = new Float32Array((e - s) * 3);
  const area = new Float32Array(e - s);
  const P = positions;
  for (let k = s; k < e; k++) {
    const f = pt.pieceFaces[k];
    const a = indices[f * 3] * 3, b = indices[f * 3 + 1] * 3, c = indices[f * 3 + 2] * 3;
    const o = (k - s) * 3;
    pts[o] = (P[a] + P[b] + P[c]) / 3;
    pts[o + 1] = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    pts[o + 2] = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area[k - s] = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
  }
  return { pts, area };
}

// ---------------------------------------------------------------------------
// Registration: rotation about Z by angular-histogram correlation, refined by 2D ICP
// ---------------------------------------------------------------------------

const BINS = 360;

/**
 * @param {Float32Array} pts
 * @param {Float32Array} area
 * @param {number} cx
 * @param {number} cy
 * @returns {Float64Array}
 */
function angularHistogram(pts, area, cx, cy) {
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

/**
 * @typedef {object} Registration
 * @property {ZTransform} t
 * @property {number} rms RMS distance (mm) of matched centroids after alignment
 * @property {number} inliers fraction of sampled centroids with a partner within tolerance
 */

/**
 * Register piece Q onto reference R. Returns the transform mapping Q coordinates
 * into R coordinates.
 * @param {Float32Array} qPts
 * @param {Float32Array} qArea
 * @param {PieceStats} qStats
 * @param {PointGrid} rGrid
 * @param {Float32Array} rPts
 * @param {Float64Array} rHist
 * @param {PieceStats} rStats
 * @returns {Registration}
 */
export function registerPieces(
  qPts,
  qArea,
  qStats,
  rGrid,
  rPts,
  rHist,
  rStats,
) {
  const qHist = angularHistogram(qPts, qArea, qStats.cx, qStats.cy);
  // best circular shift: rotate Q by +shift bins to match R
  /** @type {{ shift: number; score: number }[]} */
  const candidates = [];
  for (let sh = 0; sh < BINS; sh++) {
    let sc = 0;
    for (let i = 0; i < BINS; i++) sc += qHist[i] * rHist[(i + sh) % BINS];
    candidates.push({ shift: sh, score: sc });
  }
  candidates.sort((a, b) => b.score - a.score);
  // try the top few distinct peaks, keep the best ICP result
  /** @type {number[]} */
  const tried = [];
  /** @type {Registration | null} */
  let best = null;
  for (const c of candidates) {
    if (tried.some((s) => Math.min(Math.abs(s - c.shift), BINS - Math.abs(s - c.shift)) < 15)) continue;
    tried.push(c.shift);
    const theta = (c.shift / BINS) * 2 * Math.PI;
    const reg = icp2d(qPts, rGrid, rPts, {
      cos: Math.cos(theta),
      sin: Math.sin(theta),
      fx: qStats.cx,
      fy: qStats.cy,
      tx: rStats.cx,
      ty: rStats.cy,
      dz: rStats.min[2] - qStats.min[2],
    });
    if (!best || reg.rms < best.rms) best = reg;
    if (tried.length >= 3 || best.rms < 0.05) break;
  }
  return best;
}

/**
 * @param {Float32Array} qPts
 * @param {PointGrid} rGrid
 * @param {Float32Array} rPts
 * @param {ZTransform} t0
 * @returns {Registration}
 */
function icp2d(qPts, rGrid, rPts, t0) {
  const n = qPts.length / 3;
  const step = Math.max(1, Math.floor(n / 1500));
  let t = { ...t0 };
  const tmp = [0, 0, 0];
  let rms = Infinity;
  let inliers = 0;
  for (let iter = 0; iter < 12; iter++) {
    let sqx = 0, sqy = 0, srx = 0, sry = 0, cnt = 0;
    /** @type {number[]} */
    const pairs = [];
    let sumD = 0;
    for (let i = 0; i < n; i += step) {
      applyZ(t, qPts[i * 3], qPts[i * 3 + 1], qPts[i * 3 + 2], tmp);
      const j = rGrid.nearest(tmp[0], tmp[1], tmp[2], iter < 3 ? 3 : 1);
      if (j < 0) continue;
      const d = Math.hypot(rPts[j * 3] - tmp[0], rPts[j * 3 + 1] - tmp[1], rPts[j * 3 + 2] - tmp[2]);
      pairs.push(i, j);
      sumD += d * d;
    }
    const m = pairs.length / 2;
    if (m < 10) break;
    rms = Math.sqrt(sumD / m);
    inliers = m / Math.ceil(n / step);
    // Procrustes in 2D between transformed-source pivots: solve for rotation about Q pivot
    for (let k = 0; k < pairs.length; k += 2) {
      const i = pairs[k], j = pairs[k + 1];
      sqx += qPts[i * 3];
      sqy += qPts[i * 3 + 1];
      srx += rPts[j * 3];
      sry += rPts[j * 3 + 1];
      cnt++;
    }
    const mqx = sqx / cnt, mqy = sqy / cnt, mrx = srx / cnt, mry = sry / cnt;
    let sxx = 0, sxy = 0;
    for (let k = 0; k < pairs.length; k += 2) {
      const i = pairs[k], j = pairs[k + 1];
      const ax = qPts[i * 3] - mqx, ay = qPts[i * 3 + 1] - mqy;
      const bx = rPts[j * 3] - mrx, by = rPts[j * 3 + 1] - mry;
      sxx += ax * bx + ay * by;
      sxy += ax * by - ay * bx;
    }
    const th = Math.atan2(sxy, sxx);
    /** @type {ZTransform} */
    const next = { cos: Math.cos(th), sin: Math.sin(th), fx: mqx, fy: mqy, tx: mrx, ty: mry, dz: t.dz };
    const moved = Math.abs(next.cos - t.cos) + Math.abs(next.sin - t.sin) + Math.abs(next.tx - t.tx - (next.fx - t.fx)) * 0;
    t = next;
    if (iter > 4 && moved < 1e-7) break;
  }
  // final residual
  let sumD = 0, m = 0, good = 0;
  for (let i = 0; i < n; i += step) {
    applyZ(t, qPts[i * 3], qPts[i * 3 + 1], qPts[i * 3 + 2], tmp);
    const j = rGrid.nearest(tmp[0], tmp[1], tmp[2], 1);
    m++;
    if (j < 0) continue;
    const d = Math.hypot(rPts[j * 3] - tmp[0], rPts[j * 3 + 1] - tmp[1], rPts[j * 3 + 2] - tmp[2]);
    sumD += d * d;
    if (d < 0.25) good++;
  }
  rms = m ? Math.sqrt(sumD / Math.max(1, good)) : Infinity;
  inliers = m ? good / m : 0;
  return { t, rms, inliers };
}

export { angularHistogram };
