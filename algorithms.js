/*
 * algorithms.js — all of Battlegrid's procedural map-generation algorithms.
 *
 * Everything here is pure and driven by a seeded PRNG, so a given seed always
 * produces the same 100x100 map. Generation order matters:
 *
 *   1. lakes   — rectangular blocks of water, 2x2 .. 17x17
 *   2. rivers  — a single-tile-wide connected path of water that starts at a
 *                lake or the board edge and flows to another edge/water
 *   3. forests — blobby patches 3x3 .. 17x17, placed only on plains (avoid water)
 *   4. cities  — 17 per player on their half of the board, on plains only
 *                (avoid water and trees)
 *
 * Exposes window.Algorithms.
 */
window.Algorithms = (function () {
  const GRID = 100;
  const inB = (r, c) => r >= 0 && r < GRID && c >= 0 && c < GRID;

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

  const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive

  function blankTerrain() {
    const t = [];
    for (let r = 0; r < GRID; r++) {
      const row = new Array(GRID);
      for (let c = 0; c < GRID; c++) row[c] = 'plains';
      t.push(row);
    }
    return t;
  }

  // --- 1. LAKES: rectangular water blocks sized 2x2 .. 17x17 ----------------
  // Kept in the central band so they don't bury the players' start columns.
  function generateLakes(t, rng, count) {
    const lakes = [];
    for (let i = 0; i < count; i++) {
      const w = randInt(rng, 2, 17);
      const h = randInt(rng, 2, 17);
      const c0 = randInt(rng, 8, GRID - 8 - w);
      const r0 = randInt(rng, 2, GRID - 2 - h);
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
  function edgeCell(rng) {
    const side = randInt(rng, 0, 3);
    if (side === 0) return [0, randInt(rng, 0, GRID - 1)];
    if (side === 1) return [GRID - 1, randInt(rng, 0, GRID - 1)];
    if (side === 2) return [randInt(rng, 0, GRID - 1), 0];
    return [randInt(rng, 0, GRID - 1), GRID - 1];
  }

  // --- 2. RIVER: a single-tile-wide connected path of water -----------------
  // Starts from a lake border (if any lakes exist) or the board edge, then
  // walks one tile at a time (4-connected, never diagonal, so it stays a
  // single connected block) drifting toward a target edge until it reaches an
  // edge or runs out of length.
  function carveRiver(t, rng, lakes) {
    let r, c;
    if (lakes.length && rng() < 0.5) {
      [r, c] = lakeBorderCell(rng, lakes[randInt(rng, 0, lakes.length - 1)]);
    } else {
      [r, c] = edgeCell(rng);
    }
    const [tr, tc] = edgeCell(rng); // flow roughly toward this edge cell

    const maxSteps = GRID * 2;
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
      if (step > 4 && (r <= 0 || r >= GRID - 1 || c <= 0 || c >= GRID - 1)) {
        if (inB(r, c)) t[r][c] = 'water';
        break;
      }
    }
  }

  function generateRivers(t, rng, lakes, count) {
    for (let i = 0; i < count; i++) carveRiver(t, rng, lakes);
  }

  // --- 3. FORESTS: blobby patches 3x3 .. 17x17, only on plains --------------
  function generateForests(t, rng, count) {
    for (let i = 0; i < count; i++) {
      const w = randInt(rng, 3, 17);
      const h = randInt(rng, 3, 17);
      const r0 = randInt(rng, 0, GRID - h);
      const c0 = randInt(rng, 0, GRID - w);
      for (let r = r0; r < r0 + h; r++)
        for (let c = c0; c < c0 + w; c++) {
          // jitter the rectangle edges so forests look organic, and never
          // overwrite water
          if (t[r][c] === 'plains' && rng() < 0.82) t[r][c] = 'forest';
        }
    }
  }

  // --- 4. CITIES: 17 per player, on their half, avoiding water and trees ----
  function placeCities(t, rng) {
    const cities = [];
    const occupied = new Set();
    const placeSide = (owner, cMin, cMax) => {
      let placed = 0, attempts = 0;
      while (placed < 17 && attempts < 20000) {
        attempts++;
        const r = randInt(rng, 1, GRID - 2);
        const c = randInt(rng, cMin, cMax);
        const k = r + ',' + c;
        if (t[r][c] !== 'plains' || occupied.has(k)) continue; // avoid water & trees
        t[r][c] = 'city';
        occupied.add(k);
        cities.push({ r, c, owner });
        placed++;
      }
    };
    placeSide(0, 1, 44);            // Blue / left half
    placeSide(1, GRID - 45, GRID - 2); // Red / right half
    return cities;
  }

  // --- top-level: build a full map from a seed ------------------------------
  function generateMap(seed) {
    const rng = makeRng(seed);
    const t = blankTerrain();
    const lakes = generateLakes(t, rng, randInt(rng, 3, 6));
    generateRivers(t, rng, lakes, randInt(rng, 3, 5));
    generateForests(t, rng, randInt(rng, 18, 28));
    const cities = placeCities(t, rng);
    return { terrain: t, cities };
  }

  return {
    GRID, makeRng, generateMap,
    generateLakes, generateRivers, carveRiver, generateForests, placeCities,
  };
})();
