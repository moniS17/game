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
    hp: 3, attack: 2, movement_speed: 2, cost: 1,
  },
  archer: {
    name: 'Archer', code: 'a', art: null,
    hp: 3, attack: 3, movement_speed: 2, cost: 2,
  },
  cavalry: {
    // Formerly the chess "knight": fast and hard-hitting.
    name: 'Cavalry', code: 'c', art: 'assets/cavalry.svg',
    hp: 5, attack: 4, movement_speed: 4, cost: 3,
  },
  artillery: {
    // Glass cannon: huge attack, very slow, expensive.
    name: 'Artillery', code: 'A', art: null,
    hp: 5, attack: 9, movement_speed: 1, cost: 8,
  },
  cannon: {
    // Siege gun: heavy hitter, slow and a touch tougher than artillery.
    name: 'Cannon', code: 'n', art: 'assets/cannon.svg',
    hp: 6, attack: 7, movement_speed: 1, cost: 6,
  },
  tank: {
    // Heavy: high hp and attack, decent speed, most expensive.
    name: 'Tank', code: 't', art: 'assets/tank.svg',
    hp: 12, attack: 8, movement_speed: 3, cost: 9,
  },
};

// Players. Player 0 starts on the LEFT, player 1 on the RIGHT.
window.PLAYERS = [
  { name: 'Blue', side: 'left',  color: '#1e88e5' },
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
// adds `gain` to the stat; the next step costs baseCost * (stepsBought + 1).
window.UPGRADES = {
  atk: { label: 'Attack',   gain: 1, baseCost: 3 },
  hp:  { label: 'Health',   gain: 2, baseCost: 3 },
  mov: { label: 'Movement', gain: 1, baseCost: 4 },
};
