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

  // Base miles per in-game marching day.
  MARCH: {
    road: 12,        // "On roads, armies move 12 miles per day" (x4/5 days -> 48 mi/IRL day)
    offroad: 6,      // "Offroad, reduce the speeds by half" (-> 24 mi/IRL day)
    forcedRoad: 18,  // "A forced march increases this to 18 miles per day" (x5/5 -> 90 mi/IRL day)
    forcedOffroad: 9,
    daysNormal: 4,   // marching days per 5-day (1 IRL day) block
    daysForced: 5,
  },

  MOUNTAIN_MULT: 0.5,       // "Mountains ... Movement speed halved."
  CAV_FORCED_MULT: 2,       // "Armies of exclusively cavalry double their forced march pace."
  // Light infantry detachments: "can move at normal speed off-road and ignore the mountain speed penalty."

  // Column: 1 mile of road per 5,000 infantry+noncombatants, 2,000 cavalry, or 50 wagons.
  COLUMN: { infPer: 5000, cavPer: 2000, wagPer: 50 },
  // Columns > 6 miles: 6 mi/day (24 mi/IRL), forced 12 mi/day (60 mi/IRL).
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

  // Reference (not used by the path cost): messengers 48 mi/day (36 hostile),
  // news 30 mi/day overland / 180 coastal; night march 6 mi (12 forced), roads only;
  // light-cavalry harassment can halve speed; morale check per forced-march day.
};

// Miles per IRL day for one land step, given context.
// opts: {road, terrain, forced, liOnly, cavOnly, weather, colMiles}
function landMilesPerIRL(o) {
  const W = RULES.WEATHER[o.weather] || RULES.WEATHER.clear;
  const forced = o.forced && W.forced;
  let day;
  if (o.road) day = forced ? RULES.MARCH.forcedRoad : RULES.MARCH.road;
  else if (o.liOnly) day = forced ? RULES.MARCH.forcedRoad : RULES.MARCH.road; // LI move at normal (road) speed off-road
  else day = forced ? RULES.MARCH.forcedOffroad : RULES.MARCH.offroad;
  if (o.terrain === 'Mountains' && !o.liOnly) day *= RULES.MOUNTAIN_MULT;
  if (forced && o.cavOnly) day *= RULES.CAV_FORCED_MULT;
  day *= o.road ? W.road : W.off;
  if (o.colMiles > RULES.LONG_COLUMN.limit)
    day = Math.min(day, forced ? RULES.LONG_COLUMN.forcedDay : RULES.LONG_COLUMN.day);
  const marchDays = forced ? RULES.MARCH.daysForced : RULES.MARCH.daysNormal;
  return day * marchDays; // miles per IRL day (5 in-game days)
}

function columnMiles(a) {
  return (a.inf + a.non) / RULES.COLUMN.infPer + a.cav / RULES.COLUMN.cavPer + a.wag / RULES.COLUMN.wagPer;
}

// Ford delay in IRL days (minor rivers only; cavalry ford at regular speed and are excluded).
function fordIRLDays(a, weather) {
  const W = RULES.WEATHER[weather] || RULES.WEATHER.clear;
  if (!W.ford) return null; // fording impossible in this weather
  const colMiles = (a.inf + a.non) / RULES.COLUMN.infPer + a.wag / RULES.COLUMN.wagPer;
  if (colMiles <= 0) return 0;
  return RULES.FORD.dayPerColMile * colMiles / RULES.GAME_DAYS_PER_IRL;
}
