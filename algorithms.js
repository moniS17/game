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
 *   4. cities  — per player on their half of the board, on plains only
 *
 * Exposes window.Algorithms.
 */
window.Algorithms = (function () {
  const GRID = 100;              // legacy default (square)
  const MIN = 5, MAX = 400;      // hard bounds on either dimension
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

  // --- 4. CITIES: per player, on their half, avoiding water and trees -------
  function placeCities(t, rng, rows, cols) {
    const cities = [];
    const occupied = new Set();
    const perSide = citiesPerSide(rows, cols); // scales with board area (17 at 100x100)
    const leftMax = Math.max(1, Math.floor(cols * 0.44));            // 44 at cols=100
    const rightMin = cols - 1 - Math.floor(cols * 0.44);            // 55 at cols=100
    const placeSide = (owner, cMin, cMax) => {
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
    };
    placeSide(0, 1, leftMax);            // Blue / left half
    placeSide(1, rightMin, cols - 2);    // Red / right half
    return cities;
  }

  // --- 5. VILLAGES: single neutral tiles scattered on plains ---------------
  // Placed LAST so lakes/rivers/forests/cities are byte-for-byte unchanged for a
  // given seed; villages only paint onto leftover plains (never over a city).
  function generateVillages(t, rng, count, rows, cols) {
    let placed = 0, attempts = 0;
    const cap = count * 200 + 500;
    while (placed < count && attempts < cap) {
      attempts++;
      const r = randInt(rng, 0, rows - 1);
      const c = randInt(rng, 0, cols - 1);
      if (t[r][c] !== 'plains') continue; // avoid water, forest, city
      t[r][c] = 'village';
      placed++;
    }
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
    const cities = placeCities(t, rng, rows, cols);
    generateVillages(t, rng, Math.max(1, Math.round(randInt(rng, 14, 20) * scale)), rows, cols);
    return { terrain: t, cities };
  }

  return {
    GRID, MIN, MAX, clampDim, makeRng, generateMap,
    CITIES_PER_SIDE, UNITS_PER_SIDE, areaScale, citiesPerSide, unitsPerSide,
    generateLakes, generateRivers, carveRiver, generateForests, placeCities, generateVillages,
  };
})();
