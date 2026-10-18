/**
 * Round-trip comparison: the model in memory vs the same model re-imported
 * from the exported 3MF. Colours are compared as the slicer will print them
 * (unpainted faces resolved to their part's default filament).
 */
import { SUBDIV, buildFaceDefaults } from './model-data.js?v=bb5fb4d3b6';
/** @typedef {import('./model-data.js').ModelData} ModelData */
import { decodePaint, resolveUnpainted, treesEqual } from './paint-codec.js?v=0d8bec0312';

/**
 * @typedef {object} VerifyReport
 * @property {boolean} ok
 * @property {number} faces
 * @property {number} vertices
 * @property {number} facesBack
 * @property {number} verticesBack
 * @property {number} positionMismatches
 * @property {number} indexMismatches
 * @property {number} colourMismatches
 * @property {number} paintedFaces
 * @property {number} subdividedFaces
 * @property {number} subdividedMismatches
 * @property {string[]} examples
 */

/**
 * @param {ModelData} a
 * @param {ModelData} b
 * @returns {VerifyReport}
 */
export function compareModels(a, b) {
  const Fa = a.indices.length / 3;
  const Fb = b.indices.length / 3;
  const Va = a.positions.length / 3;
  const Vb = b.positions.length / 3;
  /** @type {VerifyReport} */
  const r = {
    ok: false,
    faces: Fa,
    vertices: Va,
    facesBack: Fb,
    verticesBack: Vb,
    positionMismatches: 0,
    indexMismatches: 0,
    colourMismatches: 0,
    paintedFaces: 0,
    subdividedFaces: 0,
    subdividedMismatches: 0,
    examples: [],
  };
  /** @param {string} s */
  const note = (s) => {
    if (r.examples.length < 8) r.examples.push(s);
  };
  if (Fa !== Fb) note(`Triangle count differs: ${Fa} vs ${Fb}`);
  if (Va !== Vb) note(`Vertex count differs: ${Va} vs ${Vb}`);
  const n = Math.min(a.positions.length, b.positions.length);
  for (let i = 0; i < n; i++) {
    if (a.positions[i] !== b.positions[i]) {
      if (r.positionMismatches === 0) note(`Vertex ${Math.floor(i / 3)} moved: ${a.positions[i]} vs ${b.positions[i]}`);
      r.positionMismatches++;
    }
  }
  const ni = Math.min(a.indices.length, b.indices.length);
  for (let i = 0; i < ni; i++) {
    if (a.indices[i] !== b.indices[i]) {
      if (r.indexMismatches === 0) note(`Triangle ${Math.floor(i / 3)} uses different vertices`);
      r.indexMismatches++;
    }
  }
  const da = buildFaceDefaults(a.parts, Fa);
  const db = buildFaceDefaults(b.parts, Fb);
  const F = Math.min(Fa, Fb);
  for (let f = 0; f < F; f++) {
    const sa = a.faceState[f];
    const sb = b.faceState[f];
    if (sa !== 0) r.paintedFaces++;
    if (sa === SUBDIV || sb === SUBDIV) {
      if (sa === SUBDIV) r.subdividedFaces++;
      if (sa !== SUBDIV || sb !== SUBDIV) {
        r.subdividedMismatches++;
        note(`Triangle ${f}: brush paint ${sa === SUBDIV ? 'lost' : 'appeared'}`);
        continue;
      }
      try {
        const ta = resolveUnpainted(decodePaint(a.subdiv.get(f)), da[f]);
        const tb = resolveUnpainted(decodePaint(b.subdiv.get(f)), db[f]);
        if (!treesEqual(ta, tb)) {
          r.subdividedMismatches++;
          note(`Triangle ${f}: brush paint differs (${a.subdiv.get(f)} vs ${b.subdiv.get(f)})`);
        }
      } catch (e) {
        r.subdividedMismatches++;
        note(`Triangle ${f}: ${(/** @type {Error} */ (e)).message}`);
      }
      continue;
    }
    const ea = sa || da[f];
    const eb = sb || db[f];
    if (ea !== eb) {
      if (r.colourMismatches < 3) note(`Triangle ${f}: filament ${ea} became ${eb}`);
      r.colourMismatches++;
    }
  }
  r.ok =
    Fa === Fb &&
    Va === Vb &&
    r.positionMismatches === 0 &&
    r.indexMismatches === 0 &&
    r.colourMismatches === 0 &&
    r.subdividedMismatches === 0;
  return r;
}
