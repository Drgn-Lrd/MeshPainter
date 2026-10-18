import * as THREE from './lib/three.js?v=51d02c347d';
/** @typedef {import('./model-data.js').ModelData} ModelData */
/** @typedef {import('./model-data.js').PartInfo} PartInfo */

/**
 * A small procedural "dragon chain" shown before a file is opened: identical
 * segments, each with a knot "rose" on top, so the Structure tool has copies to find.
 * @returns {ModelData}
 */
export function makeSampleModel() {
  /** @type {number[]} */
  const pos = [];
  /** @type {number[]} */
  const idx = [];
  /** @type {number[]} */
  const state = [];
  /** @type {PartInfo[]} */
  const parts = [];

  /**
   * @param {THREE.BufferGeometry} g
   * @param {THREE.Matrix4} m
   * @param {number} paint
   */
  const add = (g, m, paint) => {
    g.applyMatrix4(m);
    const p = g.getAttribute('position');
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    const index = g.getIndex();
    for (let i = 0; i < index.count; i += 3) {
      idx.push(base + index.getX(i), base + index.getX(i + 1), base + index.getX(i + 2));
      state.push(paint);
    }
    g.dispose();
  };

  const N = 11;
  const R = 62;
  for (let k = 0; k < N; k++) {
    const firstFace = state.length;
    const firstVertex = pos.length / 3;
    const t = (k / (N - 1) - 0.5) * 1.9;
    const x = Math.sin(t) * R;
    const y = Math.cos(t) * R - R * 0.55;
    const heading = -t;
    const head = k === 0;
    const scale = head ? 1.45 : 1;
    const body = new THREE.CapsuleGeometry(6, 9, 6, 22);
    const mb = new THREE.Matrix4()
      .makeTranslation(x, y, 5.2 * scale)
      .multiply(new THREE.Matrix4().makeRotationZ(heading))
      .multiply(new THREE.Matrix4().makeScale(scale, scale, scale * 0.85))
      .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    add(body, mb, 0);
    const rose = new THREE.TorusKnotGeometry(2.6, 0.95, 90, 10, 2, 5);
    const mr = new THREE.Matrix4().makeTranslation(x, y, 10.6 * scale).multiply(new THREE.Matrix4().makeScale(scale, scale, scale * 0.7));
    add(rose, mr, 0);
    parts.push({
      name: head ? 'Head' : `Segment ${k}`,
      objectIndex: 0,
      firstFace,
      faceCount: state.length - firstFace,
      firstVertex,
      vertexCount: pos.length / 3 - firstVertex,
      extruder: 1,
    });
  }
  const faces = state.length;
  return {
    name: 'Sample chain',
    format: 'stl',
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx),
    faceState: new Uint8Array(state),
    subdiv: new Map(),
    parts,
    objects: [{ name: 'Sample chain', firstPart: 0, partCount: parts.length }],
    filamentColors: [],
    warnings: [],
    stats: { faces, vertices: pos.length / 3, paintedFaces: state.filter((s) => s).length, subdividedFaces: 0, maxState: 4, seconds: 0, sourceBytes: 0 },
  };
}
