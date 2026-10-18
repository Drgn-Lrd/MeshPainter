/**
 * Joint graph and head-to-tail chain.
 * Two pieces are joined when many of their vertices come within `gap` mm of each
 * other (print-in-place joints have hundreds; rings that only touch have a few).
 * The chain is the longest path through the joint graph; other pieces branch off it.
 */
/** @typedef {import('./mesh-topology.js').PieceTable} PieceTable */
/** @typedef {import('./piece-matching.js').PieceStats} PieceStats */
import { PointGrid } from './piece-matching.js?v=7ec7bd113b';

/**
 * @typedef {object} JointEdge
 * @property {number} a
 * @property {number} b
 * @property {number} count vertices of the smaller side within the gap
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
  pairs.forEach(([a, b], idx) => {
    // overlap box
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
    const [small, large] = va.length <= vb.length ? [va, vb] : [vb, va];
    const pts = new Float32Array(large.length * 3);
    large.forEach((v, i) => {
      pts[i * 3] = P[v * 3];
      pts[i * 3 + 1] = P[v * 3 + 1];
      pts[i * 3 + 2] = P[v * 3 + 2];
    });
    const grid = new PointGrid(pts, gap);
    let count = 0;
    for (const v of small) if (grid.nearest(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], gap) >= 0) count++;
    if (count > 0) edges.push({ a, b, count });
    if (onProgress && idx % 50 === 0) onProgress(idx, pairs.length);
  });
  return edges;
}

/**
 * Chain from the joint graph: keep joints with at least `minCount` close vertices,
 * take the longest path (double BFS on the largest connected group), and put the
 * end with the larger piece first (the head is usually the biggest piece).
 * @param {number} pieceCount
 * @param {JointEdge[]} edges
 * @param {PieceStats[]} stats
 * @returns {ChainInfo}
 */
export function buildChain(pieceCount, edges, stats, minCount = 60) {
  /** @type {number[][]} */
  const adj = Array.from({ length: pieceCount }, () => []);
  for (const e of edges) {
    if (e.count < minCount) continue;
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
