/**
 * Mesh topology on typed arrays: vertex->face incidence, edge neighbours and
 * connected pieces. Everything is O(faces) with flat arrays (no Maps).
 */

/**
 * CSR list of the faces around each vertex.
 * @typedef {object} VertexFaces
 * @property {Uint32Array} offsets
 * @property {Uint32Array} faces
 */

/**
 * @param {Uint32Array} indices
 * @param {number} vertexCount
 * @returns {VertexFaces}
 */
export function buildVertexFaces(indices, vertexCount) {
  const counts = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < indices.length; i++) counts[indices[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) counts[v + 1] += counts[v];
  const offsets = counts;
  const fill = offsets.slice(0, vertexCount);
  const faces = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) faces[fill[indices[i]]++] = (i / 3) | 0;
  return { offsets, faces };
}

/**
 * For each face corner k, the face across edge (v_k, v_k+1), or -1 on a border.
 * Non-manifold edges link to the first other face found.
 * @param {Uint32Array} indices
 * @param {VertexFaces} vf
 * @returns {Int32Array}
 */
export function buildNeighbors(indices, vf) {
  const F = indices.length / 3;
  const nb = new Int32Array(F * 3).fill(-1);
  const { offsets, faces } = vf;
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < 3; k++) {
      if (nb[f * 3 + k] !== -1) continue;
      const a = indices[f * 3 + k];
      const b = indices[f * 3 + ((k + 1) % 3)];
      for (let p = offsets[a]; p < offsets[a + 1]; p++) {
        const g = faces[p];
        if (g === f) continue;
        const g0 = indices[g * 3], g1 = indices[g * 3 + 1], g2 = indices[g * 3 + 2];
        let kk = -1;
        // edge (b,a) in g (opposite winding) or (a,b) for flipped faces
        if (g0 === b && g1 === a) kk = 0;
        else if (g1 === b && g2 === a) kk = 1;
        else if (g2 === b && g0 === a) kk = 2;
        else if (g0 === a && g1 === b) kk = 0;
        else if (g1 === a && g2 === b) kk = 1;
        else if (g2 === a && g0 === b) kk = 2;
        if (kk >= 0) {
          nb[f * 3 + k] = g;
          if (nb[g * 3 + kk] === -1) nb[g * 3 + kk] = f;
          break;
        }
      }
    }
  }
  return nb;
}

/**
 * @typedef {object} PieceTable
 * @property {Uint32Array} pieceOfFace piece index of every face
 * @property {Uint32Array} pieceStart CSR: faces of piece p are pieceFaces[pieceStart[p] .. pieceStart[p+1]) in ascending order
 * @property {Uint32Array} pieceFaces
 * @property {number} count
 */

/**
 * Connected pieces (faces connected through shared vertices), ordered by first face.
 * @param {Uint32Array} indices
 * @param {number} vertexCount
 * @returns {PieceTable}
 */
export function findPieces(indices, vertexCount) {
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  /**
   * @param {number} x
   * @returns {number}
   */
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const F = indices.length / 3;
  for (let f = 0; f < F; f++) {
    const a = find(indices[f * 3]);
    const b = find(indices[f * 3 + 1]);
    const c = find(indices[f * 3 + 2]);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    const ab = find(a);
    const cc = find(c);
    if (ab !== cc) parent[Math.max(ab, cc)] = Math.min(ab, cc);
  }
  // label roots in order of first face
  const label = new Int32Array(vertexCount).fill(-1);
  const pieceOfFace = new Uint32Array(F);
  let count = 0;
  /** @type {number[]} */
  const sizes = [];
  for (let f = 0; f < F; f++) {
    const r = find(indices[f * 3]);
    if (label[r] < 0) {
      label[r] = count++;
      sizes.push(0);
    }
    const p = label[r];
    pieceOfFace[f] = p;
    sizes[p]++;
  }
  const pieceStart = new Uint32Array(count + 1);
  for (let p = 0; p < count; p++) pieceStart[p + 1] = pieceStart[p] + sizes[p];
  const fill = pieceStart.slice(0, count);
  const pieceFaces = new Uint32Array(F);
  for (let f = 0; f < F; f++) pieceFaces[fill[pieceOfFace[f]]++] = f;
  return { pieceOfFace, pieceStart, pieceFaces, count };
}
