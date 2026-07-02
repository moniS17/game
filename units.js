/*
 * units.js — unit roster, players and economy tuning.
 *
 * This file is intentionally pure data so units can be balanced or added
 * without touching game rules (rules.js), the board (board.js) or rendering
 * (render.js). Add a unit here and it appears in the game, legend and shop.
 *
 * Stats:
 *   hp              - hit points; destroyed at 0
 *   attack          - base damage to an adjacent enemy (modified by rules.js)
 *   movement_speed  - movement points per turn (terrain costs defined in board.js)
 *   cost            - gold to buy from the shop
 *   code            - single character drawn on the board
 *   art             - SVG icon (legend / shop / zoomed board), or null
 */
window.PIECES = {
  pawn: {
    name: 'Pawn', code: 'p', art: 'assets/pawn.svg',
    hp: 30, attack: 20, movement_speed: 2, cost: 1,
  },
  archer: {
    name: 'Archer', code: 'a', art: null,
    hp: 30, attack: 30, movement_speed: 2, cost: 2,
  },
  cavalry: {
    // Formerly the chess "knight": fast and hard-hitting.
    name: 'Cavalry', code: 'c', art: 'assets/cavalry.svg',
    hp: 50, attack: 40, movement_speed: 4, cost: 3,
  },
  artillery: {
    // Glass cannon: huge attack, very slow, expensive.
    name: 'Artillery', code: 'A', art: null,
    hp: 50, attack: 90, movement_speed: 1, cost: 8,
  },
  cannon: {
    // Siege gun: heavy hitter, slow and a touch tougher than artillery.
    name: 'Cannon', code: 'n', art: 'assets/cannon.svg',
    hp: 60, attack: 70, movement_speed: 1, cost: 6,
  },
  tank: {
    // Heavy: high hp and attack, decent speed, most expensive.
    name: 'Tank', code: 't', art: 'assets/tank.svg',
    hp: 120, attack: 80, movement_speed: 3, cost: 9,
  },
};

// Terrain combat modifiers — how well each unit type FIGHTS an enemy standing on
// a given terrain. The multiplier scales that unit's ATK when it attacks a target
// on that tile, and symmetrically when it counterattacks a unit on that tile.
// 1 = no change, <1 = debuff, >1 = bonus; any terrain not listed defaults to 1.
//
// Design intent:
//   tank / cavalry  — heavy & mounted units bog down assaulting cities and water.
//   artillery / cannon — siege guns excel at battering fortified cities.
//   archer          — shoots effectively into forest cover.
//   pawn            — infantry are strong in close urban fighting.
window.TERRAIN_COMBAT = {
  tank:      { city: 0.5, water: 0.5, forest: 0.75 },
  cavalry:   { city: 0.6, water: 0.5, forest: 0.7 },
  artillery: { city: 1.5 },
  cannon:    { city: 1.4 },
  archer:    { forest: 1.25 },
  pawn:      { city: 1.2 },
};

// Players. Player 0 starts on the LEFT, player 1 on the RIGHT.
window.PLAYERS = [  { name: 'Blue', side: 'left',  color: '#1e88e5' },
  { name: 'Red',  side: 'right', color: '#e53935' },
];

// Economy tuning (applied by rules.js).
window.ECONOMY = {
  start: 10,         // gold each player begins with
  base_income: 1,    // gold per round regardless of cities
  city_income: 2,    // extra gold per round for each owned city
};

// In-game unit upgrades (see upgrade.html + game.js). Bought with gold and
// stored in the save, so they only ever apply to the CURRENT game. Each step
// adds `gain` to the stat; cost DOUBLES per step: baseCost * 2^stepsBought
// (so 17, 34, 68, 136, ...).
window.UPGRADES = {
  atk: { label: 'Attack',   gain: 1, baseCost: 17 },
  hp:  { label: 'Health',   gain: 2, baseCost: 17 },
  mov: { label: 'Movement', gain: 1, baseCost: 17 },
};
