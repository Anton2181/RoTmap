# Ravages hex map — vector editor & travel calculator

Static site — works on github.io or locally with `python -m http.server` (file:// won't work, fetch is blocked).

## Files

- `index.html`, `app.js`, `style.css` — the app
- `rules.js` — all movement rules as data + cost functions (documented, edit to tune)
- `rules.md` — human-readable movement rules reference
- `data/terrain.json` — snapshot of the Google Sheet (4,230 hexes; "Refetch sheet" pulls live). Each hex carries its terrain, stronghold/river/road flags and its **region** (`g`) — the sheet's Region column, 24 of them, covering every hex but the first
- `data/strongholds.json` — OCR'd stronghold names (18 unnamed — fix with the Label tool)
- `data/features.json` — *your* drawn overlay; export from the app and commit it here
- `ref/` — classic map + old layer images, used only as tracing overlays

## Workflow

1. **Draw mode** — pick a tool, click to place points. Points snap to hex corners, edge midpoints, centers and sub-centers (half-way points), so rivers can run along edges or through hex interiors, and roads can enter/exit any side. Alt = free placement, Enter/double-click = finish, Esc = cancel, Ctrl+Z = undo, right-click = finish. Turn on the "Classic map" / "Ref:" layers to trace.
2. Work autosaves to the browser. **Export JSON** → save as `data/features.json` → commit → github.io serves it to everyone.
3. **Route mode** — multiple routes, each with its own color (click swatch to cycle, double-click name to rename, × to delete). Clicks extend the *active* route; right-click removes its last waypoint. Army composition and weather apply to all routes. Routes persist in the browser.

Drawing adds at most one hex per click (rejected clicks flash red) so features never skip hexes.

## Finding things

The **Find** box at the top of the panel searches stronghold names, your own labels, region names, and bare hex numbers. Names here are full of letters nobody is going to type — Naŕes, Hā-aēšema, Zakuruiôi, Sam'al — so nothing is matched as written: query and name are both folded to plain letters (accents dropped, case levelled, apostrophes and hyphens discarded) and then compared with a tolerance of a letter or two, counting a pair typed the wrong way round as one mistake rather than two. `nares`, `cashman`, `hasesema` and `kamabasin` all land on the right entry. Two- and three-letter queries are matched strictly, since anything looser matches half the map. Arrow keys move through the results, Enter takes the top one, Escape clears.

What the search picks out is a **selection**, not a pointer: it stays lit until you drop it. A plain click selects one thing and drops everything else, moving the map to it — only moving, never zooming, since a search is for finding something rather than for deciding how closely you wanted to look at it. **Shift-click, or the +/− button on the row, adds** to what is already selected or takes that one back out, without moving the view, so you can build up a set of regions and hexes without being dragged away from what you were looking at. (The button exists because shift needs a keyboard; on a touchscreen it is the only way in.) The hex just picked blinks a few times before settling into a steady outline, which it needs now that the view no longer zooms in on it.

Selected rows are pinned to the top of the list with a ✓, and **they stay there when the box is empty** — a region selected three searches ago can still be found and switched off. Clicking the only selected thing switches it off; Escape drops the lot.

A selected region is washed gold; a selected hex gets an outline. The wash covers whole hexes, water included: the sheet names a region per hex and that claim covers all of it, so a bay a coastline has cut out of a shore hex belongs to the same region as the hex around it. Its outer edge is drawn by stroking the same shape and masking away everything inside the region, which yields the silhouette without computing a union of several hundred hexagons and without any lines between two hexes of the region itself; each selected region keeps its own mask, so where two of them adjoin, the border between them still shows. The washes sit under the grid, roads and names so they tint the ground without burying it, while hex outlines go on the very top layer, where one thin hexagon won't be lost among the roads. Hovering any hex names its region in the tooltip.

## On a phone

Below 820px the panel leaves the side of the map and becomes a sheet that slides up from the bottom, so the map gets the whole screen; a **Controls** pill opens it (carrying the active route's travel time so the headline number is readable with the sheet shut) and a **Remove last** pill in the opposite corner takes back a mis-tapped waypoint, since a touchscreen has no right button. Drag the sheet's handle down, or tap it, to dismiss. On the map itself, one finger pans, two fingers pinch to zoom, and a tap places a waypoint — with more slack for what counts as a tap than a mouse gets, and the taps as fingers lift after a pinch ignored. The map is 2.16:1, which would letterbox into a thin band on a portrait phone, so on touch screens the opening view is zoomed to cover the window instead, and reshapes to match when the phone is turned.

Everything the mouse can do has a way in by touch. **Press and hold** a hex to read it — the terrain, the stronghold, which subhex you are on, the region it belongs to — since a tap there means "waypoint here" and there is no such thing as hovering; the readout appears above your fingertip and goes away at the next touch. Keep holding and **slide**, and the finger becomes a cursor: the readout follows it from hex to hex instead of the map panning underneath, which is how you run along a row of strongholds without lifting off and holding again at each one. Panning is what a finger that hasn't waited does, so nothing is lost either way. Android raises its context menu from that same press, so a held finger never counts as the right-click that drops a waypoint. **Set origin** closes the sheet as it arms, because the next thing to do is tap the map, which the sheet was covering. Selections are built with the +/− buttons on the search rows rather than shift. Double-tap-to-zoom is off inside the sheet, so a double-tap to rename a route reaches the route rather than the browser.

The editing tools — Draw, the mode toggle and the Data panel — only appear when the map is served locally; the published map is read-only. They work by touch too (tap to place points, double-tap to finish, Undo in the panel), though the modifier-key refinements — Alt for free placement, **E** for snapping anywhere along an edge — have no touch equivalent.

Each drawn feature type has its own **Layers** toggle — Roads, Rivers (major), Rivers (minor), Trade routes, Coast fills, Coast lines, and Strongholds — with an opacity slider and an invert button (**◐**) each. Invert is a CSS filter over that layer only, nothing in the data changes: it flips a dark reference scan into light lines, which is far easier to trace against, and it works on any layer, not just the images. The reference layers sit right under Coast lines in the panel so they're next to what you're usually tracing, and they're drawn as true underlays — over the terrain, but beneath every feature you draw, so your own river always sits on top of the scanned one you traced it from. The **Coast lines** layer (the drawn black shoreline) is off by default, so you see just the filled land/sea subhexes; turn it on to see or edit the coast borders. **Hex IDs** (also off by default) prints every hex's number at its centre, so you can read ids off the map instead of hovering one hex at a time; it's built the first time you switch it on. A hidden layer is not a snap target: if you toggle a type off, new lines won't snap to that (invisible) geometry, though the hex grid still snaps and Alt still disables all snapping.

Coast fills sit directly on top of the terrain — they *are* terrain, just at subhex resolution — so the Layers panel lists them (and the coast lines) right under Terrain. The fills are split around the rivers in the draw order: land subhex fills, then the thematic ref scans, then the river layers, then sea subhex fills, then the **Classic map**, then the coast lines. The Classic map is deliberately above *both* halves of the coast fills, because it's the basemap you trace shorelines from and an opaque sea subhex painted over it hides the very coast you're following. The consequence is forced: since the sea fills sit above the rivers, a scan above the fills is also above the drawn rivers. Coast lines, roads, trade routes, the hex grid and strongholds all stay above it. A river drawn across a split hex therefore stays visible over the land half and slides under the open water rather than being painted over. Both halves share the single "Coast fills" toggle.

Origins are made and unmade from the map as well as from the panel. While the Isochrone panel is
open, **right-clicking a hex** offers a new origin there, moving the selected one to it, removing the
one already standing on it, and clearing them all — the entries adapt to what is actually under the
cursor, so there is no "remove" on bare ground and no "move here" on the hex the selected origin is
already on. They sit **above** the route entries rather than replacing them: which panel is open says
what you are most likely to want, not what you are allowed to want, and a route you were building
does not stop existing because you opened another panel.

## The isochrone speaks in subhexes

Everywhere else on the map, a hex a coastline or a major river has cut in two is *two places* that
happen to share an outline, and the pathfinder has treated them that way for a long time. The
isochrone used to collapse them again on the way out — one figure per hex, taking the best of
whatever reached it — so a port whose bay a fleet could sail into came back shaded over its whole
hex, land included, even for an army with no ships and no way ashore. The reach was right; the
reporting threw the distinction away.

So every field the isochrone builds is now keyed by **hex and region together**, in all four modes,
and every band it paints is the region's own shape rather than the hexagon around it. A coastal hex
can be half shaded and half bare, which is the truth about it; the tooltip answers for the subhex
under the cursor and says nothing over the half that is out of reach. Hexes nothing has split have
exactly one region and read exactly as they always did. Word of a siege is given to every region of
a hex alike — news does not slow down at a shoreline — so it is the march that does the dividing.

**Without ships, nothing at sea is shaded at all.** With "Start as fleet" off, the isochrone drops
every sea subhex from the field — a fleetless column has no billet on the water, so painting it as
ground held was never right. Only the field is filtered, not the search: an army allowed to secure a
fleet can still spend its month doing so and cross a strait, and the land it reaches on the far side
shades normally. A strait drawn as a gap between two shaded shores is the honest picture of
that. River subhexes stay either way, since a bank is walkable ground that happens to be sailable
too. One consequence worth knowing: a siege origin placed on a *sea* subhex with no fleet gives an
empty field, because nothing can reach it inside any budget shorter than the securing month.

The area outlines are drawn the way the region selection is: the whole shape is stroked and then
masked by everything inside it, which hides the inner half of every line and, with it, every line
between two pieces the same area holds. What survives is the silhouette, holes and coastlines
included, without computing a union of several hundred polygons. The origin-list count stays in
whole hexes — a hex cut in two is still one place on the map, and counting it twice would flatter
whoever happened to hold a shore.

## Relieving a siege

The Isochrone panel's fourth spread, **Siege relief**, turns the usual question inside out. An
ordinary isochrone asks how far a force can get; this one asks what a defender actually needs to know:
*how far away can I station this force and still have it arrive in time*. The origin is the hex
**being besieged**, and every shaded hex is somewhere you could quarter troops, shaded by how many
days they would take to get back — word of the siege travelling out to them as the crow flies
(rumour, 90 mi a day, or a courier at 240), and then the column marching in over the roads.

Each leg is billed in **whole days, and separately**, then added. Orders are issued in whole days,
and these are two orders rather than one — the news lands during a day and the column sets out on
the next — so a rumour that takes three hours and a march that takes six still cost two days between
them, and no hex but the besieged one can come in under two. The default budget is **4 days**;
hovering a hex breaks the total back out into its two legs, with the unrounded figures in brackets,
because which leg is eating the budget is what you can do something about. A hex held back by the
march wants a road; one held back by the news wants a courier posted, not a garrison moved.

The march is costed **inward**, in the direction it is actually made, which is not the same
calculation as the outward one every other mode does. A hex is paid for by the step that enters it,
so a march solved outward from the siege never pays for the besieged hex — and on a fortress in the
mountains that is a whole day at half pace, unpaid, on precisely the ground fortresses stand on. So
this mode runs the movement graph backwards, recovering each node's incoming moves from its possible
predecessors and expanding each hex at most once, which keeps the work in proportion to the area
covered rather than to the map.

Several origins are several sieges, and a hex goes to whichever one it can save soonest; the tooltip
names the other and says how much later it would arrive, since a hex that covers two sieges is
usually the hex you want. How long you really have is a judgement the map cannot make for you — but
the walls falling is not the end of it, since taking a stronghold in hand costs the besieger 5
in-game days for a fortress (1 IRL day), 1d6 × 5 for a town (1–6) and 2d6 × 5 for a city (2–12).
The panel's "How long you actually have" note keeps that table within reach of the box.

## Movement semantics

- Route lines visually trace the drawn feature they use: a road step follows the road's drawn path, and a sailing step follows a drawn river's path where one connects the two hexes (open-sea and off-road steps go centre-to-centre).
- Road between two hexes (drawn line passing from one to the other) → road speed; crossing a river on a road = bridge.
- Roads are a **connected network**, not just per-hex adjacency: an army keeps road speed only while following one continuous road. Where the drawn line goes matters — two roads that merely pass through the same hex are treated as separate unless their lines actually **touch or cross** inside that hex (a junction), so you can't cut a corner or hop between parallel roads for free. An army can always leave a road and march off-road between adjacent hexes at the slower off-road rate (it just loses the road bonus), and re-join any road at the hex where it arrives.
- Ferry is **not drawn** — there is no ferry tool. A ferry is simply what a road does where it crosses a major river, which nobody can ford: the step is free for the whole column, wagons included, and the breakdown labels it `road, ferry` (a road over a *minor* river is a `bridge`). Draw the road across the river and the ferry is there.
- Major river (3 px): no fording at all — you need a road across it (bridge/ferry); navigable by fleets. A fleet already at sea sails straight into and along a connected major river with no stronghold or embark (it's continuous water). Boarding ships from land still needs a coastal/large-river port.
- Minor river (1 px): fordable by all incl. wagons; delay = ½ day per mile of column (cavalry free).
- Contradictory overlaps are prevented: a new river drawn on top of an existing river (either type) is rejected — erase the old one first. A road drawn over a river is fine (that's a bridge). When stacked lines are erased, the most recently drawn one goes first.
- Trade route: bulk shipping = road-grade infrastructure; armies traverse it end-to-end at road speed — all at once or not at all, no stops partway, endpoints need not be strongholds. Distinct from sailing: no fleet or embark involved, so a trade route works just as well overland as along a river. Where one route's endpoint lands in the same hex as another's, they chain: you arrive, and may either ride straight on down the next one or stop there. The cost is the **drawn length of the line** (50 px = one hex = 30 mi), not the number of hexes it touches — a line that runs close to a hex boundary flickers between neighbours and can re-enter a hex it already left, which used to bill 150 miles for 90 miles of road and made fording a river look like the better option.
- Coast: draw the shoreline, then **click the side that is sea** (a preview dot follows the cursor; Shift+click an existing coast to re-pick later). Splits each crossed hex into a land part and a sea part — the line may begin or end inside a hex and it still splits. Works on land *and* sea hexes, including a Sea/Ocean hex that really holds some land or has a stronghold "on the sea". Visual, except that a coast's sea subhex counts as navigable water: any stronghold on or bordering it is a coastal port, and armies can embark/sail into it even though the hex's headline terrain is land. Fill colors are borrowed from the hex and its neighbors. Coast lines act as barriers: each coast-crossed hex is flood-filled into regions, and a region is sea only if you marked it (clicked it as sea). This means several coasts can compose into multiple sea subhexes, or two coasts can enclose an inner sea in the middle of a land hex without flooding the whole hex. While drawing, points also snap to the vertices of features you've already drawn (and, holding **E**, to any point along a drawn segment or hex edge) so new lines connect precisely to existing geometry. Alt = fully free placement.

They snap to the line *currently* being drawn too, which is what lets you draw an **island smaller than a hex**: once a coast has three points its starting node becomes a snap target (shown as a teal ring), and clicking it seals the ring and finishes the line, straight on to picking the sea side. A closed ring is flood-filled rather than split two ways, so the inside and the outside become separate subhexes; mark the outside as sea and you have an island, mark the inside and you have a pond. An *almost* closed loop leaks through the gap and gives you one broken region instead — hence the snap. Regions with holes are drawn as a single `fill-rule: evenodd` path, so the enclosing water punches a hole for the island instead of painting over it.

Coasts are **routable subhexes**, not just paint. Splitting a hex yields two (or more) co-equal regions — each land region and each sea region is its own first-class node in the movement graph (a hex can have several, e.g. two land strips separated by a sea inlet). Waypoint markers are centred on their region. Hovering highlights the exact subhex under the cursor (tinted region + "land subhex"/"sea subhex" in the tooltip). In Route mode, clicking inside a region adds a waypoint for *that* region (filled = sea, ring = land).

One hex is one hex: the cost of a hex is paid by the step that crosses *into* it, so moving between two subhexes of the same hex — a bay opening into a channel, a river mouth — is free and shows as `sail (within hex)` for 0 days. Charging a full hex again there would double-count the crossing, and a hex entered through its sea half and left from its river half must still cost exactly one hex.

Because each region is its own node, **naval subhexes block land movement**: an army can't march straight across a sea inlet — it must go around it (through connected land, possibly via a neighbouring hex) or embark at a coastal port. Marching between two land regions of adjacent hexes is only allowed where those land regions actually meet along the shared edge. The step breakdown labels each hex "Sea subhex" / "Land subhex".

**Drawn major rivers split hexes the same way**, into a region per bank, because a major river can't be forded anywhere — not even in the middle of a hex. The two banks are separate nodes: an army on one can't reach the other, or a road on the other, unless a road bridges the river inside that hex, and then the crossing is free (`bridge (within hex)`). Before this, a river that cut a hex without separating the two hex *centres* was invisible to the pathfinder, and a column could step onto a road across the water having forded nothing.
- Erase is granular: click a node to remove just that vertex, click along a segment to cut that one edge (splitting the line in two), or Shift+click to delete the whole line. Drag across the map to wipe whole features/strongholds continuously. Stronghold markers erase/reset when clicked.
- Embark/disembark only at coastal/port strongholds. Going ashore is **free**. Boarding costs +7 IRL days if you have no fleet — a month spent securing one, with the boarding folded in — or +1 IRL day if you already have ships and are simply getting back aboard after a landing. The two are never charged together. Fleets move 10 hexes/IRL day.
- Those two costs have **a checkbox each**, and they are independent. **Start as fleet** says the column owns ships, which is what licenses the 1-day re-embark; **Allow securing a fleet** licenses the 7-day month, and nothing else. A fleet with no leave to secure another may sail, land and sail again from the same dock all day, but once it marches inland its ships are gone for good. A column with neither box never takes ship at all.
- Water is only continuous where it really is continuous. **Sea to sea always connects** — the open sea and every bay along the coast are one body of water, so a coastal sea subhex sails freely to its neighbours. A **river** region, though, joins its neighbour only where the drawn major river actually goes: across a hex edge the line must cross that edge, and *within* a hex the line must run through both regions — that junction is the **river mouth**. Otherwise a bay sharing a hex with an inland channel would let a fleet step off the sea straight into the channel, anywhere along the coast, with no mouth at all.
- Docking: going ashore and re-embarking at the same port is free of the 7-day penalty (just the 1-day re-embark), but marching or trading away from the dock hex leaves the fleet behind, so re-embarking later costs the 7 days again. The calculator tracks this held-fleet state along the whole route. Port status: every sea- or river-side stronghold is a port **by default** — on, or bordering, open sea, a drawn major river, or the sea part of a coast-crossed hex — so you don't have to flag a hundred of them by hand. An explicit flag (Stronghold tool, Shift+click) always wins in either direction, which is how you carve out the exceptions. Blue-ringed markers are ports. This is deliberately looser than the river-mouth rule above: standing on the water's edge makes a port, regardless of whether a fleet can cross that particular edge. The Stronghold tool also places the marker's exact position within its hex (saved in your features JSON).
- Strongholds can be **removed and renamed** regardless of source. The Erase tool deletes a stronghold under the cursor — including ones that come from the datasheet, which are hidden with a persistent `removed` flag in your features JSON (Ctrl+Z, or clicking the hex with the Stronghold tool, restores it). The Label tool renames any hex or stronghold (datasheet ones included); clearing the text reverts to the datasheet name. Custom placements, port flags, removals and renames all live in `data/features.json`, so the datasheet snapshot is never mutated.

See `rules.md` for the full extracted rules table and calculator caveats.
