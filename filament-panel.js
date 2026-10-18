import { BASIC_COLORS, inkFor } from './colors.js?v=0dda646d26';
import { ColorWheel } from './color-wheel.js?v=b11fbeba76';
import { MAX_FILAMENTS } from './model-data.js?v=bb5fb4d3b6';

/**
 * @typedef {object} Filament
 * @property {string} name
 * @property {string} color
 * @property {boolean} autoName name follows the colour until the user types their own
 */

/** @type {Filament[]} */
export const DEFAULT_FILAMENTS = [
  { name: 'Green', color: '#00A63F', autoName: true },
  { name: 'Red', color: '#C8281E', autoName: true },
  { name: 'Yellow', color: '#F4E22A', autoName: true },
  { name: 'White', color: '#F4F4F2', autoName: true },
];

const PENCIL_SVG =
  '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M13.6 2.6a1.9 1.9 0 0 1 2.7 0l1.1 1.1a1.9 1.9 0 0 1 0 2.7L7.2 16.6l-4.2 1 1-4.2L13.6 2.6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m12.2 4 3.8 3.8" stroke="currentColor" stroke-width="1.6"/></svg>';

/**
 * @typedef {object} FilamentPanelHooks
 * @property {(index: number) => void} onSelect
 * @property {(index: number, color: string, name?: string) => void} onColor
 * @property {(index: number, name: string) => void} onRename
 * @property {() => void} onAdd
 * @property {() => void} onRemoveLast
 */

export class FilamentPanel {
  /** @type {HTMLElement} */
  list;
  /** @type {HTMLButtonElement} */
  addBtn;
  /** @type {HTMLButtonElement} */
  removeBtn;
  /** @type {HTMLElement} */
  popover;
  wheel = new ColorWheel();
  editing = -1;
  /** @type {Filament[]} */
  filaments = [];
  /** @type {FilamentPanelHooks} */
  hooks;

  /**
   * @param {HTMLElement} root
   * @param {FilamentPanelHooks} hooks
   */
  constructor(root, hooks) {
    this.hooks = hooks;
    root.innerHTML = `
      <ol class="filament-list" aria-label="Filaments"></ol>
      <div class="filament-actions">
        <button type="button" class="btn btn-quiet" id="filament-add">+ Add filament</button>
        <button type="button" class="btn btn-quiet" id="filament-remove">Remove last</button>
      </div>`;
    this.list = root.querySelector('.filament-list');
    this.addBtn = root.querySelector('#filament-add');
    this.removeBtn = root.querySelector('#filament-remove');
    this.addBtn.addEventListener('click', () => hooks.onAdd());
    this.removeBtn.addEventListener('click', () => hooks.onRemoveLast());

    this.popover = document.createElement('div');
    this.popover.className = 'popover';
    this.popover.setAttribute('role', 'dialog');
    this.popover.hidden = true;
    this.popover.innerHTML = `
      <div class="popover-head"><strong class="popover-title"></strong><button type="button" class="icon-btn" data-close aria-label="Close">×</button></div>
      <div class="basic-grid" role="listbox" aria-label="Basic colours"></div>
      <button type="button" class="btn btn-quiet advanced-toggle" aria-expanded="false">Advanced</button>
      <div class="advanced" hidden></div>`;
    document.body.appendChild(this.popover);
    const grid = this.popover.querySelector('.basic-grid');
    for (const c of BASIC_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'basic-swatch';
      b.dataset.hex = c.hex;
      b.setAttribute('role', 'option');
      b.innerHTML = `<span class="chip" style="background:${c.hex}"></span><span>${c.name}</span>`;
      b.addEventListener('click', () => {
        if (this.editing < 0) return;
        this.hooks.onColor(this.editing, c.hex, c.name);
        this.wheel.setColor(c.hex);
        this.markSelected(c.hex);
      });
      grid.appendChild(b);
    }
    const adv = /** @type {HTMLElement} */ (this.popover.querySelector('.advanced'));
    adv.appendChild(this.wheel.el);
    const toggle = /** @type {HTMLButtonElement} */ (this.popover.querySelector('.advanced-toggle'));
    toggle.addEventListener('click', () => {
      adv.hidden = !adv.hidden;
      toggle.setAttribute('aria-expanded', String(!adv.hidden));
      toggle.textContent = adv.hidden ? 'Advanced' : 'Hide advanced';
      this.position();
    });
    this.wheel.onInput = (hex) => {
      if (this.editing >= 0) this.hooks.onColor(this.editing, hex);
      this.markSelected(hex);
    };
    this.popover.querySelector('[data-close]').addEventListener('click', () => this.close());
    document.addEventListener('pointerdown', (e) => {
      if (this.popover.hidden) return;
      const t = /** @type {Node} */ (e.target);
      if (this.popover.contains(t)) return;
      if ((/** @type {HTMLElement} */ (t)).closest?.('.pencil-btn')) return;
      this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.popover.hidden) this.close();
    });
    window.addEventListener('resize', () => this.position());
  }

  /** @type {HTMLElement | null} */
  anchor = null;

  /**
   * @param {string} hex
   * @returns {void}
   */
  markSelected(hex) {
    /** @type {NodeListOf<HTMLElement>} */ (this.popover.querySelectorAll('.basic-swatch')).forEach((b) => b.classList.toggle('selected', b.dataset.hex === hex.toUpperCase()));
  }

  /**
   * @param {number} index
   * @param {HTMLElement} anchor
   * @returns {void}
   */
  open(index, anchor) {
    this.editing = index;
    this.anchor = anchor;
    const f = this.filaments[index];
    this.popover.querySelector('.popover-title').textContent = `Filament ${index + 1} colour`;
    this.wheel.setColor(f.color);
    this.markSelected(f.color);
    this.popover.hidden = false;
    this.position();
    /** @type {HTMLButtonElement} */ (this.popover.querySelector('.basic-swatch'))?.focus();
  }

  /** @returns {void} */
  close() {
    this.popover.hidden = true;
    this.editing = -1;
    this.anchor?.focus();
    this.anchor = null;
  }

  /** @returns {void} */
  position() {
    if (this.popover.hidden || !this.anchor) return;
    const a = this.anchor.getBoundingClientRect();
    const p = this.popover.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = a.right + 10;
    let top = a.top - 12;
    if (left + p.width > vw - 12) left = Math.max(12, Math.min(vw - p.width - 12, a.left));
    if (left < a.right && left + p.width > a.left) top = a.bottom + 8; // below the anchor when it does not fit beside
    if (top + p.height > vh - 12) top = Math.max(12, vh - p.height - 12);
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }

  /**
   * @param {Filament[]} filaments
   * @param {number} active
   * @param {number[]} usage
   * @returns {void}
   */
  render(filaments, active, usage) {
    this.filaments = filaments;
    this.list.innerHTML = '';
    filaments.forEach((f, i) => {
      const li = document.createElement('li');
      li.className = 'filament' + (i + 1 === active ? ' active' : '');
      const used = usage[i + 1] ?? 0;
      li.innerHTML = `
        <button type="button" class="swatch" aria-pressed="${i + 1 === active}" title="Paint with filament ${i + 1}" style="--swatch:${f.color};--ink:${inkFor(f.color)}">${i + 1}</button>
        <div class="filament-text">
          <input id="filament-name-${i + 1}" class="filament-name" value="" aria-label="Name of filament ${i + 1}" maxlength="40" spellcheck="false">
          <span class="filament-meta">${f.color.toUpperCase()}${used ? ` · ${used.toLocaleString()} tri` : ''}</span>
        </div>
        <button type="button" class="icon-btn pencil-btn" aria-label="Edit colour of filament ${i + 1}" title="Edit colour">${PENCIL_SVG}</button>`;
      const name = /** @type {HTMLInputElement} */ (li.querySelector('.filament-name'));
      name.value = f.name;
      name.addEventListener('change', () => this.hooks.onRename(i, name.value.trim() || `Filament ${i + 1}`));
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') name.blur();
        e.stopPropagation();
      });
      li.querySelector('.swatch').addEventListener('click', () => this.hooks.onSelect(i + 1));
      const pencil = /** @type {HTMLButtonElement} */ (li.querySelector('.pencil-btn'));
      pencil.addEventListener('click', () => {
        if (!this.popover.hidden && this.editing === i) this.close();
        else this.open(i, pencil);
      });
      this.list.appendChild(li);
    });
    this.addBtn.disabled = filaments.length >= MAX_FILAMENTS;
    this.removeBtn.disabled = filaments.length <= 1;
    if (!this.popover.hidden && this.editing >= 0) {
      const pencils = /** @type {NodeListOf<HTMLElement>} */ (this.list.querySelectorAll('.pencil-btn'));
      this.anchor = pencils[this.editing] ?? null;
      this.position();
    }
  }
}
