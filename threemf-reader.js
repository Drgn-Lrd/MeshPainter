/**
 * Streaming 3MF reader.
 * Handles plain 3MF, PrusaSlicer projects (single mesh + volume ranges) and
 * Orca/Bambu projects (meshes in 3D/Objects/*.model referenced by <component p:path>,
 * build-item and component transforms, per-part extruders in model_settings.config).
 * Existing paint (paint_color / slic3rpe:mmu_segmentation) is kept per triangle.
 */
import { XmlScanner, bytes } from './xml-scanner.js?v=00306bca48';
/** @typedef {import('./xml-scanner.js').Attrs} Attrs */
/** @typedef {import('./xml-scanner.js').XmlHandler} XmlHandler */
import { readZipDirectory, findEntry, streamEntry, readEntryText } from './zip-reader.js?v=1497fb2c24';
/** @typedef {import('./zip-reader.js').ZipEntry} ZipEntry */
/** @typedef {import('./byte-source.js').ByteSource} ByteSource */
/** @typedef {import('./byte-source.js').ProgressFn} ProgressFn */
import { GrowF32, GrowU32, GrowU8 } from './growable-arrays.js?v=fed2e8a4dd';
import { wholeStateFromBytes, decodePaint, maxState as treeMaxState } from './paint-codec.js?v=0d8bec0312';
import { SUBDIV } from './model-data.js?v=bb5fb4d3b6';
/** @typedef {import('./model-data.js').ModelData} ModelData */
/** @typedef {import('./model-data.js').PartInfo} PartInfo */
/** @typedef {import('./model-data.js').ObjectInfo} ObjectInfo */

/**
 * 3MF affine transform, 12 values in file order (row-vector convention).
 * @typedef {number[]} Mat
 */
/** @type {Mat} */
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/**
 * Apply a first, then b.
 * @param {Mat} a
 * @param {Mat} b
 * @returns {Mat}
 */
function mul(a, b) {
  /** @type {Mat} */
  const r = new Array(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      let s = row === 3 ? b[9 + col] : 0;
      for (let k = 0; k < 3; k++) s += a[row * 3 + k] * b[k * 3 + col];
      r[row * 3 + col] = s;
    }
  }
  return r;
}

/**
 * @param {Mat} m
 * @returns {number}
 */
function det3(m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

/**
 * @param {string} s
 * @returns {Mat | null}
 */
function parseMat(s) {
  const v = s.trim().split(/[\s,]+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) return null;
  return v;
}

/** @type {Record<string, number>} */
const UNIT_SCALE = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

const T_MODEL = 0, T_OBJECT = 1, T_MESH = 2, T_VERTEX = 3, T_TRIANGLE = 4, T_COMPONENT = 5, T_BUILD = 6, T_ITEM = 7;
const TAGS = ['model', 'object', 'mesh', 'vertex', 'triangle', 'component', 'build', 'item'];

const A_X = bytes('x'), A_Y = bytes('y'), A_Z = bytes('z');
const A_V1 = bytes('v1'), A_V2 = bytes('v2'), A_V3 = bytes('v3');
const A_PAINT = bytes('paint_color'), A_MMU = bytes('mmu_segmentation');
const A_ID = bytes('id'), A_TYPE = bytes('type'), A_NAME = bytes('name');
const A_OBJECTID = bytes('objectid'), A_PATH = bytes('path'), A_TRANSFORM = bytes('transform'), A_UNIT = bytes('unit');

/**
 * @typedef {object} RawRef
 * @property {number} objectId
 * @property {string | null} path
 * @property {Mat | null} transform
 */
/**
 * @typedef {object} RawObject
 * @property {number} id
 * @property {string} type
 * @property {string} name
 * @property {boolean} hasMesh
 * @property {number} vStart
 * @property {number} vCount
 * @property {number} fStart
 * @property {number} fCount
 * @property {RawRef[]} components
 */
/**
 * @typedef {object} RawFile
 * @property {string} path
 * @property {number} unitScale
 * @property {Map<number, RawObject>} objects
 * @property {RawRef[]} build
 * @property {Float32Array} positions
 * @property {Uint32Array} indices
 * @property {Uint8Array} faceState
 * @property {Map<number, string>} subdiv
 */

/**
 * @param {Attrs} a
 * @returns {RawRef}
 */
function readRef(a) {
  const ti = a.find(A_TRANSFORM);
  const pi = a.findLocal(A_PATH);
  return {
    objectId: a.int(a.find(A_OBJECTID)),
    path: pi >= 0 ? a.str(pi) : null,
    transform: ti >= 0 ? parseMat(a.str(ti)) : null,
  };
}

class ModelFileParser  {
  pos = new GrowF32(1 << 18);
  idx = new GrowU32(1 << 18);
  st = new GrowU8(1 << 17);
  subdiv = new Map();
  objects = new Map();
  /** @type {RawRef[]} */
  build = [];
  unitScale = 1;
  /** @type {RawObject | null} */
  cur = null;
  inBuild = false;

  /**
   * @param {number} tag
   * @param {Attrs} a
   * @returns {void}
   */
  open(tag, a) {
    switch (tag) {
      case T_VERTEX:
        if (this.cur) this.pos.push3(a.num(a.find(A_X)), a.num(a.find(A_Y)), a.num(a.find(A_Z)));
        break;
      case T_TRIANGLE: {
        if (!this.cur) break;
        this.idx.push3(a.int(a.find(A_V1)), a.int(a.find(A_V2)), a.int(a.find(A_V3)));
        let pi = a.find(A_PAINT);
        if (pi < 0) pi = a.findLocal(A_MMU);
        let s = 0;
        if (pi >= 0) {
          s = wholeStateFromBytes(a.buf, a.vs[pi], a.ve[pi]);
          if (s < 0) {
            this.subdiv.set(this.st.len, a.str(pi));
            s = SUBDIV;
          }
        }
        this.st.push(s);
        break;
      }
      case T_OBJECT:
        this.cur = {
          id: a.int(a.find(A_ID)),
          type: a.str(a.find(A_TYPE), 'model'),
          name: a.str(a.find(A_NAME)),
          hasMesh: false,
          vStart: this.pos.len / 3,
          vCount: 0,
          fStart: this.st.len,
          fCount: 0,
          components: [],
        };
        break;
      case T_MESH:
        if (this.cur) this.cur.hasMesh = true;
        break;
      case T_COMPONENT:
        if (this.cur) this.cur.components.push(readRef(a));
        break;
      case T_BUILD:
        this.inBuild = true;
        break;
      case T_ITEM:
        if (this.inBuild) this.build.push(readRef(a));
        break;
      case T_MODEL: {
        const u = a.str(a.find(A_UNIT), 'millimeter').toLowerCase();
        this.unitScale = UNIT_SCALE[u] ?? 1;
        break;
      }
    }
  }
  /**
   * @param {number} tag
   * @returns {void}
   */
  close(tag) {
    if (tag === T_OBJECT && this.cur) {
      const c = this.cur;
      c.vCount = this.pos.len / 3 - c.vStart;
      c.fCount = this.st.len - c.fStart;
      this.objects.set(c.id, c);
      this.cur = null;
    } else if (tag === T_BUILD) this.inBuild = false;
  }
  /**
   * @param {string} path
   * @returns {RawFile}
   */
  finish(path) {
    return {
      path,
      unitScale: this.unitScale,
      objects: this.objects,
      build: this.build,
      positions: this.pos.finish(),
      indices: this.idx.finish(),
      faceState: this.st.finish(),
      subdiv: this.subdiv,
    };
  }
}

// ---------------------------------------------------------------------------
// Slicer settings (Bambu/Orca model_settings.config, PrusaSlicer Slic3r_PE_model.config)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PartSettings
 * @property {string} [name]
 * @property {number} [extruder]
 * @property {string} subtype
 */
/**
 * @typedef {object} VolumeSettings
 * @property {number} first
 * @property {number} last
 * @property {string} [name]
 * @property {number} [extruder]
 * @property {string} type
 */
/**
 * @typedef {object} ObjSettings
 * @property {string} [name]
 * @property {number} [extruder]
 * @property {Map<number, PartSettings>} parts
 * @property {VolumeSettings[]} volumes
 */

/**
 * @param {string} text
 * @param {Map<number, ObjSettings>} into
 * @returns {void}
 */
function parseSettings(text, into) {
  const S_OBJECT = 0, S_PART = 1, S_VOLUME = 2, S_METADATA = 3, S_PLATE = 4;
  /** @type {ObjSettings | null} */
  let obj = null;
  /** @type {PartSettings | null} */
  let part = null;
  /** @type {VolumeSettings | null} */
  let vol = null;
  let inPlate = 0;
  /** @type {XmlHandler} */
  const handler = {
    open(tag, a) {
      if (tag === S_PLATE) inPlate++;
      if (inPlate) return;
      const o = a.toObject();
      if (tag === S_OBJECT) {
        const id = Number(o.id);
        obj = into.get(id) ?? { parts: new Map(), volumes: [] };
        into.set(id, obj);
      } else if (tag === S_PART && obj) {
        part = { subtype: o.subtype || 'normal_part' };
        obj.parts.set(Number(o.id), part);
      } else if (tag === S_VOLUME && obj) {
        vol = { first: Number(o.firstid), last: Number(o.lastid), type: 'ModelPart' };
        obj.volumes.push(vol);
      } else if (tag === S_METADATA) {
        const key = o.key;
        const value = o.value;
        if (key === undefined) return;
        /** @type {{ name?: string; extruder?: number } | null} */
        const target = vol ?? part ?? obj;
        if (!target) return;
        if (key === 'name') target.name = value;
        else if (key === 'extruder') {
          const e = Number(value);
          if (Number.isFinite(e) && e > 0) target.extruder = e;
        } else if (key === 'volume_type' && vol) vol.type = value;
        else if (key === 'modifier' && vol && value === '1') vol.type = 'ParameterModifier';
      }
    },
    close(tag) {
      if (tag === S_PLATE) inPlate = Math.max(0, inPlate - 1);
      if (inPlate) return;
      if (tag === S_OBJECT) obj = null;
      else if (tag === S_PART) part = null;
      else if (tag === S_VOLUME) vol = null;
    },
  };
  const sc = new XmlScanner(['object', 'part', 'volume', 'metadata', 'plate'], handler);
  sc.push(new TextEncoder().encode(text));
  sc.end();
}

/**
 * @param {string | null} projectJson
 * @param {string | null} prusaIni
 * @returns {string[]}
 */
function parseFilamentColors(projectJson, prusaIni) {
  /** @param {string} c */
  const valid = (c) => /^#[0-9a-fA-F]{6}/.test(c);
  if (projectJson) {
    try {
      const d = JSON.parse(projectJson);
      const fc = d.filament_colour ?? d.filament_color;
      if (Array.isArray(fc) && fc.every((c) => typeof c === 'string')) return fc.map((c) => c.slice(0, 7).toUpperCase()).filter(valid);
    } catch {
      /* not JSON */
    }
  }
  if (prusaIni) {
    for (const key of ['filament_colour', 'extruder_colour']) {
      const m = new RegExp(`^;\\s*${key}\\s*=\\s*(.+)$`, 'm').exec(prusaIni);
      if (m) {
        const list = m[1].split(';').map((s) => s.trim().slice(0, 7).toUpperCase());
        if (list.some(valid)) return list.map((c) => (valid(c) ? c : '#808080'));
      }
    }
  }
  return [];
}

// ---------------------------------------------------------------------------

/** @param {string} p */
const normPath = (p) => {
  let s = p.replace(/^\/+/, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep */
  }
  return s.toLowerCase();
};

/**
 * @param {ByteSource} src
 * @param {string} name
 * @param {ProgressFn} [onProgress]
 * @returns {Promise<ModelData>}
 */
export async function read3mf(src, name, onProgress) {
  const t0 = performance.now();
  const entries = await readZipDirectory(src);
  /** @type {string[]} */
  const warnings = [];

  // Main model path from the package relationships
  let mainPath = '3D/3dmodel.model';
  const relsE = findEntry(entries, '_rels/.rels');
  if (relsE) {
    const rels = await readEntryText(src, relsE);
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      if (/Type="[^"]*\/3dmodel"/.test(tag)) {
        const t = /Target="([^"]+)"/.exec(tag);
        if (t) mainPath = t[1];
        break;
      }
    }
  }
  let mainEntry = findEntry(entries, mainPath);
  if (!mainEntry) {
    for (const e of entries.values()) if (/\.model$/i.test(e.name)) {
      mainEntry = e;
      break;
    }
  }
  if (!mainEntry) throw new Error('This 3MF has no model file (3D/3dmodel.model).');

  // Slicer settings
  const settings = new Map();
  for (const p of ['Metadata/model_settings.config', 'Metadata/Slic3r_PE_model.config']) {
    const e = findEntry(entries, p);
    if (e) {
      try {
        parseSettings(await readEntryText(src, e), settings);
      } catch (err) {
        warnings.push(`Could not read ${p}: ${(/** @type {Error} */ (err)).message}`);
      }
    }
  }
  const projE = findEntry(entries, 'Metadata/project_settings.config');
  const prusaE = findEntry(entries, 'Metadata/Slic3r_PE.config');
  const filamentColors = parseFilamentColors(
    projE ? await readEntryText(src, projE) : null,
    prusaE ? await readEntryText(src, prusaE) : null,
  );

  // Progress over all model entries
  let totalBytes = 0;
  for (const e of entries.values()) if (/\.model$/i.test(e.name)) totalBytes += e.compSize;
  let doneBytes = 0;
  /**
   * @param {ZipEntry} e
   * @returns {Promise<RawFile>}
   */
  const parse = async (e) => {
    const parser = new ModelFileParser();
    const sc = new XmlScanner(TAGS, parser);
    await streamEntry(
      src,
      e,
      (chunk) => sc.push(chunk),
      (n) => {
        doneBytes += n;
        onProgress?.('Reading 3MF', doneBytes, totalBytes);
      },
    );
    if (!sc.end()) warnings.push(`${e.name} ended in the middle of a tag.`);
    return parser.finish(e.name);
  };

  const files = new Map();
  const mainKey = normPath(mainEntry.name);
  files.set(mainKey, await parse(mainEntry));
  // Referenced model files (breadth-first, each parsed once)
  const pending = [mainKey];
  while (pending.length) {
    const f = files.get(pending.shift());
    const refs = new Set();
    for (const o of f.objects.values()) for (const c of o.components) if (c.path) refs.add(c.path);
    for (const b of f.build) if (b.path) refs.add(b.path);
    for (const r of refs) {
      const key = normPath(r);
      if (files.has(key)) continue;
      const e = findEntry(entries, r);
      if (!e) {
        warnings.push(`Missing model file ${r}`);
        continue;
      }
      files.set(key, await parse(e));
      pending.push(key);
    }
  }

  onProgress?.('Assembling', 0, 1);
  const model = assemble(files, mainKey, settings, name, warnings);
  model.filamentColors = filamentColors;
  model.stats.seconds = (performance.now() - t0) / 1000;
  model.stats.sourceBytes = src.size;
  return model;
}

/**
 * @typedef {object} PartSpec
 * @property {RawFile} file
 * @property {RawObject} obj
 * @property {Mat} m
 * @property {number} f0
 * @property {number} f1
 * @property {string} name
 * @property {number} extruder
 * @property {number} objectIndex
 */

/**
 * @param {Map<string, RawFile>} files
 * @param {string} mainKey
 * @param {Map<number, ObjSettings>} settings
 * @param {string} name
 * @param {string[]} warnings
 * @returns {ModelData}
 */
function assemble(files, mainKey, settings, name, warnings) {
  const main = files.get(mainKey);
  /** @type {PartSpec[]} */
  const specs = [];
  /** @type {ObjectInfo[]} */
  const objects = [];
  let skippedModifiers = 0;
  let skippedNonModel = 0;
  let mirrored = 0;

  /**
   * @param {RawFile} from
   * @param {string | null} path
   * @returns {RawFile | undefined}
   */
  const fileFor = (from, path) => (path ? files.get(normPath(path)) : from);

  main.build.forEach((item, itemNo) => {
    const topFile = fileFor(main, item.path);
    const top = topFile?.objects.get(item.objectId);
    if (!topFile || !top) {
      warnings.push(`Build item refers to missing object ${item.objectId}`);
      return;
    }
    const os = settings.get(item.objectId);
    const objectIndex = objects.length;
    const firstPart = specs.length;
    /**
     * @param {RawFile} file
     * @param {RawObject} obj
     * @param {Mat} m
     * @param {number} depth
     */
    const walk = (file, obj, m, depth) => {
      if (depth > 16) return;
      if (obj.type && obj.type !== 'model' && obj.type !== 'solidsupport') {
        skippedNonModel++;
        return;
      }
      if (obj.hasMesh && obj.fCount > 0) {
        if (det3(m) < 0) mirrored++;
        const ps = os?.parts.get(obj.id);
        if (ps && ps.subtype !== 'normal_part') {
          skippedModifiers++;
        } else if (obj === top && os && os.volumes.length > 0) {
          // PrusaSlicer: volumes are face ranges of the single object mesh
          for (const v of os.volumes) {
            if (v.type !== 'ModelPart') {
              skippedModifiers++;
              continue;
            }
            const f0 = Math.max(0, v.first);
            const f1 = Math.min(obj.fCount, v.last + 1);
            if (f1 > f0) specs.push({ file, obj, m, f0, f1, name: v.name || os.name || obj.name || `Part ${specs.length + 1}`, extruder: v.extruder ?? os.extruder ?? 1, objectIndex });
          }
        } else {
          specs.push({
            file,
            obj,
            m,
            f0: 0,
            f1: obj.fCount,
            name: ps?.name || obj.name || os?.name || `Part ${specs.length + 1}`,
            extruder: ps?.extruder ?? os?.extruder ?? 1,
            objectIndex,
          });
        }
      }
      for (const c of obj.components) {
        const cf = fileFor(file, c.path);
        const co = cf?.objects.get(c.objectId);
        if (!cf || !co) {
          warnings.push(`Component refers to missing object ${c.objectId}${c.path ? ' in ' + c.path : ''}`);
          continue;
        }
        walk(cf, co, mul(c.transform ?? IDENTITY, m), depth + 1);
      }
    };
    walk(topFile, top, item.transform ?? IDENTITY, 0);
    if (specs.length > firstPart) objects.push({ name: os?.name || top.name || `Object ${itemNo + 1}`, firstPart, partCount: specs.length - firstPart });
  });

  if (skippedModifiers) warnings.push(`Left out ${skippedModifiers} modifier / negative / support-blocker part(s); they are not printed geometry.`);
  if (skippedNonModel) warnings.push(`Left out ${skippedNonModel} non-model object(s) (support or other).`);
  if (mirrored) warnings.push(`${mirrored} part(s) use a mirrored transform; their triangle winding is kept as in the file.`);

  // Sizes
  let F = 0;
  let V = 0;
  /** @type {(Int32Array | null)[]} */
  const remaps = [];
  /** @type {number[]} */
  const vCounts = [];
  for (const s of specs) {
    F += s.f1 - s.f0;
    if (s.f0 === 0 && s.f1 === s.obj.fCount) {
      remaps.push(null);
      vCounts.push(s.obj.vCount);
      V += s.obj.vCount;
    } else {
      const remap = new Int32Array(s.obj.vCount).fill(-1);
      let n = 0;
      const idx = s.file.indices;
      for (let f = s.obj.fStart + s.f0; f < s.obj.fStart + s.f1; f++) {
        for (let k = 0; k < 3; k++) {
          const v = idx[f * 3 + k];
          if (v < s.obj.vCount && remap[v] < 0) remap[v] = n++;
        }
      }
      remaps.push(remap);
      vCounts.push(n);
      V += n;
    }
  }

  const positions = new Float32Array(V * 3);
  const indices = new Uint32Array(F * 3);
  const faceState = new Uint8Array(F);
  const subdiv = new Map();
  /** @type {PartInfo[]} */
  const parts = [];
  const unit = main.unitScale;
  let vBase = 0;
  let fBase = 0;
  let badRefs = 0;
  let painted = 0;
  let maxState = 0;

  specs.forEach((s, si) => {
    const { file, obj, m } = s;
    const remap = remaps[si];
    const vc = vCounts[si];
    const src = file.positions;
    // vertices
    /**
     * @param {number} dst
     * @param {number} sv
     */
    const out = (dst, sv) => {
      const x = src[sv * 3], y = src[sv * 3 + 1], z = src[sv * 3 + 2];
      positions[dst * 3] = (x * m[0] + y * m[3] + z * m[6] + m[9]) * unit;
      positions[dst * 3 + 1] = (x * m[1] + y * m[4] + z * m[7] + m[10]) * unit;
      positions[dst * 3 + 2] = (x * m[2] + y * m[5] + z * m[8] + m[11]) * unit;
    };
    if (!remap) for (let v = 0; v < obj.vCount; v++) out(vBase + v, obj.vStart + v);
    else for (let v = 0; v < obj.vCount; v++) if (remap[v] >= 0) out(vBase + remap[v], obj.vStart + v);
    // faces
    const idx = file.indices;
    const st = file.faceState;
    for (let lf = s.f0; lf < s.f1; lf++) {
      const sf = obj.fStart + lf;
      const df = fBase + (lf - s.f0);
      for (let k = 0; k < 3; k++) {
        let v = idx[sf * 3 + k];
        if (v >= obj.vCount) {
          badRefs++;
          v = 0;
        }
        indices[df * 3 + k] = vBase + (remap ? Math.max(0, remap[v]) : v);
      }
      const state = st[sf];
      faceState[df] = state;
      if (state !== 0) {
        painted++;
        if (state === SUBDIV) {
          const str = file.subdiv.get(sf);
          subdiv.set(df, str);
          try {
            maxState = Math.max(maxState, treeMaxState(decodePaint(str)));
          } catch {
            warnings.push(`Unreadable paint data on triangle ${df}; it was kept as-is.`);
          }
        } else maxState = Math.max(maxState, state);
      }
    }
    parts.push({ name: s.name, objectIndex: s.objectIndex, firstFace: fBase, faceCount: s.f1 - s.f0, firstVertex: vBase, vertexCount: vc, extruder: s.extruder });
    vBase += vc;
    fBase += s.f1 - s.f0;
  });
  if (badRefs) warnings.push(`${badRefs} triangle corner(s) referenced missing vertices.`);
  for (const p of parts) maxState = Math.max(maxState, p.extruder);

  return {
    name,
    format: '3mf',
    positions,
    indices,
    faceState,
    subdiv,
    parts,
    objects,
    filamentColors: [],
    warnings,
    stats: { faces: F, vertices: V, paintedFaces: painted, subdividedFaces: subdiv.size, maxState, seconds: 0, sourceBytes: 0 },
  };
}
