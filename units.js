/*
 * units.js — unit roster, players and economy tuning.
 *
 * This file is intentionally pure data so units can be balanced or added
 * without touching game rules (rules.js), the board (board.js) or rendering
 * (render.js). Add a unit here and it appears in the game, legend and shop.
 *
 * Stats are PER SUBUNIT. A board piece is a "template" — a stack of same-type
 * subunits (see rules.js STACK_LIMIT = 25, a 5x5 grid). A template's strength
 * scales with how many subunits it holds: total HP / ATK = sum over its subunits.
 *
 * Stats:
 *   hp              - hit points of ONE subunit; the subunit dies at 0
 *   attack          - base damage ONE subunit deals (modified by rules.js)
 *   movement_speed  - movement points per turn (terrain costs defined in board.js)
 *   cost            - gold to buy one subunit from the shop
 *   code            - single character drawn on the board
 *   art             - SVG icon (legend / shop / zoomed board), or null
 */
window.PIECES = {
  infantry: {
    name: 'Infantry', code: 'i', art: 'assets/pawn.svg',
    hp: 30, attack: 20, movement_speed: 3, cost: 1,
  },
  motorized: {
    // Truck-borne infantry: quick, ranged-value attacker.
    name: 'Motorized', code: 'm', art: 'assets/truck.svg',
    hp: 30, attack: 30, movement_speed: 6, cost: 2,
  },
  cavalry: {
    // Formerly the chess "knight": fast and hard-hitting.
    name: 'Cavalry', code: 'c', art: 'assets/cavalry.svg',
    hp: 50, attack: 40, movement_speed: 4, cost: 3,
  },
  cannon: {
    // Siege gun: heavy hitter, slow.
    name: 'Cannon', code: 'n', art: 'assets/cannon.svg',
    hp: 60, attack: 70, movement_speed: 3, cost: 6,
  },
  tank: {
    // Heavy: high hp and attack, decent speed, most expensive.
    name: 'Tank', code: 't', art: 'assets/tank.svg',
    hp: 120, attack: 80, movement_speed: 6, cost: 9,
  },
};

// Terrain combat modifiers — how well each unit type FIGHTS while standing ON a
// given terrain. The multiplier scales that unit's ATK from the tile it occupies,
// both when it attacks and when it counterattacks (e.g. a unit IN water fights
// weakly, regardless of where its target stands).
// 1 = no change, <1 = debuff, >1 = bonus; any terrain not listed defaults to 1.
//
// Design intent:
//   tank      — overruns open ground but bogs down fighting from a village.
//   cavalry   — mounted units bog down fighting from cities and water.
//   cannon    — siege gun batters from villages; struggles firing from forest/water.
//   motorized — wheeled troops lose bite in forest and while in water.
//   infantry  — foot soldiers hold cities and forest; weak fighting from water.
window.TERRAIN_COMBAT = {
  tank:      { plains: 1.5, city: 0.8, village: 0.8, forest: 0.75, water: 0.5 },
  cavalry:   { city: 0.6, water: 0.5, forest: 0.7 },
  cannon:    { village: 1.2, forest: 0.9, water: 0.5 },
  motorized: { forest: 0.9, water: 0.5 },
  infantry:  { city: 1.05, forest: 1.05, water: 0.65 },
};

// Unit-vs-unit combat modifiers — how well an ATTACKER of one type fights a
// DEFENDER of another type (a rock/paper/scissors layer on top of raw ATK and
// the terrain modifiers above). The multiplier scales the attacker's ATK; it is
// keyed [attackerType][defenderType]. 1 = no change; any pair not listed is 1.
// The defending stack's FRONT unit type is used as the representative target.
//
// Design intent:
//   tank      — crushes infantry, beats cavalry, but is vulnerable to cannon.
//   infantry  — soft vs motorized/cavalry, but storms cannon crews.
//   motorized — outmaneuvers cavalry and overruns cannon.
window.UNIT_COMBAT = {
  tank:      { infantry: 1.2, cavalry: 1.1, cannon: 0.8 },
  infantry:  { motorized: 0.8, cavalry: 0.9, cannon: 1.2 },
  motorized: { cavalry: 1.1, cannon: 1.1 },
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

// HP regeneration (applied by game.js). A unit that did NOT move during its turn
// recovers HP at the start of its next turn. Motorized subunits carry field-repair
// and heal ANYWHERE, scaled by their share of the unit; every other subunit needs
// supply — being near an OWNED city or village. Cavalry/tank units (heavy, longer
// logistics tail) draw supply from farther out. Values are fractions of max HP.
window.REGEN = {
  motor: 0.25,        // fully-motorized unit heals 25% of max HP per idle turn
  supply: 0.2,        // within supply range: +20% of max HP per idle turn
  range:      { city: 3, village: 1 }, // Manhattan tiles for normal units
  heavyRange: { city: 5, village: 2 }, // cavalry / tank reach farther
};

// In-game subunit upgrades (see tech.html + game.js). Bought with gold and
// stored in the save, so they only ever apply to the CURRENT game. Each step
// adds `gain` to the stat; cost DOUBLES per step: baseCost * 2^stepsBought
// (so 17, 34, 68, 136, ...).
window.UPGRADES = {
  atk: { label: 'Attack',   gain: 1, baseCost: 17 },
  hp:  { label: 'Health',   gain: 2, baseCost: 17 },
  mov: { label: 'Movement', gain: 1, baseCost: 17 },
};

// Economy upgrades — raise a player's gold income for THIS game only (per-player,
// stored in the save as ecoUpgrades). Each level adds +1 gold; cost DOUBLES per
// step (baseCost * 2^stepsBought), like UPGRADES. Passive (flat, every round) is
// the dearest, then per-owned-city, then per-owned-village (cheapest).
window.ECO_UPGRADES = {
  passive: { label: 'Passive income', desc: 'gold every round',    gain: 1, baseCost: 30 },
  city:    { label: 'City income',    desc: 'per owned city',      gain: 1, baseCost: 20 },
  village: { label: 'Village income', desc: 'per owned village',   gain: 1, baseCost: 12 },
};

// Tech tree — gold cost to UNLOCK each unit type for the current game (see
// tech.html + game.js Game.unlocked). Infantry is free and unlocked from the
// start; every other type must be researched before it can be bought, built
// into a template, or upgraded. Unlocks are per-player and per-game (in the save).
window.TECH = {
  infantry:  0,
  motorized: 12,
  cavalry:   18,
  cannon:    24,
  tank:      40,
};
