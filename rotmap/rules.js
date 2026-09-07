// Ravages movement rules, extracted from "Consolidated Rules Ravages" (Cataphract-based).
// All distances in miles. 1 hex = 30 miles across. 1 IRL day = 5 in-game days.
// Marching cadence: normal march = 4 marching days out of 5; forced march = 5 of 5.

const RULES = {
  HEX_MILES: 30,
  GAME_DAYS_PER_IRL: 5,

  // Message/rumour spread: straight-line ("as the crow flies") miles per IRL day.
  // Terrain, roads and rivers are ignored — this is a pure radial spread, matching
  // the Google-Sheet straight-line calc (no pathfinding).
  SPREAD: {
    message: 240,  // couriers / official dispatches: 240 mi per IRL day (8 hexes/day)
    rumour:  90,   // word of mouth: 90 mi per IRL day (3 hexes/day)
  },

  // Base miles per in-game marching day. These are the ROAD figures; everything else in the rules
  // modifies them.
  MARCH: {
    road: 12,        // "On roads, armies move 12 miles per day" (x4/5 days -> 48 mi/IRL day)
    forcedRoad: 18,  // "A forced march increases this to 18 miles per day" (x5/5 -> 90 mi/IRL day)
    daysNormal: 4,   // marching days per 5-day (1 IRL day) block
    daysForced: 5,
  },

  // "Offroad, reduce the speeds by half." A multiplier on whatever pace the column has, not a
  // separate pair of speeds: for an ordinary army it gives the familiar 6 and 9 mi/day, and for a
  // column over the length limit it halves the limit instead. See landMilesPerIRL.
  OFFROAD_MULT: 0.5,

  MOUNTAIN_MULT: 0.5,       // "Mountains ... Movement speed halved."
  CAV_FORCED_MULT: 2,       // "Armies of exclusively cavalry double their forced march pace."
  // "Light infantry detachments can move at normal speed off-road and ignore the mountain speed
  // penalty." Taken here to set the pace of the whole army once light infantry are a third of it —
  // the same threshold the rules use for light infantry elsewhere ("if at least ⅓ of your army is
  // light infantry..."). Measured against the fighting strength, infantry and cavalry; the baggage
  // is what the column drags along, not part of what it is.
  LI_FRACTION: 1 / 3,

  // Column: 1 mile of road per 5,000 infantry+noncombatants, 2,000 cavalry, or 50 wagons.
  COLUMN: { infPer: 5000, cavPer: 2000, wagPer: 50 },
  // Logistician (a commander trait): "Your army stretches half as long on the road." A shorter column
  // is shorter for every purpose the length is used for — the 6-mile limit and the ford, both of which
  // are charged by the mile — so it is applied to the length itself rather than to either consequence.
  LOGISTICIAN_MULT: 0.5,
  // "Armies (or groups of armies marching in a single column) stretching longer than 6 miles travel
  // only 6 miles per day, for a total of 24 miles per IRL day, or 12 miles per day at a forced march
  // (for a total of 60 miles per IRL day)."
  // Like the 12 and 18 above these are ROAD paces — the rules measure the column in miles "of road",
  // and 24 mi/IRL is 6 x 4 marching days, the road cadence. So this replaces the base pace and the
  // off-road, mountain and weather multipliers still apply on top of it.
  LONG_COLUMN: { limit: 6, day: 6, forcedDay: 12 },

  // Rivers: minor (1px) rivers are fordable; major (3px) rivers can ONLY be crossed by bridge or ferry.
  // Fording: each mile of column (infantry, noncombatants, wagons) = half a day. Cavalry ford at regular speed.
  FORD: { dayPerColMile: 0.5 },

  // Weather multipliers (rules table). ford=false means fording is impossible.
  WEATHER: {
    clear:      { road: 1,    off: 1,    ford: true,  forced: true },
    heavy_rain: { road: 0.75, off: 0.5,  ford: false, forced: true },
    storm:      { road: 0.5,  off: 0.25, ford: false, forced: false },
    snow:       { road: 0.75, off: 0.5,  ford: true,  forced: true },
    blizzard:   { road: 0.25, off: 0,    ford: true,  forced: false },
    heatwave:   { road: 1,    off: 1,    ford: true,  forced: false },
  },

  // Ships: 60 mi/day on sea and rivers = 2 hexes per in-game day = 10 hexes (300 mi) per IRL day.
  SHIP_MILES_PER_DAY: 60,
  SECURE_SHIPS_IRL_DAYS: 7, // one month of game time securing ships — only if you don't already have a fleet
  // Boarding costs a day only when you ALREADY have ships, i.e. getting back aboard after landing.
  // The very first embark is free of it: the month spent securing the fleet covers the boarding.
  EMBARK_IRL_DAYS: 1,
  DISEMBARK_IRL_DAYS: 0,    // putting an army ashore costs nothing
  // Embark/disembark only at a coastal/large-river stronghold.

  WATER: new Set(['Ocean', 'Sea', 'Lake']),
  IMPASSABLE: new Set(['N/A']),

  // Marines (a tradition): "Marines can disembark anywhere." Taking ship still needs a port.
  // Reference, not used by the path cost: messengers 48 mi per in-game day (240/IRL), news 90 mi per
  // IRL day overland; night march 6 mi a night (12 forced), roads only, no night marching off-road;
  // light-cavalry harassment can halve speed; morale check per forced-march day; the Engineers
  // tradition ignores river-crossing penalties; fog costs no speed but risks losing the way.
};

// Miles per IRL day for one land step, given context.
// opts: {road, terrain, forced, liThird, cavOnly, weather, colMiles}
function landMilesPerIRL(o) {
  const W = RULES.WEATHER[o.weather] || RULES.WEATHER.clear;
  const forced = o.forced && W.forced;
  // Start from the road pace, then let the long column cut it. Both are paces on a road, so this
  // settles what the column makes in a day before anything about the ground it is crossing.
  let day = forced ? RULES.MARCH.forcedRoad : RULES.MARCH.road;
  // Cavalry double their forced pace, and the column limit is a ceiling over that rather than
  // something to double past: the doubling clause speaks of a forced march pace in general, the
  // column clause of what a long column may do at a forced march, and the narrower one wins. Twelve
  // thousand horse is where this starts to matter.
  if (forced && o.cavOnly) day *= RULES.CAV_FORCED_MULT;
  if (o.colMiles > RULES.LONG_COLUMN.limit)
    day = Math.min(day, forced ? RULES.LONG_COLUMN.forcedDay : RULES.LONG_COLUMN.day);
  // Now the ground. Off-road halves the pace the column actually has — light infantry excepted, who
  // keep their road pace off it. This ordering is the whole of the long-column fix: taking the
  // ceiling *after* the halving clamped road and off-road to the same 6 mi/day, which left a road
  // worth nothing to any army over the limit and sent big columns cross-country in a straight line.
  // Taken before it, a road is worth double at every size, as it is for everyone else.
  if (!o.road && !o.liThird) day *= RULES.OFFROAD_MULT;
  if (o.terrain === 'Mountains' && !o.liThird) day *= RULES.MOUNTAIN_MULT;
  day *= o.road ? W.road : W.off;
  const marchDays = forced ? RULES.MARCH.daysForced : RULES.MARCH.daysNormal;
  return day * marchDays; // miles per IRL day (5 in-game days)
}

function columnMiles(a) {
  const mi = (a.inf + a.non) / RULES.COLUMN.infPer + a.cav / RULES.COLUMN.cavPer + a.wag / RULES.COLUMN.wagPer;
  return a.logistician ? mi * RULES.LOGISTICIAN_MULT : mi;
}

// Ford delay in IRL days (minor rivers only; cavalry ford at regular speed and are excluded).
function fordIRLDays(a, weather) {
  const W = RULES.WEATHER[weather] || RULES.WEATHER.clear;
  if (!W.ford) return null; // fording impossible in this weather
  // Cavalry are excluded (they ford at their regular speed), so this is not columnMiles — but the
  // trait shortens what remains just the same.
  let colMiles = (a.inf + a.non) / RULES.COLUMN.infPer + a.wag / RULES.COLUMN.wagPer;
  if (a.logistician) colMiles *= RULES.LOGISTICIAN_MULT;
  if (colMiles <= 0) return 0;
  return RULES.FORD.dayPerColMile * colMiles / RULES.GAME_DAYS_PER_IRL;
}
