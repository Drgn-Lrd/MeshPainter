/**
 * Full piece analysis, run in the worker after a model is opened:
 * pieces, edge neighbours, identical groups with registration and face
 * correspondence, joint graph and head-to-tail chain.
 */
import { findPieces, buildVertexFaces, buildNeighbors } from './mesh-topology.js?v=18fa32f863';
/** @typedef {import('./mesh-topology.js').PieceTable} PieceTable */
import { pieceStats, makeShape, shapeGrid, matchShapes, applyZ } from './piece-matching.js?v=f6f03e4619';
/** @typedef {import('./piece-matching.js').Shape} Shape */
/** @typedef {import('./piece-matching.js').PieceStats} PieceStats */
/** @typedef {import('./piece-matching.js').ZTransform} ZTransform */
import { findJoints, buildChain } from './piece-chain.js?v=d247fe708c';
/** @typedef {import('./piece-chain.js').JointEdge} JointEdge */

/**
 * @typedef {object} PieceGroup
 * @property {number} ref
 * @property {number[]} members
 * @property {ZTransform[]} transforms member -> reference transform (identity for the reference)
 * @property {number} worstRms worst surface distance (RMS) of a member to the reference (mm)
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
 * Quick test before the (slower) shape comparison: size, volume and spread must
 * agree. Loose enough for simplified meshes, where copies of the same piece get
 * different triangles (the triangle count is not compared at all).
 * @param {PieceStats} s
 * @param {PieceStats} r
 * @returns {boolean}
 */
function similarStats(s, r) {
  return (
    near(s.area, r.area, 0.025) &&
    near(s.volume, r.volume, 0.025) &&
    near(s.ixx, r.ixx, 0.05) &&
    near(s.iyy, r.iyy, 0.05) &&
    Math.abs(s.max[2] - s.min[2] - (r.max[2] - r.min[2])) <= Math.max(0.3, 0.03 * (r.max[2] - r.min[2]))
  );
}

/**
 * How different two pieces' statistics are (for trying the likeliest group first).
 * @param {PieceStats} s
 * @param {PieceStats} r
 */
const statDistance = (s, r) =>
  Math.abs(s.area - r.area) / r.area + Math.abs(s.volume - r.volume) / Math.max(r.volume, 1e-9) + Math.abs(s.ixx - r.ixx) / Math.max(r.ixx, 1e-9);

/**
 * A member must have this fraction of its surface points on the reference's
 * surface (within matchTolerance), and the other way round. Copies of a piece
 * score 100 %; pieces that differ by a feature (a longer tail tip, a different
 * claw) score below 99 %.
 */
const SAME_SHAPE = 0.99;
/** at most this many candidate groups are tried for one piece */
const MAX_TRIES = 6;

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
  // Every piece is compared with the reference piece of each group whose
  // statistics are close; it joins the first group whose shape matches and
  // otherwise starts a new group (and becomes its reference).
  const groupOfPiece = new Int32Array(pieces.count).fill(-1);
  /** @type {PieceGroup[]} */
  const groups = [];
  /** @type {Shape[]} shapes of the reference pieces */
  const refShapes = [];
  const corr = new Uint32Array(F);
  for (let f = 0; f < F; f++) corr[f] = f;
  /** @param {number} p */
  const facesOf = (p) => pieces.pieceFaces.subarray(pieces.pieceStart[p], pieces.pieceStart[p + 1]);
  const tmp = [0, 0, 0];
  const hit = [0, 0, 0, 0];
  for (let p = 0; p < pieces.count; p++) {
    onProgress?.('Matching identical pieces', p, pieces.count);
    const candidates = groups
      .map((g, gi) => gi)
      .filter((gi) => similarStats(stats[p], stats[groups[gi].ref]))
      .sort((a, b) => statDistance(stats[p], stats[groups[a].ref]) - statDistance(stats[p], stats[groups[b].ref]))
      .slice(0, MAX_TRIES);
    /** @type {Shape | null} */
    let shape = null;
    let joined = false;
    for (const gi of candidates) {
      shape ??= makeShape(positions, indices, facesOf(p));
      const m = matchShapes(shape, refShapes[gi], positions, indices, { minInside: SAME_SHAPE });
      if (m.inside < SAME_SHAPE) continue;
      const group = groups[gi];
      group.members.push(p);
      group.transforms.push(m.t);
      group.worstRms = Math.max(group.worstRms, m.rms);
      groupOfPiece[p] = gi;
      // face correspondence: the reference face under each face's centre
      const rGrid = shapeGrid(refShapes[gi], positions, indices);
      const faces = facesOf(p);
      for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        const a = indices[f * 3] * 3, b = indices[f * 3 + 1] * 3, c = indices[f * 3 + 2] * 3;
        applyZ(m.t, (positions[a] + positions[b] + positions[c]) / 3, (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3, (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3, tmp);
        const k = rGrid.closest(tmp[0], tmp[1], tmp[2], 5, hit);
        if (k >= 0) corr[f] = rGrid.faces[k];
      }
      joined = true;
      break;
    }
    if (!joined) {
      groupOfPiece[p] = groups.length;
      groups.push({ ref: p, members: [p], transforms: [IDENTITY(stats[p])], worstRms: 0 });
      refShapes.push(shape ?? makeShape(positions, indices, facesOf(p)));
    }
  }
  onProgress?.('Matching identical pieces', pieces.count, pieces.count);

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
