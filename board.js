/*
 * board.js — terrain definitions and board helpers.
 *
 * Owns the terrain table and small query helpers used by rules.js, render.js
 * and game.js. Map *generation* lives in algorithms.js; this file just wraps
 * it (Board.fromSeed) and provides tile lookups, so the board representation
 * can evolve independently of the rules.
 *
 *   move_cost - movement points to ENTER the tile (see rules.js for the
 *               extra water-crossing rules)
 *   defense   - subtracted from incoming attack damage on this tile
 */
window.TERRAIN = {
  plains: { name: 'Plains', code: '.', color: '#7cb342', move_cost: 1, defense: 0 },
  city:   { name: 'City',   code: 'C', color: '#9e9e9e', move_cost: 1, defense: 2 },
  forest: { name: 'Forest', code: 'F', color: '#2e7d32', move_cost: 2, defense: 1 },
  water:  { name: 'Water',  code: 'W', color: '#1976d2', move_cost: 2, defense: 0 },
};

window.Board = (function () {
  const GRID = Algorithms.GRID;

  const key = (r, c) => r + ',' + c;
  const inBounds = (r, c) => r >= 0 && r < GRID && c >= 0 && c < GRID;

  // Build terrain + cities for a seed (deterministic). See algorithms.js.
  function fromSeed(seed) { return Algorithms.generateMap(seed); }

  const typeAt = (terrain, r, c) => terrain[r][c];
  const defAt = (terrain, r, c) => TERRAIN[terrain[r][c]];
  const isWater = (terrain, r, c) => terrain[r][c] === 'water';

  return { GRID, key, inBounds, fromSeed, typeAt, defAt, isWater };
})();
