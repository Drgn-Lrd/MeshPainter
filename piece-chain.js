/**
 * Joint graph and head-to-tail chain.
 * Two pieces are joined when a large part of their surfaces runs within `gap` mm
 * of each other. The contact area is measured on the surfaces themselves, so it
 * does not depend on how finely the model is triangulated: a print-in-place
 * joint has tens of mm² of contact, pieces that merely touch have a few.
 * The chain is the longest path through the joint graph; other pieces branch off it.
 */
/** @typedef {import('./mesh-topology.js').PieceTable} PieceTable */
/** @typedef {import('./piece-matching.js').PieceStats} PieceStats */
import { PointGrid, TriangleGrid } from './piece-matching.js?v=f6f03e4619';

/**
 * @typedef {object} JointEdge
 * @property {number} a
 * @property {number} b
 * @property {number} area contact area (mm²): surface of the smaller side within the gap of the other piece
 */

/**
 * @typedef {object} ChainInfo
 * @property {JointEdge[]} edges
 * @property {number[]} order pieces from head to tail
 * @property {Int32Array} position chain position of every piece; branch pieces get the position of the chain piece they hang from; -1 if unconnected
 */

/**
 * @param {Uint32Array} indices
 * @param {number} vertexCount
 * @param {PieceTable} pt
 * @returns {{ start: Uint32Array; verts: Uint32Array }}
 */
export function pieceVertexLists(indices, vertexCount, pt) {
  const owner = new Int32Array(vertexCount).fill(-1);
  const counts = new Uint32Array(pt.count + 1);
  for (let p = 0; p < pt.count; p++) {
    for (let k = pt.pieceStart[p]; k < pt.pieceStart[p + 1]; k++) {
      const f = pt.pieceFaces[k];
      for (let j = 0; j < 3; j++) {
        const v = indices[f * 3 + j];
        if (owner[v] !== p) {
          owner[v] = p;
          counts[p + 1]++;
        }
      }
    }
  }
  for (let p = 0; p < pt.count; p++) counts[p + 1] += counts[p];
  const fill = counts.slice(0, pt.count);
  const verts = new Uint32Array(counts[pt.count]);
  owner.fill(-1);
  for (let p = 0; p < pt.count; p++) {
    for (let k = pt.pieceStart[p]; k < pt.pieceStart[p + 1]; k++) {
      const f = pt.pieceFaces[k];
      for (let j = 0; j < 3; j++) {
        const v = indices[f * 3 + j];
        if (owner[v] !== p) {
          owner[v] = p;
          verts[fill[p]++] = v;
        }
      }
    }
  }
  return { start: counts, verts };
}

/**
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {PieceTable} pt
 * @param {PieceStats[]} stats
 * @param {number} [gap] mm
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {JointEdge[]}
 */
export function findJoints(
  positions,
  indices,
  pt,
  stats,
  gap = 0.9,
  onProgress,
) {
  const V = positions.length / 3;
  const pv = pieceVertexLists(indices, V, pt);
  const n = pt.count;
  // typical triangle edge of each piece (from its mean triangle area)
  const edge = stats.map((s) => Math.sqrt((4 * s.area) / (Math.sqrt(3) * Math.max(1, s.faces))));
  // candidate pairs by overlapping expanded boxes (sweep along x)
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => stats[a].min[0] - stats[b].min[0]);
  /** @type {[number, number][]} */
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const a = stats[order[i]];
    for (let j = i + 1; j < n; j++) {
      const b = stats[order[j]];
      if (b.min[0] > a.max[0] + gap) break;
      if (b.min[1] > a.max[1] + gap || a.min[1] > b.max[1] + gap) continue;
      if (b.min[2] > a.max[2] + gap || a.min[2] > b.max[2] + gap) continue;
      pairs.push([order[i], order[j]]);
    }
  }
  /** @type {JointEdge[]} */
  const edges = [];
  const P = positions;
  const near = new Uint8Array(V);
  pairs.forEach(([a, b], idx) => {
    if (onProgress && idx % 20 === 0) onProgress(idx, pairs.length);
    // vertices of each piece inside the overlap of the two boxes
    const sa = stats[a], sb = stats[b];
    const lo = [0, 1, 2].map((d) => Math.max(sa.min[d], sb.min[d]) - gap);
    const hi = [0, 1, 2].map((d) => Math.min(sa.max[d], sb.max[d]) + gap);
    /** @param {number} v */
    const inBox = (v) =>
      P[v * 3] >= lo[0] && P[v * 3] <= hi[0] && P[v * 3 + 1] >= lo[1] && P[v * 3 + 1] <= hi[1] && P[v * 3 + 2] >= lo[2] && P[v * 3 + 2] <= hi[2];
    /** @param {number} p */
    const collect = (p) => {
      /** @type {number[]} */
      const out = [];
      for (let k = pv.start[p]; k < pv.start[p + 1]; k++) if (inBox(pv.verts[k])) out.push(pv.verts[k]);
      return out;
    };
    const va = collect(a);
    const vb = collect(b);
    if (!va.length || !vb.length) return;
    // keep the vertices that come close to the other piece (generous reach: the
    // other piece's surface can be closer than its nearest vertex)
    const reach = gap + 2 * Math.max(edge[a], edge[b]);
    const ga = vertexGrid(P, va, reach), gb = vertexGrid(P, vb, reach);
    let any = false;
    for (const v of va) if (gb.nearest(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], reach) >= 0) (near[v] = 1), (any = true);
    for (const v of vb) if (ga.nearest(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], reach) >= 0) near[v] = 1;
    if (any) {
      // faces of each piece touching such a vertex, then the exact contact area both ways
      const fa = nearFaces(indices, pt, a, near), fb = nearFaces(indices, pt, b, near);
      if (fa.length && fb.length) {
        const area = Math.min(contactArea(P, indices, fa, new TriangleGrid(P, indices, fb), gap), contactArea(P, indices, fb, new TriangleGrid(P, indices, fa), gap));
        if (area > 0) edges.push({ a, b, area });
      }
    }
    for (const v of va) near[v] = 0;
    for (const v of vb) near[v] = 0;
  });
  return edges;
}

/**
 * @param {Float32Array} P
 * @param {number[]} verts
 * @param {number} cell
 * @returns {PointGrid}
 */
function vertexGrid(P, verts, cell) {
  const pts = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => {
    pts[i * 3] = P[v * 3];
    pts[i * 3 + 1] = P[v * 3 + 1];
    pts[i * 3 + 2] = P[v * 3 + 2];
  });
  return new PointGrid(pts, cell);
}

/**
 * Faces of piece p with at least one marked vertex.
 * @param {Uint32Array} indices
 * @param {PieceTable} pt
 * @param {number} p
 * @param {Uint8Array} mark
 * @returns {Uint32Array}
 */
function nearFaces(indices, pt, p, mark) {
  /** @type {number[]} */
  const out = [];
  for (let k = pt.pieceStart[p]; k < pt.pieceStart[p + 1]; k++) {
    const f = pt.pieceFaces[k];
    if (mark[indices[f * 3]] || mark[indices[f * 3 + 1]] || mark[indices[f * 3 + 2]]) out.push(f);
  }
  return Uint32Array.from(out);
}

/**
 * Total area of the faces whose centre lies within `gap` of the surface in `grid`.
 * @param {Float32Array} P
 * @param {Uint32Array} indices
 * @param {Uint32Array} faces
 * @param {TriangleGrid} grid
 * @param {number} gap
 * @returns {number}
 */
function contactArea(P, indices, faces, grid, gap) {
  const hit = [0, 0, 0, 0];
  let total = 0;
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    const a = indices[f * 3] * 3, b = indices[f * 3 + 1] * 3, c = indices[f * 3 + 2] * 3;
    const x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    if (grid.closest(x, y, z, gap, hit) < 0) continue;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return total;
}

/**
 * Smallest contact area that counts as a joint. Joints of one model are much alike
 * while touching pieces have far less contact, so look for the biggest jump
 * (at least 2.5x) in the sorted areas below the median; without one, a quarter
 * of the median.
 * @param {JointEdge[]} edges
 * @returns {number}
 */
export function jointThreshold(edges) {
  const areas = edges.map((e) => e.area).sort((x, y) => x - y);
  if (!areas.length) return Infinity;
  const median = areas[areas.length >> 1];
  let best = 0, threshold = 0.25 * median;
  for (let i = 0; i + 1 < areas.length && areas[i + 1] <= median; i++) {
    const ratio = areas[i + 1] / Math.max(areas[i], 0.05);
    if (ratio >= 2.5 && ratio > best) {
      best = ratio;
      threshold = Math.sqrt(areas[i + 1] * Math.max(areas[i], 0.05));
    }
  }
  return Math.max(0.5, threshold);
}

/**
 * Chain from the joint graph: keep the real joints (see jointThreshold), take the
 * longest path (double BFS on the largest connected group), and put the end with
 * the larger piece first (the head is usually the biggest piece).
 * @param {number} pieceCount
 * @param {JointEdge[]} edges
 * @param {PieceStats[]} stats
 * @returns {ChainInfo}
 */
export function buildChain(pieceCount, edges, stats) {
  const minArea = jointThreshold(edges);
  /** @type {number[][]} */
  const adj = Array.from({ length: pieceCount }, () => []);
  for (const e of edges) {
    if (e.area < minArea) continue;
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  /** @param {number} src */
  const bfs = (src) => {
    const dist = new Int32Array(pieceCount).fill(-1);
    const prev = new Int32Array(pieceCount).fill(-1);
    dist[src] = 0;
    const q = [src];
    for (let i = 0; i < q.length; i++) {
      const u = q[i];
      for (const w of adj[u])
        if (dist[w] < 0) {
          dist[w] = dist[u] + 1;
          prev[w] = u;
          q.push(w);
        }
    }
    return { dist, prev, visited: q };
  };
  // largest connected group
  const seen = new Uint8Array(pieceCount);
  /** @type {number[]} */
  let bestComp = [];
  for (let p = 0; p < pieceCount; p++) {
    if (seen[p]) continue;
    const { visited } = bfs(p);
    for (const v of visited) seen[v] = 1;
    if (visited.length > bestComp.length) bestComp = visited;
  }
  const position = new Int32Array(pieceCount).fill(-1);
  if (bestComp.length < 2) return { edges, order: bestComp.slice(0, 1), position };
  /** @param {number} src */
  const far = (src) => {
    const r = bfs(src);
    let best = src;
    for (const v of r.visited) if (r.dist[v] > r.dist[best]) best = v;
    return { node: best, ...r };
  };
  const e1 = far(bestComp[0]).node;
  const r2 = far(e1);
  /** @type {number[]} */
  const path = [];
  for (let v = r2.node; v >= 0; v = r2.prev[v]) path.push(v);
  // path runs from r2.node back to e1; head = the end with the larger piece
  const endA = path[0], endB = path[path.length - 1];
  if (stats[endB].volume > stats[endA].volume) path.reverse();
  path.forEach((p, i) => (position[p] = i));
  // branch pieces: position of the nearest chain piece (multi-source BFS)
  const q = [...path];
  for (let i = 0; i < q.length; i++) {
    const u = q[i];
    for (const w of adj[u])
      if (position[w] < 0) {
        position[w] = position[u];
        q.push(w);
      }
  }
  return { edges, order: path, position };
}
