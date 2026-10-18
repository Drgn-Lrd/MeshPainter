/**
 * Painted 3MF writer. Emits the XML in chunks straight into a streaming
 * ZIP (fflate), collecting the compressed output as Blob parts, so no giant
 * string is ever built.
 *
 * Every painted triangle carries both `paint_color` (Orca / Bambu loader) and
 * `slic3rpe:mmu_segmentation` (PrusaSlicer-format loader). All transforms are
 * baked into the vertices; each source object becomes one mesh object.
 * A part's default filament other than 1 is baked into the paint, so the
 * colours survive even though the slicer will treat filament 1 as the base.
 */
import { Zip, ZipDeflate, ZipPassThrough } from './lib/fflate.js?v=d33a216730';
import { SUBDIV, buildFaceDefaults } from './model-data.js?v=bb5fb4d3b6';
/** @typedef {import('./model-data.js').ModelData} ModelData */
import { decodePaint, encodePaint, resolveUnpainted, wholeCodeCached, MAX_STATE } from './paint-codec.js?v=0d8bec0312';
/** @typedef {import('./byte-source.js').ProgressFn} ProgressFn */

/**
 * @typedef {object} WriteOptions
 * @property {number} [level] deflate level 0-9 (default 3: fast, still ~5x smaller than raw XML)
 * @property {ProgressFn} [onProgress]
 * @property {string} [appName]
 */

/**
 * @typedef {object} WriteResult
 * @property {Blob} blob
 * @property {number} xmlBytes
 * @property {number} zipBytes
 * @property {number} seconds
 */

const enc = new TextEncoder();

/**
 * @param {string} s
 * @returns {string}
 */
function trimZeros(s) {
  if (s.indexOf('.') < 0) return s;
  let e = s.length;
  while (s.charCodeAt(e - 1) === 48) e--;
  if (s.charCodeAt(e - 1) === 46) e--;
  return s.slice(0, e);
}

/**
 * Shortest decimal that parses back to the same float32.
 * @param {number} v
 * @returns {string}
 */
export function formatFloat32(v) {
  if (v === 0 || !Number.isFinite(v)) return '0';
  for (let p = 6; p <= 9; p++) {
    const s = v.toPrecision(p);
    if (p === 9 || Math.fround(+s) === v) {
      const e = s.indexOf('e');
      if (e < 0) return trimZeros(s);
      return trimZeros(s.slice(0, e)) + s.slice(e);
    }
  }
  return String(v);
}

/**
 * @param {string} s
 * @returns {string}
 */
function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {ModelData} model
 * @param {WriteOptions} [opts]
 * @returns {Promise<WriteResult>}
 */
export function write3mf(model, opts = {}) {
  const t0 = performance.now();
  const level = opts.level ?? 3;
  /** @type {Uint8Array[]} */
  const out = [];
  let zipBytes = 0;
  let xmlBytes = 0;
  /** @type {Error | null} */
  let zipError = null;
  let finished = false;
  const zip = new Zip((err, data, final) => {
    if (err) {
      zipError = err;
      return;
    }
    out.push(data);
    zipBytes += data.length;
    if (final) finished = true;
  });

  /**
   * @param {string} name
   * @param {string} text
   */
  const addSmall = (name, text) => {
    const f = new ZipPassThrough(name);
    zip.add(f);
    f.push(enc.encode(text), true);
  };
  addSmall(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
  );
  addSmall(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
  );

  const modelFile = new ZipDeflate('3D/3dmodel.model', { level: /** @type {0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9} */ (level) });
  zip.add(modelFile);

  // Chunked text emitter
  /** @type {string[]} */
  let buf = [];
  let bufLen = 0;
  const FLUSH = 1 << 20;
  /** @param {string} s */
  const emit = (s) => {
    buf.push(s);
    bufLen += s.length;
    if (bufLen >= FLUSH) flush(false);
  };
  /** @param {boolean} final */
  const flush = (final) => {
    const bytes = enc.encode(buf.join(''));
    xmlBytes += bytes.length;
    modelFile.push(bytes, final);
    buf = [];
    bufLen = 0;
    if (zipError) throw zipError;
  };

  const { positions, indices, faceState, subdiv, parts, objects } = model;
  const F = indices.length / 3;
  const V = positions.length / 3;
  const defaults = buildFaceDefaults(parts, F);
  /** @type {string[]} */
  const attrFor = [];
  for (let s = 0; s <= MAX_STATE; s++) {
    const c = wholeCodeCached(s);
    attrFor.push(c ? ` paint_color="${c}" slic3rpe:mmu_segmentation="${c}"` : '');
  }

  emit(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n' +
      ` <metadata name="Application">${escAttr(opts.appName ?? 'Mesh Painter')}</metadata>\n` +
      ' <metadata name="slic3rpe:Version3mf">1</metadata>\n' +
      ' <metadata name="slic3rpe:MmPaintingVersion">1</metadata>\n' +
      ' <resources>\n',
  );

  const total = V + F;
  let done = 0;
  const report = () => opts.onProgress?.('Writing 3MF', done, total);

  objects.forEach((o, oi) => {
    const first = parts[o.firstPart];
    const last = parts[o.firstPart + o.partCount - 1];
    const v0 = first.firstVertex;
    const v1 = last.firstVertex + last.vertexCount;
    const f0 = first.firstFace;
    const f1 = last.firstFace + last.faceCount;
    emit(`  <object id="${oi + 1}" name="${escAttr(o.name)}" type="model">\n   <mesh>\n    <vertices>\n`);
    for (let v = v0; v < v1; v++) {
      emit(`     <vertex x="${formatFloat32(positions[v * 3])}" y="${formatFloat32(positions[v * 3 + 1])}" z="${formatFloat32(positions[v * 3 + 2])}"/>\n`);
      if ((++done & 0xffff) === 0) report();
    }
    emit('    </vertices>\n    <triangles>\n');
    for (let f = f0; f < f1; f++) {
      const a = indices[f * 3] - v0;
      const b = indices[f * 3 + 1] - v0;
      const c = indices[f * 3 + 2] - v0;
      const s = faceState[f];
      /** @type {string} */
      let attr;
      if (s === SUBDIV) {
        let str = subdiv.get(f) ?? '';
        const def = defaults[f];
        if (def !== 1 && str) {
          try {
            str = encodePaint(resolveUnpainted(decodePaint(str), def));
          } catch {
            /* keep original */
          }
        }
        attr = str ? ` paint_color="${str}" slic3rpe:mmu_segmentation="${str}"` : '';
      } else {
        const eff = s !== 0 ? s : defaults[f] !== 1 ? defaults[f] : 0;
        attr = attrFor[eff] ?? '';
      }
      emit(`     <triangle v1="${a}" v2="${b}" v3="${c}"${attr}/>\n`);
      if ((++done & 0xffff) === 0) report();
    }
    emit('    </triangles>\n   </mesh>\n  </object>\n');
  });

  emit(' </resources>\n <build>\n');
  objects.forEach((_o, oi) => emit(`  <item objectid="${oi + 1}" printable="1"/>\n`));
  emit(' </build>\n</model>\n');
  flush(true);
  zip.end();
  report();
  if (zipError) return Promise.reject(zipError);
  if (!finished) return Promise.reject(new Error('ZIP writer did not finish'));
  const blob = new Blob(/** @type {BlobPart[]} */ (out), { type: 'model/3mf' });
  return Promise.resolve({ blob, xmlBytes, zipBytes, seconds: (performance.now() - t0) / 1000 });
}
