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
 * Minimum s-t cut of an undirected graph with real capacities (Dinic's algorithm).
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
  // arcs 2e and 2e+1 are the two directions of edge e (each other's reverse)
  const head = new Int32Array(n).fill(-1);
  const next = new Int32Array(2 * m);
  const arcTo = new Int32Array(2 * m);
  const res = new Float64Array(2 * m);
  for (let e = 0; e < m; e++) {
    arcTo[2 * e] = to[e];
    res[2 * e] = cap[e];
    next[2 * e] = head[from[e]];
    head[from[e]] = 2 * e;
    arcTo[2 * e + 1] = from[e];
    res[2 * e + 1] = cap[e];
    next[2 * e + 1] = head[to[e]];
    head[to[e]] = 2 * e + 1;
  }
  const EPS = 1e-12;
  const level = new Int32Array(n);
  const it = new Int32Array(n);
  const queue = new Int32Array(n);
  const pathArc = new Int32Array(n);
  const bfs = () => {
    level.fill(-1);
    level[s] = 0;
    let qh = 0, qt = 0;
    queue[qt++] = s;
    while (qh < qt) {
      const u = queue[qh++];
      for (let a = head[u]; a >= 0; a = next[a]) {
        const v = arcTo[a];
        if (res[a] > EPS && level[v] < 0) {
          level[v] = level[u] + 1;
          queue[qt++] = v;
        }
      }
    }
    return level[t] >= 0;
  };
  while (bfs()) {
    it.set(head);
    // blocking flow with an explicit stack (no recursion)
    for (;;) {
      let depth = 0;
      let u = s;
      let found = false;
      while (true) {
        if (u === t) {
          found = true;
          break;
        }
        let a = it[u];
        while (a >= 0 && !(res[a] > EPS && level[arcTo[a]] === level[u] + 1)) a = next[a];
        it[u] = a;
        if (a < 0) {
          // dead end: retreat
          if (depth === 0) break;
          level[u] = -1;
          depth--;
          const back = pathArc[depth];
          u = arcTo[back ^ 1];
          it[u] = next[it[u]];
          continue;
        }
        pathArc[depth++] = a;
        u = arcTo[a];
      }
      if (!found) break;
      let push = Infinity;
      for (let i = 0; i < depth; i++) push = Math.min(push, res[pathArc[i]]);
      for (let i = 0; i < depth; i++) {
        res[pathArc[i]] -= push;
        res[pathArc[i] ^ 1] += push;
      }
    }
  }
  // source side: reachable from s through arcs with capacity left
  const side = new Uint8Array(n);
  side[s] = 1;
  let qh = 0, qt = 0;
  queue[qt++] = s;
  while (qh < qt) {
    const u = queue[qh++];
    for (let a = head[u]; a >= 0; a = next[a]) {
      const v = arcTo[a];
      if (res[a] > EPS && !side[v]) {
        side[v] = 1;
        queue[qt++] = v;
      }
    }
  }
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

/** faces within this fraction of the size of the top are always inside */
const INNER = 0.4;
/** faces farther than this fraction of the size from the top are outside */
const OUTER = 1.2;
/** how much cheaper a concave crease is to cut: weight exp(-SHARP * crease angle / angle setting) */
const SHARP = 3;
/** a cut whose average weight is above this runs over smooth surface, not along a crease */
const NO_CREASE = 0.25;

/** how far (x size) the top of a structure is looked for from the mouse */
const CLIMB = 0.7;

/**
 * The structure under `seed`: climb to its top, then cut the neighbourhood of
 * the top along the cheapest closed loop that keeps the faces near the top
 * inside and the faces farther than OUTER x size outside. If the climb went over
 * to a taller structure away from the mouse (a rose beside big tail leaves), the
 * structure is taken from the nearest top instead.
 * @param {RegionGrower} grower
 * @param {number} seed
 * @param {GrowParams} params angle: crease sensitivity (degrees); radius: size (mm)
 * @returns {number[]}
 */
export function cutStructure(grower, seed, params) {
  const R = params.radius;
  const top = structureTop(grower, seed, CLIMB * R);
  const region = cutAt(grower, top, params);
  // keep it if it reaches the mouse (a leaf touching the rose still gives the rose)
  const [sx, sy, sz] = grower.centroid(seed);
  const reach2 = (0.3 * R) ** 2;
  for (const f of region) {
    const [x, y, z] = grower.centroid(f);
    if ((x - sx) ** 2 + (y - sy) ** 2 + (z - sz) ** 2 <= reach2) return region;
  }
  const near = structureTop(grower, seed, 0.25 * R);
  return near === top ? region : cutAt(grower, near, params);
}

/**
 * The minimum cut around a given top face.
 * @param {RegionGrower} grower
 * @param {number} top
 * @param {GrowParams} params
 * @returns {number[]}
 */
function cutAt(grower, top, params) {
  const R = params.radius;
  const P = grower.positions, I = grower.indices, NB = grower.neighbors;
  const piece = grower.pieceOfFace[top];
  const [tx, ty, tz] = grower.centroid(top);
  const inner = INNER * R, outer = OUTER * R;
  const angle = (Math.max(1, params.angle) * Math.PI) / 180;

  // neighbourhood: faces connected to the top within `outer` of it
  const local = grower.localIndex();
  /** @type {number[]} */
  const faces = [top];
  local[top] = 0;
  const dist = [0];
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
  let maxDist = 0;
  for (let i = 0; i < n; i++) if (dist[i] > maxDist) maxDist = dist[i];
  const sinkDist = open ? 0.95 * outer : 0.8 * maxDist;

  // inside: faces near the top, connected to it without leaving the inner ball
  const isSource = new Uint8Array(n);
  isSource[0] = 1;
  const stack = [0];
  while (stack.length) {
    const i = stack.pop();
    const f = faces[i];
    for (let k = 0; k < 3; k++) {
      const g = NB[f * 3 + k];
      if (g < 0) continue;
      const j = local[g];
      if (j < 0 || isSource[j] || dist[j] > inner) continue;
      isSource[j] = 1;
      stack.push(j);
    }
  }

  // graph: one node per face plus source S and sink T; face-face edges cost
  // edge length x crease weight
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
      from[m] = i;
      to[m] = j;
      cap[m] = len * w;
      edgeLen[m] = len;
      m++;
    }
    if (isSource[i]) {
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
  /** @type {number[]} */
  const out = [];
  // the whole piece fits and no crease separates anything: the piece is the structure
  const whole = !open && (length === 0 || cost / length > NO_CREASE);
  for (let i = 0; i < n; i++) if (whole || side[i]) out.push(faces[i]);
  for (const f of faces) local[f] = -1;
  return out;
}
