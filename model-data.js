/**
 * In-memory model: one indexed triangle mesh in world space (all transforms baked),
 * split into parts (contiguous face ranges) grouped into objects (build items).
 * Paint is one byte per face plus a sparse map of subdivided paint strings.
 */

/** faceState value meaning "see subdiv map for this face". */
export const SUBDIV = 255;
/** Data model supports up to 16 filaments in the UI (codec goes to 33). */
export const MAX_FILAMENTS = 16;

/**
 * @typedef {object} PartInfo
 * @property {string} name
 * @property {number} objectIndex
 * @property {number} firstFace
 * @property {number} faceCount
 * @property {number} firstVertex
 * @property {number} vertexCount
 * @property {number} extruder default filament (1-based) used by unpainted faces
 */

/**
 * @typedef {object} ObjectInfo
 * @property {string} name
 * @property {number} firstPart
 * @property {number} partCount
 */

/**
 * @typedef {object} ModelData
 * @property {string} name
 * @property {'stl' | '3mf'} format
 * @property {Float32Array} positions
 * @property {Uint32Array} indices
 * @property {Uint8Array} faceState 0 = unpainted, 1..33 = whole-triangle filament, SUBDIV = subdivided (see subdiv)
 * @property {Map<number, string>} subdiv
 * @property {PartInfo[]} parts
 * @property {ObjectInfo[]} objects
 * @property {string[]} filamentColors filament colours found in the file's project settings, '#RRGGBB'
 * @property {string[]} warnings
 * @property {LoadStats} stats
 */

/**
 * @typedef {object} LoadStats
 * @property {number} faces
 * @property {number} vertices
 * @property {number} paintedFaces
 * @property {number} subdividedFaces
 * @property {number} maxState
 * @property {number} seconds
 * @property {number} sourceBytes
 */

/**
 * @param {Pick<ModelData, 'indices'>} m
 * @returns {number}
 */
export function faceCount(m) {
  return m.indices.length / 3;
}

/**
 * Per-face default filament (1-based) from the part list.
 * @param {PartInfo[]} parts
 * @param {number} faces
 * @returns {Uint8Array}
 */
export function buildFaceDefaults(parts, faces) {
  const out = new Uint8Array(faces);
  out.fill(1);
  for (const p of parts) out.fill(Math.max(1, Math.min(255, p.extruder)), p.firstFace, p.firstFace + p.faceCount);
  return out;
}

/**
 * Find the part containing a face (binary search; parts are sorted by firstFace).
 * @param {PartInfo[]} parts
 * @param {number} face
 * @returns {number}
 */
export function partOfFace(parts, face) {
  let lo = 0;
  let hi = parts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (parts[mid].firstFace <= face) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Arrays that move between threads with a model.
 * @param {ModelData} m
 * @returns {ArrayBuffer[]}
 */
export function modelTransferables(m) {
  return [/** @type {ArrayBuffer} */ (m.positions.buffer), /** @type {ArrayBuffer} */ (m.indices.buffer), /** @type {ArrayBuffer} */ (m.faceState.buffer)];
}
