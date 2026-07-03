/*
 * algorithms.js — all of Battlegrid's procedural map-generation algorithms.
 *
 * Everything here is pure and driven by a seeded PRNG, so a given (seed, rows,
 * cols) always produces the same map. The board can be any size; feature sizes
 * and counts scale with the board so small maps stay playable and the classic
 * 100x100 map is byte-for-byte identical to before. Generation order:
 *
 *   1. lakes   — rectangular blocks of water
 *   2. rivers  — single-tile-wide connected paths of water
 *   3. forests — blobby patches placed only on plains (avoid water)
 *   4. cities  — per player, clustered toward each side's 30% width mark,
 *                plus neutral cities near the board center (fought over)
 *   5. villages — scattered neutral tiles (capturable; pay 50% of a city)
 *
 * Exposes window.Algorithms.
 */
window.Algorithms = (function () {
  const GRID = 100;              // legacy default (square)
  const MIN = 10, MAX = 1717;    // hard bounds on either dimension
  const clampDim = (n) => Math.max(MIN, Math.min(MAX, Math.floor(n) || GRID));

  // --- board-size scaling ----------------------------------------------------
  // Cities and starting armies scale with the board AREA so density is constant:
  // the classic 100x100 map yields exactly CITIES_PER_SIDE cities and
  // UNITS_PER_SIDE units for each player; bigger/smaller maps get proportionally
  // more/fewer (always at least 1 so any legal board stays playable).
  const CITIES_PER_SIDE = 17;    // per player at 100x100
  const UNITS_PER_SIDE = 34;     // per player at 100x100
  const areaScale = (rows, cols) => (rows * cols) / (GRID * GRID); // 1 at 100x100
  const citiesPerSide = (rows, cols) => Math.max(1, Math.round(CITIES_PER_SIDE * areaScale(rows, cols)));
  const unitsPerSide = (rows, cols) => Math.max(1, Math.round(UNITS_PER_SIDE * areaScale(rows, cols)));
  // Neutral cities near the board center: 1 at 10x10, 17 at 100x100, more on larger boards.
  const neutralCount = (rows, cols) => Math.max(1, Math.round(CITIES_PER_SIDE * areaScale(rows, cols)));

  // --- seeded PRNG (mulberry32): deterministic given the seed ---------------
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Inclusive integer in [lo, hi]. Degenerate ranges (hi < lo) yield lo without
  // consuming the PRNG, so a too-small board just skips a feature cleanly.
  const randInt = (rng, lo, hi) => (hi < lo ? lo : lo + Math.floor(rng() * (hi - lo + 1)));

  function blankTerrain(rows, cols) {
    const t = [];
    for (let r = 0; r < rows; r++) {
      const row = new Array(cols);
      for (let c = 0; c < cols; c++) row[c] = 'plains';
      t.push(row);
    }
    return t;
  }

  // Largest lake/forest dimension for a board (17 at 100x100).
  const featMax = (rows, cols) => Math.max(2, Math.min(17, Math.floor(Math.min(rows, cols) / 4)));

  // --- 1. LAKES: rectangular water blocks -----------------------------------
  // Kept in the central band so they don't bury the players' start columns.
  function generateLakes(t, rng, count, rows, cols, inB) {
    const lakes = [];
    const fm = featMax(rows, cols);
    const band = Math.max(1, Math.floor(cols * 0.08)); // 8 at cols=100
    for (let i = 0; i < count; i++) {
      const w = randInt(rng, 2, fm);
      const h = randInt(rng, 2, fm);
      const c0 = randInt(rng, band, cols - band - w);
      const r0 = randInt(rng, 2, rows - 2 - h);
      for (let r = r0; r < r0 + h; r++)
        for (let c = c0; c < c0 + w; c++)
          if (inB(r, c)) t[r][c] = 'water';
      lakes.push({ r0, c0, w, h });
    }
    return lakes;
  }

  // Pick a random cell on the perimeter of a lake rectangle.
  function lakeBorderCell(rng, L) {
    const side = randInt(rng, 0, 3);
    if (side === 0) return [L.r0, randInt(rng, L.c0, L.c0 + L.w - 1)];               // top
    if (side === 1) return [L.r0 + L.h - 1, randInt(rng, L.c0, L.c0 + L.w - 1)];     // bottom
    if (side === 2) return [randInt(rng, L.r0, L.r0 + L.h - 1), L.c0];               // left
    return [randInt(rng, L.r0, L.r0 + L.h - 1), L.c0 + L.w - 1];                      // right
  }

  // A random cell on the edge of the board.
  function edgeCell(rng, rows, cols) {
    const side = randInt(rng, 0, 3);
    if (side === 0) return [0, randInt(rng, 0, cols - 1)];
    if (side === 1) return [rows - 1, randInt(rng, 0, cols - 1)];
    if (side === 2) return [randInt(rng, 0, rows - 1), 0];
    return [randInt(rng, 0, rows - 1), cols - 1];
  }

  // --- 2. RIVER: a single-tile-wide connected path of water -----------------
  function carveRiver(t, rng, lakes, rows, cols, inB) {
    let r, c;
    if (lakes.length && rng() < 0.5) {
      [r, c] = lakeBorderCell(rng, lakes[randInt(rng, 0, lakes.length - 1)]);
    } else {
      [r, c] = edgeCell(rng, rows, cols);
    }
    const [tr, tc] = edgeCell(rng, rows, cols); // flow roughly toward this edge cell

    const maxSteps = Math.max(rows, cols) * 2;
    for (let step = 0; step < maxSteps && inB(r, c); step++) {
      t[r][c] = 'water';

      let mr = 0, mc = 0;
      if (rng() < 0.72) {
        // bias toward the target along the axis with the greater remaining gap
        if (Math.abs(tr - r) >= Math.abs(tc - c)) {
          mr = Math.sign(tr - r) || (rng() < 0.5 ? 1 : -1);
        } else {
          mc = Math.sign(tc - c) || (rng() < 0.5 ? 1 : -1);
        }
      } else {
        // occasional meander
        if (rng() < 0.5) mr = rng() < 0.5 ? 1 : -1;
        else mc = rng() < 0.5 ? 1 : -1;
      }

      r += mr; c += mc;
      // once we've travelled a little, stop when we hit an edge
      if (step > 4 && (r <= 0 || r >= rows - 1 || c <= 0 || c >= cols - 1)) {
        if (inB(r, c)) t[r][c] = 'water';
        break;
      }
    }
  }

  function generateRivers(t, rng, lakes, count, rows, cols, inB) {
    for (let i = 0; i < count; i++) carveRiver(t, rng, lakes, rows, cols, inB);
  }

  // --- 3. FORESTS: blobby patches, only on plains ---------------------------
  function generateForests(t, rng, count, rows, cols) {
    const fm = featMax(rows, cols);
    for (let i = 0; i < count; i++) {
      const w = randInt(rng, Math.min(3, fm), fm);
      const h = randInt(rng, Math.min(3, fm), fm);
      const r0 = randInt(rng, 0, rows - h);
      const c0 = randInt(rng, 0, cols - w);
      for (let r = r0; r < r0 + h; r++)
        for (let c = c0; c < c0 + w; c++) {
          // jitter the rectangle edges so forests look organic, never over water
          if (t[r][c] === 'plains' && rng() < 0.82) t[r][c] = 'forest';
        }
    }
  }

  // --- 4. CITIES: per player, clustered toward each side's 30% width mark ----
  function placeCities(t, rng, rows, cols) {
    const cities = [];
    const occupied = new Set();
    const perSide = citiesPerSide(rows, cols); // scales with board area (17 at 100x100)
    // Cluster each side's cities around the column 30% of the way in from THEIR
    // own edge (Blue ~0.30·W, Red ~0.70·W), leaving the center for neutral cities.
    const half = Math.max(1, Math.round(cols * 0.12));
    const blueMid = Math.round(0.30 * (cols - 1));
    const redMid = Math.round(0.70 * (cols - 1));
    const clampC = (c) => Math.max(1, Math.min(cols - 2, c));
    const placeBand = (owner, mid) => {
      const cMin = clampC(mid - half), cMax = clampC(mid + half);
      let placed = 0, attempts = 0;
      while (placed < perSide && attempts < 20000) {
        attempts++;
        const r = randInt(rng, 1, rows - 2);
        const c = randInt(rng, cMin, cMax);
        const k = r + ',' + c;
        if (t[r][c] !== 'plains' || occupied.has(k)) continue; // avoid water & trees
        t[r][c] = 'city';
        occupied.add(k);
        cities.push({ r, c, owner });
        placed++;
      }
      return occupied;
    };
    placeBand(0, blueMid);   // Blue / left cluster
    placeBand(1, redMid);    // Red / right cluster
    return { cities, occupied };
  }

  // --- 4b. NEUTRAL CITIES: unowned cities in a central band, fought over ------
  function placeNeutralCities(t, rng, rows, cols, occupied) {
    const cities = [];
    const count = neutralCount(rows, cols);
    const half = Math.max(2, Math.round(cols * 0.12)); // central ~0.38–0.62·W
    const mid = Math.round((cols - 1) / 2);
    const cMin = Math.max(1, mid - half), cMax = Math.min(cols - 2, mid + half);
    let placed = 0, attempts = 0;
    const cap = count * 200 + 500;
    while (placed < count && attempts < cap) {
      attempts++;
      const r = randInt(rng, 1, rows - 2);
      const c = randInt(rng, cMin, cMax);
      const k = r + ',' + c;
      if (t[r][c] !== 'plains' || occupied.has(k)) continue;
      t[r][c] = 'city';
      occupied.add(k);
      cities.push({ r, c, owner: null }); // neutral until captured
      placed++;
    }
    return cities;
  }

  // --- 5. VILLAGES: clustered around cities --------------------------------
  // Placed LAST so lakes/rivers/forests/cities are byte-for-byte unchanged for a
  // given seed. Each city (owned OR neutral) seeds a RANDOM 0–6 villages onto the
  // (up to) 8 tiles surrounding it — only leftover plains qualify, so villages
  // never overwrite water, forest, or another city/village. The requested count
  // is a target; fewer land if the ring is crowded. Returns the placed positions
  // as capturable, income-generating sites (each village pays 50% of a city).
  const RING8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  function generateVillages(t, rng, cities, rows, cols, inB) {
    const villages = [];
    for (const city of cities) {
      const want = randInt(rng, 0, 6);            // 0..6 per city
      if (!want) continue;
      // Fisher–Yates shuffle the 8 neighbours so which sides get villages varies.
      const ring = RING8.map(([dr, dc]) => [city.r + dr, city.c + dc]);
      for (let i = ring.length - 1; i > 0; i--) {
        const j = randInt(rng, 0, i);
        const tmp = ring[i]; ring[i] = ring[j]; ring[j] = tmp;
      }
      let placed = 0;
      for (const [r, c] of ring) {
        if (placed >= want) break;
        if (!inB(r, c) || t[r][c] !== 'plains') continue; // skip water/forest/city/edge
        t[r][c] = 'village';
        villages.push({ r, c, owner: null });    // neutral until captured
        placed++;
      }
    }
    return villages;
  }

  // --- top-level: build a full map from a seed + dimensions -----------------
  function generateMap(seed, rows, cols) {
    rows = clampDim(rows == null ? GRID : rows);
    cols = clampDim(cols == null ? GRID : cols);
    const inB = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols;
    const rng = makeRng(seed);
    const t = blankTerrain(rows, cols);
    const scale = (rows * cols) / (GRID * GRID); // 1 at 100x100
    const lakes = generateLakes(t, rng, Math.max(1, Math.round(randInt(rng, 3, 6) * scale)), rows, cols, inB);
    generateRivers(t, rng, lakes, Math.max(1, Math.round(randInt(rng, 3, 5) * scale)), rows, cols, inB);
    generateForests(t, rng, Math.max(2, Math.round(randInt(rng, 18, 28) * scale)), rows, cols);
    const { cities, occupied } = placeCities(t, rng, rows, cols);
    const neutral = placeNeutralCities(t, rng, rows, cols, occupied);
    for (const nc of neutral) cities.push(nc);
    // Villages cluster around every city (0–6 each) — see generateVillages.
    const villages = generateVillages(t, rng, cities, rows, cols, inB);
    return { terrain: t, cities, villages };
  }

  return {
    GRID, MIN, MAX, clampDim, makeRng, generateMap,
    CITIES_PER_SIDE, UNITS_PER_SIDE, areaScale, citiesPerSide, unitsPerSide, neutralCount,
    generateLakes, generateRivers, carveRiver, generateForests, placeCities, placeNeutralCities, generateVillages,
  };
})();
