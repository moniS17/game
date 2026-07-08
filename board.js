/*
 * board.js — terrain definitions and board helpers.
 *
 * Owns the terrain table and small query helpers used by rules.js, render.js
 * and game.js. Map *generation* lives in algorithms.js; this file just wraps
 * it (Board.fromSeed) and provides tile lookups. Board dimensions (Board.ROWS,
 * Board.COLS) are chosen per game and default to the classic 100x100.
 *
 *   move_cost - movement points to ENTER the tile (see rules.js for the
 *               extra water-crossing rules)
 *   defense   - fraction (0..1) of incoming attack damage this tile absorbs
 *   attack_penalty - fraction (0..1) cut from the damage units on this tile DEAL
 *               (a village debuffs attackers, its defense buffs defenders)
 */
window.TERRAIN = {
  plains:  { name: 'Plains',  code: '.', color: '#a39f5c', move_cost: 1, defense: 0 },
  city:    { name: 'City',    code: 'C', color: '#9e9e9e', move_cost: 1, defense: 0 },
  village: { name: 'Village', code: 'V', color: '#caa16a', move_cost: 1, defense: 0.3, attack_penalty: 0.2 },
  forest:  { name: 'Forest',  code: 'F', color: '#2e7d32', move_cost: 1, defense: 0.15 },
  water:   { name: 'Water',   code: 'W', color: '#66CCFF', move_cost: 2, defense: 0 },
};

window.Board = (function () {
  // Board dimensions are chosen per game (see the setup screen). They default
  // to the classic square 100x100 and can be any size within Algorithms' bounds.
  let ROWS = Algorithms.GRID, COLS = Algorithms.GRID;

  const key = (r, c) => r + ',' + c;
  const inBounds = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;

  function setDims(rows, cols) {
    ROWS = Algorithms.clampDim(rows);
    COLS = Algorithms.clampDim(cols);
  }

  // Deployment-zone width (columns) per side, scaled to board width (17 at 100).
  function zone() { return Math.max(1, Math.min(17, Math.floor(COLS / 3))); }

  // Build terrain + cities for a seed at the current (or given) dimensions.
  function fromSeed(seed, rows, cols) {
    if (rows != null && cols != null) setDims(rows, cols);
    return Algorithms.generateMap(seed, ROWS, COLS);
  }

  const typeAt = (terrain, r, c) => terrain[r][c];
  const defAt = (terrain, r, c) => TERRAIN[terrain[r][c]];
  const isWater = (terrain, r, c) => terrain[r][c] === 'water';

  return {
    key, inBounds, setDims, zone, fromSeed, typeAt, defAt, isWater,
    get ROWS() { return ROWS; }, get COLS() { return COLS; },
  };
})();
