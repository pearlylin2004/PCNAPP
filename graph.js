// Turns the NParks paths (park connectors + paths inside parks) into a graph and finds
// routes that use them as much as possible.
//
// - Every point along a path is a node; consecutive points are joined by path edges.
// - Paths whose ends touch are joined automatically (points within ~5 m are merged).
// - Where a path dead-ends, it is joined to other paths nearby by "off-network" edges
//   (straight-line hops that the app later fills in with real road directions).
// - Off-network distance costs more than path distance (the "penalty"), so the cheapest
//   route sticks to park connectors unless leaving them saves a lot of distance.
// - When cycling, paths where cycling isn't allowed (e.g. stairs, some trails) are skipped.

const PCNGraph = (() => {
  const SNAP = 20000;          // 1/20000 degree ≈ 5.5 m: points closer than this become one node
  const CELL = 0.005;          // spatial index cell size in degrees (≈ 550 m)
  const GAP_RADIUS = 500;      // m: furthest off-network hop from a dead end
  const GAP_LINKS = 10;        // hops kept per dead end (to the closest other paths)
  const ACCESS_RADIUS = 2000;  // m: how far from the start / end we look for paths to join
  const ACCESS_LINKS = 30;     // ways onto the network kept for the start / end
  const MIN_LEG = 150;         // m: shorter path stretches are merged into their neighbours
  const CROSSING = 100;        // m: shorter off-network hops between two paths are just crossings
  const ROAD_DETOUR = 1.3;     // roads are typically this much longer than a straight line

  // Singapore is small and near the equator, so a flat approximation is accurate enough.
  const M_PER_DEG_LAT = 110574;
  const M_PER_DEG_LNG = 111320 * Math.cos(1.35 * Math.PI / 180);

  // Distance in metres between two [lng, lat] points.
  function distance(a, b) {
    return Math.hypot((a[0] - b[0]) * M_PER_DEG_LNG, (a[1] - b[1]) * M_PER_DEG_LAT);
  }

  const nodes = [];            // { pt: [lng, lat], line, name, pc }
  const adj = [];              // adj[node] = [{ to, d, info }]; info = the path's properties
  const keyToNode = new Map();
  const grid = new Map();      // "cx,cy" -> [node ids]
  const gapsByMode = {};       // mode -> Map(node -> [off-network edges])
  let built = false;

  const usable = (e, mode) => mode !== 'bike' || e.info.bike;
  const nodeUsable = (id, mode) => adj[id].some((e) => usable(e, mode));
  const cellOf = (pt) => [Math.floor(pt[0] / CELL), Math.floor(pt[1] / CELL)];

  function nodeAt(pt, line, info) {
    const key = `${Math.round(pt[0] * SNAP)},${Math.round(pt[1] * SNAP)}`;
    let id = keyToNode.get(key);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ pt, line, name: '', pc: false });
      adj.push([]);
      keyToNode.set(key, id);
      const cellKey = cellOf(pt).join(',');
      if (!grid.has(cellKey)) grid.set(cellKey, []);
      grid.get(cellKey).push(id);
    }
    nodes[id].name ||= info.name;
    nodes[id].pc ||= info.pc;
    return id;
  }

  function build(geojson) {
    geojson.features.forEach((f, line) => {
      const info = f.properties;
      let prev = null;
      for (const pt of f.geometry.coordinates) {
        const n = nodeAt(pt, line, info);
        if (prev !== null && prev !== n) {
          const d = distance(nodes[prev].pt, nodes[n].pt);
          adj[prev].push({ to: n, d, info });
          adj[n].push({ to: prev, d, info });
        }
        prev = n;
      }
    });
    built = true;
  }

  // The closest node on each path near `pt` (only nodes passing `accept`), nearest first.
  function nearby(pt, radius, accept, limit) {
    const span = Math.ceil(radius / (CELL * M_PER_DEG_LNG));
    const [cx, cy] = cellOf(pt);
    const best = new Map(); // line -> { id, d }
    for (let x = cx - span; x <= cx + span; x++) {
      for (let y = cy - span; y <= cy + span; y++) {
        for (const id of grid.get(`${x},${y}`) || []) {
          const d = distance(pt, nodes[id].pt);
          const line = nodes[id].line;
          if (d <= radius && d < (best.get(line)?.d ?? Infinity) && accept(id)) best.set(line, { id, d });
        }
      }
    }
    return [...best.values()].sort((a, b) => a.d - b.d).slice(0, limit);
  }

  function nearest(pt, accept) {
    let best = { id: -1, d: Infinity };
    nodes.forEach((n, id) => {
      const d = distance(pt, n.pt);
      if (d < best.d && accept(id)) best = { id, d };
    });
    return best;
  }

  // Minimal binary heap keyed on cost, for Dijkstra.
  class MinHeap {
    constructor() { this.items = []; }
    get size() { return this.items.length; }
    push(id, cost) {
      const a = this.items;
      a.push([id, cost]);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p][1] <= a[i][1]) break;
        [a[p], a[i]] = [a[i], a[p]];
        i = p;
      }
    }
    pop() {
      const a = this.items, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l][1] < a[m][1]) m = l;
          if (r < a.length && a[r][1] < a[m][1]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]];
          i = m;
        }
      }
      return top;
    }
  }

  // Nodes reachable from `start` along paths within `limit` metres.
  function reachable(start, limit, mode) {
    const seen = new Map([[start, 0]]);
    const heap = new MinHeap();
    heap.push(start, 0);
    while (heap.size) {
      const [u, c] = heap.pop();
      if (c > seen.get(u)) continue;
      for (const e of adj[u]) {
        const nc = c + e.d;
        if (usable(e, mode) && nc <= limit && nc < (seen.get(e.to) ?? Infinity)) {
          seen.set(e.to, nc);
          heap.push(e.to, nc);
        }
      }
    }
    return seen;
  }

  // Off-network hops from every dead end to nearby paths it isn't already well connected to.
  function gapEdges(mode) {
    if (gapsByMode[mode]) return gapsByMode[mode];
    const gaps = new Map();
    const add = (a, b, d) => {
      if (!gaps.has(a)) gaps.set(a, []);
      gaps.get(a).push({ to: b, d, info: null });
    };
    nodes.forEach((n, id) => {
      if (adj[id].filter((e) => usable(e, mode)).length !== 1) return;
      const close = reachable(id, GAP_RADIUS * 2, mode);
      const accept = (other) => !close.has(other) && nodeUsable(other, mode);
      for (const c of nearby(n.pt, GAP_RADIUS, accept, GAP_LINKS)) {
        add(id, c.id, c.d);
        add(c.id, id, c.d);
      }
    });
    return (gapsByMode[mode] = gaps);
  }

  // Where a start / end point can join the network.
  function accessLinks(pt, mode) {
    const accept = (id) => nodeUsable(id, mode);
    const links = nearby(pt, ACCESS_RADIUS, accept, ACCESS_LINKS);
    return links.length ? links : [nearest(pt, accept)];
  }

  // Group the route's individual edges into legs:
  //   { kind: 'path', name, pc, coords, dist }   follow a park connector / park path
  //   { kind: 'road', from, to }                 get between two points off the network
  function toLegs(steps) {
    // 1. One leg per stretch of the same path; unnamed bits (crossings etc.) join the stretch before.
    const legs = [];
    for (const s of steps) {
      const last = legs[legs.length - 1];
      if (!s.info) {
        if (last && last.kind === 'road') last.to = s.b;
        else legs.push({ kind: 'road', from: s.a, to: s.b });
      } else if (last && last.kind === 'path' && (!s.info.name || !last.name || s.info.name === last.name)) {
        last.coords.push(s.b);
        last.dist += s.d;
        last.name ||= s.info.name;
        last.pc ||= s.info.pc;
      } else {
        legs.push({ kind: 'path', name: s.info.name, pc: s.info.pc, coords: [s.a, s.b], dist: s.d });
      }
    }

    // 2–3 can create new tiny pieces, so repeat them until nothing changes.
    let current = legs;
    for (let count = -1; current.length !== count;) {
      count = current.length;
      current = mergeLegs(foldLegs(current));
    }
    return current;
  }

  // A short hop between two paths is a road crossing: keep it as part of the path.
  // A tiny path stretch with roads either side is the opposite: treat it as road.
  function foldLegs(legs) {
    const isRoad = (leg) => !leg || leg.kind === 'road';
    return legs.map((leg, i) => {
      const before = legs[i - 1], after = legs[i + 1];
      if (leg.kind === 'road' && !isRoad(before) && !isRoad(after) && distance(leg.from, leg.to) < CROSSING) {
        return { kind: 'path', name: '', pc: false, coords: [leg.from, leg.to], dist: distance(leg.from, leg.to) };
      }
      if (leg.kind === 'path' && leg.dist < MIN_LEG && isRoad(before) && isRoad(after)) {
        return { kind: 'road', from: leg.coords[0], to: leg.coords[leg.coords.length - 1] };
      }
      return leg;
    });
  }

  // Join neighbouring road legs, and neighbouring path legs when one is tiny, unnamed or they share a name.
  function mergeLegs(legs) {
    const merged = [];
    for (const leg of legs) {
      const last = merged[merged.length - 1];
      if (last && last.kind === 'road' && leg.kind === 'road') {
        last.to = leg.to;
      } else if (last && last.kind === 'path' && leg.kind === 'path' &&
                 (!leg.name || leg.dist < MIN_LEG || leg.name === last.name || last.dist < MIN_LEG)) {
        if (last.dist < MIN_LEG && leg.name) { // the bigger stretch names the combined leg
          last.name = leg.name;
          last.pc = leg.pc;
        }
        last.coords.push(...leg.coords.slice(1));
        last.dist += leg.dist;
      } else {
        merged.push(leg);
      }
    }
    return merged;
  }

  // Best route from `from` to `to` (both [lng, lat]) for `mode` ('bike' or 'foot').
  // `penalty` is how much more an off-network metre costs than a metre on a path.
  function route(from, to, penalty, mode) {
    if (!built) build(window.TRACKS_DATA);
    const gaps = gapEdges(mode);

    const N = nodes.length, START = N, END = N + 1;
    const startEdges = accessLinks(from, mode).map(({ id, d }) => ({ to: id, d, info: null }));
    startEdges.push({ to: END, d: distance(from, to), info: null }); // going directly is always an option
    const endLinks = new Map(accessLinks(to, mode).map(({ id, d }) => [id, d]));

    const pointOf = (i) => (i === START ? from : i === END ? to : nodes[i].pt);
    const edgesOf = (u) => {
      if (u === START) return startEdges;
      let edges = adj[u];
      if (gaps.has(u)) edges = edges.concat(gaps.get(u));
      if (endLinks.has(u)) edges = edges.concat({ to: END, d: endLinks.get(u), info: null });
      return edges;
    };

    const cost = new Float64Array(N + 2).fill(Infinity);
    const prev = new Array(N + 2);
    const heap = new MinHeap();
    cost[START] = 0;
    heap.push(START, 0);
    while (heap.size) {
      const [u, c] = heap.pop();
      if (c > cost[u]) continue;
      if (u === END) break;
      for (const e of edgesOf(u)) {
        if (e.info && !usable(e, mode)) continue;
        const nc = c + (e.info ? e.d : e.d * ROAD_DETOUR * penalty);
        if (nc < cost[e.to]) {
          cost[e.to] = nc;
          prev[e.to] = { from: u, e };
          heap.push(e.to, nc);
        }
      }
    }

    const steps = [];
    for (let v = END; v !== START; v = prev[v].from) {
      const { from: u, e } = prev[v];
      steps.push({ a: pointOf(u), b: pointOf(v), d: e.d, info: e.info });
    }
    return toLegs(steps.reverse());
  }

  // How far `pt` is from `line` (a list of [lng, lat]), and how far along the line
  // its closest point is: { d, at } in metres.
  function locateAlong(line, pt) {
    let best = { d: Infinity, at: 0 }, travelled = 0;
    for (let i = 1; i < line.length; i++) {
      // Work in metres relative to `pt`.
      const ax = (line[i - 1][0] - pt[0]) * M_PER_DEG_LNG, ay = (line[i - 1][1] - pt[1]) * M_PER_DEG_LAT;
      const bx = (line[i][0] - pt[0]) * M_PER_DEG_LNG, by = (line[i][1] - pt[1]) * M_PER_DEG_LAT;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (len * len))) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.d) best = { d, at: travelled + t * len };
      travelled += len;
    }
    return best;
  }

  // Closest park connector point to `pt`: { pt, d, name }.
  function nearestPCN(pt) {
    if (!built) build(window.TRACKS_DATA);
    const { id, d } = nearest(pt, (i) => nodes[i].pc);
    return { pt: nodes[id].pt, d, name: nodes[id].name };
  }

  return { route, nearestPCN, distance, locateAlong };
})();
