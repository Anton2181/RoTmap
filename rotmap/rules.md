# Movement rules reference (extracted from Consolidated Rules Ravages)

Scale: 1 hex = 30 miles. 1 IRL day = 5 in-game days. Normal march = 4 marching days per 5; forced = 5 per 5.

**Counting hexes.** A march pays for every hex it stands in, the one it sets out from included: a
journey through N hexes costs N crossings, not N−1. Each hex but the first is paid for by the step
that enters it; the first is paid for by the step that leaves it, priced the way the column departs —
on the road if it takes one, at that hex's own terrain, and at the sailing rate if it puts out onto
the water. Moving between subhexes of one hex — boarding a ship, crossing its own bridge — is not a
crossing and costs nothing, and a route that begins and ends in the same hex costs nothing at all.
Only the beginning of a march is charged this way: a waypoint partway along was already paid for by
the leg that arrived at it, so adding waypoints to a route never changes what it costs.

## Land speeds (miles per marching day → miles per IRL day)

| Situation | mi/day | mi/IRL day |
|---|---|---|
| Road, normal | 12 | 48 |
| Off-road, normal | 6 | 24 |
| Road, forced | 18 | 90 |
| Off-road, forced | 9 | 45 |
| Cavalry-only army, forced | ×2 | up to 180 |

("Cavalry-only" = nothing on foot and nothing on wheels: zero infantry and zero wagons. Noncombatants do not disqualify it. The bonus applies only on a forced march.)

- **Light infantry**: once light infantry are at least ⅓ of the fighting strength (infantry + cavalry), the army keeps its road pace off-road and ignores the mountain halving. The rules give the movement clause per *detachment* ("light infantry detachments can move at normal speed off-road and ignore the mountain speed penalty") and the ⅓ threshold for the battle "rough terrain" modifier; this calculator applies the ⅓ threshold to the movement clause as well.
- **Marines** (tradition): the army can be put ashore anywhere, not only at a port. Taking ship still requires a coastal/large-river stronghold.

| Mountains | ×0.5 | — |
| Column > 6 mi, normal | 6 on road, 3 off | 24 / 12 |
| Column > 6 mi, forced | 12 on road, 6 off | 60 / 30 |
| Night march | 6 on road (12 forced), roads only | 24 / 60 |

Column length: 1 mi per 5,000 infantry+noncombatants, 2,000 cavalry, or 50 wagons. The **Logistician**
trait ("your army stretches half as long on the road") halves it, and halves it for fording too, since
both are charged by the mile of column. At the sample army's cavalry and wagons that moves the 6-mile
limit from 14,500 infantry to 44,500.

The long-column figures are **road** paces, and the off-road halving applies on top of them, as do
mountains and weather. The rules give the column in miles *of road* ("marching armies stretch 1 mile
of road per 5,000 infantry…") and its speed as "only 6 miles per day, for a total of 24 miles per IRL
day" — 6 × 4 marching days, which is the road cadence; "offroad, reduce the speeds by half" then
applies to whatever pace the column has. So the limit replaces the base 12/18 rather than capping the
finished number, and **a road is worth double at every army size**. Reading it the other way — a flat
ceiling both surfaces are clamped to — makes road and off-road identical at 6 mi/day for any column
over the limit, which leaves a road worth nothing to a large army and has the pathfinder send it
straight across country. That is what this calculator used to do.
Forced march: morale check per day (doubles → −1 morale). Night march: same check every 5 nights;
2-in-6 wrong turn at forks. Neither is costed — morale is not tracked, and a wrong turn makes a
different route rather than a slower one — so the readout states them instead.

Night marching is an **alternative** to marching by day, not an addition to it: the weather table sets
the two against each other ("Heatwave — day marching gives −1 Morale per IRL day. Night marching is
fine"), and under Hot it is night marching that escapes the morale check. So it replaces the 12/18
road pace over the same cadences — 24 mi/IRL, 60 forced — and is always slower than the same march
made by daylight. You march at night to get out of the heat, not to arrive sooner. Being roads only,
a night-marching column still crosses roadless ground by day at the ordinary off-road rate; the step
list says which stretches were which. The 6-mile column limit is exactly the two night paces, so it
never binds a night march.
Light infantry detachments move at normal (road) speed off-road and ignore the mountain penalty; an army with ≥⅓ light infantry ignores the *battle* rough-terrain penalty only.

## Morale

Base resting morale 9, maximum 12; a majority-peasant army rests at 6 with a maximum of 9.

A morale check is **2d6 ≤ morale** — equal or under holds. A failed roll indexes the consequences
table (2 mutiny · 3 mass desertion −30% · 4 defection ×2d3 · 5 major desertion −20% · 6 advance on pay
· 7 defection ×1 · 8 desertion −10% · 9 detachments away · 10 camp followers +5% · 11 detachment away
· 12 nothing). Forced marching and night marching each add a rider to the same roll: **on doubles,
lose 1 morale** — a flat 1 in 6 whatever the army's morale.

So one marching day's roll is read twice, and the calculator keeps the two apart:

| | trigger | cost |
|---|---|---|
| Doubles rider | each IRL day of forced or night marching | −1 morale, p = 1/6 |
| Failed check | roll over current morale | a result from the table |
| Heatwave | each IRL day of **day** marching | −1 morale, certain |
| Blizzard | each IRL day of any marching | −1 morale, certain |
| Hot | day forced marching, or day marching over 60 mi | a check, no morale cost |

A day that is both forced **and** by night rolls both checks. Part-days round up, per leg. Sailing is
not marching and calls for nothing.

The morale loss is a binomial in the number of checks and does not depend on the order they come in,
which is what lets the optimiser rearrange legs freely and still be exact. The *failure* risk does
depend on order — an army worn down by the first half of a march fails more often in the second — so
it is walked check by check over the running distribution of morale rather than averaged. Traits:
**Marching City** (over 6 miles long, ≥1 wagon per 30 infantry) drops the forced-march checks on
road; and **Poet** shifts a failed roll two rows up the consequences table without changing how often it
fails. (**Stubborn** — no morale loss on defeat — touches only battle, which this calculator does not
model, so it is not offered.)

With **Forced march** or **Night march** ticked the box stops meaning "the whole route" and starts
meaning "where it pays": the legs to march hard are chosen as the fastest set that still leaves the
army at or above its allowed floor with the certainty asked for, and those choices override any legs
marked by hand. Where the floor is already out of reach the gentlest march is shown instead, and the
card says so.

Not modelled: recovery towards resting morale (1 per 20 IRL days), rest, supply, pay, battle, and the
feedback from a consequence back into the march — a desertion shortens the column and would speed the
army up, which is not a trade worth optimising into.

## Rivers

- Minor rivers (1 px on the map) are fordable. Major rivers (3 px) can ONLY be crossed where a road crosses them — no fording, by anyone.
- Fording a minor river: each mile of column (infantry + noncombatants + wagons) = half an in-game day. Cavalry ford at their regular speed (no delay for cavalry-only armies).
- No fording in Heavy Rain or Storm.
- Roads crossing a river are assumed bridged. Where a road crosses a *major* river the crossing is a ferry rather than a bridge — mechanically the same thing, a free crossing for everyone including wagons. Ferries are therefore never drawn; they are derived from road × major-river crossings.
- A major river is a barrier **wherever it is drawn, including inside a single hex**. A drawn major river splits the hexes it runs through into a region per bank, exactly as a coastline splits a hex into land and sea. The two banks are separate places that happen to share a hex: an army on one cannot reach the other, or a road on the other, unless a road bridges the river there — in which case crossing between them is free, since the cost of a hex is paid by the step that enters it. This is what stops a column stepping onto a road across the water without ever crossing it, in cases where both hex centres sit on the same side and no hex boundary is involved.

## Water

- Ocean, Sea, Lake: ships only. Ships: 60 mi/day on sea and rivers = 2 hexes/in-game day = 10 hexes (300 mi)/IRL day.
- A stronghold counts as a coastal port if there is navigable water **in its own hex** — its own subhex is a major-river bank, or another subhex of the same hex is sea or river. Sea- and river-side strongholds are therefore ports by default; an explicit flag (Stronghold tool, Shift+click) overrides that either way. Water in a *neighbouring* hex does not make a port: a river drawn along a hex boundary is recorded on one side of it, and the hex on the other side borders that water without having any — which let a keep with no water in its hex secure a fleet and put out onto a channel running past the far side of its own boundary. Boats go into the water the port stands on, and a port with water in its hex loses nothing by that, since it boards there and sails on with the next step.
- Sea connects to sea everywhere they touch — open sea and coastal bays are one body of water. A river only connects to its neighbour where the drawn major river actually runs: it must cross the hex edge to carry a fleet upstream, and within a single hex it must run through both regions for a fleet to pass between them. Where the river runs **along** a shared edge, that river belongs to **both** hexes: each is one of its banks, either can put boats in, and the reach between them is one body of water, so a fleet passes from one to the other freely. (The subhex test that stops a marching column walking over that water is waived for sailing, since the water is the way through.) Which side of the boundary the drawn line happens to fall on is a fact about the drawing, not about the ground. A river needs to be *in* a hex — about half a hex of it — before that hex counts as having it at all; a few units straying over a boundary near a corner is a graze, not a river. And a river drawn **along** an edge is one reach with a hex on either side of it: it carries a fleet downstream from the hexes bordering one stretch to those bordering the next, and never from one of its own banks to the other, which is a bridge or a ford rather than a voyage. That junction — river reaching the water — is the river mouth, and it is the only way from the sea into an inland channel.
- Securing ships (converting a legion to a fleet): 1 in-game month [7 IRL days], at a coastal/large-river stronghold. Only needed if you don't already have a fleet, and the boarding itself is folded into that month — a first embark costs the 7 days and nothing more.
- The two boxes are **two separate permissions**, one per cost:
  - **"Start as fleet"** is a claim about the *force*, not about where it is standing: this column owns ships. It therefore never pays the securing month, and boards for the **1-day re-embark** — including a garrison ashore in a port, whose ships are simply waiting in the harbour. That day is licensed by having the ships, so it applies whatever the other box says. It puts the force *afloat* only where being afloat is a real choice, which is a major-river subhex: a sea subhex is afloat regardless and a land subhex cannot be. This is why ticking it changes the answer for a coastal hex's land half. With it off, the isochrone leaves sea subhexes out of its shading altogether — a fleetless column has nowhere at sea to be.
  - **"Allow securing a fleet"** licenses the **7-day month** and nothing else: whether a column with no ships may go and get some. Turn it off for a force that will never commandeer shipping.
  - The four combinations: neither box, and the column never takes ship at all. Securing only, and it pays 7 days the first time. Fleet only, and it may sail, land and sail again from the same dock for a day each — but the moment it marches inland it has left its ships behind for good, with no leave to get more. Both, and it is a fleet that can also replace one it has lost.
- Putting an army ashore is free. Getting it back aboard once it already has ships costs +1 IRL day; that day is the *re*-embark, never the first one.
- Docking: you may go ashore and re-embark at the same port without paying the 7-day securing penalty again (just the 1-day re-embark) — as long as you do not march or take a trade route away from that dock hex. Any overland movement leaves the fleet behind, so a later embark re-incurs the full 7 days.
- Fleets can't forage or scout; visible at 1 hex.
- Trade routes (house rule per Anton): so much daily shipping that they give road-grade infrastructure. Atomic: an army enters at one terminal and exits at the other — no stopping or joining partway. Costs road speed over the route's drawn length in miles (not its hex count, which over-reports whenever the line hugs a hex boundary). Overland routes work exactly like riverine ones. Two routes sharing a terminal hex chain together — arrive on one, then either ride straight on down the next or stop there. Terminals need not be strongholds; this is bulk transport, not sailing, so no embark/fleet mechanics involved.

## Weather

| Weather | Road | Off-road | Notes |
|---|---|---|---|
| Clear / Light rain / Hot | ×1 | ×1 | Hot: morale checks for marching >6 mi/day or forcing |
| Heavy rain (bad) | ×0.75 | ×0.5 | no fording |
| Storm (very bad) | ×0.5 | ×0.25 | no fording, no forced march |
| Snow (bad) | ×0.75 | ×0.5 | |
| Blizzard (very bad) | ×0.25 | ×0 | no forced march, zero visibility, −1 morale |
| Heatwave | ×1 | ×1 | no forced march, day marching −1 morale |
| Fog (very bad) | ×1 | ×1 | zero visibility, wrong turns/lost chances |

## Other delays & speeds

- Harassment (2× enemy light cavalry in range): halve speed & forgo actions, or take 1%/5-day casualties.
- Rest: morale +1 per 15 in-game days [3 IRL]; ending early −2 morale.
- Messengers: 48 mi/day (friendly), 36 (hostile). News: 30 mi/day overland, 180 coastal.
- Taking a fallen stronghold in hand: a **fortress** 5 in-game days [1 IRL day], a **town** 1d6 × 5 [1–6 IRL days], a **city** 2d6 × 5 [2–12 IRL days]. The walls falling is therefore not the end of the clock — a relief force that arrives inside that window arrives in time.
- Scouting: own + adjacent hex (light cav +1–2); −1 hex bad weather, −2 very bad.
- Wagons off-road: allowed, growing breakdown chance the longer off-road.

## The relief army

The isochrone's **Relief army** spread answers where a force has to be stationed to reach trouble in
time — a siege, a battle, a landing. It is two journeys in opposite directions, not one:

- **x** — news of it reaching the force, as the crow flies, at rumour (90 mi/IRL day) or
  courier (240) speed.
- **y** — the force marching from where it stands *back to* the besieged hex, pathfound under its
  own column and the weather.

Each leg is billed in **whole IRL days and separately**, then added: orders are issued in whole days,
and these are two orders — news lands during a day, and the column forms up and sets out on the next.
So the smallest possible answer for any hex but the origin's own is 2 days, and half a day of riding
plus half a day of marching is 2, not 1.

The march is costed **inward**. This matters: every hex but the first is paid for by the step that enters it, so a
march solved outward from the siege never pays for the besieged hex itself and pays instead for
wherever it stops. On a fortress in the mountains that is a whole day at half pace, always in the
player's favour, and on exactly the terrain fortresses are built on.

Calculator caveats: night marches, harassment, morale effects and wagon breakdown are not modeled; embark assumed possible at any stronghold hex adjacent to water.
