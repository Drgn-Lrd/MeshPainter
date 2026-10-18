/**
 * Full piece analysis, run in the worker after a model is opened:
 * pieces, edge neighbours, identical groups with registration and face
 * correspondence, joint graph and head-to-tail chain.
 */
import { findPieces, buildVertexFaces, buildNeighbors } from './mesh-topology.js?v=18fa32f863';
/** @typedef {import('./mesh-topology.js').PieceTable} PieceTable */
import { pieceStats, pieceCentroids, PointGrid, registerPieces, angularHistogram, applyZ } from './piece-matching.js?v=7ec7bd113b';
/** @typedef {import('./piece-matching.js').PieceStats} PieceStats */
/** @typedef {import('./piece-matching.js').ZTransform} ZTransform */
import { findJoints, buildChain } from './piece-chain.js?v=27b7717146';
/** @typedef {import('./piece-chain.js').JointEdge} JointEdge */

/**
 * @typedef {object} PieceGroup
 * @property {number} ref
 * @property {number[]} members
 * @property {ZTransform[]} transforms member -> reference transform (identity for the reference)
 * @property {number} worstRms worst registration residual of the group (mm)
 */

/**
 * @typedef {object} Analysis
 * @property {PieceTable} pieces
 * @property {PieceStats[]} stats
 * @property {Int32Array} neighbors
 * @property {PieceGroup[]} groups
 * @property {Int32Array} groupOfPiece
 * @property {Uint32Array} corr for every face, the corresponding face on its group's reference piece
 * @property {JointEdge[]} joints
 * @property {number[]} chainOrder
 * @property {Int32Array} chainPosition
 * @property {number} seconds
 */

/** @typedef {(phase: string, done: number, total: number) => void} AnalysisProgress */

/**
 * @param {number} a
 * @param {number} b
 * @param {number} tol
 */
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-9);

/**
 * @param {PieceStats} s
 * @param {PieceStats} r
 * @returns {boolean}
 */
function sameSignature(s, r) {
  return (
    near(s.faces, r.faces, 0.03) &&
    near(s.area, r.area, 0.01) &&
    near(s.volume, r.volume, 0.015) &&
    Math.abs(s.max[2] - s.min[2] - (r.max[2] - r.min[2])) < 0.08 &&
    near(s.ixx, r.ixx, 0.03) &&
    near(s.iyy, r.iyy, 0.03)
  );
}

/**
 * @param {PieceStats} s
 * @returns {ZTransform}
 */
const IDENTITY = (s) => ({ cos: 1, sin: 0, fx: s.cx, fy: s.cy, tx: s.cx, ty: s.cy, dz: 0 });

/**
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {AnalysisProgress} [onProgress]
 * @returns {Analysis}
 */
export function analyze(positions, indices, onProgress) {
  const t0 = performance.now();
  const V = positions.length / 3;
  const F = indices.length / 3;
  onProgress?.('Finding pieces', 0, 1);
  const pieces = findPieces(indices, V);
  const stats = pieceStats(positions, indices, pieces);
  onProgress?.('Linking neighbouring triangles', 0, 1);
  const vf = buildVertexFaces(indices, V);
  const neighbors = buildNeighbors(indices, vf);

  // --- identical groups -------------------------------------------------------
  const groupOfPiece = new Int32Array(pieces.count).fill(-1);
  /** @type {PieceGroup[]} */
  const groups = [];
  const corr = new Uint32Array(F);
  for (let f = 0; f < F; f++) corr[f] = f;
  // candidate buckets by signature, largest pieces first
  const order = Array.from({ length: pieces.count }, (_, i) => i).sort((a, b) => stats[b].faces - stats[a].faces);
  /** @type {number[][]} */
  const buckets = [];
  for (const p of order) {
    const b = buckets.find((b) => sameSignature(stats[p], stats[b[0]]));
    if (b) b.push(p);
    else buckets.push([p]);
  }
  let registered = 0;
  const toRegister = buckets.reduce((n, b) => n + (b.length > 1 ? b.length - 1 : 0), 0);
  for (let bucket of buckets) {
    while (bucket.length) {
      const ref = Math.min(...bucket); // lowest index = stable choice
      /** @type {PieceGroup} */
      const group = { ref, members: [ref], transforms: [IDENTITY(stats[ref])], worstRms: 0 };
      groupOfPiece[ref] = groups.length;
      /** @type {number[]} */
      const rest = [];
      if (bucket.length > 1) {
        const rc = pieceCentroids(positions, indices, pieces, ref);
        const grid = new PointGrid(rc.pts, 0.3);
        const rHist = angularHistogram(rc.pts, rc.area, stats[ref].cx, stats[ref].cy);
        const refStart = pieces.pieceStart[ref];
        for (const q of bucket) {
          if (q === ref) continue;
          const qc = pieceCentroids(positions, indices, pieces, q);
          const reg = registerPieces(qc.pts, qc.area, stats[q], grid, rc.pts, rHist, stats[ref]);
          registered++;
          onProgress?.('Matching identical pieces', registered, toRegister);
          if (reg.inliers < 0.97 || reg.rms > 0.12) {
            rest.push(q);
            continue;
          }
          group.members.push(q);
          group.transforms.push(reg.t);
          group.worstRms = Math.max(group.worstRms, reg.rms);
          groupOfPiece[q] = groups.length;
          // face correspondence q -> ref
          const tmp = [0, 0, 0];
          const qs = pieces.pieceStart[q];
          const n = qc.area.length;
          for (let i = 0; i < n; i++) {
            applyZ(reg.t, qc.pts[i * 3], qc.pts[i * 3 + 1], qc.pts[i * 3 + 2], tmp);
            let j = grid.nearest(tmp[0], tmp[1], tmp[2], 1);
            if (j < 0) j = grid.nearest(tmp[0], tmp[1], tmp[2], 5);
            if (j >= 0) corr[pieces.pieceFaces[qs + i]] = pieces.pieceFaces[refStart + j];
          }
        }
      }
      groups.push(group);
      bucket = rest;
    }
  }

  // --- joints and chain -----------------------------------------------------------
  onProgress?.('Finding joints', 0, 1);
  const joints = findJoints(positions, indices, pieces, stats, 0.9, (d, t) => onProgress?.('Finding joints', d, t));
  const chain = buildChain(pieces.count, joints, stats);
  // prefer the chain end that the side pieces (legs, wings) hang closer to as the head
  if (chain.order.length > 3) {
    const L = chain.order.length;
    let sum = 0, cnt = 0;
    for (let p = 0; p < pieces.count; p++) {
      if (chain.position[p] >= 0 && !chain.order.includes(p)) {
        sum += chain.position[p];
        cnt++;
      }
    }
    if (cnt > 0 && sum / cnt > (L - 1) / 2) {
      chain.order.reverse();
      for (let p = 0; p < pieces.count; p++) if (chain.position[p] >= 0) chain.position[p] = L - 1 - chain.position[p];
    }
  }
  return {
    pieces,
    stats,
    neighbors,
    groups,
    groupOfPiece,
    corr,
    joints,
    chainOrder: chain.order,
    chainPosition: chain.position,
    seconds: (performance.now() - t0) / 1000,
  };
}

/**
 * @param {Analysis} a
 * @returns {ArrayBuffer[]}
 */
export function analysisTransferables(a) {
  return /** @type {ArrayBuffer[]} */ ([
    a.pieces.pieceOfFace.buffer,
    a.pieces.pieceStart.buffer,
    a.pieces.pieceFaces.buffer,
    a.neighbors.buffer,
    a.groupOfPiece.buffer,
    a.corr.buffer,
    a.chainPosition.buffer,
  ]);
}
