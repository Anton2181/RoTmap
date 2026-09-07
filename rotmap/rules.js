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

  // "An army undergoing a night march travels 6 miles per night, or 12 miles at a forced march ...
  // Armies cannot night march off-road."
  // Marching by night is an alternative to marching by day, not an addition to it — the weather table
  // sets the two against each other ("Day marching gives -1 Morale per IRL day. Night marching is
  // fine"), so these replace the 12/18 road pace rather than adding to it, over the same 4-of-5 and
  // 5-of-5 cadences: 24 mi/IRL, or 60 forced. Always slower than the same march made by day, which is
  // the point — night marching is what you do to get out of the heat, not to arrive sooner.
  // The 6-mile column limit is exactly these two numbers, so it never binds a night march.
  NIGHT: { day: 6, forcedDay: 12 },
  /* Marching by day *and* by night is the third thing the sheet distinguishes, and it is the sum
     rather than a replacement: the column makes its 12 road miles in daylight and another 6 after
     dark, 18 a day, or 30 at a forced march. Roads only for the dark half, so off-road a day-and-
     night march is just an ordinary day march — the night buys nothing where there is no road to
     follow. It pays for that speed twice over in a heatwave, where the daylight half still costs its
     point a day and the dark half still calls for its check. */

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
    // Hot was folded into clear while nothing read the morale rules; it costs no speed, but it is the
    // weather night marching exists for, so it needs to be its own answer now that morale is modelled.
    hot:        { road: 1,    off: 1,    ford: true,  forced: true },
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
  // IRL day overland; light-cavalry harassment can halve speed; morale checks per forced-march day
  // and per five nights marched; the 2-in-6 wrong turn at a fork on a night march; the Engineers
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
  // Night marching is a road pace and only a road pace: an army cannot night march off-road, so a
  // step with no road under it is one the column makes by day, at the ordinary day rate, and needs
  // no special case here — leaving `day` at the day pace is what "marched this stretch by daylight"
  // means. Callers that must say so in words ask nightStep().
  if (o.night && o.road) day = forced ? RULES.NIGHT.forcedDay : RULES.NIGHT.day;
  else if (o.dayNight && o.road) day += forced ? RULES.NIGHT.forcedDay : RULES.NIGHT.day;
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

// Whether a step under these conditions is actually marched by night. Night marching is roads only,
// so a night-marching column still crosses roadless ground by day; the readout says which is which.
function nightStep(o, road) { return !!o.night && !!road; }
// A day-and-night step is one where the dark half actually buys something, which is to say a road.
function dayNightStep(o, road) { return !!o.dayNight && !!road; }
// Whether any part of this step is marched after dark — what the night morale check asks about.
function marchesAtNight(o, road) { return !!road && (!!o.night || !!o.dayNight); }
// Whether any part of it is marched in daylight — what the heat rules ask about.
function marchesByDay(o, road) { return !o.night || !road; }

/* ---------------- morale ---------------- */
/* "Certain events call for a morale check: roll 2d6 equal to or under the army's morale. On a success,
   the army holds; on a failure, consult the table below, using the morale roll as the result. In
   certain cases, morale checks carry additional specific consequences; the default results still
   apply."

   So one marching check is a single 2d6 roll carrying two independent outcomes, and the calculator
   has to keep them apart:
     - **doubles** costs a point of morale ("check morale: on a roll of doubles, lose 1 morale"),
       at a flat 1 in 6 whatever the army's morale is;
     - a roll **over** the army's morale is a failure, and the roll indexes the consequences table.
   The first is what the histogram and the optimiser are about. The second is the graver risk and is
   reported beside them, because a mutiny is not a slower march. */
RULES.MORALE = {
  MAX: 12, REST: 9,              // "armies have a resting morale of 9 and a maximum morale of 12"
  PEASANT_MAX: 9, PEASANT_REST: 6, // "if the majority of your army is peasant infantry"
  DOUBLES: 6 / 36,               // the marching rider: 6 doubles out of 36 faces
  MARCHING_CITY_WAGON_PER_INF: 30, // "at least 1 wagon for every 30 infantry", and over 6 miles long
  POET_BONUS: 2,                 // "your morale rolls count as 2 higher for ... failed consequences"
  RECOVERY_IRL_DAYS: 20,         // "every 20 IRL days, morale changes by 1 towards resting" 
};

// Weather riders on morale. Speed multipliers live in WEATHER; these are what the same weather does
// to the army's spirit, which is a separate question and only Hot, Heatwave and Blizzard ask it.
RULES.WEATHER_MORALE = {
  hot:      { dayForcedCheck: true, dayMilesCheck: 60 }, // checks, no automatic loss; "night marching is fine"
  heatwave: { dayLoss: 1 },                              // "day marching gives -1 Morale per IRL day"
  blizzard: { anyLoss: 1 },                              // "marching gives -1 morale per IRL day"
};

/* The consequences table, indexed by the failed roll. `size` is the expected fraction of the army
   lost outright, so a result that only threatens a loss is written at its expectation: mutiny is a
   3-in-6 chance of losing half, which is a quarter of the army on average. `dets` counts detachments
   that leave for good and `away` those that leave and come back; `temp` marks a result that costs no
   permanent strength at all, and `grows` one that makes the column longer rather than shorter. */
RULES.CONSEQUENCES = {
  2:  { name: 'Mutiny',            size: 0.25, mutiny: true, detail: '3-in-6 that half the army disbands' },
  3:  { name: 'Mass desertion',    size: 0.30, detail: 'army and supplies -30%' },
  4:  { name: 'Defection',         size: 0,    dets: 4, detail: '2d3 detachments defect (4 on average)' },
  5:  { name: 'Major desertion',   size: 0.20, detail: 'army and supplies -20%' },
  6:  { name: 'Advance on pay',    size: 0,    coin: true, detail: 'a quarter of the army\'s pay in coin' },
  7:  { name: 'Defection',         size: 0,    dets: 1, detail: 'one detachment defects' },
  8:  { name: 'Desertion',         size: 0.10, detail: 'army and supplies -10%' },
  9:  { name: 'Detachments stray', size: 0,    away: 3.5, temp: true, detail: '1d6 detachments away 1d4+1 IRL days' },
  10: { name: 'Camp followers',    size: 0,    grows: 0.05, detail: 'noncombatants +5% — a longer column' },
  11: { name: 'Detachment strays', size: 0,    away: 1, temp: true, detail: 'one detachment away 1d4+1 IRL days' },
  12: { name: 'No consequences',   size: 0,    temp: true, detail: 'the army holds' },
};

// 2d6, as 36ths: how many of the 36 faces show each total, and how many of those are doubles.
const D2_WAYS = { 2:1, 3:2, 4:3, 5:4, 6:5, 7:6, 8:5, 9:4, 10:3, 11:2, 12:1 };
const D2_DOUBLE_WAYS = { 2:1, 4:1, 6:1, 8:1, 10:1, 12:1 };   // 1-1, 2-2, ... 6-6
function d2Prob(total) { return (D2_WAYS[total] || 0) / 36; }
// A check is failed when the roll is strictly over the army's morale ("equal to or under" holds).
function checkFailProb(morale) {
  let p = 0;
  for (let r = 2; r <= 12; r++) if (r > morale) p += d2Prob(r);
  return p;
}

// Binomial pmf over k successes in n trials, built as a whole array: the number of checks a route
// makes is small, and the caller always wants the entire distribution rather than one term.
function binomDist(n, p) {
  const out = new Array(n + 1).fill(0);
  out[0] = Math.pow(1 - p, n);
  for (let k = 1; k <= n; k++) out[k] = out[k - 1] * ((n - k + 1) / k) * (p / (1 - p));
  return out;
}

/* The distribution of the morale an army finishes a march with. Every check subtracts a point with
   the same 1-in-6 whatever the morale at the time, so the total loss is binomial and does not depend
   on the order the checks come in — which is what lets the optimiser reorder and re-mark legs freely
   and still get an exact answer. The weather's automatic losses are certain, so they simply shift it.
   Morale floors at 0; an army there fails every check it makes. */
function moraleDist(start, checks, detLoss, max, drifts, rest) {
  const cap = max || RULES.MORALE.MAX;
  const dist = new Array(cap + 1).fill(0);
  const loss = binomDist(checks, RULES.MORALE.DOUBLES);
  for (let k = 0; k < loss.length; k++) {
    const m = Math.max(0, Math.min(cap, start - detLoss - k));
    dist[m] += loss[k];
  }
  return moraleDrift(dist, drifts || 0, rest);
}

/* "Every 20 IRL days, morale changes by 1 towards an army's resting morale. If it is over, it goes
   down by 1, and if it is under, it goes up by 1." Applied to the whole distribution a step at a
   time, because the direction depends on where each outcome sits: one march can leave some of its
   possible armies above resting and some below, and the same tick pulls them opposite ways.

   Taken after the march's losses rather than interleaved with them. For any route shorter than 20 IRL
   days that is exact, since there are no ticks at all; beyond it, the two orderings differ only where
   an outcome crosses resting morale mid-march, which is the price of not carrying elapsed time
   through the whole distribution. */
function moraleDrift(dist, ticks, rest) {
  const target = rest ?? RULES.MORALE.REST;
  let cur = dist;
  for (let t = 0; t < ticks; t++) {
    const next = new Array(cur.length).fill(0);
    for (let m = 0; m < cur.length; m++) {
      if (!cur[m]) continue;
      next[m === target ? m : m > target ? m - 1 : m + 1] += cur[m];
    }
    cur = next;
  }
  return cur;
}
// How many rest-drift ticks a march of this many IRL days earns.
function moraleDrifts(irlDays) { return Math.floor((irlDays || 0) / RULES.MORALE.RECOVERY_IRL_DAYS); }

// P(the army finishes at or above `floor`).
function moraleAtLeast(start, checks, detLoss, floor, max, drifts, rest) {
  const d = moraleDist(start, checks, detLoss, max, drifts, rest);
  let p = 0;
  for (let m = Math.max(0, floor); m < d.length; m++) p += d[m];
  return p;
}
/* The most checks a march can carry and still finish at or above `floor` with at least `conf`
   confidence. Monotone in the number of checks, so this counts up until it breaks; -1 means the
   deterministic losses alone already put the army under, and no arrangement of legs can help. */
function moraleCheckBudget(start, detLoss, floor, conf, max, drifts, rest) {
  if (moraleAtLeast(start, 0, detLoss, floor, max, drifts, rest) < conf) return -1;
  let n = 0;
  while (n < 400 && moraleAtLeast(start, n + 1, detLoss, floor, max, drifts, rest) >= conf) n++;
  return n;
}

/* What the failed checks are likely to do. Unlike the morale loss this *does* depend on the order and
   on the morale at the time of each roll — an army worn down by the first half of a march fails more
   often in the second — so it is walked check by check over the running distribution of morale
   rather than reduced to a binomial. Returns the chance of at least one failure, the expected
   fraction of the army lost, and the odds of each result on the table.

   `legs` is [{checks, plain, det}] in marching order. A `plain` check is one that can fail but
   carries no doubles rider — the Hot weather checks — so it threatens the army without wearing it
   down, and the two kinds cannot be added together. `poet` shifts the *consequence* two rows up the table
   without changing whether the roll failed, which is what the trait says. */
function moraleOutlook(start, legs, { poet = false, max = RULES.MORALE.MAX, drifts = 0, rest } = {}) {
  const cap = max, zeros = () => new Array(cap + 1).fill(0);
  /* Two distributions are carried, not one. `dist` is every path, and answers what morale the army
     ends on. `clean` is only those paths that have not yet failed a check, and its total mass at the
     end is the chance of coming through without a failure — which is *not* one minus the sum of the
     per-check failure probabilities, because a march can fail twice and that sum double-counts it. */
  let dist = zeros(), clean = zeros();
  const s0 = Math.max(0, Math.min(cap, start));
  dist[s0] = 1; clean[s0] = 1;
  const byResult = {}; let expFails = 0, sizeLoss = 0, dets = 0;
  const shift = poet ? RULES.MORALE.POET_BONUS : 0;
  for (const leg of legs) {
    if (leg.det) {                                  // certain losses land before the leg's checks
      const nd = zeros(), nc = zeros();
      for (let m = 0; m <= cap; m++) {
        const to = Math.max(0, m - leg.det);
        nd[to] += dist[m]; nc[to] += clean[m];
      }
      dist = nd; clean = nc;
    }
    for (let c = 0; c < (leg.checks || 0) + (leg.plain || 0); c++) {
      // The morale-costing rolls first, then the plain ones; within a leg the order between them
      // makes no difference to either answer, since both read the same 2d6 against the same morale.
      const wears = c < (leg.checks || 0);
      const nd = zeros(), nc = zeros();
      for (let m = 0; m <= cap; m++) {
        const pm = dist[m], pc = clean[m];
        if (!pm && !pc) continue;
        for (let r = 2; r <= 12; r++) {
          const p = d2Prob(r);
          if (!p) continue;
          // The chance this total was rolled as doubles, given the total. Independent of whether the
          // check passed: one roll, read twice.
          const dbl = wears ? (D2_DOUBLE_WAYS[r] || 0) / D2_WAYS[r] : 0;
          const to = Math.max(0, m - 1);
          if (pm) {
            const pr = pm * p;
            if (r > m) {                            // failed: the roll is the result
              const idx = Math.min(12, r + shift), con = RULES.CONSEQUENCES[idx];
              byResult[idx] = (byResult[idx] || 0) + pr;
              expFails += pr; sizeLoss += pr * (con.size || 0); dets += pr * (con.dets || 0);
            }
            nd[to] += pr * dbl; nd[m] += pr * (1 - dbl);
          }
          if (pc && r <= m) {                       // only a passed check keeps a path clean
            const pr = pc * p;
            nc[to] += pr * dbl; nc[m] += pr * (1 - dbl);
          }
        }
      }
      dist = nd; clean = nc;
    }
  }
  return { anyFail: 1 - clean.reduce((a, b) => a + b, 0), expFails, sizeLoss, dets, byResult,
           dist: moraleDrift(dist, drifts, rest) };
}

/* Whether the Marching City tradition covers this column's forced marching: "if your army is more
   than 6 miles long and has at least 1 wagon for every 30 infantry, you can force march on roads
   without risking morale". All three facts are already known — the length from columnMiles, the ratio
   from the boxes, and the road from the step. */
function marchingCityCovers(o, colMiles, allRoad) {
  if (!o.marchingCity || !allRoad) return false;
  if (colMiles <= RULES.LONG_COLUMN.limit) return false;
  const inf = o.army?.inf || 0;
  return o.army?.wag * RULES.MORALE.MARCHING_CITY_WAGON_PER_INF >= inf;
}
