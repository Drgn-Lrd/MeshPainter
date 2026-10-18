/**
 * Mesh Painter: the page itself. Wires the filament panel, tools, painting,
 * structure mode, file opening and export together. The heavy work happens in
 * model-worker.js (files, export, analysis) and viewer.js (3D view).
 */
import { Viewer } from './viewer.js?v=da2fac7054';
import { ModelWorker } from './worker-client.js?v=6eaa5528be';
import { FilamentPanel, DEFAULT_FILAMENTS } from './filament-panel.js?v=9ecc609c0a';
/** @typedef {import('./filament-panel.js').Filament} Filament */
import { BASIC_COLORS, nearestColorName } from './colors.js?v=0dda646d26';
import { makeSampleModel } from './sample-model.js?v=54e4167854';
import { saveBlob } from './save-file.js?v=f98773da6b';
import { SUBDIV, MAX_FILAMENTS, buildFaceDefaults, partOfFace } from './model-data.js?v=bb5fb4d3b6';
/** @typedef {import('./model-data.js').ModelData} ModelData */
import { decodePaint, encodePaint, isLeaf, paintAtBarycentric, barycentricIn } from './paint-codec.js?v=0d8bec0312';
/** @typedef {import('./paint-codec.js').PaintNode} PaintNode */
/** @typedef {import('./paint-codec.js').Vec3} Vec3 */
/** @typedef {import('./worker-client.js').ExportResult} ExportResult */
import { StructureController } from './structure-panel.js?v=eeb3b9bef2';
/** @typedef {import('./structure-engine.js').StructureType} StructureType */

/** @typedef {'orbit' | 'structure' | 'pencil' | 'fine' | 'eraser'} Tool */

/**
 * @typedef {object} Change
 * @property {number} face
 * @property {number} before
 * @property {string} [beforeSub]
 * @property {number} beforeManual
 * @property {number} after
 * @property {string} [afterSub]
 * @property {number} afterManual
 */

/**
 * @typedef {{ kind: 'paint'; changes: Change[] } | { kind: 'structures'; before: StructureType[]; after: StructureType[] }} UndoEntry
 */

import { VERSION } from './version.js?v=8a54183a1c';

/**
 * Shorthand for document.getElementById (typed loosely: the elements are known from index.html).
 * @param {string} id
 * @returns {any}
 */
const $ = (id) => document.getElementById(id);

const state = {
  filaments: /** @type {Filament[]} */ (DEFAULT_FILAMENTS.map((f) => ({ ...f }))),
  active: 2,
  tool: /** @type {Tool} */ ('orbit'),
  model: /** @type {ModelData | null} */ (null),
  isSample: false,
  defaults: /** @type {Uint8Array} */ (new Uint8Array(0)),
  busy: false,
  /** model arrays are lent to the worker: do not read them */
  exporting: false,
  usage: /** @type {number[]} */ ([]),
  /** faces painted by hand in this session; hand paint wins over structure paint */
  manual: /** @type {Uint8Array} */ (new Uint8Array(0)),
  altDown: false,
};

/** @type {Viewer} */
let viewer;
try {
  viewer = new Viewer($('viewer'));
} catch (err) {
  // Without 3D graphics nothing can be shown: explain why instead of leaving a dead page.
  showGraphicsProblem(err, false);
  throw err;
}
const worker = new ModelWorker();
/** @type {UndoEntry[]} */
const undoStack = [];
/** @type {UndoEntry[]} */
const redoStack = [];
/** @type {Map<number, Change> | null} */
let stroke = null;

const structures = new StructureController({
  viewer,
  worker,
  model: () => state.model,
  filaments: () => state.filaments,
  activeFilament: () => state.active,
  manual: () => state.manual,
  toast: (m, bad) => toast(m, bad),
  pushStructureUndo(before, after) {
    pushUndo({ kind: 'structures', before, after });
  },
  onLayerChanged: () => scheduleUsage(),
});

/** @param {UndoEntry} e */
function pushUndo(e) {
  undoStack.push(e);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}

/**
 * Filament a face will print with: structure paint, else its own paint, else the part base.
 * @param {number} f
 * @returns {number}
 */
function effectiveState(f) {
  const layer = structures.layer;
  if (layer && layer[f]) return layer[f];
  const s = state.model.faceState[f];
  return s !== 0 ? s : state.defaults[f];
}

// ---------------------------------------------------------------------------
// Filaments
// ---------------------------------------------------------------------------

const panel = new FilamentPanel($('filaments'), {
  onSelect(i) {
    state.active = i;
    if (state.tool === 'orbit' || state.tool === 'eraser') setTool(structures.status === 'ready' ? 'structure' : 'pencil');
    renderFilaments();
  },
  onColor(i, color, name) {
    const f = state.filaments[i];
    f.color = color;
    if (f.autoName) f.name = name ?? nearestColorName(color);
    applyPalette();
    renderFilaments();
    structures.render();
  },
  onRename(i, name) {
    state.filaments[i].name = name;
    state.filaments[i].autoName = false;
    renderFilaments();
    renderParts();
    structures.render();
  },
  onAdd() {
    if (state.filaments.length >= MAX_FILAMENTS) return;
    state.filaments.push(nextFilament());
    applyPalette();
    renderFilaments();
    renderParts();
    structures.render();
  },
  onRemoveLast() {
    const n = state.filaments.length;
    if (n <= 1) return;
    const used = (state.usage[n] ?? 0) + partsUsing(n);
    if (used > 0) {
      toast(`Filament ${n} is still used (${used.toLocaleString()} triangles or parts). Repaint them or change the part base first.`, true);
      return;
    }
    state.filaments.pop();
    if (state.active > state.filaments.length) state.active = state.filaments.length;
    applyPalette();
    renderFilaments();
    renderParts();
    structures.render();
  },
});

/** @returns {Filament} */
function nextFilament() {
  const used = new Set(state.filaments.flatMap((f) => [f.color.toUpperCase(), f.name.toLowerCase()]));
  const c = BASIC_COLORS.find((b) => !used.has(b.hex.toUpperCase()) && !used.has(b.name.toLowerCase())) ?? BASIC_COLORS[10];
  return { name: c.name, color: c.hex, autoName: true };
}

/**
 * @param {number} n
 * @returns {number}
 */
function partsUsing(n) {
  return state.model && !state.isSample ? state.model.parts.filter((p) => p.extruder === n).length : 0;
}

function applyPalette() {
  viewer.setPalette(state.filaments.map((f) => f.color));
  const mark = $('brand-mark');
  mark.innerHTML = '';
  state.filaments.slice(0, 8).forEach((f, i) => {
    const bar = document.createElement('i');
    bar.style.background = f.color;
    bar.style.height = `${[22, 16, 19, 13, 18, 15, 20, 14][i]}px`;
    mark.appendChild(bar);
  });
}

function renderFilaments() {
  panel.render(state.filaments, state.active, state.usage);
}

let usageTimer = 0;
function scheduleUsage() {
  clearTimeout(usageTimer);
  usageTimer = window.setTimeout(computeUsage, 250);
}
function computeUsage() {
  const m = state.model;
  if (!m || state.exporting) return;
  const counts = new Array(40).fill(0);
  const st = m.faceState;
  const d = state.defaults;
  const layer = structures.layer;
  for (let f = 0; f < st.length; f++) {
    if (layer && layer[f]) {
      counts[layer[f]]++;
      continue;
    }
    const s = st[f];
    if (s !== SUBDIV) counts[s !== 0 ? s : d[f]]++;
  }
  state.usage = counts;
  renderFilaments();
  renderStats();
}

// ---------------------------------------------------------------------------
// Model display
// ---------------------------------------------------------------------------

/**
 * @param {ModelData} model
 * @param {boolean} isSample
 */
async function showModel(model, isSample) {
  state.model = model;
  state.isSample = isSample;
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoButtons();
  if (model.filamentColors.length) {
    state.filaments = model.filamentColors.slice(0, MAX_FILAMENTS).map((c) => ({ name: nearestColorName(c), color: c, autoName: true }));
  }
  const need = Math.min(MAX_FILAMENTS, Math.max(4, model.stats.maxState, ...model.parts.map((p) => p.extruder)));
  while (state.filaments.length < need) state.filaments.push(nextFilament());
  if (state.active > state.filaments.length) state.active = 2;
  state.defaults = buildFaceDefaults(model.parts, model.indices.length / 3);
  state.manual = new Uint8Array(model.indices.length / 3);
  applyPalette();
  await viewer.setModel(model, state.defaults, (d, t) => setProgress('Preparing the 3D view', d, t));
  void structures.analyse(model);
  $('file-name').textContent = model.name;
  $('file-name').title = model.name;
  computeUsage();
  renderFilaments();
  renderStats();
  renderParts();
  renderWarnings();
}

function renderStats() {
  const m = state.model;
  const el = $('file-stats');
  if (!m) {
    el.innerHTML = '';
    return;
  }
  const F = m.indices.length / 3;
  let painted = 0;
  const st = m.faceState;
  const layer = structures.layer;
  for (let f = 0; f < F; f++) if (st[f] !== 0 || (layer && layer[f])) painted++;
  const chips = [
    `<span class="chip-stat"><b>${F.toLocaleString()}</b> triangles</span>`,
    `<span class="chip-stat"><b>${m.objects.length}</b> object${m.objects.length === 1 ? '' : 's'} · <b>${m.parts.length}</b> part${m.parts.length === 1 ? '' : 's'}</span>`,
    `<span class="chip-stat"><b>${painted.toLocaleString()}</b> painted${m.subdiv.size ? ` · <b>${m.subdiv.size.toLocaleString()}</b> brush` : ''}</span>`,
  ];
  if (state.isSample) chips.unshift('<span class="chip-stat chip-sample">Example model</span>');
  el.innerHTML = chips.join('');
}

function renderParts() {
  const m = state.model;
  const root = $('parts');
  if (!m) {
    root.innerHTML = '';
    return;
  }
  /** @param {number} sel */
  const opts = (sel) =>
    state.filaments.map((f, i) => `<option value="${i + 1}"${i + 1 === sel ? ' selected' : ''}>${i + 1} ${escapeHtml(f.name)}</option>`).join('');
  /** @type {string[]} */
  const html = ['<div class="parts-scroll">'];
  const MAX_ROWS = 400;
  let rows = 0;
  m.objects.forEach((o) => {
    let faces = 0;
    for (let p = o.firstPart; p < o.firstPart + o.partCount; p++) faces += m.parts[p].faceCount;
    html.push(`<div class="object-head"><span>${escapeHtml(o.name)}</span><span>${faces.toLocaleString()} tri</span></div>`);
    for (let p = o.firstPart; p < o.firstPart + o.partCount; p++) {
      if (rows++ >= MAX_ROWS) continue;
      const part = m.parts[p];
      html.push(
        `<div class="part-row"><span class="part-name" title="${escapeHtml(part.name)}">${escapeHtml(part.name)}</span>` +
          `<span class="part-tris">${part.faceCount.toLocaleString()}</span>` +
          `<select id="part-base-${p}" data-part="${p}" aria-label="Base filament for ${escapeHtml(part.name)}">${opts(part.extruder)}</select></div>`,
      );
    }
  });
  if (rows > MAX_ROWS) html.push(`<div class="part-row"><span class="part-name">…and ${(rows - MAX_ROWS).toLocaleString()} more parts</span></div>`);
  html.push('</div>');
  root.innerHTML = html.join('');
  /** @type {NodeListOf<HTMLSelectElement>} */ (root.querySelectorAll('select[data-part]')).forEach((sel) =>
    sel.addEventListener('change', () => {
      const cur = state.model;
      if (!cur || state.exporting) return;
      const p = Number(sel.dataset.part);
      cur.parts[p].extruder = Number(sel.value);
      state.defaults = buildFaceDefaults(cur.parts, cur.indices.length / 3);
      viewer.setDefaults(state.defaults);
      scheduleUsage();
    }),
  );
}

function renderWarnings() {
  const w = state.model?.warnings ?? [];
  $('warnings-panel').hidden = w.length === 0;
  $('warnings').innerHTML = w.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------
// Busy / progress / toast
// ---------------------------------------------------------------------------

let busyStart = 0;
/** @param {boolean} on */
function setBusy(on, title = '') {
  state.busy = on;
  $('progress').hidden = !on;
  for (const id of ['btn-open', 'btn-export', 'btn-check']) (/** @type {HTMLButtonElement} */ ($(id))).disabled = on;
  if (on) {
    busyStart = performance.now();
    $('progress-title').textContent = title;
    setProgress('Starting', 0, 1);
    viewer.setHover(-1);
  }
}

/**
 * @param {string} phase
 * @param {number} done
 * @param {number} total
 */
function setProgress(phase, done, total) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  $('progress-phase').textContent = phase;
  $('progress-pct').textContent = `${pct.toFixed(0)}%`;
  $('progress-bar').style.width = `${pct}%`;
  const secs = (performance.now() - busyStart) / 1000;
  $('progress-foot').textContent = `${secs.toFixed(1)} s elapsed`;
}

let toastTimer = 0;
/** @param {string} msg */
function toast(msg, bad = false, ms = 6000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/** @param {File} file */
async function openFile(file) {
  if (state.busy) return;
  if (!/\.(stl|3mf)$/i.test(file.name)) {
    toast(`${file.name} is not an STL or 3MF file.`, true);
    return;
  }
  setBusy(true, `Opening ${file.name} (${(file.size / 1048576).toFixed(1)} MB)`);
  const previous = state.model;
  const previousSample = state.isSample;
  // Release the previous model before parsing the next one (keeps peak memory down).
  structures.reset();
  viewer.clearModel();
  state.model = null;
  try {
    const model = await worker.load(file, file.name, setProgress);
    await showModel(model, false);
    const s = model.stats;
    toast(`Opened ${model.name}: ${s.faces.toLocaleString()} triangles in ${(performance.now() - busyStart) / 1000 < 10 ? ((performance.now() - busyStart) / 1000).toFixed(1) : Math.round((performance.now() - busyStart) / 1000)} s${s.paintedFaces ? `, ${s.paintedFaces.toLocaleString()} already painted` : ''}.`);
  } catch (e) {
    toast(`Could not open ${file.name}: ${(/** @type {Error} */ (e)).message}`, true, 10000);
    if (previous) await showModel(previous, previousSample);
  } finally {
    setBusy(false);
  }
}

$('btn-open').addEventListener('click', () => (/** @type {HTMLInputElement} */ ($('file-input'))).click());
$('file-input').addEventListener('change', (e) => {
  const input = /** @type {HTMLInputElement} */ (e.target);
  const f = input.files?.[0];
  input.value = '';
  if (f) void openFile(f);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  $('drop-hint').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('drop-hint').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-hint').hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) void openFile(f);
});

// ---------------------------------------------------------------------------
// Export + round trip
// ---------------------------------------------------------------------------

/** @type {{ result: ExportResult; filename: string } | null} */
let lastExport = null;

/** @returns {string} */
function exportName() {
  const m = state.model;
  const base = m.name.replace(/\.(stl|3mf)+$/i, '').replace(/[\\/:*?"<>|]+/g, '_') || 'model';
  return `${base}-painted.3mf`;
}

/** @param {boolean} verify */
async function runExport(verify) {
  const m = state.model;
  if (!m || state.busy) return;
  setBusy(true, verify ? 'Checking the round trip' : `Exporting ${exportName()}`);
  try {
    // Structure paint is baked into a copy of the face paint for the export.
    const layer = structures.layer;
    const ownState = m.faceState;
    const ownSubdiv = m.subdiv;
    /** @type {ModelData} */
    let outgoing = m;
    if (layer) {
      const combined = ownState.slice();
      const subdiv = new Map(ownSubdiv);
      for (let f = 0; f < combined.length; f++) {
        if (layer[f]) {
          combined[f] = layer[f];
          subdiv.delete(f);
        }
      }
      outgoing = { ...m, faceState: combined, subdiv };
    }
    state.exporting = true;
    const { result, model, error } = await worker.export(outgoing, verify, setProgress);
    // the arrays travelled to the worker and back: switch to the returned copies
    /** @type {ModelData} */
    const back = layer ? { ...model, faceState: ownState, subdiv: ownSubdiv } : model;
    state.model = back;
    state.exporting = false;
    viewer.rebind(back);
    structures.rebind(back);
    if (error || !result) throw new Error(error ?? 'export failed');
    lastExport = { result, filename: exportName() };
    if (verify) showReport(result);
    else {
      setBusy(false);
      await save(result.blob, exportName());
    }
  } catch (e) {
    toast(`Export failed: ${(/** @type {Error} */ (e)).message}`, true, 10000);
  } finally {
    state.exporting = false;
    setBusy(false);
  }
}

/**
 * @param {Blob} blob
 * @param {string} filename
 */
async function save(blob, filename) {
  const out = await saveBlob(blob, filename);
  toast(out.message, !out.ok, out.ok && out.filename.endsWith('.zip') ? 12000 : 6000);
}

/** @param {ExportResult} res */
function showReport(res) {
  const r = res.report;
  /** @param {number} n */
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  $('report-pill').textContent = r.ok ? 'Match' : 'Mismatch';
  $('report-pill').className = `pill ${r.ok ? 'ok' : 'bad'}`;
  $('report-lede').textContent = r.ok
    ? 'The exported 3MF was read back and every triangle has the same position and the same filament, including brush-painted sub-triangles.'
    : 'The exported 3MF was read back and some triangles differ. Details below.';
  /**
   * @param {string} label
   * @param {string} value
   * @param {boolean} [good]
   */
  const row = (label, value, good) =>
    `<tr><th>${label}</th><td class="${good === undefined ? '' : good ? 'ok' : 'bad'}">${value}</td></tr>`;
  $('report-table').innerHTML = [
    row('Triangles', `${r.faces.toLocaleString()} → ${r.facesBack.toLocaleString()}`, r.faces === r.facesBack),
    row('Vertex positions', r.positionMismatches === 0 && r.vertices === r.verticesBack ? `${r.vertices.toLocaleString()} identical` : `${r.positionMismatches.toLocaleString()} moved`, r.positionMismatches === 0 && r.vertices === r.verticesBack),
    row('Triangle corners', r.indexMismatches === 0 ? 'identical' : `${r.indexMismatches.toLocaleString()} differ`, r.indexMismatches === 0),
    row('Filament per triangle', r.colourMismatches === 0 ? `all match (${r.paintedFaces.toLocaleString()} painted)` : `${r.colourMismatches.toLocaleString()} differ`, r.colourMismatches === 0),
    row('Brush-painted triangles', r.subdividedMismatches === 0 ? `${r.subdividedFaces.toLocaleString()} match` : `${r.subdividedMismatches.toLocaleString()} of ${r.subdividedFaces.toLocaleString()} differ`, r.subdividedMismatches === 0),
    row('3MF size', `${mb(res.zipBytes)} (model XML ${mb(res.xmlBytes)})`),
    row('Time', `export ${res.seconds.toFixed(1)} s · re-import ${res.verifySeconds.toFixed(1)} s`),
  ].join('');
  $('report-notes').innerHTML = r.examples.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
  $('report').hidden = false;
  $('report-save').focus();
}

$('btn-export').addEventListener('click', () => void runExport(false));
$('btn-check').addEventListener('click', () => void runExport(true));
$('report-close').addEventListener('click', () => ($('report').hidden = true));
$('report-save').addEventListener('click', async () => {
  if (!lastExport) return;
  $('report').hidden = true;
  await save(lastExport.result.blob, lastExport.filename);
});

// ---------------------------------------------------------------------------
// Tools and painting
// ---------------------------------------------------------------------------

/** @type {Record<Tool, string>} */
const TOOL_HINTS = {
  orbit: 'Left-drag rotates, right-drag pans, wheel zooms.',
  structure: 'Hover a structure to see it on every identical piece, click to add it. Alt+click cuts a part out, Shift+click removes. Right-drag rotates.',
  pencil: 'Click or drag to paint whole triangles. Right-drag rotates, middle-drag pans.',
  fine: 'Paints one sixteenth of a triangle (brush-style paint). Right-drag rotates.',
  eraser: 'Click or drag to clear paint back to the part base filament.',
};

/** @param {Tool} t */
function setTool(t) {
  state.tool = t;
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tool')).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tool === t)));
  $('tool-hint').textContent = TOOL_HINTS[t];
  $('stage').dataset.tool = t;
  viewer.setMode(t === 'orbit' ? 'orbit' : 'paint');
  if (t !== 'structure') structures.clearHover();
  viewer.setHover(-1);
  $('hover-info').textContent = '';
}
/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tool')).forEach((b) => b.addEventListener('click', () => setTool(/** @type {Tool} */ (b.dataset.tool))));

/** @param {number} f */
function remember(f) {
  const m = state.model;
  if (stroke && !stroke.has(f)) stroke.set(f, { face: f, before: m.faceState[f], beforeSub: m.subdiv.get(f), beforeManual: state.manual[f], after: 0, afterManual: 0 });
}

/**
 * Hand paint on a face: it now wins over structure paint.
 * @param {number} f
 */
function markManual(f) {
  state.manual[f] = 1;
  const layer = structures.layer;
  if (layer) layer[f] = 0;
}

/**
 * @param {number} f
 * @param {number} s
 * @param {string} [sub]
 */
function setFace(f, s, sub) {
  const m = state.model;
  m.faceState[f] = s;
  if (s === SUBDIV && sub) m.subdiv.set(f, sub);
  else m.subdiv.delete(f);
}

let overlayDirty = false;

/**
 * @param {number} f
 * @param {number} clientX
 * @param {number} clientY
 */
function paintFace(f, clientX, clientY) {
  const m = state.model;
  if (!m) return;
  const target = state.tool === 'eraser' ? 0 : state.active;
  const cur = m.faceState[f];
  if (state.tool === 'fine') {
    const P = m.positions;
    const I = m.indices;
    /**
     * @param {number} k
     * @returns {Vec3}
     */
    const V = (k) => [P[I[f * 3 + k] * 3], P[I[f * 3 + k] * 3 + 1], P[I[f * 3 + k] * 3 + 2]];
    const hit = viewer.hitPoint(f, clientX, clientY);
    if (!hit) return;
    const b = /** @type {Vec3} */ (barycentricIn(V(0), V(1), V(2), hit).map((x) => Math.max(0, x)));
    const sum = b[0] + b[1] + b[2] || 1;
    /** @type {Vec3} */
    const bary = [b[0] / sum, b[1] / sum, b[2] / sum];
    /** @type {PaintNode} */
    let tree;
    try {
      tree = cur === SUBDIV ? decodePaint(m.subdiv.get(f)) : { s: cur };
    } catch {
      tree = { s: cur === SUBDIV ? 0 : cur };
    }
    const next = paintAtBarycentric(tree, bary, target, 2);
    remember(f);
    markManual(f);
    if (isLeaf(next)) setFace(f, next.s);
    else setFace(f, SUBDIV, encodePaint(next));
    overlayDirty = true;
  } else {
    const layer = structures.layer;
    if (cur === target && !(layer && layer[f])) return;
    remember(f);
    markManual(f);
    if (cur === SUBDIV) overlayDirty = true;
    setFace(f, target);
  }
  viewer.refreshFaces([f]);
}

function beginStroke() {
  stroke = new Map();
}
function endStroke() {
  if (!stroke) return;
  const m = state.model;
  /** @type {Change[]} */
  const changes = [];
  for (const c of stroke.values()) {
    c.after = m.faceState[c.face];
    c.afterSub = m.subdiv.get(c.face);
    c.afterManual = state.manual[c.face];
    if (c.after !== c.before || c.afterSub !== c.beforeSub || c.afterManual !== c.beforeManual) changes.push(c);
  }
  stroke = null;
  if (changes.length) {
    pushUndo({ kind: 'paint', changes });
    scheduleUsage();
  }
}

/**
 * @param {Change[]} changes
 * @param {boolean} forward
 */
function applyChanges(changes, forward) {
  const m = state.model;
  if (!m) return;
  let sub = false;
  let manualCleared = false;
  for (const c of changes) {
    const s = forward ? c.after : c.before;
    const str = forward ? c.afterSub : c.beforeSub;
    const man = forward ? c.afterManual : c.beforeManual;
    if (s === SUBDIV || m.faceState[c.face] === SUBDIV) sub = true;
    if (state.manual[c.face] && !man) manualCleared = true;
    state.manual[c.face] = man;
    if (man) markManual(c.face);
    setFace(c.face, s, str);
  }
  if (manualCleared) structures.applyLayer();
  viewer.refreshFaces(changes.map((c) => c.face));
  if (sub) viewer.rebuildOverlay();
  scheduleUsage();
}

/**
 * @param {UndoEntry} e
 * @param {boolean} forward
 */
function applyEntry(e, forward) {
  if (e.kind === 'paint') applyChanges(e.changes, forward);
  else structures.restore(forward ? e.after : e.before);
}

function undo() {
  const c = undoStack.pop();
  if (!c) return;
  applyEntry(c, false);
  redoStack.push(c);
  updateUndoButtons();
}
function redo() {
  const c = redoStack.pop();
  if (!c) return;
  applyEntry(c, true);
  undoStack.push(c);
  updateUndoButtons();
}
function updateUndoButtons() {
  (/** @type {HTMLButtonElement} */ ($('btn-undo'))).disabled = undoStack.length === 0;
  (/** @type {HTMLButtonElement} */ ($('btn-redo'))).disabled = redoStack.length === 0;
}
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);

// Pointer handling: one GPU pick per animation frame at most.
const canvas = viewer.canvas;
let painting = false;
/** @type {{ x: number; y: number } | null} */
let pointer = null;
let frameQueued = false;

/**
 * @param {number} f
 * @returns {string}
 */
function hoverText(f) {
  const m = state.model;
  const p = m.parts[partOfFace(m.parts, f)];
  const s = m.faceState[f];
  const fromStructure = !!structures.layer?.[f];
  if (s === SUBDIV && !fromStructure) return `Triangle ${f.toLocaleString()} · ${escapeHtml(p.name)} · brush paint (mixed)`;
  const fi = effectiveState(f);
  const fil = state.filaments[fi - 1];
  const label = fil ? `${fi} ${escapeHtml(fil.name)}` : `${fi}`;
  return `Triangle ${f.toLocaleString()} · ${escapeHtml(p.name)} · <i style="background:${fil?.color ?? '#999'}"></i>${label}${fromStructure ? ' (structure)' : s === 0 ? ' (base)' : ''}`;
}

function onFrame() {
  frameQueued = false;
  if (!pointer || state.busy || !state.model) return;
  const f = viewer.pick(pointer.x, pointer.y);
  if (state.tool === 'structure') {
    viewer.setHover(-1);
    $('hover-info').innerHTML = structures.hover(f, state.altDown);
    return;
  }
  viewer.setHover(f);
  if (painting && f >= 0) paintFace(f, pointer.x, pointer.y);
  if (overlayDirty) {
    overlayDirty = false;
    viewer.rebuildOverlay();
  }
  $('hover-info').innerHTML = f >= 0 ? hoverText(f) : '';
}
function queueFrame() {
  if (!frameQueued) {
    frameQueued = true;
    requestAnimationFrame(onFrame);
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || state.tool === 'orbit' || state.busy || !state.model) return;
  if (state.tool === 'structure') {
    const f = viewer.pick(e.clientX, e.clientY);
    structures.click(f, e.altKey, e.shiftKey);
    pointer = { x: e.clientX, y: e.clientY };
    state.altDown = e.altKey;
    onFrame();
    return;
  }
  painting = true;
  canvas.setPointerCapture(e.pointerId);
  beginStroke();
  pointer = { x: e.clientX, y: e.clientY };
  onFrame();
});
canvas.addEventListener('pointermove', (e) => {
  if (state.tool === 'orbit') return;
  pointer = { x: e.clientX, y: e.clientY };
  state.altDown = e.altKey;
  // While rotating with the right button, skip hover picks.
  if (!painting && e.buttons !== 0) return;
  queueFrame();
});
const stop = () => {
  if (!painting) return;
  painting = false;
  if (pointer) onFrame();
  endStroke();
};
canvas.addEventListener('pointerup', stop);
canvas.addEventListener('pointercancel', stop);
canvas.addEventListener('pointerleave', () => {
  if (!painting) {
    pointer = null;
    viewer.setHover(-1);
    structures.clearHover();
    $('hover-info').textContent = '';
  }
});
viewer.onCameraChange = () => {
  if (pointer && state.tool !== 'orbit' && !painting) queueFrame();
};
// The graphics driver was reset (for example the GPU ran out of memory). The browser
// normally hands the context back within a second; then the 3D view is rebuilt.
let contextLost = false;
viewer.onContextLost = () => {
  contextLost = true;
  structures.clearHover();
  toast('The 3D view stopped because the graphics driver was reset. Waiting for it to come back…', true, 8000);
  setTimeout(() => {
    if (contextLost) showGraphicsProblem(new Error('The graphics context was lost and the browser did not give it back.'), true);
  }, 6000);
};
viewer.onContextRestored = async () => {
  contextLost = false;
  $('graphics-problem')?.remove();
  if (state.model && !state.exporting) {
    await viewer.setModel(state.model, state.defaults);
    viewer.setLayer(structures.layer);
  }
  toast('3D view restored.');
};

/**
 * Explain that WebGL is unavailable and how to get it back.
 * @param {unknown} err
 * @param {boolean} midSession true if the view worked before (painting is still in memory)
 */
function showGraphicsProblem(err, midSession) {
  if (document.getElementById('graphics-problem')) return;
  const detail = err instanceof Error ? err.message : String(err);
  const box = document.createElement('div');
  box.className = 'overlay';
  box.id = 'graphics-problem';
  box.innerHTML = `
    <div class="report-card problem-card" role="alert">
      <div class="report-head"><h3>${midSession ? 'The 3D view stopped' : 'Your browser could not start 3D graphics'}</h3><span class="pill bad">WebGL off</span></div>
      <p class="report-lede">${
        midSession
          ? 'The browser switched off 3D graphics (WebGL) while a model was open. Your painting is still in memory: use Export 3MF now to keep it, then follow the steps below and reload the page.'
          : 'Mesh Painter needs WebGL to show models, and the browser refused to start it. Nothing is wrong with your files.'
      }</p>
      <ol class="problem-steps">
        <li><b>Close every Chrome window and open Chrome again.</b> After a graphics crash (for example while a very large model was open) Chrome turns 3D off until it restarts.</li>
        <li>In Chrome's Settings, under <b>System</b>, turn on <b>Use graphics acceleration when available</b>, then relaunch.</li>
        <li>Type <code>chrome://gpu</code> in the address bar. Next to <b>WebGL</b> it should say <b>Hardware accelerated</b>.</li>
      </ol>
      <p class="problem-detail">Browser message: ${escapeHtml(detail)}</p>
    </div>`;
  ($('stage') ?? document.body).appendChild(box);
  for (const id of midSession ? ['btn-open', 'btn-check'] : ['btn-open', 'btn-export', 'btn-check']) {
    const b = /** @type {HTMLButtonElement | null} */ (document.getElementById(id));
    if (b) {
      b.disabled = true;
      b.title = '3D graphics are switched off in this browser';
    }
  }
}

$('btn-fit').addEventListener('click', () => viewer.fit());
$('btn-top').addEventListener('click', () => viewer.topView());

/** @param {KeyboardEvent} e */
const altChanged = (e) => {
  if (e.key !== 'Alt' || state.tool !== 'structure') return;
  e.preventDefault();
  state.altDown = e.type === 'keydown';
  if (pointer) queueFrame();
};
window.addEventListener('keyup', altChanged);
window.addEventListener('keydown', (e) => {
  altChanged(e);
  const t = /** @type {HTMLElement} */ (e.target);
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (!$('report').hidden && e.key === 'Escape') {
    $('report').hidden = true;
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 's') setTool('structure');
  else if (k === 'o') setTool('orbit');
  else if (k === 'p') setTool('pencil');
  else if (k === 'f') setTool('fine');
  else if (k === 'e') setTool('eraser');
  else if (/^[1-9]$/.test(k) && Number(k) <= state.filaments.length) {
    state.active = Number(k);
    if (state.tool === 'orbit' || state.tool === 'eraser') setTool(structures.status === 'ready' ? 'structure' : 'pencil');
    renderFilaments();
  }
});

// ---------------------------------------------------------------------------
// Start with the example model
// ---------------------------------------------------------------------------

document.title = `MeshPainter - Multi-Color 3MF Pattern Mapper v${VERSION}`;
setTool('orbit');
applyPalette();
renderFilaments();
void showModel(makeSampleModel(), true);

// Hook for automated browser tests (loads a URL as if it were dropped).
(/** @type {{ __meshpainter: unknown }} */ (/** @type {unknown} */ (window))).__meshpainter = {
  state,
  /**
   * @param {string} url
   * @param {string} [name]
   */
  async openUrl(url, name) {
    const r = await fetch(url);
    const b = await r.blob();
    await openFile(new File([b], name ?? url.split('/').pop() ?? 'model'));
  },
  openFile,
  runExport,
  lastReport: () => lastExport?.result.report ?? null,
  pick: (x, y) => viewer.pick(x, y),
  structures,
  setTool,
  viewer,
  paintFace: (f) => {
    beginStroke();
    remember(f);
    setFace(f, state.active);
    viewer.refreshFaces([f]);
    endStroke();
  },
};
