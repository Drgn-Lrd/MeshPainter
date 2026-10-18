import * as THREE from './lib/three.js?v=51d02c347d';
import { OrbitControls } from './lib/three.js?v=51d02c347d';
import { SUBDIV } from './model-data.js?v=bb5fb4d3b6';
/** @typedef {import('./model-data.js').ModelData} ModelData */
import { decodePaint, forEachLeaf } from './paint-codec.js?v=0d8bec0312';
/** @typedef {import('./paint-codec.js').Vec3} Vec3 */
import { meshVertex, meshFragment, pickFragment, overlayVertex, overlayFragment, overlayPickFragment, PALETTE_SIZE } from './shaders.js?v=0f20f4332e';

/** @typedef {'orbit' | 'paint'} ViewerMode */

const TEX_W = 4096;
const CHUNK_FACES = 1 << 20;
const BED_MM = 270;

/**
 * @typedef {object} Chunk
 * @property {THREE.BufferGeometry} geometry
 * @property {THREE.Mesh} mesh
 * @property {THREE.Mesh} pick
 */

/** Thrown by the Viewer when the browser will not start WebGL at all. */
export class GraphicsUnavailableError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GraphicsUnavailableError';
  }
}

export class Viewer {
  /** @type {HTMLCanvasElement} */
  canvas;
  /** @type {THREE.WebGLRenderer} */
  renderer;
  scene = new THREE.Scene();
  pickScene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  /** @type {OrbitControls} */
  controls;
  /** @type {Chunk[]} */
  chunks = [];
  /** @type {{ mesh: THREE.Mesh; pick: THREE.Mesh } | null} */
  overlay = null;
  plate = new THREE.Group();
  stateData = new Uint8Array(TEX_W);
  /** @type {THREE.DataTexture} */
  stateTex;
  /** @type {THREE.Vector3[]} */
  palette = Array.from({ length: PALETTE_SIZE }, () => new THREE.Vector3(0.6, 0.6, 0.6));
  /** @type {Record<string, THREE.IUniform>} */
  uniforms;
  pickTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
  pickBuf = new Uint8Array(4);
  dirty = true;
  /** @type {ModelData | null} */
  model = null;
  /** @type {Uint8Array} */
  defaults = new Uint8Array(0);
  /**
   * structure paint layer (0 = none), drawn over the model's own paint
   * @type {Uint8Array | null}
   */
  layer = null;
  /** @type {Uint32Array} */
  highlighted = new Uint32Array(0);
  highlightCount = 0;
  bounds = new THREE.Box3();
  /** @type {ResizeObserver} */
  resizeObs;
  disposed = false;
  /** @type {() => void} */
  onCameraChange;
  /** @type {HTMLElement} */
  container;

  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (err) {
      // The browser refused to start WebGL (graphics switched off, or turned off after a GPU crash).
      throw new GraphicsUnavailableError(err instanceof Error ? err.message : String(err));
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'viewer-canvas';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);

    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-150, -250, 200);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => {
      this.requestRender();
      this.onCameraChange?.();
    });

    this.stateTex = this.makeStateTexture(1);
    this.uniforms = {
      uState: { value: this.stateTex },
      uTexW: { value: TEX_W },
      uPalette: { value: this.palette },
      uHover: { value: -1 },
      uHoverColor: { value: new THREE.Color(1, 1, 1) },
      uHighlightColor: { value: new THREE.Color(1, 0.85, 0.2) },
    };

    this.scene.add(this.plate);
    this.applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    new MutationObserver(() => this.applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    // If the graphics driver resets, the browser drops everything on the GPU. preventDefault()
    // asks it to give the context back; the page then rebuilds the model buffers.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.onContextLost?.();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.onContextRestored?.();
    });
    const loop = () => {
      if (this.disposed) return;
      if (this.dirty) {
        this.dirty = false;
        this.renderer.render(this.scene, this.camera);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** @type {() => void} */
  onContextLost;
  /** @type {(() => void) | undefined} called when the browser gives the graphics context back */
  onContextRestored;

  /**
   * Read colours from CSS tokens so the 3D view follows the page theme.
   * @returns {void}
   */
  applyTheme() {
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue('--viewer-bg').trim() || '#1b1f22';
    const grid = cs.getPropertyValue('--viewer-grid').trim() || '#3a4248';
    const hover = cs.getPropertyValue('--accent').trim() || '#ffffff';
    this.scene.background = new THREE.Color(bg);
    setSrgb(/** @type {THREE.Color} */ (this.uniforms.uHoverColor.value), hover);
    this.plate.traverse((o) => {
      const m = /** @type {THREE.LineBasicMaterial | undefined} */ ((/** @type {THREE.LineSegments} */ (o)).material);
      if (m && 'color' in m) m.color.set(grid);
    });
    this.requestRender();
  }

  /** @returns {void} */
  requestRender() {
    this.dirty = true;
  }

  /** @returns {void} */
  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /**
   * @param {ViewerMode} mode
   * @returns {void}
   */
  setMode(mode) {
    const c = this.controls;
    if (mode === 'orbit') {
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      c.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
      c.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
    }
  }

  /**
   * @param {number} rows
   * @returns {THREE.DataTexture}
   */
  makeStateTexture(rows) {
    const t = new THREE.DataTexture(this.stateData, TEX_W, rows, THREE.RedIntegerFormat, THREE.UnsignedByteType);
    t.internalFormat = 'R8UI';
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
  }

  /**
   * @param {string} fragment
   * @param {number} faceOffset
   * @param {boolean} pick
   * @returns {THREE.RawShaderMaterial}
   */
  material(fragment, faceOffset, pick) {
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: meshVertex,
      fragmentShader: fragment,
      uniforms: pick
        ? { uState: this.uniforms.uState, uTexW: this.uniforms.uTexW, uFaceOffset: { value: faceOffset } }
        : { ...this.uniforms, uFaceOffset: { value: faceOffset } },
      side: THREE.DoubleSide,
    });
  }

  /**
   * Show a model. `defaults` = per-face default filament. Builds GPU buffers chunk by chunk.
   * @param {ModelData} model
   * @param {Uint8Array} defaults
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<void>}
   */
  async setModel(model, defaults, onProgress) {
    this.clearModel();
    this.model = model;
    this.defaults = defaults;
    const F = model.indices.length / 3;
    const rows = Math.max(1, Math.ceil(F / TEX_W));
    this.stateData = new Uint8Array(rows * TEX_W);
    this.stateTex.dispose();
    this.stateTex = this.makeStateTexture(rows);
    this.uniforms.uState.value = this.stateTex;
    this.refreshAll();

    const pos = model.positions;
    const idx = model.indices;
    this.bounds.makeEmpty();
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.length; i += 3) {
      v.set(pos[i], pos[i + 1], pos[i + 2]);
      this.bounds.expandByPoint(v);
    }
    for (let f0 = 0; f0 < F; f0 += CHUNK_FACES) {
      const n = Math.min(CHUNK_FACES, F - f0);
      const arr = new Float32Array(n * 9);
      for (let f = 0; f < n; f++) {
        const src = (f0 + f) * 3;
        for (let k = 0; k < 3; k++) {
          const vi = idx[src + k] * 3;
          const o = f * 9 + k * 3;
          arr[o] = pos[vi];
          arr[o + 1] = pos[vi + 1];
          arr[o + 2] = pos[vi + 2];
        }
      }
      const geometry = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(arr, 3);
      geometry.setAttribute('position', attr);
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      // Free the CPU copy once it is on the GPU (the model keeps the indexed data).
      attr.onUpload(function () {
        (/** @type {{ array: Float32Array | null }} */ (/** @type {unknown} */ (this))).array = null;
      });
      const mesh = new THREE.Mesh(geometry, this.material(meshFragment, f0, false));
      const pick = new THREE.Mesh(geometry, this.material(pickFragment, f0, true));
      this.scene.add(mesh);
      this.pickScene.add(pick);
      this.chunks.push({ geometry, mesh, pick });
      onProgress?.(f0 + n, F);
      // let the browser breathe (and upload) between chunks
      this.renderer.compile(this.scene, this.camera);
      this.renderer.render(this.scene, this.camera);
      await new Promise((r) => setTimeout(r, 0));
    }
    this.rebuildOverlay();
    this.buildPlate();
    this.fit();
    this.requestRender();
  }

  /** @returns {void} */
  clearModel() {
    for (const c of this.chunks) {
      this.scene.remove(c.mesh);
      this.pickScene.remove(c.pick);
      c.geometry.dispose();
      (/** @type {THREE.Material} */ (c.mesh.material)).dispose();
      (/** @type {THREE.Material} */ (c.pick.material)).dispose();
    }
    this.chunks = [];
    this.clearOverlay();
    this.model = null;
    this.layer = null;
    this.highlightCount = 0;
    this.uniforms.uHover.value = -1;
    this.requestRender();
  }

  /**
   * Point at a model whose arrays were handed back from the worker (same geometry).
   * @param {ModelData} model
   * @returns {void}
   */
  rebind(model) {
    this.model = model;
  }

  /** @returns {boolean} */
  get hasModel() {
    return this.model !== null;
  }

  /**
   * @param {string[]} colors
   * @returns {void}
   */
  setPalette(colors) {
    const c = new THREE.Color();
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const hex = colors[i - 1] ?? '#9aa0a6';
      c.set(hex);
      this.palette[i].set(c.r, c.g, c.b);
    }
    // colours are given in sRGB; THREE.Color converts to linear on set() - undo that
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const p = this.palette[i];
      p.set(lin2srgb(p.x), lin2srgb(p.y), lin2srgb(p.z));
    }
    this.requestRender();
  }

  /**
   * @param {number} f
   * @returns {number}
   */
  displayByte(f) {
    if (this.layer && this.layer[f] !== 0) return this.layer[f] & 63;
    const s = this.model.faceState[f];
    if (s === SUBDIV) return 128;
    return (s !== 0 ? s : this.defaults[f]) & 63;
  }

  /** @returns {void} */
  refreshAll() {
    if (!this.model) return;
    const F = this.model.faceState.length;
    for (let f = 0; f < F; f++) this.stateData[f] = this.displayByte(f) | (this.stateData[f] & 64);
    this.stateTex.needsUpdate = true;
    this.requestRender();
  }

  /**
   * @param {Iterable<number>} faces
   * @returns {void}
   */
  refreshFaces(faces) {
    if (!this.model) return;
    for (const f of faces) this.stateData[f] = this.displayByte(f) | (this.stateData[f] & 64);
    this.stateTex.needsUpdate = true;
    this.requestRender();
  }

  /**
   * @param {Uint8Array} defaults
   * @returns {void}
   */
  setDefaults(defaults) {
    this.defaults = defaults;
    this.refreshAll();
    this.rebuildOverlay();
  }

  /** @returns {void} */
  clearOverlay() {
    if (!this.overlay) return;
    this.scene.remove(this.overlay.mesh);
    this.pickScene.remove(this.overlay.pick);
    this.overlay.mesh.geometry.dispose();
    (/** @type {THREE.Material} */ (this.overlay.mesh.material)).dispose();
    (/** @type {THREE.Material} */ (this.overlay.pick.material)).dispose();
    this.overlay = null;
  }

  /**
   * Expand subdivided (brush-painted) triangles into their coloured sub-triangles.
   * @returns {void}
   */
  rebuildOverlay() {
    this.clearOverlay();
    const m = this.model;
    if (!m || m.subdiv.size === 0) {
      this.requestRender();
      return;
    }
    /** @type {number[]} */
    const pos = [];
    /** @type {number[]} */
    const col = [];
    /** @type {number[]} */
    const face = [];
    const P = m.positions;
    const I = m.indices;
    /**
     * @param {number} v
     * @returns {Vec3}
     */
    const vtx = (v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
    for (const [f, str] of m.subdiv) {
      if (this.layer && this.layer[f] !== 0) continue;
      let tree;
      try {
        tree = decodePaint(str);
      } catch {
        continue;
      }
      const def = this.defaults[f];
      forEachLeaf(tree, vtx(I[f * 3]), vtx(I[f * 3 + 1]), vtx(I[f * 3 + 2]), (s, a, b, c) => {
        pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        const ci = s !== 0 ? s : def;
        col.push(ci, ci, ci);
        face.push(f, f, f);
      });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 1));
    g.setAttribute('aFace', new THREE.Float32BufferAttribute(face, 1));
    g.computeBoundingSphere();
    /**
     * @param {string} frag
     * @param {boolean} pick
     */
    const mk = (frag, pick) =>
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: overlayVertex,
        fragmentShader: frag,
        uniforms: pick ? {} : { uPalette: this.uniforms.uPalette, uHover: this.uniforms.uHover, uHoverColor: this.uniforms.uHoverColor },
        side: THREE.DoubleSide,
      });
    const mesh = new THREE.Mesh(g, mk(overlayFragment, false));
    const pick = new THREE.Mesh(g, mk(overlayPickFragment, true));
    this.scene.add(mesh);
    this.pickScene.add(pick);
    this.overlay = { mesh, pick };
    this.requestRender();
  }

  /**
   * Face under a client-space point, or -1.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {number}
   */
  pick(clientX, clientY) {
    if (!this.model) return -1;
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    if (x < 0 || y < 0 || x >= r.width || y >= r.height) return -1;
    this.camera.setViewOffset(r.width, r.height, x, y, 1, 1);
    const prevTarget = this.renderer.getRenderTarget();
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.pickTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.pickScene, this.camera);
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, this.pickBuf);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevClear, prevAlpha);
    this.camera.clearViewOffset();
    const b = this.pickBuf;
    const id = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    return id - 1;
  }

  /**
   * Point on face `f` under the cursor (ray / triangle-plane intersection).
   * @param {number} f
   * @param {number} clientX
   * @param {number} clientY
   * @returns {Vec3 | null}
   */
  hitPoint(f, clientX, clientY) {
    const m = this.model;
    if (!m) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const P = m.positions;
    const I = m.indices;
    const a = new THREE.Vector3(P[I[f * 3] * 3], P[I[f * 3] * 3 + 1], P[I[f * 3] * 3 + 2]);
    const b = new THREE.Vector3(P[I[f * 3 + 1] * 3], P[I[f * 3 + 1] * 3 + 1], P[I[f * 3 + 1] * 3 + 2]);
    const c = new THREE.Vector3(P[I[f * 3 + 2] * 3], P[I[f * 3 + 2] * 3 + 1], P[I[f * 3 + 2] * 3 + 2]);
    const plane = new THREE.Plane().setFromCoplanarPoints(a, b, c);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return [hit.x, hit.y, hit.z];
  }

  /**
   * @param {number} face
   * @returns {void}
   */
  setHover(face) {
    if (this.uniforms.uHover.value === face) return;
    this.uniforms.uHover.value = face;
    this.requestRender();
  }

  /** @returns {void} */
  buildPlate() {
    this.plate.clear();
    const cs = getComputedStyle(document.documentElement);
    const gridColor = cs.getPropertyValue('--viewer-grid').trim() || '#3a4248';
    const b = this.bounds;
    const cx = (b.min.x + b.max.x) / 2;
    const cy = (b.min.y + b.max.y) / 2;
    const z = b.min.z - 0.05;
    const half = BED_MM / 2;
    /** @type {number[]} */
    const fine = [];
    /** @type {number[]} */
    const bold = [];
    for (let i = -half; i <= half + 1e-6; i += 10) {
      const list = Math.abs(i % 50) < 1e-6 ? bold : fine;
      list.push(cx + i, cy - half, z, cx + i, cy + half, z);
      list.push(cx - half, cy + i, z, cx + half, cy + i, z);
    }
    /**
     * @param {number[]} pts
     * @param {number} opacity
     */
    const mk = (pts, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const m = new THREE.LineBasicMaterial({ color: gridColor, transparent: true, opacity, depthWrite: false });
      return new THREE.LineSegments(g, m);
    };
    this.plate.add(mk(fine, 0.35));
    this.plate.add(mk(bold, 0.8));
  }

  /** @returns {number} */
  viewDistance() {
    const size = this.bounds.isEmpty() ? new THREE.Vector3(100, 100, 50) : this.bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = radius / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2);
    this.camera.near = Math.max(0.01, radius / 200);
    this.camera.far = radius * 40 + 1000;
    this.camera.updateProjectionMatrix();
    return fit * 1.05;
  }

  /** @returns {THREE.Vector3} */
  center() {
    return this.bounds.isEmpty() ? new THREE.Vector3() : this.bounds.getCenter(new THREE.Vector3());
  }

  /** @returns {void} */
  fit() {
    const d = this.viewDistance();
    const c = this.center();
    const dir = new THREE.Vector3(-0.45, -0.75, 0.62).normalize();
    this.camera.position.copy(c).addScaledVector(dir, d);
    this.controls.target.copy(c);
    this.controls.update();
    this.requestRender();
  }

  /**
   * Show a structure paint layer over the model's paint (null to remove).
   * @param {Uint8Array | null} layer
   * @returns {void}
   */
  setLayer(layer) {
    this.layer = layer;
    this.refreshAll();
    this.rebuildOverlay();
  }

  /**
   * Highlight a set of faces (replaces the previous highlight). `tone` picks the
   * colour: 'add' for a structure about to be added, 'cut' for a part about to be
   * excluded, 'info' for showing pieces.
   * @param {Uint32Array | null} faces
   * @param {'add' | 'cut' | 'info'} [tone]
   * @returns {void}
   */
  setHighlight(faces, tone = 'add') {
    if (!this.model) return;
    const data = this.stateData;
    for (let i = 0; i < this.highlightCount; i++) data[this.highlighted[i]] &= ~64;
    const n = faces ? faces.length : 0;
    if (this.highlighted.length < n) this.highlighted = new Uint32Array(Math.max(n, this.highlighted.length * 2));
    for (let i = 0; i < n; i++) {
      const f = faces[i];
      this.highlighted[i] = f;
      data[f] |= 64;
    }
    this.highlightCount = n;
    const cs = getComputedStyle(document.documentElement);
    const css = tone === 'cut' ? cs.getPropertyValue('--bad').trim() || '#ff6b5b' : tone === 'info' ? cs.getPropertyValue('--warn').trim() || '#f0b94a' : cs.getPropertyValue('--accent').trim() || '#57c3cc';
    setSrgb(/** @type {THREE.Color} */ (this.uniforms.uHighlightColor.value), css);
    this.stateTex.needsUpdate = true;
    this.requestRender();
  }

  /**
   * Point the camera at a box, keeping the current viewing direction.
   * @param {[number, number, number]} min
   * @param {[number, number, number]} max
   * @returns {void}
   */
  frameBox(min, max) {
    const c = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const r = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const fov = (this.camera.fov * Math.PI) / 180;
    const d = (r / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2)) * 1.2;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, d);
    this.controls.update();
    this.requestRender();
  }

  /** @returns {void} */
  topView() {
    const d = this.viewDistance();
    const c = this.center();
    this.camera.position.set(c.x, c.y - d * 0.001, c.z + d);
    this.controls.target.copy(c);
    this.controls.update();
    this.requestRender();
  }

  /** @returns {void} */
  dispose() {
    this.disposed = true;
    this.resizeObs.disconnect();
    this.clearModel();
    this.renderer.dispose();
  }
}

/**
 * Store an sRGB CSS colour without colour management (the shaders work in sRGB).
 * @param {THREE.Color} target
 * @param {string} css
 * @returns {void}
 */
function setSrgb(target, css) {
  target.set(css);
  target.setRGB(lin2srgb(target.r), lin2srgb(target.g), lin2srgb(target.b), THREE.LinearSRGBColorSpace);
}

/**
 * @param {number} x
 * @returns {number}
 */
function lin2srgb(x) {
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}
