/**
 * Structure selection by a minimum cut.
 *
 * A modelled structure (a rose on a body segment) is separated from the rest of
 * its piece by a ring of concave creases where it meets the body. Growing from
 * the mouse until a crease is hit stops at the first crease met, which on a rose
 * is often a fold between two petals (leaving parts of the rose out), and leaks
 * through gaps in the ring into thorns and leaves; on a simplified mesh the large
 * triangles break the creases up even more.
 *
 * Here the whole neighbourhood of the structure is looked at at once: the faces
 * near its top must be inside, the faces far away must be outside, and the
 * boundary between them is the closed loop that is cheapest to cut. Cutting
 * along a concave crease is cheap, cutting across smooth or convex surface is
 * expensive, so the loop follows the crease ring at the base of the structure.
 * The result is the same on a full and a simplified copy of a model.
 */
/** @typedef {import('./region-growing.js').RegionGrower} RegionGrower */
/** @typedef {import('./region-growing.js').GrowParams} GrowParams */

/**
 * Minimum s-t cut of an undirected graph with real capacities. Edges to the
 * source s and the sink t become terminal links, then the Boykov-Kolmogorov
 * max-flow algorithm (search trees grown from both terminals and reused between
 * augmentations) runs on the rest; it is fast on mesh-like graphs.
 * Returns the nodes on the source side.
 * @param {number} n node count (source and sink included)
 * @param {Int32Array} from edge end
 * @param {Int32Array} to edge end
 * @param {Float64Array} cap edge capacity (both directions)
 * @param {number} m number of edges used
 * @param {number} s source node
 * @param {number} t sink node
 * @returns {Uint8Array}
 */
export function minCut(n, from, to, cap, m, s, t) {
  // terminal capacity of every node: > 0 towards the source, < 0 towards the sink
  const tcap = new Float64Array(n);
  // arcs 2e and 2e+1 are the two directions of edge e (each other's reverse)
  const head = new Int32Array(n).fill(-1);
  const next = new Int32Array(2 * m);
  const arcTo = new Int32Array(2 * m);
  const res = new Float64Array(2 * m);
  let arcs = 0;
  for (let e = 0; e < m; e++) {
    const u = from[e], v = to[e];
    if (u === s || v === s) {
      tcap[u === s ? v : u] += cap[e];
      continue;
    }
    if (u === t || v === t) {
      tcap[u === t ? v : u] -= cap[e];
      continue;
    }
    arcTo[arcs] = v;
    res[arcs] = cap[e];
    next[arcs] = head[u];
    head[u] = arcs++;
    arcTo[arcs] = u;
    res[arcs] = cap[e];
    next[arcs] = head[v];
    head[v] = arcs++;
  }
  const side = boykovKolmogorov(n, head, next, arcTo, res, tcap);
  side[s] = 1;
  side[t] = 0;
  return side;
}

const FREE = 0, SRC = 1, SNK = 2;
const TERMINAL = -1, ORPHAN = -2, NONE = -3;

/**
 * Boykov-Kolmogorov max-flow on residual arrays (modified in place). For a node
 * in the source tree, parent[v] is the arc from its parent to v; in the sink
 * tree, the arc from v to its parent. Returns 1 for nodes on the source side of
 * the minimum cut.
 * @param {number} n
 * @param {Int32Array} head
 * @param {Int32Array} next
 * @param {Int32Array} arcTo
 * @param {Float64Array} res
 * @param {Float64Array} tcap
 * @returns {Uint8Array}
 */
function boykovKolmogorov(n, head, next, arcTo, res, tcap) {
  const EPS = 1e-12;
  const tree = new Uint8Array(n);
  const parent = new Int32Array(n).fill(NONE);
  const ts = new Int32Array(n); // time the distance below was valid
  const dist = new Int32Array(n); // steps to the terminal
  const active = new Int32Array(n); // FIFO ring of active nodes
  const inActive = new Uint8Array(n);
  let qHead = 0, qLen = 0;
  /** @param {number} v */
  const activate = (v) => {
    if (inActive[v]) return;
    inActive[v] = 1;
    active[(qHead + qLen) % n] = v;
    qLen++;
  };
  /** @type {number[]} */
  const orphans = [];
  let time = 1;
  for (let v = 0; v < n; v++) {
    if (tcap[v] > EPS) {
      tree[v] = SRC;
      parent[v] = TERMINAL;
      dist[v] = 1;
      ts[v] = time;
      activate(v);
    } else if (tcap[v] < -EPS) {
      tree[v] = SNK;
      parent[v] = TERMINAL;
      dist[v] = 1;
      ts[v] = time;
      activate(v);
    }
  }
  for (;;) {
    // --- growth: find an arc joining the two trees
    let bridge = -1; // arc from a source-tree node to a sink-tree node
    while (qLen && bridge < 0) {
      const v = active[qHead];
      if (tree[v] === FREE) {
        qHead = (qHead + 1) % n;
        qLen--;
        inActive[v] = 0;
        continue;
      }
      const tv = tree[v];
      for (let a = head[v]; a >= 0; a = next[a]) {
        const w = arcTo[a];
        // residual in the direction the flow would go
        const r = tv === SRC ? res[a] : res[a ^ 1];
        if (r <= EPS) continue;
        if (tree[w] === FREE) {
          tree[w] = tv;
          parent[w] = tv === SRC ? a : a ^ 1;
          ts[w] = ts[v];
          dist[w] = dist[v] + 1;
          activate(w);
        } else if (tree[w] !== tv) {
          bridge = tv === SRC ? a : a ^ 1;
          break;
        } else if (dist[w] > dist[v] + 1 && ts[w] <= ts[v]) {
          // keep paths short (heuristic from the paper)
          parent[w] = tv === SRC ? a : a ^ 1;
          ts[w] = ts[v];
          dist[w] = dist[v] + 1;
        }
      }
      if (bridge < 0) {
        qHead = (qHead + 1) % n;
        qLen--;
        inActive[v] = 0;
      }
    }
    if (bridge < 0) break;
    time++;
    // --- augmentation along source root ... a -> b ... sink root
    const a0 = arcTo[bridge ^ 1], b0 = arcTo[bridge];
    let push = res[bridge];
    for (let v = a0; parent[v] !== TERMINAL; v = arcTo[parent[v] ^ 1]) push = Math.min(push, res[parent[v]]);
    let rootS = a0;
    while (parent[rootS] !== TERMINAL) rootS = arcTo[parent[rootS] ^ 1];
    push = Math.min(push, tcap[rootS]);
    for (let v = b0; parent[v] !== TERMINAL; v = arcTo[parent[v]]) push = Math.min(push, res[parent[v]]);
    let rootT = b0;
    while (parent[rootT] !== TERMINAL) rootT = arcTo[parent[rootT]];
    push = Math.min(push, -tcap[rootT]);
    res[bridge] -= push;
    res[bridge ^ 1] += push;
    for (let v = a0; parent[v] !== TERMINAL; ) {
      const pa = parent[v];
      const u = arcTo[pa ^ 1];
      res[pa] -= push;
      res[pa ^ 1] += push;
      if (res[pa] <= EPS) {
        parent[v] = ORPHAN;
        orphans.push(v);
      }
      v = u;
    }
    tcap[rootS] -= push;
    if (tcap[rootS] <= EPS) {
      parent[rootS] = ORPHAN;
      orphans.push(rootS);
    }
    for (let v = b0; parent[v] !== TERMINAL; ) {
      const pa = parent[v];
      const u = arcTo[pa];
      res[pa] -= push;
      res[pa ^ 1] += push;
      if (res[pa] <= EPS) {
        parent[v] = ORPHAN;
        orphans.push(v);
      }
      v = u;
    }
    tcap[rootT] += push;
    if (tcap[rootT] >= -EPS) {
      parent[rootT] = ORPHAN;
      orphans.push(rootT);
    }
    // --- adoption: find new parents for orphans, or free them
    while (orphans.length) {
      const v = /** @type {number} */ (orphans.pop());
      const tv = tree[v];
      let bestArc = NONE, bestDist = Infinity;
      for (let a = head[v]; a >= 0; a = next[a]) {
        const w = arcTo[a];
        if (tree[w] !== tv) continue;
        // arc from w to v (source tree) or from v to w (sink tree) must have room
        const pa = tv === SRC ? a ^ 1 : a;
        if (res[pa] <= EPS) continue;
        // does w still reach a terminal? (count steps, stop at known nodes)
        let d = 0, u = w, ok = false;
        for (;;) {
          if (ts[u] === time) {
            d += dist[u];
            ok = true;
            break;
          }
          const pu = parent[u];
          d++;
          if (pu === TERMINAL) {
            ts[u] = time;
            dist[u] = 1;
            ok = true;
            break;
          }
          if (pu === ORPHAN || pu === NONE) break;
          u = tv === SRC ? arcTo[pu ^ 1] : arcTo[pu];
        }
        if (!ok) continue;
        if (d < bestDist) {
          bestDist = d;
          bestArc = pa;
        }
        // remember distances along the path just walked
        for (let x = w, dd = d; ts[x] !== time; ) {
          ts[x] = time;
          dist[x] = dd--;
          const px = parent[x];
          x = tv === SRC ? arcTo[px ^ 1] : arcTo[px];
        }
      }
      if (bestArc !== NONE) {
        parent[v] = bestArc;
        ts[v] = time;
        dist[v] = bestDist + 1;
        continue;
      }
      // no parent: v leaves its tree; its neighbours may grow into the gap
      for (let a = head[v]; a >= 0; a = next[a]) {
        const w = arcTo[a];
        if (tree[w] !== tv) continue;
        const pa = tv === SRC ? a ^ 1 : a;
        if (res[pa] > EPS) activate(w);
        const pw = parent[w];
        if (pw >= 0 && (tv === SRC ? arcTo[pw ^ 1] : arcTo[pw]) === v) {
          parent[w] = ORPHAN;
          orphans.push(w);
        }
      }
      tree[v] = FREE;
      parent[v] = NONE;
    }
  }
  const side = new Uint8Array(n);
  for (let v = 0; v < n; v++) if (tree[v] === SRC) side[v] = 1;
  return side;
}

/**
 * The top of the structure under `seed`: repeatedly step to the highest face
 * within `reach` mm (across any edge), so that wherever the mouse is on a
 * structure, the same top is found. Pieces lie flat on the plate, so
 * decorations face up.
 * @param {RegionGrower} grower
 * @param {number} seed
 * @param {number} reach
 * @returns {number}
 */
export function structureTop(grower, seed, reach) {
  let s = seed;
  for (let iter = 0; iter < 16; iter++) {
    let best = s;
    let bestZ = grower.centroid(s)[2];
    for (const f of grower.grow(s, { angle: 180, radius: reach })) {
      const z = grower.centroid(f)[2];
      if (z > bestZ + 1e-4) {
        bestZ = z;
        best = f;
      }
    }
    if (best === s) break;
    s = best;
  }
  return s;
}

/** faces within this fraction of the size of the centre are always inside */
const INNER = 0.4;
/** faces farther than this fraction of the size from the centre are outside */
const OUTER = 1.2;
/** how much cheaper a concave crease is to cut: weight exp(-SHARP * crease angle / angle setting) */
const SHARP = 3;
/** cuts nearer the centre are cheaper by (distance / outer) ^ PULL, so the loop hugs the structure */
const PULL = 0;
/** a cut whose average weight is above this runs over smooth surface, not along a crease */
const NO_CREASE = 0.25;

/**
 * The structure under `seed`: cut around the face under the mouse, then cut
 * again around the centre of what was found, until the centre stays put. The
 * face under the mouse is always part of the result, and wherever the mouse is
 * on a structure, the same centre (and so the same structure) is reached.
 * @param {RegionGrower} grower
 * @param {number} seed
 * @param {GrowParams} params angle: crease sensitivity (degrees); radius: size (mm)
 * @returns {number[]}
 */
export function cutStructure(grower, seed, params) {
  const R = params.radius;
  let center = grower.centroid(seed);
  // first with a small inside ball, so a mouse near the edge of a structure does
  // not pull in the surface next to it
  let cut = cutAround(grower, seed, center, params, 0.3);
  for (let iter = 0; iter < 4; iter++) {
    const c = cut.center;
    if (Math.hypot(c[0] - center[0], c[1] - center[1], c[2] - center[2]) < 0.05 * R) break;
    center = c;
    cut = cutAround(grower, seed, center, params);
  }
  return cut.region;
}

/**
 * The minimum cut around a centre point: faces within INNER x size of it (and
 * the seed face) are inside, faces farther than OUTER x size are outside.
 * @param {RegionGrower} grower
 * @param {number} seed
 * @param {[number, number, number]} center
 * @param {GrowParams} params
 * @param {number} [innerScale] shrinks the inside ball
 * @returns {{ region: number[]; center: [number, number, number] }}
 */
function cutAround(grower, seed, center, params, innerScale = 1) {
  const R = params.radius;
  const P = grower.positions, I = grower.indices, NB = grower.neighbors;
  const piece = grower.pieceOfFace[seed];
  const [tx, ty, tz] = center;
  const inner = INNER * R * innerScale, outer = OUTER * R;
  const angle = (Math.max(1, params.angle) * Math.PI) / 180;

  // neighbourhood: faces connected to the seed within `outer` of the centre
  const local = grower.localIndex();
  const [sx, sy, sz] = grower.centroid(seed);
  /** @type {number[]} */
  const faces = [seed];
  local[seed] = 0;
  const dist = [Math.hypot(sx - tx, sy - ty, sz - tz)];
  let open = false; // does the piece continue beyond the neighbourhood?
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    for (let k = 0; k < 3; k++) {
      const g = NB[f * 3 + k];
      if (g < 0 || local[g] >= 0 || grower.pieceOfFace[g] !== piece) continue;
      const [x, y, z] = grower.centroid(g);
      const d = Math.hypot(x - tx, y - ty, z - tz);
      if (d > outer) {
        open = true;
        continue;
      }
      local[g] = faces.length;
      faces.push(g);
      dist.push(d);
    }
  }
  const n = faces.length;
  // Outside: faces near the edge of the neighbourhood. When the whole piece fits
  // inside it, its farthest part is outside instead, so a large size on a small
  // piece still finds the structure rather than the whole piece.
  let maxDist = 0, minDist = Infinity;
  for (let i = 0; i < n; i++) {
    if (dist[i] > maxDist) maxDist = dist[i];
    if (dist[i] < minDist) minDist = dist[i];
  }
  const sinkDist = open ? 0.95 * outer : 0.8 * maxDist;
  // inside: the seed, and faces near the centre (the centre can lie inside a
  // rounded structure, so the inner ball reaches at least a little past the nearest face)
  const sourceDist = Math.max(inner, minDist + 0.25 * inner);

  const S = n, T = n + 1;
  const maxEdges = n * 2 + n;
  const from = new Int32Array(maxEdges), to = new Int32Array(maxEdges);
  const cap = new Float64Array(maxEdges);
  const edgeLen = new Float64Array(maxEdges);
  let m = 0;
  const nf = new Float64Array(6);
  const BIG = 1e9;
  for (let i = 0; i < n; i++) {
    const f = faces[i];
    let edge = false;
    grower.normal(f, nf, 0);
    for (let k = 0; k < 3; k++) {
      const g = NB[f * 3 + k];
      const j = g < 0 ? -1 : local[g];
      if (j < 0) {
        if (g >= 0 && grower.pieceOfFace[g] === piece) edge = true; // neighbourhood ends here
        continue;
      }
      if (j < i) continue; // each edge once
      const ea = I[f * 3 + k], eb = I[f * 3 + ((k + 1) % 3)];
      const len = Math.hypot(P[ea * 3] - P[eb * 3], P[ea * 3 + 1] - P[eb * 3 + 1], P[ea * 3 + 2] - P[eb * 3 + 2]);
      grower.normal(g, nf, 3);
      const cos = Math.max(-1, Math.min(1, nf[0] * nf[3] + nf[1] * nf[4] + nf[2] * nf[5]));
      let w = 1;
      if (cos < 0.9999) {
        // concave when g's far corner lies above f's plane: cheap to cut there
        let far = I[g * 3];
        if (far === ea || far === eb) far = I[g * 3 + 1];
        if (far === ea || far === eb) far = I[g * 3 + 2];
        const d = (P[far * 3] - P[ea * 3]) * nf[0] + (P[far * 3 + 1] - P[ea * 3 + 1]) * nf[1] + (P[far * 3 + 2] - P[ea * 3 + 2]) * nf[2];
        if (d > 0) w = Math.max(1e-4, Math.exp((-SHARP * Math.acos(cos)) / angle));
      }
      if (PULL) w *= Math.pow(Math.max(0.5 * (dist[i] + dist[j]), 0.25 * inner) / outer, PULL);
      from[m] = i;
      to[m] = j;
      cap[m] = len * w;
      edgeLen[m] = len;
      m++;
    }
    if (i === 0 || dist[i] <= sourceDist) {
      from[m] = S;
      to[m] = i;
      cap[m] = BIG;
      m++;
    } else if (edge || dist[i] > sinkDist) {
      from[m] = i;
      to[m] = T;
      cap[m] = BIG;
      m++;
    }
  }
  const side = minCut(n + 2, from, to, cap, m, S, T);
  // how crease-like is the cut? (average weight along it)
  let cost = 0, length = 0;
  for (let e = 0; e < m; e++) {
    if (from[e] >= n || to[e] >= n || side[from[e]] === side[to[e]]) continue;
    cost += cap[e];
    length += edgeLen[e];
  }
  // the whole piece fits and no crease separates anything: the piece is the structure
  const whole = !open && (length === 0 || cost / length > NO_CREASE);
  /** @type {number[]} */
  const region = [];
  let A = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    if (!whole && !side[i]) continue;
    const f = faces[i];
    region.push(f);
    const a3 = I[f * 3] * 3, b3 = I[f * 3 + 1] * 3, c3 = I[f * 3 + 2] * 3;
    const ux = P[b3] - P[a3], uy = P[b3 + 1] - P[a3 + 1], uz = P[b3 + 2] - P[a3 + 2];
    const vx = P[c3] - P[a3], vy = P[c3 + 1] - P[a3 + 1], vz = P[c3 + 2] - P[a3 + 2];
    const ar = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const [x, y, z] = grower.centroid(f);
    A += ar;
    cx += ar * x;
    cy += ar * y;
    cz += ar * z;
  }
  for (const f of faces) local[f] = -1;
  A = A || 1;
  return { region, center: [cx / A, cy / A, cz / A] };
}
