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
 * SCALE: hp, attack, cost and every GOLD amount are kept as WHOLE numbers scaled
 * ×10 (not floats), so percentage modifiers — terrain/matchup combat multipliers
 * and the PvE difficulty income buffs — round to meaningful whole values instead
 * of vanishing (e.g. +10% of 20 gold = +2, where +10% of 2 would round to 0).
 * Movement is NOT scaled: it carries no percentage modifiers and shares the
 * terrain move-cost scale in board.js.
 *
 * Stats:
 *   hp              - hit points of ONE subunit (×10); the subunit dies at 0
 *   attack          - base damage ONE subunit deals (×10; modified by rules.js)
 *   movement_speed  - movement points per turn (terrain costs defined in board.js)
 *   cost            - gold to buy one subunit from the shop (×10)
 *   code            - single character drawn on the board
 *   art             - SVG icon (legend / shop / zoomed board), or null
 */
window.PIECES = {
  infantry: {
    name: 'Infantry', code: 'i', art: 'assets/pawn.svg',
    hp: 10, attack: 10, movement_speed: 3, cost: 10,
  },
  motorized: {
    // Truck-borne infantry: quick, ranged-value attacker.
    name: 'Motorized', code: 'm', art: 'assets/truck.svg',
    hp: 20, attack: 20, movement_speed: 6, cost: 50,
  },
  cavalry: {
    // Formerly the chess "knight": fast and hard-hitting.
    name: 'Cavalry', code: 'c', art: 'assets/cavalry.svg',
    hp: 10, attack: 20, movement_speed: 4, cost: 30,
  },
  cannon: {
    // Siege gun: heavy hitter, slow.
    name: 'Cannon', code: 'n', art: 'assets/cannon.svg',
    hp: 10, attack: 30, movement_speed: 3, cost: 40,
  },
  tank: {
    // Heavy: high hp and attack, decent speed, most expensive.
    name: 'Tank', code: 't', art: 'assets/tank.svg',
    hp: 30, attack: 30, movement_speed: 6, cost: 100,
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
  cannon:    { tank: 1.4 },
};

// Players. Player 0 starts on the LEFT, player 1 on the RIGHT.
window.PLAYERS = [  { name: 'Blue', side: 'left',  color: '#00acc1' },
  { name: 'Red',  side: 'right', color: '#e53935' },
];

// Economy tuning (applied by rules.js). Gold amounts are scaled ×10 (see PIECES).
window.ECONOMY = {
  start: 100,        // gold each player begins with
  base_income: 10,   // gold per round regardless of cities
  city_income: 20,   // extra gold per round for each owned city
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
// (so 170, 340, 680, ...). Gold and combat stats are ×10-scaled (see PIECES);
// movement is not, so its gain stays 1.
window.UPGRADES = {
  atk: { label: 'Attack',   gain: 10, baseCost: 170 },
  hp:  { label: 'Health',   gain: 20, baseCost: 170 },
  mov: { label: 'Movement', gain: 1,  baseCost: 170 },
};

// Economy upgrades — raise a player's gold income for THIS game only (per-player,
// stored in the save as ecoUpgrades). Each level adds `gain` gold; cost DOUBLES
// per step (baseCost * 2^stepsBought), like UPGRADES. Passive (flat, every round)
// is the dearest, then per-owned-city, then per-owned-village (cheapest).
window.ECO_UPGRADES = {
  passive: { label: 'Passive income', desc: 'gold every round',    gain: 10, baseCost: 300 },
  city:    { label: 'City income',    desc: 'per owned city',      gain: 10, baseCost: 200 },
  village: { label: 'Village income', desc: 'per owned village',   gain: 10, baseCost: 120 },
};

// Tech tree — gold cost to UNLOCK each unit type for the current game (see
// tech.html + game.js Game.unlocked). Infantry is free and unlocked from the
// start; every other type must be researched before it can be bought, built
// into a template, or upgraded. Unlocks are per-player and per-game (in the save).
window.TECH = {
  infantry:  0,
  motorized: 60,
  cavalry:   30,
  cannon:    50,
  tank:      100,
};

// Gold icon markup — a drawn coin standing in for a "$" everywhere gold is shown.
// Sized in `em` so it scales with the surrounding text.
window.GOLD_ICON = '<img src="assets/gold.svg" alt="gold" class="gold-coin" ' +
  'style="width:1em;height:1em;vertical-align:-0.15em;">';

// Buildable structures — placed on tiles by players, captured on enemy movement.
// Fort: reduces incoming damage to the defender by `defense` fraction.
// Supply hub: extends the supply network for healing / refit (village-range).
window.STRUCTURES = {
  fort:   { name: 'Fort',       cost: 1,  defense: 0.1, art: 'assets/fort.svg' },
  supply: { name: 'Supply Hub', cost: 10, art: 'assets/supply.svg' },
};
