/*
 * terrain-weights.js — configurable terrain spawn-rate weights.
 *
 * Controls how many lakes, rivers, forests, cities, and villages the map
 * generator places. Each weight is a multiplier (1 = default density from
 * algorithms.js). The UI on mode.html lets the player drag sliders; the
 * values are passed through the game intent to algorithms.js at generation
 * time.
 *
 * Exposes window.TerrainWeights.
 */
window.TerrainWeights = (function () {
  const DEFAULTS = {
    forest: 1.0,
    water:  1.0,
    city:   1.0,
    village: 1.0,
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function sanitize(raw) {
    if (!raw || typeof raw !== 'object') return Object.assign({}, DEFAULTS);
    return {
      forest:  clamp(Number(raw.forest)  || 1, 0, 3),
      water:   clamp(Number(raw.water)   || 1, 0, 3),
      city:    clamp(Number(raw.city)    || 1, 0, 3),
      village: clamp(Number(raw.village) || 1, 0, 3),
    };
  }

  function applyToGeneration(seed, rows, cols, playerCount, weights) {
    const w = sanitize(weights);
    return { seed, rows, cols, playerCount, weights: w };
  }

  return { DEFAULTS, sanitize, applyToGeneration };
})();
