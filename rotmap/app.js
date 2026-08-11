'use strict';
/* Ravages vector hex map — terrain from the datasheet, hand-drawn overlays, travel calculator. */

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1jC2kO_Hidhg4WoL-jBGw1lKKD5s6a1-xoqv1omTZR_k/gviz/tq?tqx=out:csv&gid=0';
/* `no-cache` on every data file, which means *revalidate*, not "fetch it again": the browser still
   sends its ETag and still gets a 304 with an empty body when nothing has changed, so the cost is one
   round trip and the payload is only ever sent when the file has actually moved.

   Without it a static host's cache headers decide when a republished map arrives, and GitHub Pages
   serves these with ten minutes of freshness — so a file uploaded and then looked at reads as "the
   change did not go through", which is the one failure that sends you hunting through the JSON for a
   change that is sitting right there in it. The map is small and republished by hand; a stale one is
   far more expensive than a conditional request. */
const DATA_FETCH = { cache: 'no-cache' };
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
// The palette the things that stand on the ground are drawn from — counters and isochrone origins.
// It is built out of the Warlords legend, so it is declared beside it: see PALETTE, below
// WARLORD_NAMES. Routes have their own, for reasons given at ROUTE_COLORS.
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
  // The Borders map draws the warlords' doing over the realms' own claims, so it needs that scan as
  // well — read here whether or not the Warlords layer is ever switched on.
  { id: 'borders',  name: 'Borders',        def: 0, names: 'Realm names — the name each colour has been given, laid across the ground it holds', nameDef: true, lazy: async () => {
      await loadRealmScan('warlords', 'ref/warlords.png');
      await loadRealmScan('borders', 'ref/Borders_clean.png');
    } },
  /* How the ground is *administered*, between the two maps of who holds it. Above Borders because a
     province is a finer division than a realm and would be buried under it; below Warlords because a
     legion sitting on a province is a fact about this month and the province is a fact about the
     century — what a warlord holds should read over the administration he is holding it from.

     Unlike its two neighbours this one is not read off a scan: the commanderies are in the datasheet
     already, refined to subhexes against your own coastlines, and named after whichever settlement
     they hold. So it needs no image, and its names come with it. */
  { id: 'comm', name: 'Commanderies', def: 0, names: 'Commandery names — the settlement each province is named for, laid across its ground', nameDef: true, lazy: () => paintCommanderies() },
  // Who holds what *now*, over the top of who holds what by right. It goes directly above Borders so
  // that with both on, the warlord's claim is the one you see and the realm beneath shows only where
  // no warlord has taken it — which is the comparison the pair exists to make. It leaves nine tenths
  // of the map transparent, so most of Borders goes on showing through regardless.
  { id: 'warlords', name: 'Warlords',       def: 0, names: 'Warlord names — the name each colour has been given, laid across the ground it holds', nameDef: true, lazy: () => loadRealmScan('warlords', 'ref/warlords.png') },
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
  { id: 'hexIds',   name: 'Hex IDs',        def: 0, lazy: renderHexIds }, // 4,113 numbers, baked to images on first use
  { id: 'roads',    name: 'Roads',          def: 1, types: ['road'] },
  { id: 'trade',    name: 'Trade routes',   def: 1, types: ['trade'] },
  /* The markers and the names they carry are one layer with two switches. A marker says a place is
     there and how big it is; the name says which place. Reading a crowded stretch of coast you often
     want the first without the second — and at low zoom the names are what collides, not the discs —
     so the names come off on their own. On by default, because a stronghold you cannot name is of
     limited use, and the realm names are off by default for the opposite reason: they are a second
     reading of ground the map is already colouring. */
  // `linked: 'shNames'` is the names, which are a group of their own so they can sit below the realm
  // lettering while the markers stay above it — see buildScaffold. Linking is what keeps them under this
  // row's checkbox, slider and invert button despite no longer being inside its group.
  { id: 'labels',   name: 'Strongholds',    def: 1, linked: 'shNames',
    names: 'Stronghold names — the name beside each marker', nameDef: true },
  // Tokens are the topmost thing on the map: they are what you are currently moving about on it,
  // and they must stay grabbable over everything drawn under them.
  { id: 'tokens',   name: 'Tokens',         def: 1 },
];
// Sidebar row order (ids only; slave layers have no row). Kept separate from the z-order above
// because the coast fills are split around the rivers, so one array can't express both. Coast
// fills/lines stay paired at the top, right under Terrain.
// The tracing refs sit next, because they're what you flick on and off against the coast you're
// drawing; the river/road/etc. layers you're producing come below them.
const PANEL_ORDER = ['terrain', 'coast', 'coastLines', 'borders', 'comm', 'warlords',
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
  { into: 'roads',      name: 'Roads',  with: ['trade'] },
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
  /* The commanderies, read off the three tier scans by tools/build-commanderies.py: a flat list of
     { tier, hexes }, each one contiguous. They carry no names — a commandery is named for the
     settlement it holds, and that name is derived from the live stronghold data (see below), so a
     stronghold renamed on the map renames its commandery with it. */
  commanderies: [],
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
const UI = { pane: 'route', shut: false, card: null, cardOff: false, find: null, findOn: false };
try { Object.assign(UI, JSON.parse(localStorage.getItem(UI_LS)) || {}); } catch {}

/* ---------------- geometry ---------------- */
let CORN = [], EDGE = [], SUB = []; // offsets from center: corners, edge mids, sub-centres
function initGeom() {
  const G = S.G;
  gridOutline = null;                               // traced from the grid; a new grid needs a new one
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
  /* The hover layer never takes a pointer event. It exists to show you what you are pointing *at*, so an
     element in it that intercepts the pointer is answering a question with a lie — and it was doing so:
     the highlight for a split hex is a **filled** region polygon, unlike the stroke-only outline a whole
     hex gets, and a filled path is hit-testable. It sits above the route layer, so a waypoint on one bank
     of a river could not be grabbed at all: the press landed on the highlight drawn to point out the very
     marker you were reaching for. Dragging worked everywhere else, which is what made it look like a
     subhex problem rather than a stacking one.

     Set on the group rather than per element, because "nothing in here is a target" is the rule for the
     whole layer, and stating it once means the next thing drawn into it cannot forget. */
  groups.hover = el('g', { id: 'lyr_hover' });
  groups.hover.style.pointerEvents = 'none';
  groups.selHex = el('g', { id: 'lyr_selHex' });   // topmost: outlines of the hexes the search picked
  // The region wash goes under the grid, roads and names — it tints the ground, it doesn't bury it.
  groups.selRegion = el('g', { id: 'lyr_selRegion' });
  svg.insertBefore(groups.selRegion, groups.grid);
  // Tokens keep their place in LAYERS (and so their sidebar row), but move above the route lines and
  // the edit/hover scratch layers: a counter you are about to grab shouldn't hide under a route.
  svg.insertBefore(groups.tokens, groups.selHex);
  /* The top of the map is three kinds of thing, and they stack in this order for three separate reasons.

     **Stronghold names**, lowest of the three. They are the names of *places*, and a polity's name is a
     statement about a whole stretch of ground — so where the two collide the larger claim reads over the
     smaller. A town's name is also recoverable by hovering it, which a realm's lettering is not.

     **Realm names** above them, and above everything drawn: a label a road can cross is no better than
     no label. They ride in groups of their own rather than inside the layers they belong to, because a
     realm layer is something you *dim* — Borders is most useful at half strength with the terrain
     showing through — and a name faded along with the wash it names is a name you cannot read. Nor
     should lettering be inverted by a button meant for tracing scans. So they sit outside that layer's
     slider and filter.

     **Stronghold markers** above both. A disc is a point rather than a piece of text, small enough that
     lettering over it hides the very thing it marks, and it is the thing you click.

     The stronghold names are a top-level group for this reason alone — they were a child of the marker
     layer, which fixed their z-order to it — and they are `linked` back to that layer in LAYERS, so its
     checkbox, its slider and its invert button all still reach them. */
  groups.shNames = el('g', { id: 'lyr_shNames' });
  svg.insertBefore(groups.shNames, groups.labels);
  for (const L of LAYERS) if (L.names && L.id !== 'labels') {
    realmNameG[L.id] = el('g', { id: 'lyr_names_' + L.id });
    realmNameG[L.id].style.display = 'none';
    svg.insertBefore(realmNameG[L.id], groups.labels);
  }
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
/* ---------------- on the hairlines between abutting fills ----------------
   Two paths that share an edge do not quite meet. Each is rasterised on its own, each covers about
   half the pixels along the join, and a half-covered pixel laid over a half-covered pixel comes out
   at three quarters rather than whole — so a hairline of whatever is *behind* shows between them.
   The hex grid used to hide it, since that strokes every hex outline; with the grid off and the map
   zoomed out far enough for the hairlines to be dense, they read as a shimmer of a grid that is not
   there.

   The geometry is not at fault: every one of the 24,834 shared corners on this map rounds to the
   same coordinate from both sides. So this was first fixed by having each patch bleed half a screen
   pixel past its own edge — right in principle, and far too expensive in practice. A
   `non-scaling-stroke` is the one kind of paint that cannot be cached: its outline is a function of
   the current transform, so twenty-five thousand hexagon edges had to be re-stroked on every frame
   of every pan and every zoom.

   What is cheap is putting the right colour *behind* the seam, since a hairline is only visible when
   what shows through differs from what is in front of it. That costs nothing per frame, because it
   is only ever geometry, decided once:

     · the basemap paints every hex whole in the land colour and then paints the water over the top.
       One path laid under another cannot leave a gap between them, so the longest boundaries on the
       map — every coastline — have no seam to show at all.
     · the terrain sits on that basemap, so where two of its colours meet the hairline shows the land
       or the sea beneath rather than the page: green under green, blue under blue.

   Nothing is stroked. What is left is a faint line where two *different land* terrains meet and
   neither of them is Flatlands — a hills-and-mountains border, seen against the green underneath —
   which is a great deal less than a black lattice over the whole map, and free. */

function renderTerrain() {
  groups.terrain.innerHTML = ''; groups.grid.innerHTML = '';
  // Absent entirely on the published map, where the layer is dropped rather than hidden.
  if (groups.sheetRivers) groups.sheetRivers.innerHTML = '';
  const byT = {};
  let all = '', rivers = '';
  for (const idS in S.hexes) {
    const id = +idS, v = S.hexes[idS], t = v.t;
    // The sheet's grid is three columns wider than the world it describes, and those columns are
    // filled with "N/A" — not sea, not land, not anywhere. They were drawn as a dark band down the
    // right-hand edge, which made them look like part of the map that happened to be unlit. Nothing
    // is drawn for them now, so the map simply ends where it ends.
    if (t === 'N/A') continue;
    const [cx, cy] = hexCenter(id);
    const p = hexPath(cx, cy);
    byT[t] = (byT[t] || '') + p;
    all += p;
    if (v.r) rivers += p; // "River" flagged in the datasheet
  }
  for (const t in byT) {
    const c = TERRAIN_COLORS[t] || '#666';
    el('path', { d: byT[t], fill: c, stroke: 'none' }, groups.terrain);
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
// The legend read the other way round, so the palette below can ask for a warlord by name.
const WARLORD_HEX = Object.fromEntries(Object.entries(WARLORD_NAMES).map(([hex, n]) => [n, hex]));

/* The fourteen legions, in numeral order. Up here rather than beside the tokens because the palette is
   built out of it and the palette is needed early. */
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV'];
/* Four legions hold no ground on the Warlords scan, so that scan gives them no colour, so they need one
   given here. Chosen to sit in the hue gaps the other ten leave — the scan's ten cover red, crimson,
   wine, orange, gold, tan, brown, two greens and a blue, which leaves teal, violet, olive and a
   desaturated slate as the four openings. Legion XI's is deliberately the flat one: with thirteen
   saturated counters on the board, a grey among them is easier to pick out than a fourteenth hue
   squeezed between two others. */
const LEGION_UNHELD = { IV: '#0f8f8a', VIII: '#7b4fd0', X: '#7d8c1f', XI: '#6e7b96' };
/* A legion's colour is the colour the Warlords scan paints its ground, so a counter on the board and the
   territory under it are the same colour — which is the whole point of aligning the two. Derived from the
   legend rather than copied out of it, so the two cannot drift: change a colour in WARLORD_NAMES and the
   counters follow. */
const LEGION_COLORS = ROMAN.map(n => WARLORD_HEX['Legion ' + n] || LEGION_UNHELD[n]);
/* Five more, for everything that is not a legion: an isochrone origin, a counter for somebody's
   baggage train. Kept clear of all fifteen warlord colours *and* of the terrain beneath them —
   no mid-green (Flatlands), no tan (Hills), no grey-brown (Mountains), no soft mid-blue (Sea and Lake) —
   so nothing here can be mistaken for a legion or lost against the ground. The charcoal is dark on
   purpose and takes white ink, which inkOn() works out rather than being told. */
const PALETTE_SPARE = ['#eceff3', '#2b3440', '#00c8d4', '#ffd93d', '#ff5e9c'];
/* One palette for everything that *stands on* the map and needs telling apart — the fourteen legions,
   their detachments, the isochrone origins. One list rather than two, because two meant a counter and
   an origin could be "the same colour" without matching, and meant learning the swatch grid twice.

   Twenty: the five spares first, then the fourteen legions in numeral order, then the Blue Scarves —
   who are on both realm maps in their own right and so have a colour of their own to match. Twenty
   rather than fifteen because fourteen legions took all but one of the old fifteen and left nothing
   for anything that is not a legion, and because twenty is four even rows of five in the swatch grid
   where fifteen was three.

   The spares lead. The first colour offered to a thing that is not a legion should not be a legion's:
   these fifteen mean something on this map, and a baggage train wearing Legion VII's green is a
   counter that reads as Legion VII's.

   Routes were once handed out of this list too, and are not any more — a *line* has the opposite
   requirement to a counter. A counter matching the ground it stands on is the whole point of aligning
   the board with the scan; a route matching the ground it crosses is a route you cannot see. See
   ROUTE_COLORS. */
const PALETTE = [...PALETTE_SPARE, ...LEGION_COLORS, WARLORD_HEX['Blue Scarves']];
/* Detachments are named off the parent: the 5th's first is V'a, the next V'b. So a token's "base" is
   whatever stands before the apostrophe, and every token sharing a base belongs to one command — which is
   also how the next free letter is found, and how a detachment knows whose colour to wear. */
const tokenBase = lab => String(lab || '').split("'")[0];
/* Which counter colour a label implies. A token called V is Legion V and takes Legion V's colour; so does
   its detachment V'a, since a detachment is part of its parent and colouring it separately would say
   otherwise. Anything else — a name, a numeral past XIV — has no legion to point at and falls through to
   the first unused colour. */
const legionColorFor = label => {
  const i = ROMAN.indexOf(tokenBase(label));
  return i < 0 ? null : LEGION_COLORS[i];
};

/* The Borders scan paints the empire in two shades of purple — the pale one and the strong one — and
   those two are what "held by the empire" looks like on that map. Sampled from the scan itself rather
   than guessed: they are far and away its two commonest washes, at 11% and 7% of the map.

   The warlords are then laid over it. A legion holding ground the empire's map does not already show
   as one of those two is still the empire's ground, in the sense that map is drawing — so it takes
   the pale shade. The Blue Scarves are the exception, being nobody's subject: they keep their own
   colour and appear on the Borders map as a realm in their own right. */
const EMPIRE_LIGHT = '218,133,255', EMPIRE_DARK = '199,69,209';
const BORDERS_INDEPENDENT = new Set(['106,181,216']);   // Blue Scarves

const realmScans = new Map();   // layer id -> { d, w, h } decoded pixels
// layer id -> Map("hex:region" -> "r,g,b"). Kept from the paint so the readout can answer for the
// subhex under the cursor without sampling the image again, which would mean holding the pixels of
// every scan for the sake of one lookup at a time.
const realmCols = new Map();
async function loadRealmScan(id, src) {
  if (realmScans.has(id)) { paintRealms(); return; }   // already read; just make sure it is on screen
  const img = new Image();
  img.src = src;
  try { await img.decode(); } catch { return; }
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  try { realmScans.set(id, { d: ctx.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height }); }
  catch { return; } // tainted, which happens on file://
  paintRealms();     // all of them: Borders is drawn partly from the Warlords scan
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
/* The warlords, laid over the realms' own map. Ground a legion holds that the Borders scan does not
   already show as the empire's takes the paler of the empire's two shades — it is being held *from*
   the empire, and this map is about who holds what by right. The Blue Scarves are not that: they are
   independent, so they are drawn in their own colour instead of being coloured in as anyone's.

   Applied after the inheritance pass, so a spit that took its realm from the land beside it can still
   be overruled by a legion sitting on it, and left out of the Warlords layer's own paint, which goes
   on saying exactly what its scan says. */
function overlayWarlords(cols) {
  const w = realmCols.get('warlords');
  if (!w) return;
  for (const [k, c] of w) {
    if (BORDERS_INDEPENDENT.has(c)) { cols.set(k, c); continue; }
    const cur = cols.get(k);
    if (cur !== EMPIRE_LIGHT && cur !== EMPIRE_DARK) cols.set(k, EMPIRE_LIGHT);
  }
}
// Repaint every scan that has been loaded, or just the one named. Both are redone whenever the land
// changes shape, since region indices move with it and nothing here may be cached against them.
/* ---------------- the commanderies, as a layer ----------------
   The other two realm layers are read off a picture. This one is read off the datasheet: the
   commanderies are already worked out per subhex, against your own coastlines, and already named
   after whichever settlement they hold. What is missing is the one thing a map needs and the data has
   no opinion about — a colour each.

   So a colour is **made from the name**. Hashed rather than handed out in order, which buys three
   things worth having: a province keeps its colour when another is added, renamed or split, since
   nothing depends on position in a list; the same province is the same colour in two browsers a week
   apart with nothing stored anywhere to make it so; and renaming the settlement a province is named
   for recolours it, which is honest — on this map that *is* renaming the province.

   Hue takes the whole circle and saturation and lightness take a narrow band, so seventy-two colours
   differ in the way a reader can actually tell apart at a glance rather than in three ways at once.
   Two names hashing to the same colour would be drawn as one province and labelled once, so a taken
   colour is nudged around the circle until it is free — an ugly little loop that saves an ugly bug. */
function hslRgb(hh, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + hh / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map(v => Math.round(v * 255)).join(',');
}
function nameColor(s, taken) {
  let x = 2166136261;                               // FNV-1a: short, stable, and well spread
  for (let i = 0; i < s.length; i++) { x = Math.imul(x ^ s.charCodeAt(i), 16777619); }
  x >>>= 0;
  const sat = 0.42 + (x >>> 9 & 31) / 31 * 0.22, li = 0.40 + (x >>> 14 & 31) / 31 * 0.16;
  for (let k = 0; k < 360; k++) {                   // 37° steps: coprime with 360, so every hue is tried
    const c = hslRgb((x + k * 37) % 360, sat, li);
    if (!taken || !taken.has(c)) return c;
  }
  return hslRgb(x % 360, sat, li);
}
// Colour -> the name it was made from, which is how the label pass asks what to write. Rebuilt with
// the paint, since a renamed settlement changes both halves at once.
const commColorName = new Map();
function paintCommanderies() {
  const g = groups.comm;
  if (!g) return;
  g.innerHTML = '';
  if (!S.adj) deriveAdj();
  if (!commIndex) commanderyBuild();
  commColorName.clear();
  const taken = new Set(), colOf = new Map(), cols = new Map();
  for (const [key, i] of commanderyCells()) {
    let c = colOf.get(i);
    if (c === undefined) {
      // A province holding no named settlement still covers ground and still wants telling apart, so
      // it is coloured from what it *is* rather than from what it is called. It gets no label: there
      // is nothing to write.
      const nm = commSeats[i]?.name;
      c = nameColor(nm || `${S.commanderies[i]?.tier || 'tier'}#${i}`, taken);
      taken.add(c); colOf.set(i, c);
      if (nm) commColorName.set(c, nm);
    }
    cols.set(key, c);
  }
  realmCols.set('comm', cols);                      // what the label pass reads, exactly as a scan's
  const byColour = new Map();
  for (const [key, c] of cols) {
    const i = key.indexOf(':'), r = regionsOf(+key.slice(0, i))[+key.slice(i + 1)];
    if (r) byColour.set(c, (byColour.get(c) || '') + regionShape(+key.slice(0, i), r));
  }
  for (const [c, d] of byColour)
    el('path', { d, fill: `rgb(${c})`, 'fill-rule': 'evenodd', stroke: 'none' }, g);
  realmNameG.comm?.replaceChildren();               // stale the moment the ground moved; refitted below
}

function paintRealms(only) {
  for (const id of realmScans.keys()) if (!only || id === only) paintRealm(id);
  /* The commanderies answer to the same ground as the scans do — a coastline redrawn moves which
     subhexes are administered, and a stronghold renamed renames the province around it — so they are
     repainted on the same beat. Only while someone is looking: the layer starts off, and until it is
     asked for there is nothing on screen to be stale. */
  if ((!only || only === 'comm') && groups.comm?.style.display !== 'none') paintCommanderies();
  // The names are fitted to the ground, so they cannot outlive a repaint: what has just been rewritten
  // is which subhex belongs to whom, and a label placed against the old answer is in the wrong country.
  // Once, after all the painting, because placing them is a joint pass over both layers at once.
  renderRealmNames();
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
  /* Land the scan doesn't speak for. Its washes stop at the coastline *it* was drawn with, so a spit
     or headland that your own coast puts further out falls outside every wash and comes back blank.
     Such a piece takes the realm of the land it adjoins — land it could be walked to, by the same
     region adjacency the marching rules use, not merely land in a neighbouring hex, since a spit
     faces plenty of hexes across water and taking a realm from one of those strands a piece of it
     out at sea.

     Run to a fixed point, because a spit's nearest held ground is often another spit. The shore the
     drawn coast carves out runs as a *chain* of these fragments, and a single pass could only ever
     reach the first link: hex 1965's sliver adjoined exactly two pieces of land, both of them Legion
     VI's in the finished map, but one of those was itself a blank the same pass was about to fill —
     so at voting time it counted as neutral ground rather than as the neighbour it turned out to be,
     one vote against one, and the sliver stayed grey between two red hexes. Each round sees what the
     last one settled and the loop stops when a round settles nothing.

     Iterating cannot creep inland, because the only candidates are the pieces of a *split* hex —
     S.adj.sub holds exactly the hexes a drawn coast or major river cuts, so a whole unsplit hex of
     genuinely neutral ground is never up for inheritance in any round. What spreads is confined to
     the shoreline the drawing itself created, which is what this pass is for. */
  const inherited = new Map();
  const held = k => cols.get(k) || inherited.get(k);
  for (;;) {
    // Collected per round rather than applied as they are found, so within a round nothing inherits
    // from an inheritance and the result does not depend on the order the pieces are walked in.
    const round = new Map();
    for (const [hx, cells] of S.adj.sub) {
      const rs = cells.regions;
      for (let ri = 0; ri < rs.length; ri++) {
        if (rs[ri].sea || held(hx + ':' + ri)) continue;
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
            const c = held(n + ':' + rj);
            if (c) votes.set(c, (votes.get(c) || 0) + 1); else neutral++;
          }
        }
        let best = null, bn = 0;
        for (const [c, n] of votes) if (n > bn) { bn = n; best = c; }
        // Strictly more than the neutral ground, so a tie leaves it unclaimed: land is inherited when
        // most of what it adjoins is held, not merely when something adjoining it is. A piece whose
        // only land neighbour is claimed still inherits — there is nothing there to object — which is
        // the case this pass was written for.
        if (best && bn > neutral) round.set(hx + ':' + ri, best);
      }
    }
    if (!round.size) break;                       // terminates: every round that runs again adds one
    for (const [k, c] of round) inherited.set(k, c);
  }
  for (const [k, c] of inherited) cols.set(k, c);
  if (id === 'borders') overlayWarlords(cols);
  // Hand-painted last, so it beats the scan, the inheritance and the warlords overlay alike. That is
  // the point of it: it is there for the places all three of them get wrong.
  for (const h in S.features.realms?.[id] || {})
    for (const ri in S.features.realms[id][h]) {
      const c = S.features.realms[id][h][ri];
      if (c === 'none') cols.delete(h + ':' + ri); else cols.set(h + ':' + ri, c);
    }
  realmCols.set(id, cols);   // what the readout answers from
  const byColour = new Map();
  for (const [key, c] of cols) {
    const [hs, ris] = key.split(':'), r = regionsOf(+hs)[+ris];
    if (r) byColour.set(c, (byColour.get(c) || '') + regionShape(+hs, r));
  }
  for (const [c, d] of byColour) // one path per realm, so 4,000 hexes cost a couple of dozen nodes
    el('path', { d, fill: `rgb(${c})`, 'fill-rule': 'evenodd', stroke: 'none' }, g);
  // The names that were on this ground are now stale, but they are not rebuilt here: placing them takes
  // both layers at once, so paintRealms does it after every layer that needed painting has been painted.
  realmNameG[id]?.replaceChildren();
}

/* ---------------- realm names ----------------
   A name laid across the ground it belongs to, the way the grand strategy maps do it: not a caption
   pinned to a centre, but lettering that runs the length of a country and bends with it, so the shape
   of the word tells you the shape of the country before you have read it.

   The work divides in two, and the division is the important thing about this section. **Finding a
   baseline** — a line through the country to write along — is a question with several defensible
   answers and no obviously right one; a parabola through the middle, a walk along the country's spine,
   an arc of a circle, and the same arc shared with every other label on the map all produce maps that
   look different and each look better than the others somewhere. **Setting a name along a baseline** —
   trimming it to the ground, deciding how large the letters can be, how far apart, where they start —
   is the same problem whatever line arrived, and is answered once.

   So the baselines are a *list* rather than a decision, chosen from and tuned in the local-only Realm
   labels panel, and everything downstream of `setNameAlong` neither knows nor cares which one it got.
   Every number either half uses lives in `RN` and is a control on that panel; the published map takes
   the defaults, which are what the panel was used to settle on. */
const realmNameG = {};   // layer id -> the <g> its labels are drawn into

/* Every knob, with the value the published map uses. Kept as one object rather than as constants
   because the whole point is that they are tried against a real map with real names on it — a number
   in this file is a hypothesis, and the panel is how it gets tested. */
const RN_DEFAULT = {
  /* The **circular arc through the spine**: the walk finds the route through the country, and then the
     whole of it is reduced to a single arc. One curvature per label, so there is no ripple available to
     it at any degree of zoom — which the cubic could still manage on a long awkward block — while the
     walk underneath keeps it going the way the country goes and through whatever neck the country goes
     through. It is the calmest of the eight that is still about the shape of the ground. */
  algo: 'spineArc',
  face: 'palatino',      // which face: see REALM_FACES
  ink: 'ivory',          // which ink: see REALM_INKS

  fsMin: 3,              // below this a label is a smudge; better nothing
  fsMax: 48,             // above this the biggest realms start shouting
  trackMax: 1,           // most extra advance a gap may take, in ems
  thickPct: 0.35,        // percentile of the thickness profile the size is taken from
  thickFrac: 0.36,       // how much of that thickness a font size may be — settled with the provinces
                         // on the map, where 0.52 had the names filling their ground edge to edge
  /* Both of the taper protections are **off**. They were written for a fitted curve, which will happily
     run a name into the point of a spit; an arc through the spine stays much closer to the middle of
     the ground, so the letters do not need holding back from the ends and the map reads better for the
     extra room. Turn them up if a name starts hanging off a headland again. */
  endInset: 0,           // room left clear at the two ends together, in font sizes
  taperNeed: 0,          // ground must be this many font sizes thick to hold a capital
  /* Steps of "outside the country" the trim will step over rather than end the name. Generous, because
     an arc is a firmer shape than a fitted curve and will leave the land for longer where a country
     turns — and because the alternative to stepping over the gap is losing half the name. */
  gapTol: 11,
  sagMax: 0.18,          // hard cap on bend, as sag ÷ span, whatever the baseline asked for

  /* Degrees; past this a label reads as text turned on its side. Settled at 29 against a real map:
     fifty let the long thin provinces stand nearly diagonal, which is faithful to the ground and
     hard to read across a sheet of them, and the names sit level enough at this to be scanned in
     rows while still leaning the way the country leans. */
  tiltMax: 29,
  // At 1 nothing counts as round, so every block is given its own axis rather than being levelled.
  roundRatio: 1,
  pull: 3.8,             // how strongly the spine is pulled off the border towards the middle
  /* Degrees of total turn past which a baseline is unwritable. Settled at 190 against a real map:
     490 let a name follow a country round a hook until the word had turned further than a reader
     will, and refusing those leaves the name to a straighter piece of the same ground. */
  turnMax: 190,
  polyDeg: 3,            // degree of the fit through the spine
  smoothMix: 0.6,        // 0 = the raw walk, 1 = the fit; between = pulled back towards the walk
  avgPasses: 2,          // averaging passes, for the smoothed-spine baseline
  chaikin: 2,            // corner-cutting passes, likewise

  originDeg: 40,         // shared-origin arcs: which way the common centre lies from the map's middle
  originDist: 8.6,       // ...and how far, in map heights

  blocksMax: 8,          // most pieces of one realm that get its name
  blockMinHex: 0,        // a piece must be at least this many whole hexes
  blockFrac: 0.14,       // ...and this share of the realm's largest piece
  collide: 0.48,         // labels touch when closer than this times their heights added
  /* The same, for two labels from *different* layers. It was set well below the same-layer figure on the
     theory that the pair want less room from each other — two names close together on one layer is a
     real ambiguity about who holds the ground between them, and across the pair it is not, the two being
     answers to different questions about the same ground. Which is true as far as it goes, and it turned
     out not to be what the eye wants: at half the crowding was worse than the ambiguity it was avoiding,
     because a legion's name and a realm's name jostling at arm's length still read as one crowded map
     rather than as two layers. So it sits within a whisker of the same-layer figure, and the two layers
     really are treated as one for spacing. What keeps the legion names is the precedence below, not a
     licence to crowd. */
  collideCross: 0.5,
  /* Who wins when a warlord's name and a realm's name want the same ground: `upper` gives it to
     Warlords, which is the layer drawn on top and therefore the paint a reader can actually see there;
     `lower` to Borders; `area` to whichever country is larger, regardless of layer. */
  crossRule: 'upper',
};
// The choices for that last one, as the panel offers them.
const RN_CROSS_RULES = [
  { id: 'upper', name: 'Warlords win (upper layer)' },
  { id: 'lower', name: 'Borders win (lower layer)' },
  { id: 'area',  name: 'Larger realm wins' },
];
const RN = { ...RN_DEFAULT };
const RN_LS = 'rotmap_realmnames_v1';
// Only locally. A stored preference on the published map would mean two readers seeing two maps.
if (LOCAL) try { Object.assign(RN, JSON.parse(localStorage.getItem(RN_LS)) || {}); } catch {}

/* Caps, letter-spaced, in a serif. Caps because a spaced-out lowercase word reads as a mistake and a
   spaced-out capitalised one reads as a map, and serif for the same reason — this is the one thing on
   the map that is lettering rather than a label, and it should not look like the UI.

   The three web faces are dev-only auditions: they fetch a stylesheet the first time they are picked
   and never otherwise, so nothing is requested by anyone merely reading the map. Each falls back
   through the installed serifs, so picking one offline gets the fallback rather than a blank map. */
const REALM_FACES = [
  { id: 'palatino',  name: 'Palatino',        weight: 600, family: '"Palatino Linotype", "Book Antiqua", Palatino, "URW Palladio L", Georgia, serif' },
  { id: 'georgia',   name: 'Georgia',         weight: 600, family: 'Georgia, "Times New Roman", serif' },
  { id: 'constantia',name: 'Constantia',      weight: 600, family: 'Constantia, Cambria, Georgia, serif' },
  { id: 'times',     name: 'Times',           weight: 700, family: '"Times New Roman", Times, serif' },
  { id: 'sans',      name: 'System sans',     weight: 600, family: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: 'cinzel',    name: 'Cinzel · web',    weight: 600, family: 'Cinzel, "Palatino Linotype", Georgia, serif', web: 'Cinzel:wght@400..900' },
  { id: 'marcellus', name: 'Marcellus SC · web', weight: 400, family: '"Marcellus SC", "Palatino Linotype", Georgia, serif', web: 'Marcellus+SC' },
  { id: 'garamond',  name: 'EB Garamond · web',  weight: 600, family: '"EB Garamond", "Palatino Linotype", Georgia, serif', web: 'EB+Garamond:wght@400..800' },
];
/* How the lettering is inked. The first is the published treatment: **opaque** ivory on a solid dark
   rim. It was translucent once — four fifths on the fill, three quarters on the halo — on the theory
   that the realm colour reading through would tie the name to its ground. What it actually did was mix
   every name with whatever it lay on and turn the lot grey, which is the one thing lettering on a map
   must not be: a label is either legible or it is dirt on the picture. The realm colour ties the name
   to its ground by being *underneath* it. */
const REALM_INKS = [
  { id: 'ivory', name: 'Ivory on black',   fill: '#fbf6ea', stroke: '#0d1015', sw: 0.17 },
  { id: 'white', name: 'White on black',   fill: '#ffffff', stroke: '#14181e', sw: 0.17 },
  // Ink cut from the realm's own colour, with the halo the other way round. The one treatment that
  // says *which* country without being read, and the one that needs the colour passed in.
  { id: 'realm', name: 'Realm ink on ivory', realm: true, fill: '#fbf6ea', stroke: '#fbf6ea', sw: 0.2 },
];
const realmFace = () => REALM_FACES.find(f => f.id === RN.face) || REALM_FACES[0];
const realmInk  = () => REALM_INKS.find(i => i.id === RN.ink)   || REALM_INKS[0];

/* Measured off a canvas rather than off the SVG. The honest way is to put the text in the document
   and ask it its length, but these labels are fitted while their group is switched off — that is the
   whole point of building on demand — and a hidden element has no length to give. The same family,
   weight and size measured on a canvas is the same font, so the number is the same one; it just does
   not need the label to be on screen to be had. */
const _measCtx = (() => { try { return document.createElement('canvas').getContext('2d'); } catch { return null; } })();
function realmTextW(s, px) {
  const f = realmFace();
  if (!_measCtx) return s.length * px * 0.62;   // no canvas: assume a typical average advance
  _measCtx.font = `${f.weight} ${px}px ${f.family}`;
  return _measCtx.measureText(s).width || s.length * px * 0.62;
}

/* ---- the ground a name has to work with ---- */

/* The graph of a colour's holdings: which held subhexes can be walked between. Same-hex pieces that
   touch (either bank of a river) count as joined; across a hex edge the regions must genuinely meet,
   which is the test that keeps a headland from inheriting the realm on the far side of a strait.
   Built once per colour and used twice — its connected components are the blocks, and the walk that
   becomes the spine runs along its edges. */
function realmGraph(cells) {
  const adj = new Map();
  for (const k of cells) adj.set(k, []);
  for (const k of cells) {
    const i = k.indexOf(':'), h = +k.slice(0, i), ri = +k.slice(i + 1);
    const out = adj.get(k);
    for (const [a, b] of regionAdj(h)) {
      if (a === ri && cells.has(h + ':' + b)) out.push(h + ':' + b);
      else if (b === ri && cells.has(h + ':' + a)) out.push(h + ':' + a);
    }
    for (const n of neighbors(h)) {
      if (!S.hexes[n] || S.hexes[n].t === 'N/A') continue;
      const nrs = regionsOf(n);
      for (let rj = 0; rj < nrs.length; rj++)
        if (cells.has(n + ':' + rj) && regionsMeet(h, ri, n, rj)) out.push(n + ':' + rj);
    }
  }
  return adj;
}
// The blocks: one array of keys per piece of the realm that can be walked around without a boat.
function realmBlocks(adj) {
  const seen = new Set(), out = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [start], block = [];
    while (stack.length) {
      const k = stack.pop();
      block.push(k);
      for (const n of adj.get(k)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    out.push(block);
  }
  return out;
}
/* How far each subhex of a block is from the block's own edge, in steps. 1 on the border, upward
   inland. This is what lets the spine prefer the middle: it is a cheap stand-in for distance to the
   boundary, and cheap is the point — the alternative is a real distance transform over the polygons.
   A piece counts as border if it does not have a piece of this block in all six directions, which
   catches the coast and the frontier with the same test and needs no idea of what lies beyond. */
function blockDepth(block, adj) {
  const inBlock = new Set(block);
  const depth = new Map();
  const q = [];
  for (const k of block) {
    const h = +k.slice(0, k.indexOf(':'));
    const around = new Set();
    for (const n of adj.get(k)) {
      const nh = +n.slice(0, n.indexOf(':'));
      if (nh !== h && inBlock.has(n)) around.add(nh);
    }
    if (around.size < 6) { depth.set(k, 1); q.push(k); }
  }
  if (!q.length) { for (const k of block) depth.set(k, 1); return depth; }
  for (let i = 0; i < q.length; i++) {
    const k = q[i], d = depth.get(k);
    for (const n of adj.get(k))
      if (inBlock.has(n) && !depth.has(n)) { depth.set(n, d + 1); q.push(n); }
  }
  for (const k of block) if (!depth.has(k)) depth.set(k, 1);
  return depth;
}
const cellPoint = k => {
  const i = k.indexOf(':'), h = +k.slice(0, i), r = regionsOf(h)[+k.slice(i + 1)];
  return r?.cent || hexCenter(h);
};
// How much ground a subhex actually is. A whole hex is a whole hex; a piece cut out by a coastline is
// worth its own polygon, islands included. This is what the axis is weighted by and what decides
// whether a block is big enough to be worth naming, both of which a count of pieces gets wrong.
const wholeHexArea = () => 3 * Math.sqrt(3) / 2 * S.G.hex_size ** 2;
function cellArea(r) {
  if (!r || !r.poly) return wholeHexArea();
  let a = Math.abs(polyArea(r.poly));
  for (const p of r.extra || []) if (p && p.length >= 3) a += Math.abs(polyArea(p));
  return a;
}
/* Which subhex a point on the map is over, answered against a set. This is how a baseline is trimmed
   to the ground it is supposed to be lying on: the same question the tooltip asks, put to a hundred
   points along a line instead of to one under the cursor. */
function pointInCells(cells, x, y) {
  const h = nearestHex(x, y);
  if (!h || !S.hexes[h] || S.hexes[h].t === 'N/A') return false;
  return cells.has(h + ':' + regionAt(h, [x, y]));
}

/* ---- polyline housekeeping ---- */

// Arc-length parameterisation of a polyline: total length, and the point at any distance along it.
function polyWalk(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const len = cum[cum.length - 1];
  const at = s => {
    if (!(len > 0)) return pts[0].slice();
    const t = Math.max(0, Math.min(len, s));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < t) i++;
    const f = (t - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-9);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
            pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
  };
  return { pts, cum, len, at };
}
function resample(pts, n) {
  const w = polyWalk(pts);
  if (!(w.len > 0)) return null;
  const out = [];
  for (let i = 0; i <= n; i++) out.push(w.at(w.len * i / n));
  return out;
}
function smoothAvg(pts, passes) {
  let out = pts;
  for (let p = 0; p < passes; p++) {
    const next = [out[0]];
    for (let i = 1; i < out.length - 1; i++)
      next.push([(out[i - 1][0] + 2 * out[i][0] + out[i + 1][0]) / 4,
                 (out[i - 1][1] + 2 * out[i][1] + out[i + 1][1]) / 4]);
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}
function smoothChaikin(pts, iters) {
  let out = pts;
  for (let it = 0; it < iters && out.length > 2; it++) {
    const next = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}
// Total absolute turn along a polyline. The test for a baseline that has curled up too far to write on.
function totalTurn(pts) {
  let turn = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const ax = pts[i][0] - pts[i - 1][0], ay = pts[i][1] - pts[i - 1][1];
    const bx = pts[i + 1][0] - pts[i][0], by = pts[i + 1][1] - pts[i][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    turn += Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
  }
  return turn;
}
/* A hard cap on how far a baseline may bow, applied to whichever algorithm produced it and expressed
   as **sag against span** — the deepest the line falls away from the chord joining its ends, over the
   length of that chord — because that is the ratio the eye is actually judging. It is not the same
   thing as the turn test above: a long gentle curve can turn a long way and read perfectly, while a
   short sharp one turns very little and reads as a name falling over. Small blocks are where this
   matters. Twelve subhexes of Blue Scarves gave a circle fit an almost circular arc to work with,
   quite correctly, and the name came out bent double round it.

   The correction squashes the whole line towards its own chord rather than clipping the middle out of
   it, so what comes back is the same shape more shallowly drawn, and still follows the country. */
function limitSag(pts, maxRatio) {
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  if (!(L > 1e-6)) return pts;
  const nx = -dy / L, ny = dx / L;
  let worst = 0;
  const off = pts.map(p => {
    const o = (p[0] - a[0]) * nx + (p[1] - a[1]) * ny;
    if (Math.abs(o) > worst) worst = Math.abs(o);
    return o;
  });
  const allow = L * maxRatio;
  if (worst <= allow || worst < 1e-9) return pts;
  const k = allow / worst - 1;
  return pts.map((p, i) => [p[0] + nx * off[i] * k, p[1] + ny * off[i] * k]);
}
/* Which way round to read it. A textPath sets glyphs from the start of the path onwards, standing them
   upright to it, so a baseline handed over running leftwards produces a name upside down and backwards.
   What decides it is therefore the **x** component and almost nothing else: any path with a net
   leftward drift is reversed, however steep it is. Only when the drift is genuinely vertical — under a
   fifth of the rise — does the sign of x stop meaning anything, and then the convention is the one a
   name on a map follows, top to bottom. */
function orientForReading(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const wrong = Math.abs(dx) > Math.abs(dy) * 0.2 ? dx < 0 : dy < 0;
  return wrong ? pts.slice().reverse() : pts;
}
// Reach past each end along the end's own direction, so the trim has coast to find: a walk between
// subhex centres stops half a hex short of the shore at both ends.
function extendEnds(pts, by) {
  const out = pts.slice();
  const dir = (p, q) => { const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };
  const d0 = dir(out[1] ?? out[0], out[0]), d1 = dir(out[out.length - 2] ?? out[out.length - 1], out[out.length - 1]);
  out.unshift([out[0][0] + d0[0] * by, out[0][1] + d0[1] * by]);
  out.push([out[out.length - 1][0] + d1[0] * by, out[out.length - 1][1] + d1[1] * by]);
  return out;
}
// Two lines, resampled alike and interpolated. This is what `smoothMix` moves along: 1 takes the fit
// whole, 0 takes the raw walk, and between the two the fit is pulled back towards the walk — which is
// how a curve smooth enough to write on can be kept honest about a bottleneck it wants to cut across.
function mixLines(a, b, t, n) {
  const A = resample(a, n), B = resample(b, n);
  if (!A || !B) return A || B;
  return A.map((p, i) => [p[0] + (B[i][0] - p[0]) * t, p[1] + (B[i][1] - p[1]) * t]);
}
// Gaussian elimination with partial pivoting, for the small dense normal equations below. Returns null
// rather than nonsense if the system is singular, which happens when every point is in one place.
function solveSym(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    if (Math.abs(A[piv][i]) < 1e-12) return null;
    [A[i], A[piv]] = [A[piv], A[i]];
    [b[i], b[piv]] = [b[piv], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      if (!f) continue;
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let acc = b[i];
    for (let c = i + 1; c < n; c++) acc -= A[i][c] * x[c];
    x[i] = acc / A[i][i];
  }
  return x;
}
/* A low-order fit through a polyline, parameterised by **distance along it**. That parameter is the
   whole trick: fitting one coordinate against another is a parabola again and cannot describe a shape
   that doubles back, which is exactly what a spine through a bottleneck often is. Fitting x(s) and
   y(s) separately has no such limit — the curve may hook or fork back as the ground does — while a
   cubic in each simply has nowhere to put a ripple. */
function fitPolyPath(pts, deg, n) {
  const w = polyWalk(pts);
  if (!(w.len > 0)) return null;
  deg = Math.max(1, Math.min(deg, pts.length - 1));
  const s = w.cum.map(c => c / w.len);
  const m = deg + 1;
  const A = Array.from({ length: m }, () => new Float64Array(m));
  const bx = new Float64Array(m), by = new Float64Array(m);
  for (let k = 0; k < pts.length; k++) {
    const pow = [1];
    for (let j = 1; j < m; j++) pow.push(pow[j - 1] * s[k]);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) A[i][j] += pow[i] * pow[j];
      bx[i] += pow[i] * pts[k][0];
      by[i] += pow[i] * pts[k][1];
    }
  }
  const cx = solveSym(A.map(r => Array.from(r)), Array.from(bx));
  const cy = solveSym(A.map(r => Array.from(r)), Array.from(by));
  if (!cx || !cy) return null;
  const ev = (co, t) => { let v = 0, p = 1; for (let i = 0; i < m; i++) { v += co[i] * p; p *= t; } return v; };
  const out = [];
  for (let i = 0; i <= n; i++) { const t = i / n; out.push([ev(cx, t), ev(cy, t)]); }
  return out;
}
/* A circle through a cloud of points, by the algebraic (Kåsa) fit: x²+y² = Ax + By + C is linear in
   A, B, C, and the centre and radius fall straight out of them. Not the geometrically optimal circle —
   that needs iteration — but the difference is invisible at a hundredth of the radius, and this one
   cannot fail to converge because it does not converge, it solves.

   The arc wanted from it is then the stretch that spans the points, found by taking each point's
   bearing from the centre **relative to the mean bearing** rather than absolutely. That detour matters:
   bearings are angles, angles wrap, and the min and max of a set that straddles due west are the two
   points either side of the seam rather than the two ends of the arc. */
function circleArcThrough(pts, wts, n) {
  const m = 3;
  const A = Array.from({ length: m }, () => new Float64Array(m));
  const rhs = new Float64Array(m);
  let W = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i], w = wts ? wts[i] : 1;
    const row = [x, y, 1], v = x * x + y * y;
    W += w;
    for (let a = 0; a < m; a++) {
      for (let b = 0; b < m; b++) A[a][b] += w * row[a] * row[b];
      rhs[a] += w * row[a] * v;
    }
  }
  if (W <= 0) return null;
  const sol = solveSym(A.map(r => Array.from(r)), Array.from(rhs));
  if (!sol) return null;
  const cx = sol[0] / 2, cy = sol[1] / 2;
  const r2 = sol[2] + cx * cx + cy * cy;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  // A radius far larger than the map is a straight line wearing a circle's clothes, and asking for
  // bearings about a centre ten thousand hexes away is asking for rounding noise. Say so instead.
  if (!isFinite(r) || r > S.G.image_width * 40) return null;
  return arcAbout([cx, cy], r, pts, n);
}
/* The arc of a given circle that spans a set of points. Used by the fitted circle above and by the
   shared-origin arcs below, which differ only in where the centre comes from. */
function arcAbout(c, r, pts, n) {
  let sx = 0, sy = 0;
  for (const p of pts) {
    const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
    sx += Math.cos(a); sy += Math.sin(a);
  }
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) return null;   // points ringed evenly: no arc
  const mid = Math.atan2(sy, sx);
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    let d = Math.atan2(p[1] - c[1], p[0] - c[0]) - mid;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  if (!(hi > lo)) return null;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = mid + lo + (hi - lo) * i / n;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}
/* One centre for the whole map, a long way outside it, and every label an arc about that centre. The
   labels then all bow the same way and by an amount that depends only on where on the map they are —
   which is what a graticule does, and what makes an atlas page read as a piece of a globe rather than
   as a flat sheet with words on it. It says nothing at all about the shape of any individual country,
   which is either the point or the objection depending on the map you want. */
function sharedOrigin() {
  const a = RN.originDeg * Math.PI / 180;
  const cx = S.G.image_width / 2, cy = S.G.image_height / 2;
  const d = S.G.image_height * RN.originDist;
  return [cx + Math.cos(a) * d, cy + Math.sin(a) * d];
}

/* ---- the axis, and the baselines built on it ---- */

/* The block's principal axis, and a parabola about it. The axis is wanted whichever baseline is in
   use: it is how the two **ends** of the country are chosen, being the subhexes where the ground runs
   out along the direction the country lies in. */
function fitRealmCurve(pts, wts) {
  let W = 0, mx = 0, my = 0;
  for (let i = 0; i < pts.length; i++) { W += wts[i]; mx += pts[i][0] * wts[i]; my += pts[i][1] * wts[i]; }
  mx /= W; my /= W;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - mx, dy = pts[i][1] - my, w = wts[i];
    sxx += w * dx * dx; sxy += w * dx * dy; syy += w * dy * dy;
  }
  sxx /= W; sxy /= W; syy /= W;
  // Eigenvalues of the 2×2 covariance: the spread along the long axis and along the short one. Their
  // ratio is how elongated the block is, and so whether it has a long direction at all.
  const tr = sxx + syy, det = Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy);
  const l1 = (tr + det) / 2, l2 = Math.max((tr - det) / 2, 1e-9);
  let ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  if (Math.sqrt(l1 / l2) < RN.roundRatio) ang = 0;        // round enough that the axis is noise
  // atan2 halved already lands in (−π/2, π/2], so u always increases with x.
  const tilt = RN.tiltMax * Math.PI / 180;
  ang = Math.max(-tilt, Math.min(tilt, ang));
  const cs = Math.cos(ang), sn = Math.sin(ang);
  const ex = [cs, sn], ey = [-sn, cs];
  const us = [], vs = [];
  let umin = Infinity, umax = -Infinity;
  for (const p of pts) {
    const dx = p[0] - mx, dy = p[1] - my;
    const u = dx * ex[0] + dy * ex[1], v = dx * ey[0] + dy * ey[1];
    us.push(u); vs.push(v);
    if (u < umin) umin = u;
    if (u > umax) umax = u;
  }
  // Weighted least squares for v = a·u² + b·u + c. Under six pieces there is not enough to see a bend
  // in and the fit would be describing the sampling rather than the country, so the quadratic term is
  // not asked for; under three, neither is the slope.
  let a = 0, b = 0, c = 0;
  const deg = pts.length >= 6 ? 2 : pts.length >= 3 ? 1 : 0;
  if (deg >= 1) {
    const m = deg + 1;
    const M = Array.from({ length: m }, () => new Float64Array(m));
    const rhs = new Float64Array(m);
    for (let i = 0; i < us.length; i++) {
      const pow = [1];
      for (let j = 1; j < m; j++) pow.push(pow[j - 1] * us[i]);
      for (let r = 0; r < m; r++) {
        for (let cc = 0; cc < m; cc++) M[r][cc] += wts[i] * pow[r] * pow[cc];
        rhs[r] += wts[i] * pow[r] * vs[i];
      }
    }
    const sol = solveSym(M.map(r => Array.from(r)), Array.from(rhs));
    if (sol) { c = sol[0]; b = sol[1] || 0; a = sol[2] || 0; }
  }
  return { mx, my, ex, ey, a, b, c, umin, umax };
}
// The straight line along the axis: the plainest baseline there is, and the one to compare the rest
// against — if a curve is not visibly better than this it is not worth the arithmetic.
function axisLine(f, n) {
  const pad = S.G.hex_size;
  const u0 = f.umin - pad, u1 = f.umax + pad, out = [];
  for (let i = 0; i <= n; i++) {
    const u = u0 + (u1 - u0) * i / n;
    out.push([f.mx + u * f.ex[0] + f.c * f.ey[0], f.my + u * f.ex[1] + f.c * f.ey[1]]);
  }
  return out;
}
// The parabola as a polyline, so the one measuring-and-setting path serves every baseline alike.
function parabolaPoints(f, n) {
  const pad = S.G.hex_size;
  const u0 = f.umin - pad, u1 = f.umax + pad, out = [];
  for (let i = 0; i <= n; i++) {
    const u = u0 + (u1 - u0) * i / n, v = f.a * u * u + f.b * u + f.c;
    out.push([f.mx + u * f.ex[0] + v * f.ey[0], f.my + u * f.ex[1] + v * f.ey[1]]);
  }
  return out;
}
/* The spine: the cheapest walk from one end of the block to the other, where cheap means short and
   away from the edges. Dijkstra rather than breadth-first, because the two costs are not commensurate
   in hops — a step is priced by the distance it covers and then marked up by how exposed it lands, so
   a detour of one subhex to stay inland is worth taking and a detour of five is not. At a neck there
   is no detour to be had and the walk simply goes through, which is what makes this work where a
   fitted curve cannot: **a walk through the block cannot leave the block.**

   Endpoints along the principal axis rather than by graph diameter. Graph-farthest sounds right and is
   wrong for a broad country: the two ends of the longest walk across a wide block are opposite
   *corners*, so the empire's name came out set on the diagonal. */
function blockSpine(block, adj, f) {
  if (block.length < 2) return null;
  const depth = blockDepth(block, adj);
  let maxD = 1;
  for (const d of depth.values()) if (d > maxD) maxD = d;
  let A = null, B = null, uA = Infinity, uB = -Infinity;
  for (const k of block) {
    const p = cellPoint(k);
    const u = (p[0] - f.mx) * f.ex[0] + (p[1] - f.my) * f.ex[1];
    if (u < uA) { uA = u; A = k; }
    if (u > uB) { uB = u; B = k; }
  }
  if (A === B) return null;
  const cost = new Map([[A, 0]]), from = new Map();
  // A plain set used as the frontier. A block is at most a few hundred subhexes, so scanning it for
  // the cheapest is faster than maintaining a heap and very much easier to be sure of.
  const open = new Set([A]), done = new Set();
  while (open.size) {
    let k = null, best = Infinity;
    for (const x of open) { const c = cost.get(x); if (c < best) { best = c; k = x; } }
    open.delete(k); done.add(k);
    if (k === B) break;
    const p = cellPoint(k);
    for (const n of adj.get(k)) {
      if (done.has(n)) continue;
      const q = cellPoint(n);
      // Marked up by exposure: 1 at the deepest interior the block has, 1 + pull on the border.
      const exposure = 1 + RN.pull * (1 - (depth.get(n) - 1) / Math.max(maxD - 1, 1));
      const c = best + Math.hypot(q[0] - p[0], q[1] - p[1]) * exposure;
      if (c < (cost.get(n) ?? Infinity)) { cost.set(n, c); from.set(n, k); open.add(n); }
    }
  }
  if (!cost.has(B)) return null;
  const walk = [B];
  while (walk[0] !== A) { const p = from.get(walk[0]); if (!p) return null; walk.unshift(p); }
  return walk.map(cellPoint);
}

/* The baselines, in the order the panel lists them. Each is handed the block's geometry and returns a
   polyline to write along, or null if it has nothing to say about this shape. They are genuinely
   different opinions rather than refinements of one another, which is why they are a list: a parabola
   describes a lobe well and a country badly, a raw spine describes the country exactly and reads as a
   wobble, and an arc describes neither but looks like an atlas. */
const RN_ALGOS = [
  { id: 'axis', name: 'Straight — principal axis',
    fn: c => axisLine(c.f, 48) },
  { id: 'parabola', name: 'Parabola on the axis',
    fn: c => parabolaPoints(c.f, 48) },
  { id: 'arcFit', name: 'Best-fitting circular arc',
    fn: c => circleArcThrough(c.pts, c.wts, 48) },
  { id: 'arcShared', name: 'Shared-origin arcs (graticule)',
    fn: c => { const o = sharedOrigin();
               const r = Math.hypot(c.f.mx - o[0], c.f.my - o[1]);
               return arcAbout(o, r, c.pts, 48); } },
  { id: 'spineRaw', name: 'Spine — raw walk',
    fn: c => c.spine },
  { id: 'spineSmooth', name: 'Spine — averaged & rounded',
    fn: c => c.spine && smoothChaikin(smoothAvg(c.spine, RN.avgPasses), RN.chaikin) },
  { id: 'spineFit', name: 'Spine — polynomial fit',
    fn: c => { if (!c.spine) return null;
               const fit = fitPolyPath(c.spine, RN.polyDeg, 48);
               return fit ? mixLines(c.spine, fit, RN.smoothMix, 48) : null; } },
  { id: 'spineArc', name: 'Spine — circular arc through it',
    fn: c => c.spine && circleArcThrough(c.spine, null, 48) },
];
const rnAlgo = () => RN_ALGOS.find(a => a.id === RN.algo) || RN_ALGOS.find(a => a.id === 'spineFit');

/* ---- setting a name along a baseline ---- */

/* Everything above finds a line. This is the part that decides whether there is room for a name on it
   at all, and how big and how spread out it should be to fill the room there is. It is deliberately
   ignorant of which algorithm produced the line: by the time anything reaches here it is just a line
   through some ground, which is what lets the baselines be swapped freely. */
function setNameAlong(baseline, cells, name, area, capFs) {
  let line = resample(limitSag(baseline, RN.sagMax), 64);
  if (!line) return null;
  line = orientForReading(resample(extendEnds(line, S.G.hex_size), 64));
  const w = polyWalk(line);
  if (!(w.len > 1)) return null;
  /* Trimmed to the ground: walked end to end, asking at each of a hundred steps which subhex it is
     over, and cut back to the longest run that stays inside the block.

     With a **tolerance**, which is what lets a name cross a bottleneck. A smoothed line through a
     country pinched to one hex wide will cut the corner and step outside for a sample or two before
     coming back in; judged strictly, that ends the run, and the empire's name was cut back to whichever
     lobe it started in while the other went unnamed. A gap of a step or two is the smoothing showing,
     not the country ending, and the letters standing over it have a halo. A gap of ten is the sea. */
  const N = 100, step = w.len / N;
  const inside = [];
  for (let i = 0; i <= N; i++) { const p = w.at(i * step); inside.push(pointInCells(cells, p[0], p[1])); }
  let bestS = -1, bestE = -1, curS = -1, gap = 0;
  for (let i = 0; i <= N; i++) {
    if (inside[i]) {
      if (curS < 0) curS = i;
      gap = 0;
      if (i - curS > bestE - bestS) { bestS = curS; bestE = i; }
    } else if (curS >= 0 && ++gap > RN.gapTol) { curS = -1; gap = 0; }
  }
  if (bestS < 0 || bestE <= bestS) return null;    // the line never lies on its own country
  const s0 = bestS * step, s1 = bestE * step;
  const run = resample([w.at(s0), ...w.pts.filter((p, i) => w.cum[i] > s0 && w.cum[i] < s1), w.at(s1)], 40);
  if (!run) return null;
  const iw = polyWalk(run);
  /* How thick the country is under the line, sampled the whole way along rather than at a handful of
     places in the middle. Stepped out along the local **normal** and stopped at the first step that
     leaves the block, both ways. A profile rather than a number, because the two things it is wanted
     for are different questions: how big the letters can be is about the *typical* thickness, and where
     the name may start and stop is about the thickness *at those points*. */
  const probe = S.G.hex_size * 0.3, LIM = 14, K = 24, prof = [];
  for (let i = 0; i <= K; i++) {
    const s = iw.len * i / K;
    const [px, py] = iw.at(s);
    const a = iw.at(Math.max(0, s - probe)), b = iw.at(Math.min(iw.len, s + probe));
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / tl, ny = (b[0] - a[0]) / tl;
    let t = 0;
    for (const dir of [1, -1])
      for (let k = 1; k <= LIM; k++) {
        if (!pointInCells(cells, px + nx * dir * probe * k, py + ny * dir * probe * k)) break;
        t += probe;
      }
    prof.push(t + probe);   // the step the line itself is standing on counts
  }
  const NAME = name.toUpperCase();
  const nat = realmTextW(NAME, 100) / 100;         // natural advance at font-size 1
  /* Size and extent, settled together, because each is the other's constraint.

     A country **tapers**, and the run the trim handed back reaches into the point of the taper: the
     centreline is inside the country right to the tip, but the letters standing at the tip are a whole
     font size tall and there is no country left to hold them. Legion V's name ran down a spit and
     dropped its last letter into the sea for exactly this reason. So the ends are cut back to where the
     ground is thick enough to stand a capital in — which cannot be done before the size is known, and
     the size depends on how much run is left after cutting. Three passes, shrinking only, so it settles
     rather than oscillating.

     The typical thickness is taken at a **percentile** of what is left rather than at the median: a
     name has to fit the narrow places it crosses, not the average of narrow and wide. */
  let lo = 0, hi = K, fs = 0, usable = 0;
  for (let pass = 0; pass < 3; pass++) {
    const arc = iw.len * (hi - lo) / K;
    const seg = prof.slice(lo, hi + 1).sort((p, q) => p - q);
    const thick = seg[Math.min(seg.length - 1, Math.floor(seg.length * RN.thickPct))];
    // `capFs` is the placement pass asking for this name smaller than it would like, so it can fit
    // beside something already placed rather than be dropped. See renderRealmNames.
    const size = room => Math.min(room / Math.max(nat, 0.01), thick * RN.thickFrac, RN.fsMax, capFs ?? Infinity);
    usable = arc * 0.9;
    for (let q = 0; q < 2; q++) usable = Math.min(arc * 0.9, arc - size(usable) * RN.endInset);
    fs = size(usable);
    const need = fs * RN.taperNeed;
    let nlo = lo, nhi = hi;
    while (nlo < nhi && prof[nlo] < need) nlo++;
    while (nhi > nlo && prof[nhi] < need) nhi--;
    if (nhi - nlo < 3) break;                      // nowhere on this line is thick enough; keep what we had
    if (nlo === lo && nhi === hi) break;           // settled
    lo = nlo; hi = nhi;
  }
  if (fs < RN.fsMin) return null;                  // too small to read; better nothing than a smudge
  const glyphs = Math.max(NAME.length - 1, 1);
  const ls = Math.max(0, Math.min((usable - fs * nat) / glyphs, fs * RN.trackMax));
  const total = fs * nat + ls * glyphs;
  // The surviving stretch is the path the name is set on, so the start offset is measured against the
  // same line the letters will walk — not against the untrimmed run they no longer use.
  const final = resample([iw.at(iw.len * lo / K),
                          ...iw.pts.filter((p, i) => iw.cum[i] > iw.len * lo / K && iw.cum[i] < iw.len * hi / K),
                          iw.at(iw.len * hi / K)], 40);
  if (!final) return null;
  const fw = polyWalk(final);
  /* Where the ink actually falls, as a chain of points down the middle of the lettering, for the
     overlap pass. Only the stretch the ink covers is walked, since the name is centred and the trimmed
     ends are usually bare.

     A chain rather than a rectangle. It was a rectangle, and a rectangle is close enough for a level
     label and hopeless for a slanted one: the bounding box of a name set on a diagonal is mostly the
     two corners it does not touch, so a long diagonal claimed a quarter of the map and every small
     realm anywhere near it lost its name to a collision that was not happening. What a label occupies
     is a *ribbon* along its baseline, and a run of points down that ribbon describes it well enough. */
  const ink = [];
  for (let i = 0; i <= 14; i++) ink.push(fw.at((fw.len - total) / 2 + total * i / 14));
  return { d: smoothPathD(final), fs, ls, total, arc: fw.len, area, text: NAME, ink };
}
// A smooth SVG path through a polyline, Catmull-Rom converted to cubics. The points are already evenly
// spaced and already smoothed; this is only so the joins between them do not show under 40px letters.
function smoothPathD(pts) {
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}
/* Do two labels touch? Their ribbons are compared point against point: a hit is any pair closer than
   the two half-heights added together, which is the distance at which a capital of one would be
   sitting on a capital of the other.

   Labels from **different layers** are allowed closer than labels from the same one. On one layer two
   names near each other is a genuine ambiguity about who holds the ground between them; across the pair
   it is not, because the two are answering different questions about the same ground — who holds it by
   right, and who is sitting on it now — and a reader looking at both at once is expecting them to be
   layered. Room enough not to overlap is all that is wanted there. */
function labelsCollide(a, b) {
  const near = (a.fs + b.fs) * (a.layer === b.layer ? RN.collide : RN.collideCross);
  const n2 = near * near;
  for (const p of a.ink) for (const q of b.ink) {
    const dx = p[0] - q[0], dy = p[1] - q[1];
    if (dx * dx + dy * dy < n2) return true;
  }
  return false;
}
/* One block, one name. The chosen baseline first, then the plainer ones as fallbacks — because an
   algorithm returning nothing for an awkward shape is a normal event, not an error, and the answer to
   it is a duller line rather than no name. */
function fitRealmLabel(block, adj, name) {
  const cells = new Set(block);
  const pts = [], wts = [];
  for (const k of block) {
    const i = k.indexOf(':'), h = +k.slice(0, i);
    pts.push(cellPoint(k));
    wts.push(cellArea(regionsOf(h)[+k.slice(i + 1)]));
  }
  const area = wts.reduce((s, x) => s + x, 0);
  const f = fitRealmCurve(pts, wts);
  const ctx = { block, adj, cells, pts, wts, f, spine: blockSpine(block, adj, f) };
  const turnMax = RN.turnMax * Math.PI / 180;
  const chosen = rnAlgo();
  // The fallback chain never repeats the chosen one and never leaves the parabola out: whatever else
  // fails, a country has an axis and a bend about it.
  for (const algo of [chosen, ...RN_ALGOS.filter(a => a.id === 'parabola' || a.id === 'axis')]) {
    let line;
    try { line = algo.fn(ctx); } catch { line = null; }
    if (!line || line.length < 2) continue;
    // A baseline that turns this far is a shape no word fits, rather than a wobble to be smoothed away.
    if (totalTurn(line) > turnMax) continue;
    const lab = setNameAlong(line, cells, name, area);
    // The baseline is kept with the label so the placement pass can ask for the same name again
    // smaller, which is how a label that loses a collision yields size instead of existence.
    if (lab) { lab.algo = algo.id; lab.line = line; lab.cells = cells; lab.name = name; return lab; }
  }
  return null;
}

/* Every named realm on a layer, laid across its ground. Only *named* ones: the Warlords scan ships a
   legend and the Borders scan does not, so most of the Borders palette has never been anything but a
   hex code, and writing "#DA85FF" across half the empire is not a label. Name a colour in the Realm
   tool and it appears here — which makes this switch a reading of the same names the swatches and the
   tooltip give, rather than a third place they could disagree. */
let nameSeq = 0;   // ids for the curves the labels ride on; unique across rebuilds, never reused
let rnLastStats = null;   // what the last fit did, for the panel to report
// Which layer keeps a name when the two of them make the same one and it comes to a tie. Warlords is
// the upper layer and the one whose scan the shared legend belongs to, so it goes first.
// Who keeps a name when two layers want to write the same one in the same place. The commanderies go
// last: a province named for its seat and a realm named the same thing are the same word about the
// same ground, and of the two the realm is the larger claim.
const RN_LAYER_ORDER = ['warlords', 'borders', 'comm'];
/* The three layers that paint ground, in the order they are stacked — bottom first. Only these can
   bury one another, and only in this direction. */
const REALM_STACK = ['borders', 'comm', 'warlords'];
/* The cells this layer is painting but nobody can see, because a layer above it is on and painting
   the same ground. A name belongs on ground that is showing the colour it names: a commandery lying
   wholly under a warlord's wash was still having its name written across him, which says the ground
   is one province's while every pixel of it says otherwise. Partly covered, the name is refitted to
   what is left — the label pass takes a set of cells and asks no questions about where they came
   from, so cutting the set is the whole of it — and where too little is left to write on legibly,
   the fitting declines and there is no label, which is the right answer for a province with nothing
   of itself in view.

   Visibility only, not opacity. A wash dimmed to a quarter is still that layer's answer showing
   through, and reading a threshold off the slider would refit sixty times a second while it was
   being dragged. */
function realmCovered(id) {
  const i = REALM_STACK.indexOf(id);
  if (i < 0) return null;
  const out = new Set();
  for (const above of REALM_STACK.slice(i + 1)) {
    if (groups[above]?.style.display === 'none') continue;
    for (const k of realmCols.get(above)?.keys() || []) out.add(k);
  }
  return out.size ? out : null;
}
/* Every label one layer *wants*, fitted but not yet placed. Placement is a separate pass because it is
   not a per-layer question — see renderRealmNames below.

   Grouped by **name**, not by colour, and that is the whole mechanism for a federation. Several washes
   given the same name are one polity here: their subhexes go into one set, contiguity is worked out over
   the union, and what comes back is a single name laid across the whole of it rather than one copy per
   member. A confederation whose members each have their own colour on the scan — as a scan of *who
   holds what* quite properly draws them — reads as the one thing it is.

   Grouping by the name rather than by some separate notion of a group is deliberate. Naming is already
   the mechanism: it is stored per layer and per colour, it exports and imports and undoes with the rest
   of the hand-drawn work, and the palette already renames by double-click. So there is nothing to
   invent and nothing new to keep in step — call three washes "The Lasiŕos Federation" and they are one.
   The tooltip goes on answering with the federation's name over any of its members, which is the right
   answer to "who holds this", and the palette keeps the three swatches separate, which is the right
   answer to "what can I paint with". */
function realmLabelCandidates(id) {
  const cols = realmCols.get(id);
  if (!cols) return [];
  const buried = realmCovered(id);
  const byName = new Map();   // name -> { cells: Set, colour: Map(cell -> the wash it came from) }
  for (const [k, c] of cols) {
    if (buried?.has(k)) continue;                  // ground this layer is no longer showing on
    const name = realmName(id, c);
    if (!name) continue;                           // unnamed washes have nothing to write
    let g = byName.get(name);
    if (!g) byName.set(name, g = { cells: new Set(), colour: new Map() });
    g.cells.add(k);
    g.colour.set(k, c);
  }
  const hexA = wholeHexArea(), out = [];
  for (const [name, g] of byName) {
    const adj = realmGraph(g.cells);
    const labels = [];
    for (const block of realmBlocks(adj)) {
      const lab = fitRealmLabel(block, adj, name);
      if (!lab) continue;
      /* Which colour to ink it in, for the treatment that inks a name in its realm's own colour: the
         member wash holding most of *this block*. Per block rather than per federation, because the
         point of a federation is that its parts are elsewhere — a name on one member's ground drawn in
         another member's colour would be pointing at the wrong place. */
      const share = new Map();
      for (const k of block) {
        const c = g.colour.get(k), i = k.indexOf(':');
        share.set(c, (share.get(c) || 0) + cellArea(regionsOf(+k.slice(0, i))[+k.slice(i + 1)]));
      }
      let best = null, ba = -1;
      for (const [c, a] of share) if (a > ba) { ba = a; best = c; }
      lab.c = best; lab.layer = id;
      labels.push(lab);
    }
    if (!labels.length) continue;
    // A realm gets its name on each piece of itself, but not on every scrap: without the fraction a
    // large realm has its name written again on every coastal fragment it owns, and without the floor a
    // realm that is *entirely* fragments ends up with no name at all.
    labels.sort((p, q) => q.area - p.area);
    const big = labels[0].area;
    for (const lab of labels.slice(0, Math.max(1, RN.blocksMax)))
      if (lab === labels[0] || (lab.area >= big * RN.blockFrac && lab.area >= hexA * RN.blockMinHex))
        out.push(lab);
  }
  return out;
}
/* Both layers' names, fitted and then placed **together**.

   Placement cannot be a per-layer question, and treating it as one produced two visible faults as soon
   as Borders and Warlords were switched on at once. Each layer laid out its own names in ignorance of
   the other's, so a legion's name and the name of the imperial ground it sits on were written across
   each other; and the Blue Scarves, who appear on *both* maps — being nobody's subject, they keep their
   own colour on the Borders map instead of being coloured in as the empire's — had their name written
   twice in the same place, once from each layer.

   So the candidates from every visible name group go into one pool, and one pass places them. Two rules
   come out of that:

   - **They respect each other as if they were one layer.** One collision list, so a warlord's name and
     a realm's name give way to each other exactly as two realms on one layer do, largest first.
   - **A name is written once.** If the same name has already been placed *from another layer*, this
     copy is dropped. Only from another layer: within one layer a realm may quite properly have its name
     on several separate pieces of itself, which is what `blocksMax` is about.

   Which layer keeps it is settled by size first and by RN_LAYER_ORDER on a tie — and a tie is the usual
   case here, since a colour on both maps is the same colour over the same ground and its blocks come out
   identical. Each label is still drawn into *its own* layer's group, so it goes on appearing and
   disappearing with that layer's switch. */
function renderRealmNames() {
  for (const id in realmNameG) realmNameG[id].innerHTML = '';
  if (!S.adj) return;
  const t0 = performance.now();
  const shown = [...RN_LAYER_ORDER, ...Object.keys(realmNameG).filter(id => !RN_LAYER_ORDER.includes(id))]
    .filter(id => realmNameG[id] && realmNameG[id].style.display !== 'none');
  const cand = [];
  for (const id of shown) cand.push(...realmLabelCandidates(id));
  /* The order candidates are offered in is the order they win in, and across the two layers that is a
     choice rather than a fact. Sorting the pool purely by area — the obvious thing, and what was done
     first — hands the map to Borders, whose pale imperial wash is the largest thing on it by a wide
     margin: its name is set across three hundred hexes and crosses half the legions on the way, and
     four legion names disappeared under it. Which is exactly backwards for a reader who has just
     switched Warlords on. With both layers up, the paint you can *see* inside a legion's territory is
     the legion's — Warlords is drawn over Borders and leaves the realm beneath showing only where no
     warlord has taken it — so the name that survives there should be the legion's too, whatever the
     relative size of the two countries. The name should match the paint.

     Hence a precedence rather than a size contest, `RN.crossRule` deciding it: the upper layer first by
     default, or the lower, or the old largest-wins. Within a layer it is always area order. */
  const layerRank = id => RN_LAYER_ORDER.indexOf(id);
  const rule = RN.crossRule;
  cand.sort((p, q) => {
    if (p.layer !== q.layer && rule !== 'area')
      return (rule === 'lower' ? -1 : 1) * (layerRank(p.layer) - layerRank(q.layer));
    return q.area - p.area || layerRank(p.layer) - layerRank(q.layer);
  });
  const face = realmFace(), ink = realmInk();
  const placed = [], byAlgo = {}, drawn = {}, byName = new Map();
  let hit = 0, dup = 0, shrunk = 0;
  for (const lab0 of cand) {
    const already = byName.get(lab0.text);
    if (already && already !== lab0.layer) { dup++; continue; }   // the other layer has said it
    /* A label that loses a collision is offered the chance to be **smaller** before it is dropped. It
       is a better answer than either alternative: dropping it loses the name outright, and nudging it
       aside moves it off its own ground onto somebody else's. Smaller keeps it where it belongs and
       says something true about the relation — the crowded name is the lesser claim on that ground.
       Two steps down, because a name at a third of the size it wanted is not the map's problem any
       more, it is unreadable. */
    let lab = lab0;
    let clash = placed.some(other => labelsCollide(lab, other));
    for (const shrink of [0.7, 0.48]) {
      if (!clash) break;
      const alt = setNameAlong(lab0.line, lab0.cells, lab0.name, lab0.area, lab0.fs * shrink);
      if (!alt) break;
      Object.assign(alt, { algo: lab0.algo, line: lab0.line, cells: lab0.cells,
                           name: lab0.name, layer: lab0.layer, c: lab0.c });
      lab = alt;
      clash = placed.some(other => labelsCollide(lab, other));
      if (!clash) shrunk++;
    }
    if (clash) { hit++; continue; }
    placed.push(lab);
    byName.set(lab.text, lab.layer);
    byAlgo[lab.algo] = (byAlgo[lab.algo] || 0) + 1;
    drawn[lab.layer] = (drawn[lab.layer] || 0) + 1;
    const g = realmNameG[lab.layer];
    const pid = 'rn_' + lab.layer + '_' + (nameSeq++);   // a serial: a textPath must name its path
    const path = el('path', { id: pid, d: lab.d, fill: 'none', stroke: 'none' }, g);
    /* Ink and halo, both **opaque**. The halo is scaled with the font so it stays a rim at every size
       instead of swallowing small labels and vanishing on large ones, and `paint-order: stroke` is
       what puts it behind the fill rather than across it. */
    const t = el('text', {
      'font-family': face.family, 'font-weight': face.weight, 'font-size': lab.fs.toFixed(2),
      'letter-spacing': lab.ls.toFixed(2),
      fill: ink.realm ? darkenRgb(lab.c, 0.42) : ink.fill,
      stroke: ink.stroke, 'stroke-width': (lab.fs * ink.sw).toFixed(2),
      'paint-order': 'stroke', 'stroke-linejoin': 'round', 'pointer-events': 'none',
    }, g);
    const tp = el('textPath', { href: '#' + pid, startOffset: 0 }, t);
    tp.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#' + pid);  // older renderers
    tp.textContent = lab.text;
    /* Centred by hand rather than with text-anchor. Letter-spacing is added *after* every character
       including the last, so the advance the renderer centres is half a gap wider than the word
       actually is, and a heavily tracked name comes out visibly left of where it should be. Placing
       the start explicitly at half the slack sidesteps it. The path's own length is asked for in
       preference to the sampled one — same curve, but it is the renderer's own arithmetic that will
       be walking the glyphs along it. */
    let len = lab.arc;
    try { const L = path.getTotalLength(); if (L > 0) len = L; } catch {}
    tp.setAttribute('startOffset', Math.max(0, (len - lab.total) / 2).toFixed(1));
  }
  rnLastStats = { layers: shown, drawn, ms: +(performance.now() - t0).toFixed(1),
                  total: placed.length, hit, dup, shrunk, byAlgo };
  updateRnReport();
}
// A realm's own colour, taken down far enough to be ink. Multiplying rather than mixing towards black
// keeps the hue: a washed-out lilac darkens to a lilac, not to a grey.
function darkenRgb(c, k) {
  return 'rgb(' + String(c).split(',').map(n => Math.round(+n * k)).join(',') + ')';
}
// One entry point, since the pass is joint: whatever changed, both groups are rebuilt from scratch.
// Every control on the panel, every repaint and every switch ends here.
const refitRealmNames = renderRealmNames;
/* A web face is fetched the first time it is picked and never otherwise, so a reader of the published
   map requests nothing. Waited for rather than merely asked for: the widths are measured on a canvas,
   and a canvas measuring a font that has not arrived silently measures the fallback. */
const realmFontsAsked = new Set();
async function loadRealmWebFont(f) {
  if (!f?.web) return;
  if (!realmFontsAsked.has(f.web)) {
    realmFontsAsked.add(f.web);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${f.web}&display=swap`;
    document.head.appendChild(link);
  }
  const family = f.family.split(',')[0].replace(/"/g, '').trim();
  try { await document.fonts.load(`${f.weight} 40px "${family}"`); await document.fonts.ready; } catch {}
}

/* ---- the tuning panel (local only) ----
   Which baseline is right, and what every threshold in the fitting should be, are not questions this
   file can answer by reasoning. They are answered by looking at a real map with real names on it and
   changing one number at a time. So the panel exists, it is built from the table below rather than
   from markup — one row per knob, so adding a knob is adding a line — and it is dropped entirely from
   the published build along with the stored choices, where a reader's own tuning would mean two people
   seeing two different maps. */
const RN_FIELDS = [
  { group: 'Baseline' },
  { k: 'algo', label: 'Algorithm', opts: () => RN_ALGOS, wide: true },
  { k: 'sagMax', label: 'Max bend', min: 0, max: 0.6, step: 0.01,
    hint: 'Hard cap on how far any baseline may bow, whatever it asked for. Small blocks are where this bites.' },
  { k: 'gapTol', label: 'Bottleneck steps', min: 0, max: 12, step: 1,
    hint: 'How many steps outside the country the trim will step over rather than end the name. This is what carries a name through a one-hex neck.' },
  { k: 'turnMax', label: 'Max turn °', min: 60, max: 720, step: 10,
    hint: 'Degrees of turn from end to end past which a baseline is unwritable and the plainer fallbacks are used instead.' },

  { group: 'Spine' },
  { k: 'pull', label: 'Interior pull', min: 0, max: 6, step: 0.1,
    hint: 'How much more a step costs when it lands on the border than when it lands as deep inland as the block goes.' },
  { k: 'smoothMix', label: 'Fit ↔ raw walk', min: 0, max: 1, step: 0.05,
    hint: '1 takes the fitted curve whole; 0 takes the raw walk; between pulls the curve back towards the walk, which keeps a bottleneck the fit wants to cut across.' },
  { k: 'polyDeg', label: 'Fit degree', min: 1, max: 5, step: 1,
    hint: 'Degree of the polynomial fitted to x and y against distance along the spine. 1 is a straight line; 3 manages one real bend; higher starts to ripple again.' },
  { k: 'avgPasses', label: 'Averaging passes', min: 0, max: 8, step: 1,
    hint: 'For the averaged-and-rounded spine only. Takes the hex stagger down without changing the fact that the line still follows it.' },
  { k: 'chaikin', label: 'Corner cutting', min: 0, max: 5, step: 1 },

  { group: 'Axis' },
  { k: 'tiltMax', label: 'Max tilt °', min: 0, max: 90, step: 1,
    hint: 'How far off level the principal axis may be. It sets where the two ends of the country are taken from, so it steers the spine as well as the straight baselines.' },
  { k: 'roundRatio', label: 'Round threshold', min: 1, max: 3, step: 0.05,
    hint: 'Below this axis ratio a block counts as round and its name is set level, the axis being noise.' },

  { group: 'Shared origin' },
  { k: 'originDeg', label: 'Direction °', min: -180, max: 180, step: 5,
    hint: 'Which way the shared centre lies from the middle of the map: 90 is below it, so the arcs bow upwards like lines of latitude on a north-up globe.' },
  { k: 'originDist', label: 'Distance', min: 0.3, max: 20, step: 0.1,
    hint: 'How far away the shared centre is, in map heights. Near, and the labels curve hard; far, and they flatten towards straight.' },

  { group: 'Lettering' },
  { k: 'face', label: 'Face', opts: () => REALM_FACES, wide: true },
  { k: 'ink', label: 'Ink', opts: () => REALM_INKS, wide: true },
  { k: 'fsMax', label: 'Largest size', min: 10, max: 120, step: 1,
    hint: 'A ceiling for the biggest realms, which are otherwise limited only by how thick they are.' },
  { k: 'fsMin', label: 'Smallest size', min: 3, max: 30, step: 0.5 },
  { k: 'trackMax', label: 'Max tracking (em)', min: 0, max: 1.5, step: 0.05 },
  { k: 'thickFrac', label: 'Size ÷ thickness', min: 0.2, max: 1, step: 0.02 },
  { k: 'thickPct', label: 'Thickness percentile', min: 0, max: 1, step: 0.05,
    hint: 'Which of the thicknesses along the line the size is taken from. Low means the name fits the narrow places it crosses.' },
  { k: 'endInset', label: 'End clearance', min: 0, max: 3, step: 0.1,
    hint: 'Room left clear at the two ends together, in font sizes, since the trim only followed the centreline and a glyph has width.' },
  { k: 'taperNeed', label: 'Taper cut-off', min: 0, max: 2, step: 0.05,
    hint: 'Ground must be this many font sizes thick to hold a capital; thinner, and the ends are cut back.' },

  { group: 'Which blocks, and collisions' },
  { k: 'blocksMax', label: 'Names per realm', min: 1, max: 8, step: 1 },
  { k: 'blockMinHex', label: 'Smallest piece', min: 0, max: 30, step: 1,
    hint: 'A piece of a realm must be at least this many whole hexes to be worth its own copy of the name.' },
  { k: 'blockFrac', label: '…share of largest', min: 0, max: 1, step: 0.02,
    hint: '…and this share of the realm\u2019s largest piece. Without it a big realm has its name written again on every coastal fragment it owns.' },
  { k: 'collide', label: 'Collision distance', min: 0, max: 1.5, step: 0.02,
    hint: 'Two labels touch when closer than this times their two heights added. 0 places everything and lets them overlap.' },

  { group: 'Borders ↔ Warlords' },
  { k: 'crossRule', label: 'Who wins', opts: () => RN_CROSS_RULES, wide: true },
  { k: 'collideCross', label: 'Distance across layers', min: 0, max: 1.5, step: 0.02,
    hint: 'The same, for two labels on different layers — which are allowed nearer, since the two are answering different questions about the same ground rather than disputing it.' },
];
function buildRnPanel() {
  const host = document.getElementById('rnTuner');
  if (!host || !LOCAL) return;
  host.innerHTML = '';
  for (const f of RN_FIELDS) {
    if (f.group) {
      const h = document.createElement('div');
      h.className = 'rngroup';
      h.textContent = f.group;
      host.appendChild(h);
      continue;
    }
    const row = document.createElement('label');
    row.className = 'rnrow' + (f.wide ? ' wide' : '');
    row.title = f.hint || '';
    const val = RN[f.k];
    row.innerHTML = f.opts
      ? `<span>${escHtml(f.label)}</span><select>${f.opts().map(o =>
          `<option value="${o.id}"${o.id === val ? ' selected' : ''}>${escHtml(o.name)}</option>`).join('')}</select>`
      : `<span>${escHtml(f.label)}</span>
         <input type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}">
         <output>${val}</output>`;
    const input = row.querySelector('select, input');
    const out = row.querySelector('output');
    const commit = async () => {
      RN[f.k] = f.opts ? input.value : +input.value;
      if (out) out.textContent = RN[f.k];
      try { localStorage.setItem(RN_LS, JSON.stringify(RN)); } catch {}
      if (f.k === 'face') await loadRealmWebFont(realmFace());
      refitRealmNames();
    };
    // Sliders answer live, since the whole value of the panel is watching the map move as you drag —
    // a refit is forty milliseconds and the browser coalesces what it cannot keep up with.
    input.oninput = commit;
    input.onchange = commit;
    host.appendChild(row);
  }
  const foot = document.createElement('div');
  foot.className = 'rnfoot';
  foot.innerHTML = `<button class="btn" type="button">Back to defaults</button><p class="hint" id="rnReport"></p>`;
  foot.querySelector('button').onclick = () => {
    Object.assign(RN, RN_DEFAULT);
    try { localStorage.removeItem(RN_LS); } catch {}
    buildRnPanel(); refitRealmNames();
  };
  host.appendChild(foot);
  loadRealmWebFont(realmFace());
  updateRnReport();
}
/* What the last fit actually did. Worth reporting because the interesting failures are silent ones:
   a baseline that returned nothing and fell back, or a label dropped for a collision, both leave a
   map that merely looks a bit bare. The tally names which algorithm each drawn label came from. */
function updateRnReport() {
  const el = document.getElementById('rnReport');
  if (!el || !rnLastStats) return;
  const s = rnLastStats;
  if (!s.layers.length) { el.textContent = 'No realm names showing.'; return; }
  const per = s.layers.map(id => `${id} ${s.drawn[id] || 0}`).join(' + ');
  const from = Object.entries(s.byAlgo).map(([k, n]) => `${n}× ${k}`).join(', ');
  el.textContent = `${per} drawn`
                 + (s.shrunk ? `, ${s.shrunk} shrunk to fit` : '')
                 + (s.hit ? `, ${s.hit} dropped for collisions` : '')
                 + (s.dup ? `, ${s.dup} as duplicates across layers` : '')
                 + ` · ${s.ms} ms` + (from ? ` · ${from}` : '');
}

/* Four thousand numbers, drawn once into pictures.

   As live <text> this was 4,113 nodes, each with a stroked outline behind it — and text with
   paint-order:stroke is about the most expensive thing an SVG renderer can be asked for, since every
   glyph has to be outlined, stroked and filled again on every frame of every pan and zoom. Switching
   the layer on made the whole map stick.

   Nothing about the numbers ever changes: they are the hex ids, at the hex centres, in a fixed size.
   So they are rendered to a canvas once and hung in the layer as images — four of them rather than
   one, because a single canvas at this supersampling would be eighty megapixels and some browsers
   refuse canvases a fraction of that. Tiling by the supersampling factor keeps each canvas at exactly
   the world's pixel size, which is the largest that can be relied on. Panning and zooming then costs
   nine bitmap blits instead of four thousand outlined glyphs.

   Supersampled so the numbers survive being zoomed into: they are drawn at nine map pixels and read
   at whatever zoom you are at, so the raster has to hold three pixels to the map's one for them to
   stay crisp up to 3:1. Beyond that they soften, which is a fair trade for a layer to glance at.

   Blob URLs rather than data URLs: the same pixels, but a short string in the DOM instead of a
   megabyte of base64 per tile. They are revoked when the layer is rebuilt, since a sheet refetch
   would otherwise leak the old set. If a canvas cannot be had at all, the old text nodes are still
   there to fall back on — slow, but a slow map beats a blank layer. */
const HEXID_FONT = '9px system-ui, sans-serif';
const HEXID_SS = 3;        // supersampling: how many raster pixels to a map pixel
const HEXID_TILES = 3;     // tiles per axis. At TILES === SS each canvas is exactly the world's
                           // pixel size, which is the largest every browser will reliably allocate.
let hexIdUrls = [];
async function renderHexIds() {
  groups.hexIds.innerHTML = '';
  for (const u of hexIdUrls) URL.revokeObjectURL(u);
  hexIdUrls = [];
  const hw = Math.max(...CORN.map(c => Math.abs(c[0]))), hh = Math.max(...CORN.map(c => Math.abs(c[1])));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const ids = [];
  for (const idS in S.hexes) {
    if (S.hexes[idS].t === 'N/A') continue;          // the sheet's padding is not anywhere
    const [cx, cy] = hexCenter(+idS);
    ids.push([idS, cx, cy]);
    x0 = Math.min(x0, cx - hw); x1 = Math.max(x1, cx + hw);
    y0 = Math.min(y0, cy - hh); y1 = Math.max(y1, cy + hh);
  }
  if (!ids.length) return;
  const N = HEXID_TILES, tw = (x1 - x0) / N, th = (y1 - y0) / N;
  /* A number wider than the gap to the tile edge hangs over into the next tile. The tile that holds
     its hex centre clips the overhang, and the neighbour never draws it at all, because the centre
     is not in *its* bounds — so the label came out sliced down the middle, once along every seam.
     Every tile therefore draws any label within a margin of its edge as well as those inside it. The
     two draw identical pixels and each clips to its own half, so the halves meet; a label drawn twice
     costs nothing, since each canvas keeps only the part that falls inside it. One hex width of margin
     is far more than a four-digit number at nine pixels can span. */
  const margin = S.G.hex_width;
  let ok = true;
  for (let ty = 0; ty < N && ok; ty++) for (let tx = 0; tx < N && ok; tx++) {
    const ox = x0 + tx * tw, oy = y0 + ty * th;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(tw * HEXID_SS); cv.height = Math.ceil(th * HEXID_SS);
    const ctx = cv.getContext('2d');
    if (!ctx) { ok = false; break; }
    ctx.scale(HEXID_SS, HEXID_SS);
    ctx.translate(-ox, -oy);
    ctx.font = HEXID_FONT;
    ctx.textAlign = 'center';
    ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#14181e'; ctx.fillStyle = '#fff';
    for (const [idS, cx, cy] of ids) {
      if (cx < ox - margin || cx > ox + tw + margin || cy < oy - margin || cy > oy + th + margin) continue;
      ctx.strokeText(idS, cx, cy + 3.6);             // stroke first: SVG's paint-order: stroke
      ctx.fillText(idS, cx, cy + 3.6);
    }
    const img = el('image', { x: ox, y: oy, width: tw, height: th, 'pointer-events': 'none' }, groups.hexIds);
    try {
      // One tile at a time. Nine canvases of nine megapixels each is a third of a gigabyte if they
      // are all alive at once; awaiting the encode lets each go before the next is made.
      const url = await new Promise(res => {
        if (cv.toBlob) cv.toBlob(bl => res(bl ? URL.createObjectURL(bl) : null), 'image/png');
        else res(cv.toDataURL());
      });
      if (!url) { ok = false; break; }
      if (url.startsWith('blob:')) hexIdUrls.push(url);
      img.setAttribute('href', url);
    } catch { ok = false; }
  }
  if (ok) return;
  // No canvas to be had. The numbers matter more than the frame rate, so draw them the slow way.
  groups.hexIds.innerHTML = '';
  for (const [idS, cx, cy] of ids)
    el('text', {
      x: cx, y: cy + 3.6, 'text-anchor': 'middle', 'font-size': 9, fill: '#fff',
      stroke: '#14181e', 'stroke-width': 2, 'paint-order': 'stroke',
      'font-family': 'system-ui,sans-serif', 'pointer-events': 'none',
    }, groups.hexIds).textContent = idS;
}
/* One marker per stronghold, and a stronghold belongs to a subhex — so a hex split by a major river
   can show a town on one bank and a keep on the other, each with its own name and each a port or not
   on its own account. The dedupe therefore has to be by hex *and* subhex; keyed by hex alone, as it was,
   the two would collapse into one. */
function renderLabels() {
  groups.labels.innerHTML = '';
  /* The names go in a group of their own, appended after every marker has been drawn, for two
     reasons. One is the switch: the Strongholds row carries a names button, and a group is something
     that can be hidden without any of this being redone. The other is stacking — names used to be
     drawn interleaved with the discs, so a name reaching over its neighbour went *behind* that
     neighbour's marker and lost a letter or two. Collected and laid on top afterwards, every name
     clears every disc. Names overlapping each other is a different problem and not one a z-order
     can solve. */
  const names = [];
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
    if (name) names.push([cx, cy - r - SH_NAME_GAP, name]);
  };
  for (const id of namedHexes()) {
    const es = shEntries(id);
    // Every stronghold in the hex, marker-backed or straight off the datasheet, each on its own bank.
    for (const { m, ri } of es) put(id, ri, shName(id, m), m);
    // A hex named by hand with nothing fortified in it is still a place worth drawing — and it has no
    // marker to hang the name off, so it stays hex-keyed and sits wherever the centre falls.
    if (!es.length && S.features.labels[id]) put(id, shRegion(id, {}), S.features.labels[id], null);
  }
  /* Emptied and refilled rather than made afresh, because the group is not this function's to own: it
     lives at its own height in the z-order (below the realm lettering, above the drawn features) and it
     carries the switch state, the opacity and the filter that the Strongholds row has set on it. Rebuild
     the element and all three are silently lost — which is what happened while it was a child made on
     every render: renaming one stronghold brought every hidden name back with it. */
  groups.shNames.replaceChildren();
  for (const [x, y, name] of names) el('text', {
    x, y, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#fff',
    stroke: '#14181e', 'stroke-width': 2.4, 'paint-order': 'stroke', 'font-family': 'system-ui,sans-serif',
  }, groups.shNames).textContent = name;
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
/* What to call a piece of ground, asked of the subhex rather than the hex: the stronghold standing
   on it names it, and only failing that does the hex's own label answer. The readout has always done
   this — it is why hovering says Ephialtas — but the step table and the step menu asked the hex
   alone, so a place whose name lives on its marker (every stronghold moved or added by hand) went
   nameless in the very list you write orders from. One rule, in one place, for all three. */
function placeName(h, ri) {
  const m = shAt(h, ri | 0);
  return (m ? shName(h, m) : (S.features.labels[h] ?? S.names.hexes[h])) || '';
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

/* Painting a realm on by hand. The two scans are pictures of a moment and go out of date the way any
   picture does; rather than repaint a PNG to move one hex, an override is kept per layer, per subhex,
   and applied over whatever the scan said. It lives in the features file with everything else drawn
   by hand, so it exports, imports and undoes like the rest of it.

   Keyed by subhex, and so subject to the same caveat as subTerrain: region indices move when a
   coastline is redrawn, and an override on a hex you then cut in two may end up on the other half. */
function setRealmAt(layer, h, ri, colour) {
  pushUndo();
  const all = S.features.realms || (S.features.realms = {});
  const byHex = all[layer] || (all[layer] = {});
  const byRi = byHex[h] || (byHex[h] = {});
  if (!colour) {                             // back to whatever the scan says
    delete byRi[ri | 0];
    if (!Object.keys(byRi).length) delete byHex[h];
  } else byRi[ri | 0] = colour;
  commitFeatures();
}
const realmOverride = (layer, h, ri) => S.features.realms?.[layer]?.[h]?.[ri | 0] || null;

/* What a realm is called. The Warlords scan ships with a legend — ten colours identified from the
   image itself — and the Borders scan with none, so most of the palette has only ever been able to
   go by its own hex code. A name given here is stored per layer and per colour and beats the legend,
   which makes the legend a default rather than a fact: a legion that changes hands, a colour mixed
   for a realm that did not exist when the scan was drawn, and every unnamed Borders wash can all be
   told what they are. On Warlords, a token supplies the legion name when its colour is absent from the
   original legend. Clearing the text falls back to those defaults, and then to the hex — the same way
   clearing a stronghold's label falls back to the datasheet's name.

   Keyed by colour rather than by subhex, so naming one hex of a realm names the realm. It lives in
   the features file with everything else written by hand, and so exports, imports and undoes with the
   rest of it. */
/* A commandery's name is not a name given to a colour; it is the settlement the province is named
   for, and the colour was made from it. So it answers from the paint rather than from the stored
   names, and is not renamable here — rename the stronghold and the province follows, which is how
   commandery names have always worked on this map. */
const realmName = (layer, c) => layer === 'comm' ? (commColorName.get(c) ?? null)
  : S.features.realmNames?.[layer]?.[c]
  ?? WARLORD_BY_RGB.get(c)
  ?? (layer === 'warlords' ? tokenColourNames(rgbHex(c))[0] : null)
  ?? null;
const realmLabel = (layer, c) => realmName(layer, c) || rgbHex(c);
/* How many colours on this layer answer to the same name as this one — 1 for an ordinary realm, more for
   a federation. Counted over the colours the layer is actually *painting* rather than over the stored
   names, so a name left behind on a wash the scan no longer uses does not inflate it. */
function realmKin(layer, c) {
  const name = realmName(layer, c);
  if (!name) return 1;
  const seen = new Set();
  for (const col of realmCols.get(layer)?.values() || []) if (realmName(layer, col) === name) seen.add(col);
  return Math.max(seen.size, 1);
}
function setRealmName(layer, c, name) {
  pushUndo();
  const all = S.features.realmNames || (S.features.realmNames = {});
  const byColour = all[layer] || (all[layer] = {});
  const n = (name || '').trim().slice(0, 40);
  if (n) byColour[c] = n; else delete byColour[c];
  if (!Object.keys(byColour).length) delete all[layer];
  commitFeatures();
  renderRealmPicker();
}

/* The Realm tool's palette. Not a list kept by hand — the choices are the colours that layer actually
   uses, read off the paint, most-used first. Whatever realms are on the map are what you can paint
   with, and a realm added to a scan turns up here without anyone editing a table. Warlord colours are
   named; the Borders scan's washes have no names, so they go by their own colour.

   "Rub out" is a real choice rather than the absence of one, and is stored as such: an override of
   `none` means *this subhex holds nobody*, which is different from having no override, where the scan
   is left to speak. Without it there would be no way to clear ground the scan claims. */
let realmPaint = null;              // the colour the tool is loaded with, or 'none', or null
/* A colour mixed by hand belongs in the palette even before it has been laid down anywhere, or it
   could only ever be used for one subhex: the palette is read off the paint, and a colour that is
   nowhere on the map yet is nowhere in that reading. Kept per layer, since a colour mixed for the
   warlords means nothing on the borders — the same reason `realmPaint` is dropped when the layer
   changes. Once painted it turns up in the reading on its own and this copy is simply redundant. */
const realmCustom = new Map();      // layer -> the last colour mixed by hand
/* The dropper is armed rather than instant: it is a mode the next map click resolves, like the coast
   tool's sea-side pick. Instant would mean a modifier, and the one modifier free here is the one
   that erases a whole line under the eraser — too close for a tool that shares the eraser's drag. */
let realmDropper = false;
function setRealmDropper(on) {
  realmDropper = !!on;
  svg.classList.toggle('picking', realmDropper);
  renderRealmPicker();
}
/* Reaching for the tool is as good as asking for the layer, and asking for it means seeing it. Read
   the scan if it has not been read, so there is a palette to choose from — and redraw the picker when
   it arrives, since reading a scan is a round trip and the palette comes from what it paints.

   Then switch the layer *on*. Painting a map you cannot see is not a thing anyone wants to do, and
   the old behaviour — read the scan, leave it hidden — meant the first few clicks landed invisibly
   and the tool looked broken. It goes through the row's own checkbox rather than round the back of
   it, so the panel never claims a layer is off while the map is painting it.

   The first time that happens, say so: the Layers panel opens with the row it just ticked flashing.
   A layer turning itself on is the kind of thing that has to be shown rather than done quietly,
   because the next question is always "how do I turn it off again" and the answer is then on screen.

   Once only, though. It is a thing to be told, not a thing to be reminded of, and a panel that
   reopens whenever you reach for the tool — or switch scans, or come back from the eraser — is a
   panel you spend the session closing. The showing and the switching are therefore separate: the
   layer goes on *every* time, since painting a map you cannot see is never what anyone wanted, but
   it is only ever pointed at once. Deliberately not saved with the UI preferences: this is orientation
   for whoever is at the map now, and a reload is cheap enough to be worth showing again. */
let realmLayerShown = false;
function ensureRealmLayer() {
  const L = LAYERS.find(x => x.id === document.getElementById('realmLayer')?.value);
  if (!L) return;
  if (!L._built) { L._built = true; Promise.resolve(L.lazy?.()).then(renderRealmPicker); }
  if (!L._chk || L._chk.checked) return;
  L._chk.checked = true;
  L._apply();          // `_built` is already set above, so this only reveals the group
  if (realmLayerShown) return;
  realmLayerShown = true;
  openLayers();
  flashLayerRow(L);
}
/* Three blinks and done, the same tell the search gives a hex it has just found. The class is dropped
   and the row measured before it goes back on, which is what makes a second flash restart the
   animation rather than be ignored as a no-op — and the pending cleanup is cancelled with it, or the
   first flash's timer would arrive mid-way through the second and put it out early. */
function flashLayerRow(L) {
  if (!L._row) return;
  clearTimeout(L._flash);
  L._row.classList.remove('lit');
  void L._row.offsetWidth;
  L._row.classList.add('lit');
  L._flash = setTimeout(() => L._row?.classList.remove('lit'), 1800);
}
// The colours a layer actually uses, most-used first. The palette proper; the extras below are added
// to it rather than mixed into it, so they keep their place at the bottom however the map changes.
function realmPalette(layer) {
  const counts = new Map();
  for (const c of realmCols.get(layer)?.values() || []) counts.set(c, (counts.get(c) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}
/* Token colours are also valid Warlords paint, even before that colour holds any ground. One swatch per
   colour is enough; prefer the parent legion token when detachments share it. */
function tokenRealmColours() {
  const byColour = new Map();
  for (const t of S.tokens || []) {
    if (!/^#[0-9a-f]{6}$/i.test(t.color || '')) continue;
    const c = rgbKey(t.color.toLowerCase());
    if (!byColour.has(c)) byColour.set(c, []);
    byColour.get(c).push(t);
  }
  const out = new Map();
  for (const [c, tokens] of byColour) {
    const parent = tokens.find(t => t.label === tokenBase(t.label)) || tokens[0];
    const base = tokenBase(parent.label);
    const legion = ROMAN.includes(base) ? `Legion ${base}` : '';
    const designation = String(parent.label || '').trim();
    out.set(c, legion || designation || 'Token');
  }
  return out;
}
// Names shown when a shared-palette swatch is already in use by one or more tokens.
function tokenColourNames(colour) {
  const key = String(colour || '').toLowerCase();
  const names = [];
  for (const t of S.tokens || []) {
    if (String(t.color || '').toLowerCase() !== key) continue;
    const designation = String(t.label || '').trim();
    const base = tokenBase(designation);
    const name = ROMAN.includes(base) ? `Legion ${base}` : designation;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
/* Take the map to a realm colour: to the middle of the largest contiguous piece of ground that colour
   holds, panning only. The largest piece rather than the centre of everything it holds, because a realm
   with an island the far side of the map has a centre out at sea — the whole point of going there is to
   land on the ground itself.

   Contiguity is the same walk the labels use, so "the piece it takes you to" and "the piece its name is
   written on" are the same piece. The colour is *sampled from the paint* rather than from the scan, so
   hand-painted overrides count and a colour that has been rubbed out everywhere takes you nowhere,
   which is the honest answer. */
function panToRealm(layer, c) {
  const cols = realmCols.get(layer);
  if (!cols || !S.adj) return false;
  const cells = new Set();
  for (const [k, col] of cols) if (col === c) cells.add(k);
  if (!cells.size) return false;
  let best = null, bestArea = -1;
  for (const block of realmBlocks(realmGraph(cells))) {
    let a = 0;
    for (const k of block) {
      const i = k.indexOf(':');
      a += cellArea(regionsOf(+k.slice(0, i))[+k.slice(i + 1)]);
    }
    if (a > bestArea) { bestArea = a; best = block; }
  }
  if (!best) return false;
  let x = 0, y = 0;
  for (const k of best) { const p = cellPoint(k); x += p[0]; y += p[1]; }
  S.vb = { ...S.vb, x: x / best.length - S.vb.w / 2, y: y / best.length - S.vb.h / 2 };
  applyViewBox();
  return true;
}
function renderRealmPicker() {
  const wrap = document.getElementById('realmPick');
  if (!wrap) return;
  const on = S.mode === 'draw' && S.tool === 'realm';
  wrap.hidden = !on;
  if (!on) { if (realmDropper) { realmDropper = false; svg.classList.remove('picking'); } return; }
  const layer = document.getElementById('realmLayer').value;
  const box = document.getElementById('realmSwatches');
  box.innerHTML = '';
  const mapCols = realmPalette(layer);
  const tokenCols = layer === 'warlords' ? tokenRealmColours() : new Map();
  const cols = [...mapCols, ...[...tokenCols.keys()].filter(c => !mapCols.includes(c))];
  if (!cols.length) {
    box.innerHTML = '<div class="emptynote">Turn this layer on to load its colours.</div>';
    return;
  }
  if (realmPaint === null) realmPaint = cols[0];
  const add = (val, label, css, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'realmsw' + (cls ? ' ' + cls : '') + (realmPaint === val ? ' on' : '');
    b.title = label;
    b.innerHTML = `<span class="sw" style="background:${css}"></span><span class="nm">${escHtml(label)}</span>`;
    b.onclick = () => { realmPaint = val; setRealmDropper(false); };
    box.appendChild(b);
    return b;
  };
  // A colour is renamed by double-clicking its name, the way a route is. The click underneath still
  // reaches the button and loads the brush, which is no loss: you were pointing at that realm anyway.
  const colourSwatch = c => {
    const stored = S.features.realmNames?.[layer]?.[c];
    const label = stored || WARLORD_BY_RGB.get(c) || tokenCols.get(c) || rgbHex(c);
    const b = add(c, label, `rgb(${c})`);
    /* Colours sharing a name are one polity: the label pass groups by name, so a federation is made by
       calling each member wash the same thing. Said in the tooltip because it is otherwise invisible —
       the swatches stay separate, as they must for painting, and nothing else on screen shows that two
       of them have been tied together. */
    const kin = realmKin(layer, c);
    const tokenNames = tokenColourNames(rgbHex(c));
    b.title = `${label} · ${rgbHex(c)}`
            + (tokenNames.length ? `\n${tokenNames.length === 1 ? 'Token' : 'Tokens'}: ${tokenNames.join(', ')}` : '')
            + `\nDouble-click the swatch to go to it; double-click the name to rename.`
            + (kin > 1 ? `\nOne of ${kin} colours under this name; they are labelled as one polity.` : '');
    /* Double-clicking the swatch takes the map to the realm. The palette is read off the paint, so every
       entry in it is somewhere on the map by construction — but a wash of two subhexes on a coast three
       screens away is a colour you can select and then not find, and the question "where is this one?"
       has no other answer. It goes to the *largest* piece and only pans, never zooms, for the same reason
       the search only pans: you have already decided how closely you want to look.

       On the swatch rather than on the whole button because the name is the rename target, and one
       element cannot carry two double-clicks. The clicks underneath still load the brush, which is no
       loss — you were pointing at that realm anyway. */
    b.querySelector('.sw').ondblclick = e => { e.stopPropagation(); panToRealm(layer, c); };
    b.querySelector('.nm').ondblclick = e => {
      e.stopPropagation();
      const cur = realmName(layer, c) ?? '';
      const n = prompt(`Name for ${rgbHex(c)} on the ${layer} map.\n\n`
                     + 'Give two or more colours the same name and they are labelled as one polity — '
                     + 'which is how a federation is made. Clear the text to fall back to the legend.', cur);
      if (n !== null && n.trim() !== cur) setRealmName(layer, c, n);
    };
  };
  for (const c of cols) colourSwatch(c);
  // A hand-mixed colour sits with the rest and is selected the same way, so it can be picked up again
  // after a detour through another swatch without reopening the dialog. Once it has been painted
  // somewhere the reading above already holds it, and this stops adding a duplicate.
  const mixed = realmCustom.get(layer);
  if (mixed && !cols.includes(mixed)) colourSwatch(mixed);
  add('none', 'Nobody', 'repeating-linear-gradient(45deg,#333 0 4px,#555 4px 8px)');

  const input = document.getElementById('realmCustomInput');
  const mix = add(Symbol('mix'), 'Custom colour…',
                  'conic-gradient(#f43,#fd3,#4d6,#3cf,#63f,#f3b,#f43)', 'realmact');
  mix.onclick = () => {
    if (!input) return;
    // Seeded with whatever is loaded, so the dialog opens on the colour you were just using rather
    // than on black — mixing is nearly always an adjustment of something already on the map.
    input.value = rgbHex(!realmPaint || realmPaint === 'none' ? (mixed || cols[0]) : realmPaint);
    input.click();
  };
  const drop = add(Symbol('drop'), realmDropper ? 'Click the map…' : 'Pick from map',
                   'linear-gradient(135deg,#8fa6bd,#dfe7ef)', 'realmact' + (realmDropper ? ' armed' : ''));
  drop.onclick = () => setRealmDropper(!realmDropper);
}
/* Sweeping lays the colour down and leaves it there. A drag crosses the same subhex several times as
   the hand wavers, and the click behaviour — same colour again lifts it — would flicker it on and off
   under the cursor. So the sweep only ever sets. */
function paintRealmDrag(wx, wy) {
  const h = nearestHex(wx, wy);
  if (!h || S.hexes[h].t === 'N/A' || !realmPaint) return;
  const layer = document.getElementById('realmLayer').value;
  const ri = regionAt(h, [wx, wy]);
  if (realmOverride(layer, h, ri) === realmPaint) return;
  setRealmAt(layer, h, ri, realmPaint);
}
/* Lifting a colour off the map. It reads what the map is *showing* there rather than what the scan
   alone said, because an override, an inherited spit and a warlord painted over the borders all look
   the same to the eye and so must answer the same to the dropper. Ground nobody holds picks up
   Nobody, which is a real brush rather than a failure to pick — the eraser of this tool.

   Whatever it lifts is by construction already in the palette (that is where the palette is read
   from), so there is nothing to remember: the swatch it selects is one that is on screen. */
function pickRealmAt(wx, wy) {
  const h = nearestHex(wx, wy);
  if (!h || S.hexes[h].t === 'N/A') return setRealmDropper(false);
  const layer = document.getElementById('realmLayer').value;
  realmPaint = realmCols.get(layer)?.get(h + ':' + regionAt(h, [wx, wy])) || 'none';
  setRealmDropper(false);
}
// Painting one subhex. Same colour again lifts it, so the tool rubs out by being used twice — and a
// colour that only matches what the scan already said is stored anyway, since the scan may change.
function paintRealmAt(wx, wy) {
  const h = nearestHex(wx, wy);
  if (!h || S.hexes[h].t === 'N/A' || !realmPaint) return;
  const layer = document.getElementById('realmLayer').value;
  const ri = regionAt(h, [wx, wy]);
  if (realmOverride(layer, h, ri) === realmPaint) setRealmAt(layer, h, ri, null);
  else setRealmAt(layer, h, ri, realmPaint);
}
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

   Water is at subhex resolution like everything else, so a bay bitten out of a shore hex is water
   here too. A hex nothing has cut is one shape, taken from the datasheet's own terrain: a bank of a
   major river is land on both sides, so only a coastline makes a difference to this.

   It is built in layers laid completely over one another rather than tiled edge to edge, which is
   what makes it seam-free: two paths that tile a surface between them leave a hairline everywhere
   they meet — here, every coastline on the map — while a path laid wholly over another cannot.

   The land is therefore the grid's own outline, filled — see gridOutlineD, which traces it once. Not
   four thousand hexagons: under the water and the off-map filler it is never seen, and where it *is*
   seen it is a single flat colour, so those were twenty-five thousand edges to rasterise every frame
   for a result the boundary gives exactly. The water goes over it, then the off-map filler over that.
   This is also the solid backdrop the terrain above needs, which is what keeps *its* seams from
   showing the page — so it stays drawn even when Terrain is covering all of it, which is all the more
   reason for it to be cheap.

   The sheet pads its grid three columns wider than the world it describes and fills them with "N/A".
   None of it is drawn: not here, not by the terrain, and not by the outline, which traces the real
   map rather than the whole grid. The map ends where the map ends. */
/* The outline of the whole grid, as closed loops: every hex side with no hex behind it, stitched end
   to end. A staggered hex grid is not a rectangle — its edge is a sawtooth, and the water drawn over
   this is hex-shaped, so a straight-edged backdrop showed as a green step wherever the two disagreed.

   It is also the cheap way to fill the grid. Four thousand hexagons is a quarter of a megabyte of
   path for a shape whose boundary is a few hundred points, and every one of those hexagons has to be
   rasterised on every frame for a result the boundary alone gives exactly. The grid's shape cannot
   change without initGeom, which is where this is dropped, so it is worked out once and kept.

   The stitching is safe because the corners are: adjacent hexes emit identical coordinates for the
   corners they share — all 24,834 of them agree — so matching an endpoint is an equality test and not
   a search for something near enough. Sides are emitted in the winding every hexagon is built with,
   so following them from any starting point walks the loop in order. */
let gridOutline = null;
function gridOutlineD() {
  if (gridOutline !== null) return gridOutline;
  const K = p => p[0].toFixed(1) + ' ' + p[1].toFixed(1);
  const real = h => S.hexes[h] && S.hexes[h].t !== 'N/A';   // the map, as against the sheet's padding
  const next = new Map();                    // corner -> the corners a boundary side leads to
  for (const idS in S.hexes) {
    const h = +idS;
    if (!real(h)) continue;
    const [cx, cy] = hexCenter(h);
    /* Which of the six sides have a hex behind them, asked of the neighbours themselves. Asking the
       map instead — what hex lies across this side — is what a first attempt did, and it is wrong at
       exactly the edge this function is about: past the last column there is no hex there, and
       `nearestHex` answers with the nearest one it can find, which is often a hex in the row above.
       That reads as an interior side, drops it from the boundary, and leaves the chain in pieces.

       The midpoint between two adjacent centres is the midpoint of the side they share, so a
       neighbour names its own side by where it sits. */
    const interior = new Set();
    for (const n of neighbors(h)) {
      if (!real(n)) continue;                // padding is not behind anything; this side is an edge
      const [nx, ny] = hexCenter(n);
      const mx = (nx - cx) / 2, my = (ny - cy) / 2;
      let bi = 0, bd = Infinity;
      for (let i = 0; i < 6; i++) {
        const dd = (EDGE[i][0] - mx) ** 2 + (EDGE[i][1] - my) ** 2;
        if (dd < bd) { bd = dd; bi = i; }
      }
      interior.add(bi);
    }
    for (let i = 0; i < 6; i++) {
      if (interior.has(i)) continue;
      const a = [cx + CORN[i][0], cy + CORN[i][1]];
      const b = [cx + CORN[(i + 1) % 6][0], cy + CORN[(i + 1) % 6][1]];
      const k = K(a);
      if (!next.has(k)) next.set(k, []);
      next.get(k).push(K(b));
    }
  }
  let d = '';
  for (const start of next.keys()) {
    const outs = next.get(start);
    while (outs.length) {
      let cur = outs.pop();
      d += 'M' + start + 'L' + cur;
      for (let guard = next.size + 8; guard-- && cur !== start;) {
        const on = next.get(cur);
        if (!on || !on.length) break;       // an open chain, which a closed grid cannot produce
        cur = on.pop();
        d += 'L' + cur;
      }
      d += 'Z';
    }
  }
  return (gridOutline = d);
}

function renderBase(sub = coastSubcells()) {
  const g = groups.base;
  if (!g) return;
  g.innerHTML = '';
  let sea = '';
  for (const idS in S.hexes) {
    const h = +idS, t = S.hexes[idS].t;
    if (t === 'N/A') continue;               // the sheet's padding: not anywhere, and drawn as nothing
    const [cx, cy] = hexCenter(h);
    const cells = sub.get(h);
    if (cells?.regions.length) {
      for (const r of cells.regions) if (r.sea && !r.river) sea += regionShape(h, r);
    } else if (RULES.WATER.has(t)) sea += hexPath(cx, cy);
  }
  el('path', { d: gridOutlineD(), fill: TERRAIN_COLORS.Flatlands, 'fill-rule': 'evenodd',
               stroke: 'none' }, g);
  if (sea) el('path', { d: sea, fill: TERRAIN_COLORS.Ocean, 'fill-rule': 'evenodd', stroke: 'none' }, g);
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
  if (!f.realms) f.realms = {};        // hand-painted realm colours, per scan layer
  if (!f.realmNames) f.realmNames = {}; // and what those colours are called, per layer and colour
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
/* ---------------- whether any of this outlives the tab ----------------
   Everything drawn, moved or planned is written to this browser as it happens, which is right for a map
   you are building over months and wrong for an afternoon of "what if he marched here instead". The
   switch at the foot of the rail settles which of the two this session is.

   Off means **nothing is written and nothing is read**: no save, no delete, and at the next load the
   copies already in the browser are passed over in favour of the shipped files. So a reload comes up as
   the map ships, and the work that was in storage is still in storage, untouched — switching saving
   back on and reloading brings it back. The switch itself is a preference about this browser rather
   than a change to the map, so it is kept whatever the switch says; it is the only thing that is. */
const saveOn = () => UI.save !== false;
function saveLocal() {
  const n = S.features.features.length;
  if (saveOn()) localStorage.setItem(LS_KEY, JSON.stringify(S.features));
  document.getElementById('saveInfo').textContent = saveOn()
    ? `Autosaved locally — ${n} features.`
    : `Not saving — ${n} features, and a reload clears these edits.`;
  markDrift();
}
// computeRoute rebuilds S.adj, so the borders repaint picks up the coastline that was just drawn.
// `commanderiesChanged` because a commandery is named for the settlement inside it: erasing, adding,
// renaming or reclassifying a stronghold can rename the commandery around it, and the search rows and
// the readout have to say the new name rather than the one cached before the edit.
function commitFeatures() {
  commanderiesChanged();
  renderFeatures(); renderLabels(); saveLocal(); computeRoute(); paintRealms(); renderSearch();
}

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
  /* How much river a hex needs before it counts as having the river in it. A river drawn along the
     boundary between two hexes belongs to whichever side of it the line happens to fall, and near a
     corner it can stray across for a few units and back — which used to be enough to make the hex it
     grazed a river hex, navigable, with a sail link to the hex the river really runs down. Gerénéi
     picked up four units of somebody else's river that way, and a fleet there could put out onto a
     channel that runs past the far side of the hex boundary. Four units is a graze; a river through a
     hex is most of a hex long. */
  const RIVER_IN_HEX = () => S.G.hex_size * 0.25;
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
    // group into runs per hex
    const all = [];
    for (let i = 0; i < samples.length; i++) {
      const h = samples[i][2];
      if (!all.length || all[all.length - 1].h !== h) all.push({ h, i0: i, i1: i });
      else all[all.length - 1].i1 = i;
    }
    /* A run too short to be the river passing through that hex is a graze at a boundary — the line is
       drawn along an edge and strays a few units over it near a corner. Dropped, so that the runs
       either side of it meet instead, which is where the river actually goes. Without this, four
       units of stray river through Gerénéi put a navigable channel there and a sail link to the hex
       the river really runs down. See RIVER_IN_HEX, which decides the same question for whether the
       hex counts as a river hex at all — the two must agree, or a fleet could board where it could
       not sail, or sail out of a hex it could not be in. */
    const runLen = r => {
      let L = 0;
      for (let k = r.i0; k < r.i1; k++)
        L += Math.hypot(samples[k + 1][0] - samples[k][0], samples[k + 1][1] - samples[k][1]);
      return L;
    };
    const runs = all.filter(r => runLen(r) >= RIVER_IN_HEX());
    /* ---------------- a river drawn along a hex boundary ----------------
       Rivers on this map are very often drawn *on* the edge between two hexes rather than through the
       middle of one, which is what a river between two counties looks like. Sampled every four units
       and asked which hex each sample is in, such a river answers A, B, A, B, A, B all the way down,
       because the drawn line wanders a unit either side of the boundary it is following.

       Read run by run, that came out as a long series of A→B connections — and a connection here
       means *a fleet can sail from A to B*. So the one thing the river plainly does not offer, a
       passage from one of its banks to the other, was the only thing it offered; and the thing it
       obviously does offer, a way downstream, was not there at all. A fleet at Gerénéi could not
       reach the hex below it without first crossing the channel to the far bank and back.

       So the alternation is read for what it is. Three or more runs flip-flopping between the same
       two neighbours are one **reach** of river with a hex on either side of it, and reaches are what
       get joined: every hex bordering one reach to every neighbouring hex bordering the next. Two
       hexes facing each other across the same reach are not joined at all — there is nowhere to sail
       to, they are the same water — and crossing between them is a bridge or a ford, which is a
       different question with its own answer (see riverEdge). A river that genuinely crosses an edge
       makes a run in each hex and no alternation, so it comes through this exactly as before. */
    const reaches = [];
    for (let i = 0; i < runs.length; ) {
      const a = runs[i].h, b = runs[i + 1]?.h;
      let j = i;
      if (a && b && a !== b && neighbors(a).includes(b))
        while (j + 1 < runs.length && runs[j + 1].h === (runs[j].h === a ? b : a)) j++;
      if (j >= i + 2) { reaches.push({ hexes: [a, b], i0: runs[i].i0, i1: runs[j].i1 }); i = j + 1; }
      else { reaches.push({ hexes: [a], i0: runs[i].i0, i1: runs[i].i1 }); i++; }
    }
    for (let j = 0; j + 1 < reaches.length; j++) {
      const u = reaches[j], v = reaches[j + 1];
      for (const a of u.hexes) for (const b of v.hexes) {
        if (!a || !b || a === b || !neighbors(a).includes(b)) continue;
        if (u.hexes.includes(b) || v.hexes.includes(a)) continue;   // two banks of one reach
        const key = pairKey(a, b);
        if (set) set.add(key);
        if (!geomMap.has(key)) {
          const mu = (u.i0 + u.i1) >> 1, mv = (v.i0 + v.i1) >> 1;
          geomMap.set(key, { a, pts: samples.slice(mu, mv + 1).map(s => [s[0], s[1]]) });
        }
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
  const majorLen = new Map();
  const addRiverSegs = (pts, minor) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const seg = { x1: pts[i][0], y1: pts[i][1], x2: pts[i + 1][0], y2: pts[i + 1][1], minor };
      // bucket into hexes near the segment (incl. neighbours, for crossing detection)
      const touched = new Set();
      const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1), n = Math.max(1, Math.ceil(len / 4));
      for (let k = 0; k <= n; k++) {
        const h = nearestHex(seg.x1 + (seg.x2 - seg.x1) * k / n, seg.y1 + (seg.y2 - seg.y1) * k / n);
        if (h) {
          touched.add(h);
          if (!minor) majorLen.set(h, (majorLen.get(h) || 0) + len / n);
          for (const nb of neighbors(h)) touched.add(nb);
        }
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
  for (const [h, L] of majorLen) if (L >= RIVER_IN_HEX()) majorHexes.add(h);
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
const realHex = h => !!S.hexes[h] && S.hexes[h].t !== 'N/A';
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
/* Where the water is in a subhex: the point on a drawn major river inside it, nearest that subhex's
   own centre. A step taken **afloat** with no drawn river to follow — launching from a port into the
   next hex's channel, which is a move the river-mouth rule does not have to allow — was drawn from
   one bank's centre to the other's, a line across open country between two places the fleet was never
   at, plainly nowhere near the river it was supposedly sailing. This is the same idea as anchoring a
   stop on its stronghold marker: draw to the thing the step is actually about. */
function riverPointIn(h, ri) {
  const segs = S.adj.riverByHex.get(h);
  if (!segs) return null;
  const c = nodePoint(h, ri);
  let best = null, bd = Infinity;
  for (const s of segs) {
    if (s.minor) continue;
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((c[0] - s.x1) * dx + (c[1] - s.y1) * dy) / L2)) : 0;
    const p = [s.x1 + dx * t, s.y1 + dy * t];
    if (nearestHex(p[0], p[1]) !== h) continue;   // the bucket holds the neighbours' water as well
    const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
/* Is there major water within `r` of this point? `riverByHex` already buckets every segment into its
   own hex *and* its neighbours, so one lookup covers everything that could be near. */
function nearMajorRiver(p, r) {
  const h = nearestHex(p[0], p[1]);
  if (h == null) return false;
  const r2 = r * r;
  for (const s of S.adj.riverByHex.get(h) || []) {
    if (s.minor) continue;
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - s.x1) * dx + (p[1] - s.y1) * dy) / L2)) : 0;
    const ex = p[0] - s.x1 - dx * t, ey = p[1] - s.y1 - dy * t;
    if (ex * ex + ey * ey < r2) return true;
  }
  return false;
}
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
const SETTING_CHKS = ['forced', 'marines', 'embark', 'fleet', 'noTrade', 'stops'];
/* Boxes that are on unless something says otherwise. Every route saved before a box existed has no
   opinion about it, and reading a missing key as "off" would silently change what those routes mean —
   `stops` in particular, where off would stop billing halts on marches that were planned with them. */
const SETTING_CHK_ON = { stops: true };
let syncingForm = false;
function syncRouteForm() {
  const st = activeSettings();
  syncingForm = true;
  for (const id of SETTING_NUMS) document.getElementById(id).value = st[id] ?? 0;
  for (const id of SETTING_CHKS) document.getElementById(id).checked = st[id] ?? !!SETTING_CHK_ON[id];
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
/* ---------------- commanderies ----------------

   The administrative division under the region: three tiers of them — core, province, frontier —
   read off ref/{core,provinces,frontier}_commanderies.png into data/commanderies.json by
   tools/build-commanderies.py. A hex belongs to at most one, and plenty of hexes belong to none.

   Where a region is a claim the datasheet makes per hex, a commandery is a *set* of hexes, so the
   two are stored the other way round from each other and the index below is what makes them ask-able
   in the same way. Both end up answering "what is this hex part of" and "which hexes is that", which
   is all the readout and the search need.

   A commandery has no name of its own: it is named for the settlement inside it, the grandest one it
   holds — a major city over a fortress over an ordinary stronghold, ties going to the lowest hex id
   so the answer does not depend on iteration order. That is derived here rather than baked into the
   file, so a stronghold renamed with the Draw tools renames its commandery too, and a hex that is
   given its first stronghold can give a nameless commandery a name. */
const COMM_RANK = { major: 0, fortress: 1, ordinary: 2 };
let commIndex = null;     // hex -> index into S.commanderies
let commSeats = null;     // index -> { h, name, kind } | null, the settlement it is named for
let commCells = null;     // "hex:region" -> index; the subhex reading, see commanderyCells

/* Dropped whenever the strongholds or the hand-written labels might have moved under us; the next
   question rebuilds it. Cheap enough (a few hundred lookups) that nothing tries to be cleverer.
   `commCells` goes too, since it is keyed by region index and those move when a coastline is redrawn. */
function commanderiesChanged() { commIndex = null; commSeats = null; commCells = null; }

/* A commandery, per **subhex** rather than per hex.

   `data/commanderies.json` names whole hexes, because the scans it is read from are pixels over hexes and
   the tool that reads them has no idea where your coastlines are. But administered ground is land: a bay
   that a drawn coast has bitten out of a shore hex is not part of the commandery around it, and saying so
   is the difference between a wash that describes a province and one that spills into the sea. So the hex
   list is refined here, against the live geometry, and the answer is a set of subhexes.

   Refined rather than re-derived. The alternative was to sample the three scans in the browser the way
   `paintRealm` samples the realm scans, which is the more faithful reading — it could put two banks of one
   river in different commanderies — and it was rejected twice over: it means three more images fetched and
   sampled at boot, where the readout and the search want commanderies immediately and a JSON is free; and
   it would move the colour-to-component work out of the Python tool, where it is done once and can be
   inspected and versioned, into work redone on every load. The hex list is the identity; the coast is the
   only thing the tool could not know; this adds exactly that.

   Two rules, then. **Water is not administered** — a sea subhex of a listed hex is left out, unless a
   drawn river runs through it, since a river reach inside a province is still inside the province. And a
   **sliver the list does not cover inherits**, by the same fixed-point pass the realm scans use: a spit
   your coast pushed out past what the scan drew belongs to the commandery it can be walked to, and a chain
   of such slivers resolves because each round sees what the last one settled. */
function commanderyCells() {
  if (commCells) return commCells;
  if (!commIndex) commanderyBuild();
  if (!S.adj) deriveAdj();
  commCells = new Map();
  for (const [h, i] of commIndex) {
    if (!S.hexes[h] || S.hexes[h].t === 'N/A') continue;
    const rs = regionsOf(h);
    /* `regWalkable` is the whole test, and is exactly the right one: it admits land, and admits the water
       of a major river's channel where one splits a hex — a reach running through a province is inside it —
       while leaving open sea out. It was `regWalkable || riverInRegion` at first, and that second clause
       quietly let nine **river mouths** in: a bay a drawn river empties into is reached by that river and
       is still the sea. The channel is in; the mouth is not. */
    for (let ri = 0; ri < rs.length; ri++)
      if (regWalkable(rs[ri])) commCells.set(h + ':' + ri, i);
  }
  /* The inheritance pass, confined to hexes a drawn coast or river has actually cut up — `S.adj.sub` holds
     exactly those — so nothing can creep across whole hexes of unadministered ground. A piece takes the
     commandery most of the land it adjoins is in, and stays out if the unadministered ground it touches
     outnumbers that: being in no commandery is a real answer about a piece of ground, most of this map
     being in none. */
  for (;;) {
    const round = new Map();
    for (const [h, cells] of S.adj.sub) {
      if (!S.hexes[h] || S.hexes[h].t === 'N/A') continue;
      const rs = cells.regions;
      for (let ri = 0; ri < rs.length; ri++) {
        if (!regWalkable(rs[ri])) continue;
        if (commCells.has(h + ':' + ri)) continue;
        const votes = new Map();
        let none = 0;
        for (const n of neighbors(h)) {
          if (!S.hexes[n] || S.hexes[n].t === 'N/A') continue;
          const nrs = regionsOf(n);
          for (let rj = 0; rj < nrs.length; rj++) {
            if (!regWalkable(nrs[rj]) || !regionsMeet(h, ri, n, rj)) continue;
            const c = commCells.get(n + ':' + rj);
            if (c === undefined) none++; else votes.set(c, (votes.get(c) || 0) + 1);
          }
        }
        let best = null, bn = 0;
        for (const [c, n] of votes) if (n > bn) { bn = n; best = c; }
        if (best !== null && bn > none) round.set(h + ':' + ri, best);
      }
    }
    if (!round.size) break;
    for (const [k, c] of round) commCells.set(k, c);
  }
  return commCells;
}

function commanderyBuild() {
  commIndex = new Map();
  commSeats = S.commanderies.map((c, i) => {
    for (const h of c.hexes) commIndex.set(h, i);
    let best = null;
    for (const h of c.hexes) {                    // ascending, so ties fall to the lowest hex
      /* Exactly the settlements the map draws, by asking the same function the renderer does. A
         datasheet stronghold with no marker of its own still counts, and counts as ordinary — the
         sheet says one is there, not what kind. One that has been **erased** does not: this used to
         fall back to the sheet whenever the filtered list came out empty, which quietly resurrected
         the very stronghold that had just been removed, and the province went on being named after
         a town that was no longer on the map. */
      for (const { m } of shEntries(h)) {
        const name = shName(h, m);
        if (!name) continue;
        const kind = shKindOf(m);
        if (!best || COMM_RANK[kind] < COMM_RANK[best.kind]) best = { h, name, kind };
      }
    }
    return best;
  });
}
/* The commandery a piece of ground is in, as { i, tier, name, hexes }, or null. `name` is null for one
   holding no named settlement at all — possible in principle, and better said than silently blanked.

   Answers for a **subhex** when given one, and for the hex as a whole when not. Both are wanted: the
   readout is pointing at one bank of a river and should say whether *that* bank is administered, while
   anything asking "is this hex in a commandery" — the search, the wash's own bookkeeping — means the hex.
   Asked about a hex, it falls back to the hex list, so a hex whose only land is an inherited sliver still
   answers rather than coming back empty. */
function commanderyAt(h, ri) {
  if (!commIndex) commanderyBuild();
  const i = ri == null ? commIndex.get(+h) : commanderyCells().get(+h + ':' + (ri | 0));
  if (i === undefined) return null;
  return { i, tier: S.commanderies[i].tier, name: commSeats[i]?.name ?? null,
           seat: commSeats[i]?.h ?? null, hexes: S.commanderies[i].hexes };
}
// Every named commandery, for the search. Unnamed ones are left out: there would be nothing to type.
function commanderyList() {
  if (!commIndex) commanderyBuild();
  const out = [];
  S.commanderies.forEach((c, i) => {
    if (commSeats[i]) out.push({ i, tier: c.tier, name: commSeats[i].name, hexes: commanderySize(i) });
  });
  return out;
}
/* How big a commandery is, in hexes — but counted over the ground it actually holds, so a shore province
   whose hexes are half water is not credited with the water. Whole hexes still count as one; a cut hex
   counts as the share of it that is land, and the total is rounded for display. Which means the number in
   the search rows can now differ from the length of the hex list in the JSON, and should: the list says
   which hexes it reaches into, and this says how much ground that comes to. */
function commanderySize(i) {
  const whole = wholeHexArea();
  let a = 0;
  for (const [k, ci] of commanderyCells()) {
    if (ci !== i) continue;
    const p = k.indexOf(':'), h = +k.slice(0, p);
    a += cellArea(regionsOf(h)[+k.slice(p + 1)]);
  }
  return Math.max(1, Math.round(a / whole));
}
function commanderyName(i) {
  if (!commIndex) commanderyBuild();
  return commSeats?.[i]?.name ?? null;
}

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
  return !!regSail(region(h, ri));                   // the subhex is itself navigable — a river bank
  /* And that is the whole of the inference: the water has to be **in this hex**. It used to reach
     over an edge as well — any neighbour with navigable water facing the same stretch of boundary
     made this a port — and the trouble with that is what a boundary is. A river drawn along the edge
     between two hexes is recorded in whichever of them the line falls in, so the hex on the other
     side of it borders navigable water without having any, and a stronghold there could secure a
     fleet and put out onto a channel that runs past the far side of its own boundary. Gerénéi was
     doing exactly that, seven days of shipwrighting at a keep with no water in its hex at all.

     Thirteen markers stop being ports by this, out of eighty-four. The ones that keep it are the ones
     with the water in front of them: a coast hex is split into land and sea subhexes, so a shore town
     has its own harbour by construction, and a river bank is navigable in its own right. */
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
  const reg = region(h, ri); if (!reg || !realHex(h)) return out;
  const hSplit = isSplit(h);
  // The datasheet carries three padding columns marked N/A. They are outside the world, not cheap
  // flatlands a Marines column may land on, so they must never enter the movement graph at all.
  const N = neighbors(h).filter(realHex)
    .map(n => ({ n, e: (hSplit || isSplit(n)) ? sharedEdgePts(h, n) : null }));
  if (af) { // afloat, ships === 1 — never on a road, so arrivals carry g: 0
    for (const { n, e } of N) { // sail across to any navigable region (sea OR river) — no port needed
      if (!regionOnEdge(h, ri, e)) continue;
      const rs = regionsOf(n);
      for (let rj = 0; rj < rs.length; rj++)
        // Merely reaching this edge somewhere is not enough: two bays can touch opposite ends of
        // it with dry ground between them. The regions themselves must face the same stretch.
        /* `regionsMeet` is there to stop a column *walking* over water that lies between two hexes'
           banks. Afloat it asks the wrong question, and where the drawn river runs **along** the
           shared edge it gives the wrong answer to every pair: all four banks touch that edge, the
           table rules them all out as separated by the water, and the water is precisely what the
           fleet is on. A boundary reach then carried nothing, and the Ayauda's own channel could not
           be sailed from one hex to the next — the search paid a day to go ashore and launch again on
           the far side instead, which is not a thing anybody does to get down a river they are
           already on. So on such an edge the meeting test is waived; being navigable, being on the
           edge, and the river actually running between the two are still all required. */
        if (regSail(rs[rj]) && regionOnEdge(n, rj, e) && waterLink(h, ri, n, rj) &&
            (regionsMeet(h, ri, n, rj) || S.adj.riverEdge.has(pairKey(h, n))))
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
    // A major-river region is both navigable water and walkable bank. Land in the region already
    // reached, instead of treating its ground half as permission to jump ashore from a different
    // river reach across a neighbouring edge.
    if (regWalkable(reg) && (o.marines || isPort(h, ri)))
      out.push({ toH: h, toRi: ri, af: 0, ships: 1, g: 0, irl: DISEMBARK, note: DISEMBARK_NOTE });
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
        // A navigable destination must be reached by the sailing loop above, which enforces the
        // river's actual drawn edge. This loop is only for stepping directly onto dry coast.
        if (regWalkable(rs[rj]) && !regSail(rs[rj]) && regionOnEdge(n, rj, e) &&
            regionsMeet(h, ri, n, rj) &&
            (o.marines || isPort(n, rj)))
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
    /* Launching straight into a *neighbouring* hex's water, the ship starting in it rather than
       having to reach it by a river mouth. This is the one place a fleet may enter water it could not
       have sailed to, and it is meant: a port is a place where boats are put in, and where the water
       in front of it belongs is a fact about which hex the drawn river fell in, not about the harbour.

       It was taken out for a day when a keep with **no water in its own hex** was using it to reach
       across a boundary and put a fleet on the channel beyond — and that turned out to be the wrong
       place to fix it, since it also cost the Ayauda its way down to the sea. The fix belongs in what
       counts as a port: a stronghold now needs the water to be in its own hex, so the keep that was
       reaching across is not a port at all and never gets here. */
    for (const { n, e } of N) {
      if (!regionOnEdge(h, ri, e)) continue;
      const rs = regionsOf(n);
      for (let rj = 0; rj < rs.length; rj++)
        if (regSail(rs[rj]) && regionOnEdge(n, rj, e) && regionsMeet(h, ri, n, rj))
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

/* ---------------- a route's colour is its own ----------------
   Routes used to draw from the one shared palette, which is the Warlords legend behind five spares —
   and the trouble with that is what the legend *is*. Those colours are the colours the map paints
   the ground in. Switch the Warlords or Borders layer on and a route in one of them is a line laid
   over an acre of itself: Legion VII's green route across Legion VII's green province is not a route
   you can follow, and the five spares ran out after five. Worse, a route that set out from a hex a
   counter was standing on **took that counter's colour automatically**, which was a nice idea — the
   V's road drawn in V's colour without anyone choosing it — and was the single most reliable way to
   get a march that vanished the moment the layer it matched came on.

   So routes have a palette of their own, ten colours chosen for one job: being a line, over this
   map, that nothing else on it is. Each is kept clear of the terrain beneath (mid-green Flatlands,
   tan Hills, grey-brown Mountains, the three blues of Ocean, Sea and Lake), of the drawn features it
   will be running along (orange roads, blue rivers), and of all seventeen realm washes — no pair
   within about ten of any of them by ΔE2000, and none within fourteen of each other. They are
   brighter and more saturated than any of that: the map's own colours are washes and fills, meant to
   be looked past, and a route is a line drawn on top and meant to be looked at.

   Orange leads because that is what a march is: it is the warmest, most forward colour on the wheel
   that this map does not already use for a *fill*, and the first route anyone draws should be the
   one that shouts. It is a hotter orange than the roads' burnt one, which is the one real
   compromise here — the two are within about eleven — and it is bearable because they are told apart
   by weight and shape rather than by hue: a road is a thin quiet line, a route is thicker, solid,
   and carries arrowheads. The order after it deliberately does not walk the rainbow. Consecutive
   routes want to be as unlike each other as possible, since routes one and two are the two on screen
   together, so the list jumps across the wheel each time — orange, ice, pink, green, violet — and
   only settles down once there are more marches than anyone reads at once. Paper and charcoal come
   last: they are the two answers to ground too dark or too pale for a hue, and want choosing rather
   than handing out. */
const ROUTE_COLORS = [
  '#ff9500',  // tangerine — the default march
  '#35e0ff',  // ice
  '#ff4d8d',  // hot pink
  '#5ef08a',  // spring green
  '#8f7dff',  // violet
  '#ffe14d',  // butter
  '#00d6b0',  // mint
  '#ff5c46',  // vermilion
  '#eceff3',  // paper — for a march through the mountains
  '#2b3440',  // charcoal — for one over snow or open water
];
/* Two routes in the same colour would defeat the point, so a new one takes the first colour nobody
   is using and only starts repeating once all ten are out. */
function freeRouteColor(used = new Set(S.routes.map(r => r.color))) {
  return ROUTE_COLORS.find(c => !used.has(c)) || ROUTE_COLORS[S.routes.length % ROUTE_COLORS.length];
}
/* Routes already in a browser when the palette changed are still wearing whatever the old one handed
   them, and for most of them that is a legion's colour — which is the fault, sitting on screen, that
   changing the palette was meant to fix. So they are moved across at the next load.

   Only the **legion and Blue Scarves** colours are touched. Those fifteen are what the realm layers
   paint the ground in and are the whole of the problem; the old five spares were chosen to stay clear
   of the map in the first place, two of them survive into the new list unchanged, and a route in one
   of them is a route that reads perfectly well — moving it would be changing a colour that was right
   for no reason but tidiness. Anything mixed by hand in the custom picker is likewise left alone: it
   was chosen, and a choice outranks a default.

   Quiet, and not an undo step. It runs before the map is on screen, against a state nobody has seen
   yet, so there is no "before" for a Ctrl+Z to go back to — and one that put a march back into Legion
   VII's green would be undoing the fix rather than an edit. */
function retireLegionRouteColors() {
  const retire = new Set([...LEGION_COLORS, WARLORD_HEX['Blue Scarves']].map(c => c.toLowerCase()));
  const used = new Set(S.routes.map(r => r.color).filter(c => !retire.has(String(c).toLowerCase())));
  for (const rt of S.routes) {
    if (!retire.has(String(rt.color).toLowerCase())) continue;
    rt.color = freeRouteColor(used);
    used.add(rt.color);
  }
}

// The quiet form is for callers that have already taken their own undo snapshot and mean the new
// route to be part of that same step — clicking bare map places a waypoint *and* the route to hold
// it, and one Ctrl+Z should take back both.
function newRouteQuiet() {
  S.routes.push({ name: 'Route ' + (S.routes.length + 1),
                  color: freeRouteColor(), wps: [],
                  // Copied, not shared: a second route for the same army starts already described,
                  // and then goes its own way the moment you change a box.
                  set: { ...activeSettings() } });
  S.activeRoute = S.routes.length - 1;
}
function newRoute() { pushUndoRoutes(); newRouteQuiet(); computeRoute(); }

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
  if (fail) return { irl: 0, hexes: 0, miles: 0, steps: [], pts: [], ends: null, fail };
  let best = null;
  for (const v of dp.values()) if (!best || v.cost < best.cost) best = v;
  if (!best) return { irl: 0, hexes: 0, miles: 0, steps: [], pts: [], ends: null, fail: null };
  /* What it cost to reach the last waypoint in each state the column could be standing there in —
     the DP's final column, handed on rather than thrown away. The route itself only needs the
     cheapest of them, but anything asking what a *further* leg would cost needs all three: arriving
     with ships is dearer and leaving with them may be cheaper, and which wins is not settled until
     the next destination is known. The hover preview below is the one thing that asks. */
  const ends = new Map([...dp].map(([k, v]) => [k, v.cost]));

  // The ordered drawn geometry a step traces from prevH into st.h (road or trade line, or a drawn
  // river for a sailing step). null when the step has no feature to follow (plain off-road).
  const stepGeom = (st, prevH) => {
    if (st.geom) return st.geom;            // road step / trade route (already oriented prevH→st.h)
    const key = pairKey(prevH, st.h), note = st.note || '';
    let g = note.startsWith('road') ? S.adj.geom.get(key) : null;
    if (!g && note.includes('sail')) g = S.adj.riverGeom.get(key);
    return g ? (g.a === prevH ? g.pts : [...g.pts].reverse()) : null;
  };
  /* A road does not stop at the hex boundary: it runs on to its own mid-hex point, and on a hex split
     by a major river that point can be **on the far bank**. Following it there draws the column
     across the water a step early, and the crossing that comes next then has to bring it back — an
     out-and-back over the bridge some twenty units long, invisible under a three-unit stroke except
     that it is long enough to turn an arrowhead round. A march heading north-east showed one head at
     the bridge pointing south-west.

     So a run's tail is cut back to the region the step it belongs to actually arrives in. Only the
     tail, and only inside that step's own hex: the head of the run is in the hex it came from and is
     none of this step's business. On a hex the river has not split there is one region and nothing to
     cut. */
  const clipToRegion = (pts, h, ri) => {
    if (!pts || pts.length < 2 || !isSplit(h)) return pts;
    let end = pts.length - 1;
    while (end > 0 && nearestHex(pts[end][0], pts[end][1]) === h && regionAt(h, pts[end]) !== ri) end--;
    return end === pts.length - 1 ? pts : pts.slice(0, end + 1);
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
    // Afloat and with no drawn river to trace: aim at the water rather than at the bank's midpoint.
    // A stop keeps its marker either way — the ring is drawn there and the line must agree with it.
    const afloatAt = (!wp && /sail/.test(st.note || '') && riverPointIn(st.h, st.ri)) || anchor;
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
    const gpts = clipToRegion(stepGeom(st, ph), st.h, st.ri);
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
    /* A step that changes only the column's *state* — going ashore, taking ship, spending the month
       securing one — does not move it an inch, and so has nothing to contribute to the line: it
       happens where the line already is. Drawing it anyway meant drawing to the subhex's own centre,
       and on a bank that centre is nowhere near the water. Coming off the sea at Akanin to launch
       again into the next reach, the line left the river, struck out twenty-two units across dry
       country to the middle of the bank, and came back. */
    const prev = flat[idx - 1]?.st;
    if (prev && st.h === prev.h && (st.ri | 0) === (prev.ri | 0)) continue;
    /* The shortcut above is a cosmetic liberty — the column *was* at this node, and the only reason
       to leave it out is that drawing in and out again looks like a spike. It is only a liberty while
       it stays honest about the water. Cutting the corner off a hex whose two halves are split by a
       major river draws a straight line from wherever the column came in to wherever it is going
       next, and where the river bends between those two points that line goes over it and back — so a
       march that forded once was drawn fording three times, which is a claim about the ground and not
       a matter of taste. So the corner is only cut when cutting it crosses nothing: otherwise the
       node the column actually stood on goes back in, and the line goes round the bend the long way,
       the way the column did. */
    if (staysInHex) {
      /* Unless the step that follows is the crossing itself, in which case the line is *supposed* to
         go over the water and asking whether it does is asking the wrong question. It cost a spike
         seventeen units long at the bridge in 1694, the line detouring up to the node and back purely
         to avoid a ford it was in the middle of making. */
      const crossing = /bridge|ford|ferry|sail/i.test(nxt.st.note || '');
      const from = allPts[allPts.length - 1];
      const ng = stepGeom(nxt.st, st.h);
      const to = ng && ng.length ? ng[0]
               : (nxt.wp ? endPoint(nxt.st.h, nxt.st.ri) : nodePoint(nxt.st.h, nxt.st.ri));
      if (crossing || !from || !to || !segCrossesMajor(from, to)) continue;
      allPts.push(afloatAt);
      continue;
    }
    // Off-road / plain march (no feature to trace). If the next step rejoins a drawn feature
    // (a road), aim straight at where we rejoin it — its nearest end in this hex — rather than
    // detouring through the hex centroid, which leaves a jagged corner at the point of diversion.
    let joinPt = null;
    if (nxt) {
      const ng = stepGeom(nxt.st, st.h);
      if (ng && ng.length) joinPt = ng[0];
    }
    allPts.push(joinPt || afloatAt);
  }
  // A geometry step (sailing a river, or a road) ends at the feature's mid-hex point, which can
  // stop short of the destination hex's node point (its marker) — e.g. getting off a river into
  // the hex left the final leg undrawn. Connect the line to the last waypoint's marker.
  if (flat.length) {
    const last = flat[flat.length - 1].st, np = endPoint(last.h, last.ri), lp = allPts[allPts.length - 1];
    if (!lp || Math.hypot(lp[0] - np[0], lp[1] - np[1]) > 0.5) allPts.push(np);
  }
  return { irl: best.cost, hexes: totHex, miles: totMiles, steps, pts: throughSharedEdges(allPts),
           ends, fail: null };
}

/* ---------------- the march as orders: whole days, one order per halt ----------------
   A column marches under orders written in whole days, so the fraction left over when it halts is
   spent whether it was needed or not: a run of 3.2 days is a four-day order, and the 0.8 is gone.
   That is the figure a plan is actually made in, so it is the one a route now reports — with the
   exact total kept beside it, because the difference between the two *is* the waste, and the waste
   is what a better order of waypoints removes.

   A waypoint the column only **passes through** breaks no march. No order ends there, so its leg
   runs straight on into the next and the rounding waits for the next halt. Arriving is always a
   halt: the march is over, and the day it ends in is spent. Setting out is never one — nothing has
   been ordered yet. */
/* Two switches, one question. The route's box says whether the column halts at its waypoints at all;
   a waypoint's own flag excuses just that one. Absent means yes on both counts — a waypoint is
   somewhere to be, and being somewhere takes a day. Arrival is not asked about: the march ends there
   whatever the boxes say, so the callers that care about arriving handle it themselves. */
const routeStops = rt => rt?.set?.stops !== false;
const wpHalt = (rt, wi) => routeStops(rt) && !rt?.wps?.[wi]?.thru;

function legCosts(rt, r) {
  const legs = new Array(Math.max(0, rt.wps.length - 1)).fill(0);
  for (const st of r.steps) if (st.leg < legs.length) legs[st.leg | 0] += st.irl;
  return legs;
}
// Ordered days for a march over `legs`, asking `isHalt(wi)` whether the column stops at each waypoint
// it reaches, with `final` deciding whether the end of the list is an arrival (it is, for a whole
// route) or a stop the column is about to march on from (it is not, for the hover preview).
function orderedFor(legs, isHalt, final = true) {
  let days = 0, pending = 0, exact = 0, halts = 0;
  for (let i = 0; i < legs.length; i++) {
    pending += legs[i]; exact += legs[i];
    const last = i === legs.length - 1;
    if ((last && final) || isHalt(i + 1)) { days += optDays(pending); pending = 0; halts++; }
  }
  return { days, exact, pending, halts, waste: days + pending - exact };
}
// What a solved route costs in orders. Null when there is nothing solved to bill.
function orderedOf(rt, r) {
  if (!rt || !r || r.fail || rt.wps.length < 2) return null;
  return orderedFor(legCosts(rt, r), wi => wpHalt(rt, wi));
}
// The short form the row, the map button and the card heading all say: whole days if the march is
// solved, and the exact figure only in the tooltip, where there is room to explain itself.
function routeDays(rt, r) {
  const o = orderedOf(rt, r);
  return o ? o.days + 'd' : r.irl.toFixed(1) + 'd';
}
function routeDaysTitle(rt, r) {
  const o = orderedOf(rt, r);
  return o ? `${o.days} IRL days ordered — ${o.exact.toFixed(1)} marched, ${o.waste.toFixed(1)} wasted at ${o.halts} halt${o.halts === 1 ? '' : 's'}` : '';
}

/* ---------------- the best order to visit them in ----------------
   Given a set of places a column has to reach, the order it reaches them in is a decision worth as
   much as the roads it takes: on ground this size the difference between a sensible-looking order and
   the best one is routinely several days. Done by hand it is dragging waypoints about and reading the
   total off the card, one arrangement at a time, which is exactly the kind of search a machine should
   be doing.

   It is billed in **orders**, not in exact days, because that is what the reordering is for. Two
   arrangements that march 11.4 and 11.9 days cost the same twelve days of orders if they halt in the
   same places, and an arrangement that marches *further* can cost a day less by landing its halts
   more tidily. Sorting on the exact total would hand back the wrong answer with great precision.

   Held-Karp over subsets: exact, and small enough here to stay exact — a dozen waypoints is 4,096
   subsets, and the real cost is the pathfinding, one field per waypoint per state it can set out in,
   built only when the search actually needs it. What makes it more than a plain travelling-salesman
   problem is the state the column carries between legs (afloat, ashore with ships, ashore without)
   and the rounding, which is not additive: a run through pass-through waypoints is rounded once at
   its end, so a partial answer is described by a pair — orders already spent, and the fraction still
   running — and neither alone decides which of two partial answers is worth keeping. Both are kept,
   as a small Pareto frontier per subset, and the pair that dominates wins. With every waypoint a halt
   the frontier is one entry deep and this reduces to the ordinary DP. */
// Where the exact search stops being instant. Measured, not guessed: fifteen waypoints is about
// eight-tenths of a second all in, and the subsets double with every one after that.
const OPT_MAX_WPS = 15;

function optimiseRouteOrder(rt, mode) {
  const wps = rt.wps, n = wps.length;
  const o = armyOpts(rt.set);
  // With halts switched off the whole march is one order and the arrangement is judged on the exact
  // total after all — every order rounds once, at the end, so the rounding stops discriminating.
  const stops = routeStops(rt);
  // The forced-march flag says "push on from here", so it belongs to the waypoint and travels with it
  // when the order changes — a leg is solved at the pace of the stop it sets out from.
  const oAt = k => (wps[k].f && !o.forced ? { ...o, forced: true } : o);
  const statesAt = k => {
    const f = forcedAf(region(wps[k].h, wps[k].ri | 0));
    return STATES.filter(([af]) => f === null || af === f).map(([af, sh]) => af * 2 + sh);
  };
  /* One Dijkstra field per (waypoint, departure state), read for the cost to every other waypoint in
     every state it can arrive in — the whole cost matrix from a handful of searches. Memoised and
     built on demand, so a state no arrangement can actually leave in is never searched from. */
  const fields = new Map();
  const costsFrom = (k, st) => {
    const id = k + ':' + st;
    const hit = fields.get(id);
    if (hit) return hit;
    const F = dijkstraField(wps[k].h, wps[k].ri | 0, st >> 1, st & 1, oAt(k));
    const out = wps.map((w, j) => {
      const m = new Map();
      if (j === k) return m;
      for (const [af, sh] of STATES) {
        let best;
        for (let g = 0; g < 8; g++) {
          const c = F.dist.get(sk(w.h, w.ri | 0, af, sh, g));
          if (c !== undefined && (best === undefined || c < best)) best = c;
        }
        if (best !== undefined) m.set(af * 2 + sh, best);
      }
      return m;
    });
    fields.set(id, out);
    return out;
  };

  const full = (1 << n) - 1;
  const key = (mask, last, st) => (mask * n + last) * 4 + st;
  const dp = new Map();
  // A partial answer is kept unless another is no worse on every count. Orders spent and the fraction
  // still running are both compared, because a smaller number of orders bought by leaving a nearly
  // full day running is not obviously better — the next halt may pay for it.
  const push = (k, e) => {
    const a = dp.get(k);
    if (!a) { dp.set(k, [e]); return; }
    for (const x of a)
      if (x.days <= e.days && x.pending <= e.pending + 1e-9 && x.exact <= e.exact + 1e-9) return;
    const keep = a.filter(x => !(e.days <= x.days && e.pending <= x.pending + 1e-9 && e.exact <= x.exact + 1e-9));
    keep.push(e);
    dp.set(k, keep);
  };

  const [af0, sh0] = startState(wps[0].h, wps[0].ri | 0, o);
  push(key(1, 0, af0 * 2 + sh0), { days: 0, pending: 0, exact: 0, prev: null, at: 0 });

  const fixedEnd = mode === 'ends' ? n - 1 : -1;
  for (let mask = 1; mask <= full; mask++) {
    if (!(mask & 1)) continue;                       // every arrangement sets out from the first stop
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last))) continue;
      for (const st of statesAt(last)) {
        const a = dp.get(key(mask, last, st));
        if (!a || !a.length) continue;
        const cs = costsFrom(last, st);
        for (let j = 0; j < n; j++) {
          if (mask & (1 << j)) continue;
          const next = mask | (1 << j);
          // A fixed finish is only ever reached last, so it is not allowed to be stepped on early.
          if (j === fixedEnd && next !== full) continue;
          for (const [st2, c] of cs[j]) {
            const halt = stops && !wps[j].thru;
            for (const e of a) {
              const pend = e.pending + c;
              push(key(next, j, st2), halt
                ? { days: e.days + optDays(pend), pending: 0, exact: e.exact + c, prev: e, at: j }
                : { days: e.days, pending: pend, exact: e.exact + c, prev: e, at: j });
            }
          }
        }
      }
    }
  }

  // The finish. Arriving is a halt whatever the boxes say, so whatever is still running is rounded up.
  let best = null;
  for (let last = 0; last < n; last++) {
    if (fixedEnd >= 0 && last !== fixedEnd) continue;
    for (const st of statesAt(last)) {
      for (const e of dp.get(key(full, last, st)) || []) {
        const days = e.days + optDays(e.pending);
        if (!best || days < best.days || (days === best.days && e.exact < best.exact - 1e-9))
          best = { days, exact: e.exact, end: e };
      }
    }
  }
  if (!best) return null;

  const order = [];
  for (let e = best.end; e; e = e.prev) order.push(e.at);
  order.reverse();
  return { order, days: best.days, exact: best.exact };
}

/* The button and the menu both come here. The search is a second or two of pathfinding on a big
   route, which is a second or two the page cannot paint through, so the button says what it is doing
   and is given a frame to say it in before the work starts. */
async function runOptimise(i, mode) {
  const rt = S.routes[i];
  if (!rt) return;
  if (rt.wps.length < 3) return toast('Nothing to reorder — a route needs three waypoints or more', true);
  if (rt.wps.length > OPT_MAX_WPS)
    return toast(`Too many waypoints to search exactly — ${OPT_MAX_WPS} is the limit`, true);
  if (mode === 'ends' && rt.wps.length < 4)
    return toast('With both ends held there is nothing left to reorder', true);
  if (!S.adj) deriveAdj();
  const btn = document.getElementById('optRoute');
  const was = btn?.textContent;
  if (btn) { btn.textContent = 'Optimising…'; btn.disabled = true; }
  await new Promise(r => setTimeout(r, 20));
  let res = null;
  try { res = optimiseRouteOrder(rt, mode); }
  finally { if (btn) { btn.textContent = was; btn.disabled = false; } }
  if (!res) return toast('No order reaches every waypoint with these settings', true);
  const before = orderedOf(rt, lastResults[i]);
  const wps = rt.wps;
  const next = res.order.map(k => wps[k]);
  const same = next.length === wps.length && next.every((w, k) => w === wps[k]);
  if (same) return toast(`${rt.name} is already in the best order — ${res.days} d`);
  pushUndoRoutes();
  rt.wps = next;
  S.activeRoute = i;
  computeRoute();
  toast(before ? `${rt.name}: ${before.days} d → ${res.days} d` : `${rt.name}: ${res.days} d`);
}
// The three questions the button can be asking, kept in one place so the panel and the route menu
// cannot offer different ones.
function optimiseMenu(i) {
  return box => {
    ctxHead(box, `<b>${escHtml(S.routes[i]?.name || 'Route')}</b> — best order`);
    ctxItem(box, 'Keep the start<span class="arw">finish anywhere</span>',
            () => { closeCtx(); runOptimise(i, 'start'); });
    ctxItem(box, 'Keep both ends<span class="arw">first and last stay</span>',
            () => { closeCtx(); runOptimise(i, 'ends'); });
  };
}

/* ---------------- where the next click would get you ---------------- */
/* Placing a waypoint answers "how long does that take"; the readout under the cursor answers it
   before the click, which is the order the question is actually asked in — you are hunting for the
   hex the column can reach in four days, not checking one you have already committed to.

   One Dijkstra field out of the route's last stop answers it for every hex on the map at once, so
   the work is done once per change to the route and each hover is a lookup. That field is exactly
   what a leg costs to solve — dijkstraLeg builds the same thing and then reads one hex out of it —
   so this is one extra leg's worth of work, paid on the first hover after a change rather than
   eagerly, since a route nobody is measuring should cost nothing.

   Up to three fields, one per state the column can be standing at the last waypoint in (afloat,
   ashore with ships, ashore without), because which of them is cheapest to *leave* from is not
   settled until the destination is known. Taking the minimum over all of them at lookup time is the
   same joint optimisation routeLeg does across its legs. */
let routeProbe = null;
function routeProbeFields() {
  if (routeProbe) return routeProbe.fields;
  // `banked` is the orders already spent at the last halt and `pending` the run still going, so the
  // preview can bill a further leg the way the route does: the fraction only rounds when it stops.
  routeProbe = { fields: [], banked: 0, pending: 0, baseExact: 0 };
  const rt = S.routes[S.activeRoute];
  if (!rt || !rt.wps.length) return routeProbe.fields;
  const o = armyOpts(rt.set);
  const last = rt.wps[rt.wps.length - 1], lh = last.h, lri = last.ri | 0;
  let ends;
  if (rt.wps.length === 1) {
    // A route of one waypoint has not set out: the column is standing on it having spent nothing.
    const [af, sh] = startState(lh, lri, o);
    ends = new Map([[af * 2 + sh, 0]]);
  } else {
    const r = lastResults[S.activeRoute];
    // A route that cannot be walked as far as its last stop has nothing to add a leg to. The panel
    // already says which pair of hexes defeated it; the readout stays quiet rather than blaming
    // every hex on the map for it.
    if (!r || r.fail || !r.ends) { routeProbe.broken = true; return routeProbe.fields; }
    ends = r.ends;
    // Not billed as an arrival: the column is standing at the last waypoint about to march on, so a
    // run that has not halted yet is still running and rounds only when it finally stops.
    const o = orderedFor(legCosts(rt, r), wi => wpHalt(rt, wi), false);
    routeProbe.banked = o.days; routeProbe.pending = o.pending;
    // Lookups come back as an exact total from the route's first waypoint; this is what to subtract
    // to leave the part that is new. A state dearer to arrive in carries its surcharge with it, which
    // is right: paying a day for ships to reach the hovered hex is a day this leg costs.
    routeProbe.baseExact = r.irl;
  }
  // The forced-march flag sits on the waypoint a push starts *from*, so a forced last leg means the
  // leg being previewed is forced too — solved at that pace, not rescaled after the fact.
  const lo = last.f && !o.forced ? { ...o, forced: true } : o;
  for (const [state, cost] of ends)
    routeProbe.fields.push({ cost, F: dijkstraField(lh, lri, state >> 1, state & 1, lo) });
  return routeProbe.fields;
}
// The cheapest the column could be standing on this subhex, whatever state it arrives in and
// whichever road it arrives on — the same minimisation dijkstraLeg makes at a fixed destination.
function routeProbeCost(h, ri) {
  const fields = routeProbeFields();
  if (!fields.length) return null;
  let best;
  for (const f of fields)
    for (const [af, sh] of STATES)
      for (let g = 0; g < 8; g++) {
        const c = f.F.dist.get(sk(h, ri, af, sh, g));
        if (c === undefined) continue;
        const t = f.cost + c;
        if (best === undefined || t < best) best = t;
      }
  return best === undefined ? null : best;
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
const isoHolds = (h, ri, o) => realHex(h) && (o.fleet || o.secureFleet || regWalkable(region(h, ri)));

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
    if (!realHex(id)) continue;
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
const ISO_COLORS = PALETTE;      // the grid an origin's swatch opens, in the one order
/* Handing out is a different question from reading. An origin's colour is drawn as a thin outline
   around the ground it claims, and the two quietest spares — near-white and charcoal — are the two
   worst lines to draw over a map that is already pale in the north and dark in the mountains. So a
   new origin is offered the strong hues first, while its picker still shows the same grid as
   everything else. */
const ISO_PICK = [...LEGION_COLORS, WARLORD_HEX['Blue Scarves'], ...PALETTE_SPARE];
function freeIsoColor() {
  const used = new Set(S.iso.origins.map(o => o.color));
  return ISO_PICK.find(c => !used.has(c)) || ISO_PICK[S.iso.origins.length % ISO_PICK.length];
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
    // Origins are controls as well as symbols. A transparent disc makes the small ring easy to grab;
    // the visible circle ignores pointer events so the group owns the whole gesture consistently.
    const g = el('g', { 'data-iso-origin': i, style: 'cursor:grab' }, groups.iso);
    el('circle', { cx: ox, cy: oy, r: (act ? 6.5 : 5.5) + 4, fill: 'transparent', stroke: 'none' }, g);
    el('circle', { cx: ox, cy: oy, r: act ? 6.5 : 5.5, fill: '#fff', stroke: og.color,
                   'stroke-width': act ? 2.8 : 2, 'pointer-events': 'none' }, g);
  });
  // Waste is not a distance, and five chips reading "0.4–0.6 d" would be taken for one if left
  // unlabelled beside the band legend they replace.
  if (opt || relief) {
    const cap = document.createElement('div');
    cap.className = 'isocap';
    cap.textContent = relief ? 'Total days: news out, relief march back:'
                             : 'Time lost by rounding up:';
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

/* ---------------- drawing a march so it can be read ----------------
   A long route was the hardest thing on this map to look at, for two reasons that have nothing to do
   with the solving and everything to do with the drawing.

   The first is that a column that comes back the way it went lays the return leg **exactly** on top
   of the outward one. Both passes trace the same road geometry, so the second is drawn over the
   first pixel for pixel and simply vanishes: a route out to Kisra and home again looked like a route
   to Kisra, and the twelve days it billed for looked like six days' worth of line. The fix is to give
   each pass over the same stretch a lane of its own — one stop-marker's radius to the walker's left —
   so a doubled road reads as two lines running together, which is what it is, and the turn at the end
   of it comes out as a circle of exactly that marker's radius about exactly its centre. Only stretches
   that are actually doubled move; a route that never crosses its own path is drawn exactly where it
   always was, still sitting on the road it follows.

   The second is that a line has no direction. Which end a march starts from was readable only by
   finding the waypoint list and counting, and on a route that loops it was not readable at all. So
   the line is now **solid** and carries arrowheads along it at a fixed spacing. The dashes were
   doing a job — they said "this is a plan, not a drawn feature" — but the colour already says that
   (roads are orange, a route wears its own swatch), and a dashed line broken again by arrows is two
   kinds of interruption arguing with each other. Solid, with arrows, says both things at once: one
   continuous march, going that way. */

/* The stop marker, in the two sizes it comes in: the ring's radius and the weight of its outline.
   Named rather than written where they are drawn because the lane spacing is derived from them, and
   a lane gap that quietly stopped matching the marker would be the one thing worse than no lanes. */
const wpR = act => act ? 6 : 5;
const wpSW = act => act ? 2.4 : 1.8;
/* Where two lines meet, each given as two points on it. Null when they run parallel and never do. */
function lineMeet(p1, p2, p3, p4) {
  const d1 = [p2[0] - p1[0], p2[1] - p1[1]], d2 = [p4[0] - p3[0], p4[1] - p3[1]];
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return null;
  const r = [p3[0] - p1[0], p3[1] - p1[1]];
  const t = (r[0] * d2[1] - r[1] * d2[0]) / den;
  return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
}

/* ---------------- the turn at the end of an out-and-back ----------------
   Where the column turns round, the two lanes have to be joined, and joining them with a straight run
   across gives a square fold a lane wide — a notch, and a notch is not what a road doing a hairpin
   looks like. It is drawn as an **arc about the vertex the line turned at** instead.

   That arc is tangent to both lanes for free, and the reason is worth stating because it is what the
   whole scheme rests on: a lane's offset is *perpendicular to its direction of travel*, so the radius
   from the vertex out to where a lane passes meets that lane at a right angle. Any circle centred on
   the vertex therefore leaves and rejoins the lanes running exactly the way they were already going.
   Nothing has to be fitted, and the turn's radius is simply how far out the lane is.

   Which is why the lanes are placed **at the marker's own radius**: the turn at a stop is then a
   circle of exactly the ring's radius, centred on exactly the ring's centre, so the loop and the ring
   are the same circle. The hairpin does not sit near the marker or inside it — it *is* the marker,
   traced by the line that made it.

   Which way round it goes is not chosen, and must not be. The lanes keep *left of travel*, so the
   only sweep that leaves and rejoins them running the right way is the one that carries on past the
   turn before coming back — a sweep the other way would cut across the approach and cross the very
   lines it is joining. Continuing the incoming direction is therefore both the tangent condition and
   the no-crossing condition, and there is exactly one arc that satisfies it. */
const ARC_STEP = Math.PI / 12;   // how finely an arc is sampled into the polyline: 15° a side

/* Null when the arc that satisfies the tangent condition would have to sweep more than half a circle,
   which is the one answer that is never the right one. Nothing here ever asks for more than a
   half-turn: a fillet turns by however much the corner turns, which is less than a straight-about, and
   a hairpin turns by exactly a straight-about. A sweep of anything more means the two ends handed in
   are not what they were taken for — the commonest way being that they are *nearly the same point*,
   where the direction to leave in decides between "no turn at all" and "all the way round", and lands
   on all the way round. That is what was drawing a pretzel where a route recrossed itself at a bridge:
   a knot of three-unit steps threw up two joins whose ends stood half a unit apart, and each was
   answered with a full 360° loop of the lane's own radius. Handing back null lets the caller draw the
   short honest join instead. */
function turnArc(P, e, s, u1) {
  const r = Math.hypot(e[0] - P[0], e[1] - P[1]);
  const a0 = Math.atan2(e[1] - P[1], e[0] - P[0]), a1 = Math.atan2(s[1] - P[1], s[0] - P[0]);
  // Which way round: the way that carries on in the direction the line was already going. The cross
  // product of the radius at `e` with that direction is positive exactly when the angle should grow.
  const ccw = (e[0] - P[0]) * u1[1] - (e[1] - P[1]) * u1[0] > 0;
  const TAU = Math.PI * 2;
  let d = a1 - a0;
  d = ccw ? ((d % TAU) + TAU) % TAU : -((((-d) % TAU) + TAU) % TAU);
  if (!(r > 1e-9) || Math.abs(d) > Math.PI + 0.05) return null;
  const steps = Math.max(2, Math.ceil(Math.abs(d) / ARC_STEP));
  const out = [];
  for (let k = 0; k <= steps; k++) {
    const a = a0 + d * k / steps;
    out.push([P[0] + r * Math.cos(a), P[1] + r * Math.sin(a)]);
  }
  return out;
}

/* ---------------- rounding the bends ----------------
   A solved route is a polyline through node points, road ends and edge touch-downs, and a polyline
   turns corners. On a march that follows a coast or a river through a dozen hexes those corners come
   thick and fast, and drawn sharp they read as a jagged thing rather than a road — the mitre is
   geometrically right and the eye reads it as damage. Every bend is therefore given a fillet: a
   circular arc tangent to both sides, cutting the corner off.

   Two limits, and they matter more than the radius does. A fillet may take **no more than a shade
   under half of either segment it sits between**, so two fillets on a short segment cannot eat into
   each other, and a corner between two two-unit hops is left alone rather than rounded into mush. And
   it may not carry the line **more than a few units off its own corner**, whatever the radius asks
   for, because that corner is often a touch-down `throughSharedEdges` planted on the edge between two
   hexes precisely to keep the line inside them — round it too generously and the tidying that put it
   there is undone. Both clamps work by shortening the tangent and re-deriving the radius from it, so
   the arc stays tangent whichever of them bites.

   It runs over the *drawn* line rather than the solved one, after the lanes and their tapers, so a
   route that never doubles back is rounded too, and so are the joins the lanes introduce. The
   hairpins come through untouched: they are already arcs, and an arc's own sampling turns through
   fifteen degrees at a time, which is below the angle worth filleting. */
const BEND_R = 18;     // the radius a corner is rounded to when nothing stops it
const BEND_DEV = 6;    // ...but never leaving its own corner by more than this, an eighth of a hex

function roundBends(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i + 1 < pts.length; i++) {
    const A = pts[i - 1], V = pts[i], B = pts[i + 1];
    const L1 = Math.hypot(V[0] - A[0], V[1] - A[1]), L2 = Math.hypot(B[0] - V[0], B[1] - V[1]);
    if (L1 < 1e-9 || L2 < 1e-9) continue;
    const u1 = [(V[0] - A[0]) / L1, (V[1] - A[1]) / L1], u2 = [(B[0] - V[0]) / L2, (B[1] - V[1]) / L2];
    const phi = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    // Straight enough not to be a corner, or so nearly doubled back that there is no corner to round.
    if (phi < 0.02 || Math.PI - phi < 0.05) { out.push(V); continue; }
    const tn = Math.tan(phi / 2);
    const want = Math.min(BEND_R, BEND_DEV / (1 / Math.cos(phi / 2) - 1));
    const t = Math.min(want * tn, L1 * 0.45, L2 * 0.45), r = t / tn;
    if (r < 0.2) { out.push(V); continue; }
    const p1 = [V[0] - u1[0] * t, V[1] - u1[1] * t], p2 = [V[0] + u2[0] * t, V[1] + u2[1] * t];
    // Rounding a corner is a liberty with the geometry, and like every other one here it stops at the
    // water: a corner cut across a bend in a major river would draw a ford the column never made.
    if (segCrossesMajor(p1, p2) && !segCrossesMajor(p1, V) && !segCrossesMajor(V, p2)) { out.push(V); continue; }
    const sgn = u1[0] * u2[1] - u1[1] * u2[0] > 0 ? 1 : -1;   // the centre lies to the inside of the turn
    const fillet = turnArc([p1[0] - u1[1] * r * sgn, p1[1] + u1[0] * r * sgn], p1, p2, u1);
    if (fillet) out.push(...fillet); else out.push(V);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/* How far the line takes to ease from one lane into the next, in world units — about half a hex. A
   lane change used to happen at a point: the offset was a per-segment constant, so where the count of
   passes changed the line stepped sideways in no distance at all and left a hard zigzag exactly where
   two tracks were meant to be separating. Worse, at a shallow crossing the step went the *wrong* way
   for the eye — it brought the two tracks together for the length of the step before they parted. The
   offset is now a function of distance along the line rather than of which segment you are on, and it
   eases across on a smoothstep centred on the vertex, so the tracks drift apart the way two roads
   diverging actually look. */
const TAPER = 30;
const TAPER_N = 8;                        // samples across one ease; enough that the curve reads as one
const smoothstep = t => t * t * (3 - 2 * t);

function fanOutRetraced(pts, R) {
  if (pts.length < 3) return pts;
  /* Two passes over one stretch are not bit-identical: a road's geometry arrives reversed on the way
     back, and the touch-downs `throughSharedEdges` plants are recomputed from the segment the other
     way round. So segments are matched on a quarter-unit grid — far below anything that could be two
     different places on a map whose hexes are fifty units across, and comfortably above the last few
     bits of a float. */
  const key = p => Math.round(p[0] * 4) + ',' + Math.round(p[1] * 4);
  const P = pts.filter((p, i) => !i || key(p) !== key(pts[i - 1]));   // a zero-length hop has no side
  const n = P.length - 1;
  if (n < 2) return pts;
  /* Passes are counted two ways. **Undirected** says whether a stretch is doubled at all, since a
     stretch walked once wants leaving exactly where it is. **Directed** says how many passes are
     going the same way along it, which is what decides how far out a pass sits. */
  const und = [], dir = [], count = new Map();
  for (let i = 0; i < n; i++) {
    const ka = key(P[i]), kb = key(P[i + 1]);
    und.push(ka < kb ? ka + '|' + kb : kb + '|' + ka);
    dir.push(ka + '>' + kb);
    count.set(und[i], (count.get(und[i]) || 0) + 1);
  }
  // The overwhelmingly common case, and the one where any nudge at all would be a lie about where the
  // column walked. Hand the line straight back rather than rebuild it identically.
  if (![...count.values()].some(c => c > 1)) return pts;

  const u = [], nrm = [], cum = [0];
  for (let i = 0; i < n; i++) {
    const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], L = Math.hypot(dx, dy);
    u.push([dx / L, dy / L]);
    nrm.push([dy / L, -dx / L]);       // the left hand of whoever is walking this segment
    cum.push(cum[i] + L);
  }
  /* ---------------- which lane each pass runs in ----------------
     A stretch walked more than once has to spread its passes across it, and there are two questions:
     how wide, and in what order. The order is the one that used to be got wrong, twice.

     First it was a canonical ordering of the segment's two endpoints, which is a fact about the hex
     ids and not about the march, so the outward leg's side was arbitrary and could change from one
     segment to the next. Then it was **keep left** — measured off the walker, so an out-and-back
     straddles the road on its own, left of east being north and left of west south. That is right
     for two passes going opposite ways and wrong for two going the *same* way, which it stacked one
     outside the other on the same side of the road: two tracks running alongside each other with the
     road bare beside them, and, where they finally parted, the one heading south obliged to cross the
     one heading north to get there.

     So the passes are **ordered by where they are going**. A pass is a run of doubled segments walked
     without turning round; every pass over one stretch belongs to a corridor; and each pass leans to
     one side or the other by the road it came in on and the road it leaves by, measured against the
     corridor's own frame. Sorted by that lean and laid out in order, the pass that peels off south
     is on the south side of the stretch before it peels — which is the whole point of separating
     them, and is also exactly what stops them crossing at the point they part.

     For an out-and-back this reduces to what keep-left already did: the outward and return lean by
     their approach and their departure, which are at opposite ends of the corridor, and the hairpin
     at the far end joins the two lanes it finds. Lanes are two marker radii apart, so a pair sits at
     ±R and the half-turn between them comes out at exactly the marker's radius — see turnArc. The
     spread is capped at three radii either way; six passes over one stretch is past telling apart,
     and letting it grow would fling the outermost lane most of a hex clear of the road. */
  const doubled = i => count.get(und[i]) >= 2;
  const isRev = j => j > 0 && j < n && u[j - 1][0] * u[j][0] + u[j - 1][1] * u[j][1] < -0.5;

  // Corridors: doubled segments joined by lying next to each other along the march, or by being the
  // same ground walked again. Consecutive segments must agree on the lane order or a track would
  // change sides midway; two passes over one stretch must differ or they would be drawn on top of
  // each other. Both hold if the whole corridor is ordered at once.
  const parent = [...Array(n).keys()];
  const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const seen = new Map();
  for (let i = 0; i < n; i++) {
    if (!doubled(i)) continue;
    if (i && doubled(i - 1)) join(i - 1, i);
    const had = seen.get(und[i]);
    if (had === undefined) seen.set(und[i], i); else join(had, i);
  }
  // Passes: maximal runs of consecutive doubled segments in one corridor. Broken at a reversal,
  // since the two halves of a hairpin are two passes and want opposite lanes, not one lane through.
  const passes = [];
  for (let i = 0; i < n; ) {
    if (!doubled(i)) { i++; continue; }
    const c = find(i);
    let j = i;
    while (j + 1 < n && doubled(j + 1) && find(j + 1) === c && !isRev(j + 1)) j++;
    passes.push({ c, i0: i, i1: j });
    i = j + 1;
  }
  const byCorridor = new Map();
  for (const p of passes) (byCorridor.get(p.c) || byCorridor.set(p.c, []).get(p.c)).push(p);

  const d = new Array(n).fill(0);
  for (const ps of byCorridor.values()) {
    const N0 = nrm[ps[0].i0];                       // the corridor's frame: its first pass's left hand
    // How far to the left of that frame the step from `a` to `b` leans.
    const lean = (a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      return L > 1e-9 ? (dx * N0[0] + dy * N0[1]) / L : 0;
    };
    for (const p of ps) {
      p.s = 0;
      // The road it came in on. Nothing to read where the pass begins the march, or where what comes
      // before is the other half of a hairpin — that end is the turn, and the turn has no side.
      if (p.i0 > 0 && !doubled(p.i0 - 1)) p.s += lean(P[p.i0], P[p.i0 - 1]);
      if (p.i1 + 1 < n && !doubled(p.i1 + 1)) p.s += lean(P[p.i1 + 1], P[p.i1 + 2]);
    }
    ps.sort((a, b) => a.s - b.s || a.i0 - b.i0);
    ps.forEach((p, k) => {
      const off = Math.max(-3, Math.min(3, (k - (ps.length - 1) / 2) * 2)) * R;
      /* The offset is stored against each segment's own left hand, so a pass walking the corridor
         backwards needs its sign flipped. Carried along the pass rather than compared to the frame
         segment by segment: a corridor that curves through a right angle would otherwise have a
         segment whose normal is square to the frame, where the comparison is a coin toss. */
      let sgn = nrm[p.i0][0] * N0[0] + nrm[p.i0][1] * N0[1] >= 0 ? 1 : -1;
      d[p.i0] = off * sgn;
      for (let i = p.i0 + 1; i <= p.i1; i++) {
        if (nrm[i][0] * nrm[i - 1][0] + nrm[i][1] * nrm[i - 1][1] < 0) sgn = -sgn;
        d[i] = off * sgn;
      }
    });
  }

  /* A lane is a cosmetic displacement and is not allowed to make a claim about the ground. Six units
     is nothing on a fifty-unit hex until the line is beside a river, and then it is the difference
     between one bank and the other: an out-and-back that forded twice was **drawn fording four
     times**, its two tracks stepping over the water and back again purely to get out of each other's
     way. Nor is it only the lane — the half-turn at a hairpin is a whole lane's radius wide, and a
     fillet takes its own bite of the corner, so keeping the water clear needs room on both counts.

     So no lane is taken within two lanes' width of major water: the tracks close up as they come to
     the river, cross it together on the one line the column actually took, and part again on the far
     side, which the tapers do for free once the offset is zero. It costs nothing where it applies —
     the stretch that loses its lane is a ford, which is one place on the map that could not be
     mistaken for anywhere else. `throughSharedEdges` refuses the same liberty for the same reason. */
  for (let i = 0; i < n; i++) {
    if (!d[i]) continue;
    const keep = Math.abs(d[i]) * 3;
    if (nearMajorRiver(P[i], keep) || nearMajorRiver(P[i + 1], keep)) d[i] = 0;
  }

  /* Where a taper may run to before it meets a reversal, another lane change, or the end of the line:
     easing on through any of those would be easing towards a lane the line never reaches. */
  const room = (j, step) => {
    for (let k = j + step; k > 0 && k < n; k += step)
      if (isRev(k) || d[k] !== d[k - 1]) return Math.abs(cum[k] - cum[j]);
    return step > 0 ? cum[n] - cum[j] : cum[j];
  };
  /* One ramp per place the lane actually changes. Turning round is usually not such a place — the
     offset is measured off the walker, and both passes are the same distance to their own left — so
     an ordinary hairpin makes no ramp and is left to its arc.

     But it *can* be one, and that is what tied the line in a knot where a route recrossed itself at a
     bridge. A crossing walked three times has a stretch two lanes out sitting next to one at a single
     lane and another on the road itself, with the turns between them; the lane changed and the
     reversal was suppressing the ramp, so the line stepped eighteen units sideways in no distance and
     then, the two ends of the join now being different distances from the corner, could not be given
     an arc either. Letting the ramp happen fixes both at once: it eases the change over what room
     there is, and at the turn itself the two ends meet the eased value from either side — equal
     distances, opposite sides — so the arc goes back to being drawable, at whatever radius the ease
     has reached by then. */
  const ramps = [];
  for (let j = 1; j < n; j++) {
    if (d[j] === d[j - 1]) continue;
    const s0 = cum[j] - Math.min(TAPER / 2, room(j, -1)), s1 = cum[j] + Math.min(TAPER / 2, room(j, 1));
    if (s1 - s0 > 1e-6) ramps.push({ s0, s1, from: d[j - 1], to: d[j] });
  }
  // How far out the line is at distance `s` along it. Inside a taper that is the eased value; anywhere
  // else it is simply the lane the segment under `s` belongs to.
  const offsetAt = (s, i) => {
    for (const r of ramps)
      if (s > r.s0 && s < r.s1) return r.from + (r.to - r.from) * smoothstep((s - r.s0) / (r.s1 - r.s0));
    return d[i];
  };
  const at = (i, s) => {
    const t = s - cum[i], D = offsetAt(s, i);
    return [P[i][0] + u[i][0] * t + nrm[i][0] * D, P[i][1] + u[i][1] * t + nrm[i][1] * D];
  };

  const out = [];
  for (let i = 0; i < n; i++) {
    // The segment's own points: its two ends, plus enough samples to draw whatever part of a taper
    // falls inside it.
    const ss = [cum[i], cum[i + 1]];
    for (const r of ramps) {
      const a = Math.max(r.s0, cum[i]), b = Math.min(r.s1, cum[i + 1]);
      for (let k = 0; b > a && k <= TAPER_N; k++) {
        const s = a + (b - a) * k / TAPER_N;
        if (s > cum[i] + 1e-9 && s < cum[i + 1] - 1e-9) ss.push(s);
      }
    }
    ss.sort((x, y) => x - y);
    const run = ss.map(s => at(i, s));
    if (!i) { out.push(...run); continue; }

    /* Joining this segment's run to the last one's. Three ways, tried in order of how much they leave
       alone.

       **An arc about the corner**, and only where the column actually turns round. Both ends stand a
       lane's width from the corner, so a circle centred there passes through both and — the offset
       being perpendicular to travel — meets each of them at a right angle, which is to say tangent.
       The turn's radius is therefore just how far out the lane is, and with the lanes at the stop
       marker's radius the loop and the ring come out as the same circle. This used to fire wherever
       the two ends merely happened to be equidistant, which on a bend they always are: the result was
       a little hoop sprouting at any corner two tracks passed each other on, reading as a waypoint
       that was not there. Turning round is the thing being drawn, so turning round is the test — and
       the two ends have to stand on genuinely *opposite* sides of the corner for there to be a
       half-turn between them at all. Where a route recrosses itself at a bridge, three-unit steps and
       two corridors that voted differently can leave those ends half a unit apart on the same side,
       and the arc that answers that is a full circle: a pretzel where a join was wanted. Both the
       opposite-sides test here and turnArc's own refusal to sweep past a half-circle rule it out.

       **A miter**, for a lane going round an ordinary bend: the two offset lines still cross, and
       meeting them there keeps the corner a corner rather than opening a notch a lane wide. Held to
       within twice the lane width of the corner, since the crossing runs away to nothing as a bend
       tightens, and a spike most of a hex off the road is worse than a slightly cut corner.

       **Both ends kept**, for anything left — a taper with no room to run, which steps across in no
       distance because there was none to be had. */
    const V = P[i], e = out[out.length - 1], a = run[0];
    if (Math.hypot(e[0] - a[0], e[1] - a[1]) < 0.02) { out.push(...run.slice(1)); continue; }
    const ev = [e[0] - V[0], e[1] - V[1]], av = [a[0] - V[0], a[1] - V[1]];
    const re = Math.hypot(ev[0], ev[1]), ra = Math.hypot(av[0], av[1]);
    const arc = isRev(i) && re > 0.01 && Math.abs(re - ra) < 0.05 && ev[0] * av[0] + ev[1] * av[1] < 0
      ? turnArc(V, e, a, u[i - 1]) : null;
    if (arc) { out.push(...arc.slice(1, -1), ...run); continue; }
    const m = out.length > 1 && run.length > 1 ? lineMeet(out[out.length - 2], e, a, run[1]) : null;
    if (m && Math.hypot(m[0] - V[0], m[1] - V[1]) < R * 2) { out[out.length - 1] = m; out.push(...run.slice(1)); }
    else out.push(...run);
  }
  return out;
}

/* Arrowheads every `gap` units of *path*, not of ground: what makes a route unreadable is its drawn
   length, and a hex-based spacing would have put an arrow into every step of a mountain crawl and
   two into a trade hop spanning six hexes. The first lands half a gap in, so a march too short to
   hold a full interval still gets one arrow rather than none.

   Which way a head points is taken from the **chord across its own length** — where the line is
   `span/2` back and `span/2` on — and not from the one facet of the polyline it happens to be
   standing on. That facet can be two units long where the drawn geometry is fine, and it can point
   backwards: a bridge is traced through points a few units apart and the solved line takes a step or
   two the wrong way among them, invisible under a stroke three units wide and round-jointed, but
   enough to flip a seventeen-unit arrowhead end for end. A march heading north-east showed one head
   at the bridge pointing south-west. Reading the chord asks the question at the scale the answer is
   drawn at, which is the scale it was always meant to be asked at — it also lines the heads up along
   a curve rather than along whichever facet they landed on.

   `avoid` is the waypoint markers. An arrowhead landing on a stop fills in its hollow ring and turns
   a stop into a blob, so anything within `clear` of one is dropped — the ring is the more important
   mark, and the arrow either side of it says the same thing about direction. */
function arrowsAlong(pts, gap, span, avoid, clear) {
  const cum = [0];
  for (let i = 0; i + 1 < pts.length; i++)
    cum.push(cum[i] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return [];
  // Where the line is, `s` units along it.
  const at = s => {
    s = Math.max(0, Math.min(total, s));
    let lo = 0, hi = cum.length - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cum[m] <= s) lo = m; else hi = m - 1; }
    const L = cum[lo + 1] - cum[lo], t = L > 0 ? (s - cum[lo]) / L : 0;
    return [pts[lo][0] + (pts[lo + 1][0] - pts[lo][0]) * t, pts[lo][1] + (pts[lo + 1][1] - pts[lo][1]) * t];
  };
  const out = [];
  // Half a gap in, or the middle of the line when the whole of it is shorter than a gap.
  for (let s = Math.min(gap, total) * 0.5; s < total; s += gap) {
    const p = at(s);
    if (avoid.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < clear)) continue;
    const a = at(s - span / 2), b = at(s + span / 2);
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L > 1e-6) out.push([p[0], p[1], dx / L, dy / L]);
  }
  return out;
}
/* A filled head rather than an open chevron: an outlined one drawn in the line's own colour on top of
   the line is just a thicker bit of line. Sized off the stroke so it stays in proportion when the
   active route thickens, and drawn big — six strokes long and nearly five wide. A head sized to sit
   politely on the line is a head you have to go looking for, and the whole reason it is there is to
   be answerable at a glance and at a zoom where the line itself is a thread. It is wider than the
   lane spacing, so on a doubled stretch the two directions' heads reach across each other's tracks;
   that is why they are spaced as far apart as they are, below. */
const arrowLen = sw => sw * 6;   // also the span the head's direction is read over — see arrowsAlong
function arrowPathD([x, y, ux, uy], sw) {
  const l = arrowLen(sw), w = sw * 2.4, nx = -uy, ny = ux;
  const tx = x + ux * l * 0.5, ty = y + uy * l * 0.5;
  const bx = x - ux * l * 0.5, by = y - uy * l * 0.5;
  return `M${(bx + nx * w).toFixed(1)} ${(by + ny * w).toFixed(1)}` +
         `L${tx.toFixed(1)} ${ty.toFixed(1)}` +
         `L${(bx - nx * w).toFixed(1)} ${(by - ny * w).toFixed(1)}Z`;
}
/* World units of path between one arrowhead and the next — about a hex and a quarter. Set against the
   size of the head rather than picked for density on its own: at the spacing that suited a small head,
   a big one turns the line into an unbroken chain of chevrons, and on a stretch walked twice the two
   lanes' heads interlock into a braid with no plain line left anywhere to tell them apart. Far enough
   apart that every head has clear line either side of it, and the doubled stretch reads as what it is:
   two lines running together, each saying which way it goes. */
const ARROW_GAP = 62;

/* Is anything on screen singling one route out? Two things can be, and either will do: the **Routes
   panel**, which names the active route in its heading, its settings and its list, and the **readout
   card** on the map, which is that route's answer. With both away nothing is claiming a subject, and
   the map should simply show every march it has.

   Asked as a question rather than kept as a flag because it is a question about two other pieces of
   state, and a flag would be a third thing to remember to update. */
const routeIsSubject = () => (UI.pane === 'route' && !UI.shut) || !routeCard.hidden;
/* Repainting after that answer changes. It re-solves, which sounds heavy for a change of opacity —
   but it is the same work a dragged waypoint does on every frame, and `preview` keeps it from
   touching storage or recomputing the isochrones, which have no opinion about any of this. Guarded
   because the panel is placed once during script evaluation, before there is a map to draw on. */
const relightRoutes = () => { if (S.G && groups.route) computeRoute({ preview: true }); };

function computeRoute({ preview = false, previewIso = false } = {}) {
  const out = document.getElementById('routeOut');
  groups.route.innerHTML = '';
  // Anything that recomputes the route — a waypoint placed or dragged, a settings box, an undo, a
  // road drawn — moves the ground the hover preview was measured from, so the cached field goes.
  routeProbe = null;
  // A waypoint drag temporarily moves a stop so the answer can follow the pointer. It must not
  // overwrite the saved route (or the undo snapshot) until the pointer is actually released.
  if (!preview) saveRoutes();
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
  if (!preview || previewIso) {
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
  }
  const results = [];
  const singled = routeIsSubject();
  S.routes.forEach((rt, i) => {
    /* Faint means "not the one being talked about", and that only means anything while something on
       screen is doing the talking. With the Routes panel away and the readout card dismissed, the
       active route is a fact about the state and about nothing the reader can see — so dimming the
       rest is dimming them in favour of a distinction nobody is being shown, and what is left is a
       map with one march legible and the others half there for no stated reason. When nothing is
       singling one out, they are all drawn as the one. */
    const act = !singled || i === S.activeRoute;
    /* The marched line first, the stop markers over it. It was the other way round, which looked much
       the same — the dashes crossing a hollow ring rather than stopping at it — and made the markers
       **ungrabbable**: the line is drawn through every waypoint it passes, so at exactly the point you
       aim at to pick a stop up, the line was the topmost thing and took the press. It is also given
       `pointer-events: none`, since it is a drawn answer rather than a control and has no business
       intercepting anything. */
    const r = rt.wps.length > 1 ? routeLeg(rt, armyOpts(rt.set)) : null;
    if (r && r.pts.length > 1) {
      const sw = act ? 2.8 : 2, op = act ? 0.95 : 0.55;
      // The stops, wanted before the line is drawn so the arrowheads can be kept off them.
      const stops = rt.wps.map(w => endPoint(w.h, w.ri | 0));
      const pts = roundBends(fanOutRetraced(r.pts, wpR(act)));
      el('path', { d: featPathD(pts), fill: 'none', stroke: rt.color, 'stroke-width': sw,
                   'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: op,
                   'data-rt': i, 'pointer-events': 'none' }, groups.route);
      for (const a of arrowsAlong(pts, ARROW_GAP, arrowLen(sw), stops, wpR(act) + 4))
        el('path', { d: arrowPathD(a, sw), fill: rt.color, stroke: 'none', opacity: op,
                     'data-rt': i, 'pointer-events': 'none' }, groups.route);
    }
    rt.wps.forEach((w, wi) => {
      const [cx, cy] = endPoint(w.h, w.ri | 0); // every waypoint is a stop, and stops sit at the marker
      const sea = !!(region(w.h, w.ri | 0)?.sea && !region(w.h, w.ri | 0)?.river);
      /* Draggable, so a march can be adjusted rather than retyped. It was remove-and-re-add, which for a
         waypoint in the *middle* of a route meant taking the tail off behind it — the only removal is the
         last one — or right-clicking the hex it happens to sit on and rebuilding from there. Moving the
         thing you can see is the obvious gesture and it was the one thing the marker would not do.

         `data-wp` is what the pointer handler grabs by; the ring is given a transparent disc behind it so
         the whole marker is a target rather than just its outline, which at five pixels is nothing to aim
         at. Only that hit area is filled — the ring itself still reads as hollow. */
      /* A waypoint the column only passes through is drawn smaller and thinner. It is a lesser thing
         than a stop — no halt, no order ending on it, nothing spent there — and the marker says so by
         being less of a marker, rather than by taking a symbol of its own that would have to be
         learnt. The hit area stays the size a finger needs either way. */
      const thru = !wpHalt(rt, wi) && wi !== rt.wps.length - 1;   // arriving is a halt whatever the boxes say
      const rad = wpR(act) * (thru ? 0.62 : 1);
      const g = el('g', { 'data-wp': i + ':' + wi, style: 'cursor:grab' }, groups.route);
      el('circle', { cx, cy, r: wpR(act) + 4, fill: 'transparent', stroke: 'none' }, g);
      el('circle', { cx, cy, r: rad, fill: sea ? rt.color : 'none', stroke: rt.color,
                     'stroke-width': wpSW(act) * (thru ? 0.75 : 1),
                     opacity: (act ? 1 : 0.7) * (thru ? 0.8 : 1), 'data-rt': i,
                     'pointer-events': 'none' }, g);
    });
    results.push(r);
  });
  lastResults = results;
  renderRouteList(results);
  syncRouteForm();
  const rt = S.routes[S.activeRoute], r = results[S.activeRoute];
  if (!rt) { out.innerHTML = ''; return; }
  if (rt.wps.length < 2) { out.innerHTML = '<div class="hint">Add a destination hex.</div>'; return; }
  if (r.fail) {
    out.innerHTML = `<div class="err">${rt.name}: no route between hex ${r.fail[0]} and hex ${r.fail[1]} with these settings. ` +
      `Check water access, trade routes, river crossings, and weather.</div>`;
    return;
  }
  const game = r.irl * RULES.GAME_DAYS_PER_IRL;
  let cum = 0;
  let prevH = null;
  const rows = r.steps.map((st, j) => {
    cum += st.irl;
    const name = placeName(st.h, st.ri);
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
  /* Ordered days lead, marched days follow. What a plan is made of is the orders — a column cannot be
     told to march three-tenths of a day — so the whole-day figure is the answer to "how long", and the
     exact one is the working behind it. The gap between them is the waste, and the waste is the thing
     the order of the waypoints can actually change. */
  const ord = orderedOf(rt, r);
  const wasteRow = ord
    ? `<tr><td>Orders</td><td>${ord.days} whole days over ${ord.halts} halt${ord.halts === 1 ? '' : 's'}` +
      `${ord.waste > 0.05 ? ` — <span class="warn">${ord.waste.toFixed(1)} d wasted</span>` : ''}</td></tr>`
    : '';
  out.innerHTML =
    `<div class="big" style="color:${rt.color}">${rt.name}: ${ord ? ord.days + ' IRL days' : r.irl.toFixed(1) + ' IRL days'} ` +
    `<span style="color:#9aa4b2">(${r.irl.toFixed(1)} marched · ${game.toFixed(0)} in-game)</span></div>` +
    (() => {
      const legs = rt.wps.filter(w => w.f).length;
      if (!legs) return '';
      // Sections, not just legs: a route can be pushed in several separate bursts.
      let runs = 0;
      rt.wps.forEach((w, i) => { if (w.f && !rt.wps[i - 1]?.f) runs++; });
      return `<div class="fmnote">Forced march: ${runs} section${runs > 1 ? 's' : ''}, ` +
             `${legs} of ${Math.max(1, rt.wps.length - 1)} legs — right-click a step to change where.</div>`;
    })() +
    `<table>${wasteRow}<tr><td>Distance</td><td>${r.hexes} hexes ≈ ${Math.round(r.miles ?? r.hexes * RULES.HEX_MILES)} mi</td></tr>` +
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
  const half = {
    name: 'Route ' + (S.routes.length + 1),
    color: freeRouteColor(),
    wps: tail, set: { ...(rt.set || SETTINGS) },
  };
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
  // Orders first here too: an order written out of this line is written in whole days.
  const ord = orderedOf(rt, r);
  return `${rt.name} — ${ord ? ord.days + ' IRL days ordered (' + r.irl.toFixed(1) + ' marched, ' : r.irl.toFixed(1) + ' IRL days ('}` +
         `${game.toFixed(0)} in-game), ${r.hexes} hexes ≈ ${miles} mi\n` + parts.join(' -> ');
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
    color: ROUTE_COLORS.find(c => !used.has(c)) || rt.color,
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
    // Renaming lives here now. It used to be a double-click on the name in the row, which the name filled
    // nearly all of — so double-clicking "the row" mostly hit it, and the gesture the row plainly wants
    // is the breakdown. A menu the row already has is a better home for the rarer of the two.
    ctxItem(box, 'Rename…', () => {
      closeCtx();
      const n = prompt('Route name:', rt.name);
      if (n) { pushUndoRoutes(); rt.name = n; computeRoute(); }
    });
    ctxItem(box, 'Duplicate route', () => { closeCtx(); cloneRoute(i); });
    // The same three questions the panel button asks, on the route this menu was opened for rather
    // than on the selected one — the menu is the handle for *this* route in every other entry too.
    if (rt.wps.length > 2) ctxFlyout(ctxItem(box, 'Optimise order<span class="arw">▸</span>'), optimiseMenu(i));
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

/* Double-clicking a route row opens that route's breakdown — recognised by hand rather than by the
   browser, because the browser will never fire `dblclick` here. A single click activates the route,
   activating recomputes, recomputing **re-renders the whole list**, and `dblclick` requires two clicks on
   the *same* element; the second always lands on a freshly built row. A row's own `ondblclick` is
   therefore dead code, and had been for as long as the sidebar advertised "double-click its name to
   rename" — that gesture never worked either.

   So the listener lives on the *container*, which survives re-rendering, identifies the row by its
   **index** rather than by its node, and is registered in the **capture** phase so it reads that index
   before the row's own click handler rebuilds everything underneath it.

   The whole row answers, the name included. The name filled nearly all of it, so reserving the name for
   renaming would have meant that double-clicking "the row" mostly renamed — and the breakdown is plainly
   what a route row wants a second click to do: a route is a question and the step table is the answer.
   Renaming moved to the row's own ⋯ menu, which is the better home for the rarer of the two. */
const RT_DBL_MS = 400;
let rtLastClick = { i: -1, t: 0 };
document.getElementById('routeList').addEventListener('click', e => {
  const row = e.target.closest('.rtitem');
  // The swatch, the ⋯ and the × answer for themselves and must not start or finish a double.
  if (!row || e.target.closest('.sw, .mn, .x')) { rtLastClick = { i: -1, t: 0 }; return; }
  const i = [...document.getElementById('routeList').querySelectorAll('.rtitem')].indexOf(row);
  const now = performance.now();
  const second = i === rtLastClick.i && now - rtLastClick.t < RT_DBL_MS;
  rtLastClick = second ? { i: -1, t: 0 } : { i, t: now };
  if (!second || !S.routes[i]) return;
  // Activated first, so the card that opens describes the route just double-clicked rather than whichever
  // was active before — the plain click has usually done this already, but not if it was ever eaten.
  S.activeRoute = i;
  computeRoute();
  showCard();
}, true);

function renderRouteList(results) {
  const list = document.getElementById('routeList');
  list.innerHTML = S.routes.length ? '' : '<div class="emptynote">No routes yet. Click a hex to start one.</div>';
  S.routes.forEach((rt, i) => {
    const div = document.createElement('div');
    div.className = 'rtitem' + (i === S.activeRoute ? ' on' : '');
    div.title = 'Click to activate · double-click for the hex breakdown';
    const r = results[i];
    const tm = r ? (r.fail ? '✗' : routeDays(rt, r)) : rt.wps.length + ' wp';
    div.innerHTML = `<span class="sw" style="background:${rt.color}" title="Change colour"></span>` +
      `<span class="nm">${rt.name}</span>` +

      `<span class="tm" title="${escHtml(routeDaysTitle(rt, r))}">${tm}</span>` +
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
    // Each half only where it was already painted. An arrowhead is fill-only, and handing it a stroke
    // would fatten it by a unit for the length of the drag; a land waypoint is a hollow ring, and
    // handing it a fill would plug it. Sea waypoints are filled, and the arrowheads carry no stroke.
    if (e.getAttribute('stroke') !== 'none') e.setAttribute('stroke', rt.color);
    if (e.getAttribute('fill') !== 'none') e.setAttribute('fill', rt.color);
  }
  // Both swatches: the sidebar row and the map button. Either can be the one on screen — the panel
  // is often shut while the buttons never are — and a live picker that repainted only one of them
  // would leave whichever was showing behind the colour it was being dragged away from.
  for (const sel of ['#routeList .rtitem', '#routeBtns .rtbtn']) {
    const sw = document.querySelectorAll(sel)[i]?.querySelector('.sw');
    if (sw) sw.style.background = rt.color;
  }
  if (i === S.activeRoute) {
    const big = document.querySelector('#routeOut .big');
    if (big) big.style.color = rt.color;
  }
  saveRoutes();
}

function saveRoutes() {
  const j = snapRoutes();
  routesSnap = j;              // what undo restores to, should the next change be to a route
  if (saveOn()) try { localStorage.setItem('rotmap_routes_v1', j); } catch {}
}

/* ---------------- interactions ---------------- */
let pan = null, downPos = null, spaceHeld = false, edgeSnap = false;
let tokDrag = null;   // { t, g, p, dx, dy, moved, target } while a token is under the pointer
let wpDrag = null;    // route/waypoint, original stop and live preview while its marker is dragged
let isoDrag = null;   // origin index, original node and live reach preview while its marker is dragged
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
    // Held on a token, the same gesture stands in for the right-click a touchscreen hasn't got — and on
    // the same terms: the counter's entries belong to whoever has the Tokens panel open. Otherwise the
    // hold falls through to the readout, which is what a hold on anything else gives.
    if (tokDrag && !tokDrag.moved && UI.pane === 'tokens') {
      openCtx(pt.clientX, pt.clientY, tokenMenu(tokDrag.t));
      return;
    }
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
  /* An isochrone origin behaves like a one-point route: grab the marker itself, preview every subhex
     it crosses, and do not let the underlying map click move some other selected origin as well. */
  const grabbedIso = (e.button === 0 && !spaceHeld && S.mode !== 'draw')
    ? e.target.closest?.('[data-iso-origin]') : null;
  if (grabbedIso) {
    const oi = +grabbedIso.dataset.isoOrigin, og = S.iso.origins[oi];
    if (og?.h != null) {
      isoDrag = { oi, g: grabbedIso, p: nodePoint(og.h, og.ri | 0), moved: false, target: null,
                  original: { h: og.h, ri: og.ri | 0 }, oldActive: S.iso.active,
                  previewKey: `${og.h}:${og.ri | 0}`, snapshot: snapRoutes() };
      S.iso.active = oi;
      svg.setPointerCapture(e.pointerId);
      return;
    }
  }
  /* A press on a waypoint marker belongs to that waypoint, the same way a press on a counter belongs to
     the counter: it never pans, never draws, never plants a second waypoint on top of the first. Taken
     before the token test only because the two cannot overlap — a marker and a counter in one hex sit at
     different points — so the order is arbitrary and this one reads first. */
  const grabbedWp = (e.button === 0 && !spaceHeld && S.mode !== 'draw') ? e.target.closest?.('[data-wp]') : null;
  if (grabbedWp) {
    const [ri, wi] = grabbedWp.dataset.wp.split(':').map(Number);
    const rt = S.routes[ri];
    if (rt?.wps[wi]) {
      const w = rt.wps[wi];
      wpDrag = { ri, wi, g: grabbedWp, p: endPoint(w.h, w.ri | 0), moved: false, target: null,
                 original: { ...w }, previewKey: `${w.h}:${w.ri | 0}` };
      svg.setPointerCapture(e.pointerId);
      return;
    }
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
  // An armed dropper takes the click and lays nothing down, so it must not open a sweep either.
  if (e.button === 0 && S.mode === 'draw' && (S.tool === 'erase' || (S.tool === 'realm' && !realmDropper))) {
    // Realm shares the eraser's drag: both are "apply this to whatever I sweep over", and both want
    // the whole sweep to be one press of Ctrl+Z.
    S.dragErase = { undoPushed: false, paint: S.tool === 'realm' };
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
  if (isoDrag) {
    if (!isoDrag.moved && downPos && Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) <= tapSlop(e)) return;
    isoDrag.moved = true;
    cancelLongPress();
    const [wx, wy] = toWorld(e);
    const h = nearestHex(wx, wy);
    isoDrag.target = (h && S.hexes[h].t !== 'N/A') ? { h, ri: regionAt(h, [wx, wy]) } : null;
    const key = isoDrag.target ? `${isoDrag.target.h}:${isoDrag.target.ri | 0}` : 'off-map';
    if (key !== isoDrag.previewKey) {
      const og = S.iso.origins[isoDrag.oi];
      if (og) {
        const at = isoDrag.target || isoDrag.original;
        og.h = at.h; og.ri = at.ri | 0;
        isoDrag.previewKey = key;
        computeRoute({ preview: true, previewIso: true });
        // The reach redraw replaces the marker group; keep its replacement under the pointer.
        isoDrag.g = groups.iso.querySelector(`[data-iso-origin="${isoDrag.oi}"]`);
        isoDrag.p = nodePoint(og.h, og.ri | 0);
      }
    }
    isoDrag.g?.setAttribute('transform', `translate(${(wx - isoDrag.p[0]).toFixed(2)} ${(wy - isoDrag.p[1]).toFixed(2)})`);
    groups.hover.innerHTML = '';
    tooltip.hidden = true;
    if (isoDrag.target) {
      const [cx, cy] = hexCenter(isoDrag.target.h);
      el('path', { d: hexPath(cx, cy), fill: 'rgba(255,255,255,.10)', stroke: '#fff',
                   'stroke-width': 1.8, 'pointer-events': 'none' }, groups.hover);
    }
    return;
  }
  if (wpDrag) {
    if (!wpDrag.moved && downPos && Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) <= tapSlop(e)) return;
    wpDrag.moved = true;
    cancelLongPress();
    const [wx, wy] = toWorld(e);
    const h = nearestHex(wx, wy);
    /* The marker follows the pointer, and the hex under it is outlined — the same two things the token
       drag does, for the same reason: a marker that jumped from node to node would hide which hex it was
       actually going to land on, and the outline is what answers that.

       Unlike a token, a waypoint carries a *subhex*, so the region under the pointer is picked up as well
       — dropping a stop on the far bank of a river has to mean the far bank. And unlike a token it may
       land on water, since fleets sail: what it may not land on is off-map filler. */
    wpDrag.target = (h && S.hexes[h].t !== 'N/A') ? { h, ri: regionAt(h, [wx, wy]) } : null;
    const key = wpDrag.target ? `${wpDrag.target.h}:${wpDrag.target.ri | 0}` : 'off-map';
    if (key !== wpDrag.previewKey) {
      const rt = S.routes[wpDrag.ri];
      if (rt?.wps[wpDrag.wi]) {
        rt.wps[wpDrag.wi] = wpDrag.target
          ? { ...wpDrag.original, h: wpDrag.target.h, ri: wpDrag.target.ri | 0 }
          : { ...wpDrag.original };
        wpDrag.previewKey = key;
        S.activeRoute = wpDrag.ri;
        computeRoute({ preview: true });
        // computeRoute rebuilt the marker group. Keep the newly drawn one under the pointer too.
        wpDrag.g = groups.route.querySelector(`[data-wp="${wpDrag.ri}:${wpDrag.wi}"]`);
        const cur = rt.wps[wpDrag.wi];
        wpDrag.p = endPoint(cur.h, cur.ri | 0);
      }
    }
    wpDrag.g?.setAttribute('transform', `translate(${(wx - wpDrag.p[0]).toFixed(2)} ${(wy - wpDrag.p[1]).toFixed(2)})`);
    groups.hover.innerHTML = '';
    tooltip.hidden = true;
    if (wpDrag.target) {
      const [cx, cy] = hexCenter(wpDrag.target.h);
      el('path', { d: hexPath(cx, cy), fill: 'rgba(255,255,255,.10)', stroke: '#fff',
                   'stroke-width': 1.8, 'pointer-events': 'none' }, groups.hover);
    }
    return;
  }
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
    if (S.dragErase.paint) paintRealmDrag(wx, wy); else eraseWholeAt(wx, wy, s);
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
  if (isoDrag) {
    const d = isoDrag;
    isoDrag = null;
    pan = null; downPos = null;
    groups.hover.innerHTML = '';
    const og = S.iso.origins[d.oi];
    if (d.moved && d.target && og) {
      const changed = d.original.h !== d.target.h || d.original.ri !== (d.target.ri | 0);
      if (changed) {
        // Carry the exact pre-drag state. The ambient routesSnap can predate a saved-state load and
        // is therefore not a safe description of where this particular gesture began.
        pushUndoEntry('routes', d.snapshot);
        routesSnap = null;
        og.h = d.target.h; og.ri = d.target.ri | 0;
        computeRoute();
        return;
      }
    }
    if (og) { og.h = d.original.h; og.ri = d.original.ri; }
    // A click selects without moving; an off-map release cancels the provisional position.
    computeRoute();
    return;
  }
  if (wpDrag) {
    const d = wpDrag;
    wpDrag = null;
    pan = null; downPos = null;
    groups.hover.innerHTML = '';
    /* A drag that went somewhere commits the stop whose route has already been previewing live; a press
       that did not is left alone. Not
       treated as a click, deliberately: a click on bare map plants a waypoint, and a press on a marker
       that turns out not to have moved should do *nothing* rather than plant a second stop on the one
       already there. */
    if (d.moved && d.target) {
      const rt = S.routes[d.ri];
      if (rt?.wps[d.wi]) {
        const changed = d.original.h !== d.target.h || (d.original.ri | 0) !== (d.target.ri | 0);
        if (!changed) { rt.wps[d.wi] = { ...d.original }; computeRoute(); return; }
        pushUndoRoutes();             // routesSnap is still the pre-preview route
        rt.wps[d.wi] = { ...d.original, h: d.target.h, ri: d.target.ri | 0 };
        S.activeRoute = d.ri;      // the route you just adjusted is the one the card should describe
        computeRoute();
        return;
      }
    }
    // Letting go outside the map, or losing the pointer, cancels the provisional move.
    const rt = S.routes[d.ri];
    if (rt?.wps[d.wi]) rt.wps[d.wi] = { ...d.original };
    computeRoute();                // clears the transform the marker was following the pointer with
    return;
  }
  if (tokDrag) {
    const d = tokDrag;
    tokDrag = null;
    pan = null; downPos = null;
    groups.hover.innerHTML = '';
    // renderTokens() either way: it clears the transform the drag was following the pointer with,
    // which is also how a token let go off the edge of the map finds its way back.
    if (afterPinch) { renderTokens(); return; }
    // A click swaps the rim between black and white. It used to step the *fill* through the palette,
    // which is no longer a useful thing to do to a counter: the fill is the legion's colour and means
    // something, so stepping it turns Legion V into Legion VI's colour at a stray click. What a click is
    // good for is the one adjustment that is purely about being seen — a white rim against dark ground,
    // a black one against light — and the fill is changed deliberately, from the menu.
    if (!d.moved) d.t.rim = tokenRim(d.t) === '#fff' ? '#14181e' : '#fff';
    else if (d.target) d.t.h = d.target;
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
    if (isoDrag) {
      const d = isoDrag; isoDrag = null;
      const og = S.iso.origins[d.oi];
      if (og) { og.h = d.original.h; og.ri = d.original.ri; }
      S.iso.active = d.oldActive;
      computeRoute(); groups.hover.innerHTML = '';
    }
    // Same for a waypoint the pointer was lost from — a cancelled drag has to put the marker back, and
    // recomputing is what clears the transform it was following the pointer with.
    if (wpDrag) {
      const d = wpDrag; wpDrag = null;
      const rt = S.routes[d.ri];
      if (rt?.wps[d.wi]) rt.wps[d.wi] = { ...d.original };
      computeRoute(); groups.hover.innerHTML = '';
    }
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
  /* A counter's own entries are offered only while the **Tokens panel is open**. They were offered
     whenever you right-clicked a counter, which sounds helpful and is not: a counter sitting on the hex
     you want to march from is in the way, and a menu that opens with six ways to rename and recolour it
     — above the hex entries you were after — makes it more in the way. Having that panel open is the
     plain statement that counters are what you are working on; with it shut, the counter is scenery and
     the hex under it is the subject. The panel's own rows still answer the right button either way, and
     `Mark as` on the hex menu is how a counter gets made in the first place. */
  const onTok = UI.pane === 'tokens' ? e.target.closest?.('[data-tok]') : null;
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
  if (S.tool === 'realm') { (realmDropper ? pickRealmAt : paintRealmAt)(wx, wy); return; }
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
    const sheet = S.names.hexes[h];
    const cur = m ? shName(h, m) : (S.features.labels[h] ?? sheet ?? '');
    /* Clearing means clearing. It used to mean "put the datasheet's name back", which made a name
       from the sheet impossible to be rid of: emptying the box handed it straight back, so a hex
       went on calling itself Ephialtas long after the stronghold there had been erased and the town
       redrawn a hex away. The sheet's own name is offered in the message instead, which makes
       putting it back a matter of retyping what is in front of you rather than a gesture nobody
       could have guessed. */
    const name = prompt(`Name for hex ${h}${sub}${m ? ' (stronghold)' : ''} — rename, or clear to remove.` +
                        (!m && sheet ? `\nThe datasheet calls it ${sheet}.` : ''), cur);
    if (name === null) return;
    pushUndo();
    const t = name.trim();
    // A blank name on a stronghold is an empty name, not a deletion — the keep is still there, just
    // unlabelled.
    if (m) shEnsure(h, ri).name = t;
    else if (t) S.features.labels[h] = t;
    // The blank is kept only where there is a datasheet name for it to overrule. On a hex the sheet
    // never named, blank is simply the absence of a label, and is stored as one.
    else if (sheet) S.features.labels[h] = '';
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
  document.getElementById('saveInfo').textContent = `Sea set to the ${f.seaLeft ? 'left' : 'right'} of the coast. Click near the coast to change it.`;
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
/* Who holds the ground, from whichever of the two scans are up. They answer different questions —
   Borders is who holds it by right, Warlords who holds it now — so each gets a line of its own, and
   when both are showing each says which map it came from. One alone needs no saying: there is
   nothing there to confuse it with.

   The two are not read equally, because they were not drawn equally. The Warlords scan ships with a
   legend of its own, so it can name every colour it paints and admit it when it cannot. The Borders
   scan ships with none — twenty-five washes that would otherwise read out as hex codes, which tell a
   reader nothing at all. So Borders speaks **only where a colour has been named by hand**, with the
   palette's double-click rename, and is silent otherwise. That silence is the default state of that
   map and is meant to be: name a wash once and it starts answering, everywhere, for good.

   The Warlords legend gets to speak for the Borders layer in exactly one case, and it is not a
   coincidence of colour: `BORDERS_INDEPENDENT`. Every other warlord is overlaid onto that map as the
   empire's own pale shade, because Borders is about who holds what *by right* and a legion holding
   imperial ground is still holding imperial ground. A realm in that set is nobody's subject, so
   `overlayWarlords` writes its own colour straight through instead — meaning the colour is on the
   Borders map *because it is that realm*, by construction rather than by matching triple, and the
   legend is describing it rather than guessing at it. That is the Blue Scarves. */
function realmTip(h, ri) {
  const found = [];
  for (const id of ['borders', 'warlords']) {                 // by right first, then who sits on it
    const g = groups[id];
    if (!g || g.style.display === 'none' || !realmScans.has(id)) continue;
    const c = realmCols.get(id)?.get(h + ':' + (ri | 0));
    if (!c) continue;
    // The same name the palette shows, so a colour renamed there is renamed here too — the readout
    // and the swatch are the two places a realm says what it is and they must not disagree.
    const legend = id === 'warlords' || BORDERS_INDEPENDENT.has(c);
    const name = S.features.realmNames?.[id]?.[c] ?? (legend ? WARLORD_BY_RGB.get(c) : null);
    if (!name && id === 'borders') continue;                  // an unnamed wash has nothing to say
    found.push({ id, c, name });
  }
  /* One line per *answer*, not one per layer. With both maps up the pair usually differ — a legion sits
     on imperial ground, and saying so twice is the point of having both — but where they agree they agree
     because it is the same fact arriving twice, which is what happens over the Blue Scarves: they keep
     their own colour on the Borders map by construction, so both layers name them and the readout said it
     twice. Identical name *and* identical colour is the test; same name in two colours is a federation
     holding ground on both maps and still worth two lines.

     And no "Borders"/"Warlords" qualifier. It was there to say which map a line came from, which sounds
     useful and is not: the two are stacked deliberately so that what shows is who holds the ground now
     over who holds it by right, and by the time a reader has both layers on they know which is which.
     What the qualifier actually did was put the machinery's vocabulary in front of the answer. */
  const lines = [];
  for (const { c, name } of found)
    if (!lines.some(p => p.c === c && p.name === name)) lines.push({ c, name });
  return lines.map(({ c, name }) =>
    `<br><span class="rg"><span class="chip" style="background:rgb(${c})"></span>` +
    (name ? escHtml(name) : `unnamed colour ${rgbHex(c)}`) +
    '</span>').join('');
}

/* The counters standing on this hex, and who commands them. The designation is on the board already, so
   this line exists for the **name** — which is deliberately not drawn on the map, fourteen commanders'
   names over fourteen counters being a way to bury the terrain. Hovering is how you ask about one of them.

   Keyed by hex rather than by subhex: a counter sits on a hex, not on one bank of it, so both halves of a
   split hex report the force standing there. Counters with no commander still get a line, because being
   told "V" and nothing else is the correct answer for a force nobody has named — the Blue Scarves are not
   anybody's command, and an absent name is a fact about them rather than a hole in the data. */
function tokenTip(h) {
  const here = S.tokens.filter(t => t.h === h);
  if (!here.length) return '';
  return here.map(t =>
    `<br><span class="rg"><span class="chip" style="background:${escHtml(t.color)}"></span>` +
    `<b>${escHtml(t.label || '—')}</b>` + (t.name ? ' · ' + escHtml(t.name) : '') +
    '</span>').join('');
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

/* What clicking here would cost the active route, said while the pointer is still over the hex. The
   figure is the whole march from the start, not the leg alone — "when does it arrive" is the
   question a route is drawn to answer, and the leg on its own answers a smaller one. Both are given
   where they differ, the total first and what it added under it.

   Only in route mode, and not while a click means something else: with the Isochrone panel open, or
   Set origin armed, the map is taking origins rather than waypoints, and offering a march time for a
   click that will not make one is worse than saying nothing. */
function routeTip(h, ri) {
  if (S.mode !== 'route' || S.isoPick || UI.pane === 'iso') return '';
  const rt = S.routes[S.activeRoute];
  if (!rt || !rt.wps.length) return '';
  const last = rt.wps[rt.wps.length - 1];
  if (last.h === h && (last.ri | 0) === (ri | 0)) return '';   // where the column already stands
  const total = routeProbeCost(h, ri | 0);
  if (total === null) {
    if (routeProbe?.broken) return '';
    // Unreachable is an answer, and a useful one: a hex across water with no fleet, or a shore the
    // weather has shut. Said quietly, since a whole sea can be in that state at once.
    return `<br><span class="eta"><i>no march to here — check ships, fords, weather</i></span>`;
  }
  /* One line: the march from the start, and in brackets what this leg adds to it. Both in ordered
     whole days, the same billing the route reports — a preview in exact days would quietly disagree
     with the card the moment you clicked. Hovering a hex the column could reach in a fraction of the
     day it is already marching therefore adds nothing at all, which is the truth about it and the
     whole reason the figure is worth showing before the click rather than after. */
  const banked = routeProbe?.banked || 0, pending = routeProbe?.pending || 0;
  const arrive = banked + optDays(pending + total - (routeProbe?.baseExact || 0));
  const base = rt.wps.length > 1 ? banked + optDays(pending) : 0;
  return `<br><span class="eta" style="color:${escHtml(rt.color)}">arrives in ${arrive} IRL days` +
         (base ? ` <i>(+${arrive - base} d)</i>` : '') + '</span>';
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
      // Which piece of a split hex the cursor is on is a fact about how the map is *built*, not about
      // the world — the highlight already shows it, and on the published map it reads as jargon. It
      // is drawn either way; only the words are held back. Same for the sheet's river and road flags
      // below: they are there to check the drawing against the data, which is a local job.
      if (LOCAL) {
        subLabel = ' · ' + (sea ? 'sea' : 'land') + ' subhex';
        if (!sea && S.features.subTerrain?.[h]?.[ri]) subLabel += ` (${S.features.subTerrain[h][ri]})`;
      }
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
  const name = placeName(h, hoverRi);
  /* What kind of place it is, as one phrase: "Port Fortress", "Inland Major City". Whether it can be
     reached by ship is the first thing anyone wants of a stronghold on a map with a fleet on it, so it
     leads rather than trailing in a bracket — and a bracket after a bracketed hex number was one pair
     too many. Both halves are said; neither is the assumption.

     **Port**, not "coastal", because coastal describes where a place *is* and port describes what it
     *does* — and it is the second that the map is actually asserting and that the rules act on. A
     stronghold on the shore that ships cannot use is coastal and is not a port, which the old wording
     made unsayable; the flag has always meant the port, and now the readout says the same word the
     Stronghold tool and the marching rules use for it. */
  const shKind = hoverM
    ? (isPort(h, hoverRi) ? 'Port ' : 'Inland ') +
      ({ major: 'Major City', fortress: 'Fortress' }[shKindOf(hoverM)] || 'Stronghold')
    : '';
  // The two ways the map divides the same ground: the region, geographic, from the sheet; and under
  // it the commandery, administrative, from the scans. A line each — they are different answers, and
  // side by side the longer pairs ran past the width of the readout.
  // Asked of the subhex under the cursor, so a bay cut out of a shore hex answers "no commandery" while
  // the land beside it answers for the province — the two are different ground.
  const cm = commanderyAt(h, hoverRi);
  tooltip.innerHTML = `<span class="t">${name ? name + ' — ' : ''}hex ${h}${subLabel}</span><br>` +
    `${v.t}${hoverM ? ` · ${shKind}` : ''}` +
    (LOCAL ? `${v.r ? ' · river (sheet)' : ''}${v.d ? ' · road (sheet)' : ''}` : '') +
    (v.g ? `<br><span class="rg">${escHtml(v.g)}</span>` : '') +
    (cm?.name ? `<br><span class="cm">${escHtml(cm.name)} commandery <i>(${cm.tier})</i></span>` : '') +
    realmTip(h, hoverRi) +                                // who holds it, while those layers are up
    tokenTip(h) +                                         // and who is standing on it
    isoTip(h, hoverRi) +
    routeTip(h, hoverRi);                                 // and when the marching route would get here
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
    if (realmDropper) return setRealmDropper(false);
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
  S.mode = m;
  svg.classList.toggle('drawing', m === 'draw');
  // Drawing wants every point on the map clickable, and a counter sitting on the hex you are tracing
  // would swallow the click. In Draw mode tokens are scenery; everywhere else they are handles.
  if (groups.tokens) groups.tokens.style.pointerEvents = m === 'draw' ? 'none' : '';
  svg.classList.toggle('routing', m === 'route');
  if (m !== 'draw' && S.drawing) finishDrawing();
  renderRealmPicker();
}
document.getElementById('toolBtns').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (S.drawing) finishDrawing();
  S.coastPickFor = null;
  S.tool = b.dataset.tool;
  document.querySelectorAll('#toolBtns button').forEach(x => x.classList.toggle('on', x === b));
  // Reaching for the tool is as good as asking for the layer: read the scan if it has not been, so
  // there is a palette to choose from and something on screen to paint against.
  if (S.tool === 'realm') ensureRealmLayer();
  renderRealmPicker();
});
document.getElementById('realmLayer')?.addEventListener('change', () => {
  realmPaint = null;                       // a colour from one scan means nothing on the other
  setRealmDropper(false);                  // and neither does a dropper aimed at the one you left
  ensureRealmLayer();
  renderRealmPicker();
});
/* `input` rather than `change`, so dragging around the dialog's wheel repaints the swatch live and
   you can see what you are mixing against the map behind it. The colour is armed as it is mixed —
   closing the dialog leaves the brush loaded with whatever you settled on, which is what picking a
   colour is for. */
document.getElementById('realmCustomInput')?.addEventListener('input', e => {
  const c = rgbKey(e.target.value);
  realmCustom.set(document.getElementById('realmLayer').value, c);
  realmPaint = c;
  setRealmDropper(false);
});
/* The published map keeps the Draw panel, but only Map painting: someone reading it may well want to
   move a front line on their own copy, which touches nobody else's, since it lives in their browser.
   The line tools, the Stronghold tool and — because naming places and rubbing out roads are the map's
   own making rather than a reader's business — Label and Erase are dropped, buttons and their help
   alike, rather than hidden, along with the Data panel's sheet refetch. Marked in the HTML so the two
   lists cannot drift apart. */
for (const el of document.querySelectorAll(`[data-pane="draw"] [data-${LOCAL ? 'pub' : 'dev'}]`))
  el.remove();
// Whichever tool is left first is the one the panel opens on, so the default is read off the row
// rather than assumed: locally that is Road, published it is Map painting — armed, but it still
// fetches nothing until it is clicked and paints nothing until a colour is chosen.
{
  const first = document.querySelector('#toolBtns button');
  if (first) { S.tool = first.dataset.tool; first.classList.add('on'); }
}

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
/* ---------------- how far this browser has drifted from the shipped map ----------------
   Two files ship with the map and two are edited from it: the drawing and the board. The reset button
   lights when what is in front of you differs from either, which is a question about *content* and not
   about whether anything has been touched — draw a road and rub it out again and the answer is no,
   which is the answer a flag counting edits would get wrong.

   Compared as text with the keys sorted, because two objects holding the same map need not hold it in
   the same order: everything added since the file was written was added at the end, and a round trip
   through a browser's storage is under no obligation to preserve that. Sorting costs a few
   milliseconds on a half-megabyte drawing, which is why it is done after the fact rather than in the
   middle of a stroke — the check is deferred to the next idle moment and the frames in between are
   left alone. */
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}
// The shipped files as fetched, kept whole: the reset needs to hand them back and the drift check needs
// to compare against them, and re-fetching for either would be a network round trip to answer a
// question already answered.
const canon = { features: null, featText: null, featSig: null, tokens: null, tokSig: null };
function driftParts() {
  const out = [];
  if (canon.featSig != null && stableJson(S.features) !== canon.featSig) out.push('drawing');
  if (canon.tokSig != null && stableJson(S.tokens) !== canon.tokSig) out.push('board');
  return out;
}
let driftTimer = null;
function markDrift() {
  clearTimeout(driftTimer);
  driftTimer = setTimeout(() => {
    const btn = document.getElementById('resetAll');
    if (!btn) return;
    /* Nothing to undo means nothing to press: with the map exactly as its files have it, the button
       goes grey and stops answering, which says "there is no work here" without a word — where a
       label explaining that a live-looking button would do nothing is a sentence spent on a
       non-event. It also disarms, since a question already asked about a state that has since gone
       back to the files has stopped being a question. */
    const parts = driftParts();
    btn.classList.toggle('drift', parts.length > 0);
    btn.disabled = !parts.length;
    if (!parts.length) armReset(false);
    btn.dataset.label = 'Reset map';
  }, 200);
}
/* Everything back to the files, in one gesture. The two panel buttons that already did half of this
   each are still there — this is the one that does not require knowing which panel owns what — and it
   is the only one that says, before it acts, what it is about to throw away.

   Routes and isochrone origins are left alone deliberately. They are planning laid *over* the map
   rather than part of it, no file ships with them, and their own Clear all buttons are a click away in
   the panel where they belong. */
/* Armed by the first click on Reset and disarmed by anything else: a second click on the button, a
   click anywhere on the page, Esc, or five seconds of nothing. The tab is a separate button, so the
   confirming click lands somewhere the first one was not — a double-click cannot answer a question it
   never saw. */
let resetArmTimer = null;
function armReset(on) {
  const slot = document.getElementById('resetSlot'), tab = document.getElementById('resetConfirm');
  if (!slot) return;
  clearTimeout(resetArmTimer);
  slot.classList.toggle('armed', on);
  if (!on) return;
  // One question, always the same one. What is at stake is already on the button's own label and in
  // the colour it is wearing; the tab is the answer slot, and a slot that reworded itself would be
  // asking to be read again every time rather than clicked.
  tab.textContent = 'Are you sure?';
  resetArmTimer = setTimeout(() => armReset(false), 5000);
}
async function resetEverything() {
  armReset(false);
  if (!canon.featText) return toast('The shipped data/features.json could not be read', true);
  S.features = migrateFeatures(JSON.parse(canon.featText));
  S.tokens = normalizeTokens(JSON.parse(JSON.stringify(canon.tokens || []))) || [];
  S.undoStack = [];
  tokensSnap = JSON.stringify(S.tokens);
  // Storage is only ever touched while saving is on — off means off in both directions, so a reset made
  // in a throwaway session does not quietly delete the work the switch was turned off to protect.
  if (saveOn()) try {
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(TOK_LS);
    if (canon.features.stamp) localStorage.setItem(FEAT_SRC_LS, canon.features.stamp);
    localStorage.setItem(FEAT_BASE_LS, canon.featText);   // reset to the file: the file is the parent
    if (startingTokensStamp) localStorage.setItem(TOK_SRC_LS, startingTokensStamp);
  } catch {}
  commitFeatures();
  commitTokens({ quiet: true });          // the shipped board is not a change to take back
  markDrift();
  toast('Map reset to the data files');
}
function showSaving() {
  const btn = document.getElementById('saveToggle'), on = saveOn();
  if (!btn) return;
  btn.classList.toggle('on', on);
  btn.classList.toggle('off', !on);
  btn.dataset.label = on ? 'Saving — keeps edits on reload'
                         : 'Not saving — clears edits on reload';
}
function setSaving(on) {
  UI.save = on;
  saveUI();
  showSaving();
  // Switching it on makes what is on screen the saved state at once, rather than waiting for the next
  // edit: the alternative is a browser that says it is saving while holding something older.
  if (on) { saveLocal(); saveTokens(); saveRoutes(); }
}

async function resetDrawing() {
  if (!confirm('Discard local drawing and reload data/features.json?')) return;
  const ff = await fetchFeaturesFile();
  if (!ff) return alert('Could not load data/features.json.');
  // Only while saving is on — off means storage is not written to *or* deleted from, so a reset made in
  // a throwaway session leaves the saved work the switch was turned off to protect.
  if (saveOn()) try {
    localStorage.removeItem(LS_KEY);
    // The fingerprint and the parent both go with it: what is in the browser is now this file exactly,
    // so the next load has nothing to think stale and nothing to merge.
    localStorage.setItem(FEAT_SRC_LS, ff.stamp);
    localStorage.setItem(FEAT_BASE_LS, JSON.stringify(ff.obj));
  } catch {}
  S.features = migrateFeatures(ff.obj);
  S.undoStack = [];
  commitFeatures();
}
document.getElementById('resetBtn').onclick = resetDrawing;
document.getElementById('drawResetBtn').onclick = resetDrawing;
document.getElementById('saveToggle').onclick = () => setSaving(!saveOn());
document.getElementById('resetAll').onclick = () =>
  armReset(!document.getElementById('resetSlot').classList.contains('armed'));
document.getElementById('resetConfirm').onclick = resetEverything;
// Anything else at all puts the question away. Capture, so it hears the click before whatever the
// click was actually for — which goes ahead as normal; dismissing is not a click the map loses.
document.addEventListener('pointerdown', e => {
  if (!e.target.closest?.('#resetSlot')) armReset(false);
}, true);
addEventListener('keydown', e => { if (e.key === 'Escape') armReset(false); });
document.getElementById('newRoute').onclick = () => newRoute();
/* Which ends are held is asked at the moment of asking rather than kept as a setting, because it is a
   fact about the march in front of you — a supply run comes home, a campaign does not — and a setting
   would have to be remembered and checked before every use. The menu drops from the button, so the
   answer is one click further on rather than one screen away. */
document.getElementById('optRoute').onclick = e => {
  if (S.activeRoute < 0) return toast('Select a route first', true);
  const r = e.currentTarget.getBoundingClientRect();
  openCtx(r.left, r.bottom + 6, optimiseMenu(S.activeRoute));
};
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
for (const id of ['inf', 'cav', 'wag', 'non', 'li', 'forced', 'marines', 'fleet', 'embark', 'noTrade', 'stops', 'weather'])
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
    commanderiesChanged();   // the sheet's own stronghold flags feed the naming
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
    /* Invert is a tracing aid and nothing else: it exists so a dark reference scan can be flipped
       into light lines to draw against. The scans themselves are dropped from the published build,
       which leaves the button there offering to solarise the finished map — a control whose only
       honest use has been taken away. So it goes out with them, and the published row is a
       checkbox, a slider, and whatever that layer has to say for itself. */
    row.innerHTML = `<label><input type="checkbox" ${L.def > 0 ? 'checked' : ''}> ${L.name}</label>
      <input type="range" min="0" max="1" step="0.05" value="${L.def || 1}">
      ${L.names ? `<button class="nam" title="${escHtml(L.names)}">A</button>` : ''}
      ${LOCAL ? `<button class="inv" title="Invert the reference layer for easier tracing.">◐</button>` : ''}`;
    const [chk, rng] = row.querySelectorAll('input');
    const inv = row.querySelector('.inv');
    const nmb = row.querySelector('.nam');
    // Whether this layer's names are showing. Kept on the layer rather than in the closure so the
    // renderers can ask — a name group is rebuilt from scratch whenever the ground under it changes,
    // and has to come back up in the state the button is showing.
    if (L.names) L._names = L.nameDef ?? false;
    // What the switch was last time apply() ran, so a wash going on or off can be told apart from the
    // sixty calls an opacity drag makes. Seeded with the layer's own default, or the first call would
    // read as a change and refit the labels for nothing.
    L._was = L.def > 0;
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
      /* A wash going on or off changes what the layers *under* it are still showing, and a name now
         belongs on ground you can see — so switching one of the stacked realm layers refits every
         label on the map, not only its own. Guarded on the switch actually having flipped, since
         apply() also runs on every frame of an opacity drag. */
      const flipped = REALM_STACK.includes(L.id) && L._was !== chk.checked;
      L._was = chk.checked;
      if (L.names) applyNameGroup(L, chk.checked, flipped);
      else if (flipped) renderRealmNames();
    };
    chk.onchange = apply; rng.oninput = apply;
    if (inv) inv.onclick = () => { L._inv = !L._inv; inv.classList.toggle('on', L._inv); apply(); };
    if (nmb) {
      nmb.classList.toggle('on', !!L._names);
      nmb.onclick = () => { L._names = !L._names; nmb.classList.toggle('on', L._names); apply(); };
    }
    list.appendChild(row);
    // Kept on the layer so something else can work the switch and have the panel agree: the Map
    // painting tool turns its own scan on, and a checkbox that said otherwise would be a lie.
    L._apply = apply; L._row = row; L._chk = chk; L._nmb = nmb;
  }
}
/* A names group is only ever drawn while it is being looked at. Fitting the realm labels means walking
   every held subhex, splitting it into contiguous blocks and probing the ground along a curve for each
   one, and that is not work to do for a layer nobody has asked to read — so the button being switched
   on is what builds it. Both conditions matter: names belong to their layer, and a layer that is off
   has no names.

   Whose names get built is *not* just this layer's, though. Since the two realm layers are placed
   together, switching either one changes what the other is allowed to draw — turn Warlords on and the
   Blue Scarves label it takes over has to come off Borders — so the whole pass is redone whenever the
   set of visible name groups changes.

   Which is why the rebuild is guarded rather than unconditional: `apply` also runs on every frame of an
   opacity drag, and refitting there would refit sixty times a second. It fires when a group's visibility
   actually flipped, or when a visible one has nothing in it yet. */
function applyNameGroup(L, on, flipped) {
  const show = on && !!L._names;
  if (L.id === 'labels') {
    if (groups.shNames) groups.shNames.style.display = show ? '' : 'none';
    return;
  }
  const g = realmNameG[L.id];
  if (!g) return;
  const was = g.style.display !== 'none';
  g.style.display = show ? '' : 'none';
  // `flipped` is this layer's *wash* having been switched, which changes the ground the other layers
  // may write on even when this one's own names never appear.
  if (was !== show || flipped || (show && !g.firstChild)) renderRealmNames();
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
const TOK_LS = 'rotmap_tokens_v1';
const TOK_MAXLEN = 24;
/* Who is commanding it. The counter itself carries a *designation* — V, XII'a — because that is what has
   to be readable at a glance from across the map, and a designation is short. Whose command it is is a
   different kind of fact: it is asked about one counter at a time, so it belongs in the readout rather
   than on the board, where fourteen names would bury the terrain. Optional throughout, and blank is a
   real answer, not a gap to be filled — the Blue Scarves are not anybody's command. */
const TOK_NAME_MAXLEN = 48;

const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tokenById = id => S.tokens.find(t => t.id === id);

/* Rebuilt rather than trusted, wherever tokens come in from outside: ids are reissued and colours
   validated, so a hand-edited file can't leave two tokens sharing an id or a colour the renderer
   can't use, and a hex that isn't on the map is dropped rather than drawn nowhere. */
function normalizeTokens(arr) {
  if (!Array.isArray(arr)) return null;
  return arr.filter(t => t && S.hexes[+t.h]).map((t, i) => {
    const out = {
      id: i + 1, h: +t.h,
      label: String(t.label ?? '').slice(0, TOK_MAXLEN),
      color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : TOKEN_COLORS[i % TOKEN_COLORS.length],
    };
    // Both of these are optional and both are omitted when unset rather than written as empty, so a
    // board that uses neither exports exactly as it did before either existed.
    if (t.rim === TOK_RIM_LIGHT || t.rim === TOK_RIM_DARK) out.rim = t.rim;
    const name = String(t.name ?? '').trim().slice(0, TOK_NAME_MAXLEN);
    if (name) out.name = name;
    return out;
  });
}
// The board as the news last left it, shipped with the map. It seeds an empty browser and can be
// asked for again at any time — it is a starting position, not a save. The fingerprint is for the
// recolour below: it is how a change to the shipped board reaches a browser that already has one.
let startingTokensStamp = null;
async function fetchStartingTokens() {
  try {
    const r = await fetch('data/tokens.json', DATA_FETCH);
    if (!r.ok) return null;
    const txt = await r.text();
    startingTokensStamp = quickHash(txt);
    return normalizeTokens(JSON.parse(txt).tokens);
  } catch { return null; }
}

/* A counter's rim: black or white, and nothing else. Two states rather than a colour, because the rim is
   not carrying information — the fill does that — it is carrying *contrast*, and against the terrain of
   this map there are only two useful answers. A click on the counter swaps them.

   **Black by default**, for every counter, whatever its fill. The obvious alternative is to derive it
   from the fill the way the numeral inside is derived, giving each counter the rim that contrasts with
   itself — and that is worse, because it makes the board's outlines inconsistent for a reason the reader
   cannot see. Fourteen counters, some ringed black and some white according to their own darkness, read
   as a board with something going on in it; fourteen ringed alike read as fourteen counters. Uniform also
   keeps the *fill* doing all the work of identification, which is the point of matching the fills to the
   Warlords scan in the first place. The swap is there for the one case the default cannot cover — a dark
   counter on its own dark ground — and it is one click, on the counter, where the eye already is. */
const TOK_RIM_DARK = '#14181e', TOK_RIM_LIGHT = '#fff';
const tokenRim = t => t.rim === TOK_RIM_LIGHT ? TOK_RIM_LIGHT : TOK_RIM_DARK;
function saveTokens() {
  if (saveOn()) try { localStorage.setItem(TOK_LS, JSON.stringify({ version: 1, tokens: S.tokens })); } catch {}
  markDrift();
}
/* A board already in this browser, brought up to date with the map's colours — and with its **colours
   only**. Where the counters *are* is the reader's own; a position they have been playing for a month
   must survive a republication, so nothing here moves anything. What colour Legion XII is, on the other
   hand, is the map's to say: the label names a legion, the map paints that legion neon green, and a white
   counter labelled XII is simply out of date. The palette was recoloured to match the Warlords scan and
   every existing board went on showing the old colours, because the shipped board only ever seeded an
   empty browser — the same shape of fault as a stale features file shadowing a republished one.

   Keyed on a fingerprint of the shipped board, so this runs once per publication rather than on every
   load, and a deliberate recolour survives until the next one. It is a real undo step, not a quiet one:
   one Ctrl+Z puts the old colours back for anyone who wanted them. */
const TOK_SRC_LS = 'rotmap_tokens_src_v1';
async function refreshLegionColours() {
  await fetchStartingTokens();                    // for the fingerprint; the positions are not wanted
  if (!startingTokensStamp) return false;
  let seen = null;
  try { seen = localStorage.getItem(TOK_SRC_LS); } catch {}
  if (seen === startingTokensStamp) return false; // already up to date with this publication
  const changed = S.tokens.filter(t => {
    const want = legionColorFor(t.label);
    return want && t.color !== want;
  });
  if (saveOn()) try { localStorage.setItem(TOK_SRC_LS, startingTokensStamp); } catch {}
  if (!changed.length) return false;
  for (const t of changed) t.color = legionColorFor(t.label);
  commitTokens();
  return true;
}
/* `quiet` is for the one commit that isn't a change the user made — seeding the board at boot.
   `coalesce` folds a run of live changes (a colour picker being dragged) into one undo step. */
function commitTokens(opts) {
  if (!opts?.quiet) pushUndoEntry('tokens', tokensSnap ?? JSON.stringify(S.tokens), opts?.coalesce);
  tokensSnap = JSON.stringify(S.tokens);
  renderTokens(); renderTokenList(); renderRealmPicker(); saveTokens();
}

// Two armies arriving in the same colour would defeat the point, so a new token takes the first
// colour nobody is using before it starts repeating.
/* A colour for a counter that is nobody's legion. The spares are offered first, because the fifteen
   warlord colours mean something on this map and a baggage train wearing Legion VII's green is a counter
   that reads as Legion VII's. Only once the spares are all out does it fall back to the rest of the
   palette, which is better than repeating: at that point every colour says something misleading and the
   only remaining virtue is being distinct. */
function nextTokenColor() {
  const used = new Set(S.tokens.map(t => t.color));
  return PALETTE_SPARE.find(c => !used.has(c))
      || TOKEN_COLORS.find(c => !used.has(c))
      || TOKEN_COLORS[S.tokens.length % TOKEN_COLORS.length];
}
/* A new counter takes its legion's colour if its label names one, and otherwise the first colour nobody
   is using — two armies arriving in the same colour would defeat the point. The legion case comes first
   and is *not* subject to the "unused" rule: two counters of Legion V should be the same colour, because
   they are the same legion. */
function addToken(h, label, color) {
  const id = S.tokens.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1;
  S.tokens.push({ id, h, label: String(label).slice(0, TOK_MAXLEN),
                  color: color || legionColorFor(label) || nextTokenColor() });
  commitTokens();
}
function deleteToken(t) { S.tokens = S.tokens.filter(x => x !== t); commitTokens(); }

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
    // Black rim or white, whichever this counter has been given — see tokenRim.
    el('circle', { cx: p.x, cy: p.y, r: p.r, fill: t.color,
                   stroke: tokenRim(t), 'stroke-width': 1.7 }, g);
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
    // The commander's name sits beside the designation in the row, quieter than it — the row is a list of
    // forces and the designation is what identifies one; the name is what it is called.
    div.innerHTML = `<span class="sw" style="background:${escHtml(t.color)}"></span>` +
      `<span class="nm">${escHtml(t.label)}` +
      (t.name ? `<i class="who">${escHtml(t.name)}</i>` : '') +
      `</span><span class="hx">hex ${t.h}</span>` +
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
    const tokenNames = tokenColourNames(c);
    b.title = tokenNames.length ? tokenNames.join(', ') : c;
    b.setAttribute('aria-label', tokenNames.length ? `${c}: ${tokenNames.join(', ')}` : c);
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

// Given the subhex the pointer is on, the menu's heading names what is standing there rather than
// what the sheet once called the hex — the same answer the readout under the cursor is giving.
function hexTitle(h, ri) {
  const name = ri == null ? (S.features.labels[h] ?? S.names.hexes[h] ?? '') : placeName(h, ri);
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
/* Painting a realm colour over a whole commandery at once. The Map tool paints a subhex at a time, and a
   sweep paints a stroke, which is the right grain for a frontier and the wrong grain for the commonest edit
   of all: a province changes hands. Seventy-two commanderies is the administrative map the scans already
   draw, so "this province is his now" is one instruction, and doing it by hand meant nine or ten strokes
   and a squint at the boundary.

   Every subhex the commandery holds, from the subhex reading — so it stops at the coast, and the bay in a
   shore hex is not painted with the land. One undo step for the lot: it is one decision. */
function paintCommandery(layer, ci, colour) {
  const cells = commanderyCells();
  pushUndo();
  const all = S.features.realms || (S.features.realms = {});
  const byHex = all[layer] || (all[layer] = {});
  let n = 0;
  for (const [k, i] of cells) {
    if (i !== ci) continue;
    const p = k.indexOf(':'), hx = k.slice(0, p), ri = +k.slice(p + 1);
    const byRi = byHex[hx] || (byHex[hx] = {});
    if (colour) byRi[ri] = colour;
    else { delete byRi[ri]; if (!Object.keys(byRi).length) delete byHex[hx]; }
    n++;
  }
  commitFeatures();
  return n;
}
function hexMenu(h, pt, wp) {
  return box => {
    ctxHead(box, hexTitle(h, pt ? regionAt(h, pt) : 0));
    /* The Map tool's own entries, at the top, and only while that tool is in hand. Everything the tool can
       do was in the panel or on the pointer; the one thing a right-click is for is acting on *what you are
       pointing at*, and the two entries below are exactly that — this subhex, and the province it is part
       of. Undo and the clear are here because a painting tool wants them within reach of the hand that is
       painting, not across the window. */
    if (S.mode === 'draw' && S.tool === 'realm' && pt) {
      const layer = document.getElementById('realmLayer').value;
      const ri = regionAt(h, pt);
      const cur = realmOverride(layer, h, ri);
      /* Two entries, and neither says which colour. The menu opened with the loaded colour named and
         swatched on both, and a palette flyout beside each so another could be chosen — which was one
         reading of "colour" too many. The colour is loaded in the panel, the panel shows it, and by the
         time you are right-clicking the map you have already chosen it: repeating it here was the tool
         telling you what you had just told it, twice, and offering to ask again. What the menu is for is
         *where* the colour goes — this subhex, or the whole province — so that is all it says. */
      if (realmPaint) ctxItem(box, 'Paint', () => { setRealmAt(layer, h, ri, realmPaint); closeCtx(); });
      // Offered only where there is a commandery, since otherwise it is an entry with no subject.
      const cm = commanderyAt(h, ri) || commanderyAt(h);
      if (realmPaint && cm)
        ctxItem(box, 'Paint commandery', () => { paintCommandery(layer, cm.i, realmPaint); closeCtx(); });
      if (cur || cm) ctxSep(box);
      if (cur) ctxItem(box, 'Rub out this subhex', () => { setRealmAt(layer, h, ri, null); closeCtx(); });
      ctxItem(box, 'Undo<span class="arw">Ctrl+Z</span>', () => { closeCtx(); undoLast(); });
      ctxItem(box, 'Reset painted hexes', () => { closeCtx(); resetDrawing(); }, 'danger');
      ctxSep(box);
    }
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
      /* Whether the column *halts* here, which is a different question from whether it comes here.
         Orders are written in whole days, so a halt spends whatever is left of the day it lands in —
         and a waypoint put down only to send the march over a particular pass or ford was never
         meant to cost that. Offered on the first waypoint too, where it reads oddly but does no
         harm: nothing is billed before the column sets out, and a route that gets reordered may not
         start there for long. The last one is a genuine halt, since arriving is arriving. */
      const w = rt.wps[wp.wi];
      // With the route's own switch off nothing halts anywhere, so the entry says so rather than
      // offering to change a flag that is not being read.
      const off = !routeStops(rt) ? '<span class="arw">route halts nowhere</span>' : '';
      ctxItem(box, w.thru ? `Halt here${off || '<span class="arw">now passes through</span>'}`
                          : `Pass through — no halt${off || '<span class="arw">now a stop</span>'}`, () => {
        closeCtx();
        pushUndoRoutes();
        if (w.thru) delete w.thru; else w.thru = true;
        computeRoute();
      });
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
      computeRoute();
    });
    /* Emptying *this* march, beside emptying them all. The two are not the same question and the
       second is much the bigger one: a board with four routes on it and one of them wrong wants the
       one wrong one gone, and clearing the lot was the only thing the map offered. It names the route
       it will empty rather than saying "the active one", because which route is active is a fact
       about a panel that may well be shut, and this menu is on the map. */
    if (S.mode === 'route' && act?.wps.length)
      ctxItem(box, `Clear <b>${escHtml(act.name)}</b><span class="arw">${act.wps.length} wp</span>`,
              () => { closeCtx(); clearRouteWaypoints(S.activeRoute); }, 'danger');
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
    const name = placeName(st.h, st.ri);
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
    ctxHead(box, `<b>${escHtml(t.label)}</b>${t.name ? ' · ' + escHtml(t.name) : ''} — token`);
    ctxItem(box, 'Rename…', () => {
      const v = prompt('Token text:', t.label);
      closeCtx();
      if (v != null && v.trim()) { t.label = v.trim().slice(0, TOK_MAXLEN); commitTokens(); }
    });
    /* The designation and the commander are two separate things to set, so they are two entries rather
       than one prompt asking for both. The item says which it is holding, so a counter with a commander
       shows the name here and one without shows the invitation. */
    ctxItem(box, t.name ? `Commander: <b style="color:#fff">${escHtml(t.name)}</b>` : 'Commander…', () => {
      const v = prompt('Who commands this force? Leave blank for none — not every force has a name.',
                       t.name || '');
      closeCtx();
      if (v == null) return;
      const n = v.trim().slice(0, TOK_NAME_MAXLEN);
      if (n) t.name = n; else delete t.name;
      commitTokens();
    });
    ctxFlyout(ctxItem(box, `<span class="sw" style="background:${escHtml(t.color)}"></span>Colour<span class="arw">▸</span>`),
              s => buildColorPanel(s, TOKEN_COLORS, () => t.color,
                                   c => { t.color = c; commitTokens({ coalesce: 'tkcolor' + t.id }); }));
    // No rim entry. A click on the counter swaps it, which is the whole of the feature, and a menu row
    // saying so was a line of text spent on something already done by the more obvious gesture.
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
  // Taking the shipped board wholesale also takes its colours, so this browser is up to date with that
  // publication by definition — recording it stops the recolour pass finding work to do on next boot.
  if (startingTokensStamp && saveOn()) try { localStorage.setItem(TOK_SRC_LS, startingTokensStamp); } catch {}
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
/* The drawing as shipped with the map, and a fingerprint of the file it came from. The fingerprint is
   what lets a republished map reach a browser that has been here before — see chooseFeatures. */
async function fetchFeaturesFile() {
  try {
    const r = await fetch('data/features.json', DATA_FETCH);
    if (!r.ok) return null;
    const txt = await r.text();
    const j = JSON.parse(txt);
    if (!Array.isArray(j.features)) return null;
    return { obj: { version: 2, labels: {}, strongholds: {}, ...j }, stamp: quickHash(txt) };
  } catch { return null; }
}
// Enough of a fingerprint to tell one publication of a file from the next. Not a checksum for anything
// that matters — length plus a rolling hash, which no plausible edit survives unchanged.
function quickHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return s.length + '-' + h.toString(36);
}
/* ---------------- carrying local edits onto a republished file ----------------
   Which drawing to open with was, for a long time, a choice between two answers that were each wrong
   half the time. Locally the browser's copy won, so a features.json pulled from someone else was
   invisible until the copy was thrown away by hand. On the published map the *file* won whenever it
   changed, so a reader who had named a dozen realms lost the lot the next time the map was
   republished — which is the fault this section exists to fix, and it is not a choice at all. It is a
   **merge**: the copy in the browser and the file on the server are two descendants of the same
   parent, and what is wanted is both sets of changes.

   So the parent is kept. Beside the working copy sits the file it was made against, and when a new one
   arrives the three are merged: for every part of the drawing, whoever changed it since the parent
   wins, and where both changed the same part the local edit is kept — a reader's own work is the thing
   they will notice missing, and the file's version of it is one republication away from arriving again
   anyway. Where neither changed anything the parent's value simply passes through.

   The drawn lines are not merged that way, because a line has no key to merge under: they are matched
   by their whole content, so what the browser has is the new file's lines, less the ones erased
   locally, plus the ones drawn locally. Editing a line in place therefore reads as an erase and a
   draw, which is what it is here — a line is a value, not a thing with an identity.

   It costs one more copy of the file in storage, which is the whole of the price. */
const FEAT_SRC_LS = 'rotmap_features_src_v1';
// Where a superseded browser copy goes, so that being superseded is recoverable rather than final. Kept
// for the case the merge cannot run: a copy from before the parent was ever recorded.
const FEAT_PREV_LS = 'rotmap_features_prev_v1';
// The file the working copy was made against — the parent of both sides of the merge.
const FEAT_BASE_LS = 'rotmap_features_base_v1';
// What the last merge did, for the line it says afterwards. Null when no merge was needed.
let featureMerge = null;

const sameJson = (a, b) => stableJson(a) === stableJson(b);
/* Three-way merge of plain JSON. The rules are the ordinary ones and they are worth stating plainly:
   a side that changed nothing yields to the side that did; a key that only one side has is taken from
   whoever has it; a key one side deleted stays deleted; and where both sides changed the same value,
   the local one is kept. Objects recurse, so two edits inside one hex do not collide unless they are
   to the same field. Anything that is not a plain object — a number, a string, an array of markers —
   is atomic, which is right for this data: a stronghold's marker list is one statement about that hex,
   and half of one side's list mixed with half of the other's would be a hex neither of them meant. */
function merge3(base, mine, theirs, tally) {
  if (sameJson(mine, base)) return theirs;              // untouched here: take the update
  if (sameJson(theirs, base)) { tally.kept++; return mine; }   // the file left it alone: keep mine
  const plain = v => v && typeof v === 'object' && !Array.isArray(v);
  if (!plain(mine) || !plain(theirs)) { tally.conflicts++; return mine; }
  const out = {};
  const keys = new Set([...(plain(base) ? Object.keys(base) : []), ...Object.keys(mine), ...Object.keys(theirs)]);
  for (const k of keys) {
    const v = merge3(plain(base) ? base[k] : undefined, mine[k], theirs[k], tally);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
// The drawn lines, matched whole: the new file's, less what was erased here, plus what was drawn here.
function mergeFeatureList(base, mine, theirs, tally) {
  const key = f => stableJson(f);
  const mk = new Set(mine.map(key));
  const erased = new Set(base.filter(f => !mk.has(key(f))).map(key));
  const bk = new Set(base.map(key));
  const drawn = mine.filter(f => !bk.has(key(f)));
  const out = theirs.filter(f => !erased.has(key(f)));
  const have = new Set(out.map(key));
  for (const f of drawn) if (!have.has(key(f))) { out.push(f); have.add(key(f)); }
  tally.drawn += drawn.length; tally.erased += erased.size;
  return out;
}
function mergeFeatureFiles(base, mine, theirs) {
  const tally = { kept: 0, conflicts: 0, drawn: 0, erased: 0 };
  const strip = o => { const c = { ...o }; delete c.features; return c; };
  const out = merge3(strip(base), strip(mine), strip(theirs), tally);
  out.features = mergeFeatureList(base.features || [], mine.features || [], theirs.features || [], tally);
  tally.total = tally.kept + tally.conflicts + tally.drawn + tally.erased;
  return { obj: migrateFeatures(out), tally };
}

function chooseFeatures(ls, file, baseTxt) {
  featureMerge = null;
  const parsed = (() => { try { return ls ? JSON.parse(ls) : null; } catch { return null; } })();
  if (!file) return parsed;                       // nothing shipped: the local copy is all there is
  if (!parsed) return file.obj;
  const seen = localStorage.getItem(FEAT_SRC_LS);
  if (seen === file.stamp) return parsed;         // the copy was made against this same file
  // A new file, and the parent of the local copy is on hand: merge rather than choose.
  const base = (() => { try { return baseTxt ? migrateFeatures(JSON.parse(baseTxt)) : null; } catch { return null; } })();
  if (base) {
    const r = mergeFeatureFiles(base, migrateFeatures(parsed), migrateFeatures(JSON.parse(JSON.stringify(file.obj))));
    featureMerge = r.tally;
    return r.obj;
  }
  // No parent recorded — a copy made before any of this existed. The old rules, which are the best
  // that can be done without one: the author's working state wins, a reader's is superseded and
  // stashed. From this load on there is a parent, so it happens at most once per browser.
  if (LOCAL) return parsed;
  /* Republished since: the map's own answer wins. The superseded copy is **stashed rather than deleted**,
     because "a reader's sketch" is not the only thing it can be. Anyone authoring against a non-local
     hostname — a LAN address, a tunnel, the deployed site itself — is an author whose unexported work
     this would otherwise discard without trace. It is one key, it is overwritten each time, and it turns
     an irreversible loss into a recoverable one. */
  try { localStorage.setItem(FEAT_PREV_LS, ls); localStorage.removeItem(LS_KEY); } catch {}
  return file.obj;
}
async function boot() {
  const T = await (await fetch('data/terrain.json', DATA_FETCH)).json();
  S.G = T.grid; S.hexes = T.hexes;
  try { S.names = await (await fetch('data/strongholds.json', DATA_FETCH)).json(); } catch {}
  // Shipped with the map and never edited from it, so unlike the drawing it is simply read: a missing
  // or broken file costs the commandery readout and its search rows and nothing else.
  try { S.commanderies = (await (await fetch('data/commanderies.json', DATA_FETCH)).json()).commanderies || []; }
  catch { S.commanderies = []; }
  initGeom();
  buildScaffold();
  if (adaptiveView()) coverView(); else applyViewBox();
  { const r = svg.getBoundingClientRect(); if (r.width && r.height) wasLandscape = r.width >= r.height; }
  renderTerrain();
  /* The shipped file is fetched whether or not this browser has a copy of its own, because deciding
     between the two means knowing whether the file has changed since that copy was made. One fetch of a
     file the map needs anyway. */
  const ff = await fetchFeaturesFile();
  /* Kept for the reset button and the drift check, both of which need the file as it shipped rather
     than the working copy about to be made from it — and kept as **text**, because the object is not
     safe to hold onto: with nothing in storage `chooseFeatures` hands back that very object as the
     working state, and every edit after that would quietly be an edit to the map's own idea of what
     it shipped with. So the canon is a string nobody can draw on, and both the working copy and the
     reset are parsed out of it. */
  canon.features = ff;
  if (ff) {
    canon.featText = JSON.stringify(ff.obj);
    canon.featSig = stableJson(migrateFeatures(JSON.parse(canon.featText)));
  }
  // With saving off the browser's copy is passed over rather than deleted: this session starts from
  // the shipped map, and whatever was stored is still there for a session that wants it.
  const chosen = chooseFeatures(saveOn() ? localStorage.getItem(LS_KEY) : null, ff,
                                saveOn() ? localStorage.getItem(FEAT_BASE_LS) : null);
  // A copy from storage is already this browser's own; the shipped object is not, and is re-parsed.
  if (chosen) S.features = chosen === ff?.obj ? JSON.parse(canon.featText) : chosen;
  /* Recorded after the choice, so from here on a local edit counts as made against *this* file — and
     the file itself is kept beside the fingerprint, since telling that the file has changed is only
     half of what the next load needs. The other half is what it changed *from*. */
  if (ff && saveOn()) try {
    localStorage.setItem(FEAT_SRC_LS, ff.stamp);
    localStorage.setItem(FEAT_BASE_LS, canon.featText);
  } catch {}
  migrateFeatures(S.features);
  renderFeatures(); renderLabels();
  buildLayerUI();
  for (const L of LAYERS) L._apply?.();
  // A browser that has moved tokens before keeps its own board, exactly as it left it. One that
  // never has starts from the positions shipped with the map rather than from nothing.
  /* Fetched whether or not this browser has a board of its own, which it did not used to be: the reset
     button and the drift light both need to know what the shipped board *is*, and answering "does this
     differ" by fetching the file at the moment of asking would put a network round trip inside a
     tooltip. */
  canon.tokens = await fetchStartingTokens() || [];
  canon.tokSig = stableJson(canon.tokens);
  const tls = saveOn() ? localStorage.getItem(TOK_LS) : null;
  if (tls) {
    try { S.tokens = normalizeTokens(JSON.parse(tls).tokens) || []; } catch {}
    // The board as loaded is what the first Ctrl+Z should restore to, so record it as the snapshot
    // rather than leaving the first change to take one of itself, after the fact.
    tokensSnap = JSON.stringify(S.tokens);
    renderTokens(); renderTokenList();
    await refreshLegionColours();
  } else {
    // Saved as soon as it is seeded, so the shipped board becomes *this* browser's board: clearing
    // it and reloading then leaves it clear, rather than quietly putting every legion back.
    S.tokens = normalizeTokens(JSON.parse(JSON.stringify(canon.tokens))) || [];
    commitTokens({ quiet: true });   // the board as it arrives is not a change to take back
    if (startingTokensStamp && saveOn()) try { localStorage.setItem(TOK_SRC_LS, startingTokensStamp); } catch {}
  }
  try {
    const rr = JSON.parse(saveOn() ? localStorage.getItem('rotmap_routes_v1') : null);
    if (rr && Array.isArray(rr.routes)) {
      S.routes = rr.routes;
      S.activeRoute = Math.min(rr.active ?? S.routes.length - 1, S.routes.length - 1);
      retireLegionRouteColors();
    }
    if (rr && rr.iso && Array.isArray(rr.iso.origins)) {
      S.iso.origins = rr.iso.origins;
      S.iso.active = Math.min(rr.iso.active ?? 0, S.iso.origins.length - 1);
    }
  } catch {}
  computeRoute();
  showSaving();                     // the switch says what it is doing before anything is asked of it
  markDrift();
  /* A merge is not a thing to do silently. The map on screen is now neither the file that was fetched
     nor the copy that was stored, and saying so — with a count of what was carried across — is the
     difference between a feature and a mystery. Saved at once, too: the merged state is what this
     browser means from here on, and leaving it unwritten until the next edit would mean a reload in
     between quietly doing the merge all over again against the same parent. */
  if (featureMerge) {
    const t = featureMerge;
    saveLocal();
    const bits = [t.drawn && `${t.drawn} drawn`, t.erased && `${t.erased} erased`,
                  (t.kept + t.conflicts) && `${t.kept + t.conflicts} edited`].filter(Boolean);
    toast(t.total ? `Map file updated — your local changes kept (${bits.join(', ')})`
                  : 'Map file updated');
  }
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
    // `??`, not `||`: a hex whose name has been cleared has no name, and must not answer to the one
    // the datasheet used to give it.
    hits.push({ h: +num, name: S.features.labels[num] ?? S.names.hexes[num] ?? '', rank: -1 });
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
  // A commandery answers to the name of the settlement it is named for, which is also a place in its
  // own right — so searching "Cašman" turns up both the town and the commandery around it, one row
  // each. That is the point: they are different answers to the same word. The commandery sorts just
  // below the town of the same name, since the tie-break on equal rank is the name and these two are
  // equal there too — so the order is settled by the pass order above, place first.
  for (const cm of commanderyList()) {
    const rank = score(fold(cm.name));
    if (rank !== null) hits.push({ comm: cm.i, name: cm.name, tier: cm.tier, hexes: cm.hexes, rank });
  }
  /* The counters on the board, by **designation and by commander alike** — "XII" and "Gautarza" are two
     names for the same force and either should find it. This is the question the search could not answer
     and most wanted to: everything else here is a fixed feature of the map, and where a legion is is the
     one fact that changes week to week, so "where is V" was the lookup with no answer but scrolling the
     token list.

     Whichever of the two names matched is what the row is *titled*, since that is the word that was
     typed; the other is shown beside it. Both are scored, and the better of the two wins, so an exact
     commander beats a near-miss designation.

     A token hit resolves to its **hex**, not to a selection kind of its own: the answer to "where is V"
     is a place, and making it a place means it lights up, pans and pins with everything else rather than
     needing a fourth branch through the selection machinery. Two counters in one hex therefore give one
     row each and land in the same spot, which is correct — they are in the same spot. */
  for (const t of S.tokens) {
    const cands = [[t.label, t.name], [t.name, t.label]].filter(([a]) => a);
    let best = null;
    for (const [title, other] of cands) {
      const rank = score(fold(title));
      if (rank !== null && (!best || rank < best.rank)) best = { rank, title, other };
    }
    if (best) hits.push({ h: t.h, ri: t.ri, tok: t.id, name: best.title, other: best.other, rank: best.rank });
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const seen = new Set();
  // Two places in one hex are two answers, so the dedupe key has to carry the subhex — otherwise
  // searching for the one on the far bank would silently return the one on the near bank instead.
  return hits.filter(x => {
    // A counter is keyed by its own id, not by the hex it is standing on: it resolves to that hex when
    // picked, but it is a different answer from the town there and must not be deduped against it.
    const k = x.region != null ? 'r:' + x.region
            : x.comm != null ? 'c:' + x.comm
            : x.tok != null ? 't:' + x.tok
            : x.h + ':' + (x.ri ?? '');
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
let sel = [];      // [{ region } | { comm } | { h }] in the order they were chosen
// Carries the subhex, so selecting the keep on one bank does not light up the town on the other. A
// commandery is keyed by its index rather than its name, since the name is derived and can change
// under a selection — and two commanderies could in principle be named for the same word.
const selKey = it => it.region != null ? 'r:' + it.region
                   : it.comm != null ? 'c:' + it.comm
                   : 'h:' + it.h + ':' + (it.ri ?? '');
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
    // Named from the live data for the same reason a place's row is: rename the seat and the pinned
    // commandery renames with it. One whose only settlement has been erased keeps its row and loses
    // its name, rather than vanishing out of a selection nobody dropped.
    : it.comm != null
    ? { comm: it.comm, name: commanderyName(it.comm) || 'commandery',
        tier: S.commanderies[it.comm]?.tier, hexes: commanderySize(it.comm) }
    // Rebuilt from the marker where there is one, so a renamed stronghold's pin renames with it.
    : { h: it.h, ri: it.ri, name: (it.ri != null && shAt(it.h, it.ri) ? shName(it.h, shAt(it.h, it.ri)) : null)
                                  ?? S.features.labels[it.h] ?? S.names.hexes[it.h] ?? '' });
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
    // The capital's commandery is one hex, so the count has to be able to say so in English.
    const nhex = n => `${n} hex${n === 1 ? '' : 'es'}`;
    if (hit.region != null) {
      meta.textContent = `region · ${nhex(hit.hexes)}`;
    } else if (hit.comm != null) {
      // The tier is what tells two commanderies apart at a glance, and it is the thing you are most
      // likely to have been looking for, so it leads.
      meta.textContent = `${hit.tier} commandery · ${nhex(hit.hexes)}`;
    } else if (hit.tok != null) {
      // Whichever of a counter's two names was *not* the one typed leads the detail, since it is the
      // thing the row can tell you that you did not already know: search "Gautarza" and the row says
      // which force that is; search "III'a" and it says who has it.
      meta.textContent = (hit.other ? hit.other + ' · ' : '') + 'token · hex ' + hit.h;
      // The counter's own colour, so a row and the disc on the map are the same object at a glance.
      const t = tokenById(hit.tok);
      if (t) { const sw = document.createElement('span'); sw.className = 'sw';
               sw.style.background = t.color; nm.prepend(sw); }
    } else {
      const t = S.hexes[hit.h]?.t;
      meta.textContent = hit.h + (t ? ' · ' + t : '');
    }
    const item = hit.region != null ? { region: hit.region }
               : hit.comm != null ? { comm: hit.comm }
               : { h: hit.h };
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
const goToCommandery = i => pick({ comm: i }, false);

/* Move the map to what was picked without touching how far in you are: a search is for finding
   something, not for deciding how closely you wanted to look at it. */
function panToSelection(item) {
  let cx, cy;
  if (item.region != null || item.comm != null) {
    const ids = item.comm != null ? S.commanderies[item.comm]?.hexes || []
                                  : Object.keys(S.hexes).filter(id => S.hexes[id].g === item.region);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      const [hx, hy] = hexCenter(+id);
      x0 = Math.min(x0, hx); x1 = Math.max(x1, hx);
      y0 = Math.min(y0, hy); y1 = Math.max(y1, hy);
    }
    if (x0 === Infinity) return;
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;   // the middle of it, however much of it fits
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
// Same shape, from the other direction: a commandery already knows its hexes, so there is nothing to
// scan for. Off-map filler is skipped here too, though a commandery should never contain any.
/* A commandery's outline, built from the **subhexes** it holds rather than from whole hexagons — the same
   `regionShape` the realm fills use, so where a coastline has cut a shore hex the wash stops at the water's
   edge instead of running out into the bay.

   This is the visible half of the subhex reading. A region's wash still covers whole hexes, and should: the
   sheet names a region per hex and that claim covers all of it, water included. A commandery is different
   in kind — administered ground, read off a picture of the coast — so the water is not its and the wash
   should not say otherwise. */
function commanderyPath(i) {
  let d = '';
  for (const [k, ci] of commanderyCells()) {
    if (ci !== i) continue;
    const p = k.indexOf(':'), h = +k.slice(0, p), ri = +k.slice(p + 1);
    if (S.hexes[h]?.t === 'N/A') continue;
    const r = regionsOf(h)[ri];
    if (r) d += regionShape(h, r);
  }
  return d;
}
/* Regions wash gold and commanderies cyan, because the two overlap everywhere and one of each can be
   lit at once: with a single colour, selecting a commandery inside a selected region would read as
   the region having grown a brighter patch rather than as a second, smaller thing. */
const AREA_TINT = { region: ['rgba(255,215,110,.28)', '#ffd76e'],
                    comm:   ['rgba(95,208,255,.26)',  '#5fd0ff'] };
function renderSelection(justKey) {
  groups.selRegion.innerHTML = '';
  groups.selHex.innerHTML = '';
  sel.forEach((it, i) => {
    if (it.region == null && it.comm == null) return;
    const d = it.comm != null ? commanderyPath(it.comm) : regionPath(it.region);
    if (!d) return;
    const [wash, edge] = AREA_TINT[it.comm != null ? 'comm' : 'region'];
    el('path', { d, fill: wash, 'fill-rule': 'evenodd',
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
    el('path', { d, fill: 'none', stroke: edge, 'stroke-width': 5, 'stroke-linejoin': 'round',
                 mask: `url(#${id})`, 'pointer-events': 'none' }, groups.selRegion);
  });
  for (const it of sel) {
    if (it.region != null || it.comm != null) continue;
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
    if (hit) pick(hit.region != null ? { region: hit.region }
                : hit.comm != null ? { comm: hit.comm }
                : { h: hit.h }, e.shiftKey);
  } else if (e.key === 'Escape') {
    /* Two stages, and in this order: **clear, then close.** A first Escape empties the box and drops the
       selection, which is what it has always done and what someone mid-search wants. A second — with
       nothing left to clear — puts the surface away, which is what Escape means everywhere else. Closing
       on the first press would take the panel down over a typo. */
    if (searchInput.value || sel.length) {
      searchInput.value = ''; clearSelection(); renderSearch();
    } else {
      searchInput.blur();
      closeFind();
    }
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
// Find is missing from this list on purpose: it is a floating surface now, not a panel. A stored
// UI.pane of 'find' from before that change falls through to Routes, as any unknown name does.
const PANE_TITLES = { route: 'Routes', iso: 'Isochrone', tokens: 'Tokens',
                      draw: 'Draw', data: 'Data', labels: 'Realm labels' };
function showPane(name, opts) {
  if (!PANE_TITLES[name]) name = 'route';
  // Draw survives publication; the two tuning panels do not, so a stored pane name from a local
  // session cannot strand a reader on a panel that is no longer there.
  if (!LOCAL && (name === 'data' || name === 'labels')) name = 'route';
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
    ip.title = name === 'iso' ? 'Click or drag the map origin.'
                              : 'Choose the origin on the next map click.';
  }
  if (!opts?.keepShut) openPanel();
  saveUI();
  relightRoutes();   // leaving Routes for another panel stops singling one march out
}
function openPanel() {
  UI.shut = false;
  document.body.classList.remove('panel-shut');
  panelEl.classList.add('open');
  document.body.classList.add('sheet-open');
  saveUI();
  relightRoutes();
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
  relightRoutes();
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

// Draw is on both maps — trimmed to three tools when published, see the tool row above. Data is the
// sheet refetch and the drawing reset, which are jobs for whoever maintains the map, so its button is
// dropped rather than hidden.
railEl.querySelector('.railbtn[data-pane="draw"]').hidden = false;
/* The Data and Realm labels panels go the same way and for the same reason: both are for settling
   questions about the map rather than for reading it, so their buttons are dropped rather than hidden.
   The **buttons** only. Removing the panes themselves as well was tried and took `#dataInfo` with them
   — a status line `boot()` writes to before it has drawn anything — so the published map died at the
   first sentence with "Failed to load data". A pane nothing can reach is unreachable enough; there is
   no second prize for also deleting it, and the coupling that made it fatal is the sort that only
   shows up when the thing is served the way a reader would serve it. */
for (const p of ['data', 'labels']) {
  const b = railEl.querySelector(`.railbtn[data-pane="${p}"]`);
  if (LOCAL) b.hidden = false; else b.remove();
}
buildRnPanel();   // local only; a no-op on the published map

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
  for (const id of ['colGroup', 'marchGroup', 'condGroup']) {
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
  // An isochrone has an origin and a horizon, not a list of places to be at, so there is nothing for
  // it to halt at and nothing to put in a better order. The group travels with the other two rather
  // than being left behind on the Routes panel, and hides itself where it has no question to answer.
  const march = document.getElementById('marchGroup');
  if (march) march.hidden = iso;
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

/* ---------------- the dock ----------------
   The surfaces over the map are not windows. They were: each had a default corner, each could be dragged,
   each remembered where it had been put, and the corner-picking grew a rule every time another one arrived
   — the layer list and the readout collided at the top right, so the readout took the bottom; Find then
   took the bottom right, so the readout learned to step beside it. Two surfaces, three rules, and a fourth
   would have needed a fifth.

   They are a **stack against the right edge** instead, filled leftwards in the order they were opened. The
   first one open holds the edge; the next sits to its left; closing one closes the gap. That is the whole
   layout, it needs no defaults and no remembered positions, and it cannot collide — which is what dragging
   was really for. Nothing is dragged now and nothing needs to be: a surface has one place to be and it is
   already there.

   The layer list stays out of this. It drops out of its own button at the top of the screen, which is what
   makes it read as that button's list rather than as another panel, and it is the one surface whose
   position means something. */
const DOCK = [];            // the open surfaces, in the order they were opened; [0] holds the right edge
const DOCK_GAP = 16;
function layoutDock() {
  let right = DOCK_GAP;
  for (const el of DOCK) {
    if (el.hidden) continue;
    const w = el.offsetWidth || 330;
    // Clamped, so a stack wider than the window crowds inwards rather than marching off the left of it.
    el.style.left = Math.max(8, innerWidth - right - w) + 'px';
    el.style.bottom = DOCK_GAP + 'px';
    el.style.right = 'auto';
    el.style.top = 'auto';
    el.style.maxHeight = (innerHeight - DOCK_GAP * 2) + 'px';
    right += w + DOCK_GAP;
  }
}
function dockAdd(el) {
  if (!DOCK.includes(el)) DOCK.push(el);
  layoutDock();
}
function dockRemove(el) {
  const i = DOCK.indexOf(el);
  if (i >= 0) DOCK.splice(i, 1);
  layoutDock();
}
addEventListener('resize', layoutDock);

/* ---------------- Find, as a surface over the map ----------------
   Find was a panel, and a panel is the wrong shape for it. Everything else in the sidebar is something
   you settle into — plan a march, paint a border, place counters — whereas finding a place is something
   you do *while* doing one of those, and the panel made you leave the work to do it and leave the search
   to get back. So it comes out over the map, where it can sit open beside whatever panel is in use, and it
   answers to Ctrl+F, which is the key anyone already presses when they want to find something on a page.

   Where it sits is the dock's business, not its own — see above. */
const findPop = document.getElementById('findPop');
const findBtn = document.getElementById('findBtn');
function openFind(focus) {
  findPop.hidden = false;
  findBtn.classList.add('on');
  findBtn.setAttribute('aria-expanded', 'true');
  dockAdd(findPop);
  UI.findOn = true; saveUI();
  // Ctrl+F is a request to *type*, so the box takes the caret and offers what is already in it for
  // replacement — the same thing the browser's own find does, and the reason the shortcut is worth
  // taking over at all.
  if (focus) { const s = document.getElementById('search'); s.focus(); s.select(); }
}
function closeFind() {
  findPop.hidden = true;
  findBtn.classList.remove('on');
  findBtn.setAttribute('aria-expanded', 'false');
  dockRemove(findPop);
  UI.findOn = false; saveUI();
}
findBtn.onclick = () => (findPop.hidden ? openFind(true) : closeFind());
document.getElementById('findClose').onclick = () => closeFind();
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();                       // the browser's own find would cover the map with a bar
    openFind(true);
    return;
  }
  // Escape is handled by the search box itself — clear first, close second — because it is the box that
  // knows whether there is anything left to clear. Nothing to add here: elsewhere on the page Escape
  // already means "cancel what I am drawing", "drop the selection", "disarm the dropper", and taking
  // that over would be worse than useless.
});
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
/* The card's *size* is still remembered — the step table is the one thing in this app that genuinely wants
   room, and how much room is a real preference. Its position is not: the dock decides that. */
function placeCard() {
  // A size measured while the card was display:none comes back as zero. Anything under the minimum the
  // stylesheet allows is such a reading, not a size someone chose, so it is thrown away.
  const c = UI.card && UI.card.w >= CARD_MIN_W && UI.card.h >= CARD_MIN_H ? UI.card : null;
  if (c) {
    routeCard.style.width = c.w + 'px';
    routeCard.style.height = c.h + 'px';
  }
  layoutDock();
}
function showCard() {
  UI.cardOff = false;
  routeCard.hidden = false;
  dockAdd(routeCard);
  placeCard();
  saveUI();
  renderRouteButtons(lastResults);
  relightRoutes();
}
function hideCard() {
  UI.cardOff = true;
  routeCard.hidden = true;
  dockRemove(routeCard);
  saveUI();
  renderRouteButtons(lastResults);
  relightRoutes();
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
    const tm = r ? (r.fail ? '✗' : routeDays(rt, r)) : rt.wps.length + ' wp';
    b.innerHTML = `<span class="sw" style="background:${escHtml(rt.color)}"></span>` +
                  `<span class="nm">${escHtml(rt.name)}</span>` +
                  `<span class="tm" title="${escHtml(routeDaysTitle(rt, r))}">${tm}</span>`;
    b.title = `Show ${rt.name}. Click the swatch to recolour it, right-click for route actions.`;
    b.onclick = () => {
      if (act) return hideCard();
      S.activeRoute = i;
      UI.cardOff = false;
      computeRoute();          // the panel and the readout both follow the active route
      showCard();
    };
    /* The swatch is the same control it is on the sidebar row, raising the same palette. With the
       panel shut this strip is the only thing on screen naming the routes, so telling two marches
       apart by colour is exactly the job it is doing — and the colour was the one part of it you had
       to open the Routes panel to change. `stopPropagation`, or the click would bubble on to the
       button behind it and the palette would open onto a card that had just been shown or hidden. */
    const sw = b.querySelector('.sw');
    sw.title = 'Change colour';
    sw.addEventListener('click', e => {
      e.stopPropagation();
      openColorPanelAt(sw, `<b>${escHtml(rt.name)}</b> — colour`, ROUTE_COLORS, () => rt.color,
                       c => { pushUndoRoutes('rtcolor' + i); rt.color = c; recolorRoute(i); });
    });
    // The same menu the list row has. This button stands for the route just as much as that row does,
    // and with the panel shut it is the only handle on it — so duplicating or emptying a route from
    // here should not mean opening the panel first to find the identical menu.
    b.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); openRouteMenu(i, e.clientX, e.clientY); };
    routeBtns.appendChild(b);
  });
}

const routeCardHead = document.getElementById('routeCardHead');
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
// Only the size. Resizing also moves whatever is docked to its left, so the stack is re-laid here.
function rememberCard() {
  if (routeCard.hidden) return;          // a hidden element measures zero; never save that
  const r = routeCard.getBoundingClientRect();
  UI.card = { w: Math.round(r.width), h: Math.round(r.height) };
  saveUI();
  layoutDock();
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
  if (!has) { routeCard.hidden = true; dockRemove(routeCard); undoFloat.hidden = true; renderRouteButtons(results); return; }
  if (UI.cardOff) { routeCard.hidden = true; dockRemove(routeCard); renderRouteButtons(results); return; }
  const first = routeCard.hidden;
  routeCard.hidden = false;
  dockAdd(routeCard);
  if (first) placeCard();
  const r = results?.[S.activeRoute];
  routeCard.querySelector('.floathead h3').textContent =
    rt.name + (r ? (r.fail ? ' · no route' : ' · ' + routeDays(rt, r)) : '');
  // The floating Remove last only appears once there is a waypoint it could take back.
  undoFloat.hidden = !narrow() || !rt.wps.length;
  renderRouteButtons(results);
}
const updateDrawerBadge = updateRouteCard;   // the name computeRoute() calls it by

// A window that has changed shape can leave a floating surface half off the screen.
addEventListener('resize', () => {
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
// Find reopens where it was left, because it is the surface you keep up rather than one you open to
// ask a question and shut again.
if (UI.findOn) openFind(false);
if (UI.shut || narrow()) closePanel(); else openPanel();

boot().catch(err => {
  document.body.innerHTML = `<div style="padding:2em;font-family:sans-serif">Failed to load data: ${err}.<br>
  Serve this folder over HTTP (e.g. <code>python -m http.server</code>) — file:// blocks fetch.</div>`;
});
