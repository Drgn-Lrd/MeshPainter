/**
 * Structure mode: runs the piece analysis in the background, previews the
 * structure under the mouse on every identical piece, adds / cuts / removes
 * selections on click, and renders the Structures and Pieces panels.
 */
/** @typedef {import('./viewer.js').Viewer} Viewer */
/** @typedef {import('./worker-client.js').ModelWorker} ModelWorker */
/** @typedef {import('./model-data.js').ModelData} ModelData */
/** @typedef {import('./filament-panel.js').Filament} Filament */
/** @typedef {import('./region-growing.js').GrowParams} GrowParams */
import { StructureEngine, EXCLUDE_ANGLE } from './structure-engine.js?v=77ae4123ee';
/** @typedef {import('./structure-engine.js').Rule} Rule */
/** @typedef {import('./structure-engine.js').StructureType} StructureType */
import { inkFor } from './colors.js?v=0dda646d26';

/**
 * @typedef {object} StructureHost
 * @property {Viewer} viewer
 * @property {ModelWorker} worker
 * @property {() => ModelData | null} model
 * @property {() => Filament[]} filaments
 * @property {() => number} activeFilament
 * @property {() => Uint8Array} manual faces painted by hand in this session (manual paint wins over structures)
 * @property {(msg: string, bad?: boolean) => void} toast
 * @property {(before: StructureType[], after: StructureType[]) => void} pushStructureUndo
 * @property {() => void} onLayerChanged
 */

/** @typedef {'add' | 'cut'} Mode */

/** @param {string} s */
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class StructureController {
  /** @type {StructureEngine | null} */
  engine = null;
  /** @type {'idle' | 'analysing' | 'ready' | 'failed'} */
  status = 'idle';
  /** @type {GrowParams} */
  params = { angle: 35, radius: 8 };
  /** @type {Mode} */
  mode = 'add';
  activeId = 0;
  /** @type {StructureHost} */
  host;
  token = 0;
  progressText = '';
  /** @type {Uint32Array} */
  hoverEpoch = new Uint32Array(0);
  epoch = 0;
  /**
   * @type {{ mode: Mode; group: number; key: string; faces: number; refFaces: number; copies: number } | null}
   */
  cache = null;
  /** @type {Record<string, HTMLElement>} */
  els;
  matchToken = 0;
  matchText = '';

  /** @param {StructureHost} host */
  constructor(host) {
    this.host = host;
    /** @param {string} id */
    const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
    this.els = {
      status: $('struct-status'),
      types: $('struct-types'),
      review: $('struct-review'),
      pieces: $('pieces'),
      angle: $('struct-angle'),
      angleOut: $('struct-angle-out'),
      radius: $('struct-radius'),
      radiusOut: $('struct-radius-out'),
      modeAdd: $('struct-mode-add'),
      modeCut: $('struct-mode-cut'),
      newType: $('struct-new'),
      controls: $('struct-controls'),
    };
    const angle = /** @type {HTMLInputElement} */ (this.els.angle);
    const radius = /** @type {HTMLInputElement} */ (this.els.radius);
    angle.addEventListener('input', () => {
      this.params.angle = Number(angle.value);
      this.syncSliders();
      this.invalidateHover();
    });
    radius.addEventListener('input', () => {
      this.params.radius = Number(radius.value);
      this.syncSliders();
      this.invalidateHover();
    });
    this.els.modeAdd.addEventListener('click', () => this.setMode('add'));
    this.els.modeCut.addEventListener('click', () => this.setMode('cut'));
    this.els.newType.addEventListener('click', () => {
      if (!this.engine) return;
      const before = this.engine.snapshot();
      const t = this.engine.newType(`Structure ${this.engine.types.length + 1}`, this.defaultRule());
      this.activeId = t.id;
      this.host.pushStructureUndo(before, this.engine.snapshot());
      this.render();
    });
    this.syncSliders();
    this.render();
  }

  /** @returns {Rule} */
  defaultRule() {
    const a = this.host.activeFilament();
    return { kind: 'single', filament: a > 1 ? a : Math.min(2, this.host.filaments().length) };
  }

  /**
   * @param {Mode} m
   * @returns {void}
   */
  setMode(m) {
    this.mode = m;
    this.els.modeAdd.setAttribute('aria-checked', String(m === 'add'));
    this.els.modeCut.setAttribute('aria-checked', String(m === 'cut'));
    this.invalidateHover();
  }

  /** @returns {void} */
  syncSliders() {
    (/** @type {HTMLInputElement} */ (this.els.angle)).value = String(this.params.angle);
    (/** @type {HTMLInputElement} */ (this.els.radius)).value = String(this.params.radius);
    this.els.angleOut.textContent = `${this.params.angle}°`;
    this.els.radiusOut.textContent = `${this.params.radius} mm`;
  }

  /** @returns {void} */
  invalidateHover() {
    this.cache = null;
  }

  /**
   * Forget everything about the previous model and analyse the new one.
   * @param {ModelData} model
   * @returns {Promise<void>}
   */
  async analyse(model) {
    const token = ++this.token;
    this.engine = null;
    this.activeId = 0;
    this.cache = null;
    this.status = 'analysing';
    this.progressText = 'Finding pieces…';
    this.hoverEpoch = new Uint32Array(model.indices.length / 3);
    this.epoch = 0;
    this.render();
    try {
      const a = await this.host.worker.analyze(model.positions, model.indices, (phase, done, total) => {
        if (token !== this.token) return;
        this.progressText = `${phase}… ${total > 1 ? Math.round((100 * done) / total) + '%' : ''}`;
        this.els.status.textContent = this.progressText;
      });
      if (token !== this.token || this.host.model() !== model) return;
      this.engine = new StructureEngine(model.positions, model.indices, a);
      // default size: half the typical piece width
      const widths = a.stats.map((s) => Math.max(s.max[0] - s.min[0], s.max[1] - s.min[1]));
      widths.sort((x, y) => x - y);
      const typical = widths[Math.floor(widths.length / 2)] ?? 16;
      // a bit over half the typical piece width (9 mm on the Rosewing's 16 mm segments)
      this.params.radius = Math.max(1, Math.min(40, Math.round(typical * 0.55 * 2) / 2));
      this.syncSliders();
      this.status = 'ready';
    } catch (e) {
      if (token !== this.token) return;
      this.status = 'failed';
      this.progressText = `Piece analysis failed: ${(/** @type {Error} */ (e)).message}`;
    }
    this.render();
  }

  /** @returns {void} */
  reset() {
    this.token++;
    this.engine = null;
    this.status = 'idle';
    this.cache = null;
    this.render();
  }

  /**
   * The model's arrays came back from the worker after an export.
   * @param {ModelData} model
   * @returns {void}
   */
  rebind(model) {
    this.engine?.rebind(model.positions, model.indices);
  }

  /** @returns {Uint8Array | null} */
  get layer() {
    return this.engine && this.engine.types.some((t) => t.selections.length) ? this.engine.layer : null;
  }

  /** @returns {StructureType | null} */
  get activeType() {
    return this.engine?.types.find((t) => t.id === this.activeId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Hover / click
  // -------------------------------------------------------------------------

  /**
   * Update the preview for the face under the mouse. Returns status-bar HTML.
   * @param {number} face
   * @param {boolean} alt
   * @returns {string}
   */
  hover(face, alt) {
    const e = this.engine;
    if (!e) return this.status === 'analysing' ? esc(this.progressText) : '';
    if (face < 0) {
      this.clearHover();
      return '';
    }
    /** @type {Mode} */
    const mode = alt || this.mode === 'cut' ? 'cut' : 'add';
    /** @type {GrowParams} */
    const params = mode === 'cut' ? { angle: EXCLUDE_ANGLE, radius: this.params.radius } : this.params;
    const key = `${params.angle}/${params.radius}`;
    const g = e.groupOfFace(face);
    const r = e.analysis.corr[face];
    const c = this.cache;
    if (!(c && c.mode === mode && c.group === g && c.key === key && this.hoverEpoch[r] === this.epoch)) {
      const pv = e.preview(face, params, mode === 'cut');
      this.host.viewer.setHighlight(pv.faces, mode === 'cut' ? 'cut' : 'add');
      this.epoch++;
      for (const f of pv.refRegion) this.hoverEpoch[f] = this.epoch;
      this.cache = { mode, group: g, key, faces: pv.faces.length, refFaces: pv.refRegion.length, copies: pv.copies };
    }
    const cc = this.cache;
    const t = this.activeType;
    const copies = cc.copies > 1 ? `on <b>${cc.copies}</b> identical pieces` : 'on this piece (no identical copies)';
    if (mode === 'cut') return `Cut out <b>${cc.refFaces.toLocaleString()}</b> triangles ${copies}${t ? ` from “${esc(t.name)}”` : ''} · click`;
    return `Structure: <b>${cc.refFaces.toLocaleString()}</b> triangles ${copies} · click to add${t ? ` to “${esc(t.name)}”` : ''}`;
  }

  /** @returns {void} */
  clearHover() {
    if (this.cache) this.host.viewer.setHighlight(null);
    this.cache = null;
  }

  /**
   * @param {number} face
   * @param {boolean} alt
   * @param {boolean} shift
   * @returns {void}
   */
  click(face, alt, shift) {
    const e = this.engine;
    if (!e || face < 0) {
      if (this.status === 'analysing') this.host.toast('Still analysing the pieces. Structure picking starts in a moment.');
      return;
    }
    const before = e.snapshot();
    let t = this.activeType;
    let changed = false;
    if (shift) {
      if (t) changed = e.removeSelectionAt(t, face);
      if (!changed) this.host.toast('Shift+click removes a structure you added. Nothing added here yet.');
    } else if (alt || this.mode === 'cut') {
      if (t) changed = e.addExclusion(t, face, this.params.radius);
      if (!changed) this.host.toast('Cut out works inside a structure you already added. Add the structure first, then cut the part out of it.');
    } else {
      if (!t) {
        t = e.newType(`Structure ${e.types.length + 1}`, this.defaultRule());
        this.activeId = t.id;
      }
      changed = e.addSelection(t, face, this.params);
      if (!changed) this.host.toast(`That is already part of “${t.name}”. Shift+click removes it.`);
      else {
        this.applyLayer();
        this.invalidateHover();
        this.render();
        void this.findOnOtherPieces(t, before);
        return;
      }
    }
    if (!changed && e.types.length === before.length) return;
    this.applyLayer();
    this.host.pushStructureUndo(before, e.snapshot());
    this.invalidateHover();
    this.render();
  }

  /**
   * After a click: look for the same structure on the other kinds of piece.
   * @param {StructureType} t
   * @param {StructureType[]} before
   * @returns {Promise<void>}
   */
  async findOnOtherPieces(t, before) {
    const e = this.engine;
    const sel = t.selections[t.selections.length - 1];
    const token = ++this.matchToken;
    const stop = () => token !== this.matchToken || this.engine !== e;
    this.matchText = 'Looking for it on the other pieces…';
    this.renderStatus();
    const found = await e.autoMatch(t, sel, stop, (d, n) => {
      if (stop()) return;
      this.matchText = `Looking for it on the other pieces… ${d}/${n}`;
      this.els.status.textContent = this.matchText;
      this.els.status.hidden = false;
    });
    if (this.engine !== e) return;
    if (token === this.matchToken) this.matchText = '';
    if (found.kinds) {
      this.applyLayer();
      this.host.toast(`Also found on ${found.pieces} other piece${found.pieces === 1 ? '' : 's'}. Check them; Shift+click removes a wrong one.`);
    }
    this.host.pushStructureUndo(before, e.snapshot());
    this.render();
  }

  /**
   * Recompute instances and the paint layer, then refresh the view.
   * @returns {void}
   */
  applyLayer() {
    const e = this.engine;
    if (!e) return;
    e.recompute();
    const manual = this.host.manual();
    const L = e.layer;
    for (let f = 0; f < L.length; f++) if (manual[f] && L[f]) L[f] = 0;
    this.host.viewer.setLayer(this.layer);
    this.host.onLayerChanged();
  }

  /**
   * @param {StructureType[]} types
   * @returns {void}
   */
  restore(types) {
    if (!this.engine) return;
    this.matchToken++;
    this.matchText = '';
    this.engine.restore(types);
    if (!this.activeType) this.activeId = this.engine.types.at(-1)?.id ?? 0;
    this.applyLayer();
    this.invalidateHover();
    this.render();
  }

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------

  /** @returns {void} */
  render() {
    this.renderStatus();
    this.renderTypes();
    this.renderReview();
    this.renderPieces();
  }

  /** @returns {void} */
  renderStatus() {
    const s = this.els.status;
    const ready = this.status === 'ready';
    this.els.controls.hidden = !ready;
    this.els.newType.hidden = !ready;
    if (this.matchText) s.textContent = this.matchText;
    else if (this.status === 'analysing') s.textContent = this.progressText;
    else if (this.status === 'failed') s.textContent = this.progressText;
    else if (ready) s.textContent = this.engine.types.length ? '' : 'Hover a structure (for example a flower). It lights up on every identical piece. Click to add it.';
    else s.textContent = 'Open a model to find its structures.';
    s.hidden = s.textContent === '';
  }

  /**
   * @param {number} n
   * @returns {string}
   */
  swatch(n, attrs = '', extra = '') {
    const f = this.host.filaments()[n - 1];
    const color = f?.color ?? '#999999';
    return `<button type="button" class="mini-swatch ${extra}" style="--swatch:${color};--ink:${inkFor(color)}" title="${n} ${esc(f?.name ?? '')}" ${attrs}>${n}</button>`;
  }

  /** @returns {void} */
  renderTypes() {
    const root = this.els.types;
    const e = this.engine;
    if (!e) {
      root.innerHTML = '';
      return;
    }
    const fils = this.host.filaments();
    root.innerHTML = e.types
      .map((t) => {
        const inst = e.instances.filter((i) => i.type === t.id);
        const pieces = new Set(inst.map((i) => i.piece)).size;
        const autoPieces = t.selections.filter((x) => x.auto).reduce((n, x) => n + e.analysis.groups[x.group].members.length, 0);
        const r = t.rule;
        /**
         * @param {Rule['kind']} k
         * @param {string} label
         */
        const seg = (k, label) =>
          `<button type="button" role="radio" aria-checked="${r.kind === k}" data-act="rule" data-kind="${k}">${label}</button>`;
        let body = '';
        if (r.kind === 'single') {
          body = `<div class="swatch-row">${fils.map((_f, i) => this.swatch(i + 1, `data-act="single" data-n="${i + 1}" aria-pressed="${r.filament === i + 1}"`, r.filament === i + 1 ? 'on' : '')).join('')}</div>`;
        } else if (r.kind === 'sequence') {
          body =
            `<div class="seq-label">From the head: <span class="hint-inline">click a colour in the order to remove it</span></div>` +
            `<div class="swatch-row seq">${r.filaments.map((n, i) => this.swatch(n, `data-act="seq-del" data-i="${i}"`, 'on')).join('<span class="seq-arrow">›</span>') || '<span class="hint-inline">empty</span>'}</div>` +
            `<div class="seq-label">Add to the order:</div>` +
            `<div class="swatch-row">${fils.map((_f, i) => this.swatch(i + 1, `data-act="seq-add" data-n="${i + 1}"`)).join('')}</div>`;
        } else {
          body =
            `<div class="seq-label">Pick from:</div>` +
            `<div class="swatch-row">${fils.map((_f, i) => this.swatch(i + 1, `data-act="rnd-toggle" data-n="${i + 1}" aria-pressed="${r.filaments.includes(i + 1)}"`, r.filaments.includes(i + 1) ? 'on' : '')).join('')}</div>` +
            `<label class="rnd-spacing">Same colour at least <input type="number" min="0" max="200" step="1" value="${r.spacing}" data-act="rnd-spacing" id="rnd-spacing-${t.id}"> mm apart</label>` +
            `<button type="button" class="btn btn-quiet" data-act="rnd-shuffle">Shuffle</button>`;
        }
        return `<div class="stype${t.id === this.activeId ? ' active' : ''}" data-id="${t.id}">
          <div class="stype-head">
            <input class="stype-name" id="stype-name-${t.id}" value="${esc(t.name)}" aria-label="Structure name" maxlength="40" spellcheck="false">
            <button type="button" class="icon-btn" data-act="remove" aria-label="Remove ${esc(t.name)}" title="Remove this structure type">×</button>
          </div>
          <div class="stype-meta">${inst.length ? `<b>${inst.length.toLocaleString()}</b> on <b>${pieces}</b> piece${pieces === 1 ? '' : 's'}${autoPieces ? ` (${autoPieces} matched automatically)` : ''}` : 'Nothing added yet'}${t.id === this.activeId ? '' : ' · <button type="button" class="link-btn" data-act="activate">add to this one</button>'}</div>
          <div class="seg" role="radiogroup" aria-label="Colour rule">${seg('single', 'One colour')}${seg('sequence', 'Sequence')}${seg('random', 'Random')}</div>
          <div class="rule-body">${body}</div>
        </div>`;
      })
      .join('');
    /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.stype')).forEach((card) => {
      const id = Number(card.dataset.id);
      const t = e.types.find((x) => x.id === id);
      card.addEventListener('click', (ev) => {
        const el = /** @type {HTMLElement} */ ((/** @type {HTMLElement} */ (ev.target)).closest('[data-act]'));
        if (!el) {
          if (this.activeId !== id) {
            this.activeId = id;
            this.invalidateHover();
            this.render();
          }
          return;
        }
        this.onCardAction(t, el);
      });
      const name = /** @type {HTMLInputElement} */ (card.querySelector('.stype-name'));
      name.addEventListener('change', () => {
        const before = e.snapshot();
        t.name = name.value.trim() || t.name;
        this.host.pushStructureUndo(before, e.snapshot());
        this.renderReview();
      });
      name.addEventListener('keydown', (k) => {
        if (k.key === 'Enter') name.blur();
        k.stopPropagation();
      });
      const sp = /** @type {HTMLInputElement} */ (card.querySelector('[data-act="rnd-spacing"]'));
      sp?.addEventListener('change', () => {
        if (t.rule.kind !== 'random') return;
        const before = e.snapshot();
        t.rule.spacing = Math.max(0, Number(sp.value) || 0);
        this.commit(before);
      });
      sp?.addEventListener('keydown', (k) => k.stopPropagation());
    });
  }

  /**
   * @param {StructureType[]} before
   * @returns {void}
   */
  commit(before) {
    const e = this.engine;
    this.applyLayer();
    this.host.pushStructureUndo(before, e.snapshot());
    this.render();
  }

  /**
   * @param {StructureType} t
   * @param {HTMLElement} el
   * @returns {void}
   */
  onCardAction(t, el) {
    const e = this.engine;
    const act = el.dataset.act;
    if (act === 'rnd-spacing') return;
    const before = e.snapshot();
    const fils = this.host.filaments().length;
    const r = t.rule;
    switch (act) {
      case 'activate':
        this.activeId = t.id;
        this.invalidateHover();
        this.render();
        return;
      case 'remove':
        e.types = e.types.filter((x) => x.id !== t.id);
        if (this.activeId === t.id) this.activeId = e.types.at(-1)?.id ?? 0;
        break;
      case 'rule': {
        const kind = /** @type {Rule['kind']} */ (el.dataset.kind);
        if (kind === r.kind) return;
        const cur = r.kind === 'single' ? [r.filament] : r.filaments;
        const seq = cur.length > 1 ? cur : [2, 3, 4].filter((n) => n <= fils);
        if (kind === 'single') t.rule = { kind, filament: cur[0] ?? 2 };
        else if (kind === 'sequence') t.rule = { kind, filaments: seq.length ? seq : [cur[0] ?? 1] };
        else t.rule = { kind, filaments: seq.length ? seq : [cur[0] ?? 1], seed: 1, spacing: 0 };
        break;
      }
      case 'single':
        if (r.kind === 'single') r.filament = Number(el.dataset.n);
        break;
      case 'seq-add':
        if (r.kind === 'sequence') r.filaments.push(Number(el.dataset.n));
        break;
      case 'seq-del':
        if (r.kind === 'sequence') r.filaments.splice(Number(el.dataset.i), 1);
        break;
      case 'rnd-toggle':
        if (r.kind === 'random') {
          const n = Number(el.dataset.n);
          r.filaments = r.filaments.includes(n) ? r.filaments.filter((x) => x !== n) : [...r.filaments, n].sort((a, b) => a - b);
        }
        break;
      case 'rnd-shuffle':
        if (r.kind === 'random') r.seed = (r.seed * 48271 + 11) % 2147483647;
        break;
      default:
        return;
    }
    this.commit(before);
  }

  /**
   * @param {number} p
   * @returns {string}
   */
  pieceLabel(p) {
    const a = this.engine.analysis;
    const pos = a.chainPosition[p];
    const chained = a.chainOrder.length > 2;
    const where = !chained || pos < 0 ? 'loose' : p === a.chainOrder[0] ? 'head' : p === a.chainOrder.at(-1) ? 'tail' : `chain ${pos + 1}`;
    return `Piece ${p + 1} · ${where}`;
  }

  /** @returns {void} */
  renderReview() {
    const root = this.els.review;
    const e = this.engine;
    const t = this.activeType;
    if (!e || !t || !t.selections.length) {
      root.innerHTML = '';
      return;
    }
    const a = e.analysis;
    const covered = e.coveredGroups(t);
    const rows = a.groups
      .map((g, i) => ({ g, i }))
      .filter(({ i }) => !covered.has(i))
      .sort((x, y) => {
        const px = a.chainPosition[x.g.ref], py = a.chainPosition[y.g.ref];
        return (px < 0 ? 1e9 : px) - (py < 0 ? 1e9 : py);
      });
    if (!rows.length) {
      root.innerHTML = `<p class="hint">“${esc(t.name)}” is on every kind of piece.</p>`;
      return;
    }
    const MAX = 12;
    root.innerHTML =
      `<div class="review-head">Pieces without “${esc(t.name)}” (${rows.reduce((n, r) => n + r.g.members.length, 0)}). Click one to zoom to it, then hover its structure.</div>` +
      `<ul class="review-list">${rows
        .slice(0, MAX)
        .map(
          ({ g, i }) =>
            `<li><button type="button" data-group="${i}"><em>${g.members.length > 1 ? `<b>${g.members.length} ×</b> ` : ''}${this.pieceLabel(g.ref)}</em><span>${a.stats[g.ref].faces.toLocaleString()} tri</span></button></li>`,
        )
        .join('')}${rows.length > MAX ? `<li class="hint">…and ${rows.length - MAX} more kinds</li>` : ''}</ul>`;
    /** @type {NodeListOf<HTMLButtonElement>} */ (root.querySelectorAll('button[data-group]')).forEach((b) =>
      b.addEventListener('click', () => this.showGroup(Number(b.dataset.group), true)),
    );
  }

  /**
   * Highlight a group's pieces; optionally zoom to its reference piece.
   * @param {number} gi
   * @param {boolean} zoom
   * @returns {void}
   */
  showGroup(gi, zoom) {
    const e = this.engine;
    if (!e) return;
    const a = e.analysis;
    const g = a.groups[gi];
    let n = 0;
    for (const p of g.members) n += a.pieces.pieceStart[p + 1] - a.pieces.pieceStart[p];
    const faces = new Uint32Array(n);
    let k = 0;
    for (const p of g.members) for (let j = a.pieces.pieceStart[p]; j < a.pieces.pieceStart[p + 1]; j++) faces[k++] = a.pieces.pieceFaces[j];
    this.cache = null;
    this.host.viewer.setHighlight(faces, 'info');
    if (zoom) {
      const s = a.stats[g.ref];
      this.host.viewer.frameBox(s.min, s.max);
    }
  }

  /** @returns {void} */
  renderPieces() {
    const root = this.els.pieces;
    const e = this.engine;
    if (!e) {
      root.innerHTML = `<p class="hint">${this.status === 'analysing' ? esc(this.progressText) : 'Pieces appear here once a model is analysed.'}</p>`;
      return;
    }
    const a = e.analysis;
    const multi = a.groups.map((g, i) => ({ g, i })).filter(({ g }) => g.members.length > 1).sort((x, y) => y.g.members.length - x.g.members.length);
    const singles = a.groups.length - multi.length;
    const chain = a.chainOrder.length;
    root.innerHTML =
      `<p class="hint"><b>${a.pieces.count.toLocaleString()}</b> pieces, <b>${a.groups.length}</b> different shapes · analysed in ${a.seconds.toFixed(1)} s</p>` +
      `<ul class="review-list">${multi
        .slice(0, 8)
        .map(({ g, i }) => `<li><button type="button" data-group="${i}"><em><b>${g.members.length} ×</b> identical piece</em><span>${a.stats[g.ref].faces.toLocaleString()} tri</span></button></li>`)
        .join('')}${singles ? `<li class="hint">${singles} one-off piece${singles === 1 ? '' : 's'}</li>` : ''}</ul>` +
      (chain > 2
        ? `<div class="chain-row"><span>Chain of <b>${chain}</b> linked pieces</span><span class="chain-actions"><button type="button" class="btn btn-quiet" id="chain-head">Show head</button><button type="button" class="btn btn-quiet" id="chain-swap">Swap head and tail</button></span></div>`
        : `<p class="hint">No chain of linked pieces found, so sequences follow the piece order.</p>`);
    /** @type {NodeListOf<HTMLButtonElement>} */ (root.querySelectorAll('button[data-group]')).forEach((b) => b.addEventListener('click', () => this.showGroup(Number(b.dataset.group), false)));
    root.querySelector('#chain-head')?.addEventListener('click', () => this.showHead());
    root.querySelector('#chain-swap')?.addEventListener('click', () => {
      e.reverseChain();
      this.applyLayer();
      this.render();
      this.showHead();
      this.host.toast('Head and tail swapped. Sequences now start from the other end.');
    });
  }

  /** @returns {void} */
  showHead() {
    const e = this.engine;
    if (!e || !e.analysis.chainOrder.length) return;
    const a = e.analysis;
    const head = a.chainOrder[0];
    const faces = a.pieces.pieceFaces.slice(a.pieces.pieceStart[head], a.pieces.pieceStart[head + 1]);
    this.cache = null;
    this.host.viewer.setHighlight(faces, 'info');
    const s = a.stats[head];
    this.host.viewer.frameBox(s.min, s.max);
  }
}
