'use strict';
/* Ravages vector hex map — terrain from the datasheet, hand-drawn overlays, travel calculator. */

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1jC2kO_Hidhg4WoL-jBGw1lKKD5s6a1-xoqv1omTZR_k/gviz/tq?tqx=out:csv&gid=0';
const LS_KEY = 'rotmap_features_v1';
// Drawing is authoring, not viewing. The published map is something you read, so the Draw tools only
// exist when the app is served from your own machine — everything else works the same either way.
const LOCAL = location.protocol === 'file:' ||
  ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname) ||
  location.hostname.endsWith('.local');

const TERRAIN_COLORS = {
  Flatlands: '#7fae5a', Hills: '#ac9159', Mountains: '#8d8177',
  Ocean: '#5d8fc4', Sea: '#74a5d4', Lake: '#7fb7de', 'N/A': '#181d24',
};
// The hex grid's own line. A drawn coast wears exactly this, because a coast at subhex resolution is
// the same kind of thing as a hex boundary — the edge of a piece of ground — and should read as one.
const GRID = { stroke: '#0e1216', width: 0.7 };
const FSTYLE = {
  road:        { stroke: '#e0761f', width: 2.4 },
  river_major: { stroke: '#2f62c9', width: 3.2 },
  river_minor: { stroke: '#6b9cee', width: 1.7 },
  // Trade routes are road-grade infrastructure, so they wear the road's colour; the dotted dash is
  // what tells them apart from a road proper.
  trade:       { stroke: '#e0761f', width: 1.9, dash: '1.5,5' },
  coast:       { stroke: GRID.stroke, width: GRID.width },
};
// Each drawn feature type has its own layer (its own toggle). Order below is SVG z-order,
// first = bottom. Coast fills sit directly on top of the terrain — they are terrain, just at
// subhex resolution — but they are split across two groups so the rivers can slot between them:
// land subhex fills, then the tracing refs, then the rivers, then sea subhex fills, then the drawn
// coast lines. A river therefore draws over the land half of a split hex and passes *under* the
// open water, instead of being painted over wholesale. Both halves share the one "Coast fills"
// toggle via `linked`. Everything you draw outranks the reference scans you traced it from.
// PANEL_ORDER below decides the sidebar rows, since this interleaving no longer reads as a list.
// `types` lists the feature types rendered into that group; `linked` shares one toggle with a
// second group; `slave` groups are toggled by another layer and get no row of their own;
// `lazy` means the group is only populated the first time it is switched on.
const LAYERS = [
  { id: 'terrain',  name: 'Terrain',        def: 1 },
  { id: 'coast',    name: 'Coast fills',    def: 1, linked: 'coastSea' }, // land subhex fills (+ its sea half, below)
  // Who holds what, read off the borders scan. It colours land only, so it belongs directly on top of
  // the land fills — and below everything you draw, which then reads over it the way the sidebar
  // implies. It needs no place above the sea fills, since it never paints water.
  { id: 'borders',  name: 'Borders',        def: 0, lazy: renderBorders },
  // The thematic ref scans are underlays: over the terrain but under everything you draw, so your
  // own line always sits on top of the scan you traced it from. The Classic map is the exception —
  // see below.
  { id: 'refRivers',  name: 'Ref: rivers',  def: 0,   img: 'ref/rivers.png' },
  { id: 'refRoads',   name: 'Ref: roads',   def: 0,   img: 'ref/Roads.png' },
  { id: 'refNames',   name: 'Ref: names',   def: 0,   img: 'ref/Stronghold names.png' },
  { id: 'refCities',  name: 'Ref: cities/forts', def: 0, img: 'ref/citiestownsforts.png' },
  { id: 'refBorders', name: 'Ref: borders', def: 0,   img: 'ref/Borders_clean.png' },
  { id: 'sheetRivers', name: 'Sheet: river hexes', def: 0 },
  // Minor first, so a major river draws over the minor ones feeding into it rather than under them.
  { id: 'riverMinor', name: 'Rivers (minor)', def: 1, types: ['river_minor'] },
  { id: 'riverMajor', name: 'Rivers (major)', def: 1, types: ['river_major'] },
  { id: 'coastSea', slave: true, def: 1 },  // sea subhex fills — above the rivers, so a river runs
                                            // over the land half and disappears under open water
  // The Classic map sits above BOTH halves of the coast fills: it's the basemap you trace coastlines
  // from, and an opaque sea subhex painted over it hides the very shoreline you're following. Note
  // the consequence — since the sea fills are above the rivers, putting the scan above the fills
  // necessarily puts it above the drawn rivers too. Coast lines, roads, trade and strongholds stay
  // above it, so the coast you are drawing is still visible over the scan.
  // `keep`: this one is the map itself, not a tracing aid, so it ships with the published site too.
  { id: 'refClassic', name: 'Classic map',  def: 0,   img: 'ref/classic_map.png', keep: true },
  { id: 'coastLines', name: 'Coast lines',  def: 0.28, types: ['coast'] }, // drawn shore: reads as a grid line, so it defaults to the grid's opacity
  { id: 'iso',      name: 'Isochrone',      def: 0.55 },
  { id: 'grid',     name: 'Hex grid',       def: 0.28 },
  { id: 'hexIds',   name: 'Hex IDs',        def: 0, lazy: renderHexIds }, // 4,230 numbers; built on first use
  { id: 'roads',    name: 'Roads',          def: 1, types: ['road'] },
  { id: 'trade',    name: 'Trade routes',   def: 1, types: ['trade'] },
  { id: 'labels',   name: 'Strongholds',    def: 1 },
];
// Sidebar row order (ids only; slave layers have no row). Kept separate from the z-order above
// because the coast fills are split around the rivers, so one array can't express both. Coast
// fills/lines stay paired at the top, right under Terrain.
// The tracing refs sit next, because they're what you flick on and off against the coast you're
// drawing; the river/road/etc. layers you're producing come below them.
const PANEL_ORDER = ['terrain', 'coast', 'coastLines', 'borders',
                     'refClassic', 'refRivers', 'refRoads', 'refNames', 'refCities', 'refBorders',
                     'sheetRivers', 'riverMajor', 'riverMinor',
                     'iso', 'grid', 'hexIds', 'roads', 'trade', 'labels'];
// The tracing scans are for drawing against, not for reading, so they exist only when the app is
// served locally — dropped from the list rather than hidden, so the published site has no trace of
// them at all. The Classic map is exempt (`keep`): it is the map, not an aid to redrawing it.
// Borders is not one of these either: it reads its scan once, on demand, and paints land from it.
if (!LOCAL) for (let i = LAYERS.length - 1; i >= 0; i--) if (LAYERS[i].img && !LAYERS[i].keep) LAYERS.splice(i, 1);
// feature type -> id of the layer group its drawn line renders into
const TYPE_LAYER = { road: 'roads', river_major: 'riverMajor', river_minor: 'riverMinor',
                     trade: 'trade', coast: 'coastLines' };

const svg = document.getElementById('map');
const NS = 'http://www.w3.org/2000/svg';

const S = {
  mode: 'view', tool: 'road',
  G: null, hexes: null, names: { hexes: {}, floating: [] },
  features: { version: 1, features: [], labels: {}, strongholds: {} },
  drawing: null, undoStack: [],
  routes: [], activeRoute: -1,
  iso: { origin: null, data: null }, isoPick: false,
  coastPickFor: null,
  dragErase: null, needRecompute: false,
  vb: { x: 0, y: 0, w: 4401, h: 2037 },
  adj: null, // derived: {roads:Set, tradeByHex:Map, ferry:Set (road x major river), riverByHex:Map}
};

/* ---------------- geometry ---------------- */
let CORN = [], EDGE = [], SUB = []; // offsets from center: corners, edge mids, sub-centres
function initGeom() {
  const G = S.G;
  CORN.length = 0; EDGE.length = 0; SUB.length = 0; // idempotent
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    CORN.push([G.hex_size * Math.cos(a), G.hex_size * Math.sin(a)]);
  }
  for (let i = 0; i < 6; i++) {
    const c1 = CORN[i], c2 = CORN[(i + 1) % 6];
    EDGE.push([(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2]);
  }
  for (const p of CORN.concat(EDGE)) SUB.push([p[0] / 2, p[1] / 2]);
}
function hexRC(id) { const i = id - 1; return [Math.floor(i / S.G.cols), i % S.G.cols]; }
function hexId(r, c) { return (r < 0 || c < 0 || r >= S.G.rows || c >= S.G.cols) ? null : r * S.G.cols + c + 1; }
function hexCenter(id) {
  const [r, c] = hexRC(id);
  return [(r % 2 ? S.G.first_cx_odd : S.G.first_cx_even) + c * S.G.hex_width, S.G.first_cy + r * S.G.row_spacing];
}
function nearestHex(x, y) {
  const G = S.G;
  const r0 = Math.round((y - G.first_cy) / G.row_spacing);
  let best = null, bd = Infinity;
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    if (r < 0 || r >= G.rows) continue;
    const cx0 = r % 2 ? G.first_cx_odd : G.first_cx_even;
    const c0 = Math.round((x - cx0) / G.hex_width);
    for (let c = c0 - 1; c <= c0 + 1; c++) {
      const id = hexId(r, c);
      if (!id) continue;
      const [cx, cy] = hexCenter(id);
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
  }
  return best;
}
function neighbors(id) {
  const [r, c] = hexRC(id), odd = r % 2;
  const d = odd ? [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, 1]]
                : [[0, -1], [0, 1], [-1, -1], [-1, 0], [1, -1], [1, 0]];
  const out = [];
  for (const [dr, dc] of d) { const n = hexId(r + dr, c + dc); if (n) out.push(n); }
  return out;
}
const pairKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;

function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
// Where segments ab and cd meet. Only meaningful when segIntersect already said they do.
function segCrossPt(ax, ay, bx, by, cx, cy, dx, dy) {
  const r = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (!r) return [ax, ay];
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / r;
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
}
// The point on segment ab nearest p.
function closestOnSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/* ---------------- svg scaffolding ---------------- */
const groups = {};
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  (parent || svg).appendChild(e);
  return e;
}
function buildScaffold() {
  for (const L of LAYERS) {
    if (L.img) {
      // No href yet: a scan that is off — and they all start off — shouldn't be fetched at all. It
      // gets its source the first time the layer is switched on. See buildLayerUI.
      const g = el('g', { id: 'lyr_' + L.id });
      L._img = el('image', { x: 0, y: 0, width: S.G.image_width, height: S.G.image_height }, g);
      groups[L.id] = g;
    } else groups[L.id] = el('g', { id: 'lyr_' + L.id });
  }
  groups.route = el('g', { id: 'lyr_route' });
  groups.edit = el('g', { id: 'lyr_edit' });
  groups.hover = el('g', { id: 'lyr_hover' });
}
function applyViewBox() {
  svg.setAttribute('viewBox', `${S.vb.x} ${S.vb.y} ${S.vb.w} ${S.vb.h}`);
}

// The default viewBox is the whole map, which is half again as wide as it is tall. An SVG letterboxes
// a viewBox that doesn't match its box, so on a portrait phone the map arrives as a thin band across
// the middle of a mostly empty screen. On those screens the opening view is instead reshaped to the
// container's aspect ratio and zoomed until the map covers it. A mouse-driven window keeps the
// familiar whole-map view.
const FULL_VB = { ...S.vb };
const adaptiveView = () => matchMedia('(pointer: coarse), (max-width: 820px)').matches;

function coverView() {
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const a = r.width / r.height;
  const h = Math.min(FULL_VB.h, FULL_VB.w / a), w = h * a;
  S.vb = { x: FULL_VB.x + (FULL_VB.w - w) / 2, y: FULL_VB.y + (FULL_VB.h - h) / 2, w, h };
  applyViewBox();
}
// Rotating a phone swaps the aspect ratio. Reshape the viewBox to match, holding the centre and the
// visible area, so the view neither letterboxes nor jumps to a different part of the map.
function reshapeToAspect() {
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const a = r.width / r.height;
  const cx = S.vb.x + S.vb.w / 2, cy = S.vb.y + S.vb.h / 2;
  const h = Math.sqrt(S.vb.w * S.vb.h / a), w = h * a;
  S.vb = { x: cx - w / 2, y: cy - h / 2, w, h };
  applyViewBox();
}
let reshapeTimer = null;
addEventListener('resize', () => {
  if (!adaptiveView()) return;   // desktop keeps whatever the user had, letterboxing and all
  clearTimeout(reshapeTimer);
  reshapeTimer = setTimeout(reshapeToAspect, 150);
});
function toWorld(e) {
  const r = svg.getBoundingClientRect();
  const s = Math.min(r.width / S.vb.w, r.height / S.vb.h);
  const ox = (r.width - S.vb.w * s) / 2, oy = (r.height - S.vb.h * s) / 2;
  return [S.vb.x + (e.clientX - r.left - ox) / s, S.vb.y + (e.clientY - r.top - oy) / s, s];
}

/* ---------------- terrain / grid / labels ---------------- */
function hexPath(cx, cy) {
  let d = '';
  for (let i = 0; i < 6; i++)
    d += (i ? 'L' : 'M') + (cx + CORN[i][0]).toFixed(1) + ' ' + (cy + CORN[i][1]).toFixed(1);
  return d + 'Z';
}
function renderTerrain() {
  groups.terrain.innerHTML = ''; groups.grid.innerHTML = ''; groups.sheetRivers.innerHTML = '';
  const byT = {};
  let all = '', rivers = '';
  for (const idS in S.hexes) {
    const id = +idS, v = S.hexes[idS], t = v.t;
    const [cx, cy] = hexCenter(id);
    const p = hexPath(cx, cy);
    byT[t] = (byT[t] || '') + p;
    if (t !== 'N/A') all += p;
    if (v.r) rivers += p; // "River" flagged in the datasheet
  }
  for (const t in byT)
    el('path', { d: byT[t], fill: TERRAIN_COLORS[t] || '#666', stroke: 'none' }, groups.terrain);
  if (rivers) el('path', { d: rivers, fill: '#2f62c9', 'fill-opacity': 0.45, stroke: '#2f62c9', 'stroke-width': 1 }, groups.sheetRivers);
  el('path', { d: all, fill: 'none', stroke: GRID.stroke, 'stroke-width': GRID.width }, groups.grid);
  const hi = LAYERS.find(L => L.id === 'hexIds'); // keep IDs in sync after a sheet refetch
  if (hi?._built) renderHexIds();
}
// Hex ID numbers at every hex centre — the same id the tooltip shows, but readable without
// hovering. 4,230 <text> nodes is enough to notice, so this is a `lazy` layer: buildLayerUI only
// calls it the first time the toggle is switched on, and thereafter the group is just hidden.
// Sits above the grid and below roads/strongholds so a stronghold marker never hides its number.
// Colour each piece of land by whoever holds it, read straight off the borders scan: sample the
// region's own interior point and whichever of the hex's thirteen grid points fall inside it, and
// take the colour most of them agree on. The scan is flat colour per realm with everything unclaimed
// left transparent, so this is a reading rather than an interpretation. A *subhex* is the unit, not a
// hex: two pieces of land in one hex, either side of a strait or a river, need not be held by the
// same realm and are asked separately. Lazy — nothing is fetched until the layer is switched on.
// Painted opaque; the layer's own opacity slider is there if you want terrain showing through.
async function renderBorders() {
  const img = new Image();
  img.src = 'ref/Borders_clean.png';
  try { await img.decode(); } catch { return; }
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  try { borderScan = { d: ctx.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height }; }
  catch { return; } // tainted, which happens on file://
  paintBorders();
}
// The scan is decoded once and kept; everything below is cheap enough to redo whenever the land
// changes shape, which it does every time a coastline is drawn — and region indices shift with it,
// so nothing here may be cached against them.
let borderScan = null;
function paintBorders() {
  const g = groups.borders;
  if (!g || !borderScan) return;
  g.innerHTML = '';
  if (!S.adj) deriveAdj();
  const { d: data, w, h: hh } = borderScan;
  const sx = w / S.G.image_width, sy = hh / S.G.image_height;
  // The scan's realm colours are semi-transparent washes. Composite each onto white here, so what
  // gets painted is the solid colour the wash reads as and the land can be filled opaquely.
  const at = (x, y) => {
    const px = Math.round(x * sx), py = Math.round(y * sy);
    if (px < 0 || py < 0 || px >= w || py >= hh) return null;
    const i = (py * w + px) * 4, a = data[i + 3] / 255;
    if (a < 40 / 255) return null; // unclaimed ground is left transparent in the scan
    if (data[i] === 0x56 && data[i + 1] === 0x56 && data[i + 2] === 0x56) return null; // the border line itself
    const over = k => Math.round(data[i + k] * a + 255 * (1 - a));
    return `${over(0)},${over(1)},${over(2)}`;
  };
  const inRegion = (r, p) => !r.poly || pointInPoly(p, r.poly) || (r.extra || []).some(x => pointInPoly(p, x));
  const cols = new Map(); // "hex:region" -> "r,g,b"
  for (const idS in S.hexes) {
    const hx = +idS;
    if (S.hexes[idS].t === 'N/A') continue;
    const [cx, cy] = hexCenter(hx), rs = regionsOf(hx);
    for (let ri = 0; ri < rs.length; ri++) {
      const r = rs[ri];
      if (r.sea) continue; // water holds no realm
      const pts = [];
      for (const [ox, oy] of [[0, 0], ...SUB]) {
        const p = [cx + ox, cy + oy];
        if (inRegion(r, p)) pts.push(p);
      }
      // A subhex is often smaller than the gaps between those points — a spit catches none of them —
      // so it always votes from its own interior point too, which guarantees every piece a say.
      if (r.cent) pts.push(r.cent);
      const votes = new Map();
      for (const p of pts) { const c = at(p[0], p[1]); if (c) votes.set(c, (votes.get(c) || 0) + 1); }
      let best = null, bn = 0;
      for (const [c, n] of votes) if (n > bn) { bn = n; best = c; }
      if (best) cols.set(hx + ':' + ri, best);
    }
  }
  // Land the scan doesn't speak for. Its washes stop at the coastline *it* was drawn with, so a spit
  // or headland that your own coast puts further out falls outside every wash and comes back blank.
  // Such a piece takes the realm of the land it adjoins — land it could be walked to, by the same
  // region adjacency the marching rules use, not merely land in a neighbouring hex, since a spit
  // faces plenty of hexes across water and taking a realm from one of those strands a piece of it
  // out at sea. Collected before being applied, so nothing inherits from an inheritance and creeps
  // inland a ring at a time, and land with no claimed neighbour simply stays unclaimed.
  const inherited = new Map();
  for (const [hx, cells] of S.adj.sub) {
    const rs = cells.regions;
    for (let ri = 0; ri < rs.length; ri++) {
      if (rs[ri].sea || cols.has(hx + ':' + ri)) continue;
      const votes = new Map();
      for (const n of neighbors(hx)) {
        if (!S.hexes[n] || S.hexes[n].t === 'N/A') continue;
        const nrs = regionsOf(n);
        for (let rj = 0; rj < nrs.length; rj++) {
          const c = cols.get(n + ':' + rj);
          if (c && !nrs[rj].sea && regionsMeet(hx, ri, n, rj)) votes.set(c, (votes.get(c) || 0) + 1);
        }
      }
      let best = null, bn = 0;
      for (const [c, n] of votes) if (n > bn) { bn = n; best = c; }
      if (best) inherited.set(hx + ':' + ri, best);
    }
  }
  for (const [k, c] of inherited) cols.set(k, c);
  const shape = (hx, r) => {
    if (!r.poly) { const [cx, cy] = hexCenter(hx); return hexPath(cx, cy); }
    return [r.poly, ...(r.extra || [])].filter(p => p && p.length >= 3)
      .map(p => p.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('') + 'Z').join('');
  };
  const byColour = new Map();
  for (const [key, c] of cols) {
    const [hs, ris] = key.split(':'), r = regionsOf(+hs)[+ris];
    if (r) byColour.set(c, (byColour.get(c) || '') + shape(+hs, r));
  }
  for (const [c, d] of byColour) // one path per realm, so 4,000 hexes cost a couple of dozen nodes
    el('path', { d, fill: `rgb(${c})`, 'fill-rule': 'evenodd', stroke: 'none' }, g);
}
function renderHexIds() {
  groups.hexIds.innerHTML = '';
  for (const idS in S.hexes) {
    if (S.hexes[idS].t === 'N/A') continue; // off-map filler hexes
    const [cx, cy] = hexCenter(+idS);
    el('text', {
      x: cx, y: cy + 3.6, 'text-anchor': 'middle', 'font-size': 9, fill: '#fff',
      stroke: '#14181e', 'stroke-width': 2, 'paint-order': 'stroke',
      'font-family': 'system-ui,sans-serif', 'pointer-events': 'none',
    }, groups.hexIds).textContent = idS;
  }
}
function renderLabels() {
  groups.labels.innerHTML = '';
  const done = new Set();
  const put = (id, name) => {
    const sh = S.features.strongholds[id];
    const [cx, cy] = (sh && sh.x != null) ? [sh.x, sh.y] : hexCenter(+id);
    const port = (S.hexes[id]?.s || sh) && isPort(+id);
    el('circle', { cx, cy, r: 3.4, fill: '#fff', stroke: port ? '#2f86c9' : '#14181e',
                   'stroke-width': port ? 1.7 : 1.2 }, groups.labels);
    if (name) el('text', {
      x: cx, y: cy - 6.5, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#fff',
      stroke: '#14181e', 'stroke-width': 2.4, 'paint-order': 'stroke', 'font-family': 'system-ui,sans-serif',
    }, groups.labels).textContent = name;
  };
  for (const id in S.features.labels) {
    if (S.features.strongholds[id]?.removed) continue; // labelled but removed → show nothing
    put(id, S.features.labels[id]); done.add(id);
  }
  for (const id in S.hexes) {
    if (!S.hexes[id].s || done.has(id) || S.features.strongholds[id]?.removed) continue;
    put(id, S.names.hexes[id] || ''); done.add(id);
  }
  for (const id in S.features.strongholds) {
    if (done.has(id) || S.features.strongholds[id].removed) continue;
    put(id, S.names.hexes[id] || '');
  }
  // Floating OCR labels (S.names.floating) are not rendered — they were mis-OCR'd stray text, not
  // real strongholds. Use the Label tool to name a hex if a genuine label is needed.
}

/* ---------------- coasts (split hexes into land/sea parts) ---------------- */
function refineBoundary(ox, oy, ix, iy, h) { // point on hex boundary between outside (o) and inside (i)
  for (let k = 0; k < 20; k++) {
    const mx = (ox + ix) / 2, my = (oy + iy) / 2;
    if (nearestHex(mx, my) === h) { ix = mx; iy = my; } else { ox = mx; oy = my; }
  }
  return [(ox + ix) / 2, (oy + iy) / 2];
}
function coastColors(h) {
  const tSelf = S.hexes[h].t;
  let seaC = RULES.WATER.has(tSelf) ? TERRAIN_COLORS[tSelf] : null;
  let landC = (!RULES.WATER.has(tSelf) && tSelf !== 'N/A') ? TERRAIN_COLORS[tSelf] : null;
  for (const n of neighbors(h)) {
    const t = S.hexes[n].t;
    if (!seaC && RULES.WATER.has(t)) seaC = TERRAIN_COLORS[t];
    if (!landC && !RULES.WATER.has(t) && t !== 'N/A') landC = TERRAIN_COLORS[t];
  }
  return { seaC: seaC || TERRAIN_COLORS.Sea, landC: landC || TERRAIN_COLORS.Flatlands };
}
// Gather coast lines per hex, then flood-fill each into sea/land region polygons.
function coastSubcells() {
  const byHex = new Map();
  forEachHexSplit((h, chain, seaPt, kind) => {
    if (!byHex.has(h)) byHex.set(h, { chains: [], seaPts: [], kinds: [] });
    // seaPts is kept in step with chains — null where a chain has none — so a coast chain can be
    // asked which of its sides is the water.
    const e = byHex.get(h); e.chains.push(chain); e.kinds.push(kind); e.seaPts.push(seaPt || null);
  });
  const out = new Map();
  for (const [h, e] of byHex) {
    const cells = hexSubcells(h, e.chains, e.seaPts, e.kinds);
    // Say so rather than corrupt the search: region indices are packed into a fixed-width field, so
    // a hex carved into more pieces than that would address would alias onto another hex entirely.
    if (cells.regions.length > MAX_REGIONS)
      console.warn(`hex ${h}: ${cells.regions.length} regions, only ${MAX_REGIONS} are addressable`);
    out.set(h, cells);
  }
  return out;
}
function renderCoasts() {
  groups.coast.innerHTML = ''; groups.coastSea.innerHTML = '';
  const sub = coastSubcells(); // fresh (features may have changed since last deriveAdj)
  for (const [h, cells] of sub) {
    const tSelf = S.hexes[h].t;
    if (tSelf === 'N/A') continue;
    const { seaC, landC } = coastColors(h);
    // One path per region, holes and all. A region traced by the flood fill can come back as
    // several loops — a disjoint second piece, or a loop *around* another region, which is what
    // an island wholly inside the hex looks like from the water's point of view. Emitting them as
    // subpaths of a single `fill-rule: evenodd` path fills the disjoint pieces and punches out the
    // holes, so the sea can no longer paint straight over an island it encloses.
    const paint = (r, fill, bleed, g) => {
      const loops = [r.poly, ...(r.extra || [])].filter(p => p && p.length >= 3);
      if (!loops.length) return;
      const d = loops.map(poly => poly.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('') + 'Z').join('');
      el('path', { d, fill, 'fill-rule': 'evenodd',
                   ...(bleed ? { stroke: fill, 'stroke-width': 1.2, 'stroke-linejoin': 'round' } : { stroke: 'none' }) }, g);
    };
    // Paint BOTH subregions so the whole split hex is covered by fills that tile exactly along the
    // coast — no reliance on the base terrain showing through (which left slivers where fills didn't
    // perfectly meet). Land goes in the lower group and sea in the upper one, with the river layers
    // sandwiched between: a river drawn across the land half stays visible, and where it runs into
    // open water the sea fill covers it. Because sea now always paints last, it is always the half
    // that bleeds ~½px to swallow the anti-aliasing seam — that's the safe direction anyway, since
    // bleeding land outward would smear green over blue.
    for (const r of cells.regions) {
      if (r.sea) paint(r, seaC, true, groups.coastSea);
      else paint(r, landC, false, groups.coast);
    }
  }
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) &&
        (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// Compute the sea/land polygons a coast chain carves out of hex h. Pure (no drawing).
function computeSplit(h, chain, seaLeft, seaPt) {
  const [cx, cy] = hexCenter(h);
  const corners = CORN.map(o => [cx + o[0], cy + o[1]]);
  const edgeOf = p => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6;
      const d = distToSeg(p[0], p[1], corners[i][0], corners[i][1], corners[j][0], corners[j][1]);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const E = chain[0], X = chain[chain.length - 1];
  const eE = edgeOf(E), eX = edgeOf(X);
  const d2 = (p, c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
  const EafterX = eE === eX && d2(E, corners[eE]) > d2(X, corners[eX]);
  const walk = (je, ke, none) => { // boundary corners from a point on edge je forward to edge ke
    if (je === ke && none) return [];
    const out = []; let j = (je + 1) % 6;
    while (true) { out.push(corners[j]); if (j === ke) break; j = (j + 1) % 6; }
    return out;
  };
  const polyA = chain.concat(walk(eX, eE, EafterX));                    // E..X + boundary back to E
  const polyB = [...chain].reverse().concat(walk(eE, eX, eE === eX && !EafterX));
  // which side is visually left of the drawing direction? (sea-on-left convention)
  const mi = chain.length >> 1;
  const m = chain[Math.max(0, mi - 1)], m2 = chain[Math.min(chain.length - 1, mi + 1)];
  const dir = [m2[0] - m[0], m2[1] - m[1]];
  const cent = poly => poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
  const cA = cent(polyA);
  let aIsSea;
  // Prefer the actual clicked sea point (robust for bent coastlines): whichever half contains it is sea.
  if (seaPt && nearestHex(seaPt[0], seaPt[1]) === h) {
    const inA = pointInPoly(seaPt, polyA), inB = pointInPoly(seaPt, polyB);
    if (inA !== inB) aIsSea = inA;
    else { const cB = cent(polyB); aIsSea = d2(seaPt, cA) <= d2(seaPt, cB); } // ambiguous → nearer centroid
  } else {
    // legacy fallback: side of the drawing direction (polyA is left when crossA < 0)
    const crossA = dir[0] * (cA[1] - m[1]) - dir[1] * (cA[0] - m[0]);
    aIsSea = (crossA < 0) === seaLeft;
  }
  const seaPoly = aIsSea ? polyA : polyB, landPoly = aIsSea ? polyB : polyA;
  return { seaPoly, landPoly };
}
// How far a point is from the boundary of hex h.
function distToHexEdge(h, p) {
  const [cx, cy] = hexCenter(h), c = CORN.map(o => [cx + o[0], cy + o[1]]);
  let d = Infinity;
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    d = Math.min(d, distToSeg(p[0], p[1], c[i][0], c[i][1], c[j][0], c[j][1]));
  }
  return d;
}
// Cut a drawn polyline into one chain per hex it runs through, each clipped to that hex's boundary.
// `open` says the line has a loose end inside this hex — it stops there rather than crossing out the
// far side — which means it doesn't divide the hex at all: you can walk round the end of it.
function forEachHexChain(pts0, cb) {
  const pts = [];
  for (let i = 0; i + 1 < pts0.length; i++) {
    const [ax, ay] = pts0[i], [bx, by] = pts0[i + 1];
    const len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / 2));
    for (let k = (i === 0 ? 0 : 1); k <= n; k++) pts.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  const hs = pts.map(p => nearestHex(p[0], p[1]));
  const runs = {};
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i]; if (!h) continue;
    if (!runs[h] || runs[h].i1 === i - 1) {
      if (runs[h] && runs[h].i1 === i - 1) runs[h].i1 = i;
      else if (!runs[h] || (i - runs[h].i0) > (runs[h].i1 - runs[h].i0)) runs[h] = { i0: i, i1: i };
    }
  }
  for (const h in runs) {
    const { i0, i1 } = runs[h];
    const E = i0 > 0 ? refineBoundary(pts[i0 - 1][0], pts[i0 - 1][1], pts[i0][0], pts[i0][1], +h) : pts[i0];
    const X = i1 < hs.length - 1 ? refineBoundary(pts[i1 + 1][0], pts[i1 + 1][1], pts[i1][0], pts[i1][1], +h) : pts[i1];
    const chain = [E, ...pts.slice(i0, i1 + 1), X];
    if (chain.length >= 2) cb(+h, chain);
  }
}
// Run cb(hex, chain, seaPt, kind) for every per-hex barrier segment. Two kinds of line cut a hex up.
// A coast separates land from water. A drawn *major* river separates land from land: it can't be
// forded anywhere, so the two banks are as good as different places even inside a single hex, and
// the only way between them is a bridge. Both are handed to the same splitter.
function forEachHexSplit(cb) {
  for (const f of S.features.features) {
    if (f.type === 'river_major') {
      // Where a polyline stops is not where the river stops: a long river is drawn as several lines
      // laid end to end, and a join lands somewhere inside a hex like any other end would. So an end
      // only counts as the river petering out if no *other* major river takes up where it left off.
      forEachHexChain(f.pts, (h, chain) => cb(h, chain, null, 'river'));
      continue;
    }
    if (f.type !== 'coast') continue;
    // sea point: explicit click, else derive from the seaLeft half's centroid (legacy)
    const seaPtFor = (h, chain) => {
      if (f.seaPt && nearestHex(f.seaPt[0], f.seaPt[1]) === h) return f.seaPt;
      if (isClosedRing(chain)) return null; // a ring has no left/right — wait for the sea click
      const s = computeSplit(h, chain, f.seaLeft !== false, null);
      return polyCentroid(s.seaPoly);
    };
    if (f.hex != null) {
      if (f.pts.length >= 2) cb(f.hex, f.pts, seaPtFor(f.hex, f.pts), 'coast');
      continue;
    }
    forEachHexChain(f.pts, (h, chain) => cb(h, chain, seaPtFor(h, chain), 'coast'));
  }
}
// A coast that ends where it started: an island (or an inner lake) wholly inside one hex. It has
// no two ends on the hex boundary, so it can't be split the two-way vector way — flood fill has
// to find the inside and the outside for it.
const isClosedRing = ch => ch.length >= 4 &&
  Math.abs(ch[0][0] - ch[ch.length - 1][0]) < 0.5 && Math.abs(ch[0][1] - ch[ch.length - 1][1]) < 0.5;
// Split a hex crossed by a coast and/or a major river into regions.
function hexSubcells(h, chains, seaPts, kinds) {
  // A river drawn stopping a little short of what it flows into — the coast at its mouth, another
  // river it joins — is meant to reach it, and freehand lines routinely fall a few pixels short.
  // Extend it to the nearest point on that line, so the split sees a barrier that meets the water
  // instead of a gap an army could file through.
  const SNAP = S.G.hex_size * 0.4;
  // Which side of a chain a point lies on, by its nearest segment. Used to tell a river that stops
  // short of the water from one that has already reached it.
  const sideOf = (c, p) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i + 1 < c.length; i++) {
      const d = distToSeg(p[0], p[1], c[i][0], c[i][1], c[i + 1][0], c[i + 1][1]);
      if (d < bd) { bd = d; bi = i; }
    }
    const a = c[bi], b = c[bi + 1];
    return Math.sign((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
  };
  const reachOut = (p, ci) => {
    if (distToHexEdge(h, p) <= 2) return null; // already anchored where it leaves the hex
    let best = null, bd = SNAP;
    for (let k = 0; k < chains.length; k++) {
      if (k === ci) continue;
      const c = chains[k];
      // A river that ends *in* the water has arrived; dragging it to the nearest shore would draw a
      // line across the lake and cut it in two. Only a river still on land is reaching for anything.
      if (seaPts[k] && sideOf(c, p) === sideOf(c, seaPts[k])) return null;
      for (let i = 0; i + 1 < c.length; i++) {
        const q = closestOnSeg(p, c[i], c[i + 1]), d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d <= 2) return null;               // already touching it
        if (d < bd) { bd = d; best = q; }
      }
    }
    return best;
  };
  chains = chains.map((c, ci) => {
    if (kinds[ci] !== 'river') return c;
    const a = reachOut(c[0], ci), b = reachOut(c[c.length - 1], ci);
    return a || b ? [...(a ? [a] : []), ...c, ...(b ? [b] : [])] : c;
  });
  // Common case — one line running clean through the hex: exact vector two-way split, which follows
  // the line precisely. It assumes the chain runs boundary to boundary, so a line that stops short
  // inside the hex must not use it: it would invent a split where you can simply walk round the end,
  // and leave the two halves failing to tile the hex. Those, and closed rings, fall through to the
  // flood fill, which separates only where the wall actually blocks and so answers that honestly.
  const spansHex = c => distToHexEdge(h, c[0]) <= 2 && distToHexEdge(h, c[c.length - 1]) <= 2;
  if (chains.length === 1 && !isClosedRing(chains[0]) && spansHex(chains[0])) {
    const river = kinds[0] === 'river';
    const sp = (!river && seaPts[0] && nearestHex(seaPts[0][0], seaPts[0][1]) === h) ? seaPts[0] : null;
    const { seaPoly: A, landPoly: B } = computeSplit(h, chains[0], true, sp);
    const mk = (poly, sea) => ({ sea, poly, cent: insidePoint(poly), extra: [] });
    // A river splits like from like — both halves are whatever the hex already was — and the pair is
    // recorded so movement knows the two are separated by something only a bridge crosses.
    if (river) {
      const wet = baseSea(h);
      return { regions: [mk(A, wet), mk(B, wet)], adj: [[0, 1]], riverPairs: [[0, 1]],
               seaPolys: wet ? [A, B] : [], landPolys: wet ? [] : [A, B] };
    }
    return { regions: [mk(A, true), mk(B, false)], adj: [[0, 1]], riverPairs: [],
             seaPolys: [A], landPolys: [B] };
  }
  return hexSubcellsFlood(h, chains, seaPts, kinds); // several lines / enclosed seas / islands
}
// Flood-fill fallback for hexes crossed by several coasts (enclosed inner seas, straits): coast
// lines are barriers, a region is SEA iff it contains a marked sea point.
function hexSubcellsFlood(h, chains, seaPts, kinds = []) {
  const [cx, cy] = hexCenter(h), size = S.G.hex_size;
  // The grid has to resolve the drawn line, not merely find which side of it you are on: at R = 30 a
  // cell was ~2px, so the traced outline came back as a visible staircase and everything downstream
  // was working to undo it. Sub-pixel cells leave the trace within a cell of the line to begin with.
  // (Much finer than this and the wall band stops being a reliable barrier, so regions start leaking
  // into each other — measured against the drawn lines, quality collapses again somewhere past 128.)
  const R = 96, x0 = cx - size * 1.06, y0 = cy - size * 1.06, cell = size * 2.12 / R;
  const hexPoly = CORN.map(o => [cx + o[0], cy + o[1]]);
  const inside = new Uint8Array(R * R), wall = new Uint8Array(R * R), wallRiver = new Uint8Array(R * R);
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++)
    if (pointInPoly([x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell], hexPoly)) inside[j * R + i] = 1;
  chains.forEach((chain, ci) => { for (let s = 0; s + 1 < chain.length; s++) {
    const [ax, ay] = chain[s], [bx, by] = chain[s + 1], len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / (cell * 0.4)));
    for (let k = 0; k <= n; k++) {
      const i = Math.floor((ax + (bx - ax) * k / n - x0) / cell), j = Math.floor((ay + (by - ay) * k / n - y0) / cell);
      if (i >= 0 && i < R && j >= 0 && j < R) { wall[j * R + i] = 1; if (kinds[ci] === 'river') wallRiver[j * R + i] = 1; }
    }
  } });
  const reg = new Int16Array(R * R).fill(-1); let nreg = 0;
  for (let start = 0; start < R * R; start++) {
    if (!inside[start] || wall[start] || reg[start] >= 0) continue;
    reg[start] = nreg; const st = [start];
    while (st.length) { const c = st.pop(), ci = c % R, cj = (c / R) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj; if (ni < 0 || ni >= R || nj < 0 || nj >= R) continue;
        const nc = nj * R + ni; if (inside[nc] && !wall[nc] && reg[nc] < 0) { reg[nc] = nreg; st.push(nc); }
      }
    }
    nreg++;
  }
  // Which pairs of regions face each other across the *river* wall specifically. Read now, while the
  // wall cells are still unclaimed, because the dilation below hands them out to their neighbours.
  const riverPairSet = new Set();
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    const c = j * R + i; if (!wallRiver[c] || !inside[c]) continue;
    const seen = [];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj; if (ni < 0 || ni >= R || nj < 0 || nj >= R) continue;
      const r = reg[nj * R + ni]; if (r >= 0 && !seen.includes(r)) seen.push(r);
    }
    for (let a = 0; a < seen.length; a++) for (let b = a + 1; b < seen.length; b++)
      riverPairSet.add(Math.min(seen[a], seen[b]) + '-' + Math.max(seen[a], seen[b]));
  }
  // dilate regions once into the wall band (snapping later closes the rest without eroding features)
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    const c = j * R + i; if (reg[c] >= 0 || !inside[c]) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj; if (ni < 0 || ni >= R || nj < 0 || nj >= R) continue;
      if (reg[nj * R + ni] >= 0) { reg[c] = -2 - reg[nj * R + ni]; break; } // temp mark
    }
  }
  for (let c = 0; c < R * R; c++) if (reg[c] <= -2) reg[c] = -2 - reg[c]; // commit, once, after the pass
  const seaReg = new Set();
  for (const sp of seaPts) {
    if (!sp) continue; // chains without a sea side (rivers, unclicked coasts) say nothing here
    let i = Math.floor((sp[0] - x0) / cell), j = Math.floor((sp[1] - y0) / cell);
    i = Math.max(0, Math.min(R - 1, i)); j = Math.max(0, Math.min(R - 1, j));
    let r = reg[j * R + i];
    if (r < 0) for (let rad = 1; rad < 6 && r < 0; rad++) for (let dj = -rad; dj <= rad && r < 0; dj++) for (let di = -rad; di <= rad; di++) {
      const ni = i + di, nj = j + dj; if (ni >= 0 && ni < R && nj >= 0 && nj < R && reg[nj * R + ni] >= 0) { r = reg[nj * R + ni]; break; }
    }
    if (r >= 0) seaReg.add(r);
  }
  // lines a region boundary should hug: the drawn coast segments and the six hex edges
  const corners = CORN.map(o => [cx + o[0], cy + o[1]]);
  const snapLines = [];
  for (let i = 0; i < 6; i++) snapLines.push([corners[i], corners[(i + 1) % 6]]);
  for (const ch of chains) for (let s = 0; s + 1 < ch.length; s++) snapLines.push([ch[s], ch[s + 1]]);
  // Simplify only what is genuinely collinear. simplifyClosed re-runs until nothing more drops, so
  // its tolerance compounds: at 0.4 a boundary could walk right off the coast one vertex at a time,
  // which is what left fills sitting several pixels inside the drawn line with a sliver of the other
  // half showing through. Dropping the tolerance to a hair costs ~600 vertices map-wide and fixes it.
  const smooth = poly => simplifyClosed(poly.map(p => snapToLines(p, snapLines, cell * 1.7)), 0.02);
  // build a region record per flood region (largest traced loop as its polygon)
  const regions = [], slot = new Int16Array(nreg).fill(-1);
  for (let r = 0; r < nreg; r++) {
    const mask = new Uint8Array(R * R); let any = false;
    for (let c = 0; c < R * R; c++) if (reg[c] === r) { mask[c] = 1; any = true; }
    if (!any) continue;
    const polys = tracePolys(mask, R, x0, y0, cell).map(smooth).filter(p => p.length >= 3);
    let poly = null, ba = 0;
    for (const p of polys) { const a = Math.abs(polyArea(p)); if (a > ba) { ba = a; poly = p; } }
    if (!poly) continue;
    slot[r] = regions.length;
    // With no coast in this hex nothing marks a sea side, so the hex is simply what it always was —
    // otherwise a river drawn across open water would carve two patches of dry land out of the sea.
    regions.push({ sea: seaPts.length ? seaReg.has(r) : baseSea(h),
                   poly, cent: insidePoint(poly), extra: polys.filter(p => p !== poly) });
  }
  // within-hex adjacency: regions whose cells touch (across the coastline)
  const adjSet = new Set();
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    const c = j * R + i; if (reg[c] < 0) continue;
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      const ni = i + di, nj = j + dj; if (ni >= R || nj >= R) continue;
      const nc = nj * R + ni; if (reg[nc] >= 0 && reg[nc] !== reg[c]) {
        const a = slot[reg[c]], b = slot[reg[nc]];
        if (a >= 0 && b >= 0) adjSet.add(a < b ? a + '-' + b : b + '-' + a);
      }
    }
  }
  const adj = [...adjSet].map(s => s.split('-').map(Number));
  const riverPairs = [...riverPairSet]
    .map(s => s.split('-').map(Number).map(r => slot[r]))
    .filter(([a, b]) => a >= 0 && b >= 0 && a !== b);
  return { regions, adj, riverPairs,
           seaPolys: regions.filter(r => r.sea).flatMap(r => [r.poly, ...r.extra]),
           landPolys: regions.filter(r => !r.sea).flatMap(r => [r.poly, ...r.extra]) };
}
// Snap a point to the nearest of the given segments (within thr) — turns the grid staircase into
// the actual drawn coast line / hex edge it approximates.
function snapToLines(p, lines, thr) {
  let best = p, bd = thr * thr;
  for (const [a, b] of lines) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const qx = a[0] + t * dx, qy = a[1] + t * dy, d = (p[0] - qx) ** 2 + (p[1] - qy) ** 2;
    if (d < bd) { bd = d; best = [qx, qy]; }
  }
  return best;
}
// Drop near-duplicate and near-collinear vertices from a closed polygon.
function simplifyClosed(poly, eps) {
  let pts = poly.filter((p, i) => { const q = poly[(i - 1 + poly.length) % poly.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.4; });
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      if (distToSeg(b[0], b[1], a[0], a[1], c[0], c[1]) < eps) { changed = true; } else out.push(b);
    }
    if (out.length >= 3) pts = out; else break;
  }
  return pts;
}
// Trace the outline(s) of a binary cell mask into world-space polygons (rectilinear, simplified).
function tracePolys(mask, R, x0, y0, cell) {
  const ck = (ci, cj) => cj * (R + 1) + ci;
  const adj = new Map();
  const add = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); };
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    if (!mask[j * R + i]) continue;
    if (i === 0 || !mask[j * R + i - 1]) add(ck(i, j), ck(i, j + 1));
    if (i === R - 1 || !mask[j * R + i + 1]) add(ck(i + 1, j), ck(i + 1, j + 1));
    if (j === 0 || !mask[(j - 1) * R + i]) add(ck(i, j), ck(i + 1, j));
    if (j === R - 1 || !mask[(j + 1) * R + i]) add(ck(i, j + 1), ck(i + 1, j + 1));
  }
  const ekey = (a, b) => a < b ? a * 1e7 + b : b * 1e7 + a;
  const used = new Set(), loops = [];
  const cptOf = k => [x0 + (k % (R + 1)) * cell, y0 + ((k / (R + 1)) | 0) * cell];
  for (const startK of adj.keys()) {
    const first = (adj.get(startK) || []).find(nb => !used.has(ekey(startK, nb)));
    if (first === undefined) continue;
    const loop = [startK]; let prev = startK, cur = first; used.add(ekey(startK, first));
    while (cur !== startK) {
      loop.push(cur);
      const nbrs = adj.get(cur) || [];
      let nxt = nbrs.find(nb => nb !== prev && !used.has(ekey(cur, nb)));
      if (nxt === undefined) nxt = nbrs.find(nb => !used.has(ekey(cur, nb)));
      if (nxt === undefined) break;
      used.add(ekey(cur, nxt)); prev = cur; cur = nxt;
    }
    if (loop.length >= 4) {
      // simplify collinear corners
      const w = loop.map(cptOf), out = [];
      for (let i = 0; i < w.length; i++) {
        const a = w[(i - 1 + w.length) % w.length], b = w[i], c = w[(i + 1) % w.length];
        if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) !== 0) out.push(b);
      }
      if (out.length >= 3) loops.push(out);
    }
  }
  return loops;
}

/* ---------------- features ---------------- */
function featPathD(pts) {
  return pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
}
function renderFeatures() {
  for (const id of ['roads', 'trade', 'coastLines', 'riverMajor', 'riverMinor']) groups[id].innerHTML = '';
  renderCoasts();
  for (const f of S.features.features) {
    const st = FSTYLE[f.type];
    const a = { d: featPathD(f.pts), fill: 'none', stroke: st.stroke, 'stroke-width': st.width,
                'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    if (st.dash) a['stroke-dasharray'] = st.dash;
    el('path', a, groups[TYPE_LAYER[f.type]]); // each type into its own layer (see LAYERS z-order)
  }
  S.adj = null; // invalidate derived movement data
}
function pushUndo() {
  S.undoStack.push(JSON.stringify(S.features));
  if (S.undoStack.length > 60) S.undoStack.shift();
}
function saveLocal() {
  localStorage.setItem(LS_KEY, JSON.stringify(S.features));
  document.getElementById('saveInfo').textContent =
    `Autosaved locally — ${S.features.features.length} features.`;
}
// computeRoute rebuilds S.adj, so the borders repaint picks up the coastline that was just drawn.
function commitFeatures() { renderFeatures(); renderLabels(); saveLocal(); computeRoute(); paintBorders(); }

/* ---------------- snapping ---------------- */
// A hidden layer is not a snap target: if a feature's type layer is toggled off, new lines
// don't snap to that feature (you can't see it, so snapping to it would be surprising).
const featureLayerHidden = f => { const g = groups[TYPE_LAYER[f.type]]; return !!(g && g.style.display === 'none'); };
// Vertices of already-drawn features near (x,y); lets new lines connect to existing geometry.
// Excludes the feature currently being drawn. If hexOnly is set, only verts in that hex.
function drawnVertsNear(x, y, thr, hexOnly) {
  const out = [], t2 = thr * thr;
  for (const f of S.features.features) {
    if (f === S.drawing || featureLayerHidden(f)) continue;
    for (const p of f.pts) {
      if (hexOnly != null && nearestHex(p[0], p[1]) !== hexOnly) continue;
      if ((x - p[0]) ** 2 + (y - p[1]) ** 2 <= t2) out.push(p);
    }
  }
  return out;
}
// Vertices of the line you are drawing *right now*. The first one matters most: snapping exactly
// onto it is the only way to close a ring, and a ring is the only way to draw an island smaller
// than a hex — an almost-closed loop leaves a gap, the flood fill leaks through it, and you get
// one broken region instead of an inside and an outside. It only turns sticky once there are
// three points to enclose an area with, so the second click of a line isn't dragged backwards.
// Returns {p, close} so callers can weight the closing vertex more heavily than the rest.
function drawingVertsNear(x, y, thr, hexOnly) {
  const out = [], t2 = thr * thr;
  if (!S.drawing) return out;
  const n = S.drawing.pts.length;
  S.drawing.pts.forEach((p, i) => {
    if (hexOnly != null && nearestHex(p[0], p[1]) !== hexOnly) return;
    if ((x - p[0]) ** 2 + (y - p[1]) ** 2 <= t2) out.push({ p, close: i === 0 && n >= 3 });
  });
  return out;
}
// Is the snapped point p the one that would close the ring being drawn?
const closesRing = p => !!(p && S.drawing && S.drawing.pts.length >= 3 &&
                           p[0] === S.drawing.pts[0][0] && p[1] === S.drawing.pts[0][1]);
function snapPoint(x, y, thrScreen, scale) {
  const thr = thrScreen / scale;
  const h = nearestHex(x, y);
  if (!h) return null;
  let best = null, bd = thr * thr;
  const consider = (px, py, bias) => {
    const d = (x - px) ** 2 + (y - py) ** 2 - (bias || 0);
    if (d < bd) { bd = d; best = [px, py]; }
  };
  for (const id of [h, ...neighbors(h)]) {
    const [cx, cy] = hexCenter(id);
    consider(cx, cy);
    for (const o of CORN) consider(cx + o[0], cy + o[1]);
    for (const o of EDGE) consider(cx + o[0], cy + o[1]);
    for (const o of SUB) consider(cx + o[0], cy + o[1]);
  }
  // drawn-feature vertices win ties (slight bias) so connecting to existing geometry is reliable
  for (const p of drawnVertsNear(x, y, thr, null)) consider(p[0], p[1], (thr * 0.4) ** 2);
  for (const { p, close } of drawingVertsNear(x, y, thr, null)) consider(p[0], p[1], (thr * (close ? 0.9 : 0.4)) ** 2);
  return best;
}

// Snap to the given hex's own lattice, plus drawn-feature vertices in that hex.
// Never returns a neighbor's lattice point, so coasts stay inside one hex.
function snapInHex(x, y, hex) {
  const [cx, cy] = hexCenter(hex);
  let best = null, bd = Infinity;
  const consider = (px, py, bias) => { const d = (x - px) ** 2 + (y - py) ** 2 - (bias || 0); if (d < bd) { bd = d; best = [px, py]; } };
  consider(cx, cy);
  for (const o of CORN) consider(cx + o[0], cy + o[1]);
  for (const o of EDGE) consider(cx + o[0], cy + o[1]);
  for (const o of SUB) consider(cx + o[0], cy + o[1]);
  for (const p of drawnVertsNear(x, y, S.G.hex_size, hex)) consider(p[0], p[1], 100); // prefer connecting
  // ...and to the line in progress, so a coast can be closed back onto its own starting node
  for (const { p, close } of drawingVertsNear(x, y, S.G.hex_size, hex)) consider(p[0], p[1], close ? 420 : 100);
  return best;
}
// Project (x,y) onto the nearest hex edge OR nearest drawn-feature segment (anywhere along them).
function snapToEdge(x, y, hex) {
  let best = null, bd = Infinity;
  const projSeg = (a, b, bias) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const px = a[0] + t * dx, py = a[1] + t * dy, d = (x - px) ** 2 + (y - py) ** 2 - (bias || 0);
    if (d < bd) { bd = d; best = [px, py]; }
  };
  const [cx, cy] = hexCenter(hex);
  for (let i = 0; i < 6; i++) projSeg([cx + CORN[i][0], cy + CORN[i][1]], [cx + CORN[(i + 1) % 6][0], cy + CORN[(i + 1) % 6][1]]);
  const thr = S.G.hex_size;
  for (const f of S.features.features) {
    if (f === S.drawing || featureLayerHidden(f)) continue;
    for (let k = 0; k + 1 < f.pts.length; k++) {
      if (Math.hypot(x - f.pts[k][0], y - f.pts[k][1]) > thr * 1.5 && Math.hypot(x - f.pts[k + 1][0], y - f.pts[k + 1][1]) > thr * 1.5) continue;
      projSeg(f.pts[k], f.pts[k + 1], (thr * 0.4) ** 2); // drawn edges preferred on ties
    }
  }
  return best;
}

/* ---------------- derived movement data ---------------- */
function deriveAdj() {
  const roads = new Set(), ferry = new Set();
  const tradeByHex = new Map();
  const riverByHex = new Map();
  // Roads are a real network, not just hex-pair adjacency. Each road keeps its own identity so
  // road speed only chains along a *connected* road: two roads sharing a hex are only joinable
  // where their drawn lines actually touch (a junction).
  const roadPairFi = new Map();   // pairKey -> Set(roadId): which roads cross the shared edge h|n
  const roadGeomFi = new Map();   // `${pairKey}#${roadId}` -> {a, pts}: that road's drawn crossing geometry
  const roadHexPts = new Map();   // hex -> Map(roadId -> [[x,y]...]): a road's sampled points inside a hex
  const lineChain = pts => { // ordered hexes visited by a polyline
    const chain = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / 4));
      for (let k = 0; k <= n; k++) {
        const h = nearestHex(ax + (bx - ax) * k / n, ay + (by - ay) * k / n);
        if (h && h !== chain[chain.length - 1]) chain.push(h);
      }
    }
    return chain;
  };
  const coastHexes = new Set();
  const majorPairs = new Set(); // pairKey -> a drawn MAJOR river crosses this edge (river mouths)
  const geom = new Map();      // pairKey -> {a, pts}: drawn road geometry between adjacent hexes
  const riverGeom = new Map(); // same, for drawn rivers (so sailing follows the river visually)
  const addAdjFromLine = (pts, set, geomMap = geom) => {
    // fine samples along the polyline, tagged with their hex
    const samples = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / 4));
      for (let k = (i === 0 ? 0 : 1); k <= n; k++) {
        const x = ax + (bx - ax) * k / n, y = ay + (by - ay) * k / n;
        samples.push([x, y, nearestHex(x, y)]);
      }
    }
    // group into runs per hex; each adjacent run pair is a connection with real geometry
    const runs = [];
    for (let i = 0; i < samples.length; i++) {
      const h = samples[i][2];
      if (!runs.length || runs[runs.length - 1].h !== h) runs.push({ h, i0: i, i1: i });
      else runs[runs.length - 1].i1 = i;
    }
    for (let j = 0; j + 1 < runs.length; j++) {
      const u = runs[j], v = runs[j + 1];
      if (!u.h || !v.h || !neighbors(u.h).includes(v.h)) continue;
      const key = pairKey(u.h, v.h);
      if (set) set.add(key);
      if (!geomMap.has(key)) {
        const mu = (u.i0 + u.i1) >> 1, mv = (v.i0 + v.i1) >> 1;
        geomMap.set(key, { a: u.h, pts: samples.slice(mu, mv + 1).map(s => [s[0], s[1]]) });
      }
    }
  };
  // A road, keeping its identity: record which edges it crosses (roadPairFi), the drawn
  // geometry of each crossing (roadGeomFi), and its sampled points per hex (roadHexPts, for
  // junction detection). roadId is the feature's index in S.features.features.
  const processRoad = (pts, roadId) => {
    const samples = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / 4));
      for (let k = (i === 0 ? 0 : 1); k <= n; k++) {
        const x = ax + (bx - ax) * k / n, y = ay + (by - ay) * k / n;
        samples.push([x, y, nearestHex(x, y)]);
      }
    }
    const runs = [];
    for (let i = 0; i < samples.length; i++) {
      const h = samples[i][2];
      if (!runs.length || runs[runs.length - 1].h !== h) runs.push({ h, i0: i, i1: i });
      else runs[runs.length - 1].i1 = i;
    }
    for (const run of runs) {  // remember this road's footprint inside each hex it touches
      if (!run.h) continue;
      if (!roadHexPts.has(run.h)) roadHexPts.set(run.h, new Map());
      const m = roadHexPts.get(run.h);
      const arr = m.get(roadId) || [];
      for (let i = run.i0; i <= run.i1; i++) arr.push([samples[i][0], samples[i][1]]);
      m.set(roadId, arr);
    }
    for (let j = 0; j + 1 < runs.length; j++) {
      const u = runs[j], v = runs[j + 1];
      if (!u.h || !v.h || !neighbors(u.h).includes(v.h)) continue;
      const key = pairKey(u.h, v.h);
      if (!roadPairFi.has(key)) roadPairFi.set(key, new Set());
      roadPairFi.get(key).add(roadId);
      roads.add(key);
      const gk = key + '#' + roadId;
      if (!roadGeomFi.has(gk)) {
        const mu = (u.i0 + u.i1) >> 1, mv = (v.i0 + v.i1) >> 1;
        roadGeomFi.set(gk, { a: u.h, pts: samples.slice(mu, mv + 1).map(s => [s[0], s[1]]) });
      }
    }
  };
  const majorHexes = new Set(); // hexes a major river actually flows through (not just near)
  const addRiverSegs = (pts, minor) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const seg = { x1: pts[i][0], y1: pts[i][1], x2: pts[i + 1][0], y2: pts[i + 1][1], minor };
      // bucket into hexes near the segment (incl. neighbours, for crossing detection)
      const touched = new Set();
      const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1), n = Math.max(1, Math.ceil(len / 4));
      for (let k = 0; k <= n; k++) {
        const h = nearestHex(seg.x1 + (seg.x2 - seg.x1) * k / n, seg.y1 + (seg.y2 - seg.y1) * k / n);
        if (h) { touched.add(h); if (!minor) majorHexes.add(h); for (const nb of neighbors(h)) touched.add(nb); }
      }
      for (const h of touched) {
        if (!riverByHex.has(h)) riverByHex.set(h, []);
        riverByHex.get(h).push(seg);
      }
    }
  };
  S.features.features.forEach((f, fi) => {
    if (f.type === 'road') processRoad(f.pts, fi);
    else if (f.type === 'trade') {
      // Trade routes are atomic: enter at one terminal, exit at the other, nothing in between.
      // Length is measured off the drawn line, NOT off lineChain's hex count. A line that hugs a
      // hex boundary flickers between neighbours and can even re-enter a hex it already left, so
      // the hex count over-reports badly — one route here billed 150 miles for 90 miles of drawn
      // road, which made marching off-road and fording a river look like the better option.
      // 50 px (hex_width) is one hex step centre-to-centre, i.e. HEX_MILES.
      const chain = lineChain(f.pts);
      if (chain.length > 1) {
        let px = 0;
        for (let k = 0; k + 1 < f.pts.length; k++)
          px += Math.hypot(f.pts[k + 1][0] - f.pts[k][0], f.pts[k + 1][1] - f.pts[k][1]);
        const miles = px * RULES.HEX_MILES / S.G.hex_width;
        const link = { a: chain[0], b: chain[chain.length - 1], chain, pts: f.pts, miles,
                       hexes: Math.max(1, Math.round(miles / RULES.HEX_MILES)) };
        for (const t of [link.a, link.b]) {
          if (!tradeByHex.has(t)) tradeByHex.set(t, []);
          tradeByHex.get(t).push(link);
        }
      }
    }
    else if (f.type === 'coast') { if (f.hex != null) coastHexes.add(f.hex); else for (const h of lineChain(f.pts)) coastHexes.add(h); }
    else if (f.type === 'river_major') { addRiverSegs(f.pts, false); addAdjFromLine(f.pts, majorPairs, riverGeom); }
    else if (f.type === 'river_minor') { addRiverSegs(f.pts, true); addAdjFromLine(f.pts, null, riverGeom); }
  });
  // Junctions: inside each hex, union roads whose drawn lines touch/cross, then number the
  // resulting connectivity groups 1.. (0 is reserved for "not on a road"). An army may only
  // switch between two roads in a hex if they share a group. Groups are local to each hex.
  const TOUCH = S.G.hex_size * 0.18;  // roads within ~0.18 hex count as connected
  const hexRoadGroup = new Map();     // hex -> Map(roadId -> groupId >= 1)
  for (const [h, m] of roadHexPts) {
    const ids = [...m.keys()];
    const par = new Map(ids.map(i => [i, i]));
    const find = x => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
    const union = (a, b) => { par.set(find(a), find(b)); };
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const A = m.get(ids[i]), B = m.get(ids[j]);
      let touch = false;
      // any sampled point of one road within TOUCH of a segment of the other = they meet
      for (let a = 0; a < A.length && !touch; a++)
        for (let b = 0; b + 1 < B.length; b++)
          if (distToSeg(A[a][0], A[a][1], B[b][0], B[b][1], B[b + 1][0], B[b + 1][1]) <= TOUCH) { touch = true; break; }
      if (!touch) for (let b = 0; b < B.length && !touch; b++)
        for (let a = 0; a + 1 < A.length; a++)
          if (distToSeg(B[b][0], B[b][1], A[a][0], A[a][1], A[a + 1][0], A[a + 1][1]) <= TOUCH) { touch = true; break; }
      if (touch) union(ids[i], ids[j]);
    }
    const roots = [], gmap = new Map();
    for (const id of ids) { const r = find(id); let gi = roots.indexOf(r); if (gi < 0) { gi = roots.length; roots.push(r); } gmap.set(id, Math.min(gi + 1, 7)); }
    hexRoadGroup.set(h, gmap);
  }
  const ferryAt = new Map(); // pairKey -> {pt, spur}: where this edge is ferried, and the spur to follow
  const meet = new Set();      // "h|n|ri|rj": region rj of n is reachable from region ri of h
  const riverEdge = new Set(); // pairKey: a major river runs along this edge, so it is a bank
  S.adj = { roads, roadPairFi, roadGeomFi, hexRoadGroup, ferry, ferryAt, meet, riverEdge, tradeByHex, riverByHex, geom, riverGeom, coastHexes, majorHexes, majorPairs, sub: new Map() };
  // A ferry is not something you draw — it is simply what a road does where it meets a major river,
  // which can't be forded by anyone: a free crossing for the whole column, wagons included.
  // It is found geometrically, by actually intersecting the drawn lines. The older test asked instead
  // whether a road crossed this hex edge AND a major river crossed the line between the two hex
  // centres, which are two unrelated facts — a road running *alongside* a river satisfies both and
  // was handed a ferry it never had. Nothing is a ferry now unless road and river genuinely meet.
  // Each crossing also keeps its road, if that road is a spur drawn wholly inside one hex — a ferry
  // sketched in place. Such a spur is safe to draw a route along in full: it cannot leave its hex, so
  // it can't drag the line off the step the way an arbitrary stretch of a longer road could, and
  // following the whole of it is the point — the spur IS the crossing.
  const ferryPts = []; // {pt, spur}: where a drawn road cuts a major river, and the spur if it is one
  for (const f of S.features.features) {
    if (f.type !== 'road') continue;
    const spur = lineChain(f.pts).length <= 1 ? f.pts : null;
    for (let i = 0; i + 1 < f.pts.length; i++) {
      const [ax, ay] = f.pts[i], [bx, by] = f.pts[i + 1];
      // riverByHex buckets each segment into its hex and that hex's neighbours, so looking up the
      // road segment's midpoint finds every river it could possibly touch.
      for (const s of riverByHex.get(nearestHex((ax + bx) / 2, (ay + by) / 2)) || []) {
        if (s.minor) continue;
        if (segIntersect(ax, ay, bx, by, s.x1, s.y1, s.x2, s.y2))
          ferryPts.push({ pt: segCrossPt(ax, ay, bx, by, s.x1, s.y1, s.x2, s.y2), spur });
      }
    }
  }
  S.adj.ferryPts = ferryPts;
  // A ferry serves one crossing — the one it was drawn at — so an edge is ferried only when the ferry
  // sits at the point where *that* march meets the water. Testing it against the whole line from hex
  // to hex was far too loose: it lit up edges whose crossing was most of a hex upstream, so a column
  // could cross the river in open country and the pathfinder would happily detour to do it.
  if (ferryPts.length) {
    const FERRY_R = S.G.hex_size * 0.5;
    const near = new Set();
    for (const h of majorHexes) { near.add(h); for (const n of neighbors(h)) near.add(n); }
    for (const h of near) for (const n of neighbors(h)) {
      if (h > n || !S.hexes[n] || !S.hexes[h]) continue;
      const X = majorCrossPt(h, n); if (!X) continue; // where this march actually meets the river
      let best = null, bd = FERRY_R;
      for (const p of ferryPts) { const d = Math.hypot(p.pt[0] - X[0], p.pt[1] - X[1]); if (d <= bd) { bd = d; best = p; } }
      if (!best) continue;
      ferry.add(pairKey(h, n));
      ferryAt.set(pairKey(h, n), best); // remembered so the drawn route crosses at the ferry, not beside it
    }
  }
  // A major river drawn ALONG a hex boundary rather than across it. The split can't see such a river:
  // it never separates one hex's own regions from each other, so both hexes come out whole and their
  // regions duly "meet" along the edge — while the water lies right between them. Measure how much of
  // the shared edge runs in the river, and where most of it does, that edge is barred like any bank.
  {
    const RE_N = 9, RE_THR = S.G.hex_size * 0.22, RE_MIN = Math.ceil(RE_N * 0.6);
    const near = new Set();
    for (const h of majorHexes) { near.add(h); for (const n of neighbors(h)) near.add(n); }
    for (const h of near) for (const n of neighbors(h)) {
      if (h > n || !S.hexes[h] || !S.hexes[n]) continue;
      const segs = riverByHex.get(h) || [];
      if (!segs.length) continue;
      const [c1, c2] = sharedEdgeCorners(h, n);
      let wet = 0;
      for (let k = 0; k < RE_N; k++) {
        const t = (k + 0.5) / RE_N, mx = c1[0] + (c2[0] - c1[0]) * t, my = c1[1] + (c2[1] - c1[1]) * t;
        for (const s of segs)
          if (!s.minor && distToSeg(mx, my, s.x1, s.y1, s.x2, s.y2) <= RE_THR) { wet++; break; }
      }
      if (wet >= RE_MIN) riverEdge.add(pairKey(h, n));
    }
  }
  // Subhex geometry: flood-filled sea/land regions per coast-crossed hex (barriers = coast lines).
  S.adj.sub = coastSubcells();
  // A drawn major river through a coast hex makes that hex's land regions navigable too
  // (a fleet can sail the river through the land part), so mark them as river regions.
  for (const [h, cells] of S.adj.sub) if (majorHexes.has(h)) for (const r of cells.regions) if (!r.sea) r.river = true;
  // Where the drawn major rivers physically run, region by region. `river = true` above is coarse —
  // it flags every land region of a river hex — so this records the regions the line actually
  // passes through, which is what tells a river mouth (river reaches the water) from a bay that
  // merely shares a hex with an inland channel. See waterLink().
  const riverRegions = new Map(); // hex -> Set(region index)
  const markRiver = (x, y) => {
    const h = nearestHex(x, y); if (!h) return;
    const regs = S.adj.sub.get(h)?.regions;
    const add = i => { if (!riverRegions.has(h)) riverRegions.set(h, new Set()); riverRegions.get(h).add(i); };
    if (!regs || regs.length < 2) return add(0); // unsplit hex: its single region is the river
    for (let i = 0; i < regs.length; i++) if (regs[i].poly && pointInPoly([x, y], regs[i].poly)) add(i);
  };
  for (const f of S.features.features) {
    if (f.type !== 'river_major') continue;
    for (let k = 0; k + 1 < f.pts.length; k++) {
      const [ax, ay] = f.pts[k], [bx, by] = f.pts[k + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 2));
      for (let m = 0; m <= n; m++) markRiver(ax + (bx - ax) * m / n, ay + (by - ay) * m / n);
    }
  }
  // A river now runs *between* regions rather than through one, so sampling points along it can miss
  // both — the line lies on the shared boundary. The split already knows which pairs it separated,
  // and those regions are exactly the ones it runs through, so take them straight from there.
  for (const [h, cells] of S.adj.sub) for (const [a, b] of cells.riverPairs || []) {
    if (!riverRegions.has(h)) riverRegions.set(h, new Set());
    riverRegions.get(h).add(a); riverRegions.get(h).add(b);
  }
  S.adj.riverRegions = riverRegions;
  // Where a road crosses the river inside a hex, that is a bridge, and the two banks are joined
  // again for anyone on foot. Without one they are separate places that happen to share a hex.
  const bridged = new Map(); // hex -> the crossing itself, so the drawn route can go over it
  for (const p of ferryPts) { const bh = nearestHex(p.pt[0], p.pt[1]); if (bh && !bridged.has(bh)) bridged.set(bh, p); }
  S.adj.bridged = bridged;
  // Which region faces which across each hex edge. Sampled finely and requiring the two to share
  // more than a single sample: where a river crosses an edge, the two hexes place that crossing a
  // pixel or so apart, and one stray sample of overlap would otherwise pair a north bank with a
  // south one and let the column stroll across.
  // Sampled finely, because a real meeting can be narrow: where a river crosses an edge near a corner
  // the far bank keeps only a short stretch of it, and at 16 samples — most of them then thrown out
  // for being in the water — a genuine connection could come down to a single sample and be refused,
  // which sent routes the long way round. 3 of 32 is about a tenth of an edge: enough to shrug off the
  // stray sample or two where the two hexes put the crossing point slightly differently.
  const MEET_N = 32, MEET_MIN = 3, MEET_DRY = S.G.hex_size * 0.12;
  for (const h of S.adj.sub.keys()) for (const n of neighbors(h)) {
    if (!S.hexes[n] || S.hexes[n].t === 'N/A') continue;
    const [c1, c2] = sharedEdgeCorners(h, n);
    const [ax, ay] = hexCenter(h), [bx, by] = hexCenter(n);
    const wet = (riverByHex.get(h) || []).filter(s => !s.minor);
    const tally = new Map();
    for (let k = 0; k < MEET_N; k++) {
      const t = (k + 0.5) / MEET_N;
      const m = [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t];
      // Only dry ground counts as a meeting. The two hexes put the river's crossing a pixel or two
      // apart, leaving a sliver at the water's edge where opposite banks appear to touch — a gap the
      // column was stepping through. Ground within a stride of the river is not a way across it.
      if (wet.some(s => distToSeg(m[0], m[1], s.x1, s.y1, s.x2, s.y2) <= MEET_DRY)) continue;
      const i = regionAtEdge(h, m, ax, ay), j = regionAtEdge(n, m, bx, by);
      if (i < 0 || j < 0) continue;
      const key = i + ':' + j;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    for (const [key, c] of tally) if (c >= MEET_MIN) {
      const [i, j] = key.split(':');
      meet.add(`${h}|${n}|${i}|${j}`); meet.add(`${n}|${h}|${j}|${i}`); // both ways round
    }
  }
}
// The centroid of the *area*, not of the vertex list. A region traced from a drawn line carries all
// its detail on that one side — dozens of points along a river, two or three hex corners elsewhere —
// so averaging vertices drags the node onto the riverbank, which is both wrong to march from and the
// last place a route should be drawn through. Falls back to the vertex mean for degenerate slivers.
const polyCentroid = poly => {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const f = poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1];
    a += f; cx += (poly[i][0] + poly[j][0]) * f; cy += (poly[i][1] + poly[j][1]) * f;
  }
  if (Math.abs(a) < 1e-6) return poly.reduce((s, p) => [s[0] + p[0] / poly.length, s[1] + p[1] / poly.length], [0, 0]);
  return [cx / (3 * a), cy / (3 * a)];
};
const polyArea = p => { let a = 0; for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; a += p[i][0] * p[j][1] - p[j][0] * p[i][1]; } return a / 2; };
// Somewhere to stand inside a region. Usually its centroid — but a bank curled around a river bend
// is concave enough that the centroid lands in the water, and a node outside its own region is a
// place no march can start from and no line should be drawn through. For those, take the interior
// point furthest from any edge: the roomiest spot in it.
function insidePoint(poly) {
  const c = polyCentroid(poly);
  if (pointInPoly(c, poly)) return c;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  const N = 24; let best = c, bd = -1;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const p = [x0 + (i + 0.5) * (x1 - x0) / N, y0 + (j + 0.5) * (y1 - y0) / N];
    if (!pointInPoly(p, poly)) continue;
    let d = Infinity;
    for (let k = 0; k < poly.length; k++) {
      const l = (k + 1) % poly.length;
      d = Math.min(d, distToSeg(p[0], p[1], poly[k][0], poly[k][1], poly[l][0], poly[l][1]));
    }
    if (d > bd) { bd = d; best = p; }
  }
  return best;
}
const anyPoly = (polys, pt) => polys.some(p => pointInPoly(pt, p));
const baseSea = h => RULES.WATER.has(S.hexes[h].t);
const majorRiverHex = h => S.adj.majorHexes.has(h);
const seaSlivers = h => S.adj.sub.get(h)?.seaPolys || [];
const landSlivers = h => S.adj.sub.get(h)?.landPolys || [];

// A hex is either coast-split into explicit regions, or a single synthetic "whole" region.
function regionsOf(h) {
  const s = S.adj.sub.get(h);
  if (s && s.regions.length) return s.regions;
  return [{ sea: baseSea(h), whole: true, river: majorRiverHex(h) && !baseSea(h) }];
}
const regionAdj = h => S.adj.sub.get(h)?.adj || []; // within-hex touching region index pairs
const region = (h, ri) => regionsOf(h)[ri];
const regWalkable = r => r && (!r.sea || r.river); // marchable
const regSail = r => r && (r.sea || r.river);      // navigable
// Does a drawn major river actually run through this region?
const riverInRegion = (h, ri) => !!S.adj.riverRegions.get(h)?.has(ri);
// Are two navigable regions the same body of water? Sea to sea always is — that's the open sea and
// every bay along the shore. A *river* region only joins its neighbour where the drawn river truly
// goes: reaching into the sea inside a hex (that junction is the river mouth) or crossing the hex
// edge on its way upstream. Otherwise a bay that merely shares a hex with an inland channel would
// let a fleet step off the sea straight into the channel, anywhere along the coast, with no mouth.
function waterLink(h, ri, n, rj) {
  const A = region(h, ri), B = region(n, rj);
  if (!A || !B) return false;
  if (A.sea && B.sea) return true;                        // open water to open water
  if (h === n) return riverInRegion(h, ri) && riverInRegion(h, rj); // the mouth: river reaches both
  return S.adj.majorPairs.has(pairKey(h, n));             // the river itself crosses this edge
}
function hasSea(h) { return S.hexes[h].t !== 'N/A' && regionsOf(h).some(regSail); }
function hasLand(h) { return S.hexes[h].t !== 'N/A' && regionsOf(h).some(regWalkable); }
// Which region index does a clicked point fall in?
function regionAt(h, pt) {
  const rs = regionsOf(h);
  if (rs.length === 1) return 0;
  for (let i = 0; i < rs.length; i++) if (rs[i].poly && pointInPoly(pt, rs[i].poly)) return i;
  // nearest centroid fallback
  let bi = 0, bd = Infinity;
  rs.forEach((r, i) => { const c = r.cent || hexCenter(h), d = (pt[0] - c[0]) ** 2 + (pt[1] - c[1]) ** 2; if (d < bd) { bd = d; bi = i; } });
  return bi;
}
const nodePoint = (h, ri) => region(h, ri)?.cent || hexCenter(h);
// How far along the way from a to b the point p falls: 0 at a, 1 at b, negative if it lies behind a.
const onWayFrac = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  return l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
};
// Where a stronghold actually stands: its own marker if one was placed, else the hex centre. Null
// unless the marker sits in region ri — a coastal hex's sea half must not claim the keep on its
// land half, and an unplaced marker only counts if the hex centre falls in the region you asked for.
function strongholdPoint(h, ri) {
  if (!hasStronghold(h)) return null;
  const sh = S.features.strongholds[h];
  const pt = (sh && sh.x != null) ? [sh.x, sh.y] : hexCenter(h);
  return regionAt(h, pt) === (ri | 0) ? pt : null;
}
// The anchor for a route's first and last point. You march to the gate of a place, not to the middle
// of the ground around it, so a route that begins or ends at a stronghold is drawn to its marker.
const endPoint = (h, ri) => strongholdPoint(h, ri) || nodePoint(h, ri);
const isSplit = h => { const s = S.adj.sub.get(h); return !!(s && s.regions.length > 1); };
// Does region ri of h occupy the shared edge with hex n (so movement can cross there)?
// edgePts may be null when neither hex is coast-split (a whole region always spans the edge).
function regionOnEdge(h, ri, edgePts) {
  const r = region(h, ri); if (!r) return false;
  if (r.whole || !edgePts) return true;
  const [cx, cy] = hexCenter(h);
  return edgePts.some(m => pointInPoly([m[0] + (cx - m[0]) * 0.18, m[1] + (cy - m[1]) * 0.18], r.poly));
}
// Do regions (h,ri) and (n,rj) actually meet — over a real stretch of the edge they share? That each
// of them touches that edge *somewhere* is not enough: where a major river crosses the edge, both
// hexes have a bank on either side of it, so all four regions touch it and pairing them blindly
// walks the column over the water. Answered from a table built once in deriveAdj; when neither hex
// is carved up there is only one region a side and the whole edge is shared.
function regionsMeet(h, ri, n, rj) {
  if (!S.adj.sub.has(h) && !S.adj.sub.has(n)) return true;
  return S.adj.meet.has(h + '|' + n + '|' + ri + '|' + rj);
}
// Which region of h a point on its boundary belongs to, stepped a little inside first. -1 in the
// seam between regions.
function regionAtEdge(h, m, cx, cy) {
  const rs = regionsOf(h);
  const p = [m[0] + (cx - m[0]) * 0.06, m[1] + (cy - m[1]) * 0.06];
  for (let i = 0; i < rs.length; i++) if (rs[i].whole || !rs[i].poly || pointInPoly(p, rs[i].poly)) return i;
  return -1;
}
// The two corners a shares with its neighbour b — the edge between them.
function sharedEdgeCorners(a, b) {
  const [ax, ay] = hexCenter(a), c = CORN.map(o => [ax + o[0], ay + o[1]]);
  const [bx, by] = hexCenter(b);
  return c.map((p, i) => [Math.hypot(p[0] - bx, p[1] - by), i]).sort((u, v) => u[0] - v[0]).slice(0, 2).map(x => c[x[1]]);
}
// Points sampled along the shared edge between adjacent hexes a and b.
function sharedEdgePts(a, b) {
  const [c1, c2] = sharedEdgeCorners(a, b), out = [];
  for (const t of [0.12, 0.3, 0.5, 0.7, 0.88]) out.push([c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t]);
  return out;
}
// Where the march from a to b meets a drawn major river, or null if it never does. This is the spot
// a crossing would have to be at to be of any use on this step.
function majorCrossPt(a, b) {
  const [ax, ay] = hexCenter(a), [bx, by] = hexCenter(b);
  for (const s of S.adj.riverByHex.get(a) || [])
    if (!s.minor && segIntersect(ax, ay, bx, by, s.x1, s.y1, s.x2, s.y2))
      return segCrossPt(ax, ay, bx, by, s.x1, s.y1, s.x2, s.y2);
  return null;
}
// Does a drawn segment cut a major river? The movement rules ask this of the line between two hex
// centres; this asks it of a line actually being drawn, which is not the same question and is what
// keeps the cosmetic shortcuts in routeLeg from putting the column across water it never forded.
function segCrossesMajor(p, q) {
  const segs = new Set([...(S.adj.riverByHex.get(nearestHex(p[0], p[1])) || []),
                        ...(S.adj.riverByHex.get(nearestHex(q[0], q[1])) || [])]);
  for (const s of segs)
    if (!s.minor && segIntersect(p[0], p[1], q[0], q[1], s.x1, s.y1, s.x2, s.y2)) return true;
  return false;
}
// Does the march from a to b ford a *minor* river? Minor rivers aren't barriers and so aren't part
// of the subhex split; centre to centre is all there is to go on for them.
function minorCross(a, b) {
  const [ax, ay] = hexCenter(a), [bx, by] = hexCenter(b);
  for (const s of S.adj.riverByHex.get(a) || [])
    if (s.minor && segIntersect(ax, ay, bx, by, s.x1, s.y1, s.x2, s.y2)) return true;
  return false;
}
// (There is no longer a hex-centre-to-hex-centre test for *major* rivers. Whether one is in the way
// is a question about the banks, answered by the subhex regions — see regionsMeet and riverEdge.)

/* ---------------- travel calculator ---------------- */
function armyOpts() {
  const v = id => +document.getElementById(id).value || 0;
  const c = id => document.getElementById(id).checked;
  // The two infantry boxes are separate kinds, so `inf` is the whole of the foot: everything that
  // counts infantry — column length, fording, whether this is a cavalry-only army — wants the total,
  // and gets it without having to know the army was entered in two parts.
  const li = v('li');
  const army = { inf: v('inf') + li, cav: v('cav'), wag: v('wag'), non: v('non'), li };
  return {
    army,
    // Light infantry set the pace once they are a third of the fighting strength — not, as this used
    // to have it, only when the army is nothing else. Baggage isn't counted in the reckoning.
    liThird: li > 0 && li >= (army.inf + army.cav) * RULES.LI_FRACTION,
    marines: c('marines'),
    // "Cavalry-only army" = nothing marching on foot and nothing rolling: no infantry, no wagons.
    // Noncombatants don't disqualify it — camp followers keep up or get left behind, either way they
    // are not what holds the column to a walking pace. They still lengthen the column for fords.
    cavOnly: army.cav > 0 && army.inf === 0 && army.wag === 0,
    colMiles: columnMiles(army),
    forced: c('forced'), fleet: c('fleet'),
    embark: c('embark'), tradeRoad: !c('noTrade'), // the box is the opt-out; trade routes are on by default
    weather: document.getElementById('weather').value,
  };
}
// Does hex h have a stronghold? Datasheet strongholds (S.hexes[h].s) and custom-placed ones both
// count, unless a `removed` override hides it (this is how a datasheet stronghold gets deleted).
function hasStronghold(h) {
  const c = S.features.strongholds[h];
  if (c && c.removed) return false;
  return !!(S.hexes[h]?.s || c);
}
// Erase a stronghold: a datasheet one is hidden with a persistent `removed` flag (Ctrl+Z or the
// Stronghold tool restores it); a purely custom one is just deleted. Returns true if it was a
// datasheet stronghold (for messaging).
function removeStronghold(id) {
  const sheet = !!S.hexes[id]?.s;
  if (sheet) S.features.strongholds[id] = { removed: true };
  else delete S.features.strongholds[id];
  return sheet;
}
// Nearest stronghold marker to (wx,wy) within thr — considers custom placements AND datasheet
// strongholds (which may have no custom entry). Skips already-removed ones.
function nearestStronghold(wx, wy, thr) {
  let bs = null, bsd = thr;
  const consider = id => {
    const sh = S.features.strongholds[id];
    if (sh && sh.removed) return;
    const [cx, cy] = (sh && sh.x != null) ? [sh.x, sh.y] : hexCenter(+id);
    const d = Math.hypot(wx - cx, wy - cy);
    if (d < bsd) { bsd = d; bs = id; }
  };
  for (const id in S.features.strongholds) consider(id);
  const nh = nearestHex(wx, wy);
  if (nh && S.hexes[nh]?.s) consider(nh); // datasheet stronghold with no custom entry
  return { id: bs, d: bsd };
}
// Port = a stronghold on, or bordering, navigable water: open sea, a drawn major river, or the sea
// part of a coast-crossed hex. Sea- and river-side strongholds are ports by default so you don't
// have to flag a hundred of them by hand; an explicit flag (Stronghold tool, Shift+click) always
// wins, in either direction, which is how you carve out the exceptions.
// Note this is deliberately looser than `waterLink`: being a port is about standing on the water's
// edge, not about whether a fleet can cross that particular edge.
function isPort(h) {
  const sh = S.features.strongholds[h];
  if (sh && sh.removed) return false;
  if (!S.hexes[h]?.s && !sh) return false; // no stronghold in this hex
  if (sh && sh.coastal !== undefined) return sh.coastal; // explicit flag wins
  if (!S.adj) deriveAdj();
  if (hasSea(h)) return true;
  return neighbors(h).some(n => { const e = sharedEdgePts(h, n); return regionsOf(n).some((r, rj) => regSail(r) && regionOnEdge(n, rj, e)); });
}
// Too small to show in any total (steps are tenths of a day), big enough to settle a tie. Used to
// make a free move lose to not making it at all, where both reach the same place for the same price.
const NUDGE = 1e-6;
const SHIP_IRL = RULES.HEX_MILES / (RULES.SHIP_MILES_PER_DAY * RULES.GAME_DAYS_PER_IRL);
const SECURE = RULES.SECURE_SHIPS_IRL_DAYS, EMBARK = RULES.EMBARK_IRL_DAYS, DISEMBARK = RULES.DISEMBARK_IRL_DAYS;
const DISEMBARK_NOTE = DISEMBARK ? 'disembark +' + DISEMBARK + 'd' : 'disembark';

// Land-march cost from land subhex of a to land subhex of b. `road` says whether this step
// follows a road (speed bonus + bridges); off-road steps are always available at the slower rate.
// `crossMajor` says whether this particular step puts a drawn major river between the column and
// where it is going. That is a question about the two *banks* — the regions — not about the two hex
// centres: a river bending between two hexes can leave their centres on opposite sides while the
// regions being marched between are both on the near side, and asking the centres said "ferry" for
// a march that never approached the water.
function landStep(a, b, o, road, crossMajor) {
  const key = pairKey(a, b), tb = S.hexes[b].t;
  const mpi = landMilesPerIRL({ road, terrain: tb, forced: o.forced, liThird: o.liThird, cavOnly: o.cavOnly, weather: o.weather, colMiles: o.colMiles });
  if (mpi <= 0) return null;
  let irl = RULES.HEX_MILES / mpi, note = road ? 'road' : 'off-road';
  if (RULES.WATER.has(tb) || S.adj.coastHexes.has(b)) note += ' (coastal strip)';
  let fer = false;
  if (crossMajor) {
    // No fording a major river, by anyone, on or off a road: only a ferry gets you over. And it is a
    // place rather than a piece of road, so a column that marches up to one boards it either way.
    if (!S.adj.ferry.has(key)) return null;
    note += ', ferry'; fer = true; irl += NUDGE;
  } else if (minorCross(a, b)) {
    if (road) note += ', bridge';
    else if (!o.cavOnly) { const f = fordIRLDays(o.army, o.weather); if (f === null) return null; irl += f; note += ', ford minor +' + f.toFixed(1) + 'd'; }
    else note += ', ford (cav, free)';
  }
  return { irl, note, fer };
}

// Can a column standing at the node of (h, ri) get onto road `fi` where it leaves h for n? Only if
// nothing uncrossable lies between: within a hex that means a drawn major river with no bridge over
// it. The road's own point in h is where you would join it, so that is the walk to test.
function roadUnreachable(h, ri, n, fi) {
  const ge = S.adj.roadGeomFi.get(pairKey(h, n) + '#' + fi);
  if (!ge || !ge.pts.length) return false;
  const at = ge.a === h ? ge.pts[0] : ge.pts[ge.pts.length - 1];
  // Where the river has actually split this hex, the question is simply which bank the road is on.
  if (S.adj.sub.get(h)?.riverPairs?.length) return regionAt(h, at) !== ri;
  return segCrossesMajor(nodePoint(h, ri), at);
}
// The line to draw for a crossing, approached from `from`. A one-hex spur is walked end to end,
// entered at whichever end you arrive at — it cannot leave its hex, so it can't drag the route off
// its own step. Any other road is only known to touch the water, not to run the way you are going,
// so that one contributes just the crossing point itself.
function ferryRoad(fa, from) {
  const s = fa.spur;
  if (!s) return [fa.pt];
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
  const road = d2(s[0], from) <= d2(s[s.length - 1], from) ? s : [...s].reverse();
  // And only as far along it as it takes to get across. The remainder of a stub doubles back the way
  // it came, and following that drew the route out over the water and straight back again.
  let k = 0, bd = Infinity;
  for (let i = 0; i < road.length; i++) { const d = d2(road[i], fa.pt); if (d < bd) { bd = d; k = i; } }
  return road.slice(0, Math.min(k + 2, road.length));
}
// All moves out of node (h, ri, af, g). `af` = afloat (on the water with a fleet). `g` = the road
// connectivity group the army is currently travelling on (0 = not on a road). A river region can
// be occupied either afloat (sailing) or on foot (marching); sea = always afloat, land = never.
function expand(h, ri, af, ships, g, o) {
  const out = [];
  const reg = region(h, ri); if (!reg) return out;
  const hSplit = isSplit(h);
  const N = neighbors(h).map(n => ({ n, e: (hSplit || isSplit(n)) ? sharedEdgePts(h, n) : null }));
  if (af) { // afloat, ships === 1 — never on a road, so arrivals carry g: 0
    for (const { n, e } of N) { // sail across to any navigable region (sea OR river) — no port needed
      if (!regionOnEdge(h, ri, e)) continue;
      const rs = regionsOf(n);
      for (let rj = 0; rj < rs.length; rj++)
        if (regSail(rs[rj]) && regionOnEdge(n, rj, e) && waterLink(h, ri, n, rj))
          out.push({ toH: n, toRi: rj, af: 1, ships: 1, g: 0, irl: SHIP_IRL, note: 'sail' });
    }
    // Sail between adjacent navigable regions of the SAME hex (a river mouth, a bay opening into a
    // channel). This is free: one hex is one hex. The cost of a hex is paid by the step that
    // crosses into it, so charging a full hex again for moving between its own subhexes would
    // double-count the crossing — a hex entered through its sea half and left from its river half
    // must still cost exactly one hex of sailing.
    for (const [a, b] of regionAdj(h)) {
      if (a === ri && regSail(region(h, b)) && waterLink(h, ri, h, b)) out.push({ toH: h, toRi: b, af: 1, ships: 1, g: 0, irl: 0, note: 'sail (within hex)' });
      if (b === ri && regSail(region(h, a)) && waterLink(h, ri, h, a)) out.push({ toH: h, toRi: a, af: 1, ships: 1, g: 0, irl: 0, note: 'sail (within hex)' });
    }
    // Ashore inside this hex. Needs a port — unless the army is Marines, who land anywhere.
    if (isPort(h) || o.marines) for (const [a, b] of regionAdj(h)) {
      if (a === ri && regWalkable(region(h, b))) out.push({ toH: h, toRi: b, af: 0, ships: 1, g: 0, irl: DISEMBARK, note: DISEMBARK_NOTE });
      if (b === ri && regWalkable(region(h, a))) out.push({ toH: h, toRi: a, af: 0, ships: 1, g: 0, irl: DISEMBARK, note: DISEMBARK_NOTE });
    }
    for (const { n, e } of N) {
      if (!(isPort(n) || o.marines) || !regionOnEdge(h, ri, e)) continue;
      const rs = regionsOf(n);
      for (let rj = 0; rj < rs.length; rj++) if (regWalkable(rs[rj]) && regionOnEdge(n, rj, e))
        out.push({ toH: n, toRi: rj, af: 0, ships: 1, g: 0, irl: SHIP_IRL + DISEMBARK, note: DISEMBARK_NOTE });
    }
    return out;
  }
  // on land (af === 0)
  // Cross to the other bank of a major river that cuts this hex. Only where a road bridges it, and
  // free — one hex is one hex, the cost of a hex is paid by the step that enters it. With no bridge
  // there is simply no move, which is what makes the far bank unreachable without going round.
  const br = S.adj.bridged.get(h);
  if (br) for (const [a, b] of S.adj.sub.get(h)?.riverPairs || []) {
    const to = a === ri ? b : b === ri ? a : -1;
    if (to < 0 || !regWalkable(region(h, to))) continue;
    // Drawn over the bridge, not between the two banks' middles — otherwise the line meets the water
    // wherever those middles happen to line up, which is exactly the crossing that isn't there.
    // Free, but not *quite* free: a hair of cost so that crossing loses every tie against not
    // crossing. Both a bridge and a ferry are free by the rules, so "over the river and straight
    // back" cost exactly what staying on one bank cost, and the search was as happy to pick it.
    out.push({ toH: h, toRi: to, af: 0, ships: 0, g: 0, irl: NUDGE, note: 'bridge (within hex)',
               geom: [...ferryRoad(br, nodePoint(h, ri)), nodePoint(h, to)] });
  }
  const grpH = S.adj.hexRoadGroup.get(h);  // Map(roadId -> group) for this hex, or undefined
  for (const { n, e } of N) {
    if (!regionOnEdge(h, ri, e)) continue;
    const rs = regionsOf(n), grpN = S.adj.hexRoadGroup.get(n);
    // which roads actually cross this edge, and are joinable given the group we're on
    const fis = S.adj.roadPairFi.get(pairKey(h, n));
    const usable = [];
    if (fis) for (const fi of fis) {
      const gAtH = grpH?.get(fi) || 0;
      if (g !== 0 && g !== gAtH) continue;   // already on a road: only its own group is joinable
      // Joining a road you are not already on means walking to it across this hex, and a major river
      // is a barrier there exactly as it is between hexes: it is only crossed at a bridge. Without
      // this, a column standing on one bank could step onto a road on the other and be away, having
      // forded nothing — the crossing never showed up because both hex centres sit on the same side.
      if (g === 0 && roadUnreachable(h, ri, n, fi)) continue;
      usable.push(fi);
    }
    const ferried = S.adj.ferry.has(pairKey(h, n));
    for (let rj = 0; rj < rs.length; rj++) {
      if (!regWalkable(rs[rj])) continue;
      // Same bank: the two regions face each other along the edge, and no water is involved. Facing
      // banks that DON'T meet are a crossing — possible only where a ferry serves this edge, and only
      // between regions that both actually reach it.
      const meet = regionsMeet(h, ri, n, rj) && !S.adj.riverEdge.has(pairKey(h, n));
      const crossMajor = !meet;
      if (crossMajor && !(ferried && regionOnEdge(n, rj, e))) continue;
      // off-road step is always available (slower, no road bonus), and drops us off any road (g:0)
      const off = landStep(h, n, o, false, crossMajor);
      // A ferry step bends through the crossing itself, so the drawn line meets the water where the
      // road does and nowhere else. Just the one vertex, then on to the destination as usual —
      // splicing in the ferry's road instead let the line wander off the step and, at the end of a
      // route, out past the final waypoint and back.
      if (off) {
        const fa = off.fer ? S.adj.ferryAt.get(pairKey(h, n)) : null;
        let geom;
        // Only draw the crossing when it is genuinely on the way. Whether the river is in the way is
        // decided between hex centres, but the line is drawn between subhex centroids — and at a
        // stronghold, its marker — so the crossing can end up behind where this step sets off. Bending
        // through it then would have the route reach backwards to the bridge before setting out.
        if (fa && onWayFrac(fa.pt, nodePoint(h, ri), nodePoint(n, rj)) > 0.05)
          geom = [...ferryRoad(fa, hexCenter(h)), nodePoint(n, rj)];
        out.push({ toH: n, toRi: rj, af: 0, ships: 0, g: 0, irl: off.irl, note: off.note, geom });
      }
      // road steps: one per usable road, tracing that road's drawn geometry, arriving on its group
      for (const fi of usable) {
        const rs2 = landStep(h, n, o, true, crossMajor);
        if (!rs2) continue;
        const ge = S.adj.roadGeomFi.get(pairKey(h, n) + '#' + fi);
        const geom = ge ? (ge.a === h ? ge.pts : [...ge.pts].reverse()) : null;
        out.push({ toH: n, toRi: rj, af: 0, ships: 0, g: grpN?.get(fi) || 0, irl: rs2.irl, note: rs2.note, geom });
      }
    }
  }
  // (No standalone ferry move: a ferry is a property of the road step that crosses a major river,
  // so it is already covered by the road steps above.)
  if (o.embark && isPort(h)) {
    // Two different things, never both: with no fleet you spend a month securing one (and the
    // boarding is folded into that month), while an army that already has ships is simply
    // getting back aboard after a landing, which is the day that gets charged.
    const secure = ships ? 0 : SECURE, board = ships ? EMBARK : 0;
    const pre = secure ? 'secure ships +' + secure + 'd' : 're-embark +' + board + 'd';
    if (regSail(reg)) out.push({ toH: h, toRi: ri, af: 1, ships: 1, g: 0, irl: secure + board, note: pre }); // board a river in place
    for (const [a, b] of regionAdj(h)) { // board an adjacent sea region of this hex
      if (a === ri && regSail(region(h, b))) out.push({ toH: h, toRi: b, af: 1, ships: 1, g: 0, irl: secure + board, note: pre });
      if (b === ri && regSail(region(h, a))) out.push({ toH: h, toRi: a, af: 1, ships: 1, g: 0, irl: secure + board, note: pre });
    }
    for (const { n, e } of N) { // launching from a port: the ship starts in that water, no mouth needed
      if (!regionOnEdge(h, ri, e)) continue;
      const rs = regionsOf(n);
      for (let rj = 0; rj < rs.length; rj++) if (regSail(rs[rj]) && regionOnEdge(n, rj, e))
        out.push({ toH: n, toRi: rj, af: 1, ships: 1, g: 0, irl: secure + board + SHIP_IRL, note: pre + ', sail' });
    }
  }
  if (o.tradeRoad) for (const link of (S.adj.tradeByHex.get(h) || [])) {
    const other = link.a === h ? link.b : link.a;
    if (other === h) continue;
    const mpi = landMilesPerIRL({ road: true, terrain: 'Flatlands', forced: o.forced, liThird: o.liThird, cavOnly: o.cavOnly, weather: o.weather, colMiles: o.colMiles });
    if (mpi <= 0) continue;
    const miles = link.miles ?? (link.chain.length - 1) * RULES.HEX_MILES;
    const chain = link.a === h ? link.chain : [...link.chain].reverse();
    const geomPts = link.a === h ? link.pts : [...link.pts].reverse();
    // Exit into the region the drawn line actually ends in. A split (coast) terminal hex
    // must not dump the army in region 0 / the wrong strip, or the pathfinder detours
    // through a neighbouring hex to reach the intended region. Trade routes are land
    // infrastructure, so fall back to the first walkable region if the endpoint lands in water.
    let toRi = regionAt(other, geomPts[geomPts.length - 1]);
    if (!regWalkable(region(other, toRi))) {
      const w = regionsOf(other).findIndex(regWalkable);
      if (w >= 0) toRi = w;
    }
    out.push({ toH: other, toRi, af: 0, ships: 0, g: 0, irl: miles / mpi,
               note: `trade route (${Math.round(miles)} mi, no stops)`, chain, geom: geomPts,
               hexes: link.hexes, miles });
  }
  return out;
}
// Afloat state a region must be entered in when it isn't a choice (pure sea → 1, pure land → 0).
const forcedAf = r => (r.sea && !r.river) ? 1 : ((!r.sea && !r.river) ? 0 : null);

// Dijkstra over region nodes. Key encodes (hex, region, afloat, ships, roadGroup).
const STATES = [[0, 0], [0, 1], [1, 1]]; // (afloat, ships); afloat ⇒ ships
// A search node packed into one integer: hex, region, afloat, ships, road group. Widths are declared
// once and BOTH the packer and the unpacker are derived from them. Writing the two by hand is how
// widening the region field to 16 slots silently turned every hex id into double itself.
const SKW = { g: 3, sh: 1, af: 1, ri: 4 };
const SK_RI = SKW.af + SKW.sh + SKW.g, SK_AF = SKW.sh + SKW.g, SK_H = SKW.ri + SK_RI;
const sk = (h, ri, af, sh, g) => ((((h << SKW.ri | ri) << SKW.af | af) << SKW.sh | sh) << SKW.g) | g;
const skDec = k => ({ h: k >>> SK_H, ri: (k >>> SK_RI) & ((1 << SKW.ri) - 1), af: (k >>> SK_AF) & 1 });
const MAX_REGIONS = 1 << SKW.ri; // regions per hex the packing can address
function dijkstraField(fromH, fromRi, af0, sh0, o) {
  const dist = new Map(), prev = new Map();
  dist.set(sk(fromH, fromRi, af0, sh0, 0), 0);
  const pq = [[0, fromH, fromRi, af0, sh0, 0]];
  while (pq.length) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
    const [d, h, ri, af, sh, g] = pq.splice(bi, 1)[0];
    const k1 = sk(h, ri, af, sh, g);
    if (d > (dist.get(k1) ?? Infinity)) continue;
    for (const mv of expand(h, ri, af, sh, g, o)) {
      const k2 = sk(mv.toH, mv.toRi, mv.af, mv.ships, mv.g), nd = d + mv.irl;
      if (nd < (dist.get(k2) ?? Infinity)) {
        dist.set(k2, nd);
        prev.set(k2, { k: k1, note: mv.note, irl: mv.irl, chain: mv.chain, geom: mv.geom,
                       hexes: mv.hexes, miles: mv.miles });
        pq.push([nd, mv.toH, mv.toRi, mv.af, mv.ships, mv.g]);
      }
    }
  }
  const dec = skDec;
  const reconstruct = (toH, toRi, af, sh, g) => {
    let cur = sk(toH, toRi, af, sh, g);
    if (!dist.has(cur)) return null;
    const path = [];
    while (cur !== undefined) { path.push(cur); cur = prev.get(cur)?.k; }
    path.reverse();
    return path.map(k => { const d = dec(k); return { h: d.h, ri: d.ri, sea: !!d.af,
      note: prev.get(k)?.note, irl: prev.get(k)?.irl || 0, chain: prev.get(k)?.chain, geom: prev.get(k)?.geom,
      hexes: prev.get(k)?.hexes, miles: prev.get(k)?.miles }; });
  };
  return { dist, sk, reconstruct };
}

// One leg to a fixed destination region; min cost per end (afloat,ships) state, with steps.
// Minimise over the road group at the destination (it doesn't matter which road you arrive on).
function dijkstraLeg(fromH, fromRi, af0, sh0, toH, toRi, o) {
  const F = dijkstraField(fromH, fromRi, af0, sh0, o);
  const out = new Map();
  for (const [af, sh] of STATES) {
    let bestC, bestG;
    for (let g = 0; g < 8; g++) {
      const c = F.dist.get(F.sk(toH, toRi, af, sh, g));
      if (c !== undefined && (bestC === undefined || c < bestC)) { bestC = c; bestG = g; }
    }
    if (bestC !== undefined) out.set(af * 2 + sh, { irl: bestC, steps: F.reconstruct(toH, toRi, af, sh, bestG) });
  }
  return out;
}
// Starting (afloat, ships) for a waypoint region given the fleet toggle.
function startState(h, ri, o) {
  const f = forcedAf(region(h, ri));
  const af = f === null ? (o.fleet ? 1 : 0) : f; // river waypoint: default to fleet toggle
  return [af, (af || o.fleet) ? 1 : 0];
}

const ROUTE_COLORS = ['#ffdf5e', '#ff7ad0', '#6ef3a5', '#7ab8ff', '#ff9d5c', '#c99bff', '#5ce8e8', '#ff6b6b'];

function newRoute() {
  S.routes.push({ name: 'Route ' + (S.routes.length + 1),
                  color: ROUTE_COLORS[S.routes.length % ROUTE_COLORS.length], wps: [] });
  S.activeRoute = S.routes.length - 1;
  computeRoute();
}

// A drawn route joins points that can sit well off-centre in their hexes: a stronghold marker up
// against the rim of one, the end of a road inside the next. Straight between two such points the
// line can leave both hexes and clip the corner of one the column never set foot in — a road ending
// high in hex 1933 drawn on to Časman's keep, high in 1932, passed clean over the top of the edge
// they share and through 1843 above it.
//
// A hex is convex, so touching the line down on the edge the two hexes share settles it for good:
// each half then lies wholly inside one of the two. The touch-down goes where the straight line
// would have crossed that edge, so a line that was already honest doesn't move at all — only one
// pulled back from the corners, where three hexes meet and a stroke of any width would still show
// on the wrong side.
const EDGE_KEEP = 0.06; // fraction of the shared edge left clear at each end when a line is moved

function sharedEdgeTouchdown(a, b, p, q) {
  const [c1, c2] = sharedEdgeCorners(a, b);
  const d1 = [q[0] - p[0], q[1] - p[1]], d2 = [c2[0] - c1[0], c2[1] - c1[1]];
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  let t;
  if (Math.abs(den) < 1e-9) {         // running parallel to the edge: aim at the nearest bit of it
    t = onWayFrac([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], c1, c2);
  } else {
    const r = [c1[0] - p[0], c1[1] - p[1]];
    const s = (r[0] * d2[1] - r[1] * d2[0]) / den;   // how far along p→q the crossing falls
    t = (r[0] * d1[1] - r[1] * d1[0]) / den;         // how far along the edge it falls
    // The line already passes over the shared edge somewhere between the two points, so it never
    // left the pair of hexes and there is nothing to fix. Crossing close to a corner counts: the
    // corner belongs to both hexes, and a road drawn over one must not be nudged off it.
    if (s > 0 && s < 1 && t >= 0 && t <= 1) return null;
  }
  t = Math.min(1 - EDGE_KEEP, Math.max(EDGE_KEEP, t));
  return [c1[0] + d2[0] * t, c1[1] + d2[1] * t];
}
function throughSharedEdges(pts) {
  if (pts.length < 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    const a = nearestHex(p[0], p[1]), b = nearestHex(q[0], q[1]);
    if (a && b && a !== b && neighbors(a).includes(b)) {
      const td = sharedEdgeTouchdown(a, b, p, q);
      // Tidying the geometry must never march the column across a major river it never forded.
      const safe = td && !(!segCrossesMajor(p, q) && (segCrossesMajor(p, td) || segCrossesMajor(td, q)));
      if (safe) out.push(td);
    }
    out.push(q);
  }
  return out;
}

function routeLeg(rt, o) {
  // DP across waypoints over the (afloat, ships) state, jointly optimal for the whole route.
  const wps = rt.wps;
  const [af0, sh0] = startState(wps[0].h, wps[0].ri | 0, o);
  let dp = new Map([[af0 * 2 + sh0, { cost: 0, legs: [] }]]); // stateKey (af*2+sh) -> best {cost, legs}
  let fail = null;
  for (let i = 0; i + 1 < wps.length; i++) {
    const next = new Map();
    for (const [state, cur] of dp) {
      const legs = dijkstraLeg(wps[i].h, wps[i].ri | 0, state >> 1, state & 1, wps[i + 1].h, wps[i + 1].ri | 0, o);
      for (const [stEnd, r] of legs) {
        const nc = cur.cost + r.irl, ex = next.get(stEnd);
        if (!ex || nc < ex.cost) next.set(stEnd, { cost: nc, legs: [...cur.legs, r.steps] });
      }
    }
    if (next.size === 0) { fail = [wps[i].h, wps[i + 1].h]; break; }
    dp = next;
  }
  if (fail) return { irl: 0, hexes: 0, miles: 0, steps: [], pts: [], fail };
  let best = null;
  for (const v of dp.values()) if (!best || v.cost < best.cost) best = v;
  if (!best) return { irl: 0, hexes: 0, miles: 0, steps: [], pts: [], fail: null };

  // The ordered drawn geometry a step traces from prevH into st.h (road or trade line, or a drawn
  // river for a sailing step). null when the step has no feature to follow (plain off-road).
  const stepGeom = (st, prevH) => {
    if (st.geom) return st.geom;            // road step / trade route (already oriented prevH→st.h)
    const key = pairKey(prevH, st.h), note = st.note || '';
    let g = note.startsWith('road') ? S.adj.geom.get(key) : null;
    if (!g && note.includes('sail')) g = S.adj.riverGeom.get(key);
    return g ? (g.a === prevH ? g.pts : [...g.pts].reverse()) : null;
  };
  // Flatten the legs into one step sequence (dropping the duplicated waypoint between legs).
  const flat = [];
  let prevH = null;
  best.legs.forEach((legSteps, i) => {
    for (let j = 0; j < legSteps.length; j++) {
      const st = legSteps[j];
      if (i > 0 && j === 0) { prevH = st.h; continue; }
      // The last step of a leg is a waypoint you placed — a stop, not somewhere the line merely
      // passes through — so it gets anchored like the route's two ends do.
      flat.push({ st, prevH, first: i === 0 && j === 0, wp: j === legSteps.length - 1 });
      prevH = st.h;
    }
  });
  let totHex = 0, totMiles = 0; const steps = [], allPts = [];
  for (let idx = 0; idx < flat.length; idx++) {
    const { st, prevH: ph, first, wp } = flat[idx];
    // A waypoint is a place the column actually stops, so the line goes to its stronghold marker if
    // it has one — the same anchoring the route's start and end have always had.
    const anchor = wp ? endPoint(st.h, st.ri) : nodePoint(st.h, st.ri);
    steps.push(st);
    if (first) { allPts.push(endPoint(st.h, st.ri)); continue; }
    if (st.h !== ph) { // a trade hop covers several hexes at once and knows its own real length
      const nh = st.hexes ?? (st.chain ? st.chain.length - 1 : 1);
      totHex += nh;
      totMiles += st.miles ?? nh * RULES.HEX_MILES;
    }
    // When the *next* step only moves to another part of this same hex — embarking into its sea
    // subhex, crossing its bridge — the node this step lands on is not on the way to anything. The
    // column is arriving at the hex, and where in the hex it ends up is the next step's business.
    // Drawing to it first and away again is what put a spike in the line at Kisra.
    const nxt = flat[idx + 1];
    const staysInHex = nxt && nxt.st.h === st.h;
    const gpts = stepGeom(st, ph);
    if (gpts) {
      // A crossing's geometry is the road over the water, then the node it lands on. That last point
      // is only a default — if anything follows, the next step's point should stand instead. Going
      // via the node puts a jog in the line the moment the node lies off to one side, which is what
      // it does coming off a bridge. A road's geometry ends on the road itself, so it is left alone.
      const np = nodePoint(st.h, st.ri), last = gpts[gpts.length - 1];
      const landsOnNode = gpts.length > 1 && Math.hypot(last[0] - np[0], last[1] - np[1]) < 0.01;
      if (landsOnNode && wp) { allPts.push(...gpts.slice(0, -1), anchor); continue; } // stop at the marker
      allPts.push(...(nxt && landsOnNode ? gpts.slice(0, -1) : gpts));
      continue;
    }
    if (wp) { allPts.push(anchor); continue; } // a stop is reached, never cut past or shortcut to
    if (staysInHex) continue;
    // Off-road / plain march (no feature to trace). If the next step rejoins a drawn feature
    // (a road), aim straight at where we rejoin it — its nearest end in this hex — rather than
    // detouring through the hex centroid, which leaves a jagged corner at the point of diversion.
    let joinPt = null;
    if (nxt) {
      const ng = stepGeom(nxt.st, st.h);
      if (ng && ng.length) joinPt = ng[0];
    }
    allPts.push(joinPt || anchor);
  }
  // A geometry step (sailing a river, or a road) ends at the feature's mid-hex point, which can
  // stop short of the destination hex's node point (its marker) — e.g. getting off a river into
  // the hex left the final leg undrawn. Connect the line to the last waypoint's marker.
  if (flat.length) {
    const last = flat[flat.length - 1].st, np = endPoint(last.h, last.ri), lp = allPts[allPts.length - 1];
    if (!lp || Math.hypot(lp[0] - np[0], lp[1] - np[1]) > 0.5) allPts.push(np);
  }
  return { irl: best.cost, hexes: totHex, miles: totMiles, steps, pts: throughSharedEdges(allPts), fail: null };
}

/* ---------------- isochrone ---------------- */
function hpush(a, x) {
  a.push(x); let i = a.length - 1;
  while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
}
function hpop(a) {
  const t = a[0], l = a.pop();
  if (a.length) {
    a[0] = l;
    for (let i = 0; ;) {
      const c1 = 2 * i + 1, c2 = c1 + 1; let m = i;
      if (c1 < a.length && a[c1][0] < a[m][0]) m = c1;
      if (c2 < a.length && a[c2][0] < a[m][0]) m = c2;
      if (m === i) break;
      [a[i], a[m]] = [a[m], a[i]]; i = m;
    }
  }
  return t;
}

// Travel time from `from` to every reachable hex within maxD IRL days (min over fleet states).
function dijkstraAll(fromNode, o, maxD) {
  const dist = new Map(), best = new Map();
  const r0 = fromNode.ri | 0, [af0, sh0] = startState(fromNode.h, r0, o);
  dist.set(sk(fromNode.h, r0, af0, sh0, 0), 0);
  const heap = [[0, fromNode.h, r0, af0, sh0, 0]];
  while (heap.length) {
    const [d, h, ri, af, sh, g] = hpop(heap);
    if (d > (dist.get(sk(h, ri, af, sh, g)) ?? Infinity)) continue;
    if (d < (best.get(h) ?? Infinity)) best.set(h, d);
    if (d > maxD) continue;
    for (const mv of expand(h, ri, af, sh, g, o)) {
      const k2 = sk(mv.toH, mv.toRi, mv.af, mv.ships, mv.g), nd = d + mv.irl;
      if (nd < (dist.get(k2) ?? Infinity)) { dist.set(k2, nd); hpush(heap, [nd, mv.toH, mv.toRi, mv.af, mv.ships, mv.g]); }
    }
  }
  return best;
}

// Straight-line ("as the crow flies") spread from an origin hex to every hex within
// maxD IRL days, at a fixed miles/IRL-day speed. Terrain, roads and rivers are ignored
// — this mirrors the Google-Sheet straight-line calc used for messages & rumours.
// Returns Map<hexId, irlDays>, same shape as dijkstraAll.
function spreadAll(fromNode, speedMiPerDay, maxD) {
  const pxPerMile = S.G.hex_width / RULES.HEX_MILES;   // hex_width px == HEX_MILES miles
  const maxPx = maxD * speedMiPerDay * pxPerMile;
  const [ox, oy] = hexCenter(fromNode.h);
  const best = new Map();
  for (const idS in S.hexes) {
    const id = +idS;
    const [cx, cy] = hexCenter(id);
    const px = Math.hypot(cx - ox, cy - oy);
    if (px > maxPx) continue;
    const miles = px / pxPerMile;
    best.set(id, miles / speedMiPerDay);
  }
  return best;
}

function isoColor(b, n) {
  const t = n <= 1 ? 0 : b / (n - 1);
  return `hsl(${Math.round(130 - 130 * t)},75%,48%)`;
}

function renderIso() {
  groups.iso.innerHTML = '';
  const lg = document.getElementById('isoLegend');
  lg.innerHTML = '';
  if (!S.iso.origin || !S.iso.data) return;
  const band = +document.getElementById('isoBand').value || 1;
  const maxD = +document.getElementById('isoMax').value || 14;
  const n = Math.max(1, Math.ceil(maxD / band));
  const byBand = [];
  for (const [h, d] of S.iso.data) {
    if (d > maxD) continue;
    const b = Math.min(n - 1, Math.floor(d / band));
    const [cx, cy] = hexCenter(h);
    byBand[b] = (byBand[b] || '') + hexPath(cx, cy);
  }
  byBand.forEach((d, b) => { if (d) el('path', { d, fill: isoColor(b, n), stroke: 'none' }, groups.iso); });
  const [ox, oy] = nodePoint(S.iso.origin.h, S.iso.origin.ri | 0);
  el('circle', { cx: ox, cy: oy, r: 5.5, fill: '#fff', stroke: '#000', 'stroke-width': 1.6 }, groups.iso);
  for (let b = 0; b < n; b++) {
    const div = document.createElement('div');
    div.className = 'isochip';
    div.innerHTML = `<span class="sw" style="background:${isoColor(b, n)}"></span>≤ ${((b + 1) * band).toFixed(band < 1 ? 1 : 0)} d`;
    lg.appendChild(div);
  }
}

function computeRoute() {
  const out = document.getElementById('routeOut');
  groups.route.innerHTML = '';
  saveRoutes();
  if (!S.adj) deriveAdj();
  // migrate legacy waypoints (number, or {h,sea}) to region nodes {h, ri}
  for (const rt of S.routes) rt.wps = rt.wps.map(w => {
    if (typeof w === 'number') return { h: w, ri: 0 };
    if (w.ri === undefined) { const ri = regionsOf(w.h).findIndex(r => !!r.sea === !!w.sea); return { h: w.h, ri: ri < 0 ? 0 : ri }; }
    return w;
  });
  if (S.iso.origin && S.iso.origin.ri === undefined)
    S.iso.origin = { h: S.iso.origin.h, ri: Math.max(0, regionsOf(S.iso.origin.h).findIndex(r => !!r.sea === !!S.iso.origin.sea)) };
  const o = armyOpts();
  const isoMode = document.getElementById('isoMode')?.value || 'army';
  const isoMax = +document.getElementById('isoMax').value || 14;
  if (S.iso.origin) {
    if (isoMode === 'message') S.iso.data = spreadAll(S.iso.origin, RULES.SPREAD.message, isoMax);
    else if (isoMode === 'rumour') S.iso.data = spreadAll(S.iso.origin, RULES.SPREAD.rumour, isoMax);
    else S.iso.data = dijkstraAll(S.iso.origin, o, isoMax);
  } else S.iso.data = null;
  renderIso();
  const results = [];
  S.routes.forEach((rt, i) => {
    const act = i === S.activeRoute;
    rt.wps.forEach(w => {
      const [cx, cy] = endPoint(w.h, w.ri | 0); // every waypoint is a stop, and stops sit at the marker
      const sea = !!(region(w.h, w.ri | 0)?.sea && !region(w.h, w.ri | 0)?.river);
      el('circle', { cx, cy, r: act ? 6 : 5, fill: sea ? rt.color : 'none', stroke: rt.color,
                     'stroke-width': act ? 2.4 : 1.8, opacity: act ? 1 : 0.7 }, groups.route);
    });
    const r = rt.wps.length > 1 ? routeLeg(rt, o) : null;
    if (r && r.pts.length > 1)
      el('path', { d: featPathD(r.pts), fill: 'none', stroke: rt.color, 'stroke-width': act ? 2.8 : 2,
                   'stroke-dasharray': '7,5', 'stroke-linecap': 'round', opacity: act ? 0.95 : 0.55 }, groups.route);
    results.push(r);
  });
  renderRouteList(results);
  const rt = S.routes[S.activeRoute], r = results[S.activeRoute];
  if (!rt) { out.innerHTML = ''; return; }
  if (rt.wps.length < 2) { out.innerHTML = '<div class="hint">Add a destination hex.</div>'; return; }
  if (r.fail) {
    out.innerHTML = `<div class="err">${rt.name}: no possible route between hex ${r.fail[0]} and hex ${r.fail[1]} with these settings ` +
      `(water without embark or a trade route, blizzard off-road, a major river with no road across it, or weather forbids fording).</div>`;
    return;
  }
  const game = r.irl * RULES.GAME_DAYS_PER_IRL;
  let cum = 0;
  let prevH = null;
  const rows = r.steps.map((st, j) => {
    cum += st.irl;
    const name = S.features.labels[st.h] ?? S.names.hexes[st.h];
    const hexLbl = (name ? name + ' ' : '') + st.h;
    const base = S.hexes[st.h].t;
    const terr = (st.sea ? (RULES.WATER.has(base) ? base : 'Sea subhex') : (RULES.WATER.has(base) ? 'Land subhex' : base)) +
                 (hasStronghold(st.h) ? ' ⌂' : '');
    const sameHex = st.h === prevH; prevH = st.h;
    if (j === 0) return `<tr><td>${hexLbl}</td><td class="dim">${terr}</td><td class="dim">start</td><td></td><td></td></tr>`;
    return `<tr><td>${sameHex ? '' : hexLbl}</td><td class="dim">${terr}</td><td>${st.note || ''}</td>` +
           `<td>+${st.irl.toFixed(2)}</td><td>${cum.toFixed(1)}</td></tr>`;
  }).join('');
  // Cavalry-only forced-march ×2: show whether it's active, or why not (baggage present).
  const wForced = (RULES.WEATHER[o.weather] || RULES.WEATHER.clear).forced;
  let paceRow = '';
  if (o.cavOnly && o.forced && wForced)
    paceRow = `<tr><td>Pace</td><td><span style="color:#6ef3a5">exclusively cavalry — forced ×2 speed</span></td></tr>`;
  else if (o.forced && o.army.inf === 0 && o.army.cav > 0 && o.army.wag)
    paceRow = `<tr><td>Pace</td><td><span class="warn">not cavalry-only (wagons) — no ×2. Zero them for the bonus.</span></td></tr>`;
  out.innerHTML =
    `<div class="big" style="color:${rt.color}">${rt.name}: ${r.irl.toFixed(1)} IRL days <span style="color:#9aa4b2">(${game.toFixed(0)} in-game)</span></div>` +
    `<table><tr><td>Distance</td><td>${r.hexes} hexes ≈ ${Math.round(r.miles ?? r.hexes * RULES.HEX_MILES)} mi</td></tr>` +
    `<tr><td>Column</td><td>${o.colMiles.toFixed(1)} mi${o.colMiles > RULES.LONG_COLUMN.limit ? ' <span class="warn">(over 6 mi — slowed)</span>' : ''}</td></tr>${paceRow}</table>` +
    `<div class="steps"><table class="stepstbl">` +
    `<tr class="hd"><td>Hex</td><td>Terrain</td><td>Via</td><td>+IRL d</td><td>Σ</td></tr>` +
    rows + `</table></div>`;
}

function renderRouteList(results) {
  const list = document.getElementById('routeList');
  list.innerHTML = '';
  S.routes.forEach((rt, i) => {
    const div = document.createElement('div');
    div.className = 'rtitem' + (i === S.activeRoute ? ' on' : '');
    const r = results[i];
    const tm = r ? (r.fail ? '✗' : r.irl.toFixed(1) + 'd') : rt.wps.length + ' wp';
    div.innerHTML = `<span class="sw" style="background:${rt.color}" title="Cycle color"></span>` +
      `<span class="nm" title="Click to activate, double-click to rename">${rt.name}</span>` +
      `<span class="tm">${tm}</span><span class="x" title="Delete route">×</span>`;
    div.querySelector('.sw').onclick = e => {
      e.stopPropagation();
      rt.color = ROUTE_COLORS[(ROUTE_COLORS.indexOf(rt.color) + 1) % ROUTE_COLORS.length];
      computeRoute();
    };
    div.querySelector('.x').onclick = e => {
      e.stopPropagation();
      S.routes.splice(i, 1);
      if (S.activeRoute >= S.routes.length) S.activeRoute = S.routes.length - 1;
      computeRoute();
    };
    div.querySelector('.nm').ondblclick = e => {
      e.stopPropagation();
      const n = prompt('Route name:', rt.name);
      if (n) { rt.name = n; computeRoute(); }
    };
    div.onclick = () => { S.activeRoute = i; computeRoute(); };
    list.appendChild(div);
  });
  updateDrawerBadge(results);
}

function saveRoutes() {
  try { localStorage.setItem('rotmap_routes_v1', JSON.stringify({ routes: S.routes, active: S.activeRoute })); } catch {}
}

/* ---------------- interactions ---------------- */
let pan = null, downPos = null, spaceHeld = false, edgeSnap = false;

// Touch: every live pointer is tracked so that a second finger can be recognised as a pinch. A
// finger also needs more slack than a mouse before a press counts as a drag rather than a tap —
// nobody holds a thumb within 5px while tapping.
const ptrs = new Map();
let pinch = null;      // { d, vb, wx, wy } — finger distance and viewBox as the gesture began
let tapDead = false;   // a pinch happened; ignore the taps as the fingers come off
const tapSlop = e => (e.pointerType === 'mouse' ? 5 : 12);

function twoFingers() {
  const [a, b] = [...ptrs.values()];
  return { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
}
function startPinch() {
  pan = null; S.dragErase = null;
  const m = twoFingers();
  const [wx, wy] = toWorld(m);
  pinch = { d: m.d, vb: { ...S.vb }, wx, wy };
  tooltip.hidden = true; groups.hover.innerHTML = '';
}
function movePinch() {
  const m = twoFingers();
  if (!m.d || !pinch.d) return;
  const r = svg.getBoundingClientRect();
  const w = Math.min(9000, Math.max(80, pinch.vb.w * pinch.d / m.d));  // fingers apart => narrower viewBox
  const h = pinch.vb.h * (w / pinch.vb.w);
  const s = Math.min(r.width / w, r.height / h);
  const ox = (r.width - w * s) / 2, oy = (r.height - h * s) / 2;
  // Keep the world point that was under the fingers pinned to their midpoint, so the gesture zooms
  // and pans at once — the same anchoring the wheel handler does around the cursor.
  S.vb.x = pinch.wx - (m.clientX - r.left - ox) / s;
  S.vb.y = pinch.wy - (m.clientY - r.top - oy) / s;
  S.vb.w = w; S.vb.h = h;
  applyViewBox();
}
function dropPointer(e) {
  ptrs.delete(e.pointerId);
  if (pinch && ptrs.size < 2) { pinch = null; pan = null; }
}
svg.addEventListener('wheel', e => {
  e.preventDefault();
  const [wx, wy] = toWorld(e);
  const f = e.deltaY > 0 ? 1.18 : 1 / 1.18;
  const nw = Math.min(9000, Math.max(80, S.vb.w * f));
  const k = nw / S.vb.w;
  S.vb.x = wx - (wx - S.vb.x) * k;
  S.vb.y = wy - (wy - S.vb.y) * k;
  S.vb.w = nw; S.vb.h *= k;
  applyViewBox();
}, { passive: false });

// Belt and braces with the `user-select: none` in the stylesheet: a shift-click on the map used to
// extend whatever selection existed into the SVG and light up every stronghold label, so drop any
// live selection on mouse-down and refuse to start a new one here.
svg.addEventListener('selectstart', e => e.preventDefault());
svg.addEventListener('pointerdown', e => {
  const sel = window.getSelection?.();
  if (sel && !sel.isCollapsed) sel.removeAllRanges();
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) { startPinch(); tapDead = true; return; }
  if (ptrs.size > 2) return;
  tapDead = false;
  downPos = [e.clientX, e.clientY];
  if (e.button === 0 && S.mode === 'draw' && S.tool === 'erase') {
    S.dragErase = { undoPushed: false };
    svg.setPointerCapture(e.pointerId);
    return;
  }
  // Left-drag pans. A click only counts if the pointer barely moved (see pointerup), so this never
  // steals a waypoint — and it is what View mode used to be for. On touch a one-finger drag always
  // pans, draw mode included: there points are placed by tapping, so nothing is lost.
  if (e.button === 1 || spaceHeld || e.pointerType !== 'mouse' || (e.button === 0 && S.mode !== 'draw')) {
    pan = { x: e.clientX, y: e.clientY, vb: { ...S.vb } };
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});
svg.addEventListener('pointermove', e => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch) { if (ptrs.size >= 2) movePinch(); return; }
  if (pan) {
    const r = svg.getBoundingClientRect();
    const s = Math.min(r.width / S.vb.w, r.height / S.vb.h);
    S.vb.x = pan.vb.x - (e.clientX - pan.x) / s;
    S.vb.y = pan.vb.y - (e.clientY - pan.y) / s;
    applyViewBox();
    return;
  }
  if (S.dragErase && (e.buttons & 1) && Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > tapSlop(e)) {
    const [wx, wy, s] = toWorld(e);
    eraseWholeAt(wx, wy, s);
    return;
  }
  onHover(e);
});
svg.addEventListener('pointerup', e => {
  // A pinch must not leave a tap behind as the fingers lift, one after the other.
  const afterPinch = !!pinch || tapDead;
  dropPointer(e);
  if (afterPinch) {
    pan = null; S.dragErase = null; downPos = null;
    if (!ptrs.size) tapDead = false;
    return;
  }
  if (pan) {
    // A left-press starts a pan optimistically, since it can't yet be known whether it will turn
    // into a drag. If the pointer never really moved it was a click after all, so fall through and
    // let it place a waypoint. Middle-button and space-held drags are only ever panning.
    const moved = !downPos || Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > tapSlop(e);
    pan = null;
    if (moved || e.button !== 0 || spaceHeld) return;
  }
  if (S.dragErase) {
    const dr = S.dragErase; S.dragErase = null;
    if (dr.undoPushed) { if (S.needRecompute) { computeRoute(); S.needRecompute = false; } return; } // was a drag wipe
    // otherwise fall through: treat as a normal single click (granular erase)
  }
  if (!downPos || Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > tapSlop(e)) return;
  if (e.button !== 0) return;
  const [wx, wy, s] = toWorld(e);
  if (S.mode === 'draw') drawClick(wx, wy, s, e);
  else if (S.mode === 'route') {
    const h = nearestHex(wx, wy);
    if (!h) return;
    if (!S.adj) deriveAdj();
    const ri = regionAt(h, [wx, wy]); // pick the subhex region where the click landed
    if (S.isoPick || e.shiftKey) {
      S.iso.origin = { h, ri }; S.isoPick = false;
      document.getElementById('isoPick').classList.remove('on');
      computeRoute();
      return;
    }
    if (S.activeRoute < 0) newRoute();
    S.routes[S.activeRoute].wps.push({ h, ri });
    computeRoute();
  }
});
// A cancelled pointer (the browser taking over the gesture, a call coming in) never sends pointerup.
svg.addEventListener('pointercancel', e => {
  dropPointer(e);
  if (!ptrs.size) { pan = null; tapDead = false; S.dragErase = null; downPos = null; }
});
svg.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (S.mode === 'route' && S.activeRoute >= 0 && S.routes[S.activeRoute].wps.length) {
    S.routes[S.activeRoute].wps.pop(); computeRoute();
  }
  else if (S.mode === 'draw' && S.drawing) finishDrawing();
});
svg.addEventListener('dblclick', e => {
  if (S.mode === 'draw' && S.drawing) {
    if (S.drawing.pts.length > 1) S.drawing.pts.pop(); // dblclick added a dup
    finishDrawing();
  }
});

function drawClick(wx, wy, scale, e) {
  if (S.tool === 'erase') {
    const thr = 8 / scale * 1.5 + 3;
    // strongholds (custom placements/flags AND datasheet ones) — nearest marker wins over lines
    const { id: bs, d: bsd } = nearestStronghold(wx, wy, thr);
    // per-feature min distance; among near-ties, the most recently drawn wins (helps with stacked lines)
    const dists = S.features.features.map(f => {
      let m = Infinity;
      for (let k = 0; k + 1 < f.pts.length; k++)
        m = Math.min(m, distToSeg(wx, wy, f.pts[k][0], f.pts[k][1], f.pts[k + 1][0], f.pts[k + 1][1]));
      return m;
    });
    let bi = -1, bd = thr;
    const minD = Math.min(thr, ...dists);
    if (minD < thr) {
      bd = minD;
      for (let i = 0; i < dists.length; i++) if (dists[i] < minD + 0.8) bi = i;
    }
    if (bs !== null && bsd <= bd) {
      pushUndo();
      const wasSheet = removeStronghold(bs);
      commitFeatures();
      document.getElementById('saveInfo').textContent = wasSheet
        ? `Hex ${bs}: datasheet stronghold removed (Ctrl+Z or the Stronghold tool restores it).`
        : `Hex ${bs}: stronghold removed.`;
      return;
    }
    if (bi >= 0) {
      pushUndo();
      const f = S.features.features[bi];
      const tname = f.type.replace('_', ' ');
      let msg;
      if (e.shiftKey) {
        S.features.features.splice(bi, 1);
        msg = `Removed whole ${tname}.`;
      } else {
        let vi = -1, vd = Infinity;
        f.pts.forEach((p, k) => { const d = Math.hypot(wx - p[0], wy - p[1]); if (d < vd) { vd = d; vi = k; } });
        if (vd < thr * 0.8) { // clicked a node: remove just that vertex
          f.pts.splice(vi, 1);
          if (f.pts.length < 2) { S.features.features.splice(bi, 1); msg = `Removed last node — ${tname} deleted.`; }
          else msg = `Removed a node of ${tname}.`;
        } else { // clicked between nodes: remove that segment, splitting the line
          let si = 0, sd = Infinity;
          for (let k = 0; k + 1 < f.pts.length; k++) {
            const d = distToSeg(wx, wy, f.pts[k][0], f.pts[k][1], f.pts[k + 1][0], f.pts[k + 1][1]);
            if (d < sd) { sd = d; si = k; }
          }
          const parts = [f.pts.slice(0, si + 1), f.pts.slice(si + 1)]
            .filter(p => p.length > 1).map(p => ({ ...f, pts: p }));
          S.features.features.splice(bi, 1, ...parts);
          msg = `Removed a segment of ${tname}${parts.length === 2 ? ' (split in two)' : ''}.`;
        }
      }
      commitFeatures();
      document.getElementById('saveInfo').textContent = msg + ' Shift+click erases a whole line.';
    }
    return;
  }
  if (S.tool === 'stronghold') {
    const h = nearestHex(wx, wy);
    if (!h) return;
    pushUndo();
    const sh = S.features.strongholds[h] || (S.features.strongholds[h] = {});
    delete sh.removed; // interacting with the Stronghold tool (re)adds a previously removed one
    let msg;
    if (e.shiftKey) {
      sh.coastal = !isPort(h);
      msg = `Hex ${h}: now ${sh.coastal ? 'coastal (port — can embark/disembark)' : 'inland (no port)'}.`;
    } else {
      const p = e.altKey ? [wx, wy] : (snapPoint(wx, wy, 14, scale) || [wx, wy]);
      sh.x = +p[0].toFixed(1); sh.y = +p[1].toFixed(1);
      msg = `Hex ${h}: stronghold marker placed.`;
    }
    commitFeatures();
    document.getElementById('saveInfo').textContent = msg;
    return;
  }
  if (S.tool === 'label') {
    const h = nearestHex(wx, wy);
    if (!h) return;
    const cur = S.features.labels[h] ?? S.names.hexes[h] ?? '';
    const name = prompt(`Name for hex ${h}${hasStronghold(h) ? ' (stronghold)' : ''} — rename or clear:`, cur);
    if (name === null) return;
    pushUndo();
    if (name.trim()) S.features.labels[h] = name.trim();
    else delete S.features.labels[h];
    commitFeatures();
    return;
  }
  // Coast: locked to a single hex. Sea-pick / re-pick happen only when not mid-draw.
  if (S.tool === 'coast') {
    if (!S.drawing) {
      if (S.coastPickFor) { pickCoastSide(S.coastPickFor, wx, wy); return; }
      if (e.shiftKey) { // re-pick an existing coast's sea side
        const thr = 8 / scale * 1.5 + 4;
        let best = null, bd = thr;
        for (const f of S.features.features) {
          if (f.type !== 'coast') continue;
          for (let k = 0; k + 1 < f.pts.length; k++) {
            const d = distToSeg(wx, wy, f.pts[k][0], f.pts[k][1], f.pts[k + 1][0], f.pts[k + 1][1]);
            if (d < bd) { bd = d; best = f; }
          }
        }
        if (best) { pickCoastSide(best, wx, wy); return; }
      }
      const lh = nearestHex(wx, wy);
      if (!lh) return;
      S.drawing = { type: 'coast', hex: lh, pts: [] };
    }
    const cp = e.altKey ? [wx, wy] : (edgeSnap ? snapToEdge(wx, wy, S.drawing.hex) : snapInHex(wx, wy, S.drawing.hex));
    const cpts = S.drawing.pts;
    if (closesRing(cp)) { // clicked the starting node: seal the island and go straight to sea-picking
      cpts.push([cpts[0][0], cpts[0][1]]);
      renderDrawing();
      finishDrawing();
      return;
    }
    if (!cpts.length || cpts[cpts.length - 1][0] !== cp[0] || cpts[cpts.length - 1][1] !== cp[1]) cpts.push(cp);
    renderDrawing();
    return;
  }
  const eh = nearestHex(wx, wy);
  const p = e.altKey ? [wx, wy] : (edgeSnap && eh ? snapToEdge(wx, wy, eh) : (snapPoint(wx, wy, 14, scale) || [wx, wy]));
  if (!S.drawing) S.drawing = { type: S.tool, pts: [] };
  const pts = S.drawing.pts;
  if (pts.length) { // only one hex ahead per click, so nothing gets skipped
    const last = pts[pts.length - 1];
    // points on a hex boundary (edge/vertex snaps) resolve to ambiguous hexes, so also accept
    // any point within ~one hex-width — that can never skip a hex.
    const near = Math.hypot(p[0] - last[0], p[1] - last[1]) <= S.G.hex_width * 1.05;
    const hA = nearestHex(last[0], last[1]), hB = nearestHex(p[0], p[1]);
    if (!near && hA !== hB && !neighbors(hA).includes(hB)) { flashReject(p); return; }
  }
  if (!pts.length || pts[pts.length - 1][0] !== p[0] || pts[pts.length - 1][1] !== p[1]) pts.push(p);
  renderDrawing();
}
// A new river may not lie on top of an existing river (e.g. same edge as both minor and major).
// Slight touches (tributaries joining) are fine; substantial overlap is rejected.
function overlappingRiver(nf) {
  if (nf.type !== 'river_major' && nf.type !== 'river_minor') return null;
  const samples = [];
  for (let i = 0; i + 1 < nf.pts.length; i++) {
    const [ax, ay] = nf.pts[i], [bx, by] = nf.pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / 3));
    for (let k = 0; k <= n; k++) samples.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  for (const f of S.features.features) {
    if (f.type !== 'river_major' && f.type !== 'river_minor') continue;
    let on = 0;
    for (const [px, py] of samples) {
      for (let k = 0; k + 1 < f.pts.length; k++)
        if (distToSeg(px, py, f.pts[k][0], f.pts[k][1], f.pts[k + 1][0], f.pts[k + 1][1]) < 1.2) { on++; break; }
    }
    if (on / samples.length > 0.4) return f;
  }
  return null;
}

function flashReject(p) {
  const c = el('circle', { cx: p[0], cy: p[1], r: 6, fill: 'none', stroke: '#e5695e', 'stroke-width': 2 }, groups.hover);
  setTimeout(() => c.remove(), 450);
}
// Drag-erase: remove the whole nearest feature / stronghold under the cursor (defers route recompute).
function eraseWholeAt(wx, wy, scale) {
  const thr = 8 / scale * 1.5 + 3;
  const { id: bs, d: bsd } = nearestStronghold(wx, wy, thr);
  let bi = -1, bd = thr;
  S.features.features.forEach((f, i) => {
    for (let k = 0; k + 1 < f.pts.length; k++) {
      const d = distToSeg(wx, wy, f.pts[k][0], f.pts[k][1], f.pts[k + 1][0], f.pts[k + 1][1]);
      if (d < bd) { bd = d; bi = i; }
    }
  });
  if (bs === null && bi < 0) return; // nothing under cursor
  if (S.dragErase && !S.dragErase.undoPushed) { pushUndo(); S.dragErase.undoPushed = true; }
  if (bs !== null && bsd <= bd) removeStronghold(bs);
  else S.features.features.splice(bi, 1);
  renderFeatures(); renderLabels(); saveLocal(); S.needRecompute = true;
}
function finishDrawing() {
  if (S.drawing && S.drawing.pts.length > 1) {
    const ov = overlappingRiver(S.drawing);
    if (ov) {
      S.drawing = null;
      groups.edit.innerHTML = '';
      document.getElementById('saveInfo').textContent =
        `Rejected: overlaps an existing ${ov.type === 'river_major' ? 'major' : 'minor'} river — erase that first.`;
      return;
    }
    pushUndo();
    const drawn = S.drawing;
    S.features.features.push(drawn);
    S.drawing = null;
    groups.edit.innerHTML = '';
    commitFeatures();
    if (drawn.type === 'coast') {
      S.coastPickFor = drawn;
      document.getElementById('saveInfo').textContent = 'Coast drawn — click the side that is SEA.';
    }
  } else { S.drawing = null; groups.edit.innerHTML = ''; }
}
// Set which side of a coast feature is sea, from a clicked point.
function pickCoastSide(f, wx, wy) {
  let si = 0, sd = Infinity;
  for (let k = 0; k + 1 < f.pts.length; k++) {
    const d = distToSeg(wx, wy, f.pts[k][0], f.pts[k][1], f.pts[k + 1][0], f.pts[k + 1][1]);
    if (d < sd) { sd = d; si = k; }
  }
  const a = f.pts[si], b = f.pts[si + 1];
  const cross = (b[0] - a[0]) * (wy - a[1]) - (b[1] - a[1]) * (wx - a[0]);
  f.seaLeft = cross < 0; // legacy fallback for multi-hex coasts
  f.seaPt = [wx, wy];    // exact clicked point — authoritative for the split
  S.coastPickFor = null;
  commitFeatures();
  document.getElementById('saveInfo').textContent = `Sea set to the ${f.seaLeft ? 'left' : 'right'} of the coastline. Coast-tool click near a coast re-picks.`;
}
function renderDrawing(cursor) {
  groups.edit.innerHTML = '';
  if (!S.drawing) return;
  const st = FSTYLE[S.drawing.type];
  const pts = cursor ? S.drawing.pts.concat([cursor]) : S.drawing.pts;
  if (pts.length > 1) {
    const a = { d: featPathD(pts), fill: 'none', stroke: st.stroke, 'stroke-width': st.width,
                'stroke-linecap': 'round', opacity: 0.75 };
    if (st.dash) a['stroke-dasharray'] = st.dash;
    el('path', a, groups.edit);
  }
  for (const p of S.drawing.pts)
    el('circle', { cx: p[0], cy: p[1], r: 1.6, fill: st.stroke }, groups.edit);
}

// The dot that shows where the next click will land. It grows into a teal ring on the starting
// node once clicking there would close the loop, so you can see the island is about to seal.
function snapMarker(p) {
  const close = closesRing(p);
  el('circle', { cx: p[0], cy: p[1], r: close ? 5.5 : 3.2, fill: 'none',
                 stroke: close ? '#18b3a4' : (edgeSnap ? '#ffdf5e' : '#fff'),
                 'stroke-width': close ? 1.8 : 1 }, groups.hover);
}

const tooltip = document.getElementById('tooltip');
function onHover(e) {
  const [wx, wy, s] = toWorld(e);
  const h = nearestHex(wx, wy);
  groups.hover.innerHTML = '';
  if (S.mode === 'draw' && S.coastPickFor) {
    // preview which side would be chosen as sea
    el('circle', { cx: wx, cy: wy, r: 8, fill: '#5d8fc4', opacity: 0.5, stroke: '#fff', 'stroke-width': 1.5 }, groups.hover);
    el('text', { x: wx + 12, y: wy + 4, 'font-size': 11, fill: '#fff', stroke: '#14181e',
                 'stroke-width': 2.5, 'paint-order': 'stroke' }, groups.hover).textContent = 'sea?';
  } else if (S.mode === 'draw' && S.tool === 'coast') {
    const lh = S.drawing ? S.drawing.hex : nearestHex(wx, wy);
    const p = (e.altKey || !lh) ? null : (edgeSnap ? snapToEdge(wx, wy, lh) : snapInHex(wx, wy, lh));
    if (lh) { const [cx, cy] = hexCenter(lh); el('path', { d: hexPath(cx, cy), fill: 'none', stroke: '#5d8fc4', 'stroke-width': 1.4, opacity: 0.8 }, groups.hover); }
    if (p) snapMarker(p);
    if (S.drawing) renderDrawing(p || [wx, wy]);
  } else if (S.mode === 'draw' && S.tool !== 'erase' && S.tool !== 'label' && !(S.tool === 'stronghold' && e.shiftKey)) {
    const p = e.altKey ? null : (edgeSnap && h ? snapToEdge(wx, wy, h) : snapPoint(wx, wy, 14, s));
    if (p) snapMarker(p);
    if (S.drawing) renderDrawing(p || [wx, wy]);
  }
  if (!h || S.hexes[h].t === 'N/A') { tooltip.hidden = true; return; }
  const sub = S.adj?.sub?.get(h);
  let subLabel = '';
  if (sub && sub.regions.length > 1) {
    const ri = regionAt(h, [wx, wy]), reg = region(h, ri), sea = !!(reg?.sea && !reg?.river);
    const hl = reg?.poly;
    if (hl) {
      el('path', { d: hl.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('') + 'Z',
                   fill: sea ? 'rgba(93,143,196,.35)' : 'rgba(127,174,90,.35)', stroke: '#fff', 'stroke-width': 1.4, opacity: 0.95 }, groups.hover);
      subLabel = sea ? ' · sea subhex' : ' · land subhex';
    } else { const [cx, cy] = hexCenter(h); el('path', { d: hexPath(cx, cy), fill: 'none', stroke: '#fff', 'stroke-width': 1, opacity: 0.8 }, groups.hover); }
  } else {
    const [cx, cy] = hexCenter(h);
    el('path', { d: hexPath(cx, cy), fill: 'none', stroke: '#fff', 'stroke-width': 1, opacity: 0.8 }, groups.hover);
  }
  const v = S.hexes[h];
  const name = S.features.labels[h] ?? S.names.hexes[h];
  const isSh = hasStronghold(h);
  tooltip.innerHTML = `<span class="t">${name ? name + ' — ' : ''}hex ${h}${subLabel}</span><br>` +
    `${v.t}${isSh ? (isPort(h) ? ' · stronghold (coastal/port)' : ' · stronghold (inland)') : ''}` +
    `${v.r ? ' · river (sheet)' : ''}${v.d ? ' · road (sheet)' : ''}` +
    (S.iso.data && S.iso.data.has(h) ? `<br>${S.iso.data.get(h).toFixed(1)} IRL d from origin` : '');
  tooltip.hidden = false;
  const wr = svg.parentElement.getBoundingClientRect();
  tooltip.style.left = (e.clientX - wr.left + 14) + 'px';
  tooltip.style.top = (e.clientY - wr.top + 10) + 'px';
}
svg.addEventListener('pointerleave', () => { tooltip.hidden = true; groups.hover.innerHTML = ''; });

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { spaceHeld = true; e.preventDefault(); }
  else if (e.key === 'e' || e.key === 'E') edgeSnap = true;
  else if (e.key === 'Enter' && S.drawing) finishDrawing();
  else if (e.key === 'Escape') { S.drawing = null; groups.edit.innerHTML = ''; }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    if (S.drawing && S.drawing.pts.length) { S.drawing.pts.pop(); renderDrawing(); }
    else if (S.undoStack.length) { S.features = JSON.parse(S.undoStack.pop()); commitFeatures(); }
  }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space') spaceHeld = false;
  else if (e.key === 'e' || e.key === 'E') edgeSnap = false;
});

/* ---------------- UI wiring ---------------- */
function setMode(m) {
  if (m === 'draw' && !LOCAL) m = 'route'; // no drawing on the published map
  S.mode = m;
  document.querySelectorAll('#modeSeg button').forEach(x => x.classList.toggle('on', x.dataset.mode === m));
  document.getElementById('drawSection').hidden = m !== 'draw';
  document.getElementById('routeSection').hidden = m !== 'route';
  svg.classList.toggle('drawing', m === 'draw');
  svg.classList.toggle('routing', m === 'route');
  if (m !== 'draw' && S.drawing) finishDrawing();
}
document.getElementById('modeSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (b) setMode(b.dataset.mode);
});
if (!LOCAL) document.querySelector('#modeSeg button[data-mode="draw"]').hidden = true;
setMode('route'); // there is no separate View mode: routing pans and inspects like viewing did
document.getElementById('toolBtns').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (S.drawing) finishDrawing();
  S.coastPickFor = null;
  S.tool = b.dataset.tool;
  document.querySelectorAll('#toolBtns button').forEach(x => x.classList.toggle('on', x === b));
});
document.querySelector('#toolBtns button').classList.add('on');

document.getElementById('undoBtn').onclick = () => {
  if (S.drawing && S.drawing.pts.length) { S.drawing.pts.pop(); renderDrawing(); }
  else if (S.undoStack.length) { S.features = JSON.parse(S.undoStack.pop()); commitFeatures(); }
};
document.getElementById('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(S.features, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'features.json'; a.click();
  URL.revokeObjectURL(a.href);
};
document.getElementById('importInput').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!Array.isArray(j.features)) throw 0;
    pushUndo(); S.features = { version: 1, labels: {}, strongholds: {}, ...j }; commitFeatures();
  } catch { alert('Not a valid features.json'); }
  e.target.value = '';
};
document.getElementById('resetBtn').onclick = async () => {
  if (!confirm('Discard local drawing and reload data/features.json?')) return;
  localStorage.removeItem(LS_KEY);
  S.features = await fetchFeaturesFile() || { version: 1, features: [], labels: {}, strongholds: {} };
  if (!S.features.labels) S.features.labels = {};
  if (!S.features.strongholds) S.features.strongholds = {};
  S.undoStack = [];
  commitFeatures();
};
document.getElementById('newRoute').onclick = () => newRoute();
document.getElementById('isoPick').onclick = () => {
  S.isoPick = !S.isoPick;
  document.getElementById('isoPick').classList.toggle('on', S.isoPick);
};
document.getElementById('isoClear').onclick = () => {
  S.iso.origin = null; S.iso.data = null; S.isoPick = false;
  document.getElementById('isoPick').classList.remove('on');
  computeRoute();
};
for (const id of ['isoBand', 'isoMax', 'isoMode'])
  document.getElementById(id).addEventListener('change', computeRoute);
document.getElementById('clearRoute').onclick = () => { S.routes = []; S.activeRoute = -1; computeRoute(); };
// Same as right-clicking the map, for touchscreens, which have no second button. Two buttons do it:
// one in the sheet beside its siblings, one floating on the map for when the sheet is shut.
function removeLastWaypoint() {
  const rt = S.routes[S.activeRoute];
  if (rt?.wps.length) { rt.wps.pop(); computeRoute(); }
}
document.getElementById('undoWp').onclick = removeLastWaypoint;
document.getElementById('undoWpFloat').onclick = removeLastWaypoint;
for (const id of ['inf', 'cav', 'wag', 'non', 'li', 'forced', 'marines', 'fleet', 'embark', 'noTrade', 'weather'])
  document.getElementById(id).addEventListener('change', computeRoute);

document.getElementById('refetchBtn').onclick = async () => {
  const info = document.getElementById('dataInfo');
  info.textContent = 'Fetching sheet…';
  try {
    const txt = await (await fetch(SHEET_URL)).text();
    const rows = txt.trim().split('\n').map(l => l.split(',').map(c => c.replace(/^"|"$/g, '')));
    const head = rows[0];
    const ix = n => head.indexOf(n);
    const hexes = {};
    for (const r of rows.slice(1)) {
      hexes[+r[ix('Hexcode')]] = {
        t: r[ix('Terrain')], s: r[ix('Stronghold')] === 'Yes',
        r: r[ix('River')] === 'Yes', d: r[ix('Road')] === 'Yes',
      };
    }
    S.hexes = hexes;
    renderTerrain(); renderLabels(); S.adj = null; computeRoute();
    info.textContent = `Fetched ${Object.keys(hexes).length} hexes from the sheet (in-memory; data/terrain.json unchanged).`;
  } catch (err) { info.textContent = 'Fetch failed: ' + err; }
};

function buildLayerUI() {
  const list = document.getElementById('layerList');
  list.innerHTML = '';
  const byId = Object.fromEntries(LAYERS.map(L => [L.id, L]));
  const rows = PANEL_ORDER.map(id => byId[id]).filter(Boolean)
    .concat(LAYERS.filter(L => !PANEL_ORDER.includes(L.id))); // anything new falls in at the end
  for (const L of rows) {
    if (L.slave) continue; // toggled by another layer (via `linked`), no row of its own
    const row = document.createElement('div');
    row.className = 'layer';
    row.innerHTML = `<label><input type="checkbox" ${L.def > 0 ? 'checked' : ''}> ${L.name}</label>
      <input type="range" min="0" max="1" step="0.05" value="${L.def || 1}">
      <button class="inv" title="Invert this layer's colours — dark reference scans become light lines you can trace against">◐</button>`;
    const [chk, rng] = row.querySelectorAll('input');
    const inv = row.querySelector('.inv');
    const apply = () => {
      if (chk.checked && L.lazy && !L._built) { L.lazy(); L._built = true; } // build on first use
      if (chk.checked && L._img && !L._img.getAttribute('href')) L._img.setAttribute('href', L.img); // fetch on first use
      for (const id of [L.id, L.linked].filter(Boolean)) {
        const g = groups[id];
        g.style.display = chk.checked ? '' : 'none';
        g.style.opacity = rng.value;
        // CSS filter, so it costs nothing and never touches the underlying geometry or colours
        g.style.filter = L._inv ? 'invert(1)' : '';
      }
    };
    chk.onchange = apply; rng.oninput = apply;
    inv.onclick = () => { L._inv = !L._inv; inv.classList.toggle('on', L._inv); apply(); };
    list.appendChild(row);
    L._apply = apply;
  }
}

/* ---------------- boot ---------------- */
async function fetchFeaturesFile() {
  try {
    const r = await fetch('data/features.json');
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.features) ? { version: 1, labels: {}, ...j } : null;
  } catch { return null; }
}
async function boot() {
  const T = await (await fetch('data/terrain.json')).json();
  S.G = T.grid; S.hexes = T.hexes;
  try { S.names = await (await fetch('data/strongholds.json')).json(); } catch {}
  initGeom();
  buildScaffold();
  if (adaptiveView()) coverView(); else applyViewBox();
  renderTerrain();
  const ls = localStorage.getItem(LS_KEY);
  if (ls) { try { S.features = JSON.parse(ls); } catch {} }
  else { const ff = await fetchFeaturesFile(); if (ff) S.features = ff; }
  if (!S.features.labels) S.features.labels = {};
  if (!S.features.strongholds) S.features.strongholds = {};
  renderFeatures(); renderLabels();
  buildLayerUI();
  for (const L of LAYERS) L._apply?.();
  try {
    const rr = JSON.parse(localStorage.getItem('rotmap_routes_v1'));
    if (rr && Array.isArray(rr.routes)) {
      S.routes = rr.routes;
      S.activeRoute = Math.min(rr.active ?? S.routes.length - 1, S.routes.length - 1);
    }
  } catch {}
  computeRoute();
  document.getElementById('dataInfo').textContent =
    `Terrain snapshot: ${Object.keys(S.hexes).length} hexes (fetched ${T.fetched}).`;
  document.getElementById('saveInfo').textContent =
    `${S.features.features.length} features loaded.`;
}
/* ---------------- bottom sheet (narrow screens) ----------------
   The sidebar is the same element at every width; below 820px the stylesheet parks it off the bottom
   edge and these handlers slide it in. On desktop the button and grip are display:none, so none of
   this ever fires. */
const sheetEl = document.getElementById('sidebar');
const sheetBtn = document.getElementById('drawerToggle');
const sheetGrip = document.getElementById('drawerGrip');
const undoFloat = document.getElementById('undoWpFloat');

function openSheet() {
  sheetEl.classList.add('open');
  sheetBtn.setAttribute('aria-expanded', 'true');
}
function closeSheet() {
  sheetEl.classList.remove('open');
  sheetEl.style.transform = '';
  sheetBtn.setAttribute('aria-expanded', 'false');
}
sheetBtn.onclick = openSheet;
document.getElementById('drawerClose').onclick = closeSheet;

// Carrying the active route's travel time on the opener means the headline number is readable with
// the sheet shut, which is the state you want while tapping waypoints onto the map.
function updateDrawerBadge(results) {
  const b = sheetBtn.querySelector('.badge');
  if (!b) return;
  const r = results?.[S.activeRoute];
  b.textContent = !r ? '' : r.fail ? ' · no route' : ' · ' + r.irl.toFixed(1) + 'd';
  // The floating Remove last only appears once there is a waypoint it could take back.
  undoFloat.classList.toggle('nowp', !S.routes[S.activeRoute]?.wps.length);
}

// Drag the grip down to dismiss; a tap on it closes too, since that is what a handle looks like it
// should do. Anything shorter than 70px springs back.
let gripDrag = null;
sheetGrip.addEventListener('pointerdown', e => {
  gripDrag = { y: e.clientY, dy: 0 };
  sheetEl.classList.add('dragging');
  sheetGrip.setPointerCapture(e.pointerId);
});
sheetGrip.addEventListener('pointermove', e => {
  if (!gripDrag) return;
  gripDrag.dy = Math.max(0, e.clientY - gripDrag.y);
  sheetEl.style.transform = `translateY(${gripDrag.dy}px)`;
});
function endGrip() {
  if (!gripDrag) return;
  const dy = gripDrag.dy;
  gripDrag = null;
  sheetEl.classList.remove('dragging');
  sheetEl.style.transform = '';
  if (dy > 70 || dy < 4) closeSheet();
}
sheetGrip.addEventListener('pointerup', endGrip);
sheetGrip.addEventListener('pointercancel', endGrip);

boot().catch(err => {
  document.body.innerHTML = `<div style="padding:2em;font-family:sans-serif">Failed to load data: ${err}.<br>
  Serve this folder over HTTP (e.g. <code>python -m http.server</code>) — file:// blocks fetch.</div>`;
});
