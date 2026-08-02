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
/* One palette, used by everything on the map that needs telling apart — the fourteen legions, their
   detachments, and the routes. Two palettes meant a route and a token could be "the same colour"
   without matching, and meant learning the swatch grid twice.

   Fifteen, so the grid is three even rows of five. The hues are spaced right round the wheel and
   kept clear of the terrain beneath them: no mid-green (Flatlands), no tan (Hills), no grey-brown
   (Mountains), no soft mid-blue (Sea and Lake). The last two are dark on purpose and take white ink,
   which inkOn() works out rather than being told. */
/* The stronghold marker, in the two sizes it comes in — written as the ratio they are meant to read
   as, 9 to 13, rather than as two numbers that happen to sit near it. That is what the eye does with
   them: a marker is large *compared with* the ones beside it. Stating the relation instead of the
   pair is what keeps it true, this having twice been retuned by moving one number and finding the
   other no longer said what it had.

   Two things are deliberately not on this scale. The **rim** keeps its own weight: an outline is a
   line, and a line drawn thicker to go round a larger circle stops being an edge and becomes a band.
   The difference in rim weight between the two sizes is there to tell them apart at a glance, not to
   grow with whatever it encloses. And the **name** keeps its own size, being a label on the map
   rather than part of the symbol, and must stay readable at every zoom; it is given a fixed clearance
   above the rim rather than an offset of its own, so it goes on clearing the disc whatever the disc
   does next. */
const SH_R = 5.1, SH_R_MAJOR = SH_R * 13 / 9;
const SH_NAME_GAP = 4.7;   // clear air between the top of the rim and the name's baseline
// How far a marker reaches from its point. Drawing asks so it knows how big to draw; hit-testing asks
// so it knows what you have clicked on. One answer, or the symbol and its target drift apart.
const shRadius = m => m?.major ? SH_R_MAJOR : SH_R;
/* How much of the white disc the fortress square reaches across, corner to corner. A fraction rather
   than a gap in pixels, so the buffer stays in proportion when the markers are resized — which they
   have been, twice. */
const SH_FORT_FILL = 0.8;
// The square inside a fortress marker. Dark enough to hold its own against the white disc it sits in
// at four pixels across, and far enough from the port ring's blue that the two never read as the same
// statement about a place.
const FORT_FILL = '#6b3fbf';
const PALETTE = ['#ffd93d', '#ffa23d', '#ff6b5e', '#ff5e9c', '#ef7bff',
                 '#b18cff', '#8c9bff', '#4fc3ff', '#3fe0d0', '#4fe08a',
                 '#b8e838', '#eceff3', '#98a3b3', '#6b4fd0', '#b3283c'];

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
// `types` lists the feature types rendered into that group; `linked` names the other groups that
// share this row's switch; `slave` groups are driven by another layer and get no row of their own;
// `op` scales a slave's opacity against its row's, so a group that was subtler than its neighbours
// stays subtler after being folded in with them; `fixed` is never switched at all;
// `lazy` means the group is only populated the first time it is switched on.
const LAYERS = [
  /* Under everything, and not switchable: land and water, and nothing else. It is not a view of the
     map so much as the map's own outline. With Terrain off you are meant to be reading what a scan
     or an isochrone says about the ground, and a black field with coloured shapes floating in it
     says nothing about where the coast was — the shapes need a shore to mean anything. Painted in
     the same two colours the terrain uses for flat ground and open ocean, so switching Terrain off
     reads as detail being taken away rather than as a different map arriving. */
  { id: 'base',     name: 'Land & sea',     def: 1, fixed: true },
  { id: 'terrain',  name: 'Terrain',        def: 1 },
  { id: 'coast',    name: 'Coast fills',    def: 1, linked: 'coastSea' }, // land subhex fills (+ its sea half, below)
  // Who holds what, read off the borders scan. It colours land only, so it belongs directly on top of
  // the land fills — and below everything you draw, which then reads over it the way the sidebar
  // implies. It needs no place above the sea fills, since it never paints water.
  { id: 'borders',  name: 'Borders',        def: 0, lazy: () => loadRealmScan('borders', 'ref/Borders_clean.png') },
  // Who holds what *now*, over the top of who holds what by right. It goes directly above Borders so
  // that with both on, the warlord's claim is the one you see and the realm beneath shows only where
  // no warlord has taken it — which is the comparison the pair exists to make. It leaves nine tenths
  // of the map transparent, so most of Borders goes on showing through regardless.
  { id: 'warlords', name: 'Warlords',       def: 0, lazy: () => loadRealmScan('warlords', 'ref/warlords.png') },
  // The thematic ref scans are underlays: over the terrain but under everything you draw, so your
  // own line always sits on top of the scan you traced it from. The Classic map is the exception —
  // see below.
  { id: 'refRivers',  name: 'Ref: rivers',  def: 0,   img: 'ref/rivers.png' },
  { id: 'refRoads',   name: 'Ref: roads',   def: 0,   img: 'ref/Roads.png' },
  { id: 'refNames',   name: 'Ref: names',   def: 0,   img: 'ref/Stronghold names.png' },
  { id: 'refCities',  name: 'Ref: cities/forts', def: 0, img: 'ref/citiestownsforts.png' },
  { id: 'refBorders', name: 'Ref: borders', def: 0,   img: 'ref/Borders_clean.png' },
  // Scaffolding: the datasheet's own river flag, painted per hex, for checking a drawn river against
  // what the sheet claims. That is a question about the data, not about the world, so it goes with
  // the tracing scans when the map is published — see `dev` below.
  { id: 'sheetRivers', name: 'Sheet: river hexes', def: 0, dev: true },
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
  // The drawn shore reads as a grid line rather than as a feature, so it sits at the grid's opacity:
  // `def` while it has a slider of its own, `op` for when it is folded into Terrain's on the
  // published map and would otherwise be pulled up to full strength with the fills.
  { id: 'coastLines', name: 'Coast lines',  def: 0.28, op: 0.28, types: ['coast'] },
  { id: 'iso',      name: 'Isochrone',      def: 0.55 },
  { id: 'grid',     name: 'Hex grid',       def: 0.28 },
  { id: 'hexIds',   name: 'Hex IDs',        def: 0, lazy: renderHexIds }, // 4,230 numbers; built on first use
  { id: 'roads',    name: 'Roads',          def: 1, types: ['road'] },
  { id: 'trade',    name: 'Trade routes',   def: 1, types: ['trade'] },
  { id: 'labels',   name: 'Strongholds',    def: 1 },
  // Tokens are the topmost thing on the map: they are what you are currently moving about on it,
  // and they must stay grabbable over everything drawn under them.
  { id: 'tokens',   name: 'Tokens',         def: 1 },
];
// Sidebar row order (ids only; slave layers have no row). Kept separate from the z-order above
// because the coast fills are split around the rivers, so one array can't express both. Coast
// fills/lines stay paired at the top, right under Terrain.
// The tracing refs sit next, because they're what you flick on and off against the coast you're
// drawing; the river/road/etc. layers you're producing come below them.
const PANEL_ORDER = ['terrain', 'coast', 'coastLines', 'borders', 'warlords',
                     'refClassic', 'refRivers', 'refRoads', 'refNames', 'refCities', 'refBorders',
                     'sheetRivers', 'riverMajor', 'riverMinor',
                     'iso', 'grid', 'hexIds', 'roads', 'trade', 'labels', 'tokens'];
/* Two kinds of layer come out of the published build, for the same reason. The tracing scans are for
   drawing against rather than for reading; a layer marked `dev` is scaffolding of the same sort —
   something that answers a question about the *data* rather than about the world, and that anyone
   reading the map would only wonder at. Both are dropped from the list rather than hidden, so the
   published site has no trace of them: no row, no group in the SVG, nothing fetched.
   The Classic map is exempt (`keep`): it is the map, not an aid to redrawing it. Borders is not one
   of these either — it reads its scan once, on demand, and paints land from it. */
if (!LOCAL) for (let i = LAYERS.length - 1; i >= 0; i--)
  if (LAYERS[i].dev || (LAYERS[i].img && !LAYERS[i].keep)) LAYERS.splice(i, 1);

/* And some rows are folded together, for the same reason and only on the published map. Several of
   them are separate because they are separate things to *draw*, not separate things to look at:
   terrain, the subhex fills and the drawn shoreline are one picture — the fills *are* terrain at
   subhex resolution and the line is where they meet — and the two grades of river are one river
   system seen at two widths. To a reader those are switches that only ever reveal part of something
   and leave them wondering what happened to the rest. To whoever is drawing them they are exactly
   what needs separating, so locally they stay apart.

   Only the sidebar changes. The groups keep their own places in the z-order, which is why this is
   done by handing one row the others rather than by merging the groups themselves: the coast fills
   are split around the rivers and the two river grades stack in a particular order, and neither
   arrangement survives being collapsed into one group. */
const PUBLISH_MERGE = [
  { into: 'terrain',   name: 'Terrain', with: ['coast', 'coastSea', 'coastLines'] },
  { into: 'riverMajor', name: 'Rivers', with: ['riverMinor'] },
];
if (!LOCAL) for (const m of PUBLISH_MERGE) {
  const host = LAYERS.find(L => L.id === m.into);
  if (!host) continue;
  host.name = m.name;
  host.linked = m.with;
  for (const id of m.with) { const L = LAYERS.find(x => x.id === id); if (L) L.slave = true; }
}
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
  tokens: [], tokenPick: false,   // counters dropped on hexes; tokenPick = next tap places one
  /* Isochrones are a list for the same reason routes are: a campaign has several forces in it, and the
     interesting question is usually not "how far can this one get" but "where do these two meet".
     `origins` each carry a hex, a colour and a column of their own; `data` is one reach map per origin,
     index for index; `own` and `best` are what falls out of comparing them — which origin reaches each
     hex first, and how soon. An origin with h === null has been made but not yet placed. */
  iso: { origins: [], active: -1, data: [], parts: [], own: null, best: null }, isoPick: false,
  coastPickFor: null,
  dragErase: null, needRecompute: false,
  vb: { x: 0, y: 0, w: 4401, h: 2037 },
  adj: null, // derived: {roads:Set, tradeByHex:Map, ferry:Set (road x major river), riverByHex:Map}
};

/* Which panel is open, declared up here with the rest of the state rather than beside the panel code
   that owns it: the column controls are shared between Routes and Isochrone, so working out *whose*
   army the boxes are editing means asking this, and that question is asked from the travel calculator
   a long way above the UI section. The panel machinery still does everything else with it. */
const UI_LS = 'rotmap_ui_v1';
const UI = { pane: 'route', shut: false, card: null, cardOff: false };
try { Object.assign(UI, JSON.parse(localStorage.getItem(UI_LS)) || {}); } catch {}

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

// One line of the sheet's CSV. Splitting on commas was fine while every column was a number or Yes/No,
// but the Region names are free text and one of them may one day have a comma in it.
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

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
  groups.selHex = el('g', { id: 'lyr_selHex' });   // topmost: outlines of the hexes the search picked
  // The region wash goes under the grid, roads and names — it tints the ground, it doesn't bury it.
  groups.selRegion = el('g', { id: 'lyr_selRegion' });
  svg.insertBefore(groups.selRegion, groups.grid);
  // Tokens keep their place in LAYERS (and so their sidebar row), but move above the route lines and
  // the edit/hover scratch layers: a counter you are about to grab shouldn't hide under a route.
  svg.insertBefore(groups.tokens, groups.selHex);
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
// Only a real turn of the phone reshapes the view. Reacting to any resize at all was too eager: a
// window dragged narrow and back, or the one-pixel-wide blip a browser can report mid-resize, would
// leave the map at a different zoom than it started, having "adapted" to a shape that no longer
// existed by the time the handler ran. Orientation is the thing worth adapting to, and it is stable.
let reshapeTimer = null, wasLandscape = null;
addEventListener('resize', () => {
  clearTimeout(reshapeTimer);
  reshapeTimer = setTimeout(() => {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const landscape = r.width >= r.height;
    if (wasLandscape === null) { wasLandscape = landscape; return; }
    if (landscape === wasLandscape) return;   // still the same way up: leave the view exactly as it is
    wasLandscape = landscape;
    reshapeToAspect();
  }, 150);
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
/* Two paths that share an edge do not quite meet. Each is rasterised on its own, each covers about
   half the pixels along the join, and a half-covered pixel laid over a half-covered pixel comes out
   at three quarters rather than whole — so a hairline of whatever is behind shows between them. The
   hex grid used to hide it, since that strokes every hex outline; with the grid off and the map
   zoomed out far enough for those hairlines to be dense, they read as a shimmer of a grid that isn't
   there.

   The geometry is not at fault and there is nothing to close up: every one of the 24,834 shared
   corners on this map rounds to the same coordinate from both sides. What is wanted is for each patch
   to reach a little past its own edge — and the reach has to be in *screen* pixels rather than map
   ones. The seam is one pixel wide however far out you are zoomed, while a stroke measured in map
   units shrinks away to nothing at exactly the zoom where the problem shows. Hence
   `non-scaling-stroke`, and the stroke in the fill's own colour, so all it does is close the gap.

   Only the layers that tile the whole map need this. The coast fills are painted over terrain that
   has already been closed up, so a seam at their edge shows the terrain beneath rather than the
   background — near enough their own colour to disappear. */
const SEAM_BLEED = { 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' };

function renderTerrain() {
  groups.terrain.innerHTML = ''; groups.grid.innerHTML = '';
  // Absent entirely on the published map, where the layer is dropped rather than hidden.
  if (groups.sheetRivers) groups.sheetRivers.innerHTML = '';
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
  for (const t in byT) {
    const c = TERRAIN_COLORS[t] || '#666';
    el('path', { d: byT[t], fill: c, stroke: c, ...SEAM_BLEED }, groups.terrain);
  }
  if (rivers && groups.sheetRivers)
    el('path', { d: rivers, fill: '#2f62c9', 'fill-opacity': 0.45, stroke: '#2f62c9', 'stroke-width': 1 }, groups.sheetRivers);
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
/* A realm scan: an image that says, in flat colour, who holds what. There are two of them and they
   are read identically — the pixels are sampled per subhex and the land is repainted in whatever
   colour most of the samples agree on — so the machinery below is written once and keyed by which
   layer asked for it. They differ only in what they are of, and in how much of the map they bother
   to speak for: the Warlords scan leaves nine tenths of it transparent, which the reading handles
   without being told, since unclaimed ground is exactly what a transparent pixel means. */
/* The Warlords scan's legend, keyed by the colour the scan actually uses. Sampled from the legend
   image rather than read off it by eye, so these are the exact values in the file and a lookup can
   be an equality test rather than a nearest-match.

   Every colour in the scan is named. If one ever isn't — a realm added to the map before it reaches
   this table — the readout says so and gives its value, rather than guessing or falling silent. */
const WARLORD_NAMES = {
  '#b542a0': 'Legion XIV',
  '#cca32a': 'Legion XIII',
  '#7f5741': 'Legion I',
  '#b51530': 'Legion III',
  '#ff8d4e': 'Legion IX',
  '#2c367f': 'Legion II',
  '#a48966': 'Legion V',
  '#842a4b': 'Legion VI',
  '#007f46': 'Legion VII',
  '#6ab5d8': 'Blue Scarves',
  // Not in the legend image, which lists ten; identified separately. A third of a per cent of the map.
  '#00ff21': 'Legion XII',
};
const rgbKey = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',');
const WARLORD_BY_RGB = new Map(Object.entries(WARLORD_NAMES).map(([hex, n]) => [rgbKey(hex), n]));
const rgbHex = c => '#' + c.split(',').map(n => (+n).toString(16).padStart(2, '0')).join('');

const realmScans = new Map();   // layer id -> { d, w, h } decoded pixels
// layer id -> Map("hex:region" -> "r,g,b"). Kept from the paint so the readout can answer for the
// subhex under the cursor without sampling the image again, which would mean holding the pixels of
// every scan for the sake of one lookup at a time.
const realmCols = new Map();
async function loadRealmScan(id, src) {
  const img = new Image();
  img.src = src;
  try { await img.decode(); } catch { return; }
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  try { realmScans.set(id, { d: ctx.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height }); }
  catch { return; } // tainted, which happens on file://
  paintRealms(id);
}
// The outline of one piece of a hex — the whole hexagon where a coastline hasn't split it, and the
// piece's own polygon (plus any islands it left behind) where one has. Realm fills are painted with
// it, and so is the region highlight, which is why a highlighted shore stops at the water's edge.
function regionShape(hx, r) {
  if (!r.poly) { const [cx, cy] = hexCenter(hx); return hexPath(cx, cy); }
  return [r.poly, ...(r.extra || [])].filter(p => p && p.length >= 3)
    .map(p => p.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('') + 'Z').join('');
}
// The scan is decoded once and kept; everything below is cheap enough to redo whenever the land
// changes shape, which it does every time a coastline is drawn — and region indices shift with it,
// so nothing here may be cached against them.
// Repaint every scan that has been loaded, or just the one named. Both are redone whenever the land
// changes shape, since region indices move with it and nothing here may be cached against them.
function paintRealms(only) {
  for (const id of realmScans.keys()) if (!only || id === only) paintRealm(id);
}
function paintRealm(id) {
  const g = groups[id], scan = realmScans.get(id);
  if (!g || !scan) return;
  g.innerHTML = '';
  if (!S.adj) deriveAdj();
  const { d: data, w, h: hh } = scan;
  const sx = w / S.G.image_width, sy = hh / S.G.image_height;
  // A scan's realm colours may be semi-transparent washes (the Borders one's are; the Warlords one is
  // flat and opaque). Composite each onto white here, so what gets painted is the solid colour the
  // wash reads as and the land can be filled opaquely. An already-opaque pixel comes through
  // unchanged, so the one path serves both.
  const at = (x, y) => {
    const px = Math.round(x * sx), py = Math.round(y * sy);
    if (px < 0 || py < 0 || px >= w || py >= hh) return null;
    const i = (py * w + px) * 4, a = data[i + 3] / 255;
    if (a < 40 / 255) return null; // unclaimed ground is left transparent in the scan
    // The dividing line a scan draws between its realms is not a realm. Only the Borders scan has one
    // — the Warlords scan's palette holds no grey at all — so the test simply never fires there.
    if (data[i] === 0x56 && data[i + 1] === 0x56 && data[i + 2] === 0x56) return null;
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
      // Unclaimed neighbours vote too, for staying unclaimed. Counting only the claimed ones made a
      // single claimed edge decisive however much neutral ground the piece also touched — one vote
      // beating nothing, because nothing was allowed to speak — so a spit adjoining one realm and
      // two stretches of nobody's land came out as that realm's. Neutral is a real answer about a
      // piece of ground, not the absence of one.
      const votes = new Map();
      let neutral = 0;
      for (const n of neighbors(hx)) {
        if (!S.hexes[n] || S.hexes[n].t === 'N/A') continue;
        const nrs = regionsOf(n);
        for (let rj = 0; rj < nrs.length; rj++) {
          if (nrs[rj].sea || !regionsMeet(hx, ri, n, rj)) continue;
          const c = cols.get(n + ':' + rj);
          if (c) votes.set(c, (votes.get(c) || 0) + 1); else neutral++;
        }
      }
      let best = null, bn = 0;
      for (const [c, n] of votes) if (n > bn) { bn = n; best = c; }
      // Strictly more than the neutral ground, so a tie leaves it unclaimed: land is inherited when
      // most of what it adjoins is held, not merely when something adjoining it is. A piece whose
      // only land neighbour is claimed still inherits — there is nothing there to object — which is
      // the case this pass was written for.
      if (best && bn > neutral) inherited.set(hx + ':' + ri, best);
    }
  }
  for (const [k, c] of inherited) cols.set(k, c);
  realmCols.set(id, cols);   // what the readout answers from
  const byColour = new Map();
  for (const [key, c] of cols) {
    const [hs, ris] = key.split(':'), r = regionsOf(+hs)[+ris];
    if (r) byColour.set(c, (byColour.get(c) || '') + regionShape(+hs, r));
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
/* One marker per stronghold, and a stronghold belongs to a subhex — so a hex split by a major river
   can show a town on one bank and a keep on the other, each with its own name and each a port or not
   on its own account. The dedupe therefore has to be by hex *and* subhex; keyed by hex alone, as it was,
   the two would collapse into one. */
function renderLabels() {
  groups.labels.innerHTML = '';
  const done = new Set();
  const put = (id, ri, name, m) => {
    const key = id + ':' + ri;
    if (done.has(key)) return;
    done.add(key);
    const [cx, cy] = shPoint(id, m);
    const port = isPort(+id, ri);
    // A major stronghold is the same marker drawn larger, so the two read as degrees of one thing
    // rather than as two different symbols. The stroke thickens with it, or the bigger circle would
    // look fainter than the small one beside it, and the name lifts clear of the wider rim.
    const major = !!m?.major;
    const r = shRadius(m);
    // The rim keeps its own weight and does not grow with the disc — see SH_R.
    const sw = major ? (port ? 2.3 : 1.9) : (port ? 1.7 : 1.2);
    el('circle', { cx, cy, r, fill: '#fff', stroke: port ? '#2f86c9' : '#14181e',
                   'stroke-width': sw }, groups.labels);
    /* A fortress is an ordinary marker with a square set inside it — the same circle at the same
       size, so it takes its place in the run of degrees rather than starting a second scale, and the
       square says what kind of place it is without saying how big.

       Inscribed against the *inner* edge of the ring rather than against the circle's radius: the
       stroke is painted centred on r, so corners taken out to r would sit half-buried in it. And then
       held short of even that by SH_FORT_FILL, because a square whose corners just reach the rim
       touches it at four points and the whole thing reads as one blob rather than as a shape inside a
       ring. What is wanted is a square with white all the way round it. Half the side of a square
       inscribed in a circle is that circle's radius over root two. */
    if (m?.fort) {
      const a = Math.max(1, (r - sw / 2) * SH_FORT_FILL / Math.SQRT2);
      el('rect', { x: cx - a, y: cy - a, width: 2 * a, height: 2 * a,
                   fill: FORT_FILL, stroke: 'none' }, groups.labels);
    }
    if (name) el('text', {
      x: cx, y: cy - r - SH_NAME_GAP, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#fff',
      stroke: '#14181e', 'stroke-width': 2.4, 'paint-order': 'stroke', 'font-family': 'system-ui,sans-serif',
    }, groups.labels).textContent = name;
  };
  for (const id of namedHexes()) {
    const es = shEntries(id);
    // Every stronghold in the hex, marker-backed or straight off the datasheet, each on its own bank.
    for (const { m, ri } of es) put(id, ri, shName(id, m), m);
    // A hex named by hand with nothing fortified in it is still a place worth drawing — and it has no
    // marker to hang the name off, so it stays hex-keyed and sits wherever the centre falls.
    if (!es.length && S.features.labels[id]) put(id, shRegion(id, {}), S.features.labels[id], null);
  }
  // Floating OCR labels (S.names.floating) are not rendered — they were mis-OCR'd stray text, not
  // real strongholds. Use the Label tool to name a hex if a genuine label is needed.
}
/* What to call a marker. Its own name if it has been given one; otherwise the datasheet's name for the
   hex, which is right for the common case of one stronghold in a hex and is the best guess available
   for the first of two. A hex label left over from before names move onto markers still counts. */
function shName(h, m) {
  if (m && m.name !== undefined) return m.name;
  return S.features.labels[h] ?? S.names.hexes[h] ?? '';
}

/* ---------------- coasts (split hexes into land/sea parts) ---------------- */
function refineBoundary(ox, oy, ix, iy, h) { // point on hex boundary between outside (o) and inside (i)
  for (let k = 0; k < 20; k++) {
    const mx = (ox + ix) / 2, my = (oy + iy) / 2;
    if (nearestHex(mx, my) === h) { ix = mx; iy = my; } else { ox = mx; oy = my; }
  }
  return [(ox + ix) / 2, (oy + iy) / 2];
}
/* ---------------- terrain, per subhex ----------------
   The datasheet gives one terrain to a whole hex, which is right until a coastline cuts the hex in
   two and the halves are plainly not the same ground — a hill shoulder on one side of an inlet, flat
   pasture on the other. An override says what a *region* is; everything that asks about terrain asks
   here, so the fill, the tooltip, the readout and the march cost all agree.

   Keyed hex -> region index -> terrain name, and stored with the drawing, because it is a statement
   about the map rather than about your session. */
function regionTerrain(h, ri) {
  return S.features.subTerrain?.[h]?.[ri | 0] || S.hexes[h]?.t;
}
function setRegionTerrain(h, ri, t) {
  pushUndo();
  const st = S.features.subTerrain || (S.features.subTerrain = {});
  const byRi = st[h] || (st[h] = {});
  if (!t || t === S.hexes[h].t) {          // back to what the sheet says: drop the override entirely
    delete byRi[ri | 0];
    if (!Object.keys(byRi).length) delete st[h];
  } else byRi[ri | 0] = t;
  S.adj = null;                             // march costs derive from terrain
  commitFeatures();
}
const hasSubTerrain = h => !!S.features.subTerrain?.[h];
// What to call a region in a readout: its own terrain, or the fact that it is the other kind of
// ground from the hex it sits in.
function terrainLabel(h, ri, sea) {
  const t = regionTerrain(h, ri);
  if (sea) return RULES.WATER.has(t) ? t : 'Sea subhex';
  return RULES.WATER.has(t) ? 'Land subhex' : t;
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
/* The map with everything taken off it: which ground is land and which is water, in the two colours
   the terrain palette uses for flat ground and open ocean. It is under every other layer and cannot
   be switched off, because it is what the rest of them are drawn *on* — with Terrain off, a scan or
   an isochrone would otherwise be coloured shapes floating in a black field, and a shape without a
   shore beside it says nothing about where it is.

   Split at subhex resolution like everything else, so a bay bitten out of a shore hex is water here
   too. A hex nothing has cut is one shape, taken from the datasheet's own terrain: a bank of a major
   river is land on both sides, so only a coastline can make a difference to this. Two batched paths
   for the whole map — 4,000 hexes for two SVG nodes. */
function renderBase(sub = coastSubcells()) {
  const g = groups.base;
  if (!g) return;
  g.innerHTML = '';
  let land = '', sea = '';
  for (const idS in S.hexes) {
    const h = +idS, t = S.hexes[idS].t;
    if (t === 'N/A') continue;                       // off-map filler, not anywhere at all
    const cells = sub.get(h);
    if (cells?.regions.length) {
      for (const r of cells.regions) {
        const d = regionShape(h, r);
        if (r.sea && !r.river) sea += d; else land += d;
      }
    } else {
      const [cx, cy] = hexCenter(h);
      if (RULES.WATER.has(t)) sea += hexPath(cx, cy); else land += hexPath(cx, cy);
    }
  }
  // Bled like the terrain above it, and for the same reason: two paths tiling the whole map between
  // them leave a hairline everywhere they meet, which here is every coastline.
  const L = TERRAIN_COLORS.Flatlands, W = TERRAIN_COLORS.Ocean;
  if (land) el('path', { d: land, fill: L, stroke: L, 'fill-rule': 'evenodd', ...SEAM_BLEED }, g);
  if (sea)  el('path', { d: sea,  fill: W, stroke: W, 'fill-rule': 'evenodd', ...SEAM_BLEED }, g);
}
function renderCoasts(sub = coastSubcells()) {
  groups.coast.innerHTML = ''; groups.coastSea.innerHTML = '';
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
    cells.regions.forEach((r, ri) => {
      // A region told what it is paints as that; the rest fall back to the hex's own two colours.
      const own = S.features.subTerrain?.[h]?.[ri];
      const c = own ? TERRAIN_COLORS[own] : null;
      if (r.sea) paint(r, c || seaC, true, groups.coastSea);
      else paint(r, c || landC, false, groups.coast);
    });
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
  // Both read the same split of the map, and working it out is a flood fill per cut hex — so it is
  // done once here rather than once in each of them.
  const sub = coastSubcells();   // fresh: features may have changed since the last deriveAdj
  renderBase(sub);
  renderCoasts(sub);
  for (const f of S.features.features) {
    const st = FSTYLE[f.type];
    const a = { d: featPathD(f.pts), fill: 'none', stroke: st.stroke, 'stroke-width': st.width,
                'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    if (st.dash) a['stroke-dasharray'] = st.dash;
    el('path', a, groups[TYPE_LAYER[f.type]]); // each type into its own layer (see LAYERS z-order)
  }
  S.adj = null; // invalidate derived movement data
}
/* ---------------- undo ----------------
   One stack, three kinds of thing on it: the drawing, the routes, the tokens. Ctrl+Z walks it in
   the order the changes were made, whatever they were — a token dropped after a waypoint is the
   first thing taken back, because that is what "undo" means to the hand that pressed it.

   Each entry holds the state *before* its change, so undoing is restoring it. `c` coalesces: a
   colour dragged around a picker fires a change per frame and they must add up to a single press of
   Ctrl+Z, so a push whose key matches the top of the stack is dropped rather than stacked. */
const UNDO_MAX = 80;
function pushUndoEntry(k, d, c) {
  const top = S.undoStack[S.undoStack.length - 1];
  if (c && top && top.c === c) return;
  S.undoStack.push({ k, d, c });
  if (S.undoStack.length > UNDO_MAX) S.undoStack.shift();
}
function pushUndo() { pushUndoEntry('features', JSON.stringify(S.features)); }
// Routes and tokens each keep the state as of their last commit, so the "before" snapshot is always
// already to hand and no call site has to remember to take one at the right moment.
let routesSnap = null, tokensSnap = null;
// Isochrone origins ride along in the routes snapshot. They are cheap — a hex, a colour, a column —
// and now that each carries an army of its own they are exactly the sort of thing worth getting back
// after a mistaken edit. The derived reach maps are not saved; they are recomputed from the origins.
const snapRoutes = () => JSON.stringify({
  routes: S.routes, active: S.activeRoute,
  iso: { origins: S.iso.origins, active: S.iso.active },
});
function pushUndoRoutes(c) {
  pushUndoEntry('routes', routesSnap ?? snapRoutes(), c);
  routesSnap = null;                    // retaken by the next saveRoutes()
}
function undoLast() {
  const u = S.undoStack.pop();
  if (!u) return false;
  // Migrated on the way back too: the stack can hold a snapshot taken before the shape changed.
  if (u.k === 'features') { S.features = migrateFeatures(JSON.parse(u.d)); commitFeatures(); }
  else if (u.k === 'tokens') {
    S.tokens = JSON.parse(u.d); tokensSnap = u.d;
    renderTokens(); renderTokenList(); saveTokens();
  } else if (u.k === 'routes') {
    const r = JSON.parse(u.d);
    S.routes = r.routes;
    S.activeRoute = Math.min(r.active ?? -1, S.routes.length - 1);
    // A snapshot from before origins were a list simply has no `iso`, and leaving the current ones
    // alone is the right reading of that: the entry was never about them.
    if (r.iso) {
      S.iso.origins = r.iso.origins || [];
      S.iso.active = Math.min(r.iso.active ?? -1, S.iso.origins.length - 1);
    }
    routesSnap = u.d;
    computeRoute();
  }
  return true;
}
/* Bring a features object up to the current shape. Shape-sniffing rather than version-gated, because
   the `version` field has always been written and never read, so it cannot be trusted to mean anything.

   The only change so far is strongholds: one object per hex became a list of them, so that a hex split
   by a river can hold a place on each bank. A single object is wrapped, and a label that belonged to
   the hex moves onto its one marker — with several markers in a hex, one name per hex would draw the
   same word twice and mean neither of them.

   Idempotent, so it is safe to run on every path that produces an S.features: boot from storage, boot
   from the shipped file, an imported file, a reset, and an undo back past its own introduction. */
function migrateFeatures(f) {
  if (!f || typeof f !== 'object') return f;
  if (!f.features) f.features = [];
  if (!f.labels) f.labels = {};
  if (!f.strongholds) f.strongholds = {};
  for (const id in f.strongholds) {
    const v = f.strongholds[id];
    let list = Array.isArray(v) ? v : v ? [v] : [];
    /* A tombstone sitting beside a live marker is meaningless and gets swept up. The datasheet flag is
       covered by any marker at all, so there is nothing there for a tombstone to suppress — it can only
       be debris from a briefly-shipped rule that matched the flag against the marker's *subhex*, under
       which a marker dragged clear of its hex centre grew a phantom twin that then had to be erased.
       A hex whose only entry is a tombstone keeps it: there, it is doing real work. */
    if (list.some(m => !m.removed)) list = list.filter(m => !m.removed);
    if (list.length) f.strongholds[id] = list; else delete f.strongholds[id];
  }
  // Names move from the hex onto the marker, once. A hex with a label but no marker keeps the label
  // where it is — it is a named place rather than a stronghold, and renderLabels still draws it.
  for (const id in f.labels) {
    const list = f.strongholds[id];
    if (!list || list.length !== 1) continue;
    if (list[0].name === undefined && !list[0].removed) {
      list[0].name = f.labels[id];
      delete f.labels[id];
    }
  }
  f.version = 2;
  return f;
}
function saveLocal() {
  localStorage.setItem(LS_KEY, JSON.stringify(S.features));
  document.getElementById('saveInfo').textContent =
    `Autosaved locally — ${S.features.features.length} features.`;
}
// computeRoute rebuilds S.adj, so the borders repaint picks up the coastline that was just drawn.
function commitFeatures() { renderFeatures(); renderLabels(); saveLocal(); computeRoute(); paintRealms(); }

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
  // Both edge caches are answers about the shape of the ground, and the ground is about to be
  // re-derived. The point sampling only depends on the grid, but it costs nothing to drop.
  edgePtsCache = new Map(); edgeReachCache = new Map();
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
/* ---------------- strongholds, one per subhex ----------------
   A hex split by a major river has two banks, and two banks can hold two different places: a town on
   the near side and a keep on the far side are not one settlement with one name, and taking ship from
   one of them is not the same as taking ship from the other. So a stronghold belongs to a subhex.

   It is *not*, however, keyed by the subhex index. Region indices are rebuilt from the drawn coastline
   every time it changes and are explicitly not safe to cache against — the same reason subTerrain is
   recomputed rather than trusted. A stored index would let a keep jump silently to the wrong bank the
   next time a coast was nudged. What is stable is where the marker stands, so the marker's coordinate
   stays authoritative and its subhex is derived from it, which is what strongholdPoint already did.
   Redraw a coastline and every marker re-derives itself to the bank it is actually on.

   Hence the shape: strongholds[hexId] is a *list* of markers, each { x, y, major?, coastal?, name?,
   removed? }. One entry per subhex is the intended use, and shList enforces that on the way in.

   A datasheet stronghold (S.hexes[h].s) has no coordinate — it stands at the hex centre, and so falls
   in whichever subhex the centre lands in. `removed` on a marker is how a datasheet stronghold is
   erased in a way that survives a reload. */

// The markers in a hex, always an array. Tolerates the old single-object shape in place, so a board
// saved before this change reads correctly even if the migration has not run over it yet.
function shList(h) {
  const v = S.features.strongholds[h];
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}
// Where a marker stands. A placed one knows; an unplaced one — which is what a datasheet stronghold
// amounts to — stands at the middle of its hex.
const shPoint = (h, m) => (m && m.x != null) ? [m.x, m.y] : hexCenter(+h);
/* Which subhex a marker is in, derived rather than stored. The S.adj guard is not paranoia: boot draws
   the labels before it ever solves a route, so this is reached with the region geometry not yet built.
   It is done here rather than in regionsOf because deriveAdj itself walks regions, and a guard down
   there would recurse. */
const shRegion = (h, m) => {
  if (!S.adj) deriveAdj();
  return regionAt(+h, shPoint(h, m));
};
/* Every live stronghold in a hex, each paired with the subhex it stands in.

   Two sources feed this, and keeping them straight is most of the work. A *marker* is something the
   drawing put there: a placed position, a type, a name, or a tombstone. The *datasheet* stronghold has
   none of that — it is a bare flag on the hex, standing at the hex centre, so it belongs to whichever
   subhex the centre falls in. It shows up here as a synthetic entry marked `_sheet`.

   The flag counts only while the hex holds no markers at all. That rule is not obvious and is worth
   stating plainly, because the obvious alternative is wrong: matching the flag against the marker's
   *subhex* looks more precise, and it means that any marker ever dragged clear of its hex centre —
   across a coastline, over to the near bank — stops covering the flag and a phantom second stronghold
   appears beside it out of nowhere. Historically one marker was the one stronghold in its hex, wherever
   it had been dragged to, and that is what the flag has to keep meaning. Once anything is in the hex,
   everything in the hex is explicit; shEnsure makes the flag explicit before it lets anything join it.

   The synthetic entry is a throwaway, so nothing may write to it. shEnsure exists for that. */
function shEntries(h) {
  const list = shList(h);
  if (list.length) return list.filter(m => !m.removed).map(m => ({ m, ri: shRegion(h, m) }));
  if (S.hexes[h]?.s) return [{ m: { _sheet: true }, ri: shRegion(h, {}) }];
  return [];
}
// The stronghold standing in subhex ri, if any. The first match wins: two in one subhex is not the
// intended shape, and picking the earlier is at least stable.
function shAt(h, ri) {
  return shEntries(h).find(e => e.ri === (ri | 0))?.m || null;
}
/* The *stored* marker for this subhex, made real if it was not. Everything that writes to a stronghold
   goes through here — otherwise editing a datasheet stronghold would mutate the synthetic entry above
   and the change would vanish on the next render with nothing to show it had ever been made. */
function shEnsure(h, ri) {
  // Where the datasheet's own stronghold stands, while it is still only a flag.
  const sheetRi = (S.hexes[h]?.s && !shList(h).length) ? shRegion(h, {}) : null;
  // Anything joining an empty datasheet hex has to make that stronghold explicit first, or the flag
  // would stop counting the moment the newcomer arrived and the original would silently disappear.
  if (sheetRi !== null && sheetRi !== (ri | 0)) S.features.strongholds[h] = [{}];
  const cur = shList(h).find(x => shRegion(h, x) === (ri | 0));
  if (cur) return cur;                 // may be a tombstone; the caller clears `removed`
  // A marker taking over from the datasheet's stronghold stands where that stood — the hex centre,
  // which is what an absent position means. One for an empty subhex needs a position of its own, or it
  // would land in the centre's subhex rather than the one asked for.
  const m = sheetRi === (ri | 0) ? {} : shPointFor(h, ri);
  S.features.strongholds[h] = [...shList(h), m];
  return m;
}
// Every hex that could be drawing a stronghold or a name: one with markers, one the datasheet fortifies,
// one labelled by hand. The renderer and the search list both walk exactly this set, so what you can
// find is what you can see.
function namedHexes() {
  const out = new Set();
  for (const id in S.features.strongholds) out.add(+id);
  for (const id in S.hexes) if (S.hexes[id].s) out.add(+id);
  for (const id in S.features.labels) out.add(+id);
  return out;
}
/* Where a stronghold actually stands, or null if this subhex has none — a coastal hex's sea half must
   not claim the keep on its land half. Unchanged in meaning from before; only the lookup moved. */
function strongholdPoint(h, ri) {
  const m = shAt(h, ri);
  return m ? shPoint(h, m) : null;
}
// The anchor for a route's first and last point. You march to the gate of a place, not to the middle
// of the ground around it, so a route that begins or ends at a stronghold is drawn to its marker.
const endPoint = (h, ri) => strongholdPoint(h, ri) || nodePoint(h, ri);
const isSplit = h => { const s = S.adj.sub.get(h); return !!(s && s.regions.length > 1); };
// Does region ri of h occupy the shared edge with hex n (so movement can cross there)?
// edgePts may be null when neither hex is coast-split (a whole region always spans the edge).
/* Does region (h, ri) actually reach the edge this hex shares with a neighbour? Sampled along that
   edge, because a region is a traced outline and the question is really whether the water — or the
   ground — comes right up to the boundary.

   Each sample has to be nudged a little inside the hex before it is tested, since a point exactly on
   the boundary is ambiguous. That nudge used to be 0.18 of the way to the hex centre: four and a half
   pixels of a twenty-nine pixel edge, which does not test the boundary at all but a line well inside
   the hex — and a coastline crossing at an angle has moved a long way by then. Two bays that plainly
   met along forty per cent of their shared edge came back as not touching, so a fleet in one had to
   put ashore and launch again, a whole day, to reach water it was already looking at. Sampling only
   five points, bunched between 12% and 88%, made it worse: a region reaching the edge near a corner
   was missed outright.

   So an edge is now read exactly as the land-meeting table reads one — the same count of samples
   across its whole length, the same threshold, and regionAtEdge's own small inset — and for the same
   reason it gives: a single sample is an artifact, a run of them is a shore. Memoised per hex,
   region and neighbour, which is what pays for the extra samples; deriveAdj clears it whenever the
   ground changes shape. */
const EDGE_N = 32, EDGE_MIN = 3;
let edgePtsCache = new Map(), edgeReachCache = new Map();
function regionOnEdge(h, ri, edgePts) {
  const r = region(h, ri); if (!r) return false;
  if (r.whole || !edgePts) return true;
  const ck = h + ':' + (ri | 0) + ':' + edgePts.key;
  const had = edgeReachCache.get(ck);
  if (had !== undefined) return had;
  const [cx, cy] = hexCenter(h);
  let n = 0;
  for (const m of edgePts) if (regionAtEdge(h, m, cx, cy) === (ri | 0) && ++n >= EDGE_MIN) break;
  const ans = n >= EDGE_MIN;
  edgeReachCache.set(ck, ans);
  return ans;
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
// Points sampled along the whole shared edge between adjacent hexes a and b — cell centres rather
// than a hand-picked few, so nothing is favoured and the ends are covered as well as the middle. The
// same geometry every time for a given pair, so it is worked out once; the array carries the pair's
// name for the benefit of the reach cache above.
function sharedEdgePts(a, b) {
  const k = a + '|' + b;
  const had = edgePtsCache.get(k);
  if (had) return had;
  const [c1, c2] = sharedEdgeCorners(a, b), out = [];
  for (let i = 0; i < EDGE_N; i++) {
    const t = (i + 0.5) / EDGE_N;
    out.push([c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t]);
  }
  out.key = k;
  edgePtsCache.set(k, out);
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
/* The column and the conditions belong to a route, not to the window. Two routes on the map are
   usually two different armies — a legion of foot in a blizzard and a courier on a summer road —
   and a single set of boxes could only ever describe one of them. The panel edits whichever route
   is active; SETTINGS is what it edits when there is no route at all, which is the case the
   isochrone still has to work in.

   Legacy routes carry no settings, so they inherit whatever was last in the boxes. */
const ROUTE_SETTINGS = {
  li: 0, cav: 2000, inf: 8000, wag: 80, non: 2500,
  forced: false, marines: false, embark: true, fleet: false, noTrade: false, weather: 'clear',
};
const SETTINGS_LS = 'rotmap_settings_v1';
let SETTINGS = { ...ROUTE_SETTINGS };
try { Object.assign(SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_LS)) || {}); } catch {}

/* The settings in force — which is to say, whose army the column boxes are describing. There is one set
   of boxes, carried between the Routes panel and the Isochrone panel, and on each it edits the thing
   that panel is about: the active route, or the active origin. Falling back to the loose SETTINGS when
   neither exists, which is the state the map opens in.

   That the answer depends on the open panel is the price of not having two sets of boxes that would
   eventually disagree. It does mean every caller that wants a *particular* army — the route readout,
   an origin's reach — must pass those settings in explicitly rather than trusting the ambient answer. */
function activeIsoOrigin() { return S.iso.origins[S.iso.active] || null; }
function activeSettings() {
  if (UI.pane === 'iso') {
    const og = activeIsoOrigin();
    if (!og) return SETTINGS;
    if (!og.set) og.set = { ...SETTINGS };
    return og.set;
  }
  const rt = S.routes[S.activeRoute];
  if (!rt) return SETTINGS;
  if (!rt.set) rt.set = { ...SETTINGS };      // a route from before settings existed
  return rt.set;
}
function armyOpts(set) {
  const st = set || activeSettings();
  const v = id => +st[id] || 0;
  const c = id => !!st[id];
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
    // Two independent permissions, not one. `secureFleet` licenses only the month spent getting
    // ships you don't have; boarding ships you *do* have is licensed by having them, which is what
    // `fleet` says. The saved key stays `embark` — every column in every saved route and every
    // clipboard string is written with it — but what it now means is narrower than the name.
    secureFleet: c('embark'), tradeRoad: !c('noTrade'), // the trade box is the opt-out; trade routes are on by default
    weather: st.weather || 'clear',
  };
}

/* The panel is a view of one settings object. Writing a box writes through to whichever object is
   active and recomputes; changing the active route rereads the boxes from it. */
const SETTING_NUMS = ['li', 'cav', 'inf', 'wag', 'non'];
const SETTING_CHKS = ['forced', 'marines', 'embark', 'fleet', 'noTrade'];
let syncingForm = false;
function syncRouteForm() {
  const st = activeSettings();
  syncingForm = true;
  for (const id of SETTING_NUMS) document.getElementById(id).value = st[id] ?? 0;
  for (const id of SETTING_CHKS) document.getElementById(id).checked = !!st[id];
  document.getElementById('weather').value = st.weather || 'clear';
  const rt = S.routes[S.activeRoute], og = activeIsoOrigin();
  // Each panel says whose column it is showing, and they no longer agree: the Routes panel edits the
  // route's army, the Isochrone panel the selected origin's. Saying so in both headings is the only
  // thing stopping one set of boxes from looking like it means two different things at once.
  const setFor = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  setFor('settingsFor', rt ? rt.name : 'no route — defaults');
  setFor('isoFor', og ? og.name : 'no origin — defaults');
  syncingForm = false;
}
function readRouteForm(changedId) {
  if (syncingForm) return;
  const st = activeSettings();
  // One undo step per field rather than per keystroke: typing 8000 is one change, not four. The key
  // has to name the owner as well as the field, or editing a route and then an origin would coalesce.
  const owner = UI.pane === 'iso' ? 'i' + S.iso.active : 'r' + S.activeRoute;
  if (st !== SETTINGS) pushUndoRoutes('set' + owner + changedId);
  for (const id of SETTING_NUMS) st[id] = +document.getElementById(id).value || 0;
  for (const id of SETTING_CHKS) st[id] = document.getElementById(id).checked;
  st.weather = document.getElementById('weather').value;
  // The loose defaults are the only settings with nowhere else to live, so they are the only ones that
  // go to their own key; a route's or an origin's travel with the routes blob.
  if (st === SETTINGS) { try { localStorage.setItem(SETTINGS_LS, JSON.stringify(SETTINGS)); } catch {} }
  computeRoute();
}

/* ---------------- a column, as a line of text ----------------
   An army is entered once and wanted again for months: the same legion marches in the spring and the
   autumn, and retyping five numbers and a weather is how a route quietly ends up describing the wrong
   force. So a column can be written out as one line, kept in a note or a chat log, and read back.

   The line is meant to be legible and hand-editable rather than exact, so only what differs from the
   default is spelled out: `forced` appears when a march is forced, `no-embark` when embarking has been
   turned off (it is on by default), and a condition the line never mentions is simply at its default.
   That makes a paste deterministic — the text fully describes a column, rather than half-describing
   one and leaving the rest of whatever was in the boxes behind. */
const WEATHERS = new Set(Object.keys(RULES.WEATHER));
// Case-insensitive, because a line that has been through a chat client or a person's own typing may
// not have kept `noTrade`'s capital.
const SETTING_KEY = new Map([...SETTING_NUMS, ...SETTING_CHKS].map(k => [k.toLowerCase(), k]));
const CHK_SET = new Set(SETTING_CHKS);

function armyToText(st) {
  const parts = SETTING_NUMS.map(k => `${k}=${+st[k] || 0}`);
  parts.push(`weather=${st.weather || 'clear'}`);   // always stated: it is a choice, not a flag
  for (const k of SETTING_CHKS) {
    const on = !!st[k];
    if (on !== !!ROUTE_SETTINGS[k]) parts.push(on ? k : 'no-' + k);
  }
  return 'RoTmap column: ' + parts.join(' ');
}

/* Deliberately forgiving: the point of a text format is that a person can retype it. Reads our own
   line, a JSON blob (what an older copy or a poke at localStorage would give), and a bare list like
   "cav 500 inf 2000". Returns null when nothing in the text was recognisable, so the caller can say
   so rather than silently resetting the column to defaults.

   `=` is the only separator accepted, not `:`. Allowing `:` would let the "column:" in our own header
   pair itself with the `li` that follows and swallow the first real number with it. */
const KV_RE = /([a-z][a-z-]*)\s*=\s*(-?\d+(?:\.\d+)?|[a-z_]+)/gi;
function armyFromText(txt) {
  const s = String(txt || '').trim();
  if (!s) return null;
  const out = { ...ROUTE_SETTINGS };
  let hit = false;
  if (s.startsWith('{')) {
    let j; try { j = JSON.parse(s); } catch { return null; }
    if (!j || typeof j !== 'object') return null;
    for (const [lk, k] of SETTING_KEY) {
      const v = j[k] ?? j[lk];
      if (v === undefined) continue;
      out[k] = CHK_SET.has(k) ? !!v : Math.max(0, Math.round(+v) || 0);
      hit = true;
    }
    if (typeof j.weather === 'string' && WEATHERS.has(j.weather)) { out.weather = j.weather; hit = true; }
    return hit ? out : null;
  }
  for (const m of s.matchAll(KV_RE)) {
    const k = SETTING_KEY.get(m[1].toLowerCase()), v = m[2];
    if (m[1].toLowerCase() === 'weather') {
      if (WEATHERS.has(v.toLowerCase())) { out.weather = v.toLowerCase(); hit = true; }
    } else if (!k) continue;
    // A number written against a switch ("forced=0") means the switch, not a count.
    else if (CHK_SET.has(k)) { out[k] = !/^(0|no|false|off)$/i.test(v); hit = true; }
    else { out[k] = Math.max(0, Math.round(+v) || 0); hit = true; }
  }
  // Bare words are switches. Scanned over what the pairs above did *not* claim, so that "forced=0"
  // cannot be undone a moment later by the word "forced" sitting inside it.
  for (const m of s.replace(KV_RE, ' ').matchAll(/[a-z][a-z_-]*/gi)) {
    const w = m[0].toLowerCase();
    const direct = SETTING_KEY.get(w);
    if (direct && CHK_SET.has(direct)) { out[direct] = true; hit = true; continue; }
    const bare = w.replace(/^no[-_]/, '');
    const neg = bare === w ? null : SETTING_KEY.get(bare);
    if (neg && CHK_SET.has(neg)) { out[neg] = false; hit = true; }
  }
  // A bare list of numbers with no key to attach them to is not a column, whatever else it may be.
  return hit ? out : null;
}

// Paste into whichever settings the panel is currently editing — the active route's, or the loose
// defaults when there is no route, exactly as typing in the boxes would.
function applyArmyText(txt) {
  const got = armyFromText(txt);
  if (!got) { toast('No column found in that text', true); return; }
  pushUndoRoutes();
  Object.assign(activeSettings(), got);
  const rt = S.routes[S.activeRoute];
  if (!rt) { try { localStorage.setItem(SETTINGS_LS, JSON.stringify(SETTINGS)); } catch {} }
  computeRoute();          // rereads the boxes from the object it just wrote
  toast('Column pasted' + (rt ? ' into ' + rt.name : ''));
}
/* Does a stronghold stand here? With no `ri` the question is about the whole hex — which is what the
   hover readout, the search list and the step table want, since they name a place rather than a bank.
   With an `ri` it is about that subhex alone, which is what movement wants. */
function hasStronghold(h, ri) {
  if (ri === undefined) return shEntries(h).length > 0;
  return !!shAt(h, ri);
}
/* Erase the stronghold in one subhex. A datasheet one has no entry of its own to delete, so it is
   hidden behind a marker carrying `removed` — that flag is the only way "no stronghold here" survives a
   reload when the hex is one the datasheet insists has one. A custom marker is simply dropped.
   Returns true if what was erased came off the datasheet, which is what the messaging says. */
function removeStronghold(h, ri) {
  const sheet = !!S.hexes[h]?.s;
  if (ri === undefined) {                      // the whole hex, which is what the erase tools mean
    if (sheet) S.features.strongholds[h] = [{ removed: true }];
    else delete S.features.strongholds[h];
    return sheet;
  }
  const wasImplicit = sheet && !shList(h).length;   // erasing the flag itself, never materialised
  const rest = shList(h).filter(x => shRegion(h, x) !== (ri | 0));
  // A tombstone is needed only when the hex is left with nothing: the datasheet flag counts again the
  // moment the hex is empty, so without one the stronghold would be back on the next reload. While any
  // other marker remains, the flag is already fully accounted for by the markers.
  if (sheet && !rest.some(x => !x.removed)) rest.push({ removed: true });
  if (rest.length) S.features.strongholds[h] = rest;
  else delete S.features.strongholds[h];
  return wasImplicit || (sheet && !rest.some(x => !x.removed));
}
/* Four states rather than two: no stronghold, an ordinary one, a fortress, a major one — for one
   subhex at a time. "None" goes through removeStronghold rather than around it, so that setting a
   datasheet hex to none and back to major again still works.

   The three that exist are mutually exclusive, and the two flags they are stored in are kept that way
   here rather than trusted to callers: `major` is purely how large the marker is drawn and `fort` is
   purely the square inside it, so nothing stops a marker carrying both, and a marker that did would
   be claiming to be two classes at once. Nothing in the movement rules reads either. */
function setStrongholdType(h, ri, kind) {
  pushUndo();
  if (kind === 'none') removeStronghold(h, ri);
  else {
    const m = shEnsure(h, ri);
    delete m.removed;                  // naming a type (re)adds one that had been erased
    if (kind === 'major') m.major = true; else delete m.major;
    if (kind === 'fortress') m.fort = true; else delete m.fort;
  }
  commitFeatures();
}
// What class a marker is, as one word — the menu's current-value flag, the tooltip and anything else
// that has to say it all ask here, so they can never disagree about a marker carrying both flags.
const shKindOf = m => !m ? 'none' : m.major ? 'major' : m.fort ? 'fortress' : 'ordinary';
// A sensible spot for a marker that is being created rather than placed by hand: the middle of the
// subhex it belongs to. Given as {x, y} so it can be spread straight into a new marker.
function shPointFor(h, ri) {
  if (!S.adj) deriveAdj();
  const p = nodePoint(+h, ri | 0);
  return { x: +p[0].toFixed(1), y: +p[1].toFixed(1) };
}
/* Nearest stronghold marker to (wx,wy) within thr, across every hex that has one — including a
   datasheet stronghold with no marker of its own. Returns the subhex as well as the hex, because with
   several markers in a hex "the nearest stronghold" is no longer answered by naming the hex. */
function nearestStronghold(wx, wy, thr) {
  let bs = null, bri = 0, bsd = Infinity, bOn = false;
  const consider = (id, m) => {
    if (m.removed) return;
    const [cx, cy] = shPoint(id, m);
    const d = Math.hypot(wx - cx, wy - cy);
    /* Inside the marker's own disc is on the marker, whatever the grab radius says. The two used to
       agree by accident: the grab radius shrinks in world units as you zoom in, while a marker does
       not, and the largest marker happened to stay just inside it. Half again as large it does not,
       so at high zoom you could click the visible edge of a keep and erase the road behind it. */
    const on = d <= shRadius(m);
    if (!on && d >= thr) return;
    // One you are standing on beats one you are merely near; among equals, the nearer.
    if (on === bOn ? d < bsd : on) { bsd = d; bs = +id; bri = shRegion(id, m); bOn = on; }
  };
  for (const id in S.features.strongholds) for (const m of shList(id)) consider(id, m);
  const nh = nearestHex(wx, wy);
  // A datasheet stronghold the drawing has never touched has no marker to iterate, so it is offered
  // separately — but only if nothing in this hex already stands for it.
  if (nh && S.hexes[nh]?.s && !shList(nh).length) consider(nh, {});
  // Reported as nil distance when the cursor is inside the marker, because callers weigh this against
  // the nearest drawn line and being on top of a thing is as near as it gets. Beyond the disc but
  // within the grab radius, the true distance, so the old tie-breaking against lines is untouched.
  return { id: bs, ri: bri, d: bOn ? 0 : bsd, on: bOn };
}
/* Port = a stronghold standing on, or bordering, navigable water: open sea, a drawn major river, or
   the sea part of a coast-crossed hex. Sea- and river-side strongholds are ports by default so you do
   not have to flag a hundred of them by hand; an explicit flag on the marker always wins, in either
   direction, which is how the exceptions get carved out.

   Now asked of a subhex rather than a hex, and that is a change of meaning, not just of signature: a
   keep on the far bank of a major river used to make the near bank embarkable too, because the whole
   hex counted. It no longer does. Only the bank the port actually stands on can take ship, which is
   the point of splitting them — and it will make some existing routes slower, or impossible.

   Called with no `ri` the old hex-wide reading is kept, for the readouts that describe a place rather
   than a bank. Note this is deliberately looser than `waterLink`: being a port is about standing on the
   water's edge, not about whether a fleet can cross that particular edge. */
function isPort(h, ri) {
  if (!S.adj) deriveAdj();
  if (ri === undefined) return regionsOf(h).some((r, i) => isPort(h, i));
  const m = shAt(h, ri);
  if (!m) return false;                              // no stronghold in this subhex
  if (m.coastal !== undefined) return m.coastal;      // explicit flag wins
  // Water inside the hex only counts if this subhex actually touches it: a landlocked bank across a
  // major river shares its hex with the sea half and is not thereby a port.
  if (regionAdj(h).some(([a, b]) =>
      (a === (ri | 0) && regSail(region(h, b))) || (b === (ri | 0) && regSail(region(h, a))))) return true;
  if (regSail(region(h, ri))) return true;           // the subhex is itself navigable — a river bank
  // Otherwise the shore has to be over an edge this subhex occupies. Asking the whole hex, as this
  // used to, is what let an inland bank claim a coast on the far side of the water.
  return neighbors(h).some(n => {
    const e = sharedEdgePts(h, n);
    if (!regionOnEdge(h, ri, e)) return false;
    return regionsOf(n).some((r, rj) => regSail(r) && regionOnEdge(n, rj, e));
  });
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
function landStep(a, b, o, road, crossMajor, bRi) {
  // Terrain is a property of the ground being marched onto, which is the destination *region* — a
  // hex split between hill and flat charges whichever half the column actually enters.
  const key = pairKey(a, b), tb = regionTerrain(b, bRi);
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
    /* Ashore inside this hex. Needs a port — unless the army is Marines, who land anywhere. The port
       now has to be in the subhex being landed *on*, not merely somewhere in the hex: putting an army
       ashore on the far bank of a river because the near bank has a harbour was never right. */
    for (const [a, b] of regionAdj(h)) {
      if (a === ri && regWalkable(region(h, b)) && (o.marines || isPort(h, b)))
        out.push({ toH: h, toRi: b, af: 0, ships: 1, g: 0, irl: DISEMBARK, note: DISEMBARK_NOTE });
      if (b === ri && regWalkable(region(h, a)) && (o.marines || isPort(h, a)))
        out.push({ toH: h, toRi: a, af: 0, ships: 1, g: 0, irl: DISEMBARK, note: DISEMBARK_NOTE });
    }
    // Likewise across a hex edge: the landing subhex is the one that must hold the port, so the test
    // moves inside the loop over the destination's regions.
    for (const { n, e } of N) {
      if (!regionOnEdge(h, ri, e)) continue;
      const rs = regionsOf(n);
      for (let rj = 0; rj < rs.length; rj++)
        if (regWalkable(rs[rj]) && regionOnEdge(n, rj, e) && (o.marines || isPort(n, rj)))
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
      const off = landStep(h, n, o, false, crossMajor, rj);
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
        const rs2 = landStep(h, n, o, true, crossMajor, rj);
        if (!rs2) continue;
        const ge = S.adj.roadGeomFi.get(pairKey(h, n) + '#' + fi);
        const geom = ge ? (ge.a === h ? ge.pts : [...ge.pts].reverse()) : null;
        out.push({ toH: n, toRi: rj, af: 0, ships: 0, g: grpN?.get(fi) || 0, irl: rs2.irl, note: rs2.note, geom });
      }
    }
  }
  // (No standalone ferry move: a ferry is a property of the road step that crosses a major river,
  // so it is already covered by the road steps above.)
  // Taking ship is the port's own doing, so it is the subhex the column is standing in that must have
  // one. A keep on the far bank of a river no longer lends its harbour to this side.
  /* Two different things, never both, and each with its own permission. An army that already has
     ships is simply getting back aboard, which is the 1-day re-embark, and the licence for it is
     having the ships — the column said so, or it secured them earlier. An army with none must spend
     the month getting them, boarding folded into that month, and *that* is what the securing box
     allows or forbids. So a column with a fleet and no leave to secure one can sail, land, and sail
     again from the same dock, but once it marches inland it has left its ships behind for good. */
  if (isPort(h, ri) && (ships || o.secureFleet)) {
    const cost = ships ? EMBARK : SECURE;
    const pre = ships ? 're-embark +' + cost + 'd' : 'secure ships +' + cost + 'd';
    if (regSail(reg)) out.push({ toH: h, toRi: ri, af: 1, ships: 1, g: 0, irl: cost, note: pre }); // board a river in place
    for (const [a, b] of regionAdj(h)) { // board an adjacent sea region of this hex
      if (a === ri && regSail(region(h, b))) out.push({ toH: h, toRi: b, af: 1, ships: 1, g: 0, irl: cost, note: pre });
      if (b === ri && regSail(region(h, a))) out.push({ toH: h, toRi: a, af: 1, ships: 1, g: 0, irl: cost, note: pre });
    }
    for (const { n, e } of N) { // launching from a port: the ship starts in that water, no mouth needed
      if (!regionOnEdge(h, ri, e)) continue;
      const rs = regionsOf(n);
      for (let rj = 0; rj < rs.length; rj++) if (regSail(rs[rj]) && regionOnEdge(n, rj, e))
        out.push({ toH: n, toRi: rj, af: 1, ships: 1, g: 0, irl: cost + SHIP_IRL, note: pre + ', sail' });
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
/* Starting (afloat, ships) for a waypoint region, given the fleet toggle — which settles two quite
   different questions and is worth keeping apart in the reading.

   *Afloat* is about position, and it is almost never a choice: a sea subhex can only be occupied
   afloat and a land subhex can only be occupied ashore, so `forcedAf` answers for both. The toggle
   decides it only where standing on the water is genuinely one of the options, which is a major-river
   subhex — a bank you can sit on or sail down.

   *Ships* is about possession, and it matters everywhere. The rules charge a month for securing a
   fleet "only if you don't already have one", so a force that has ships boards for the 1-day
   re-embark instead of 7 days — including a garrison standing on the shore with its ships waiting in
   the harbour beside it. That is why the toggle changes the answer for a coastal hex's *land*
   subhex, which looks like a bug until you notice the box is a claim about the force rather than
   about where it is standing. */
function startState(h, ri, o) {
  const f = forcedAf(region(h, ri));
  const af = f === null ? (o.fleet ? 1 : 0) : f; // river waypoint: default to fleet toggle
  return [af, (af || o.fleet) ? 1 : 0];
}

const ROUTE_COLORS = PALETTE;

// The quiet form is for callers that have already taken their own undo snapshot and mean the new
// route to be part of that same step — clicking bare map places a waypoint *and* the route to hold
// it, and one Ctrl+Z should take back both.
function newRouteQuiet() {
  S.routes.push({ name: 'Route ' + (S.routes.length + 1),
                  color: ROUTE_COLORS[S.routes.length % ROUTE_COLORS.length], wps: [],
                  // Copied, not shared: a second route for the same army starts already described,
                  // and then goes its own way the moment you change a box.
                  set: { ...activeSettings() } });
  S.activeRoute = S.routes.length - 1;
}
function newRoute() { pushUndoRoutes(); newRouteQuiet(); computeRoute(); }

/* A route that sets out from a hex a counter is standing on is that counter's march, so it wears
   its colour — legion V's road is V's colour on the map without anyone choosing it. Only the first
   waypoint counts: it is where the army starts, and later waypoints are merely places it passes.

   Where a legion and one of its detachments share a hex the legion wins, since a route drawn from
   a stack is much likelier to be the main body's. */
function adoptTokenColor(rt) {
  const w = rt?.wps?.[0];
  if (!w) return;
  const here = S.tokens.filter(t => t.h === w.h);
  if (!here.length) return;
  rt.color = (here.find(t => !String(t.label).includes("'")) || here[0]).color;
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
      // A leg the column is pushing gets solved at the forced pace, not merely rescaled afterwards:
      // a faster march can be worth a different road, and only re-solving finds it.
      const lo = wps[i].f && !o.forced ? { ...o, forced: true } : o;
      const legs = dijkstraLeg(wps[i].h, wps[i].ri | 0, state >> 1, state & 1, wps[i + 1].h, wps[i + 1].ri | 0, lo);
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
      flat.push({ st, prevH, first: i === 0 && j === 0, wp: j === legSteps.length - 1, leg: i });
      prevH = st.h;
    }
  });
  let totHex = 0, totMiles = 0; const steps = [], allPts = [];
  for (let idx = 0; idx < flat.length; idx++) {
    const { st, prevH: ph, first, wp, leg } = flat[idx];
    // Which leg this step belongs to, and whether it *is* a waypoint. The readout needs both to
    // turn "do something at this step" into "do something at this waypoint".
    st.leg = leg ?? 0; st.wp = !!wp;
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

/* ---------------- the isochrone's unit is the subhex ----------------
   Everywhere else on this map a hex that a coastline or a major river has cut in two is two places
   that happen to share an outline, and the pathfinder has treated them that way for a long time. The
   isochrone used to collapse them again on the way out, keeping one figure per hex and taking the
   best of whatever states reached it — so a port whose bay a fleet could sail into came back shaded
   over its whole hex, including the land an army with no ships could not reach at all. The reach was
   right; the reporting threw the distinction away.

   So every map the isochrone builds is keyed by *node* — hex and region together — and every fill it
   paints is the region's own shape. A coastal hex can now be half green and half unshaded, which is
   the truth about it. Hexes nothing has split have exactly one region and read as they always did. */
const nk = (h, ri) => h * MAX_REGIONS + (ri | 0);
const nkH = k => (k / MAX_REGIONS) | 0;
const nkRi = k => k % MAX_REGIONS;

/* Which subhexes a column can be said to *hold*, as against merely to cross. Sea is somewhere a force
   can be only if it could ever be afloat — which means either it has ships, or it is at liberty to go
   and get some. A column that is neither is landlocked whatever the map looks like, and shading open
   water for it would be describing a place it can never occupy.

   Note what is *not* asked here: whether the budget actually stretches to the securing month. That is
   the search's business, and it answers it properly — with seven days to find a fleet and only four
   to spend, the water simply never comes back inside `maxD` and never reaches this test. Asking twice
   would have meant this guess and the search's arithmetic disagreeing sooner or later.

   River subhexes are held either way: a bank is walkable ground that happens to be sailable too. */
const isoHolds = (h, ri, o) => o.fleet || o.secureFleet || regWalkable(region(h, ri));

// Travel time from `from` to every reachable subhex within maxD IRL days (min over fleet states —
// but not over regions, which are different ground and get their own answer).
function dijkstraAll(fromNode, o, maxD) {
  const dist = new Map(), best = new Map();
  const r0 = fromNode.ri | 0, [af0, sh0] = startState(fromNode.h, r0, o);
  dist.set(sk(fromNode.h, r0, af0, sh0, 0), 0);
  const heap = [[0, fromNode.h, r0, af0, sh0, 0]];
  while (heap.length) {
    const [d, h, ri, af, sh, g] = hpop(heap);
    if (d > (dist.get(sk(h, ri, af, sh, g)) ?? Infinity)) continue;
    const key = nk(h, ri);
    if (isoHolds(h, ri, o) && d < (best.get(key) ?? Infinity)) best.set(key, d);
    if (d > maxD) continue;
    for (const mv of expand(h, ri, af, sh, g, o)) {
      const k2 = sk(mv.toH, mv.toRi, mv.af, mv.ships, mv.g), nd = d + mv.irl;
      if (nd < (dist.get(k2) ?? Infinity)) { dist.set(k2, nd); hpush(heap, [nd, mv.toH, mv.toRi, mv.af, mv.ships, mv.g]); }
    }
  }
  return best;
}

// Straight-line ("as the crow flies") spread from an origin hex to every subhex within
// maxD IRL days, at a fixed miles/IRL-day speed. Terrain, roads and rivers are ignored
// — this mirrors the Google-Sheet straight-line calc used for messages & rumours.
// Returns Map<nodeKey, irlDays>, same shape as dijkstraAll.
//
// Measured centre to centre as it always was, and every region of a hex is given the same figure:
// word does not slow down at a shoreline, and a bay is as far from the origin as the shore it bites
// into. The subhex split matters here only so that the answer can be intersected with a march that
// does care about it, and so that both are painted with the same brush.
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
    const d = (px / pxPerMile) / speedMiPerDay;
    const n = Math.min(regionsOf(id).length, MAX_REGIONS);
    for (let ri = 0; ri < n; ri++) best.set(nk(id, ri), d);
  }
  return best;
}

function isoColor(b, n) {
  const t = n <= 1 ? 0 : b / (n - 1);
  return `hsl(${Math.round(130 - 130 * t)},75%,48%)`;
}

/* ---------------- optimizer: what the last day of an order buys ----------------
   Orders are issued in whole days. A march the solver prices at 3.2 IRL days is paid for as 4, and
   the remaining 0.8 of a day is simply thrown away — the column sits still, having already arrived.
   Ordinary bands answer "how far can I get"; they cannot show that a hex two days out costs the same
   order as one four hours further on, which is exactly the choice a player makes when picking where
   to halt.

   So the optimizer stops shading by distance and shades by *slack*: ceil(cost) − cost, the part of
   the final day the march does not use. Green hexes sit just under a whole day — the order is spent
   almost to the hour, and going any further would buy another whole day. Red hexes have just spilled
   over a boundary, paying for a day they will barely touch. Both readings matter more than the raw
   distance, and a red hex beside a green one is a standing invitation to push a little harder or
   stop a little sooner. */
const OPT_BUCKETS = 5;             // 0.2-day steps: fine enough to read, coarse enough to batch paths

/* Why this tolerance is a thousandth of a day and not float dust.

   Moves that the rules call free but that must still lose a tie — crossing a bridge inside a hex,
   taking a ferry — are priced at NUDGE, a millionth of a day. That is invisible in every total the
   map shows, and it was invisible here too until `ceil` got hold of it. A march the rules price at
   exactly 5 days, begun on the far bank of a bridge, costs 5.000001; `ceil` reads that as a 6-day
   order throwing away almost a whole day. Moving the origin one subhex across a bridge would repaint
   every hex sitting on a whole-day boundary from green to red, while both routes still read 5.0 days.

   So the optimizer prices the order the rules meant rather than the cost the solver bookkept:
   anything within OPT_TOL of a whole day *is* that whole day. A thousandth of a day is a minute and
   a half against steps priced in tenths, so nothing the rules could intend falls inside it, and it
   leaves room for several hundred stacked nudges along one path. It must stay well clear of NUDGE
   above — if that ever grows, this has to grow with it. */
const OPT_TOL = 1e-3;

// The slack this cost throws away when billed in whole days; a whole number wastes nothing.
function optWaste(d) {
  const w = optDays(d) - d;
  return w > 0 ? w : 0;
}
function optDays(d) { return Math.max(0, Math.ceil(d - OPT_TOL)); }   // whole days actually paid for
// Little waste green, nearly a whole day wasted red. Same ramp as the bands, darkened slightly along
// the way so the two ends stay apart for a red-green eye as well as by hue.
function optColor(b, n) {
  const t = n <= 1 ? 0 : b / (n - 1);
  return `hsl(${Math.round(130 - 130 * t)},72%,${Math.round(51 - 8 * t)}%)`;
}
// An army-mode idea only: a straight-line spread has no orders in it to round up, and relief already
// bills every leg in whole days, so there is nothing left over for the optimizer to shade.
function isoOptimizing() {
  return isoMode() === 'army' && !!document.getElementById('isoOpt')?.checked;
}
function isoMode() { return document.getElementById('isoMode')?.value || 'army'; }
function isoRelief() { return isoMode() === 'relief'; }

/* ---------------- relief: how far out a force can be stationed and still save the place ----------
   A siege begins somewhere. Word of it has to reach an army before that army can march, so the
   question a commander actually asks is not "how far can my men get in four days" but "how far away
   can I station them and still have them arrive in four" — and the answer is a different shape from
   an ordinary isochrone, because the two legs run in opposite directions over different ground.
   News crosses the map as the crow flies; the column has to use the roads.

   For a candidate hex H and the besieged hex T:
       x = word of the siege travelling from T out to H   (straight line, RULES.SPREAD)
       y = the column marching from H back to T           (pathfound, under H's own column)
   and H is worth garrisoning when x + y is inside the budget.

   Both legs are billed in whole days, and separately. Orders are issued in whole days — the same
   fact the optimizer above is built on — and these are two orders rather than one: the news lands
   during a day, and the column forms up and sets out on the next. Rounding the sum instead would
   let half a day of riding and half a day of marching share a day they cannot share, and would put
   a ring of hexes in the shading that in play would arrive to find the gates already open.

   The march has to be solved *inward*, and that is not the same problem as the outward one this map
   solves everywhere else. A hex is paid for by the step that enters it, so a march out of the siege
   never pays for the besieged hex and pays instead for wherever it stops — the exact opposite of the
   march coming back. Read outward, a fortress in the mountains costs its relief nothing to enter and
   the error is a whole day at half pace, always in the player's favour, on precisely the hex a
   fortress is most likely to be standing on. So the search below runs the movement graph backwards.

   Backwards, but only once, and only over the ground it needs. The reverse of a move is not
   something `expand` can produce, so the incoming edges of a node are recovered by expanding its
   possible predecessors — the six neighbouring hexes, its own hex, and the far end of any trade
   route touching it — and keeping whichever of their moves land on it. Every hex is expanded at most
   once and only when the search actually reaches it, so the work stays in proportion to the area
   covered rather than to the map. */
function reliefMarch(toH, toRi, o, maxD) {
  const inE = new Map();                 // node key -> [[predecessor key, cost], ...]
  const filed = new Set();               // hexes whose outgoing moves have been filed as in-edges
  // Every state a column could actually stand in here. `forcedAf` pins afloat on pure land and pure
  // sea; only a river region is genuinely a choice. Afloat is never on a road, so those combinations
  // are skipped rather than expanded into moves nothing can reach.
  const fileHex = p => {
    if (filed.has(p)) return;
    filed.add(p);
    const rs = regionsOf(p);
    const gs = new Set([0]);
    for (const v of S.adj.hexRoadGroup.get(p)?.values() || []) gs.add(v | 0);
    for (let ri = 0; ri < rs.length && ri < MAX_REGIONS; ri++) {
      const f = forcedAf(rs[ri]);
      for (const [af, sh] of STATES) {
        if (f !== null && af !== f) continue;
        for (const g of gs) {
          if (af && g) continue;
          const from = sk(p, ri, af, sh, g);
          for (const mv of expand(p, ri, af, sh, g, o)) {
            const k = sk(mv.toH, mv.toRi, mv.af, mv.ships, mv.g);
            let a = inE.get(k);
            if (!a) inE.set(k, a = []);
            a.push([from, mv.irl]);
          }
        }
      }
    }
  };
  const ensure = h => {
    fileHex(h);
    for (const n of neighbors(h)) fileHex(n);
    for (const l of S.adj.tradeByHex.get(h) || []) fileHex(l.a === h ? l.b : l.a);
  };
  /* Seeded with every state the besieged subhex can be occupied in, because arriving is arriving:
     a column that marches in and one that lands in from the river have both relieved the place. What
     it cannot do is count a fleet sitting in the water as an arrival — that state is only seeded when
     the besieged subhex is itself navigable, which `forcedAf` decides. */
  const dist = new Map(), heap = [];
  const rs0 = regionsOf(toH), f0 = forcedAf(rs0[toRi | 0] || rs0[0]);
  const gs0 = new Set([0]);
  for (const v of S.adj.hexRoadGroup.get(toH)?.values() || []) gs0.add(v | 0);
  for (const [af, sh] of STATES) {
    if (f0 !== null && af !== f0) continue;
    for (const g of gs0) {
      if (af && g) continue;
      const k = sk(toH, toRi | 0, af, sh, g);
      if (!dist.has(k)) { dist.set(k, 0); hpush(heap, [0, k, toH]); }
    }
  }
  while (heap.length) {
    const [d, k, h] = hpop(heap);
    if (d > (dist.get(k) ?? Infinity)) continue;
    if (d > maxD) continue;
    ensure(h);                                   // in-edges of everything in this hex, computed once
    for (const [from, irl] of inE.get(k) || []) {
      const nd = d + irl;
      if (nd < (dist.get(from) ?? Infinity)) { dist.set(from, nd); hpush(heap, [nd, from, from >>> SK_H]); }
    }
  }
  /* Read off per subhex, from the state a force *stationed* there would set out in — the same start
     state a route from that subhex would take, so a garrison is costed as a garrison rather than as
     whatever state the search happened to pass through. Road group 0: an army standing still is not
     yet on any road, and picks one up with its first step. Each region answers for itself: a bay and
     the shore beside it are not the same billet, and only one of them can be marched out of. */
  const best = new Map();
  const seen = new Set();
  for (const [key] of dist) {
    const h = key >>> SK_H;
    if (seen.has(h)) continue;
    seen.add(h);
    regionsOf(h).forEach((r, ri) => {
      if (ri >= MAX_REGIONS || !isoHolds(h, ri, o)) return;   // no ships, no billet at sea
      const [af0, sh0] = startState(h, ri, o);
      const v = dist.get(sk(h, ri, af0, sh0, 0));
      if (v !== undefined && v <= maxD) best.set(nk(h, ri), v);
    });
  }
  return best;
}

function reliefAll(fromNode, o, newsSpeed, maxD) {
  // Neither leg is searched past the whole budget: a hex that is more than maxD days out of earshot
  // cannot be redeemed by standing next door, and vice versa.
  const news = spreadAll(fromNode, newsSpeed, maxD);
  const march = reliefMarch(fromNode.h, fromNode.ri | 0, o, maxD);
  const best = new Map(), parts = new Map();
  for (const [key, m] of march) {
    const x = news.get(key);
    if (x === undefined) continue;              // out of earshot — nobody there ever hears of it
    const xd = optDays(x), yd = optDays(m), tot = xd + yd;
    if (tot > maxD) continue;
    best.set(key, tot);
    parts.set(key, { newsD: xd, marchD: yd, news: x, march: m });
  }
  return { best, parts };
}

/* ---------------- several origins, and the ground between them ----------------
   One origin answers "how far can this force reach". Several answer the more useful question: given
   two forces setting out at the same moment, which of them gets to a given hex first — and therefore
   where the line between them falls. Contested ground goes to whichever origin reaches it in fewer
   days, which is a Voronoi diagram drawn in travel time rather than in miles, and looks nothing like
   one: a road or a river bends a border a long way, and a mountain range holds it still.

   Each origin marches as its own army, so the race is between forces rather than between points. That
   is deliberate but worth remembering when reading a border: it moves if you change either column. */
const ISO_COLORS = PALETTE;
function freeIsoColor() {
  const used = new Set(S.iso.origins.map(o => o.color));
  return ISO_COLORS.find(c => !used.has(c)) || ISO_COLORS[S.iso.origins.length % ISO_COLORS.length];
}
function freeIsoName() {
  const taken = new Set(S.iso.origins.map(o => o.name));
  for (let k = S.iso.origins.length + 1; ; k++) if (!taken.has('Origin ' + k)) return 'Origin ' + k;
}
// A new origin inherits the column currently on screen: adding a second one almost always means the
// same force setting out from somewhere else, and retyping the army to find that out is the tedium
// this list exists to remove.
function newIsoOrigin(h, ri) {
  return { h: h ?? null, ri: ri | 0, color: freeIsoColor(), name: freeIsoName(), set: { ...activeSettings() } };
}
/* A board saved before any of this had one origin under `iso.origin`, or none, and no colours, names or
   columns on it. Run before anything reads the list, so no other code has to know the old shape. */
function migrateIso() {
  const iso = S.iso;
  if (!Array.isArray(iso.origins)) iso.origins = [];
  if (iso.origin) {
    // Built by hand rather than through newIsoOrigin: `sea` is how the very oldest saves said which
    // half of a split hex they meant, and that has to be turned into a region index here.
    const ri = iso.origin.ri ?? Math.max(0, regionsOf(iso.origin.h).findIndex(r => !!r.sea === !!iso.origin.sea));
    iso.origins.push({ h: iso.origin.h, ri: ri | 0, color: freeIsoColor(), name: freeIsoName(), set: { ...SETTINGS } });
    iso.origin = null;
    iso.active = iso.origins.length - 1;
  }
  for (const og of iso.origins) {
    if (og.ri === undefined) og.ri = Math.max(0, regionsOf(og.h).findIndex(r => !!r.sea === !!og.sea));
    if (!og.color) og.color = freeIsoColor();
    if (!og.name) og.name = freeIsoName();
    if (!og.set) og.set = { ...SETTINGS };
  }
  if (iso.active >= iso.origins.length) iso.active = iso.origins.length - 1;
  if (iso.active < 0 && iso.origins.length) iso.active = 0;
}
const placedOrigins = () => S.iso.origins.filter(o => o.h != null).length;

/* Who holds each hex, and how soon they get there. Strictly-less means a tie goes to the origin that
   already holds the hex, which is the earlier one in the list — arbitrary, but stable, and a contested
   hex must not flicker between two owners every time something unrelated is recomputed. */
function assignIsoOwners(maxD) {
  const own = new Map(), best = new Map();
  S.iso.data.forEach((m, i) => {
    if (!m) return;
    for (const [key, d] of m) {          // key is a subhex, so two halves of a hex can fall differently
      if (d > maxD) continue;
      const cur = best.get(key);
      if (cur === undefined || d < cur) { best.set(key, d); own.set(key, i); }
    }
  });
  S.iso.own = own; S.iso.best = best;
}
// The runner-up for a subhex, which is what makes a border legible: ground the second force reaches a
// day later is a frontier, ground it reaches a week later is deep inside somebody's territory.
function isoRunnerUp(key) {
  let bi = -1, bd = Infinity;
  const winner = S.iso.own?.get(key);
  S.iso.data.forEach((m, i) => {
    if (!m || i === winner) return;
    const d = m.get(key);
    if (d !== undefined && d < bd) { bd = d; bi = i; }
  });
  return bi < 0 ? null : { i: bi, d: bd };
}

/* Every piece of ground one area holds, as one path. This used to walk hex sides and emit only those
   with no same-area hex behind them, which produced the outline directly — but a side is the wrong
   unit now that half a hex can be held and the other half not, and a coastline is not one of the six
   sides. So the area is described as a shape rather than as a set of edges, and the outline is got
   from the shape by stroking and masking (see renderIso): the half of every line falling inside the
   area is hidden, which silently removes every line between two of its own pieces and leaves the
   silhouette — holes where a rival has taken a pocket in the middle, and all. The same trick the
   region selection uses, for the same reason: no union of several hundred polygons to compute. */
function isoAreaD(idx) {
  let d = '';
  for (const [key, o] of S.iso.own) {
    if (o !== idx) continue;
    const h = nkH(key), r = region(h, nkRi(key));
    if (r) d += regionShape(h, r);
  }
  return d;
}

/* The origin list, built like the route list because it is the same idea: several of a thing, one of
   them selected, each with a colour you can change and a name you can give it. What differs is that an
   origin is one point rather than a path, so the row shows where it stands and how much ground it holds
   — the two things you would otherwise have to count off the map. */
function renderIsoList() {
  const list = document.getElementById('isoList');
  if (!list) return;
  list.innerHTML = S.iso.origins.length ? ''
    : '<div class="emptynote">No origins yet — click a hex, or press Add origin.</div>';
  // How much ground each area actually holds, which is the only honest measure of who is winning.
  // Counted in hexes rather than in subhexes: a hex a coastline has cut in two is still one place on
  // the map, and counting it twice would make an area look larger for standing on a shore.
  const held = new Map();
  if (S.iso.own) {
    const seen = new Map();
    for (const [key, o] of S.iso.own) {
      let s = seen.get(o); if (!s) seen.set(o, s = new Set());
      s.add(nkH(key));
    }
    for (const [o, s] of seen) held.set(o, s.size);
  }
  S.iso.origins.forEach((og, i) => {
    const div = document.createElement('div');
    div.className = 'rtitem' + (i === S.iso.active ? ' on' : '');
    const n = held.get(i) || 0;
    const where = og.h == null ? 'unplaced' : n ? `${n} hex${n === 1 ? '' : 'es'}` : `hex ${og.h}`;
    div.innerHTML = `<span class="sw" style="background:${og.color}" title="Change colour"></span>` +
      `<span class="nm" title="Click to select, double-click to rename">${escHtml(og.name)}</span>` +
      `<span class="tm">${where}</span>` +
      `<span class="mn" title="More — copy or paste this origin's column, delete it">⋯</span>` +
      `<span class="x" title="Delete origin">×</span>`;
    div.querySelector('.sw').onclick = e => {
      e.stopPropagation();
      openColorPanelAt(e.currentTarget, `<b>${escHtml(og.name)}</b> — colour`,
                       ISO_COLORS, () => og.color,
                       c => { pushUndoRoutes('isocolor' + i); og.color = c; computeRoute(); });
    };
    div.querySelector('.nm').ondblclick = e => {
      e.stopPropagation();
      const n = prompt('Origin name:', og.name);
      if (n && n.trim()) { pushUndoRoutes(); og.name = n.trim(); computeRoute(); }
    };
    div.querySelector('.mn').onclick = e => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openIsoMenu(i, r.left, r.bottom + 3);
    };
    div.querySelector('.x').onclick = e => { e.stopPropagation(); removeIsoOrigin(i); };
    div.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); openIsoMenu(i, e.clientX, e.clientY); };
    // Selecting an origin changes what the column boxes below are editing, so the form must be reread.
    div.onclick = () => { S.iso.active = i; computeRoute(); };
    list.appendChild(div);
  });
}
function openIsoMenu(i, x, y) {
  const og = S.iso.origins[i];
  if (!og) return;
  openCtx(x, y, box => {
    ctxHead(box, `<b>${escHtml(og.name)}</b>${og.h == null ? ' — unplaced' : ` — hex ${og.h}`}`);
    ctxItem(box, 'Move to next click', () => {
      closeCtx();
      S.iso.active = i; S.isoPick = true;
      document.getElementById('isoPick').classList.add('on');
      computeRoute();
      toast('Click a hex to move ' + og.name);
    });
    ctxItem(box, 'Duplicate origin', () => { closeCtx(); cloneIsoOrigin(i); });
    ctxSep(box);
    ctxItem(box, 'Copy column', () => { closeCtx(); copyText(armyToText(og.set || SETTINGS), 'Column'); });
    ctxItem(box, 'Paste column', async () => {
      closeCtx();
      S.iso.active = i;
      // activeSettings() only answers "the origin's" while the Isochrone panel is the open one, and the
      // menu can be raised from anywhere. Write to the origin directly instead of trusting the ambient.
      const got = armyFromText(await pasteText('a column'));
      if (!got) { toast('No column found in that text', true); return; }
      pushUndoRoutes();
      og.set = { ...(og.set || SETTINGS), ...got };
      computeRoute();
      toast('Column pasted into ' + og.name);
    });
    ctxSep(box);
    ctxItem(box, 'Delete origin', () => { closeCtx(); removeIsoOrigin(i); }, 'danger');
  });
}
function cloneIsoOrigin(i) {
  const og = S.iso.origins[i];
  if (!og) return;
  pushUndoRoutes();
  const copy = { ...og, set: { ...(og.set || SETTINGS) }, color: freeIsoColor(), name: freeIsoName() };
  S.iso.origins.splice(i + 1, 0, copy);
  S.iso.active = i + 1;
  computeRoute();
  // Sitting exactly on top of the one it came from, which is invisible until it is moved — so say so.
  toast(copy.name + ' added on the same hex — click the map to move it');
}
function removeIsoOrigin(i) {
  if (!S.iso.origins[i]) return;
  pushUndoRoutes();
  S.iso.origins.splice(i, 1);
  if (S.iso.active >= S.iso.origins.length) S.iso.active = S.iso.origins.length - 1;
  computeRoute();
}
// Emptying the panel, reachable from the panel's own button and from the map's right-click menu, so
// the two can never drift apart. No confirmation, for the reason clearAllRoutes gives: it is one
// Ctrl+Z from being back, and a modal that stops the work to ask about something already undoable is
// friction pretending to be safety.
function clearAllIsoOrigins() {
  if (!S.iso.origins.length) return;
  pushUndoRoutes();
  S.iso.origins = []; S.iso.active = -1; S.iso.origin = null;
  S.iso.data = []; S.iso.parts = []; S.iso.own = null; S.iso.best = null; S.isoPick = false;
  document.getElementById('isoPick').classList.remove('on');
  computeRoute();
}
function addIsoOrigin() {
  migrateIso();
  pushUndoRoutes();
  S.iso.origins.push(newIsoOrigin(null, 0));
  S.iso.active = S.iso.origins.length - 1;
  // Armed rather than placed: an origin has to stand somewhere, and only the map knows where.
  S.isoPick = true;
  document.getElementById('isoPick').classList.add('on');
  computeRoute();
  closeSheet();
  toast('Click a hex to place ' + S.iso.origins[S.iso.active].name);
}
/* Where a click on the map goes. With no origins at all the first click makes one, because that is how
   this panel behaved when there was only ever one origin and nobody should have to find a button to get
   the old behaviour back. After that a click moves whichever origin is selected. */
function placeIsoOrigin(h, ri) {
  migrateIso();
  pushUndoRoutes();
  const og = activeIsoOrigin();
  if (og) { og.h = h; og.ri = ri | 0; }
  else {
    S.iso.origins.push(newIsoOrigin(h, ri));
    S.iso.active = S.iso.origins.length - 1;
  }
  S.isoPick = false;
}

function renderIso() {
  groups.iso.innerHTML = '';
  const lg = document.getElementById('isoLegend');
  lg.innerHTML = '';
  renderIsoList();
  if (!S.iso.own || !S.iso.own.size) return;
  const maxD = +document.getElementById('isoMax').value || 7;
  const opt = isoOptimizing();
  const relief = isoRelief();
  // All three modes shade the same way — bucket every hex, batch each bucket into one path — and
  // differ only in what the bucket means and what the chip beside it should say. Relief needs no
  // band at all: its figures are already whole days, so one band per day is the only honest cut,
  // and a half-day band would draw stripes across a number that never lands inside one.
  const band = opt || relief ? 1 : (+document.getElementById('isoBand').value || 1);
  const n = opt ? OPT_BUCKETS : relief ? maxD + 1 : Math.max(1, Math.ceil(maxD / band));
  const color = opt ? optColor : isoColor;
  // The epsilon is not decoration: 4 − 3.2 lands a hair under 0.8 while 2 − 1.2 lands a hair over,
  // so without it two costs that waste the same 0.8 of a day would be shaded differently. Nudging
  // down puts every exact boundary in the kinder bucket, and the chip labels read that way too.
  const bucket = opt ? d => Math.max(0, Math.min(n - 1, Math.floor(optWaste(d) * n - 1e-9)))
                     : relief ? d => Math.max(0, Math.min(n - 1, Math.round(d)))
                     : d => Math.min(n - 1, Math.floor(d / band));
  // "≤ 2 d" would be a lie in relief mode: these are exact whole-day totals, and a hex in the 2 band
  // takes two days, not up to two.
  const label = opt ? b => `${(b / n).toFixed(1)}–${((b + 1) / n).toFixed(1)} d`
                    : relief ? b => `${b} d`
                    : b => `≤ ${((b + 1) * band).toFixed(band < 1 ? 1 : 0)} d`;
  /* Shaded by the time its *own* origin takes to reach it — `best` is already the winner's figure and
     already inside maxD, so a piece of ground belongs to exactly one band whoever holds it.

     The shape painted is the region's, not the hex's, which is the whole point: a port whose bay a
     fleet can enter and whose quay an army cannot reach shades the water and leaves the land bare.
     `evenodd` because a region can come back as several loops — a strip and an island it encloses —
     and the enclosing water has to punch a hole rather than paint over what it surrounds. Regions
     never overlap, so batching a few hundred of them into one path is safe under that rule. */
  const byBand = [];
  for (const [key, d] of S.iso.best) {
    const h = nkH(key), r = region(h, nkRi(key));
    if (!r) continue;
    const b = bucket(d);
    byBand[b] = (byBand[b] || '') + regionShape(h, r);
  }
  byBand.forEach((d, b) => { if (d) el('path', { d, fill: color(b, n), 'fill-rule': 'evenodd', stroke: 'none' }, groups.iso); });
  /* Outlines after every fill: a border drawn before the neighbouring area is painted would be half
     buried by it. Two passes rather than one, because a coloured line laid straight onto these fills
     has almost nothing to read against — the palette and the green-to-red ramp are the same brightness,
     and a yellow border on a yellow band disappears. So every border gets a dark casing first and its
     colour on top of that, which is how a road is drawn on a paper map and for the same reason.

     Both passes run over every area before the next begins, so one area's casing cannot bury the
     neighbour's colour along a border they share. The active area goes last in the colour pass, so
     where two borders coincide the one you are editing is the one you see.

     What is stroked is the area's whole shape, every piece of it, and a mask then hides everything
     lying inside that shape. The inner half of each line goes with it, and so does every line
     between two pieces the same area holds, since both halves of those are interior — what survives
     is the silhouette. Each area masks with its own shape, so a border two of them share is still
     drawn twice, once in each colour. Widths are doubled to compensate: half of every stroke is
     being thrown away. */
  const outlines = S.iso.origins.map((og, i) => ({ og, i, d: isoAreaD(i) })).filter(o => o.d);
  const lineW = i => i === S.iso.active ? 4.2 : 3;
  for (const { d, i } of outlines) {
    const id = 'isoEdgeMask' + i;
    const mask = el('mask', { id, maskUnits: 'userSpaceOnUse',
                              x: 0, y: 0, width: S.G.image_width, height: S.G.image_height }, groups.iso);
    el('rect', { x: 0, y: 0, width: S.G.image_width, height: S.G.image_height, fill: '#fff' }, mask);
    el('path', { d, fill: '#000', 'fill-rule': 'evenodd' }, mask);
  }
  for (const { d, i } of outlines)
    el('path', { d, fill: 'none', stroke: '#0c1015', 'stroke-width': 2 * (lineW(i) + 2.6),
                 'stroke-linejoin': 'round', opacity: 0.55, mask: `url(#isoEdgeMask${i})` }, groups.iso);
  for (const { d, og, i } of [...outlines].sort((a, b) => (a.i === S.iso.active) - (b.i === S.iso.active)))
    el('path', { d, fill: 'none', stroke: og.color, 'stroke-width': 2 * lineW(i),
                 'stroke-linejoin': 'round', mask: `url(#isoEdgeMask${i})` }, groups.iso);
  S.iso.origins.forEach((og, i) => {
    if (og.h == null) return;
    const [ox, oy] = nodePoint(og.h, og.ri | 0);
    const act = i === S.iso.active;
    el('circle', { cx: ox, cy: oy, r: act ? 6.5 : 5.5, fill: '#fff', stroke: og.color,
                   'stroke-width': act ? 2.8 : 2 }, groups.iso);
  });
  // Waste is not a distance, and five chips reading "0.4–0.6 d" would be taken for one if left
  // unlabelled beside the band legend they replace.
  if (opt || relief) {
    const cap = document.createElement('div');
    cap.className = 'isocap';
    cap.textContent = relief ? 'Days from the news dropping to the relief arriving — word out, then the march back:'
                             : 'Day thrown away by rounding the order up:';
    lg.appendChild(cap);
  }
  for (let b = 0; b < n; b++) {
    const div = document.createElement('div');
    div.className = 'isochip';
    div.innerHTML = `<span class="sw" style="background:${color(b, n)}"></span>${label(b)}`;
    lg.appendChild(div);
  }
  if (opt || relief) {
    const foot = document.createElement('div');
    foot.className = 'isocap dim';
    foot.textContent = relief
      ? 'Every shaded hex arrives inside the budget; the greener ones arrive with days in hand, and the reddest spend the whole of it.'
      : 'Green halts spend their last day almost to the hour; red ones have just bought a day they barely use.';
    lg.appendChild(foot);
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
  migrateIso();
  // The active *route's* army, named explicitly rather than taken from armyOpts()'s ambient answer:
  // that now depends on which panel is open, and the readout below must describe the route whatever
  // panel that happens to be.
  const o = armyOpts(S.routes[S.activeRoute]?.set);
  const mode = isoMode();
  const isoMax = +document.getElementById('isoMax').value || 7;
  const newsSpeed = RULES.SPREAD[document.getElementById('isoNews')?.value || 'rumour'] || RULES.SPREAD.rumour;
  // One reach map per origin, each under its own column. Straight-line spreads ignore the column
  // entirely, so for those the two origins differ only in where they stand. Relief keeps its two
  // legs alongside the total, because the total on its own does not say which of them is the
  // constraint — and that is the whole of what you do about it.
  S.iso.parts = [];
  S.iso.data = S.iso.origins.map((og, i) => {
    if (og.h == null) return null;
    if (mode === 'relief') {
      const r = reliefAll(og, armyOpts(og.set), newsSpeed, isoMax);
      S.iso.parts[i] = r.parts;
      return r.best;
    }
    return mode === 'message' ? spreadAll(og, RULES.SPREAD.message, isoMax)
         : mode === 'rumour' ? spreadAll(og, RULES.SPREAD.rumour, isoMax)
         : dijkstraAll(og, armyOpts(og.set), isoMax);
  });
  assignIsoOwners(isoMax);
  renderIso();
  const results = [];
  S.routes.forEach((rt, i) => {
    const act = i === S.activeRoute;
    rt.wps.forEach(w => {
      const [cx, cy] = endPoint(w.h, w.ri | 0); // every waypoint is a stop, and stops sit at the marker
      const sea = !!(region(w.h, w.ri | 0)?.sea && !region(w.h, w.ri | 0)?.river);
      el('circle', { cx, cy, r: act ? 6 : 5, fill: sea ? rt.color : 'none', stroke: rt.color,
                     'stroke-width': act ? 2.4 : 1.8, opacity: act ? 1 : 0.7, 'data-rt': i }, groups.route);
    });
    const r = rt.wps.length > 1 ? routeLeg(rt, armyOpts(rt.set)) : null;
    if (r && r.pts.length > 1)
      el('path', { d: featPathD(r.pts), fill: 'none', stroke: rt.color, 'stroke-width': act ? 2.8 : 2,
                   'stroke-dasharray': '7,5', 'stroke-linecap': 'round', opacity: act ? 0.95 : 0.55,
                   'data-rt': i }, groups.route);
    results.push(r);
  });
  lastResults = results;
  renderRouteList(results);
  syncRouteForm();
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
    // The ⌂ marks a stronghold the column is actually standing in, which on a split hex is a question
    // about the bank, not the hex.
    const terr = terrainLabel(st.h, st.ri, st.sea) + (hasStronghold(st.h, st.ri) ? ' ⌂' : '');
    const sameHex = st.h === prevH; prevH = st.h;
    // Shuffling about inside one hex — embarking into its own water, crossing its own bridge — is
    // bookkeeping the solver needs and the reader does not. It only earns a row if it costs
    // something; the free ones would otherwise double every port and every bridge in the list.
    if (j > 0 && sameHex && st.irl < 0.005) return '';
    const forced = j > 0 && rt.wps[st.leg]?.f;
    const cls = `class="strow${forced ? ' forced' : ''}"`;
    const attrs = `${cls} data-step="${j}"`;
    if (j === 0) return `<tr ${attrs}><td>${hexLbl}</td><td class="dim">${terr}</td><td class="dim">start</td><td></td><td></td><td></td></tr>`;
    // Miles for this step: a trade hop covers several hexes in one go and knows its own length.
    const nh = sameHex ? 0 : (st.hexes ?? (st.chain ? st.chain.length - 1 : 1));
    const mi = sameHex ? 0 : Math.round(st.miles ?? nh * RULES.HEX_MILES);
    const note = st.note || '';
    const via = note + (forced ? ' <span class="fm">forced</span>' : '');
    return `<tr ${attrs}><td title="${escHtml(hexLbl)}">${sameHex ? '' : hexLbl}</td>` +
           `<td class="dim" title="${escHtml(terr)}">${terr}</td><td title="${escHtml(note)}">${via}</td>` +
           `<td class="dim">${mi || ''}</td><td>${st.irl.toFixed(2)}</td><td>${cum.toFixed(1)}</td></tr>`;
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
    (() => {
      const legs = rt.wps.filter(w => w.f).length;
      if (!legs) return '';
      // Sections, not just legs: a route can be pushed in several separate bursts.
      let runs = 0;
      rt.wps.forEach((w, i) => { if (w.f && !rt.wps[i - 1]?.f) runs++; });
      return `<div class="fmnote">Forced march: ${runs} section${runs > 1 ? 's' : ''}, ` +
             `${legs} of ${Math.max(1, rt.wps.length - 1)} legs — right-click a step to change where.</div>`;
    })() +
    `<table><tr><td>Distance</td><td>${r.hexes} hexes ≈ ${Math.round(r.miles ?? r.hexes * RULES.HEX_MILES)} mi</td></tr>` +
    `<tr><td>Column</td><td>${o.colMiles.toFixed(1)} mi${o.colMiles > RULES.LONG_COLUMN.limit ? ' <span class="warn">(over 6 mi — slowed)</span>' : ''}</td></tr>${paceRow}</table>` +
    `<div class="steps"><table class="stepstbl" id="stepsTbl">` +
    `<colgroup><col class="c-hex"><col class="c-terr"><col class="c-via">` +
    `<col class="c-num"><col class="c-num"><col class="c-num"></colgroup>` +
    `<tr class="hd">` +
    ['Hex', 'Terrain', 'Via', 'mi', 'Cost', 'Σ'].map((h, i) =>
      `<td${['', '', '', ' title="Miles covered by this step"',
            ' title="What this step costs, in IRL days"', ' title="Running total, IRL days"'][i]}>${h}` +
      (i < 5 ? `<span class="colgrip" data-col="${i}" title="Drag to resize · double-click to reset"></span>` : '') +
      `</td>`).join('') +
    `</tr>` +
    rows + `</table></div>` +
    `<p class="hint">Right-click a step to force the march from there, or to split the route.
     Drag a column edge to resize it.</p>`;
  applyColWidths();
}

/* Which waypoint, if any, a click means. Not the marker — hitting a 6-unit circle is fussy work, and
   a waypoint belongs to a place, not to the few pixels its dot covers. So the whole hex counts, with
   the subhex you clicked preferred: on a split hex the sea waypoint and the land one are different
   waypoints, and you should be able to say which. Ties break to the active route, then to the later
   waypoint — the one drawn on top, hence the one you were looking at. */
function waypointAt(h, ri) {
  let best = null, bs = Infinity;
  S.routes.forEach((rt, i) => {
    rt.wps.forEach((w, wi) => {
      if (w.h !== h) return;
      const score = (i === S.activeRoute ? 0 : 2) + ((w.ri | 0) === (ri | 0) ? 0 : 1);
      if (score <= bs) { bs = score; best = { ri: i, wi }; }
    });
  });
  return best;
}
// An empty route is left standing, exactly as removing the last waypoint by button leaves it: the
// route is still yours to add to, and deleting it is the × in the list.
/* ---------------- acting on a step of the readout ----------------
   A step is a hex the column passes through, and the two things worth doing there — pushing the pace
   from here, cutting the route in two here — are both really about *waypoints*: the solver works leg
   by leg between them, so a leg is the smallest thing that can have a pace of its own. Rather than
   make you place a waypoint first and then find it again, marking a step puts one there.

   `lastResults` is what the readout was last drawn from, so a click can look up the step it names. */
let lastResults = [];
let fmPending = null;   // {ri, wi} — a forced march started but not yet ended

// The waypoint index this step sits at, planting one if the step is merely passed through.
function waypointAtStep(ri, j) {
  const rt = S.routes[ri], st = lastResults[ri]?.steps?.[j];
  if (!rt || !st) return -1;
  if (j === 0) return 0;
  if (st.wp) return st.leg + 1;            // the step *is* the waypoint that ends its leg
  const at = st.leg + 1;
  rt.wps.splice(at, 0, { h: st.h, ri: st.ri | 0, f: rt.wps[st.leg]?.f });
  return at;
}
/* Every leg from `a` up to (not including) `b` marches at the forced pace. A route can hold as many
   of these as you like — a dash to the river, an ordinary march along it, another dash at the end —
   so marking one never disturbs the others.

   `f === 2` is a provisional run: named a start but not yet an end, so it reaches the finish for
   now. Ending the push converts the part before the end and drops the rest, leaving any committed
   sections elsewhere in the route exactly as they were. */
function setForcedSpan(ri, a, b, mark) {
  const rt = S.routes[ri];
  const lo = Math.min(a, b), hi = Math.max(a, b);
  rt.wps.forEach((w, i) => { if (i >= lo && i < hi) w.f = mark || true; });
}
function clearForced(ri) {
  pushUndoRoutes();
  for (const w of S.routes[ri].wps) delete w.f;
  fmPending = null;
  computeRoute();
}
function startForcedAt(ri, j) {
  pushUndoRoutes();
  const wi = waypointAtStep(ri, j);
  if (wi < 0) return;
  fmPending = { ri, wi };
  // Until an end is named, the push runs to the finish — the common case, and one click is enough
  // when the army simply keeps going. Marked provisionally so ending it can trim the tail back
  // without touching a section marked earlier in the route.
  setForcedSpan(ri, wi, S.routes[ri].wps.length - 1, 2);
  computeRoute();
}
function endForcedAt(ri, j) {
  pushUndoRoutes();
  const wi = waypointAtStep(ri, j);
  if (wi < 0) return;
  const wps = S.routes[ri].wps;
  // Which push is being ended: the one just started, or failing that the last one begun before here.
  let from = (fmPending && fmPending.ri === ri) ? fmPending.wi : -1;
  if (from < 0) for (let i = wi - 1; i >= 0; i--) { if (!wps[i].f) break; from = i; }
  // Only the provisional tail is given up. Sections settled earlier keep their marks.
  wps.forEach(w => { if (w.f === 2) delete w.f; });
  if (from >= 0 && from < wi) setForcedSpan(ri, from, wi);
  fmPending = null;
  computeRoute();
}
// Cut the route in two at this step. Both halves keep the hex, so the second picks up exactly where
// the first stops, and the new one inherits the column and conditions it was flying under.
function splitRouteAt(ri, j) {
  const rt = S.routes[ri];
  pushUndoRoutes();
  const wi = waypointAtStep(ri, j);
  if (wi <= 0 || wi >= rt.wps.length - 1) return;   // nothing on one side of the cut
  const tail = rt.wps.slice(wi).map(w => ({ ...w }));
  rt.wps = rt.wps.slice(0, wi + 1);
  const used = new Set(S.routes.map(r => r.color));
  const half = {
    name: 'Route ' + (S.routes.length + 1),
    color: PALETTE.find(c => !used.has(c)) || PALETTE[S.routes.length % PALETTE.length],
    wps: tail, set: { ...(rt.set || SETTINGS) },
  };
  adoptTokenColor(half);      // a counter waiting at the cut names the second half too
  S.routes.splice(ri + 1, 0, half);
  S.activeRoute = ri + 1;
  computeRoute();
}

function removeWaypoint(ri, wi) {
  const rt = S.routes[ri];
  if (!rt || wi < 0 || wi >= rt.wps.length) return;
  pushUndoRoutes();
  rt.wps.splice(wi, 1);
  computeRoute();
}

/* ---------------- a march, as a line of text ----------------
   Orders are written in prose, and the thing wanted in them is the sequence: which hexes, over what
   ground, and where the column takes ship. Reading that off the table a row at a time is transcription
   work, and transcription is where a hex number goes wrong. So the readout can hand over the whole
   march as one line.

   The same rule as the table decides what earns a place: shuffling about inside one hex is bookkeeping
   the solver needs, and only appears if it cost something — which is exactly what makes embarking and
   disembarking show up as stages of their own, between hexes rather than attached to one. */
/* Two readings of the same march, because an order and a note to yourself want different things.

   The *detailed* one is the readout in a line: every hex with the ground it crosses and what the step
   cost, plus embarking and disembarking as stages of their own, under a summary line. That is what goes
   into written orders, where a ford nobody mentioned is a problem.

   The *simple* one is the chain of hex numbers, plus the moments the column is not marching at all.
   Taking ship is a week standing still and getting off again is a day, and a list of hexes that passes
   over them in silence reads as a much shorter journey than it is — so those keep their place, named
   and costed, while everything about the ground underfoot is dropped. */
function stepsToText(ri, simple) {
  const rt = S.routes[ri], r = lastResults[ri];
  if (!rt || !r || r.fail || !r.steps?.length) return null;
  const parts = [];
  let prevH = null;
  r.steps.forEach((st, j) => {
    const sameHex = st.h === prevH; prevH = st.h;
    if (simple) {
      if (!sameHex) { parts.push(String(st.h)); return; }
      // A stage inside a hex is not another place to march to, so it only earns a place by costing
      // something — which is exactly what distinguishes embarking from shuffling over a bridge.
      if (j > 0 && st.irl >= 0.005) parts.push(stageLabel(st));
      return;
    }
    if (j > 0 && sameHex && st.irl < 0.005) return;
    const terr = terrainLabel(st.h, st.ri, st.sea).toLowerCase();
    if (j === 0) parts.push(`${st.h} (${terr}, start)`);
    else if (sameHex) parts.push(st.note || 'in hex');       // a stage, not a hex: embark, disembark
    else parts.push(`${st.h} (${terr}${st.note ? ', ' + st.note : ''})`);
  });
  if (simple) return parts.join(' -> ');
  const game = r.irl * RULES.GAME_DAYS_PER_IRL;
  const miles = Math.round(r.miles ?? r.hexes * RULES.HEX_MILES);
  // The summary goes on its own line so it can be deleted with one keystroke by anyone who only
  // wanted the chain — and so its numbers stay off the line the importer reads.
  return `${rt.name} — ${r.irl.toFixed(1)} IRL days (${game.toFixed(0)} in-game), ` +
         `${r.hexes} hexes ≈ ${miles} mi\n` + parts.join(' -> ');
}
/* A pause named plainly, for the simple chain. The solver's own notes say how the cost was arrived at
   — "secure ships +7d" is a month of shipwrighting, "re-embark +1d" is going back aboard after a
   landing — but an order only needs to know the column stops and for how long, so both come out as
   Embark. Anything else that costs time without moving keeps its own note rather than being flattened
   into a word that might not be true of it. */
function stageLabel(st) {
  const note = st.note || '';
  // Anything else that costs time without moving is a halt. Repeating the solver's own note here would
  // print its "+7d" alongside the duration and say the same thing twice in two different notations —
  // and in practice nothing but embarking and disembarking ever reaches this line.
  const what = /^(secure ships|re-embark)/.test(note) ? 'Embark'
             : /^disembark/i.test(note) ? 'Disembark'
             : 'Halt';
  // Whole days stay whole: "7 days", not "7.0 days". A fraction is worth a decimal, and nothing here
  // is ever finer than that.
  const d = st.irl;
  const n = Number.isInteger(d) ? String(d) : d.toFixed(1);
  return `${what} (${n} day${d === 1 ? '' : 's'})`;
}
// Both buttons and both menu entries end up here, so the "nothing to copy" case is stated once.
function copySteps(ri, simple) {
  const t = stepsToText(ri, simple);
  if (t) copyText(t, simple ? 'Hexes' : 'March');
  else toast('Nothing to copy — no solved march on that route', true);
}

/* Hex numbers back out of pasted text, in the order they appear. Everything else is ignored, so a line
   copied from Copy hexes comes back unedited, and so does one typed by hand as "948 949 950".

   Numbers that are not hexes have to go before looking, and a march line is full of them:
     · inside brackets — a ford's "+0.5d", a trade route's mileage;
     · costs standing on their own, because embarking is a stage rather than a hex and arrives written
       as "secure ships +7d". That 7 is a month of shipwrighting, and left alone it silently becomes
       a waypoint in hex 7;
     · our own summary line, where "5.0 IRL days, 12 hexes ≈ 240 mi" offers four plausible hex ids.
   Where the text has an arrow chain, that chain is the only part worth reading at all. */
function hexListFromText(txt) {
  const lines = String(txt || '').split(/\r?\n/);
  const chain = lines.filter(l => /->|→|—>/.test(l));
  const src = (chain.length ? chain : lines.filter(l => !/IRL day/i.test(l))).join(' ')
    .replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/[+-]\s*\d+(?:\.\d+)?\s*d\b/gi, ' ')                    // "+7d", "+0.5d" — a cost
    .replace(/\d+(?:\.\d+)?\s*(?:mi|miles|hexes?|days?)\b/gi, ' ')   // "240 mi", "12 hexes"
    .replace(/\d+\.\d+/g, ' ');                 // any remaining decimal is a cost, never a hex
  const out = [], skipped = [];
  for (const m of src.matchAll(/\d+/g)) {
    const h = +m[0];
    if (!S.hexes[h] || S.hexes[h].t === 'N/A') { skipped.push(h); continue; }
    if (out[out.length - 1] !== h) out.push(h);  // a repeat is the same hex twice, not a second stop
  }
  return { hexes: out, skipped };
}
// A pasted list names hexes, not subhexes: which bank of a split hex the column is on is not in the
// text. Land is the safe reading — the solver finds its own way across a bridge or aboard a ship — so
// the first marchable region wins, falling back to 0 for a hex that is all water.
function landRi(h) {
  const i = regionsOf(h).findIndex(regWalkable);
  return i < 0 ? 0 : i;
}
// `ri` names the route to paste into, defaulting to the active one — the card's button has no other
// route in mind, but a route's own menu does, and pasting into the wrong route because it happened to
// be selected is not a mistake worth leaving available.
function applyHexList(txt, ri = S.activeRoute) {
  const { hexes, skipped } = hexListFromText(txt);
  const rt = S.routes[ri];
  if (!rt) { toast('No route to paste into — make one first', true); return; }
  if (hexes.length < 2) { toast('Need at least two hex numbers; found ' + hexes.length, true); return; }
  pushUndoRoutes();
  rt.wps = hexes.map(h => ({ h, ri: landRi(h) }));
  computeRoute();
  toast(`${hexes.length} waypoints into ${rt.name}` +
        (skipped.length ? ` · ignored ${skipped.length} number${skipped.length > 1 ? 's' : ''} that name no hex` : ''));
}

/* ---------------- duplicating and emptying a route ----------------
   Planning is comparative: the same column by the north road and by the south, or this march in clear
   weather and in snow. Both start from a route that already exists, and rebuilding it waypoint by
   waypoint to change one thing is the tedious part.

   A copy takes the waypoints, the column and the conditions, and gets a colour of its own — two
   identical lines in the same colour would be one line as far as the eye is concerned. */
function nextCopyName(base) {
  const stem = base.replace(/ copy( \d+)?$/, '');
  const taken = new Set(S.routes.map(r => r.name));
  if (!taken.has(stem + ' copy')) return stem + ' copy';
  for (let k = 2; ; k++) if (!taken.has(`${stem} copy ${k}`)) return `${stem} copy ${k}`;
}
function cloneRoute(i) {
  const rt = S.routes[i];
  if (!rt) return;
  pushUndoRoutes();
  const used = new Set(S.routes.map(r => r.color));
  const copy = {
    name: nextCopyName(rt.name),
    color: PALETTE.find(c => !used.has(c)) || rt.color,
    wps: rt.wps.map(w => ({ ...w })),          // waypoints carry forced-march marks; copy, don't share
    set: { ...(rt.set || SETTINGS) },
  };
  S.routes.splice(i + 1, 0, copy);
  S.activeRoute = i + 1;                        // the copy is what you are about to change
  computeRoute();
  toast('Duplicated as ' + copy.name);
}
// Emptied, not deleted: the route keeps its name, colour and column, and is ready to be walked
// somewhere else. Removing it altogether is still the × in the list.
function clearRouteWaypoints(i) {
  const rt = S.routes[i];
  if (!rt || !rt.wps.length) { toast('That route has no waypoints'); return; }
  pushUndoRoutes();
  const n = rt.wps.length;
  rt.wps = [];
  if (fmPending && fmPending.ri === i) fmPending = null;   // its waypoint is gone with the rest
  S.activeRoute = i;
  computeRoute();
  toast(`Cleared ${n} waypoint${n > 1 ? 's' : ''} from ${rt.name} — Ctrl+Z to undo`);
}

// Everything a route can be asked to do that is not worth a permanent button. Right-click the row, or
// tap its ⋯ — a touchscreen has no second button, and these are exactly the operations someone on a
// tablet still needs.
function openRouteMenu(i, x, y) {
  const rt = S.routes[i];
  if (!rt) return;
  openCtx(x, y, box => {
    ctxHead(box, `<b>${escHtml(rt.name)}</b> — ${rt.wps.length} waypoint${rt.wps.length === 1 ? '' : 's'}`);
    ctxItem(box, 'Duplicate route', () => { closeCtx(); cloneRoute(i); });
    ctxSep(box);
    ctxItem(box, 'Copy hexes — simple<span class="arw">948 -&gt; 949</span>',
            () => { closeCtx(); copySteps(i, true); });
    ctxItem(box, 'Copy hexes — detailed<span class="arw">with terrain</span>',
            () => { closeCtx(); copySteps(i, false); });
    // Replaces this route's waypoints, not the selected route's — the menu was opened on a particular
    // row and that is the route it should act on.
    ctxItem(box, 'Paste hexes', async () => {
      closeCtx();
      applyHexList(await pasteText('a list of hexes'), i);
    });
    ctxSep(box);
    ctxItem(box, 'Copy column', () => { closeCtx(); copyText(armyToText(rt.set || SETTINGS), 'Column'); });
    ctxItem(box, 'Paste column', async () => {
      closeCtx();
      S.activeRoute = i;                       // paste into the route whose menu this is
      applyArmyText(await pasteText('a column'));
    });
    ctxSep(box);
    ctxItem(box, 'Clear waypoints', () => { closeCtx(); clearRouteWaypoints(i); }, 'danger');
    ctxItem(box, 'Delete route', () => {
      closeCtx();
      pushUndoRoutes();
      S.routes.splice(i, 1);
      if (S.activeRoute >= S.routes.length) S.activeRoute = S.routes.length - 1;
      computeRoute();
    }, 'danger');
  });
}

function renderRouteList(results) {
  const list = document.getElementById('routeList');
  list.innerHTML = S.routes.length ? '' : '<div class="emptynote">No routes yet — click a hex, or right-click one and Start a route here.</div>';
  S.routes.forEach((rt, i) => {
    const div = document.createElement('div');
    div.className = 'rtitem' + (i === S.activeRoute ? ' on' : '');
    const r = results[i];
    const tm = r ? (r.fail ? '✗' : r.irl.toFixed(1) + 'd') : rt.wps.length + ' wp';
    div.innerHTML = `<span class="sw" style="background:${rt.color}" title="Change colour"></span>` +
      `<span class="nm" title="Click to activate, double-click to rename">${rt.name}</span>` +
      `<span class="tm">${tm}</span>` +
      `<span class="mn" title="More — duplicate, copy hexes or column, clear waypoints">⋯</span>` +
      `<span class="x" title="Delete route">×</span>`;
    div.querySelector('.mn').onclick = e => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openRouteMenu(i, r.left, r.bottom + 3);
    };
    // The row itself too, since that is where a right-click naturally lands.
    div.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); openRouteMenu(i, e.clientX, e.clientY); };
    div.querySelector('.sw').onclick = e => {
      e.stopPropagation();
      openColorPanelAt(e.currentTarget, `<b>${escHtml(rt.name)}</b> — colour`,
                       ROUTE_COLORS, () => rt.color,
                       c => { pushUndoRoutes('rtcolor' + i); rt.color = c; recolorRoute(i); });
    };
    div.querySelector('.x').onclick = e => {
      e.stopPropagation();
      pushUndoRoutes();
      S.routes.splice(i, 1);
      if (S.activeRoute >= S.routes.length) S.activeRoute = S.routes.length - 1;
      computeRoute();
    };
    div.querySelector('.nm').ondblclick = e => {
      e.stopPropagation();
      const n = prompt('Route name:', rt.name);
      if (n) { pushUndoRoutes(); rt.name = n; computeRoute(); }
    };
    div.onclick = () => { S.activeRoute = i; computeRoute(); };
    list.appendChild(div);
  });
  updateDrawerBadge(results);
}

/* Recolouring is not recomputing. computeRoute() re-runs the pathfinding for every route, which is
   far too much to do on each frame of a dragged colour picker — and the geometry hasn't changed
   anyway. So the drawn line, the sidebar swatch and the readout heading are repainted in place. */
function recolorRoute(i) {
  const rt = S.routes[i];
  if (!rt) return;
  for (const e of groups.route.querySelectorAll(`[data-rt="${i}"]`)) {
    e.setAttribute('stroke', rt.color);
    if (e.getAttribute('fill') !== 'none') e.setAttribute('fill', rt.color);  // sea waypoints are filled
  }
  const sw = document.querySelectorAll('#routeList .rtitem')[i]?.querySelector('.sw');
  if (sw) sw.style.background = rt.color;
  if (i === S.activeRoute) {
    const big = document.querySelector('#routeOut .big');
    if (big) big.style.color = rt.color;
  }
  saveRoutes();
}

function saveRoutes() {
  const j = snapRoutes();
  routesSnap = j;              // what undo restores to, should the next change be to a route
  try { localStorage.setItem('rotmap_routes_v1', j); } catch {}
}

/* ---------------- interactions ---------------- */
let pan = null, downPos = null, spaceHeld = false, edgeSnap = false;
let tokDrag = null;   // { t, g, p, dx, dy, moved, target } while a token is under the pointer
// The click that puts an open context menu away does nothing else — it must not also drop a waypoint
// on whatever hex happened to be under it.
let ctxDismiss = false;

// Touch: every live pointer is tracked so that a second finger can be recognised as a pinch. A
// finger also needs more slack than a mouse before a press counts as a drag rather than a tap —
// nobody holds a thumb within 5px while tapping.
const ptrs = new Map();
let pinch = null;      // { d, vb, wx, wy } — finger distance and viewBox as the gesture began
let tapDead = false;   // a pinch happened; ignore the taps as the fingers come off
const tapSlop = e => (e.pointerType === 'mouse' ? 5 : 12);

/* Hold a finger still on a hex to read it. A mouse has hover, and everything the tooltip says — the
   terrain, the stronghold, which subhex you are over, the region it belongs to — was reachable no
   other way on a touchscreen, since a tap there means "put a waypoint here". A press that stays put
   for a moment means neither, so it can mean "tell me about this".

   Once the press has been held, the finger becomes a cursor: keep holding and slide it, and the
   readout follows from hex to hex instead of the map panning under it — which is how you compare a
   row of strongholds without lifting off and holding again on each one. Panning is what a finger that
   *hasn't* waited does, so nothing is lost. */
const LONG_PRESS_MS = 450;
let longPress = null, longPressed = false;

function showReadout(pt) {
  onHover(pt);
  if (tooltip.hidden) return;
  // Measure it from the left edge first. Left where onHover put it — up against the right edge of the
  // map — there is no room, so the box wraps itself into a narrow column and reports that width; a
  // reading taken then would be of the squeezed shape, not the one about to be positioned.
  tooltip.style.left = '0px';
  tooltip.style.top = '0px';
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  // Above the fingertip rather than under it, where a hand would cover it, and never off the edge.
  const wr = svg.parentElement.getBoundingClientRect();
  tooltip.style.left = Math.max(6, Math.min(wr.width - w - 6, pt.clientX - wr.left - w / 2)) + 'px';
  tooltip.style.top = Math.max(6, pt.clientY - wr.top - h - 20) + 'px';
}
function startLongPress(e) {
  cancelLongPress();
  const pt = { clientX: e.clientX, clientY: e.clientY, altKey: false, shiftKey: false };
  longPress = setTimeout(() => {
    longPress = null;
    longPressed = true;   // lifting the finger now drops no waypoint, and moving it inspects
    pan = null;           // whatever pan this press had optimistically started is off
    // Held on a token, the same gesture stands in for the right-click a touchscreen hasn't got.
    if (tokDrag && !tokDrag.moved) { openCtx(pt.clientX, pt.clientY, tokenMenu(tokDrag.t)); return; }
    showReadout(pt);
  }, LONG_PRESS_MS);
}
function cancelLongPress() {
  clearTimeout(longPress);
  longPress = null;
}

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
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' });
  cancelLongPress();
  if (ptrs.size === 2) { startPinch(); tapDead = true; return; }
  if (ptrs.size > 2) return;
  tapDead = false;
  longPressed = false;
  downPos = [e.clientX, e.clientY];
  if (e.pointerType !== 'mouse') {
    tooltip.hidden = true; groups.hover.innerHTML = '';   // a new touch puts the last readout away
    startLongPress(e);
  }
  // A press that lands on a token belongs to the token: it never pans, never draws, never places a
  // waypoint. What it turns into — a colour cycle or a move — is decided on the way up.
  const grabbed = (e.button === 0 && !spaceHeld) ? e.target.closest?.('[data-tok]') : null;
  if (grabbed) {
    const t = tokenById(+grabbed.dataset.tok);
    if (t) {
      const [wx, wy] = toWorld(e);
      const p = grabbed._p || { x: wx, y: wy };
      tokDrag = { t, g: grabbed, p, dx: p.x - wx, dy: p.y - wy, moved: false, target: t.h };
      svg.setPointerCapture(e.pointerId);
      return;
    }
  }
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
  const prev = ptrs.get(e.pointerId);
  if (prev) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, touch: prev.touch });
  // Sliding before the hold has registered is panning: the press has stopped being a long one.
  if (longPress && downPos && Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > tapSlop(e)) cancelLongPress();
  if (pinch) { if (ptrs.size >= 2) movePinch(); return; }
  if (tokDrag) {
    if (longPressed) return;   // the hold became the token's menu; leave it where it is
    if (!tokDrag.moved && downPos && Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) <= tapSlop(e)) return;
    tokDrag.moved = true;
    cancelLongPress();
    const [wx, wy] = toWorld(e);
    const h = nearestHex(wx, wy);
    tokDrag.target = (h && S.hexes[h].t !== 'N/A') ? h : null;
    // The token follows the pointer directly, rather than jumping from hex centre to hex centre —
    // then lands on whichever hex it was let go over, outlined here so there is no doubt which.
    tokDrag.g.setAttribute('transform',
      `translate(${(wx + tokDrag.dx - tokDrag.p.x).toFixed(2)} ${(wy + tokDrag.dy - tokDrag.p.y).toFixed(2)})`);
    groups.hover.innerHTML = '';
    tooltip.hidden = true;
    if (tokDrag.target) {
      const [cx, cy] = hexCenter(tokDrag.target);
      el('path', { d: hexPath(cx, cy), fill: 'rgba(255,255,255,.10)', stroke: '#fff',
                   'stroke-width': 1.8, 'pointer-events': 'none' }, groups.hover);
    }
    return;
  }
  // Sliding *after* it has registered drags the readout across the map instead.
  if (longPressed && ptrs.has(e.pointerId)) {
    pan = null;
    showReadout({ clientX: e.clientX, clientY: e.clientY, altKey: false, shiftKey: false });
    return;
  }
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
  cancelLongPress();
  // A pinch must not leave a tap behind as the fingers lift, one after the other; neither must a
  // press held long enough to have been asking about the hex instead.
  const afterPinch = !!pinch || tapDead || longPressed;
  dropPointer(e);
  if (tokDrag) {
    const d = tokDrag;
    tokDrag = null;
    pan = null; downPos = null;
    groups.hover.innerHTML = '';
    // renderTokens() either way: it clears the transform the drag was following the pointer with,
    // which is also how a token let go off the edge of the map finds its way back.
    if (afterPinch) { renderTokens(); return; }
    if (!d.moved) {
      const i = TOKEN_COLORS.indexOf(d.t.color);
      d.t.color = TOKEN_COLORS[(i + 1) % TOKEN_COLORS.length];   // a custom colour rejoins at the start
    } else if (d.target) d.t.h = d.target;
    commitTokens();
    return;
  }
  if (ctxDismiss) { ctxDismiss = false; pan = null; S.dragErase = null; downPos = null; return; }
  if (afterPinch) {
    pan = null; S.dragErase = null; downPos = null;
    if (!ptrs.size) tapDead = false;
    // longPressed deliberately stays set until the next press: a browser that fires its context menu
    // *after* the finger lifts must still not have that menu taken for a right-click.
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
  // Armed from the sidebar. It is how a touchscreen — which has no right button — gets at the
  // Mark-as list, so it takes precedence over whatever the current mode would do with the tap.
  if (S.tokenPick) {
    setTokenPick(false);
    const th = nearestHex(wx, wy);
    if (th && S.hexes[th].t !== 'N/A') openCtx(e.clientX, e.clientY, markMenu(th));
    return;
  }
  if (S.mode === 'draw') drawClick(wx, wy, s, e);
  else if (S.mode === 'route') {
    const h = nearestHex(wx, wy);
    if (!h) return;
    if (!S.adj) deriveAdj();
    const ri = regionAt(h, [wx, wy]); // pick the subhex region where the click landed
    // With the Isochrone panel open, moving the origin *is* the work — so that is what a click does,
    // and no waypoints get scattered across the map while you drag the shading about. Shift+click
    // and the armed Set origin button do the same from anywhere else.
    if (S.isoPick || e.shiftKey || UI.pane === 'iso') {
      placeIsoOrigin(h, ri);
      document.getElementById('isoPick').classList.remove('on');
      computeRoute();
      return;
    }
    pushUndoRoutes();
    if (S.activeRoute < 0) newRouteQuiet();
    const rt = S.routes[S.activeRoute];
    rt.wps.push({ h, ri });
    if (rt.wps.length === 1) adoptTokenColor(rt);
    computeRoute();
  }
});
// A cancelled pointer (the browser taking over the gesture, a call coming in) never sends pointerup.
svg.addEventListener('pointercancel', e => {
  cancelLongPress();
  dropPointer(e);
  if (!ptrs.size) {
    pan = null; tapDead = false; longPressed = false; S.dragErase = null; downPos = null;
    if (tokDrag) { tokDrag = null; renderTokens(); groups.hover.innerHTML = ''; }
  }
});
svg.addEventListener('contextmenu', e => {
  e.preventDefault();
  // Android fires this from a long press, which here means "tell me about this hex" — it must not
  // also take a waypoint off the route. A real right-click has its own pointer down while this
  // arrives, so the test is for a *finger* being down, or one having just been held.
  if (longPressed || [...ptrs.values()].some(t => t.touch)) return;
  const [wx, wy] = toWorld(e);
  const h = nearestHex(wx, wy);
  if (!h || S.hexes[h].t === 'N/A') return;
  // Right-clicking anywhere in a hex a route stops in offers to take that waypoint off, wherever it
  // sits in the route.
  const hex = hexMenu(h, [wx, wy], waypointAt(h, regionAt(h, [wx, wy])));
  // A counter does not stop the hex underneath it being a hex. Landing on one used to replace the
  // hex menu outright, which meant a token sitting on the place you wanted to march from had to be
  // dragged aside first. Both menus now show, the token's first, since that is what you aimed at.
  const onTok = e.target.closest?.('[data-tok]');
  const t = onTok && tokenById(+onTok.dataset.tok);
  openCtx(e.clientX, e.clientY, t ? box => { tokenMenu(t)(box); ctxSep(box); hex(box); } : hex);
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
    const { id: bs, ri: bsri, d: bsd } = nearestStronghold(wx, wy, thr);
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
      // The eraser takes the one marker it landed on, not every stronghold in the hex — with two on two
      // banks, clicking one of them should not clear the other.
      const wasSheet = removeStronghold(bs, bsri);
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
    // Which subhex you clicked decides which stronghold you are working on, so a second click on the
    // far bank of a river adds a second one rather than dragging the first across the water.
    const ri = regionAt(h, [wx, wy]);
    pushUndo();
    const m = shEnsure(h, ri);
    delete m.removed;   // interacting with the Stronghold tool (re)adds one that had been erased
    const sub = isSplit(h) ? ` subhex ${ri}` : '';
    let msg;
    if (e.shiftKey) {
      const want = !isPort(h, ri);
      m.coastal = want;
      msg = `Hex ${h}${sub}: now ${want ? 'coastal (port — can embark/disembark)' : 'inland (no port)'}.`;
    } else {
      const p = e.altKey ? [wx, wy] : (snapPoint(wx, wy, 14, scale) || [wx, wy]);
      m.x = +p[0].toFixed(1); m.y = +p[1].toFixed(1);
      msg = `Hex ${h}${sub}: stronghold marker placed.`;
    }
    commitFeatures();
    document.getElementById('saveInfo').textContent = msg;
    return;
  }
  if (S.tool === 'label') {
    const h = nearestHex(wx, wy);
    if (!h) return;
    // A name belongs to the stronghold you clicked, not to the hex it stands in — two places on two
    // banks are two names. With no stronghold under the click the name still goes on the hex, which is
    // how an unfortified place gets labelled.
    const ri = regionAt(h, [wx, wy]);
    const m = shAt(h, ri);
    const sub = isSplit(h) ? ` subhex ${ri}` : '';
    const cur = m ? shName(h, m) : (S.features.labels[h] ?? S.names.hexes[h] ?? '');
    const name = prompt(`Name for hex ${h}${sub}${m ? ' (stronghold)' : ''} — rename or clear:`, cur);
    if (name === null) return;
    pushUndo();
    // A blank name on a stronghold is an empty name, not a deletion — the keep is still there, just
    // unlabelled. Only a bare hex label is removed outright.
    if (m) shEnsure(h, ri).name = name.trim();
    else if (name.trim()) S.features.labels[h] = name.trim();
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

/* ---------------- clipboard, and saying so ----------------
   Copying is invisible work: nothing on screen changes, so without a word of confirmation you cannot
   tell a successful copy from a dead button. Hence the toast — brief, out of the way, and never in
   front of the map's own controls.

   The async clipboard API needs a secure context, so it is there on the published map and absent when
   the file is opened straight off disk. Rather than fail quietly in the case a person is most likely
   to be testing in, both directions fall back to a prompt box: on copy it holds the text ready to be
   taken with Ctrl+C, on paste it waits for Ctrl+V. Clumsier, but it always works. */
let toastT = null;
function toast(msg, bad) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), bad ? 4200 : 2000);
}
async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(what + ' copied');
  } catch {
    // No clipboard permission, or no secure context. Show the text instead of pretending.
    window.prompt(what + ' — press Ctrl+C to copy, then Enter:', text);
  }
}
async function pasteText(what) {
  try {
    const t = await navigator.clipboard.readText();
    if (t && t.trim()) return t;
  } catch {}
  return window.prompt('Paste ' + what + ' here, then press Enter:', '') || '';
}

function flashReject(p) {
  const c = el('circle', { cx: p[0], cy: p[1], r: 6, fill: 'none', stroke: '#e5695e', 'stroke-width': 2 }, groups.hover);
  setTimeout(() => c.remove(), 450);
}
// Drag-erase: remove the whole nearest feature / stronghold under the cursor (defers route recompute).
function eraseWholeAt(wx, wy, scale) {
  const thr = 8 / scale * 1.5 + 3;
  const { id: bs, ri: bsri, d: bsd } = nearestStronghold(wx, wy, thr);
  let bi = -1, bd = thr;
  S.features.features.forEach((f, i) => {
    for (let k = 0; k + 1 < f.pts.length; k++) {
      const d = distToSeg(wx, wy, f.pts[k][0], f.pts[k][1], f.pts[k + 1][0], f.pts[k + 1][1]);
      if (d < bd) { bd = d; bi = i; }
    }
  });
  if (bs === null && bi < 0) return; // nothing under cursor
  if (S.dragErase && !S.dragErase.undoPushed) { pushUndo(); S.dragErase.undoPushed = true; }
  if (bs !== null && bsd <= bd) removeStronghold(bs, bsri);
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

/* Who holds the subhex under the cursor, according to the Warlords scan — but only while that layer
   is actually switched on. The scan is read lazily, on the first toggle, so before then there is
   nothing to say; after it has been switched off again there is nothing you are looking at, and a
   readout describing a layer you cannot see is a puzzle rather than an answer. Both states are
   covered: no scan means never opened, `display: none` means closed again. */
function warlordAt(h, ri) {
  const g = groups.warlords;
  if (!g || g.style.display === 'none' || !realmScans.has('warlords')) return '';
  const c = realmCols.get('warlords')?.get(h + ':' + (ri | 0));
  if (!c) return '';
  const name = WARLORD_BY_RGB.get(c);
  return `<br><span class="rg"><span class="chip" style="background:rgb(${c})"></span>` +
         (name ? escHtml(name) : `unnamed colour ${rgbHex(c)}`) + '</span>';
}

/* What the isochrone has to say about the subhex under the cursor — the subhex, because the two
   halves of a split hex are different ground and may well have different answers, or one of them no
   answer at all. With one origin that is simply how long the march takes.
   With several it is also who holds the hex and by how much — and the margin is the interesting number,
   because a hex won by half a day is a frontier and one won by a week is nobody's frontier at all. */
function isoTip(h, ri) {
  const key = nk(h, ri | 0);
  if (!S.iso.own || !S.iso.own.has(key)) return '';
  const i = S.iso.own.get(key), d = S.iso.best.get(key);
  const og = S.iso.origins[i];
  const many = placedOrigins() > 1;
  // In relief mode the total is the least of it. Which leg eats the budget is what you can act on:
  // a march-bound hex wants a road or a shorter stretch of one, a news-bound hex wants a courier
  // posted rather than a garrison moved, and the raw figures in brackets say how near the whole-day
  // billing came to costing a day it never used.
  const p = isoRelief() ? S.iso.parts?.[i]?.get(key) : null;
  if (p) {
    let r = `<br>${d} IRL d ${many ? 'to relieve ' + escHtml(og?.name || 'it') : 'for relief to arrive'}` +
            `<br><span class="rg">news ${p.newsD} d (${p.news.toFixed(1)}) + march ${p.marchD} d (${p.march.toFixed(1)})</span>`;
    // With several origins on the map a hex belongs to the one it can relieve soonest — but a hex that
    // covers two of them is the one you actually want, so say what else it reaches and at what price.
    if (many) {
      const up = isoRunnerUp(key);
      if (up) r += `<br><span class="rg">also relieves ${escHtml(S.iso.origins[up.i]?.name || 'the other')}` +
                   ` in ${up.d} d — ${up.d - d} d later</span>`;
    }
    return r;
  }
  let s = `<br>${d.toFixed(1)} IRL d from ${many ? escHtml(og?.name || 'origin') : 'origin'}`;
  // With the optimizer shading, the true cost alone is the least interesting of the three numbers:
  // what is being paid, and what of it is wasted, are the point.
  if (isoOptimizing()) s += ` · ${optDays(d)} d order, ${optWaste(d).toFixed(2)} wasted`;
  if (many) {
    const up = isoRunnerUp(key);
    if (up) s += `<br><span class="rg">${escHtml(S.iso.origins[up.i]?.name || 'other')} ` +
                 `${up.d.toFixed(1)} d — held by ${(up.d - d).toFixed(1)} d</span>`;
  }
  return s;
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
      subLabel = ' · ' + (sea ? 'sea' : 'land') + ' subhex';
      if (!sea && S.features.subTerrain?.[h]?.[ri]) subLabel += ` (${S.features.subTerrain[h][ri]})`;
    } else { const [cx, cy] = hexCenter(h); el('path', { d: hexPath(cx, cy), fill: 'none', stroke: '#fff', 'stroke-width': 1, opacity: 0.8 }, groups.hover); }
  } else {
    const [cx, cy] = hexCenter(h);
    el('path', { d: hexPath(cx, cy), fill: 'none', stroke: '#fff', 'stroke-width': 1, opacity: 0.8 }, groups.hover);
  }
  const v = S.hexes[h];
  // The readout describes the subhex under the cursor, so it names the stronghold standing there rather
  // than whichever one the hex happens to contain.
  const hoverRi = regionAt(h, [wx, wy]);
  const hoverM = shAt(h, hoverRi);
  const name = hoverM ? shName(h, hoverM) : (S.features.labels[h] ?? S.names.hexes[h]);
  const shKind = hoverM ? ({ major: 'major stronghold', fortress: 'fortress' }[shKindOf(hoverM)] || 'stronghold') : '';
  tooltip.innerHTML = `<span class="t">${name ? name + ' — ' : ''}hex ${h}${subLabel}</span><br>` +
    `${v.t}${hoverM ? ` · ${shKind} (${isPort(h, hoverRi) ? 'coastal/port' : 'inland'})` : ''}` +
    `${v.r ? ' · river (sheet)' : ''}${v.d ? ' · road (sheet)' : ''}` +
    (v.g ? `<br><span class="rg">${v.g}</span>` : '') +   // the region it belongs to, from the sheet
    warlordAt(h, hoverRi) +                               // and who holds it, while that layer is up
    isoTip(h, hoverRi);
  tooltip.hidden = false;
  const wr = svg.parentElement.getBoundingClientRect();
  tooltip.style.left = (e.clientX - wr.left + 14) + 'px';
  tooltip.style.top = (e.clientY - wr.top + 10) + 'px';
}
// A mouse leaving the map means you have stopped pointing at anything, so the readout goes away. A
// *touch* pointer "leaves" the moment the finger lifts, which is exactly when the long-press readout
// has just appeared and wants to stay — it is dismissed by the next touch instead.
svg.addEventListener('pointerleave', e => {
  if (e.pointerType !== 'mouse') return;
  tooltip.hidden = true; groups.hover.innerHTML = '';
});

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { spaceHeld = true; e.preventDefault(); }
  else if (e.key === 'e' || e.key === 'E') edgeSnap = true;
  else if (e.key === 'Enter' && S.drawing) finishDrawing();
  else if (e.key === 'Escape') {
    if (!ctxEl.hidden) return closeCtx();          // first Escape dismisses the menu, next clears
    if (S.tokenPick) return setTokenPick(false);
    S.drawing = null; groups.edit.innerHTML = ''; clearSelection();
  }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    // A line being drawn gives up its last point first: that is the change closest to hand.
    if (S.drawing && S.drawing.pts.length) { S.drawing.pts.pop(); renderDrawing(); }
    else undoLast();
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
  svg.classList.toggle('drawing', m === 'draw');
  // Drawing wants every point on the map clickable, and a counter sitting on the hex you are tracing
  // would swallow the click. In Draw mode tokens are scenery; everywhere else they are handles.
  if (groups.tokens) groups.tokens.style.pointerEvents = m === 'draw' ? 'none' : '';
  svg.classList.toggle('routing', m === 'route');
  if (m !== 'draw' && S.drawing) finishDrawing();
}
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
  else undoLast();
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
    // An exported file may predate the per-subhex shape, so an import goes through the migration too.
    pushUndo(); S.features = migrateFeatures({ version: 2, labels: {}, strongholds: {}, ...j }); commitFeatures();
  } catch { alert('Not a valid features.json'); }
  e.target.value = '';
};
document.getElementById('resetBtn').onclick = async () => {
  if (!confirm('Discard local drawing and reload data/features.json?')) return;
  localStorage.removeItem(LS_KEY);
  S.features = migrateFeatures(await fetchFeaturesFile() || { version: 2, features: [], labels: {}, strongholds: {} });
  S.undoStack = [];
  commitFeatures();
};
document.getElementById('newRoute').onclick = () => newRoute();
document.getElementById('isoPick').onclick = () => {
  S.isoPick = !S.isoPick;
  document.getElementById('isoPick').classList.toggle('on', S.isoPick);
  // The next thing to do is tap the map, which on a phone is behind the sheet.
  if (S.isoPick) closeSheet();
};
document.getElementById('isoAdd').onclick = addIsoOrigin;
document.getElementById('isoClear').onclick = clearAllIsoOrigins;
/* One box, two questions. "Max days" in the spread modes is how far out to bother looking, and seven
   is a comfortable answer; in relief mode the same box is the budget the event gives you, and four is
   the working figure. Carrying one number between them would mean a mode switch silently answering
   a question you didn't ask — so each mode keeps its own, and keeps whatever you last set it to. */
const ISO_MAX_DEFAULT = { army: 7, message: 7, rumour: 7, relief: 4 };
const isoMaxFor = { ...ISO_MAX_DEFAULT };
let isoLastMode = 'army';
for (const id of ['isoBand', 'isoMax', 'isoMode', 'isoOpt', 'isoNews'])
  document.getElementById(id).addEventListener('change', () => {
    const box = document.getElementById('isoMax');
    if (id === 'isoMax') isoMaxFor[isoLastMode] = +box.value || ISO_MAX_DEFAULT[isoLastMode];
    if (id === 'isoMode') {
      const m = isoMode();
      if (m !== isoLastMode) {
        isoMaxFor[isoLastMode] = +box.value || isoMaxFor[isoLastMode];
        isoLastMode = m;
        box.value = isoMaxFor[m];
      }
    }
    updateIsoSettingsShown(); computeRoute();
  });
// No confirmation. It is one Ctrl+Z away from being back, and a modal that stops the work to ask
// about something already undoable is friction pretending to be safety.
function clearAllRoutes() {
  if (!S.routes.length) return;
  pushUndoRoutes(); S.routes = []; S.activeRoute = -1; computeRoute();
}
document.getElementById('clearRoute').onclick = clearAllRoutes;

// Copy/paste the column, from whichever panel the controls are currently sitting on — they are one set
// of boxes carried between Routes and Isochrone, so these two travel with them.
document.getElementById('copyArmy').onclick = () => copyText(armyToText(activeSettings()), 'Column');
document.getElementById('pasteArmy').onclick = async () => applyArmyText(await pasteText('a column'));
// Copy/paste the march. Both act on the active route, which is the one the card is describing.
document.getElementById('copySimple').onclick = () => copySteps(S.activeRoute, true);
document.getElementById('copyDetailed').onclick = () => copySteps(S.activeRoute, false);
document.getElementById('pasteSteps').onclick = async () => applyHexList(await pasteText('a list of hexes'));
// Same as right-clicking the map, for touchscreens, which have no second button. Two buttons do it:
// one in the sheet beside its siblings, one floating on the map for when the sheet is shut.
function removeLastWaypoint() {
  const rt = S.routes[S.activeRoute];
  if (rt?.wps.length) { pushUndoRoutes(); rt.wps.pop(); computeRoute(); }
}
document.getElementById('undoWp').onclick = removeLastWaypoint;
document.getElementById('undoWpFloat').onclick = removeLastWaypoint;
for (const id of ['inf', 'cav', 'wag', 'non', 'li', 'forced', 'marines', 'fleet', 'embark', 'noTrade', 'weather'])
  document.getElementById(id).addEventListener('change', () => readRouteForm(id));

document.getElementById('refetchBtn').onclick = async () => {
  const info = document.getElementById('dataInfo');
  info.textContent = 'Fetching sheet…';
  try {
    const txt = await (await fetch(SHEET_URL)).text();
    const rows = txt.trim().split('\n').map(splitCsv);
    const head = rows[0];
    const ix = n => head.indexOf(n);
    const gi = ix('Region');       // added to the sheet later than the rest; tolerate its absence
    const hexes = {};
    for (const r of rows.slice(1)) {
      const h = {
        t: r[ix('Terrain')], s: r[ix('Stronghold')] === 'Yes',
        r: r[ix('River')] === 'Yes', d: r[ix('Road')] === 'Yes',
      };
      if (gi >= 0 && r[gi]) h.g = r[gi];
      hexes[+r[ix('Hexcode')]] = h;
    }
    S.hexes = hexes;
    renderTerrain(); renderLabels(); S.adj = null; renderSearch(); computeRoute();
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
    // Driven by another layer (via `linked`), or never switched at all — either way, no row.
    if (L.slave || L.fixed) continue;
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
      for (const id of [L.id, ...[L.linked || []].flat()]) {
        const g = groups[id];
        if (!g) continue;
        g.style.display = chk.checked ? '' : 'none';
        // A group folded into someone else's row may still want to sit at its own weight against the
        // others in it — the drawn shoreline is a grid line, not a feature — so it scales the row's
        // opacity rather than taking it whole. Only when folded in: a layer holding its own slider
        // is already at the weight its own `def` set, and would otherwise be discounted twice.
        g.style.opacity = rng.value * (id === L.id ? 1 : byId[id]?.op ?? 1);
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

/* ---------------- tokens ----------------
   A token is a counter you drop on a hex to stand for something that moves: an army, a fleet, a
   courier. It is deliberately not part of the drawing — roads and rivers are the map, tokens are
   what is happening on it this week — so they live in their own storage, they work on the published
   map as well as locally, and they are exported separately when a board state is worth keeping.

   Right-click a hex to mark it (I–XIV, or your own text). After that the token itself answers to
   the mouse: click cycles its colour, drag carries it to another hex, right-click renames,
   recolours or removes it. */
const TOKEN_COLORS = PALETTE;   // named for the tokens, shared with the routes
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV'];
const TOK_LS = 'rotmap_tokens_v1';
const TOK_MAXLEN = 24;

const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tokenById = id => S.tokens.find(t => t.id === id);

/* Rebuilt rather than trusted, wherever tokens come in from outside: ids are reissued and colours
   validated, so a hand-edited file can't leave two tokens sharing an id or a colour the renderer
   can't use, and a hex that isn't on the map is dropped rather than drawn nowhere. */
function normalizeTokens(arr) {
  if (!Array.isArray(arr)) return null;
  return arr.filter(t => t && S.hexes[+t.h]).map((t, i) => ({
    id: i + 1, h: +t.h,
    label: String(t.label ?? '').slice(0, TOK_MAXLEN),
    color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : TOKEN_COLORS[i % TOKEN_COLORS.length],
  }));
}
// The board as the news last left it, shipped with the map. It seeds an empty browser and can be
// asked for again at any time — it is a starting position, not a save.
async function fetchStartingTokens() {
  try {
    const r = await fetch('data/tokens.json');
    if (!r.ok) return null;
    return normalizeTokens((await r.json()).tokens);
  } catch { return null; }
}

function saveTokens() {
  try { localStorage.setItem(TOK_LS, JSON.stringify({ version: 1, tokens: S.tokens })); } catch {}
}
/* `quiet` is for the one commit that isn't a change the user made — seeding the board at boot.
   `coalesce` folds a run of live changes (a colour picker being dragged) into one undo step. */
function commitTokens(opts) {
  if (!opts?.quiet) pushUndoEntry('tokens', tokensSnap ?? JSON.stringify(S.tokens), opts?.coalesce);
  tokensSnap = JSON.stringify(S.tokens);
  renderTokens(); renderTokenList(); saveTokens();
}

// Two armies arriving in the same colour would defeat the point, so a new token takes the first
// colour nobody is using before it starts repeating.
function nextTokenColor() {
  const used = new Set(S.tokens.map(t => t.color));
  return TOKEN_COLORS.find(c => !used.has(c)) || TOKEN_COLORS[S.tokens.length % TOKEN_COLORS.length];
}
function addToken(h, label, color) {
  const id = S.tokens.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1;
  S.tokens.push({ id, h, label: String(label).slice(0, TOK_MAXLEN), color: color || nextTokenColor() });
  commitTokens();
}
function deleteToken(t) { S.tokens = S.tokens.filter(x => x !== t); commitTokens(); }

/* Detachments are named off the parent: the 5th's first is V'a, the next V'b. So a token's "base"
   is whatever stands before the apostrophe, and every token sharing a base belongs to one command —
   which is also how the next free letter is found. */
const tokenBase = lab => String(lab || '').split("'")[0];
function nextDetachLabel(t) {
  const base = tokenBase(t.label);
  const used = new Set(S.tokens.filter(x => tokenBase(x.label) === base)
                               .map(x => (String(x.label).split("'")[1] || '').toLowerCase()));
  for (let i = 0; i < 26; i++) {
    const c = String.fromCharCode(97 + i);
    if (!used.has(c)) return base + "'" + c;
  }
  return null;
}

// Dark ink on a pale counter, pale on a dark one — the colour is the user's to choose, including
// from the full picker, so neither can be assumed.
function inkOn(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#14181e';
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) > 150 ? '#14181e' : '#fff';
}

/* Where each token sits. One in a hex takes the centre; several fan out around it on a ring and
   shrink, so a stack of armies in one place stays countable instead of hiding behind each other. */
function tokenLayout() {
  const byHex = new Map();
  for (const t of S.tokens) {
    if (!byHex.has(t.h)) byHex.set(t.h, []);
    byHex.get(t.h).push(t);
  }
  const out = new Map();
  for (const [h, list] of byHex) {
    const [cx, cy] = hexCenter(h);
    if (list.length === 1) { out.set(list[0].id, { x: cx, y: cy, r: 11 }); continue; }
    const ring = Math.min(14, 5 + list.length * 1.6);
    const r = Math.max(5, 10.5 - list.length * 0.7);
    list.forEach((t, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / list.length;
      out.set(t.id, { x: cx + ring * Math.cos(a), y: cy + ring * Math.sin(a), r });
    });
  }
  return out;
}
function renderTokens() {
  groups.tokens.innerHTML = '';
  const lay = tokenLayout();
  for (const t of S.tokens) {
    const p = lay.get(t.id);
    if (!p) continue;
    const g = el('g', { 'data-tok': t.id, style: 'cursor:grab' }, groups.tokens);
    g._p = p;
    el('circle', { cx: p.x, cy: p.y, r: p.r, fill: t.color, stroke: '#14181e', 'stroke-width': 1.6 }, g);
    const lab = t.label || '';
    if (!lab) continue;
    // A numeral goes inside the counter, shrinking to stay off the rim. Anything long enough that
    // shrinking would make it unreadable — a name rather than a number — is written under it
    // instead, in the same white-on-dark as the stronghold labels. Below, not above, so it doesn't
    // collide with the stronghold name already sitting over the hex.
    if (lab.length <= 8) {
      // Height is what makes a designation readable at a glance, so a longer one loses far less of
      // it than its length would suggest: it is squeezed sideways instead. textLength hands the
      // exact fit to the renderer, which beats guessing a width from the character count — I, V, X
      // and the apostrophe are all much narrower than an average glyph.
      const n = lab.length;
      const fs = p.r * (n <= 2 ? 1.05 : n <= 4 ? 0.86 : n <= 6 ? 0.74 : 0.64);
      const a = { x: p.x, y: p.y + fs * 0.35, 'text-anchor': 'middle', 'font-size': fs.toFixed(2),
                  fill: inkOn(t.color), 'font-weight': 700, 'font-family': 'system-ui,sans-serif' };
      const maxW = p.r * 1.62;
      if (0.6 * fs * n > maxW) { a.textLength = maxW.toFixed(2); a.lengthAdjust = 'spacingAndGlyphs'; }
      el('text', a, g).textContent = lab;
    } else {
      el('text', { x: p.x, y: p.y + p.r + 9, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#fff',
                   stroke: '#14181e', 'stroke-width': 2.4, 'paint-order': 'stroke', 'font-weight': 600,
                   'font-family': 'system-ui,sans-serif' }, g).textContent = lab;
    }
  }
}
function renderTokenList() {
  const list = document.getElementById('tokenList');
  if (!list) return;
  list.innerHTML = '';
  if (!S.tokens.length) {
    list.innerHTML = '<div class="emptynote">Nothing marked yet.</div>';
    return;
  }
  for (const t of S.tokens) {
    const div = document.createElement('div');
    div.className = 'tokitem';
    div.innerHTML = `<span class="sw" style="background:${escHtml(t.color)}"></span>` +
      `<span class="nm">${escHtml(t.label)}</span><span class="hx">hex ${t.h}</span>` +
      `<span class="x" title="Remove">×</span>`;
    div.querySelector('.sw').title = 'Change colour';
    div.title = 'Click to centre the map on it';
    div.onclick = () => { panToSelection({ h: t.h }); closeSheet(); };
    div.querySelector('.sw').onclick = e => {
      e.stopPropagation();
      openColorPanelAt(e.currentTarget, `<b>${escHtml(t.label)}</b> — colour`,
                       TOKEN_COLORS, () => t.color,
                       c => { t.color = c; commitTokens({ coalesce: 'tkcolor' + t.id }); });
    };
    div.querySelector('.x').onclick = e => { e.stopPropagation(); deleteToken(t); };
    // The row stands for the counter, so it answers the right button the same way — no hunting for
    // the token on the map to rename or split it.
    div.oncontextmenu = e => {
      e.preventDefault(); e.stopPropagation();
      openCtx(e.clientX, e.clientY, tokenMenu(t));
    };
    list.appendChild(div);
  }
}

/* ---------------- context menu ----------------
   One popup, rebuilt each time it opens. Right-click used to pop a waypoint off the route or finish
   a line; those are now the first entries in the menu, so nothing that was a reflex has been taken
   away — it just costs a second click. */
const ctxEl = document.getElementById('ctxMenu');
let ctxSub = null;

function fitPopup(box, x, y) {
  box.style.left = '0px'; box.style.top = '0px';       // measure unconstrained, then place
  const w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = Math.max(4, Math.min(innerWidth - w - 4, x)) + 'px';
  box.style.top = Math.max(4, Math.min(innerHeight - h - 4, y)) + 'px';
}
function closeCtxSub() { if (ctxSub) { ctxSub.remove(); ctxSub = null; } }
function closeCtx() {
  closeCtxSub();
  ctxEl.hidden = true;
  ctxEl.innerHTML = '';
}
function openCtx(x, y, build) {
  closeCtx();
  ctxEl.hidden = false;
  build(ctxEl);
  fitPopup(ctxEl, x, y);
}
function ctxHead(box, html) {
  const d = document.createElement('div');
  d.className = 'ctxhd';
  d.innerHTML = html;
  box.appendChild(d);
}
function ctxSep(box) {
  const d = document.createElement('div');
  d.className = 'ctxsep';
  box.appendChild(d);
}
function ctxItem(box, html, fn, cls) {
  const d = document.createElement('div');
  d.className = 'ctxit' + (cls ? ' ' + cls : '');
  d.innerHTML = html;
  /* Moving onto any other row puts an open flyout away, the way a menu should behave — but "any other
     row" has to mean a row of the *parent* menu. The rows inside a flyout are built by this same
     function, so they inherited this handler too, and the first thing the pointer touched on its way
     into a flyout was a row that promptly closed the flyout it was standing in. The flyout could be
     opened and never used: it vanished the moment you reached for it.

     Hence the second test. The first (`_owner === d`) spares the row the flyout hangs off; this one
     spares everything the flyout contains. */
  d.addEventListener('mouseenter', () => {
    if (!ctxSub || ctxSub._owner === d || ctxSub.contains(d)) return;
    closeCtxSub();
  });
  if (fn) d.addEventListener('click', e => { e.stopPropagation(); fn(e); });
  box.appendChild(d);
  return d;
}
// A row that opens a panel beside itself: on hover for a mouse, on tap for a finger.
function ctxFlyout(anchor, build) {
  const open = () => {
    if (ctxSub && ctxSub._owner === anchor) return;
    closeCtxSub();
    const s = document.createElement('div');
    s.className = 'ctxsub';
    s._owner = anchor;
    document.body.appendChild(s);
    build(s);
    ctxSub = s;
    const r = anchor.getBoundingClientRect();
    fitPopup(s, r.right + 3, r.top - 5);
  };
  anchor.addEventListener('mouseenter', open);
  anchor.addEventListener('click', e => { e.stopPropagation(); open(); });
}

/* The colour panel: the palette as swatches, and the system picker for anything not on it. Tokens
   and routes both use it, so a colour chosen in one place is chosen the same way in the other.
   `get` is read each time the panel is built (the colour may have moved on since), and `set` is
   called live as the picker is dragged — so it must be cheap. */
function buildColorPanel(box, palette, get, set) {
  const grid = document.createElement('div');
  grid.className = 'swgrid';
  for (const c of palette) {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = c;
    if (c.toLowerCase() === (get() || '').toLowerCase()) b.classList.add('on');
    b.addEventListener('click', e => { e.stopPropagation(); set(c); closeCtx(); });
    grid.appendChild(b);
  }
  box.appendChild(grid);
  // Clicking into the picker must not be taken for clicking the menu away, or the dialog would open
  // onto a panel that had already closed behind it.
  const row = document.createElement('label');
  row.className = 'ctxit';
  row.style.marginTop = '5px';
  row.textContent = 'Custom…';
  const inp = document.createElement('input');
  inp.type = 'color';
  inp.value = /^#[0-9a-f]{6}$/i.test(get() || '') ? get() : palette[0];
  inp.oninput = () => set(inp.value);
  row.appendChild(inp);
  row.addEventListener('click', e => e.stopPropagation());
  box.appendChild(row);
}
// Anchored under a swatch rather than beside a menu row: for the sidebar lists, where the swatch is
// the whole control.
function openColorPanelAt(anchor, title, palette, get, set) {
  const r = anchor.getBoundingClientRect();
  openCtx(r.left - 6, r.bottom + 6, box => {
    ctxHead(box, title);
    buildColorPanel(box, palette, get, set);
  });
}

function hexTitle(h) {
  const name = S.features.labels[h] ?? S.names.hexes[h];
  return (name ? `<b>${escHtml(name)}</b> — ` : '') + `hex ${h}`;
}
// The numerals, plus a way out to free text. A numeral already on the map is still offered — two
// armies can share a name across a campaign — but it wears the colour of the one that has it, so
// you can see the clash before you make it.
function buildMarkGrid(box, h) {
  const grid = document.createElement('div');
  grid.className = 'numgrid';
  const used = new Map();
  for (const t of S.tokens) if (!used.has(t.label)) used.set(t.label, t);
  for (const n of ROMAN) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = n;
    const u = used.get(n);
    if (u) { b.classList.add('used'); b.style.borderColor = u.color; b.title = `${n} is already on hex ${u.h}`; }
    b.addEventListener('click', e => { e.stopPropagation(); addToken(h, n); closeCtx(); });
    grid.appendChild(b);
  }
  box.appendChild(grid);
  const custom = ctxItem(box, 'Custom text…', () => {
    const v = prompt('Token text:', '');
    closeCtx();
    if (v && v.trim()) addToken(h, v.trim());
  });
  custom.style.marginTop = '5px';
}
function markMenu(h) {
  return box => { ctxHead(box, 'Mark ' + hexTitle(h)); buildMarkGrid(box, h); };
}
function hexMenu(h, pt, wp) {
  return box => {
    ctxHead(box, hexTitle(h));
    /* Origins, while the Isochrone panel is the open one. A left-click on the map already moves the
       selected origin, which is the fast path and the one worth keeping — but it is the *only* path,
       so making a second origin, or getting rid of one, meant leaving the map for the panel. These
       are the same three things the origin list offers, put where you are already pointing.

       They go above the route entries rather than instead of them: which panel is open says what you
       are most likely to want, not what you are allowed to want, and a route you were building does
       not stop existing because you opened another panel. */
    if (UI.pane === 'iso') {
      migrateIso();
      const ri = pt ? regionAt(h, pt) : 0;
      // The origin standing on the subhex under the cursor, or failing that any origin in this hex —
      // a marker half a hex away is still the one you meant, and the entry says which half it is on.
      let at = S.iso.origins.findIndex(og => og.h === h && (og.ri | 0) === ri);
      const exact = at >= 0;
      if (!exact) at = S.iso.origins.findIndex(og => og.h === h);
      const sel = activeIsoOrigin();
      let any = false;
      if (at >= 0) {
        const og = S.iso.origins[at];
        const where = !exact && isSplit(h) ? ' · other subhex' : '';
        ctxItem(box, `Remove origin<span class="arw">${escHtml(og.name)}${where}</span>`,
                () => { closeCtx(); removeIsoOrigin(at); });
        any = true;
      }
      // Moving the selected one is what a left-click does; it earns a row only when that would
      // actually change something, which it would not if the selected origin is already standing here.
      if (sel && sel.h !== h && at !== S.iso.active) {
        ctxItem(box, `Move here<span class="arw">${escHtml(sel.name)}</span>`, () => {
          closeCtx();
          placeIsoOrigin(h, ri);
          document.getElementById('isoPick').classList.remove('on');
          computeRoute();
        });
        any = true;
      }
      ctxItem(box, `New origin here<span class="arw">${escHtml(freeIsoName())}</span>`, () => {
        closeCtx();
        pushUndoRoutes();
        S.iso.origins.push(newIsoOrigin(h, ri));
        S.iso.active = S.iso.origins.length - 1;
        computeRoute();
      });
      any = true;
      if (S.iso.origins.length)
        ctxItem(box, `Clear all origins<span class="arw">${S.iso.origins.length}</span>`,
                () => { closeCtx(); clearAllIsoOrigins(); }, 'danger');
      if (any) ctxSep(box);
    }
    // A hex a route stops in means that waypoint, not the end of the route: offer to take that one
    // off, and say which it is, since a middle waypoint disappearing is otherwise a surprise.
    const act = S.routes[S.activeRoute];
    if (wp) {
      const rt = S.routes[wp.ri];
      const which = rt.wps.length < 2 ? 'waypoint'
                  : wp.wi === rt.wps.length - 1 ? 'last waypoint'
                  : `waypoint ${wp.wi + 1} of ${rt.wps.length}`;
      const name = wp.ri === S.activeRoute ? '' : `<span class="arw">${escHtml(rt.name)}</span>`;
      ctxItem(box, `Remove ${which}${name}`, () => { removeWaypoint(wp.ri, wp.wi); closeCtx(); });
    }
    // What right-click used to do on its own, kept within one click of where it was — and first,
    // since it was a reflex before this menu existed. It stays on offer when the hex belongs to some
    // *other* route, so a stray waypoint elsewhere never costs you the reflex on the one you're building.
    if (S.mode === 'route' && act?.wps.length && wp?.ri !== S.activeRoute) {
      ctxItem(box, 'Remove last waypoint' + (wp ? `<span class="arw">${escHtml(act.name)}</span>` : ''), () => {
        pushUndoRoutes();
        act.wps.pop(); computeRoute(); closeCtx();
      });
    }
    if (S.mode === 'draw' && S.drawing) ctxItem(box, 'Finish line', () => { finishDrawing(); closeCtx(); });
    /* Strongholds are drawing work, so the entry belongs to draw mode — and it belongs on the
       right-click menu because changing one is a decision about a place you are already looking at,
       not a reason to go and select a tool. Whether it is a port lives here too: it is the other thing
       about a stronghold that is a type rather than a position, and it was previously reachable only by
       Shift+clicking with the Stronghold tool, which is not a discoverable gesture. */
    if (S.mode === 'draw') {
      // A stronghold belongs to a subhex, so the entry acts on the subhex you right-clicked and says so
      // when the hex is split — otherwise "Stronghold: none" on a hex that visibly has one would look
      // like a bug rather than a statement about this particular bank.
      const shRi = pt ? regionAt(h, pt) : 0;
      const m = shAt(h, shRi);
      const cur = shKindOf(m);
      const where = isSplit(h) ? ' · this subhex' : '';
      ctxFlyout(ctxItem(box, `Stronghold<span class="arw">${cur}${where}▸</span>`), s => {
        for (const [kind, lbl] of [['none', 'None'], ['minor', 'Ordinary'],
                                   // Square-cornered on purpose: the swatch is the symbol, not a colour chip.
                                   ['fortress', `<span class="sw" style="background:${FORT_FILL};border-radius:1px"></span>Fortress — square inside`],
                                   ['major', 'Major — larger marker']]) {
          const want = kind === 'minor' ? 'ordinary' : kind;
          const it = ctxItem(s, lbl, () => { setStrongholdType(h, shRi, kind); closeCtx(); });
          if (want === cur) it.style.color = '#fff';
        }
        if (m) {
          ctxSep(s);
          const port = isPort(h, shRi);
          ctxItem(s, port ? 'Make inland — no port' : 'Make coastal — port', () => {
            pushUndo();
            shEnsure(h, shRi).coastal = !port;
            commitFeatures();
            closeCtx();
          });
          ctxItem(s, 'Rename…', () => {
            const n = prompt(`Name for this stronghold (hex ${h}):`, shName(h, m));
            closeCtx();
            if (n === null) return;
            pushUndo();
            shEnsure(h, shRi).name = n.trim();
            commitFeatures();
          });
        }
      });
    }
    /* Extending the route you are already building, from the menu rather than by clicking the map.
       A left-click does this too — but only while the map is listening for waypoints, and it is not
       whenever the Isochrone panel is open, where every click moves an origin instead. Plotting a
       march against ground an isochrone has just shaded meant leaving that panel, losing the
       shading, and coming back; this is the same push, one menu away.

       Nothing here changes the mode or the open panel, deliberately. The request is to add a
       waypoint, not to be taken somewhere else — that is the whole reason the entry exists. */
    if (act) {
      const n = act.wps.length + 1;
      const ord = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
      ctxItem(box, `Add waypoint here<span class="arw">${escHtml(act.name)} · ${n}${ord}</span>`, () => {
        closeCtx();
        if (!S.adj) deriveAdj();
        pushUndoRoutes();
        act.wps.push({ h, ri: pt ? regionAt(h, pt) : 0 });
        // A route that begins on a hex a token stands on takes that token's colour, exactly as one
        // begun by clicking the map does — this can be the first waypoint as well.
        if (act.wps.length === 1) adoptTokenColor(act);
        computeRoute();
      });
    }
    // Routing from a hex you are already looking at, without first switching mode and hunting for
    // the New route button. The waypoint lands on the subhex region under the cursor, exactly as a
    // left-click would place it, so starting on the sea side of a split hex still means the sea.
    ctxItem(box, `Start a route here<span class="arw">Route ${S.routes.length + 1}</span>`, () => {
      closeCtx();
      if (S.mode !== 'route') setMode('route');
      if (!S.adj) deriveAdj();
      pushUndoRoutes();
      newRouteQuiet();
      const rt = S.routes[S.activeRoute];
      rt.wps.push({ h, ri: pt ? regionAt(h, pt) : 0 });
      adoptTokenColor(rt);
      computeRoute();
    });
    if (S.mode === 'route' && S.routes.length)
      ctxItem(box, `Clear all routes<span class="arw">${S.routes.length}</span>`,
              () => { closeCtx(); clearAllRoutes(); }, 'danger');
    ctxSep(box);
    ctxFlyout(ctxItem(box, 'Mark as<span class="arw">▸</span>'), s => buildMarkGrid(s, h));
    // Terrain is only worth arguing with on ground you march over, so the entry is offered on land
    // regions and not on water. It names the region under the cursor, which on a split hex is how
    // the two halves get told apart.
    if (LOCAL) {
      const ri = pt ? regionAt(h, pt) : 0;
      const reg = region(h, ri);
      if (!(reg?.sea && !reg?.river)) {
        const cur = regionTerrain(h, ri), sheet = S.hexes[h].t;
        const split = regionsOf(h).length > 1;
        ctxFlyout(ctxItem(box, `Terrain<span class="arw">${escHtml(cur)}${split ? ' · this subhex' : ''}▸</span>`), sm => {
          for (const t of ['Flatlands', 'Hills', 'Mountains']) {
            const it = ctxItem(sm, `<span class="sw" style="background:${TERRAIN_COLORS[t]}"></span>${t}`,
                               () => { setRegionTerrain(h, ri, t); closeCtx(); });
            if (t === cur) it.style.color = '#fff';
          }
          if (cur !== sheet) {
            ctxSep(sm);
            ctxItem(sm, `Back to the sheet<span class="arw">${escHtml(sheet)}</span>`,
                    () => { setRegionTerrain(h, ri, null); closeCtx(); });
          }
        });
      }
    }
  };
}
/* ---------------- the step table's columns ----------------
   The readout is rebuilt from scratch on every recompute, so column widths have to live outside it.
   Once any column has been dragged, all six are pinned in pixels and the table is sized to their
   sum — which is what makes dragging predictable, and lets the table grow wider than the card and
   scroll rather than squeezing the columns you did not touch. */
function applyColWidths() {
  const tbl = document.getElementById('stepsTbl');
  if (!tbl) return;
  const cols = tbl.querySelectorAll('col');
  if (!UI.cols || UI.cols.length !== cols.length) { tbl.style.width = ''; return; }
  cols.forEach((c, i) => { c.style.width = UI.cols[i] + 'px'; });
  tbl.style.width = UI.cols.reduce((a, b) => a + b, 0) + 'px';
}
function captureColWidths() {
  const tbl = document.getElementById('stepsTbl');
  const cells = tbl?.querySelectorAll('tr.hd td');
  if (!cells?.length) return null;
  return [...cells].map(td => Math.max(28, Math.round(td.getBoundingClientRect().width)));
}
document.getElementById('routeOut').addEventListener('pointerdown', e => {
  const g = e.target.closest('.colgrip');
  if (!g) return;
  e.preventDefault(); e.stopPropagation();
  if (!UI.cols) UI.cols = captureColWidths();
  if (!UI.cols) return;
  const i = +g.dataset.col, x0 = e.clientX, w0 = UI.cols[i];
  g.classList.add('dragging');
  document.body.classList.add('colsizing');
  const move = ev => { UI.cols[i] = Math.max(28, w0 + ev.clientX - x0); applyColWidths(); };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    g.classList.remove('dragging');
    document.body.classList.remove('colsizing');
    saveUI();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});
// Double-click a grip to hand the table back its own proportions.
document.getElementById('routeOut').addEventListener('dblclick', e => {
  if (!e.target.closest('.colgrip')) return;
  e.preventDefault(); e.stopPropagation();
  UI.cols = null;
  saveUI();
  computeRoute();
});

/* Right-click a row of the readout. Left-click centres the map on that hex, which is how you find
   out where a step actually is without reading the number. */
function stepMenu(ri, j) {
  const rt = S.routes[ri], st = lastResults[ri]?.steps?.[j];
  return box => {
    const name = S.features.labels[st.h] ?? S.names.hexes[st.h];
    ctxHead(box, (name ? `<b>${escHtml(name)}</b> — ` : '') + `hex ${st.h} · step ${j}`);
    const anyForced = rt.wps.some(w => w.f);
    const pending = !!(fmPending && fmPending.ri === ri);
    ctxItem(box, anyForced ? 'Force the march from here too' : 'Force the march from here',
            () => { closeCtx(); startForcedAt(ri, j); });
    if (pending || anyForced)
      ctxItem(box, 'End the push here', () => { closeCtx(); endForcedAt(ri, j); });
    if (anyForced)
      ctxItem(box, `Back to normal pace<span class="arw">all</span>`, () => { closeCtx(); clearForced(ri); });
    ctxSep(box);
    ctxItem(box, 'Split the route here', () => { closeCtx(); splitRouteAt(ri, j); });
    ctxItem(box, 'Centre the map here', () => { closeCtx(); panToSelection({ h: st.h }); });
  };
}
document.getElementById('routeOut').addEventListener('contextmenu', e => {
  const tr = e.target.closest('tr.strow');
  if (!tr) return;
  e.preventDefault();
  const j = +tr.dataset.step;
  if (S.activeRoute < 0 || !lastResults[S.activeRoute]?.steps?.[j]) return;
  openCtx(e.clientX, e.clientY, stepMenu(S.activeRoute, j));
});
document.getElementById('routeOut').addEventListener('click', e => {
  const tr = e.target.closest('tr.strow');
  if (!tr) return;
  const st = lastResults[S.activeRoute]?.steps?.[+tr.dataset.step];
  if (st) panToSelection({ h: st.h });
});

function tokenMenu(t) {
  return box => {
    ctxHead(box, `<b>${escHtml(t.label)}</b> — token`);
    ctxItem(box, 'Rename…', () => {
      const v = prompt('Token text:', t.label);
      closeCtx();
      if (v != null && v.trim()) { t.label = v.trim().slice(0, TOK_MAXLEN); commitTokens(); }
    });
    ctxFlyout(ctxItem(box, `<span class="sw" style="background:${escHtml(t.color)}"></span>Colour<span class="arw">▸</span>`),
              s => buildColorPanel(s, TOKEN_COLORS, () => t.color,
                                   c => { t.color = c; commitTokens({ coalesce: 'tkcolor' + t.id }); }));
    const det = nextDetachLabel(t);
    if (det) ctxItem(box, `Split off <b style="color:#fff">${escHtml(det)}</b>`, () => {
      addToken(t.h, det, t.color);   // same hex and colour: drag it off, it stays visibly the same command
      closeCtx();
    });
    ctxSep(box);
    ctxItem(box, 'Delete', () => { deleteToken(t); closeCtx(); }, 'danger');
    if (S.tokens.length > 1)
      ctxItem(box, `Clear all tokens<span class="arw">${S.tokens.length}</span>`,
              () => { closeCtx(); clearAllTokens(); }, 'danger');
  };
}

// Anything that moves the map or the page out from under the menu closes it.
document.addEventListener('pointerdown', e => {
  if (ctxEl.hidden) return;
  if (e.target.closest?.('#ctxMenu, .ctxsub')) return;
  // Grabbing a token is a real action even with the menu up, so only a press on the bare map is
  // spent on dismissing. Panning still works either way: this only cancels the click, not the drag.
  if (svg.contains(e.target) && !e.target.closest?.('[data-tok]')) ctxDismiss = true;
  closeCtx();
}, true);
addEventListener('resize', closeCtx);
svg.addEventListener('wheel', closeCtx, { passive: true });

/* ---------------- tokens: sidebar ---------------- */
function setTokenPick(on) {
  S.tokenPick = on;
  document.getElementById('tokPlace').classList.toggle('on', on);
}
document.getElementById('tokPlace').onclick = () => setTokenPick(!S.tokenPick);
document.getElementById('tokStart').onclick = async () => {
  const arr = await fetchStartingTokens();
  if (!arr) return alert('No data/tokens.json to load.');
  if (S.tokens.length && !confirm(`Replace the ${S.tokens.length} tokens on the map with the ${arr.length} starting positions?`)) return;
  S.tokens = arr;
  commitTokens();
};
function clearAllTokens() {
  if (!S.tokens.length) return;
  if (!confirm(`Remove all ${S.tokens.length} tokens from the map?`)) return;
  S.tokens = [];
  commitTokens();
}
document.getElementById('tokClear').onclick = clearAllTokens;
document.getElementById('tokExport').onclick = () => {
  const blob = new Blob([JSON.stringify({ version: 1, tokens: S.tokens }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'tokens.json'; a.click();
  URL.revokeObjectURL(a.href);
};
document.getElementById('tokImport').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const arr = normalizeTokens(Array.isArray(j) ? j : j.tokens);
    if (!arr) throw 0;
    S.tokens = arr;
    commitTokens();
  } catch { alert('Not a valid tokens.json'); }
  e.target.value = '';
};

/* ---------------- boot ---------------- */
async function fetchFeaturesFile() {
  try {
    const r = await fetch('data/features.json');
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.features) ? { version: 2, labels: {}, strongholds: {}, ...j } : null;
  } catch { return null; }
}
async function boot() {
  const T = await (await fetch('data/terrain.json')).json();
  S.G = T.grid; S.hexes = T.hexes;
  try { S.names = await (await fetch('data/strongholds.json')).json(); } catch {}
  initGeom();
  buildScaffold();
  if (adaptiveView()) coverView(); else applyViewBox();
  { const r = svg.getBoundingClientRect(); if (r.width && r.height) wasLandscape = r.width >= r.height; }
  renderTerrain();
  const ls = localStorage.getItem(LS_KEY);
  if (ls) { try { S.features = JSON.parse(ls); } catch {} }
  else { const ff = await fetchFeaturesFile(); if (ff) S.features = ff; }
  migrateFeatures(S.features);
  renderFeatures(); renderLabels();
  buildLayerUI();
  for (const L of LAYERS) L._apply?.();
  // A browser that has moved tokens before keeps its own board, exactly as it left it. One that
  // never has starts from the positions shipped with the map rather than from nothing.
  const tls = localStorage.getItem(TOK_LS);
  if (tls) {
    try { S.tokens = normalizeTokens(JSON.parse(tls).tokens) || []; } catch {}
    // The board as loaded is what the first Ctrl+Z should restore to, so record it as the snapshot
    // rather than leaving the first change to take one of itself, after the fact.
    tokensSnap = JSON.stringify(S.tokens);
    renderTokens(); renderTokenList();
  } else {
    // Saved as soon as it is seeded, so the shipped board becomes *this* browser's board: clearing
    // it and reloading then leaves it clear, rather than quietly putting every legion back.
    S.tokens = await fetchStartingTokens() || [];
    commitTokens({ quiet: true });   // the board as it arrives is not a change to take back
  }
  try {
    const rr = JSON.parse(localStorage.getItem('rotmap_routes_v1'));
    if (rr && Array.isArray(rr.routes)) {
      S.routes = rr.routes;
      S.activeRoute = Math.min(rr.active ?? S.routes.length - 1, S.routes.length - 1);
    }
    if (rr && rr.iso && Array.isArray(rr.iso.origins)) {
      S.iso.origins = rr.iso.origins;
      S.iso.active = Math.min(rr.iso.active ?? 0, S.iso.origins.length - 1);
    }
  } catch {}
  computeRoute();
  document.getElementById('dataInfo').textContent =
    `Terrain snapshot: ${Object.keys(S.hexes).length} hexes (fetched ${T.fetched}).`;
  document.getElementById('saveInfo').textContent =
    `${S.features.features.length} features loaded.`;
}
/* ---------------- place search ----------------
   The names on this map are full of letters no one is going to type: Naŕes, Hā-aēšema, Zakuruiôi,
   Sam'al. So nothing is compared as written. Both the query and every name are folded down to plain
   letters first — accents dropped, case levelled, apostrophes and hyphens thrown away — and even
   then the comparison allows a few letters to be wrong, so a name half-remembered still finds it. */
const FOLD_EXTRA = { đ: 'd', ð: 'd', ł: 'l', ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', þ: 'th' };
function fold(s) {
  return (s || '')
    .normalize('NFD').replace(/\p{M}+/gu, '')       // ŕ → r, ā → a, š → s
    .toLowerCase()
    .replace(/[đðłøæœßþ]/g, c => FOLD_EXTRA[c])     // the few that don't decompose
    .replace(/[^a-z0-9 ]+/g, '')                    // Sam'al and Samal are the same word here
    .replace(/\s+/g, ' ').trim();
}
// The fewest single-letter changes that turn the query into some run of letters inside the name —
// zero when the name simply contains it. Deletions at either end of the name cost nothing (the first
// row starts at zero, and any cell of the last row may be the answer), which is what makes this a
// search for the query *somewhere* in the name rather than a comparison of the two whole strings.
function subEdit(q, n) {
  const m = q.length, L = n.length;
  let pp = new Array(L + 1).fill(0);     // two rows back, for transpositions
  let prev = new Array(L + 1).fill(0);   // one row back; the zeroes are the free start
  let cur = new Array(L + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= L; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (q[i - 1] === n[j - 1] ? 0 : 1));
      // Two letters typed the wrong way round is one mistake, not two — and it is the commonest one.
      if (i > 1 && j > 1 && q[i - 1] === n[j - 2] && q[i - 2] === n[j - 1]) v = Math.min(v, pp[j - 2] + 1);
      cur[j] = v;
    }
    const t = pp; pp = prev; prev = cur; cur = t;
  }
  let best = prev[0];
  for (let j = 1; j <= L; j++) if (prev[j] < best) best = prev[j];
  return best;
}
// Every name the map actually draws, by the same rules renderLabels uses — a hex named by hand wins
// over its datasheet name, and a stronghold that has been erased is not a place any more.
/* Mirrors renderLabels, so what the search finds is exactly what the map draws — including two places
   in one hex, which now get a row each. Keyed by hex and subhex for the same reason the renderer is:
   keyed by hex alone, the second of two banks would be silently dropped from the search. */
function placeList() {
  const out = [], seen = new Set();
  const add = (id, ri, name) => {
    const key = id + ':' + ri;
    if (seen.has(key)) return;
    seen.add(key);
    if (name) out.push({ h: +id, ri, name });
  };
  for (const id of namedHexes()) {
    const es = shEntries(id);
    for (const { m, ri } of es) add(id, ri, shName(id, m));
    if (!es.length && S.features.labels[id]) add(id, shRegion(id, {}), S.features.labels[id]);
  }
  return out;
}
// The regions the sheet gives each hex, with how many hexes each covers.
function regionList() {
  const n = new Map();
  for (const id in S.hexes) { const g = S.hexes[id].g; if (g) n.set(g, (n.get(g) || 0) + 1); }
  return [...n].map(([name, hexes]) => ({ name, hexes }));
}
const SEARCH_MAX = 8;
function searchPlaces(raw) {
  const q = fold(raw);
  if (!q) return [];
  const hits = [];
  const num = raw.trim();
  // A bare number is a hex id. The step table is full of them, so looking one up is worth doing.
  if (/^\d+$/.test(num) && S.hexes[num])
    hits.push({ h: +num, name: S.features.labels[num] || S.names.hexes[num] || '', rank: -1 });
  // How wrong the spelling may be, in letters. One or two letters have to be exact — at that length
  // a single wrong letter would match half the map. Right spellings always rank above near ones, so
  // being generous here only ever adds rows below the good answers.
  const tol = q.length <= 2 ? 0 : q.length >= 9 ? 2 : 1;
  // Spelt right beats spelt nearly right; then the whole name, then a name that starts with what was
  // typed, then one that has it later on. Ties go to the shorter name.
  const score = n => {
    const cost = subEdit(q, n);
    if (cost > tol) return null;
    const at = cost === 0 ? n.indexOf(q) : 99;
    return cost * 10 + (n === q ? 0 : at === 0 ? 1 : at > 0 ? 2 + Math.min(at, 20) / 100 : 3) + n.length / 1000;
  };
  for (const pl of placeList()) {
    const n = fold(pl.name);
    if (!n) continue;
    const rank = score(n);
    if (rank !== null) hits.push({ h: pl.h, ri: pl.ri, name: pl.name, rank });
  }
  for (const rg of regionList()) {
    const rank = score(fold(rg.name));
    if (rank !== null) hits.push({ region: rg.name, name: rg.name, hexes: rg.hexes, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const seen = new Set();
  // Two places in one hex are two answers, so the dedupe key has to carry the subhex — otherwise
  // searching for the one on the far bank would silently return the one on the near bank instead.
  return hits.filter(x => {
    const k = x.region ?? (x.h + ':' + (x.ri ?? ''));
    return !seen.has(k) && seen.add(k);
  }).slice(0, SEARCH_MAX);
}

const searchInput = document.getElementById('search');
const searchBox = document.getElementById('searchResults');
let searchHits = [], searchSel = 0;

/* What the search has picked out is a *selection*, not a pointer: it stays lit until you drop it.
   A plain click selects one thing and drops everything else; shift-click adds to what is already
   there, or takes that one back out. Selected rows stay in the list even once the box is empty, so a
   selection made three searches ago can still be found and switched off. */
let sel = [];      // [{ region } | { h }] in the order they were chosen
// Carries the subhex, so selecting the keep on one bank does not light up the town on the other.
const selKey = it => (it.region != null ? 'r:' + it.region : 'h:' + it.h + ':' + (it.ri ?? ''));
const inSel = it => sel.some(s => selKey(s) === selKey(it));
const regionSize = name => {
  let n = 0;
  for (const id in S.hexes) if (S.hexes[id].g === name) n++;
  return n;
};

// The rows on show: everything selected, pinned at the top, then whatever the query turns up that
// isn't selected already.
function searchRows() {
  const pinned = sel.map(it => it.region != null
    ? { region: it.region, name: it.region, hexes: regionSize(it.region) }
    // Rebuilt from the marker where there is one, so a renamed stronghold's pin renames with it.
    : { h: it.h, ri: it.ri, name: (it.ri != null && shAt(it.h, it.ri) ? shName(it.h, shAt(it.h, it.ri)) : null)
                                  || S.features.labels[it.h] || S.names.hexes[it.h] || '' });
  const keys = new Set(pinned.map(selKey));
  const hits = searchPlaces(searchInput.value).filter(x => !keys.has(selKey(x)));
  return { pinned, hits, rows: [...pinned, ...hits] };
}

function renderSearch() {
  const { pinned, rows } = searchRows();
  searchHits = rows;
  searchBox.innerHTML = '';
  if (!rows.length) {
    if (searchInput.value.trim()) searchBox.innerHTML = '<div class="srnone">Nothing close to that name.</div>';
    return;
  }
  // The keyboard cursor lives among the results, not the pinned rows, which are there to be clicked.
  searchSel = Math.max(pinned.length && rows.length > pinned.length ? pinned.length : 0,
                       Math.min(searchSel, rows.length - 1));
  rows.forEach((hit, i) => {
    const d = document.createElement('div');
    d.className = 'sr' + (i === searchSel ? ' sel' : '') + (inSel(hit) ? ' on' : '');
    const nm = document.createElement('span'), meta = document.createElement('span');
    nm.className = 'nm'; meta.className = 'meta';
    nm.textContent = hit.name || 'hex ' + hit.h;          // textContent: names are data, not markup
    if (hit.region != null) {
      meta.textContent = `region · ${hit.hexes} hexes`;
    } else {
      const t = S.hexes[hit.h]?.t;
      meta.textContent = hit.h + (t ? ' · ' + t : '');
    }
    const item = hit.region != null ? { region: hit.region } : { h: hit.h };
    d.title = inSel(hit) ? 'Click to deselect · shift-click to remove from the selection'
                         : 'Click to select · shift-click to add to the selection';
    d.onclick = e => pick(item, e.shiftKey);
    // Shift needs a keyboard, so the same add/remove sits on the row as a button — the only way to
    // build a selection on a touchscreen, and no worse than the shortcut for anyone with a mouse.
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'addsel';
    plus.textContent = inSel(hit) ? '−' : '+';
    plus.title = inSel(hit) ? 'Remove from the selection' : 'Add to the selection';
    plus.onclick = e => { e.stopPropagation(); pick(item, true); };
    d.append(nm, meta, plus);
    searchBox.appendChild(d);
  });
}

/* ---------------- selection ---------------- */
function pick(item, add) {
  const k = selKey(item);
  const at = sel.findIndex(s => selKey(s) === k);
  if (add) {
    // Shift-click is a toggle on the set: it never disturbs the rest of it, and never moves the view
    // away from what you were looking at while you build one up.
    if (at >= 0) sel.splice(at, 1); else sel.push(item);
    renderSelection(at >= 0 ? null : k);
    renderSearch();
    return;
  }
  // A plain click on the only thing selected switches it off; otherwise it becomes the selection.
  if (sel.length === 1 && at === 0) {
    sel = [];
    renderSelection(null);
    renderSearch();
    return;
  }
  sel = [item];
  renderSelection(k);
  panToSelection(item);
  renderSearch();
  searchInput.blur();          // and with it the on-screen keyboard
  closeSheet();                // on a phone the map is behind the sheet; get out of the way
}
function clearSelection() {
  sel = [];
  renderSelection(null);
}
// Named entry points, one thing at a time — what the search rows and anything else should call.
const goToPlace = h => pick({ h }, false);
const goToRegion = name => pick({ region: name }, false);

/* Move the map to what was picked without touching how far in you are: a search is for finding
   something, not for deciding how closely you wanted to look at it. */
function panToSelection(item) {
  let cx, cy;
  if (item.region != null) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id in S.hexes) {
      if (S.hexes[id].g !== item.region) continue;
      const [hx, hy] = hexCenter(+id);
      x0 = Math.min(x0, hx); x1 = Math.max(x1, hx);
      y0 = Math.min(y0, hy); y1 = Math.max(y1, hy);
    }
    if (x0 === Infinity) return;
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;   // the middle of the region, however much of it fits
  } else {
    // Pans to the marker the row stands for, so picking the far-bank place goes to the far bank rather
    // than to whichever stronghold in the hex happened to be listed first.
    const m = item.ri != null ? shAt(item.h, item.ri) : null;
    [cx, cy] = m ? shPoint(item.h, m) : hexCenter(item.h);
  }
  S.vb = { ...S.vb, x: cx - S.vb.w / 2, y: cy - S.vb.h / 2 };
  applyViewBox();
}

/* Paint the selection. Regions get a wash under the grid — they are ground, and the roads and names
   on top of them must stay readable — while single hexes get an outline on the very top layer, where
   one thin hexagon won't be lost among the roads.

   A region is every hex the sheet gives it, whole. The sheet names a region per *hex*, and that claim
   covers all of it: lighting only the piece that matched the hex's own terrain left holes, since hex
   2495 is Flatlands in the Gulf of Arstis and a coastline had cut a bay out of it, leaving the bay —
   as much Gulf as the open water beside it — dark. Whole hexagons also spare the wash the seams where
   two flood-filled pieces of one hex don't quite meet. Off-map filler (N/A) is skipped: there is
   nothing drawn there to light.

   `just` marks the hex chosen a moment ago, which blinks a few times to catch the eye and then
   settles into the steady outline — the view no longer zooms in, so it needs the help. */
function regionPath(name) {
  let d = '';
  for (const id in S.hexes) {
    const v = S.hexes[id];
    if (v.g !== name || v.t === 'N/A') continue;
    const [cx, cy] = hexCenter(+id);
    d += hexPath(cx, cy);
  }
  return d;
}
function renderSelection(justKey) {
  groups.selRegion.innerHTML = '';
  groups.selHex.innerHTML = '';
  sel.forEach((it, i) => {
    if (it.region == null) return;
    const d = regionPath(it.region);
    if (!d) return;
    el('path', { d, fill: 'rgba(255,215,110,.28)', 'fill-rule': 'evenodd',
                 stroke: 'none', 'pointer-events': 'none' }, groups.selRegion);
    // An edge round the outside makes the extent legible where the ground under the wash is already
    // patchy. Rather than working out the union of a few hundred hexagons, the same shape is stroked
    // and then masked by everything the shape *isn't*: the half of each line lying inside the region
    // is hidden, and with it every line between two hexes of the region, since both its halves are
    // inside. What survives is the outer half of the boundary — the region's silhouette. Each region
    // keeps its own mask, so where two selected regions adjoin, the border between them still shows.
    const id = 'selEdgeMask' + i;
    const mask = el('mask', { id, maskUnits: 'userSpaceOnUse',
                              x: 0, y: 0, width: S.G.image_width, height: S.G.image_height }, groups.selRegion);
    el('rect', { x: 0, y: 0, width: S.G.image_width, height: S.G.image_height, fill: '#fff' }, mask);
    el('path', { d, fill: '#000', 'fill-rule': 'evenodd' }, mask);
    el('path', { d, fill: 'none', stroke: '#ffd76e', 'stroke-width': 5, 'stroke-linejoin': 'round',
                 mask: `url(#${id})`, 'pointer-events': 'none' }, groups.selRegion);
  });
  for (const it of sel) {
    if (it.region != null) continue;
    const [cx, cy] = hexCenter(it.h);
    const a = { d: hexPath(cx, cy), fill: 'rgba(255,215,110,.18)', stroke: '#ffd76e', 'stroke-width': 3,
                'stroke-linejoin': 'round', 'pointer-events': 'none' };
    if (selKey(it) === justKey) a.class = 'just';
    el('path', a, groups.selHex);
  }
}

searchInput.addEventListener('input', () => {
  searchSel = 0;
  renderSearch();     // emptying the box leaves the selection alone: its rows stay, to be clicked off
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!searchHits.length) return;
    e.preventDefault();
    searchSel = (searchSel + (e.key === 'ArrowDown' ? 1 : searchHits.length - 1)) % searchHits.length;
    renderSearch();
  } else if (e.key === 'Enter') {
    const hit = searchHits[searchSel];
    if (hit) pick(hit.region != null ? { region: hit.region } : { h: hit.h }, e.shiftKey);
  } else if (e.key === 'Escape') {
    searchInput.value = ''; clearSelection(); renderSearch(); searchInput.blur();
  }
});

/* ==========================================================================
   The shell
   --------------------------------------------------------------------------
   A rail of icons, one panel at a time, and the map. The same two elements
   serve both layouts: on a wide screen the rail is a column and the panel sits
   beside it; below 820px the stylesheet turns the rail into a bottom bar and
   the panel into a sheet that slides up. Only the transform differs, so there
   is one set of handlers rather than two.
   ========================================================================== */
const panelEl = document.getElementById('panel');
const panelTitleEl = document.getElementById('panelTitle');
const railEl = document.getElementById('rail');
const undoFloat = document.getElementById('undoWpFloat');
const narrow = () => matchMedia('(max-width: 820px)').matches;

function saveUI() { try { localStorage.setItem(UI_LS, JSON.stringify(UI)); } catch {} }

/* Which panel is showing. Draw is a mode as well as a panel — the map behaves differently while it
   is open — so opening it switches the map into drawing and leaving it switches back. That is the
   whole of the old Draw/Route toggle, minus the toggle. */
const PANE_TITLES = { find: 'Find', route: 'Routes', iso: 'Isochrone', tokens: 'Tokens',
                      draw: 'Draw', data: 'Data' };
function showPane(name, opts) {
  if (!PANE_TITLES[name]) name = 'route';
  if (!LOCAL && (name === 'draw' || name === 'data')) name = 'route';
  UI.pane = name;
  for (const el of document.querySelectorAll('#panelBody .pane')) el.classList.toggle('on', el.dataset.pane === name);
  for (const b of railEl.querySelectorAll('.railbtn[data-pane]')) b.classList.toggle('on', b.dataset.pane === name);
  panelTitleEl.textContent = PANE_TITLES[name];
  placeSettings(name);
  // The column boxes mean different things on different panels now — the route's army on Routes, the
  // selected origin's on Isochrone — so switching panels has to reread them. Without this the boxes
  // would show one army's numbers while writing them into another's.
  syncRouteForm();
  setMode(name === 'draw' ? 'draw' : 'route');
  // Says out loud what the map is about to do with a click, since it is no longer the same
  // everywhere: on this panel the button is redundant, and looking pressed is the honest signal.
  const ip = document.getElementById('isoPick');
  if (ip) {
    ip.classList.toggle('on', name === 'iso');
    ip.title = name === 'iso' ? 'Clicking the map already sets the origin while this panel is open'
                              : 'Then click the hex the shading should spread from';
  }
  if (!opts?.keepShut) openPanel();
  saveUI();
}
function openPanel() {
  UI.shut = false;
  document.body.classList.remove('panel-shut');
  panelEl.classList.add('open');
  document.body.classList.add('sheet-open');
  saveUI();
}
// On a wide screen this takes the panel out of the layout and gives the width to the map; on a
// narrow one it slides the sheet back down. Same call either way.
function closePanel() {
  UI.shut = true;
  document.body.classList.add('panel-shut');
  panelEl.classList.remove('open');
  panelEl.style.transform = '';
  document.body.classList.remove('sheet-open');
  for (const b of railEl.querySelectorAll('.railbtn[data-pane]')) b.classList.remove('on');
  saveUI();
}
const closeSheet = () => { if (narrow()) closePanel(); };

railEl.addEventListener('click', e => {
  const b = e.target.closest('.railbtn[data-pane]');
  if (!b) return;
  // Pressing the panel you are already on puts it away — the quickest route to a full-width map.
  if (b.dataset.pane === UI.pane && !UI.shut) closePanel();
  else showPane(b.dataset.pane);
});
document.getElementById('railShut').onclick = () => (UI.shut ? showPane(UI.pane) : closePanel());
document.getElementById('panelClose').onclick = closePanel;

// The published map has no Draw or Data panel at all — the buttons are dropped rather than hidden.
if (LOCAL) for (const p of ['draw', 'data']) railEl.querySelector(`.railbtn[data-pane="${p}"]`).hidden = false;
else for (const p of ['draw', 'data']) railEl.querySelector(`.railbtn[data-pane="${p}"]`).remove();

/* Anything that floats over the map can be picked up by its header and put where it suits. One
   implementation, so the layer list and the route readout behave identically — and both remember
   where they were left, per surface. */
function makeDraggable(el, handle, onDrop) {
  let drag = null;
  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;    // the close button is not a handle
    // Only the primary button drags. The right one is asking for a menu, and letting it take the
    // pointer capture as well left the surface stuck to the cursor behind whatever menu opened.
    // Touch and pen report button 0 for their primary contact, so nothing is lost by the test.
    if (e.button !== 0) return;
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    el.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', e => {
    if (!drag) return;
    // Held inside the window, and never so far down that the header itself is off the bottom.
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.right = 'auto'; el.style.bottom = 'auto';
    el.style.left = Math.max(8, Math.min(innerWidth - w - 8, e.clientX - drag.dx)) + 'px';
    el.style.top = Math.max(8, Math.min(innerHeight - 40, e.clientY - drag.dy)) + 'px';
  });
  const end = () => { if (drag) { drag = null; el.classList.remove('dragging'); onDrop?.(); } };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
// Keeps a floating surface on screen after the window has changed shape under it.
function clampFloat(el, pos) {
  const w = el.offsetWidth || 300, h = el.offsetHeight || 200;
  const x = Math.max(8, Math.min(innerWidth - w - 8, pos.x));
  const y = Math.max(8, Math.min(Math.max(8, innerHeight - h - 8), pos.y));
  el.style.left = x + 'px'; el.style.top = y + 'px';
  el.style.right = 'auto'; el.style.bottom = 'auto';
}

/* The column and the conditions are wanted on two panels: on Routes, where the march is planned,
   and on Isochrone, where the same army's reach is being shaded. Rather than two sets of boxes that
   would have to be kept in step — and would eventually disagree — there is one set, carried between
   a slot on each panel. Moving a node keeps its listeners, so nothing has to be rewired. */
function placeSettings(pane) {
  const slot = document.getElementById(pane === 'iso' ? 'isoSettingsSlot'
             : pane === 'route' ? 'routeSettingsSlot' : 'settingsPark');
  const park = document.getElementById('settingsPark');
  if (!slot || !park) return;
  for (const id of ['colGroup', 'condGroup']) {
    const g = document.getElementById(id);
    if (g && g.parentElement !== slot) slot.appendChild(g);
  }
  updateIsoSettingsShown();
}
// Straight-line spreads ignore terrain and the column entirely, so on those the controls would be
// answering a question nobody asked.
function updateIsoSettingsShown() {
  const iso = UI.pane === 'iso';
  const mode = isoMode();
  const army = mode === 'army', relief = mode === 'relief';
  // Relief marches one of its two legs, so it wants the column just as much as army mode does —
  // it is only the two pure straight-line spreads that have nothing to do with it.
  const column = army || relief;
  const slot = document.getElementById('isoSettingsSlot');
  const note = document.getElementById('isoNotArmy');
  if (slot) slot.hidden = iso && !column;
  if (note) note.hidden = !(iso && !column);
  const rNote = document.getElementById('isoReliefNote');
  if (rNote) rNote.hidden = !(iso && relief);
  const newsWrap = document.getElementById('isoNewsWrap');
  if (newsWrap) newsWrap.hidden = !relief;
  // "Max days" is a limit on how far to look; in relief mode the same box is the budget itself —
  // the whole question, not a bound on the answer — and calling it the same thing hides that.
  const maxLbl = document.getElementById('isoMaxLbl');
  if (maxLbl) maxLbl.textContent = relief ? 'Days to arrive' : 'Max days';
  // Nothing to round in a straight line, so the optimizer goes away with the column controls. And
  // while it is on the colours no longer mean bands at all — the band box would be asking for an
  // answer nothing reads, so it is dimmed rather than left looking live.
  const optWrap = document.getElementById('isoOptWrap');
  if (optWrap) optWrap.hidden = !army;
  const bandWrap = document.getElementById('isoBandWrap');
  if (bandWrap) {
    // Gone in relief mode rather than dimmed: relief totals are whole days by construction, so there
    // is no band to choose — one per day is the only cut that isn't a lie about the numbers.
    bandWrap.hidden = relief;
    const off = isoOptimizing();
    bandWrap.classList.toggle('off', off);
    bandWrap.title = off ? 'Not used while the optimizer is shading by wasted day.' : '';
  }
}

/* ---------------- layers, as a panel over the map ---------------- */
const layersPop = document.getElementById('layersPop');
const layersBtn = document.getElementById('layersBtn');
function closeLayers() {
  layersPop.hidden = true;
  layersBtn.classList.remove('on');
  layersBtn.setAttribute('aria-expanded', 'false');
}
function openLayers() {
  layersPop.hidden = false;
  layersBtn.classList.add('on');
  layersBtn.setAttribute('aria-expanded', 'true');
  // Under its own button the first time; wherever you dragged it every time after.
  const r = layersBtn.getBoundingClientRect();
  // A width you chose is remembered; the height always fits the list, capped by the window. A saved
  // `h` from when this was resizable both ways is simply ignored — it was measured against a list
  // that has since changed length, so it no longer describes anything.
  if (UI.layersSize?.w) layersPop.style.width = UI.layersSize.w + 'px';
  layersPop.style.maxHeight = (innerHeight - 40) + 'px';
  clampFloat(layersPop, UI.layers || { x: innerWidth - layersPop.offsetWidth - 16, y: r.bottom + 8 });
}
// The corner drag reports through no event of its own; an observer is how you hear about it.
if (window.ResizeObserver) {
  let seen = false;
  new ResizeObserver(() => {
    if (seen && !layersPop.hidden) {
      const b = layersPop.getBoundingClientRect();
      // Width only: the height is the list's, and recording it would put back the very thing the
      // horizontal-only resize is there to prevent.
      if (b.width > 40 && Math.round(b.width) !== UI.layersSize?.w) {
        UI.layersSize = { w: Math.round(b.width) };
        saveUI();
      }
    }
    seen = true;
  }).observe(layersPop);
}
makeDraggable(layersPop, layersPop.querySelector('.floathead'), () => {
  if (layersPop.hidden) return;
  const r = layersPop.getBoundingClientRect();
  UI.layers = { x: Math.round(r.left), y: Math.round(r.top) };
  saveUI();
});
layersBtn.onclick = () => (layersPop.hidden ? openLayers() : closeLayers());
document.getElementById('layersClose').onclick = closeLayers;
document.addEventListener('pointerdown', e => {
  if (layersPop.hidden) return;
  if (e.target.closest('#layersPop, #layersBtn')) return;
  // The press that puts it away does nothing else — the same bargain the context menu strikes, so
  // dismissing a floating surface never costs you a waypoint.
  if (svg.contains(e.target)) ctxDismiss = true;
  closeLayers();
}, true);

/* ---------------- the route readout, as a card over the map ----------------
   It was the tallest thing in the sidebar by far, and the step table is the one part of this app
   that genuinely wants room. Out here it can be dragged somewhere useful, sized to the route, and
   put away when the map matters more than the numbers. */
const routeCard = document.getElementById('routeCard');
const routeBtns = document.getElementById('routeBtns');
const CARD_MIN_W = 260, CARD_MIN_H = 150;
function placeCard() {
  // A size measured while the card was display:none comes back as zero. Anything under the minimum
  // the stylesheet allows is such a reading, not a size someone chose, so it is thrown away.
  const c = UI.card && UI.card.w >= CARD_MIN_W && UI.card.h >= CARD_MIN_H ? UI.card : null;
  if (c) {
    routeCard.style.width = c.w + 'px';
    routeCard.style.height = c.h + 'px';
  }
  const w = c?.w || routeCard.offsetWidth || 340;
  const h = c?.h || routeCard.offsetHeight || 380;
  // Its own corner, not the layer list's. Two surfaces that both opened top-right landed on top of
  // one another and looked like one broken panel; the readout is the taller of the two, so it takes
  // the bottom of the screen and leaves the top for the list that drops out of the Layers button.
  clampFloat(routeCard, { x: c?.x ?? innerWidth - w - 16, y: c?.y ?? innerHeight - h - 16 });
}
function showCard() {
  UI.cardOff = false;
  routeCard.hidden = false;
  placeCard();
  saveUI();
  renderRouteButtons(lastResults);
}
function hideCard() {
  UI.cardOff = true;
  routeCard.hidden = true;
  saveUI();
  renderRouteButtons(lastResults);
}
document.getElementById('routeCardClose').onclick = hideCard;

/* A button per route, sitting on the map. It is three things at once: a legend saying which colour
   is which, a switcher — the active route is the one the readout and the settings panel describe —
   and the way a dismissed readout is called back. Pressing the one already showing puts it away. */
function renderRouteButtons(results) {
  routeBtns.innerHTML = '';
  S.routes.forEach((rt, i) => {
    const act = i === S.activeRoute && !routeCard.hidden;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'maptool rtbtn' + (act ? ' on' : '');
    const r = results?.[i];
    const tm = r ? (r.fail ? '✗' : r.irl.toFixed(1) + 'd') : rt.wps.length + ' wp';
    b.innerHTML = `<span class="sw" style="background:${escHtml(rt.color)}"></span>` +
                  `<span class="nm">${escHtml(rt.name)}</span><span class="tm">${tm}</span>`;
    b.title = `Show ${rt.name} — its column, conditions and step list. Right-click for more.`;
    b.onclick = () => {
      if (act) return hideCard();
      S.activeRoute = i;
      UI.cardOff = false;
      computeRoute();          // the panel and the readout both follow the active route
      showCard();
    };
    // The same menu the list row has. This button stands for the route just as much as that row does,
    // and with the panel shut it is the only handle on it — so duplicating or emptying a route from
    // here should not mean opening the panel first to find the identical menu.
    b.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); openRouteMenu(i, e.clientX, e.clientY); };
    routeBtns.appendChild(b);
  });
}

const routeCardHead = document.getElementById('routeCardHead');
makeDraggable(routeCard, routeCardHead, () => rememberCard());
/* The card is a view of one route, so its head is that route's handle in every sense: the left button
   moves the card, the right one asks about the route. It raises the same menu the ⋯ on the route's row
   raises, because it is the same question about the same thing — and until now the only way to
   duplicate, rename or copy the route you were actually reading was to leave it, go back to the
   Routes panel, and find its row again. The head always describes S.activeRoute, so there is no
   ambiguity about which route is meant. */
routeCardHead.addEventListener('contextmenu', e => {
  e.preventDefault();
  e.stopPropagation();
  if (S.routes[S.activeRoute]) openRouteMenu(S.activeRoute, e.clientX, e.clientY);
});
function rememberCard() {
  if (routeCard.hidden) return;          // a hidden element measures zero; never save that
  const r = routeCard.getBoundingClientRect();
  UI.card = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  saveUI();
}
// The CSS resize handle reports through no event of its own; an observer is how you hear about it.
if (window.ResizeObserver) {
  let seen = false;
  new ResizeObserver(() => { if (seen && !routeCard.hidden) rememberCard(); seen = true; }).observe(routeCard);
}

/* The card follows the routes: it appears when there is something to say and goes away when there
   is not, unless it was dismissed by hand — in which case the Readout button brings it back. */
function updateRouteCard(results) {
  const rt = S.routes[S.activeRoute];
  const has = !!rt;
  if (!has) { routeCard.hidden = true; undoFloat.hidden = true; renderRouteButtons(results); return; }
  if (UI.cardOff) { routeCard.hidden = true; renderRouteButtons(results); return; }
  const first = routeCard.hidden;
  routeCard.hidden = false;
  if (first) placeCard();
  const r = results?.[S.activeRoute];
  routeCard.querySelector('.floathead h3').textContent =
    rt.name + (r ? (r.fail ? ' · no route' : ' · ' + r.irl.toFixed(1) + 'd') : '');
  // The floating Remove last only appears once there is a waypoint it could take back.
  undoFloat.hidden = !narrow() || !rt.wps.length;
  renderRouteButtons(results);
}
const updateDrawerBadge = updateRouteCard;   // the name computeRoute() calls it by

// A window that has changed shape can leave a floating surface half off the screen.
addEventListener('resize', () => {
  if (!routeCard.hidden) placeCard();
  if (!layersPop.hidden) clampFloat(layersPop, UI.layers || { x: innerWidth - layersPop.offsetWidth - 16, y: 60 });
});

/* Narrow screens: drag the grip down to dismiss the sheet; a tap on it closes too, since that is
   what a handle looks like it should do. Anything shorter than 70px springs back. */
let gripDrag = null;
const panelGrip = document.getElementById('panelGrip');
panelGrip.addEventListener('pointerdown', e => {
  gripDrag = { y: e.clientY, dy: 0 };
  panelEl.classList.add('dragging');
  panelGrip.setPointerCapture(e.pointerId);
});
panelGrip.addEventListener('pointermove', e => {
  if (!gripDrag) return;
  gripDrag.dy = Math.max(0, e.clientY - gripDrag.y);
  panelEl.style.transform = `translateY(${gripDrag.dy}px)`;
});
function endGrip() {
  if (!gripDrag) return;
  const dy = gripDrag.dy;
  gripDrag = null;
  panelEl.classList.remove('dragging');
  panelEl.style.transform = '';
  if (dy > 70 || dy < 4) closePanel();
}
panelGrip.addEventListener('pointerup', endGrip);
panelGrip.addEventListener('pointercancel', endGrip);

// Opening state. A phone starts with the map clear and the sheet down, whatever was last open on a
// desktop; a desktop restores the panel it was left on.
showPane(UI.pane, { keepShut: true });
if (UI.shut || narrow()) closePanel(); else openPanel();

boot().catch(err => {
  document.body.innerHTML = `<div style="padding:2em;font-family:sans-serif">Failed to load data: ${err}.<br>
  Serve this folder over HTTP (e.g. <code>python -m http.server</code>) — file:// blocks fetch.</div>`;
});
