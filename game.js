/*
 * game.js — game state, turns, economy, AI, persistence and input wiring.
 *
 * This is the orchestrator. It owns the live Game state and connects the
 * separated modules:
 *   units.js      - unit / player / economy data
 *   board.js      - terrain + board helpers
 *   algorithms.js - map generation
 *   rules.js      - movement & combat rules (no rules live here)
 *   render.js     - all canvas drawing
 *   state.js      - localStorage persistence
 * The page (index.html) provides the UI object.
 *
 * STACKING MODEL
 *   Many units of the same owner may share a tile. `Game.unitAt` maps
 *   "r,c" -> Unit[] (a "template", capped at Rules.STACK_LIMIT = 17). Units move
 *   and fight as a selected GROUP chosen from one tile (whole stack, or a
 *   checkbox-picked subset). Bought units are placed by the player into their
 *   own deployment zone. Combat is mutual (see rules.js).
 */

const key = Board.key;
const inBounds = Board.inBounds;
// Board dimensions and deployment-zone width are dynamic (chosen per game).
const COLS = () => Board.COLS;
const ROWS = () => Board.ROWS;
const ZONE = () => Board.zone(); // each player deploys within their own zone columns

// ---------------------------------------------------------------------------
// Runtime game state
// ---------------------------------------------------------------------------
const Game = {
  seed: 0,
  mode: 'pvp',          // 'pvp' | 'pve' (pve: Game.aiPlayer is controlled by the AI)
  terrain: [],
  cities: [],           // [{r, c, owner}]  owner: 0 | 1 | null (neutral)
  villages: [],         // [{r, c, owner}]  capturable; each pays 50% of a city
  structures: [],       // [{type, r, c, owner}]  fort / supply hub — built by players
  units: [],            // Unit[] — board pieces built from templates (see makeUnitFromTemplate)
  unitAt: new Map(),    // "r,c" -> Unit[]  (a stack, all same owner)
  territory: [],        // ROWS×COLS grid of 0 | 1 | null — which player owns each tile's colour

  economy: [0, 0],
  incomeMult: [1, 1],   // per-player income multiplier from PvE difficulty (see buildInitialState)
  difficulty: 'normal', // pve: 'easy' | 'normal' | 'hard'
  turn: 0,
  round: 1,
  selTile: null,        // {r, c} currently inspected, or null
  selUnits: [],         // units chosen from selTile (whole stack or a subset)
  selectAll: true,      // "select whole stack" toggle
  reachable: new Map(), // "r,c" -> remaining moves for the selected group
  toPlace: [],          // [{templateId, owner}] bought units awaiting deployment
  upgrades: [{}, {}],   // per-player, per-subunit-type upgrade steps: {infantry:{atk,hp,mov}}
  unlocked: [{ infantry: true }, { infantry: true }], // tech tree: subunits each player has researched
  templates: [[], []],  // per-player library of blueprints: {id, name, cells:[type|null ×25]}
  creative: false,      // creative mode: enables the in-game "+gold" cheat button
  aiPlayer: 1,          // pve: which side (0/1) the AI controls; null in pvp
  // Elimination is not instant: a side must be wiped out (no units, or no owned
  // cities) for LOSE_TURNS consecutive turn hand-offs before it loses, giving it
  // a window to reinforce. These count consecutive turns spent fully eliminated.
  noUnitTurns: [0, 0],
  noCityTurns: [0, 0],
  winner: null,
  winReason: null,
  // Order queue: queued move/attack orders from multiple tiles, executed together.
  orderQueue: [],       // [{id, group, sourceTile, destTile, path, isAttack, attackTarget}]
};
let nextOrderId = 1;
let nextId = 1;
// Consecutive eliminated turns a side must endure before it loses (see checkWinner).
const LOSE_TURNS = 3;
const LOSE_CITY_TURNS = 7; // 3 full player-turns of grace before city-loss defeat

// Upgrade tuning lives in units.js (window.UPGRADES) so the shop/upgrade pages
// share one source of truth. Steps are stored per-player in the save.
const UPGRADE = UPGRADES;
// Steps of `stat` bought for `owner`'s `type` so far (0 if none).
function upgradeSteps(owner, type, stat) {
  const u = Game.upgrades[owner] && Game.upgrades[owner][type];
  return (u && u[stat]) || 0;
}
// Cost of the NEXT step (doubles per step: baseCost * 2^steps).
function upgradeCost(owner, type, stat) {
  return UPGRADE[stat].baseCost * Math.pow(2, upgradeSteps(owner, type, stat));
}
// Bonus fields a freshly-created unit should carry, given its owner's upgrades.
function upgradeBonuses(owner, type) {
  return {
    atkBonus: upgradeSteps(owner, type, 'atk') * UPGRADE.atk.gain,
    movBonus: upgradeSteps(owner, type, 'mov') * UPGRADE.mov.gain,
    hpBonus:  upgradeSteps(owner, type, 'hp') * UPGRADE.hp.gain,
  };
}

// ---------------------------------------------------------------------------
// Tech tree — which unit types a player has unlocked this game (units.js TECH).
// Infantry is always unlocked; other types must be researched with gold.
// ---------------------------------------------------------------------------
function isUnlocked(owner, type) {
  return type === 'infantry' || !!(Game.unlocked[owner] && Game.unlocked[owner][type]);
}
// Spend gold to unlock `type` for `owner`. Returns true on success.
function unlockType(owner, type) {
  if (isUnlocked(owner, type)) return false;
  const cost = (typeof TECH !== 'undefined' && TECH[type]) || 0;
  if (Game.economy[owner] < cost) return false;
  Game.economy[owner] -= cost;
  Game.unlocked[owner] = Game.unlocked[owner] || {};
  Game.unlocked[owner][type] = true;
  upgradeHqTemplate(owner, type);
  persist();
  return true;
}

function upgradeHqTemplate(owner, type) {
  const hqTmpl = (Game.templates[owner] || []).find(t => t.isHq);
  if (!hqTmpl) return;
  const empty = hqTmpl.cells.indexOf(null);
  if (empty >= 0) hqTmpl.cells[empty] = type;
  const hqUnit = Game.units.find(u => u.owner === owner && isHqUnit(u));
  if (hqUnit) {
    const s = templateStats(owner, hqTmpl);
    hqUnit.parts = s.parts;
    const ratio = hqUnit.maxHp > 0 ? hqUnit.hp / hqUnit.maxHp : 1;
    hqUnit.maxHp = s.maxHp;
    hqUnit.hp = Math.max(1, Math.round(s.maxHp * ratio));
    hqUnit.mov = s.mov;
    hqUnit.type = s.primary;
  }
}

// ---------------------------------------------------------------------------
// Templates — reusable 5x5 blueprints of subunits. A UNIT is built from one.
// A template is { id, name, cells:[subunitType|null ×25] }. Its cost/HP/ATK/MOV
// are the aggregate of its subunits (subunit stats from units.js PIECES, plus
// the owner's per-type upgrades snapshotted at build time).
// ---------------------------------------------------------------------------
const TEMPLATE_CELLS = 25; // 5x5

// Count subunits per type in a template's cells -> {type: count}.
function templateComp(tmpl) {
  const comp = {};
  for (const t of (tmpl.cells || [])) if (t) comp[t] = (comp[t] || 0) + 1;
  return comp;
}
// Total subunits placed in a template.
function templateSize(tmpl) {
  let n = 0; for (const t of (tmpl.cells || [])) if (t) n++; return n;
}
// Per-type effective subunit stats for `owner` (base + upgrades).
function subunitEff(owner, type) {
  const d = PIECES[type];
  return {
    atk: d.attack + upgradeSteps(owner, type, 'atk') * UPGRADE.atk.gain,
    hp:  d.hp + upgradeSteps(owner, type, 'hp') * UPGRADE.hp.gain,
    mov: d.movement_speed + upgradeSteps(owner, type, 'mov') * UPGRADE.mov.gain,
  };
}
// Gold cost of one unit built from `tmpl` = sum of its subunits' base costs.
function templateCost(owner, tmpl) {
  let c = 0;
  for (const t of (tmpl.cells || [])) if (t) c += PIECES[t].cost;
  return c;
}
// Aggregate stats of a unit built from `tmpl` by `owner`.
function templateStats(owner, tmpl) {
  const comp = templateComp(tmpl);
  let maxHp = 0, atk = 0, mov = Infinity;
  const parts = [];
  for (const type in comp) {
    const e = subunitEff(owner, type), count = comp[type];
    parts.push({ type, count, atk: e.atk, hp: e.hp, mov: e.mov });
    maxHp += count * e.hp;
    atk += count * e.atk;
    mov = Math.min(mov, e.mov);
  }
  if (!isFinite(mov)) mov = 0;
  // Primary subunit (drawn on the board): most numerous, ties broken by cost.
  let primary = null, best = -1;
  for (const type in comp) {
    const score = comp[type] * 100 + PIECES[type].cost;
    if (score > best) { best = score; primary = type; }
  }
  return { parts, maxHp, atk, mov, primary, cost: templateCost(owner, tmpl), size: templateSize(tmpl) };
}
// Build a board unit from a template. Returns null for an empty template.
function makeUnitFromTemplate(owner, tmpl, r, c, opts) {
  const s = templateStats(owner, tmpl);
  if (!s.size) return null;
  const o = opts || {};
  return {
    id: nextId++, owner, r, c,
    templateId: tmpl.id, name: tmpl.name, type: s.primary, parts: s.parts,
    hp: s.maxHp, maxHp: s.maxHp, mov: s.mov,
    movesLeft: o.movesLeft != null ? o.movesLeft : s.mov,
    acted: !!o.acted, moved: false,
  };
}
// A player's default starting template library: one "Infantry" template (4 bodies).
function defaultTemplates() {
  const cells = new Array(TEMPLATE_CELLS).fill(null);
  for (let i = 0; i < 4; i++) cells[i] = 'infantry';
  return [{ id: 't1', name: 'Infantry', cells }];
}
function findTemplate(owner, id) {
  return (Game.templates[owner] || []).find((t) => t.id === id) || null;
}

function makeHqTemplate() {
  const cells = new Array(TEMPLATE_CELLS).fill(null);
  cells[0] = 'infantry';
  return { id: 'hq', name: 'HQ', cells, isHq: true };
}

function isHqUnit(u) {
  return u && u.templateId === 'hq';
}

// ---------------------------------------------------------------------------
// Stack helpers — keep Game.unitAt (a Map of arrays) in sync with Game.units
// ---------------------------------------------------------------------------
function stackAt(r, c) { return Game.unitAt.get(key(r, c)) || []; }
function addToStack(u) {
  const k = key(u.r, u.c);
  let s = Game.unitAt.get(k);
  if (!s) { s = []; Game.unitAt.set(k, s); }
  s.push(u);
}
function removeFromStack(u) {
  const k = key(u.r, u.c);
  const s = Game.unitAt.get(k);
  if (!s) return;
  const i = s.indexOf(u);
  if (i >= 0) s.splice(i, 1);
  if (!s.length) Game.unitAt.delete(k);
}
function rebuildUnitAt() {
  Game.unitAt = new Map();
  for (const u of Game.units) addToStack(u);
}

// Placement-zone test for a column (Blue left 17, Red right 17).
function inZone(owner, c) { return owner === 0 ? c < ZONE() : c >= COLS() - ZONE(); }

// ---------------------------------------------------------------------------
// Territory — a per-tile ownership grid (0 | 1 | null) painted in each player's
// colour. Each side's deployment zone starts claimed; moving units paint their
// path and destination, and deploying claims the drop tile. Combat uses it for
// the "surrounded by enemy colour" double-damage rule (rules.js).
// ---------------------------------------------------------------------------
function buildInitialTerritory(rows, cols) {
  const zone = Board.zone();
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols).fill(null);
    for (let c = 0; c < cols; c++) {
      if (c < zone) row[c] = 0;
      else if (c >= cols - zone) row[c] = 1;
    }
    grid.push(row);
  }
  return grid;
}
function claimTile(r, c, owner) {
  if (!inBounds(r, c)) return;
  if (!Game.territory[r]) Game.territory[r] = new Array(COLS()).fill(null);
  Game.territory[r][c] = owner;
}
// Compact save form: one string per row, chars '0' | '1' | '.' (neutral).
function serializeTerritory() {
  return (Game.territory || []).map((row) =>
    row.map((v) => (v === 0 ? '0' : v === 1 ? '1' : '.')).join(''));
}
function deserializeTerritory(rows, cols, data) {
  if (!Array.isArray(data) || data.length !== rows) return buildInitialTerritory(rows, cols);
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const s = data[r] || '';
    const row = new Array(cols).fill(null);
    for (let c = 0; c < cols; c++) row[c] = s[c] === '0' ? 0 : s[c] === '1' ? 1 : null;
    grid.push(row);
  }
  return grid;
}
// Paint every tile on the optimal path start->dest (inclusive) for `owner`,
// reconstructed by walking back through the reachable-budget map used for the
// move (`Game.reachable`). Robust: if a predecessor can't be resolved it stops
// early, but the destination is always claimed by moveGroup.
// Reconstruct the shortest path from (sr,sc) to (dr,dc) using the reachable
// budget map. Returns an array of {r,c} from start to dest (inclusive).
function getPath(sr, sc, dr, dc, startBudget) {
  const reach = Game.reachable;
  const k = (r, c) => r + ',' + c;
  const path = [{ r: dr, c: dc }];
  let cr = dr, cc = dc, guard = 0;
  while (!(cr === sr && cc === sc) && guard++ < 100000) {
    const cur = reach.has(k(cr, cc)) ? reach.get(k(cr, cc)) : startBudget;
    const cost = TERRAIN[Game.terrain[cr][cc]].move_cost;
    let prev = null;
    const hexNeighbors = Rules.neighbors(cr, cc);
    for (const [pr, pc] of hexNeighbors) {
      if (!inBounds(pr, pc)) continue;
      if (!Rules.canStep(Game.terrain, pr, pc, cr, cc)) continue;
      const isStart = pr === sr && pc === sc;
      const pv = isStart ? startBudget : (reach.has(k(pr, pc)) ? reach.get(k(pr, pc)) : null);
      if (pv == null) continue;
      if (pv - cost === cur) { prev = [pr, pc]; if (isStart) break; }
    }
    if (!prev) break;
    cr = prev[0]; cc = prev[1];
    path.push({ r: cr, c: cc });
  }
  path.reverse();
  return path;
}

// Find ALL distinct shortest paths from (sr,sc) to (dr,dc). Kept for AI use.
function findAllPaths(sr, sc, dr, dc, startBudget) {
  const reach = Game.reachable;
  const k = (r, c) => r + ',' + c;
  // Work backwards from dest; each partial is [currentR, currentC, reversedPathSoFar].
  let partials = [[dr, dc, [{ r: dr, c: dc }]]];
  const results = [];
  let guard = 0;
  while (partials.length && guard++ < 50000) {
    const next = [];
    for (const [cr, cc, rpath] of partials) {
      if (cr === sr && cc === sc) { results.push(rpath.slice().reverse()); continue; }
      const cur = reach.has(k(cr, cc)) ? reach.get(k(cr, cc)) : startBudget;
      const cost = TERRAIN[Game.terrain[cr][cc]].move_cost;
      const hexNeighbors = Rules.neighbors(cr, cc);
      for (const [pr, pc] of hexNeighbors) {
        if (!inBounds(pr, pc)) continue;
        if (!Rules.canStep(Game.terrain, pr, pc, cr, cc)) continue;
        const isStart = pr === sr && pc === sc;
        const pv = isStart ? startBudget : (reach.has(k(pr, pc)) ? reach.get(k(pr, pc)) : null);
        if (pv == null) continue;
        if (pv - cost === cur) next.push([pr, pc, [...rpath, { r: pr, c: pc }]]);
      }
    }
    partials = next;
    if (results.length > 200) break;
  }
  return results;
}

function claimPath(owner, sr, sc, dr, dc, startBudget) {
  const path = getPath(sr, sc, dr, dc, startBudget);
  for (const p of path) claimTile(p.r, p.c, owner);
}

// How many units the player-to-move still has to deploy.
function pendingForTurn() { return Game.toPlace.filter((s) => s.owner === Game.turn).length; }
function inPlacement() { return pendingForTurn() > 0; }

// ---------------------------------------------------------------------------
// State (de)serialization — bridges localStorage and the runtime Game
// ---------------------------------------------------------------------------
function serialize() {
  const out = {
    seed: Game.seed,
    rows: Board.ROWS,
    cols: Board.COLS,
    mode: Game.mode,
    turn: Game.turn,
    round: Game.round,
    creative: Game.creative,
    aiPlayer: Game.aiPlayer,
    difficulty: Game.difficulty,
    incomeMult: (Game.incomeMult || [1, 1]).slice(),
    noUnitTurns: (Game.noUnitTurns || [0, 0]).slice(),
    noCityTurns: (Game.noCityTurns || [0, 0]).slice(),
    economy: Game.economy.slice(),
    cities: Game.cities.map((c) => ({ r: c.r, c: c.c, owner: c.owner })),
    villages: Game.villages.map((v) => ({ r: v.r, c: v.c, owner: v.owner })),
    structures: Game.structures.map((s) => ({ type: s.type, r: s.r, c: s.c, owner: s.owner })),
    territory: serializeTerritory(),
    units: Game.units.map((u) => ({
      id: u.id, owner: u.owner, r: u.r, c: u.c,
      templateId: u.templateId, name: u.name, type: u.type,
      parts: (u.parts || []).map((p) => ({ type: p.type, count: p.count, atk: p.atk, hp: p.hp, mov: p.mov })),
      hp: u.hp, maxHp: u.maxHp, mov: u.mov, movesLeft: u.movesLeft, acted: u.acted, moved: !!u.moved,
    })),
    toPlace: Game.toPlace.slice(),
    upgrades: [ { ...Game.upgrades[0] }, { ...Game.upgrades[1] } ],
    ecoUpgrades: [ { ...Game.ecoUpgrades[0] }, { ...Game.ecoUpgrades[1] } ],
    unlocked: [ { ...Game.unlocked[0] }, { ...Game.unlocked[1] } ],
    templates: [ (Game.templates[0] || []).map(cloneTemplate), (Game.templates[1] || []).map(cloneTemplate) ],
    pendingSpawns: [],
  };
  if (Game.customTerrain) out.customTerrain = Game.terrain.map(row => row.slice());
  return out;
}
function cloneTemplate(t) { const c = { id: t.id, name: t.name, cells: (t.cells || []).slice() }; if (t.isHq) c.isHq = true; return c; }

// Normalize a saved unit into the composite shape. New saves already have
// `parts`; a legacy single-type unit is turned into a 1-subunit unit.
function migrateUnit(u) {
  if (u.parts && u.parts.length) {
    return { id: u.id, owner: u.owner, r: u.r, c: u.c, templateId: u.templateId,
      name: u.name || (PIECES[u.type] ? PIECES[u.type].name : 'Unit'), type: u.type,
      parts: u.parts.map((p) => ({ ...p })),
      hp: u.hp, maxHp: u.maxHp, mov: u.mov != null ? u.mov : u.movesLeft, movesLeft: u.movesLeft, acted: !!u.acted, moved: !!u.moved };
  }
  const d = PIECES[u.type] || PIECES.infantry;
  const atk = d.attack + (u.atkBonus || 0);
  const mov = d.movement_speed + (u.movBonus || 0);
  const hp = u.maxHp || d.hp;
  return { id: u.id, owner: u.owner, r: u.r, c: u.c, templateId: null,
    name: d.name, type: u.type in PIECES ? u.type : 'infantry',
    parts: [{ type: u.type in PIECES ? u.type : 'infantry', count: 1, atk, hp, mov }],
    hp: u.hp != null ? u.hp : hp, maxHp: hp, mov, movesLeft: u.movesLeft || 0, acted: !!u.acted, moved: !!u.moved };
}
function persist() { SaveState.save(serialize()); }

// Build a brand-new game for the given mode, seed and board size.
function buildInitialState(mode, seed, rows, cols, creative, startPlayer, aiPlayer, difficulty, startUnits, randomStart) {
  const { terrain, cities, villages } = Board.fromSeed(seed, rows || Algorithms.GRID, cols || Algorithms.GRID);
  const templates = [defaultTemplates(), defaultTemplates()];
  templates[0].push(makeHqTemplate());
  templates[1].push(makeHqTemplate());
  const count = (startUnits != null && startUnits >= 0) ? startUnits : 1;
  const units = buildInitialArmies(terrain, templates, count, randomStart !== false, seed);
  const ai = mode === 'pve' ? ((aiPlayer === 0 || aiPlayer === 1) ? aiPlayer : 1) : null;
  // PvE difficulty tunes AI gold: AI starts with 170 gold and its per-round
  // income is scaled by difficulty — hard 1.7×, normal 1×, easy 0.17×.
  const diff = (difficulty === 'easy' || difficulty === 'hard') ? difficulty : 'normal';
  const incomeMult = [1, 1];
  if (ai !== null) {
    if (diff === 'easy') incomeMult[ai] = 0.17;
    else if (diff === 'hard') incomeMult[ai] = 1.7;
  }
  const startGold = [ECONOMY.start, ECONOMY.start];
  if (ai !== null) startGold[ai] = 170;
  return {
    seed, mode, rows: Board.ROWS, cols: Board.COLS,
    turn: startPlayer === 1 ? 1 : 0, round: 1,
    creative: !!creative, aiPlayer: ai,
    difficulty: diff, incomeMult,
    noUnitTurns: [0, 0], noCityTurns: [0, 0],
    economy: startGold,
    territory: buildInitialTerritory(Board.ROWS, Board.COLS)
      .map((row) => row.map((v) => (v === 0 ? '0' : v === 1 ? '1' : '.')).join('')),
    cities, villages: villages || [], structures: [], units, toPlace: [], upgrades: [{}, {}],
    unlocked: [{ infantry: true }, { infantry: true }],
    ecoUpgrades: [{}, {}],
    templates, pendingSpawns: [],
  };
}

function buildCustomMapState(mode, customMap, creative, startPlayer, aiPlayer, difficulty) {
  const rows = customMap.rows, cols = customMap.cols;
  Board.setDims(rows, cols);
  const diff = (difficulty === 'easy' || difficulty === 'hard') ? difficulty : 'normal';
  const ai = mode === 'pve' ? ((aiPlayer === 0 || aiPlayer === 1) ? aiPlayer : 1) : null;
  const incomeMult = [1, 1];
  if (ai !== null) {
    if (diff === 'easy') incomeMult[ai] = 0.17;
    else if (diff === 'hard') incomeMult[ai] = 1.7;
  }
  const templates = [defaultTemplates(), defaultTemplates()];
  templates[0].push(makeHqTemplate());
  templates[1].push(makeHqTemplate());
  const allUnlocked = {};
  for (const k in PIECES) allUnlocked[k] = true;
  const cities = (customMap.cities || []).map(c => ({ ...c }));
  const villages = (customMap.villages || []).map(v => ({ ...v }));
  const terrain = customMap.terrain || [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = terrain[r] && terrain[r][c];
      if (t === 'city' && !cities.some(ci => ci.r === r && ci.c === c)) {
        cities.push({ r, c, owner: null });
      }
      if (t === 'village' && !villages.some(v => v.r === r && v.c === c)) {
        villages.push({ r, c, owner: null });
      }
    }
  }
  const third = Math.floor(cols / 3);
  for (const s of cities.concat(villages)) {
    if (s.c < third) s.owner = 0;
    else if (s.c >= cols - third) s.owner = 1;
    else if (s.owner == null) s.owner = null;
  }
  return {
    seed: 0, mode, rows, cols,
    turn: startPlayer === 1 ? 1 : 0, round: 1,
    creative: !!creative, aiPlayer: ai,
    difficulty: diff, incomeMult,
    noUnitTurns: [0, 0], noCityTurns: [0, 0],
    economy: (() => { const e = (customMap.economy || [ECONOMY.start, ECONOMY.start]).slice(); if (ai !== null) e[ai] = Math.max(e[ai], 170); return e; })(),
    territory: buildInitialTerritory(rows, cols)
      .map((row) => row.map((v) => (v === 0 ? '0' : v === 1 ? '1' : '.')).join('')),
    cities, villages,
    structures: [], units: (customMap.units || []).map((u, i) => ({ ...u, id: i + 1 })),
    toPlace: [], upgrades: [{}, {}],
    unlocked: [{ ...allUnlocked }, { ...allUnlocked }],
    ecoUpgrades: [{}, {}],
    templates, pendingSpawns: [],
    customTerrain: customMap.terrain,
  };
}

// Seed each player's starting force. `count` units per side, placed either
// randomly in the spawn zone or evenly spaced along the zone line closest to
// the board center. Each unit uses the default Infantry template.
function buildInitialArmies(terrain, templates, count, randomStart, seed) {
  if (!count || count <= 0) return [];
  const units = [];
  const dry = (r, c) => inBounds(r, c) && terrain[r][c] !== 'water';

  const rows = Board.ROWS, cols = Board.COLS, zone = Board.zone();
  const stackLimit = typeof Rules !== 'undefined' ? Rules.STACK_LIMIT : 17;

  if (randomStart) {
    // Seeded PRNG for deterministic random placement.
    let s = ((seed || 0) ^ 0x5f3759df) >>> 0;
    const rng = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

    for (let owner = 0; owner < 2; owner++) {
      const tmpl = templates[owner][0];
      const c0 = owner === 0 ? 0 : cols - zone;
      const c1 = owner === 0 ? zone : cols;
      // Collect all dry tiles in this owner's spawn zone.
      const candidates = [];
      for (let r = 0; r < rows; r++)
        for (let c = c0; c < c1; c++)
          if (dry(r, c)) candidates.push({ r, c });
      // Shuffle candidates.
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      // Place units, respecting stack limit per tile.
      const placed = new Map();
      let idx = 0;
      for (let n = 0; n < count && idx < candidates.length; ) {
        const spot = candidates[idx % candidates.length];
        const k = spot.r + ',' + spot.c;
        const cur = placed.get(k) || 0;
        if (cur >= stackLimit) { idx++; continue; }
        const u = makeUnitFromTemplate(owner, tmpl, spot.r, spot.c, { acted: false });
        if (u) { units.push(u); placed.set(k, cur + 1); n++; }
        idx++;
      }
    }
  } else {
    // Even placement: line up units along the spawn-zone column closest to center.
    for (let owner = 0; owner < 2; owner++) {
      const tmpl = templates[owner][0];
      const spawnCol = owner === 0 ? zone - 1 : cols - zone;
      // Collect dry tiles on that column in row order.
      const candidates = [];
      for (let r = 0; r < rows; r++)
        if (dry(r, spawnCol)) candidates.push({ r, c: spawnCol });
      if (!candidates.length) continue;
      // Distribute `count` units evenly across the available tiles.
      const n = Math.min(count, candidates.length * stackLimit);
      for (let i = 0; i < n; i++) {
        const idx = candidates.length <= n
          ? i % candidates.length
          : Math.round(i * (candidates.length - 1) / (n - 1 || 1));
        const spot = candidates[idx];
        const unit = makeUnitFromTemplate(owner, tmpl, spot.r, spot.c, { acted: false });
        if (unit) units.push(unit);
      }
    }
  }
  // Place 1 HQ per side near the center of their deployment zone.
  for (let owner = 0; owner < 2; owner++) {
    const hqTmpl = templates[owner].find(t => t.isHq) || makeHqTemplate();
    const spawnCol = owner === 0 ? Math.floor(zone / 2) : cols - Math.floor(zone / 2) - 1;
    const midRow = Math.floor(rows / 2);
    let placed = false;
    for (let dr = 0; dr <= rows; dr++) {
      for (const rr of [midRow + dr, midRow - dr]) {
        if (rr < 0 || rr >= rows || !dry(rr, spawnCol)) continue;
        const s = units.filter(u => u.r === rr && u.c === spawnCol);
        if (s.length >= stackLimit) continue;
        const hq = makeUnitFromTemplate(owner, hqTmpl, rr, spawnCol, { acted: false });
        if (hq) { units.push(hq); placed = true; }
        break;
      }
      if (placed) break;
    }
  }
  return units;
}

// Load a saved state object into the live Game (regenerating the map).
function loadIntoGame(st) {
  Game.seed = st.seed;
  Game.mode = st.mode || 'pvp';
  Game.aiPlayer = (st.aiPlayer === 0 || st.aiPlayer === 1) ? st.aiPlayer : (Game.mode === 'pve' ? 1 : null);
  Game.creative = !!st.creative;
  Game.difficulty = (st.difficulty === 'easy' || st.difficulty === 'hard') ? st.difficulty : 'normal';
  Game.incomeMult = (Array.isArray(st.incomeMult) && st.incomeMult.length === 2)
    ? st.incomeMult.slice() : [1, 1];
  Game.noUnitTurns = (Array.isArray(st.noUnitTurns) && st.noUnitTurns.length === 2)
    ? st.noUnitTurns.slice() : [0, 0];
  Game.noCityTurns = (Array.isArray(st.noCityTurns) && st.noCityTurns.length === 2)
    ? st.noCityTurns.slice() : [0, 0];
  // Restore board: use custom terrain if present, otherwise regenerate from seed.
  if (st.customTerrain && Array.isArray(st.customTerrain)) {
    Board.setDims(st.rows, st.cols);
    Game.terrain = st.customTerrain.map(row => row.slice());
    Game.customTerrain = true;
  } else {
    Game.terrain = Board.fromSeed(st.seed, st.rows || Algorithms.GRID, st.cols || Algorithms.GRID).terrain;
    Game.customTerrain = false;
  }
  // Territory grid (old saves predate this: rebuild from the deployment zones).
  Game.territory = deserializeTerritory(Board.ROWS, Board.COLS, st.territory);
  Game.turn = st.turn || 0;
  Game.round = st.round || 1;
  Game.economy = (st.economy || [ECONOMY.start, ECONOMY.start]).slice();
  Game.cities = (st.cities || []).map((c) => ({ ...c }));
  Game.villages = (st.villages || []).map((v) => ({ ...v }));
  if (Game.customTerrain) {
    for (let r = 0; r < Board.ROWS; r++) {
      for (let c = 0; c < Board.COLS; c++) {
        const t = Game.terrain[r] && Game.terrain[r][c];
        if (t === 'city' && !Game.cities.some(ci => ci.r === r && ci.c === c)) {
          Game.cities.push({ r, c, owner: null });
        }
        if (t === 'village' && !Game.villages.some(v => v.r === r && v.c === c)) {
          Game.villages.push({ r, c, owner: null });
        }
      }
    }
  }
  Game.structures = (st.structures || []).map((s) => ({ ...s }));
  Game.units = (st.units || []).map(migrateUnit);
  Game.upgrades = [ { ...(st.upgrades && st.upgrades[0]) }, { ...(st.upgrades && st.upgrades[1]) } ];
  Game.ecoUpgrades = [ { ...(st.ecoUpgrades && st.ecoUpgrades[0]) }, { ...(st.ecoUpgrades && st.ecoUpgrades[1]) } ];
  Game.unlocked = [
    { infantry: true, ...(st.unlocked && st.unlocked[0]) },
    { infantry: true, ...(st.unlocked && st.unlocked[1]) },
  ];
  // Template libraries (default to the starting Infantry template if missing).
  Game.templates = [
    (st.templates && st.templates[0] && st.templates[0].length) ? st.templates[0].map(cloneTemplate) : defaultTemplates(),
    (st.templates && st.templates[1] && st.templates[1].length) ? st.templates[1].map(cloneTemplate) : defaultTemplates(),
  ];
  for (let p = 0; p < 2; p++) {
    if (!Game.templates[p].some(t => t.isHq)) Game.templates[p].push(makeHqTemplate());
  }
  rebuildUnitAt();
  nextId = Game.units.reduce((m, u) => Math.max(m, u.id), 0) + 1;
  Game.winner = null;
  Game.winReason = null;
  clearSelection();
  checkWinner();

  // Units bought in the shop arrive as "to place"; the player deploys them.
  // Entries are {templateId, owner}; legacy {type} entries are dropped.
  Game.toPlace = (st.toPlace || []).filter((s) => s && s.templateId);
  for (const sp of st.pendingSpawns || []) if (sp && sp.templateId) Game.toPlace.push({ templateId: sp.templateId, owner: sp.owner });
  persist(); // flush pendingSpawns into toPlace
}

// ---------------------------------------------------------------------------
// Cities & deployment
// ---------------------------------------------------------------------------
function cityAt(r, c) {
  return Game.cities.find((ci) => ci.r === r && ci.c === c) || null;
}
function villageAt(r, c) {
  return Game.villages.find((v) => v.r === r && v.c === c) || null;
}
// Capture a city OR village on move-on (neutral owner===null counts as capture).
function captureIfCity(r, c, owner) {
  const site = cityAt(r, c) || villageAt(r, c);
  if (site && site.owner !== owner) {
    const kind = TERRAIN[Game.terrain[r][c]] ? TERRAIN[Game.terrain[r][c]].name.toLowerCase() : 'site';
    site.owner = owner;
    UI.log(`${PLAYERS[owner].name} captured a ${kind} at r${r}, c${c}.`);
  }
}

// --- Structures (fort / supply hub) ------------------------------------------
function structureAt(r, c) {
  return Game.structures.find((s) => s.r === r && s.c === c) || null;
}
function canBuild(r, c, type) {
  if (Game.winner !== null || inPlacement()) return false;
  if (!STRUCTURES[type]) return false;
  if (Game.economy[Game.turn] < STRUCTURES[type].cost) return false;
  if (Game.terrain[r][c] === 'water') return false;
  if (structureAt(r, c)) return false;
  return true;
}
function buildStructure(r, c, type) {
  if (!canBuild(r, c, type)) return false;
  Game.economy[Game.turn] -= STRUCTURES[type].cost;
  Game.structures.push({ type, r, c, owner: Game.turn });
  UI.log(`${PLAYERS[Game.turn].name} built a ${STRUCTURES[type].name} at r${r}, c${c}.`);
  persist();
  return true;
}
function captureIfStructure(r, c, owner) {
  const s = structureAt(r, c);
  if (s && s.owner !== owner) {
    s.owner = owner;
    UI.log(`${PLAYERS[owner].name} captured a ${STRUCTURES[s.type].name} at r${r}, c${c}.`);
  }
}

// --- HP regeneration --------------------------------------------------------
// A unit that did NOT move on its turn recovers HP at the start of its next one.
// Motorized subunits self-repair anywhere (scaled by their share of the unit);
// every other subunit needs supply from a nearby OWNED city/village, with
// cavalry/tank units drawing that supply from farther out. Tuning: units.js REGEN.

// Share (0..1) of a unit's subunits that are `type`.
function subunitShare(u, type) {
  let total = 0, n = 0;
  for (const p of (u.parts || [])) { total += p.count; if (p.type === type) n += p.count; }
  return total ? n / total : 0;
}
function unitHasType(u, type) {
  return (u.parts || []).some((p) => p.type === type && p.count > 0);
}
// Is (r,c) within `dist` Manhattan tiles of a site in `sites` owned by `owner`?
function nearOwnedSite(r, c, sites, owner, dist) {
  for (const s of sites) {
    if (s.owner !== owner) continue;
    if (Rules.hexDist(s.r, s.c, r, c) <= dist) return true;
  }
  return false;
}
// HP a rested unit recovers this turn (0 if none / already full).
function regenAmount(u) {
  if (u.hp >= u.maxHp) return 0;
  let frac = 0;
  const mot = subunitShare(u, 'motorized');
  if (mot > 0) frac += mot * REGEN.motor;
  const range = (unitHasType(u, 'cavalry') || unitHasType(u, 'tank')) ? REGEN.heavyRange : REGEN.range;
  const supplyHubs = Game.structures.filter((s) => s.type === 'supply');
  if (nearOwnedSite(u.r, u.c, Game.cities, u.owner, range.city) ||
      nearOwnedSite(u.r, u.c, Game.villages, u.owner, range.village) ||
      nearOwnedSite(u.r, u.c, supplyHubs, u.owner, range.village)) {
    frac += REGEN.supply;
  }
  if (frac <= 0) return 0;
  return Math.min(u.maxHp - u.hp, Math.round(u.maxHp * frac));
}

// Deploy pending UNITS (each built from a template) onto a tile in the current
// player's zone. Multiple units may stack on a tile up to Rules.STACK_LIMIT.
// A queued unit is skipped if its template contains a still-locked subunit.
function placeAt(r, c) {
  const owner = Game.turn;
  if (!inZone(owner, c)) { UI.log('Deploy inside your own deployment zone.'); return; }
  if (Game.terrain[r][c] === 'water') { UI.log('Cannot deploy on water.'); return; }
  const stack = stackAt(r, c);
  if (stack.length && stack[0].owner !== owner) { UI.log('Tile is held by the enemy.'); return; }
  let room = Rules.STACK_LIMIT - stack.length;
  if (room <= 0) { UI.log(`That tile is full (${Rules.STACK_LIMIT} units).`); return; }

  let placed = 0, blockedLocked = false;
  for (let i = 0; i < Game.toPlace.length && room > 0; ) {
    const sp = Game.toPlace[i];
    if (sp.owner !== owner) { i++; continue; }
    const tmpl = findTemplate(owner, sp.templateId);
    if (!tmpl || !templateSize(tmpl)) { Game.toPlace.splice(i, 1); continue; } // stale/empty
    // Every subunit in the template must be unlocked to deploy it.
    if (Object.keys(templateComp(tmpl)).some((t) => !isUnlocked(owner, t))) { blockedLocked = true; i++; continue; }
    Game.toPlace.splice(i, 1);
    const u = makeUnitFromTemplate(owner, tmpl, r, c, { acted: true, movesLeft: 0 }); // arrive; act next turn
    if (!u) continue;
    Game.units.push(u);
    addToStack(u);
    room--; placed++;
  }
  if (!placed && blockedLocked) {
    UI.log('That battalion needs a unit you have not researched yet.');
  } else {
    if (placed) { captureIfCity(r, c, owner); claimTile(r, c, owner); } // deploying claims the tile
    UI.log(`Deployed ${placed} unit(s) at r${r}, c${c}.` +
      (pendingForTurn() ? ` ${pendingForTurn()} left to place.` : ''));
  }
  persist();
}

// ---------------------------------------------------------------------------
// Combat — mutual, stack-vs-stack, damage applied 1-by-1 (rules in rules.js)
// ---------------------------------------------------------------------------
// Apply `total` damage evenly across a stack. Each unit takes an equal share;
// overkill from killed units redistributes to survivors. Mutates the passed
// array and the global Game.units/unitAt. Returns units destroyed.
function applyDamage(stack, total) {
  let killed = 0;
  while (total > 0 && stack.length) {
    const n = stack.length;
    const base = Math.floor(total / n);
    const extra = total % n;
    let leftover = 0;
    const dead = [];
    for (let i = 0; i < n; i++) {
      const u = stack[i];
      const dmg = base + (i < extra ? 1 : 0);
      if (u.hp > dmg) { u.hp -= dmg; }
      else { leftover += dmg - u.hp; dead.push(i); }
    }
    for (let i = dead.length - 1; i >= 0; i--) {
      const u = stack[dead[i]];
      stack.splice(dead[i], 1);
      removeFromStack(u);
      Game.units = Game.units.filter((x) => x !== u);
      killed++;
    }
    total = leftover;
    if (!dead.length) break;
  }
  return killed;
}

function doAttack(attackers, tr, tc) {
  const defenders = stackAt(tr, tc).slice();
  if (!defenders.length || defenders[0].owner === attackers[0].owner) return;
  const acting = attackers.filter((u) => !u.acted && u.owner === Game.turn);
  if (!acting.length) { UI.log('Those units have already attacked.'); return; }

  let { dmgToDef, dmgToAtk, defSurrounded, atkSurrounded } =
    Rules.resolveCombat(Game.terrain, acting, defenders, Game.territory);

  // Fort defense: defender's owned fort reduces incoming damage
  const defFort = structureAt(tr, tc);
  if (defFort && defFort.type === 'fort' && defFort.owner === defenders[0].owner) {
    dmgToDef = Math.max(1, Math.round(dmgToDef * (1 - STRUCTURES.fort.defense)));
  }

  const aTerr = Game.terrain[acting[0].r][acting[0].c];  // attackers' own tile (before casualties)
  const defKilled = applyDamage(defenders, dmgToDef);  // acting array preserved
  const atkKilled = applyDamage(acting, dmgToAtk);     // shifts dead off `acting`

  // Survivors have attacked: mark acted and halve remaining MOV (can still move).
  for (const u of acting) { u.acted = true; u.movesLeft = Math.floor(u.movesLeft / 2); }

  const foe = 1 - Game.turn;

  // Note any terrain buff/debuff the attackers' own tile imposed on them.
  const mods = [], seen = new Set();
  for (const u of acting) {
    if (seen.has(u.type)) continue;
    seen.add(u.type);
    const m = Rules.terrainAtkMult(u.type, aTerr);
    if (m !== 1) mods.push(`${PIECES[u.type].name} ${m < 1 ? '−' : '+'}${Math.round(Math.abs(1 - m) * 100)}%`);
  }
  const terrainNote = mods.length ? ` [${TERRAIN[aTerr].name}: ${mods.join(', ')}]` : '';
  const fortNote = (defFort && defFort.type === 'fort' && defFort.owner === defenders[0].owner)
    ? ` [Fort: −${Math.round(STRUCTURES.fort.defense * 100)}% dmg]` : '';
  // Surrounded-territory double-damage notes.
  let surrNote = '';
  if (defSurrounded) surrNote += ` [${PLAYERS[foe].name} surrounded: ×2 taken]`;
  if (atkSurrounded) surrNote += ` [${PLAYERS[Game.turn].name} surrounded: ×2 taken]`;

  UI.log(`${PLAYERS[Game.turn].name} (${acting.length + atkKilled}) struck ` +
    `${PLAYERS[foe].name} for ${dmgToDef} (took ${dmgToAtk} back). ` +
    `Destroyed ${defKilled} / lost ${atkKilled}.${terrainNote}${fortNote}${surrNote}`);
  checkWinner();
}

// Sample the board once per turn hand-off and advance each side's elimination
// streaks: a side with zero units (or zero owned cities) has its counter bumped,
// otherwise it resets. Call exactly once per turn transition (see advanceTo).
function updateEliminationStreaks() {
  const units = [0, 0], cities = [0, 0];
  for (const u of Game.units) units[u.owner]++;
  for (const ci of Game.cities) if (ci.owner === 0 || ci.owner === 1) cities[ci.owner]++;
  for (let p = 0; p < 2; p++) {
    Game.noUnitTurns[p] = units[p] === 0 ? Game.noUnitTurns[p] + 1 : 0;
    Game.noCityTurns[p] = cities[p] === 0 ? Game.noCityTurns[p] + 1 : 0;
  }
}

// A side loses only after being fully eliminated — no units, or no owned cities —
// for LOSE_TURNS consecutive turns (streaks maintained by updateEliminationStreaks).
// This lets a wiped-out side reinforce before the loss locks in.
function checkWinner() {
  if (Game.winner !== null) return;
  // HQ destruction: instant loss
  for (let p = 0; p < 2; p++) {
    const hadHq = (Game.templates[p] || []).some(t => t.isHq);
    if (hadHq && !Game.units.some(u => u.owner === p && isHqUnit(u))) {
      Game.winner = 1 - p;
      Game.winReason = `${PLAYERS[p].name} lost their HQ`;
      return;
    }
  }
  for (let p = 0; p < 2; p++) {
    if (Game.noUnitTurns[p] >= LOSE_TURNS) {
      Game.winner = 1 - p;
      Game.winReason = `${PLAYERS[p].name} lost all units`;
      return;
    }
    if (Game.noCityTurns[p] >= LOSE_CITY_TURNS) {
      Game.winner = 1 - p;
      Game.winReason = `${PLAYERS[p].name} lost all cities`;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Unit refit — swap a deployed unit to a different template (in supply zone)
// ---------------------------------------------------------------------------
function canRefitUnit(u) {
  if (u.owner !== Game.turn || Game.winner !== null) return false;
  if (inPlacement()) return false;
  if (isHqUnit(u)) return false;
  const enemy = 1 - u.owner;
  if (Rules.surroundedBy(Game.territory, u.r, u.c, enemy)) return false;
  const range = (unitHasType(u, 'cavalry') || unitHasType(u, 'tank')) ? REGEN.heavyRange : REGEN.range;
  const supplyHubs = Game.structures.filter((s) => s.type === 'supply');
  return nearOwnedSite(u.r, u.c, Game.cities, u.owner, range.city) ||
         nearOwnedSite(u.r, u.c, Game.villages, u.owner, range.village) ||
         nearOwnedSite(u.r, u.c, supplyHubs, u.owner, range.village);
}

function unitCostFromParts(u) {
  let cost = 0;
  for (const p of (u.parts || [])) cost += (PIECES[p.type].cost || 0) * p.count;
  return cost;
}

function refitUnitsTo(tmplId) {
  const tmpl = findTemplate(Game.turn, tmplId);
  if (!tmpl || !templateSize(tmpl)) return 0;
  if (Object.keys(templateComp(tmpl)).some((t) => !isUnlocked(Game.turn, t))) return 0;
  const eligible = Game.selUnits.filter((u) => canRefitUnit(u) && u.templateId !== tmplId);
  if (!eligible.length) return 0;
  const newCost = templateCost(Game.turn, tmpl);
  let totalDiff = 0;
  for (const u of eligible) {
    const hpRatio = u.hp / u.maxHp;
    totalDiff += newCost - Math.round(unitCostFromParts(u) * hpRatio);
  }
  if (totalDiff > 0 && Game.economy[Game.turn] < totalDiff) return 0;
  const s = templateStats(Game.turn, tmpl);
  Game.economy[Game.turn] -= totalDiff;
  for (const u of eligible) {
    const hpRatio = u.hp / u.maxHp;
    u.templateId = tmpl.id;
    u.name = tmpl.name;
    u.type = s.primary;
    u.parts = s.parts.map((p) => ({ ...p }));
    u.maxHp = s.maxHp;
    u.hp = Math.max(1, Math.round(s.maxHp * hpRatio));
    u.mov = s.mov;
    u.movesLeft = Math.min(u.movesLeft, s.mov);
  }
  UI.log(`${PLAYERS[Game.turn].name} refit ${eligible.length} unit(s) to ${tmpl.name} (${totalDiff >= 0 ? '+' : ''}${totalDiff} gold).`);
  persist();
  return eligible.length;
}

// ---------------------------------------------------------------------------
// Unit split — break subunits off a deployed unit into new 1-subunit units
// ---------------------------------------------------------------------------
function totalSubunits(u) {
  let n = 0; for (const p of (u.parts || [])) n += p.count; return n;
}

function canSplitUnit(u) {
  if (u.owner !== Game.turn || Game.winner !== null) return false;
  if (inPlacement()) return false;
  if (isHqUnit(u)) return false;
  if (totalSubunits(u) < 2) return false;
  const room = Rules.STACK_LIMIT - stackAt(u.r, u.c).length;
  return room > 0;
}

function splitUnit(u, selectedTypes) {
  if (!canSplitUnit(u)) return 0;
  if (!selectedTypes.length) return 0;
  const total = totalSubunits(u);
  if (selectedTypes.length >= total) return 0;
  const room = Rules.STACK_LIMIT - stackAt(u.r, u.c).length;
  const toSplit = selectedTypes.slice(0, room);

  const hpRatio = u.hp / u.maxHp;
  const owner = u.owner;
  const created = [];

  const removals = {};
  for (const t of toSplit) removals[t] = (removals[t] || 0) + 1;

  for (const t of toSplit) {
    const e = subunitEff(owner, t);
    const nu = {
      id: nextId++, owner, r: u.r, c: u.c,
      templateId: null, name: PIECES[t].name, type: t,
      parts: [{ type: t, count: 1, atk: e.atk, hp: e.hp, mov: e.mov }],
      hp: Math.max(1, Math.round(e.hp * hpRatio)),
      maxHp: e.hp, mov: e.mov,
      movesLeft: 0, acted: true, moved: false,
    };
    Game.units.push(nu);
    addToStack(nu);
    created.push(nu);
  }

  for (const t in removals) {
    const p = u.parts.find((x) => x.type === t);
    if (p) p.count -= removals[t];
  }
  u.parts = u.parts.filter((p) => p.count > 0);

  let newMaxHp = 0, newMov = Infinity, best = -1, primary = u.type;
  for (const p of u.parts) {
    newMaxHp += p.count * p.hp;
    newMov = Math.min(newMov, p.mov);
    const score = p.count * 100 + PIECES[p.type].cost;
    if (score > best) { best = score; primary = p.type; }
  }
  u.maxHp = newMaxHp;
  u.hp = Math.max(1, Math.round(newMaxHp * hpRatio));
  u.mov = isFinite(newMov) ? newMov : 0;
  u.movesLeft = Math.min(u.movesLeft, u.mov);
  u.type = primary;

  UI.log(`${PLAYERS[owner].name} split ${created.length} unit(s) off ${u.name}.`);
  persist();
  return created.length;
}

// ---------------------------------------------------------------------------
// Unit combine — absorb subunits from a donor into a receiver, up to 25 total
// ---------------------------------------------------------------------------
function canCombineUnits(fill, material) {
  if (!fill || !material || fill.id === material.id) return false;
  if (fill.owner !== Game.turn || material.owner !== Game.turn) return false;
  if (Game.winner !== null || inPlacement()) return false;
  if (fill.r !== material.r || fill.c !== material.c) return false;
  if (totalSubunits(fill) >= TEMPLATE_CELLS) return false;
  return true;
}

function combineUnits(fill, material) {
  if (!canCombineUnits(fill, material)) return 0;
  const room = TEMPLATE_CELLS - totalSubunits(fill);
  if (room <= 0) return 0;

  const matHpRatio = material.hp / material.maxHp;
  let taken = 0, takenMaxHp = 0;

  for (const mp of material.parts) {
    if (taken >= room) break;
    const canTake = Math.min(mp.count, room - taken);
    const existing = fill.parts.find((p) => p.type === mp.type);
    if (existing) { existing.count += canTake; }
    else { fill.parts.push({ type: mp.type, count: canTake, atk: mp.atk, hp: mp.hp, mov: mp.mov }); }
    takenMaxHp += canTake * mp.hp;
    mp.count -= canTake;
    taken += canTake;
  }
  if (!taken) return 0;

  material.parts = material.parts.filter((p) => p.count > 0);

  // Recompute fill unit stats
  let newMaxHp = 0, newMov = Infinity, best = -1, primary = fill.type;
  for (const p of fill.parts) {
    newMaxHp += p.count * p.hp;
    newMov = Math.min(newMov, p.mov);
    const score = p.count * 100 + PIECES[p.type].cost;
    if (score > best) { best = score; primary = p.type; }
  }
  const hpGain = Math.max(1, Math.round(takenMaxHp * matHpRatio));
  fill.maxHp = newMaxHp;
  fill.hp = Math.min(fill.hp + hpGain, newMaxHp);
  fill.mov = isFinite(newMov) ? newMov : 0;
  fill.movesLeft = Math.min(fill.movesLeft, fill.mov);
  fill.type = primary;

  // Remove or shrink the material unit
  if (!material.parts.length) {
    removeFromStack(material);
    Game.units = Game.units.filter((x) => x !== material);
  } else {
    let mMax = 0, mMov = Infinity, mBest = -1, mPrimary = material.type;
    for (const p of material.parts) {
      mMax += p.count * p.hp;
      mMov = Math.min(mMov, p.mov);
      const sc = p.count * 100 + PIECES[p.type].cost;
      if (sc > mBest) { mBest = sc; mPrimary = p.type; }
    }
    material.maxHp = mMax;
    material.hp = Math.max(1, Math.round(mMax * matHpRatio));
    material.mov = isFinite(mMov) ? mMov : 0;
    material.movesLeft = Math.min(material.movesLeft, material.mov);
    material.type = mPrimary;
  }

  UI.log(`${PLAYERS[fill.owner].name} combined ${taken} unit(s) from ${material.name || PIECES[material.type].name} into ${fill.name || PIECES[fill.type].name}.`);
  persist();
  return taken;
}

// ---------------------------------------------------------------------------
function clearSelection() { Game.selTile = null; Game.selUnits = []; Game.reachable = new Map(); clearAllOrders(); }

function committedUnitIds() {
  const s = new Set();
  for (const o of Game.orderQueue) for (const u of o.group) s.add(u.id);
  return s;
}
function addOrder(group, sourceTile, destTile, path, isAttack, attackTarget) {
  Game.orderQueue.push({
    id: nextOrderId++, group, sourceTile, destTile, path,
    isAttack: !!isAttack, attackTarget: attackTarget || null,
  });
  for (const u of group) u._committed = true;
}
function clearAllOrders() {
  for (const o of Game.orderQueue) for (const u of o.group) delete u._committed;
  Game.orderQueue = [];
  nextOrderId = 1;
}
function bestAdjacentForAttack(tr, tc, reachable, unitAt, owner, groupSize) {
  const nbrs = Rules.neighbors(tr, tc);
  let best = null, bestBudget = -1;
  for (const [nr, nc] of nbrs) {
    if (!Board.inBounds(nr, nc)) continue;
    const k = Board.key(nr, nc);
    if (!reachable.has(k)) continue;
    const stack = unitAt.get(k) || [];
    if (stack.length && stack[0].owner !== owner) continue;
    if (stack.length + groupSize > Rules.STACK_LIMIT) continue;
    const budget = reachable.get(k);
    if (budget > bestBudget) { bestBudget = budget; best = { r: nr, c: nc }; }
  }
  return best;
}
function autoAdvance() {
  const committed = committedUnitIds();
  const movers = Game.units.filter(u =>
    u.owner === Game.turn && u.movesLeft > 0 && !committed.has(u.id));
  if (!movers.length) { Game.selTile = null; Game.selUnits = []; Game.reachable = new Map(); UI.refresh(); Render.render(); return; }
  const seen = new Set(), tiles = [];
  for (const u of movers) {
    const k = key(u.r, u.c);
    if (seen.has(k)) continue;
    seen.add(k); tiles.push({ r: u.r, c: u.c });
  }
  tiles.sort((a, b) => (a.r - b.r) || (a.c - b.c));
  const next = tiles[0];
  selectTile(next.r, next.c);
  if (Render.centerOn) Render.centerOn(next.r, next.c);
  UI.refresh(); Render.render();
}

// Recompute reachable tiles for the units in the current selection that can move.
function recomputeReachable() {
  const committed = committedUnitIds();
  const g = Game.selUnits.filter(u => u.owner === Game.turn && u.movesLeft > 0 && !committed.has(u.id));
  Game.reachable = g.length ? Rules.reachable(Game.terrain, Game.unitAt, g) : new Map();
}

// Inspect a tile: select its whole stack (subset can be unchecked in sidebar).
function selectTile(r, c) {
  const s = stackAt(r, c);
  const committed = committedUnitIds();
  Game.selTile = { r, c };
  Game.selUnits = s.filter(u => !committed.has(u.id));
  Game.reachable = Game.selUnits.length ? (function () {
    const g = Game.selUnits.filter(u => u.owner === Game.turn && u.movesLeft > 0);
    return g.length ? Rules.reachable(Game.terrain, Game.unitAt, g) : new Map();
  })() : new Map();
}

function setSelectAll(v) {
  Game.selectAll = !!v;
  if (Game.selTile) selectTile(Game.selTile.r, Game.selTile.c); // reset to whole stack
  UI.refresh(); Render.render();
}
function toggleUnitInSelection(id) {
  const u = Game.units.find((x) => x.id === id);
  if (!u) return;
  const i = Game.selUnits.indexOf(u);
  if (i >= 0) Game.selUnits.splice(i, 1); else Game.selUnits.push(u);
  recomputeReachable();
  UI.refresh(); Render.render();
}

// Cycle the selection to the next friendly TILE that still holds a unit with
// movement left, centering the camera on it. Wraps around; stays put (with a
// note) when nobody can move.
function selectNextWithMoves() {
  if (Game.winner !== null) return;
  const movers = Game.units.filter((u) => u.owner === Game.turn && u.movesLeft > 0);
  if (!movers.length) { UI.log('No units with movement remaining.'); UI.refresh(); return; }
  // Unique tiles in a stable reading order (top-to-bottom, left-to-right).
  const seen = new Set(), tiles = [];
  for (const u of movers) {
    const k = key(u.r, u.c);
    if (seen.has(k)) continue;
    seen.add(k); tiles.push({ r: u.r, c: u.c });
  }
  tiles.sort((a, b) => (a.r - b.r) || (a.c - b.c));
  // Advance past the currently selected tile (if it is one of them).
  const cur = Game.selTile ? tiles.findIndex((t) => t.r === Game.selTile.r && t.c === Game.selTile.c) : -1;
  const next = tiles[(cur + 1) % tiles.length];
  selectTile(next.r, next.c);
  if (window.Render && Render.centerOn) Render.centerOn(next.r, next.c);
  UI.refresh(); Render.render();
}

// Move a group to (r,c). Group speed = slowest member; each loses the same
// number of points; stacks merge at the destination. If `explicitPath` is
// provided, territory is claimed along that path and intermediate tiles are
// captured; otherwise the default shortest path is reconstructed.
function moveGroup(group, r, c, explicitPath) {
  const left = Game.reachable.get(key(r, c));
  if (left === undefined) return false;
  const startBudget = Math.min(...group.map((u) => u.movesLeft));
  const spent = startBudget - left;
  const owner = group[0].owner;
  const sr = group[0].r, sc = group[0].c;
  // Paint the traversed path (and destination) into the mover's territory.
  if (explicitPath && explicitPath.length) {
    for (const p of explicitPath) {
      claimTile(p.r, p.c, owner);
      captureIfCity(p.r, p.c, owner);
      captureIfStructure(p.r, p.c, owner);
    }
  } else {
    claimPath(owner, sr, sc, r, c, startBudget);
    captureIfCity(r, c, owner);
    captureIfStructure(r, c, owner);
  }
  for (const u of group) {
    removeFromStack(u);
    u.r = r; u.c = c;
    u.movesLeft = Math.max(0, u.movesLeft - spent);
    u.moved = true; // moved this turn -> no HP regen next turn
    addToStack(u);
  }
  return true;
}

function executeOrders() {
  if (!Game.orderQueue.length) return;
  const moves = Game.orderQueue.filter(o => !o.isAttack);
  const attacks = Game.orderQueue.filter(o => o.isAttack);
  for (const order of moves) {
    const group = order.group.filter(u => Game.units.includes(u));
    if (!group.length) continue;
    Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, group);
    if (Game.reachable.has(key(order.destTile.r, order.destTile.c))) {
      moveGroup(group, order.destTile.r, order.destTile.c, order.path);
    }
  }
  // Move all attack groups to their adjacent tiles first
  for (const order of attacks) {
    const group = order.group.filter(u => Game.units.includes(u));
    if (!group.length) continue;
    const sr = group[0].r, sc = group[0].c;
    const dr = order.destTile.r, dc = order.destTile.c;
    if (sr !== dr || sc !== dc) {
      Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, group);
      if (Game.reachable.has(key(dr, dc))) {
        moveGroup(group, dr, dc, order.path);
      }
    }
  }
  // Group attacks by target tile — multiple stacks attacking the same tile
  // share the defender's retaliation damage across all of them
  const atkByTarget = new Map();
  for (const order of attacks) {
    const survivors = order.group.filter(u => Game.units.includes(u));
    if (!survivors.length || !order.attackTarget) continue;
    const tk = key(order.attackTarget.r, order.attackTarget.c);
    if (!atkByTarget.has(tk)) atkByTarget.set(tk, []);
    atkByTarget.get(tk).push(survivors);
  }
  for (const [tk, groups] of atkByTarget) {
    const [tr, tc] = tk.split(',').map(Number);
    const defenders = stackAt(tr, tc).slice();
    if (!defenders.length || defenders[0].owner === Game.turn) continue;
    const allAttackers = groups.flat().filter(u => !u.acted && u.owner === Game.turn);
    if (!allAttackers.length) continue;
    doCoordinatedAttack(allAttackers, groups, tr, tc);
  }
  clearAllOrders();
  Game.reachable = new Map();
  persist();
  clearSelection();
  UI.refresh();
  Render.render();
  Render.autoZoom();
}

// Coordinated attack: multiple stacks from different tiles attack one target.
// Total ATK is the sum of all attackers. Defender retaliation is split across
// all attacking groups proportionally to group size.
function doCoordinatedAttack(allAttackers, groups, tr, tc) {
  const defenders = stackAt(tr, tc).slice();
  if (!defenders.length || defenders[0].owner === allAttackers[0].owner) return;

  let { dmgToDef, dmgToAtk, defSurrounded, atkSurrounded } =
    Rules.resolveCombat(Game.terrain, allAttackers, defenders, Game.territory);

  const defFort = structureAt(tr, tc);
  if (defFort && defFort.type === 'fort' && defFort.owner === defenders[0].owner) {
    dmgToDef = Math.max(1, Math.round(dmgToDef * (1 - STRUCTURES.fort.defense)));
  }

  const defKilled = applyDamage(defenders, dmgToDef);

  // Split retaliation damage across attacking groups by share of total units
  const totalCount = allAttackers.length;
  let atkKilled = 0;
  for (const grp of groups) {
    const alive = grp.filter(u => Game.units.includes(u) && !u.acted && u.owner === Game.turn);
    if (!alive.length) continue;
    const share = Math.max(1, Math.round(dmgToAtk * alive.length / totalCount));
    atkKilled += applyDamage(alive, share);
  }

  for (const u of allAttackers) {
    if (Game.units.includes(u)) { u.acted = true; u.movesLeft = Math.floor(u.movesLeft / 2); }
  }

  const foe = 1 - Game.turn;
  const stkCount = groups.length > 1 ? ` (${groups.length} stacks)` : '';
  UI.log(`${PLAYERS[Game.turn].name}${stkCount} (${allAttackers.length}) struck ` +
    `${PLAYERS[foe].name} for ${dmgToDef} (took ${dmgToAtk} back split). ` +
    `Destroyed ${defKilled} / lost ${atkKilled}.`);
  checkWinner();
}

// ---------------------------------------------------------------------------
// Turns & economy
// ---------------------------------------------------------------------------
function grantIncome(player) {
  const base = Rules.income(Game.cities, Game.villages, player, Game.ecoUpgrades && Game.ecoUpgrades[player]);
  const mult = (Game.incomeMult && Game.incomeMult[player]) || 1;
  Game.economy[player] += Math.round(base * mult);
}

function startTurn(player) {
  Game.turn = player;
  let healed = 0, healedUnits = 0;
  for (const u of Game.units) {
    if (u.owner !== player) continue;
    if (!u.moved) { // rested last turn -> recover HP
      const gain = regenAmount(u);
      if (gain > 0) { u.hp += gain; healed += gain; healedUnits++; }
    }
    u.moved = false;
    u.movesLeft = u.mov || 0;
    u.acted = false;
  }
  if (healedUnits) UI.log(`${PLAYERS[player].name} recovered ${healed} HP across ${healedUnits} resting unit(s).`);
  clearSelection();
}

// Hand the turn to `player`, paying their income first. Drives the AI in PvE.
function advanceTo(player) {
  if (Game.winner !== null) return;
  // One turn has just completed: update elimination streaks and settle any loss
  // before the next side plays (a side wiped out for LOSE_TURNS straight turns).
  updateEliminationStreaks();
  checkWinner();
  if (Game.winner !== null) { persist(); UI.refresh(); Render.render(); return; }
  if (player === 0) Game.round++; // returning to Blue completes a round
  grantIncome(player);
  startTurn(player);
  persist();
  UI.refresh();
  Render.render();
  Render.autoZoom(); // small boards: keep the board filling the viewport
  if (Game.mode === 'pve' && player === Game.aiPlayer) runAiTurn();
}

function nextRound() {
  if (Game.winner !== null) return;
  if (inPlacement()) { UI.log('Deploy your bought units first.'); UI.refresh(); return; }
  if (Game.orderQueue.length) executeOrders();
  advanceTo(1 - Game.turn);
}

// ---------------------------------------------------------------------------
// PvE AI: strategic movement, retreat when outnumbered, avoid attacking
// enemies in strong defensive positions.
// ---------------------------------------------------------------------------
function nearestEnemyTile(r, c, owner) {
  let best = null, bestD = Infinity;
  for (const [k, s] of Game.unitAt) {
    if (!s.length || s[0].owner === owner) continue;
    const [er, ec] = k.split(',').map(Number);
    const d = Rules.hexDist(er, ec, r, c);
    if (d < bestD) { bestD = d; best = { r: er, c: ec }; }
  }
  return best;
}

function aiHasNoCities(me) {
  return !Game.cities.some(ci => ci.owner === me);
}

function nearestUnownedCity(r, c, me) {
  let best = null, bestD = Infinity;
  for (const ci of Game.cities) {
    if (ci.owner === me) continue;
    const d = Rules.hexDist(ci.r, ci.c, r, c);
    if (d < bestD) { bestD = d; best = { r: ci.r, c: ci.c }; }
  }
  return best;
}

function nearestUnownedCityOrVillage(r, c, me) {
  let best = null, bestD = Infinity;
  for (const s of Game.cities.concat(Game.villages)) {
    if (s.owner === me) continue;
    const d = Rules.hexDist(s.r, s.c, r, c);
    if (d < bestD) { bestD = d; best = { r: s.r, c: s.c }; }
  }
  return best;
}

function isDefensiveTerrain(r, c) {
  const t = Game.terrain[r][c];
  return t === 'city' || t === 'village' || t === 'forest' || t === 'water';
}

function aiCountNeighborUnits(r, c, owner) {
  let count = 0;
  for (const [nr, nc] of Rules.neighbors(r, c)) {
    if (!inBounds(nr, nc)) continue;
    const s = stackAt(nr, nc);
    for (const u of s) if (u.owner === owner) count++;
  }
  return count;
}

function aiMyCityCount(me) {
  return Game.cities.filter(ci => ci.owner === me).length;
}

function aiLargestEnemyCluster(me) {
  const enemy = 1 - me;
  let best = null, bestSize = 0;
  for (const [k, s] of Game.unitAt) {
    if (!s.length || s[0].owner !== enemy) continue;
    if (s.length > bestSize) {
      bestSize = s.length;
      const [r, c] = k.split(',').map(Number);
      best = { r, c };
    }
  }
  return best;
}

// The AI (Game.aiPlayer) spends its gold on reinforcements and deploys them in
// its own zone, aimed at the row where the enemy has pushed closest to the AI's
// home edge. Called after the AI's existing units have already moved this turn,
// so a freshly-arrived (0-move) unit never freezes a shared stack's movement.

// Row where the enemy is nearest to `me`'s home edge (its most advanced threat).
// me=1 defends the RIGHT edge (largest column), me=0 the LEFT (smallest column).
function aiThreatRow(me) {
  let best = null, bestC = me === 1 ? -1 : COLS();
  for (const u of Game.units) {
    if (u.owner === me) continue;
    if (me === 1 ? u.c > bestC : u.c < bestC) { bestC = u.c; best = u.r; }
  }
  return best == null ? Math.floor(ROWS() / 2) : best;
}

// Build a synthetic (single-type) template from a comp map, for AI/ad-hoc units.
function compTemplate(name, comp) {
  const cells = new Array(TEMPLATE_CELLS).fill(null);
  let i = 0;
  for (const type in comp) for (let k = 0; k < comp[type] && i < TEMPLATE_CELLS; k++) cells[i++] = type;
  return { id: 'adhoc', name, cells };
}

// Greedily spend the AI's gold on UNLOCKED units, packaged into battalions.
// Early game (few cities): focus on cheap infantry to capture cities fast.
// When the enemy fields tanks and cannon is unlocked, the AI spends roughly
// half its budget on cannon battalions to counter them.
// Returns unit specs [{type, size}]. Mirrors the buy page's cost model.
function aiBuyUnits(me) {
  const roster = Object.keys(PIECES)
    .filter((t) => isUnlocked(me, t))
    .sort((a, b) => PIECES[a].cost - PIECES[b].cost);
  if (!roster.length) return [];
  const cheapest = PIECES[roster[0]].cost;
  const units = [];
  let budget = Game.economy[me];

  // Early game: build small infantry battalions for fast city capture.
  const myCities = aiMyCityCount(me);
  if (myCities < 5 && isUnlocked(me, 'infantry')) {
    const infCost = PIECES.infantry.cost;
    const earlyBudget = Math.floor(budget * 0.85);
    let spent = 0;
    while (spent + infCost <= earlyBudget && units.length < 100) {
      const size = Math.min(4, Math.floor((earlyBudget - spent) / infCost));
      if (size < 1) break;
      let n = 0;
      while (n < size && spent + infCost <= earlyBudget) { spent += infCost; n++; }
      units.push({ type: 'infantry', size: n });
    }
    budget -= spent;
  }

  // Counter-tanks: if enemy has tanks and cannon is unlocked, dedicate ~half
  // remaining budget to cannon battalions.
  const enemyTanks = aiEnemyHasTanks(me);
  if (enemyTanks && isUnlocked(me, 'cannon')) {
    const cannonCost = PIECES.cannon.cost;
    const cannonBudget = Math.floor(budget / 2);
    let spent = 0;
    while (spent + cannonCost <= cannonBudget && units.length < 100) {
      const size = Math.max(1, Math.min(4, Math.floor((cannonBudget - spent) / cannonCost / 2) || 1));
      let n = 0;
      while (n < size && spent + cannonCost <= cannonBudget) { spent += cannonCost; n++; }
      units.push({ type: 'cannon', size: n });
    }
    budget -= spent;
  }

  // Guard the loop so a runaway can never spin (budget strictly decreases).
  while (budget >= cheapest && units.length < 100) {
    const affordable = roster.filter((t) => PIECES[t].cost <= budget);
    const type = affordable[units.length % affordable.length];
    const cost = PIECES[type].cost;
    const size = Math.max(1, Math.min(4, Math.floor(budget / cost / 3) || 1));
    let n = 0;
    while (n < size && budget >= cost) { budget -= cost; n++; }
    units.push({ type, size: n });
  }
  Game.economy[me] = budget;
  return units;
}

// The AI only researches new unit types when it has a large gold surplus
// (3× the tech cost), keeping most gold for infantry production.
function aiResearchTech(me) {
  if (typeof TECH === 'undefined') return;
  if (aiEnemyHasTanks(me) && !isUnlocked(me, 'cannon')) {
    if (Game.economy[me] >= TECH.cannon * 3) { unlockType(me, 'cannon'); return; }
  }
  const locked = Object.keys(TECH)
    .filter((t) => !isUnlocked(me, t))
    .sort((a, b) => TECH[a] - TECH[b]);
  for (const t of locked) {
    if (Game.economy[me] >= TECH[t] * 3) { unlockType(me, t); break; }
  }
}

// Row of the nearest enemy tank to `me`'s home edge (for cannon deployment).
function aiEnemyTankRow(me) {
  let best = null, bestC = me === 1 ? -1 : COLS();
  for (const u of Game.units) {
    if (u.owner === me) continue;
    if (!(u.parts || []).some((p) => p.type === 'tank' && p.count > 0)) continue;
    if (me === 1 ? u.c > bestC : u.c < bestC) { bestC = u.c; best = u.r; }
  }
  return best;
}

// Deploy AI unit specs into `me`'s zone, one unit per tile-slot, filling tiles
// closest to (threatRow, front column) first and spilling outward. Cannon units
// are deployed near enemy tanks when possible.
function aiDeployUnits(me, specs) {
  if (!specs.length) return 0;
  const cols = COLS(), rows = ROWS(), zone = ZONE();
  const frontCol = me === 1 ? cols - zone : zone - 1;
  const targetRow = aiThreatRow(me);
  const tankRow = aiEnemyTankRow(me);
  const noCities = aiHasNoCities(me);

  // Build candidate list for a given target row.
  function buildCands(tRow) {
    const cands = [];
    for (let c = 0; c < cols; c++) {
      if (!inZone(me, c)) continue;
      for (let r = 0; r < rows; r++) {
        if (Game.terrain[r][c] === 'water') continue;
        const s = stackAt(r, c);
        if (s.length && s[0].owner !== me) continue;
        cands.push({ r, c, d: Rules.hexDist(r, c, tRow, frontCol), isCity: Game.terrain[r][c] === 'city' });
      }
    }
    if (noCities) {
      cands.sort((a, b) => (b.isCity - a.isCity) || (a.d - b.d));
    } else {
      cands.sort((a, b) => a.d - b.d);
    }
    return cands;
  }

  const defaultCands = buildCands(targetRow);
  const cannonCands = tankRow != null ? buildCands(tankRow) : defaultCands;

  let placed = 0;
  for (const spec of specs) {
    if (!spec.size) continue;
    const pool = spec.type === 'cannon' ? cannonCands : defaultCands;
    const dest = pool.find((cand) => stackAt(cand.r, cand.c).length < Rules.STACK_LIMIT)
              || defaultCands.find((cand) => stackAt(cand.r, cand.c).length < Rules.STACK_LIMIT);
    if (!dest) break;
    const tmpl = compTemplate(PIECES[spec.type].name, { [spec.type]: spec.size });
    const u = makeUnitFromTemplate(me, tmpl, dest.r, dest.c, { acted: true, movesLeft: 0 });
    if (!u) continue;
    Game.units.push(u);
    addToStack(u);
    placed++;
  }
  // Refund any units that couldn't fit (zone saturated).
  for (let i = placed; i < specs.length; i++) Game.economy[me] += PIECES[specs[i].type].cost * specs[i].size;
  return placed;
}

function aiSpendAndReinforce(me) {
  if (Game.economy[me] < 1) return;
  aiResearchTech(me); // occasionally unlock a new unit before spending
  const specs = aiBuyUnits(me);
  const placed = aiDeployUnits(me, specs);
  if (placed) {
    const counts = {};
    for (let i = 0; i < placed; i++) counts[specs[i].type] = (counts[specs[i].type] || 0) + specs[i].size;
    const names = Object.keys(counts).map((t) => `${PIECES[t].name} ×${counts[t]}`);
    UI.log(`${PLAYERS[me].name} reinforced with ${names.join(', ')}.`);
  }
}

// Is (r,c) within supply range for `owner`? (cities, villages, supply hubs)
function aiInSupplyRange(r, c, owner) {
  const range = REGEN.heavyRange; // use heavy range (largest) for conservative check
  const supplyHubs = Game.structures.filter((s) => s.type === 'supply');
  return nearOwnedSite(r, c, Game.cities, owner, range.city) ||
         nearOwnedSite(r, c, Game.villages, owner, range.village) ||
         nearOwnedSite(r, c, supplyHubs, owner, range.village);
}

// Does the enemy field any tanks? Used to prioritise cannon purchases.
function aiEnemyHasTanks(me) {
  for (const u of Game.units) {
    if (u.owner === me) continue;
    if ((u.parts || []).some((p) => p.type === 'tank' && p.count > 0)) return true;
  }
  return false;
}

function runAiTurn() {
  const me = Game.aiPlayer;
  const logStart = (window.UI && UI.entries) ? UI.entries.length : 0;
  runAiFor(me);
  if (Game.winner === null) aiSpendAndReinforce(me);
  Game.reachable = new Map();
  persist();
  UI.refresh();
  Render.render();
  if (window.UI && UI.showEnemyMoves) UI.showEnemyMoves(UI.entries.slice(logStart));
  advanceTo(1 - me);
}

// AI takeover: let the AI play the current human player's turn
function runAiTakeover() {
  if (Game.winner !== null) return;
  if (inPlacement()) { UI.log('Deploy your units first.'); UI.refresh(); return; }
  if (Game.orderQueue.length) clearAllOrders();
  const me = Game.turn;
  const logStart = (window.UI && UI.entries) ? UI.entries.length : 0;
  runAiFor(me);
  if (Game.winner === null) aiSpendAndReinforce(me);
  Game.reachable = new Map();
  persist();
  UI.refresh();
  Render.render();
  if (window.UI && UI.showEnemyMoves) UI.showEnemyMoves(UI.entries.slice(logStart));
  advanceTo(1 - me);
}

function aiUnitCount(owner) {
  return Game.units.filter(u => u.owner === owner).length;
}

function aiStackCount(owner) {
  let n = 0;
  for (const [, s] of Game.unitAt) if (s.length && s[0].owner === owner) n++;
  return n;
}

function runAiFor(me) {
  const tiles = [];
  for (const [k, s] of Game.unitAt) if (s.length && s[0].owner === me) tiles.push(k);

  const noCities = aiHasNoCities(me);
  const fewCities = aiMyCityCount(me) < 5;
  const enemy = 1 - me;

  // Aggression: if AI has significantly more units than the player, attack
  // even into defensive terrain. Threshold: AI units > player units * 1.4.
  const myUnits = aiUnitCount(me);
  const enemyUnits = aiUnitCount(enemy);
  const aggressive = myUnits > enemyUnits * 1.4;

  // Adaptive formation: if the player spreads out (many stacks), AI spreads
  // too (each stack seeks its own target independently). If the player has
  // few concentrated stacks, AI concentrates toward the nearest enemy cluster.
  const playerStacks = aiStackCount(enemy);
  const aiStacks = aiStackCount(me);
  const playerSpreading = playerStacks >= 5;
  const shouldConcentrate = !playerSpreading && playerStacks <= 3;

  for (const k0 of tiles) {
    let [r, c] = k0.split(',').map(Number);
    let group = stackAt(r, c).filter((u) => u.owner === me);
    if (!group.length) continue;

    // HQ protection: move HQ toward the friendly board edge and away from enemies.
    const hqInGroup = group.find(u => isHqUnit(u));
    if (hqInGroup && hqInGroup.movesLeft > 0) {
      Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, [hqInGroup]);
      const edgeCol = me === 0 ? 0 : Board.COLS - 1;
      let bestKey = null, bestScore = -Infinity;
      for (const kk of Game.reachable.keys()) {
        const [rr, cc] = kk.split(',').map(Number);
        const edgeDist = Math.abs(cc - edgeCol);
        const enemyNear = aiCountNeighborUnits(rr, cc, enemy);
        const friendNear = aiCountNeighborUnits(rr, cc, me);
        const score = -edgeDist * 3 - enemyNear * 10 + friendNear * 2;
        if (score > bestScore) { bestScore = score; bestKey = [rr, cc]; }
      }
      if (bestKey && (bestKey[0] !== r || bestKey[1] !== c)) {
        moveGroup([hqInGroup], bestKey[0], bestKey[1]);
      }
      group = stackAt(r, c).filter((u) => u.owner === me);
      if (!group.length) continue;
    }

    const avgHpRatio = group.reduce((s, u) => s + u.hp / u.maxHp, 0) / group.length;

    // Healing hold: below 50% HP in supply range, rest to heal.
    if (avgHpRatio < 0.5 && aiInSupplyRange(r, c, me)) continue;

    // Count nearby enemy vs friendly units for retreat decision.
    const nearbyEnemies = aiCountNeighborUnits(r, c, enemy);
    const nearbyFriendlies = aiCountNeighborUnits(r, c, me);

    // RETREAT: if surrounded by more enemies than allies, retreat to a
    // defensive tile (city/water/village/forest) for the defense buff.
    // Skip retreat when aggressive (numeric superiority).
    if (!aggressive && nearbyEnemies > nearbyFriendlies + group.length) {
      Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, group);
      let bestRetreat = null, bestRD = Infinity;
      for (const kk of Game.reachable.keys()) {
        const [rr, cc] = kk.split(',').map(Number);
        if (!isDefensiveTerrain(rr, cc)) continue;
        const enemyNear = aiCountNeighborUnits(rr, cc, enemy);
        const d = enemyNear * 100 - Rules.hexDist(rr, cc, r, c);
        if (d < bestRD) { bestRD = d; bestRetreat = [rr, cc]; }
      }
      if (!bestRetreat) {
        // No defensive tile reachable: just move to the tile with fewest adjacent enemies.
        let bestD2 = Infinity;
        for (const kk of Game.reachable.keys()) {
          const [rr, cc] = kk.split(',').map(Number);
          const en = aiCountNeighborUnits(rr, cc, enemy);
          if (en < bestD2) { bestD2 = en; bestRetreat = [rr, cc]; }
        }
      }
      if (bestRetreat) {
        moveGroup(group, bestRetreat[0], bestRetreat[1]);
      }
      continue;
    }

    // TARGET: early game or no cities → capture cities/villages for income.
    // When concentrating (player has few stacks), converge on the largest
    // enemy cluster instead of each stack's nearest enemy.
    let target;
    if (noCities || fewCities) {
      target = nearestUnownedCityOrVillage(r, c, me) || nearestEnemyTile(r, c, me);
    } else if (shouldConcentrate) {
      target = aiLargestEnemyCluster(me) || nearestEnemyTile(r, c, me);
    } else {
      target = nearestEnemyTile(r, c, me);
    }
    if (!target) break;

    if (!Rules.isHexNeighbor(r, c, target.r, target.c)) {
      Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, group);

      const wounded = avgHpRatio < 0.7;
      let best = null, bestD = Rules.hexDist(r, c, target.r, target.c);
      let targetSupply = null, bestSD = Infinity;
      let targetDry = null, bestDryD = Rules.hexDist(r, c, target.r, target.c);
      for (const kk of Game.reachable.keys()) {
        const [rr, cc] = kk.split(',').map(Number);
        const d = Rules.hexDist(rr, cc, target.r, target.c);
        if (d < bestD) { bestD = d; best = [rr, cc]; }
        if (wounded && aiInSupplyRange(rr, cc, me) && d < bestSD) { bestSD = d; targetSupply = [rr, cc]; }
        if (!Board.isWater(Game.terrain, rr, cc) && d < bestDryD) { bestDryD = d; targetDry = [rr, cc]; }
      }
      if (best && Board.isWater(Game.terrain, best[0], best[1]) && targetDry) {
        best = targetDry;
      }
      const chosen = (wounded && targetSupply) ? targetSupply : best;
      if (chosen) {
        moveGroup(group, chosen[0], chosen[1]);
        r = chosen[0]; c = chosen[1];
        group = stackAt(r, c).filter((u) => u.owner === me);
        if (noCities || fewCities) {
          target = nearestUnownedCityOrVillage(r, c, me) || nearestEnemyTile(r, c, me);
        } else if (shouldConcentrate) {
          target = aiLargestEnemyCluster(me) || nearestEnemyTile(r, c, me);
        } else {
          target = nearestEnemyTile(r, c, me);
        }
      }
    }

    // ATTACK decision: aggressive AI attacks regardless of enemy terrain;
    // otherwise don't attack enemies on strong defensive tiles.
    if (target && group.length && Rules.isHexNeighbor(r, c, target.r, target.c)) {
      const enemyTerrain = Game.terrain[target.r][target.c];
      const enemyOnDefensive = enemyTerrain === 'city' || enemyTerrain === 'village' ||
                               enemyTerrain === 'forest' || enemyTerrain === 'water';

      if (enemyOnDefensive && !aggressive) {
        // Enemy is in a strong position. Find own defensive tile and hold,
        // or retreat if we're on open ground.
        if (!isDefensiveTerrain(r, c)) {
          Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, group);
          let bestDef = null, bestDD = Infinity;
          for (const kk of Game.reachable.keys()) {
            const [rr, cc] = kk.split(',').map(Number);
            if (!isDefensiveTerrain(rr, cc)) continue;
            const d = Rules.hexDist(rr, cc, target.r, target.c);
            if (d < bestDD) { bestDD = d; bestDef = [rr, cc]; }
          }
          if (bestDef) {
            moveGroup(group, bestDef[0], bestDef[1]);
          }
        }
        // Hold position on our defensive tile — don't attack.
      } else {
        doAttack(group, target.r, target.c);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HQ Rally: move all friendly units toward a target tile
// ---------------------------------------------------------------------------
function rallyAllUnits(targetR, targetC) {
  const me = Game.turn;
  const tiles = [];
  for (const [k, s] of Game.unitAt) {
    if (s.length && s[0].owner === me) tiles.push(k);
  }
  let moved = 0;
  for (const k0 of tiles) {
    const [r, c] = k0.split(',').map(Number);
    const group = stackAt(r, c).filter(u => u.owner === me && u.movesLeft > 0 && !isHqUnit(u));
    if (!group.length) continue;
    Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, group);
    let best = null, bestD = Rules.hexDist(r, c, targetR, targetC);
    for (const kk of Game.reachable.keys()) {
      const [rr, cc] = kk.split(',').map(Number);
      if (Board.isWater(Game.terrain, rr, cc)) continue;
      const d = Rules.hexDist(rr, cc, targetR, targetC);
      if (d < bestD) { bestD = d; best = [rr, cc]; }
    }
    if (best) {
      moveGroup(group, best[0], best[1]);
      moved++;
    }
  }
  Game.reachable = new Map();
  if (moved) UI.log(`HQ rallied ${moved} stack(s) toward (${targetR},${targetC}).`);
  persist();
  return moved;
}

// ---------------------------------------------------------------------------
// Input — shared tap handling for mouse clicks and touch taps
// ---------------------------------------------------------------------------
function handleTapAt(r, c) {
  if (Game.winner !== null || !inBounds(r, c)) return;

  // Rally mode: HQ ordered all units to converge on this tile.
  if (window._rallyMode) {
    window._rallyMode = false;
    rallyAllUnits(r, c);
    UI.refresh(); Render.render();
    return;
  }

  if (inPlacement()) { placeAt(r, c); UI.refresh(); Render.render(); Render.autoZoom(); return; }

  const tileStack = stackAt(r, c);
  const committed = committedUnitIds();
  const movers = Game.selUnits.filter(u => u.owner === Game.turn && !committed.has(u.id));

  if (Game.selTile && movers.length) {
    const group = movers.filter(u => u.movesLeft > 0);
    const selR = Game.selTile.r, selC = Game.selTile.c;

    // ATTACK: tapped an enemy-held tile
    if (tileStack.length && tileStack[0].owner !== Game.turn && group.length) {
      if (Rules.isHexNeighbor(selR, selC, r, c)) {
        const path = [{ r: selR, c: selC }];
        addOrder(group, { r: selR, c: selC }, { r: selR, c: selC }, path, true, { r, c });
        UI.refresh(); Render.render();
        return;
      }
      const adj = bestAdjacentForAttack(r, c, Game.reachable, Game.unitAt, Game.turn, group.length);
      if (adj) {
        const startBudget = Math.min(...group.map(u => u.movesLeft));
        const path = getPath(selR, selC, adj.r, adj.c, startBudget);
        addOrder(group, { r: selR, c: selC }, adj, path, true, { r, c });
        UI.refresh(); Render.render();
        return;
      }
    }

    // MOVE: tapped a reachable empty/friendly tile
    if (Game.reachable.has(key(r, c)) && (!tileStack.length || tileStack[0].owner === Game.turn) && group.length) {
      const startBudget = Math.min(...group.map(u => u.movesLeft));
      const path = getPath(selR, selC, r, c, startBudget);
      addOrder(group, { r: selR, c: selC }, { r, c }, path, false, null);
      UI.refresh(); Render.render();
      return;
    }
  }

  selectTile(r, c);
  UI.refresh(); Render.render();
}

function zoomAt(clientX, clientY, factor) {
  const cam = Render.cam;
  const rect = Render.canvas.getBoundingClientRect();
  const mx = clientX - rect.left, my = clientY - rect.top;
  // World pixel under cursor
  const wpx = cam.x + mx, wpy = cam.y + my;
  // Fractional position within the board (0..1)
  const S3 = Math.sqrt(3);
  const bw = S3 * cam.cell * (Board.COLS + 0.5);
  const bh = 1.5 * cam.cell * (Board.ROWS - 1) + 2 * cam.cell;
  const fx = wpx / bw, fy = wpy / bh;
  const old = cam.cell;
  cam.cell = Math.round(Math.max(Render.MIN_CELL, Math.min(Render.MAX_CELL, cam.cell * factor)));
  if (cam.cell !== old) {
    const nbw = S3 * cam.cell * (Board.COLS + 0.5);
    const nbh = 1.5 * cam.cell * (Board.ROWS - 1) + 2 * cam.cell;
    cam.x = fx * nbw - mx;
    cam.y = fy * nbh - my;
    Render.clamp(); Render.render();
  }
}

function wireInput() {
  const cv = Render.canvas;
  const cam = Render.cam;

  // ---- mouse: drag to pan, click to act, wheel to zoom ----
  let dragging = false, dragMoved = false, lastX = 0, lastY = 0;
  cv.addEventListener('mousedown', (e) => { dragging = true; dragMoved = false; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
    cam.x -= dx; cam.y -= dy; lastX = e.clientX; lastY = e.clientY;
    Render.clamp(); Render.render();
  });
  cv.addEventListener('click', (e) => {
    if (dragMoved) return;
    const { r, c } = Render.cellFromPoint(e.clientX, e.clientY);
    handleTapAt(r, c);
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 0.87);
  }, { passive: false });

  // ---- touch (Android/mobile): one finger pans + taps, two fingers pinch-zoom ----
  let touchPan = null, pinch = null, tap = null;
  const dist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                                 e.touches[0].clientY - e.touches[1].clientY);
  cv.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchPan = { x: t.clientX, y: t.clientY };
      tap = { x: t.clientX, y: t.clientY, moved: false };
      pinch = null;
    } else if (e.touches.length === 2) {
      pinch = { d: dist(e), cx: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
      touchPan = null; tap = null;
    }
  }, { passive: false });
  cv.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && touchPan) {
      const t = e.touches[0];
      const dx = t.clientX - touchPan.x, dy = t.clientY - touchPan.y;
      if (tap && Math.abs(dx) + Math.abs(dy) > 6) tap.moved = true;
      cam.x -= dx; cam.y -= dy; touchPan = { x: t.clientX, y: t.clientY };
      Render.clamp(); Render.render();
    } else if (e.touches.length === 2 && pinch) {
      const d = dist(e);
      if (pinch.d > 0) zoomAt(pinch.cx, pinch.cy, d / pinch.d);
      pinch.d = d;
    }
  }, { passive: false });
  cv.addEventListener('touchend', (e) => {
    if (tap && !tap.moved && e.touches.length === 0) {
      const { r, c } = Render.cellFromPoint(tap.x, tap.y);
      handleTapAt(r, c);
    }
    touchPan = null; pinch = null; tap = null;
  }, { passive: false });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  const intent = SaveState.takeIntent();
  let st;
  if (intent && intent.action === 'new') {
    const mode = intent.mode || 'pvp';
    const start = intent.start === 1 ? 1 : 0;
    const aiPlayer = mode === 'pve' ? (intent.human === 1 ? 0 : 1) : null;
    if (intent.customMap) {
      st = buildCustomMapState(mode, intent.customMap, intent.creative, start, aiPlayer, intent.difficulty);
    } else {
      st = buildInitialState(mode, Math.floor(Math.random() * 1e9), intent.rows, intent.cols, intent.creative, start, aiPlayer, intent.difficulty, intent.startUnits, intent.randomStart);
    }
    SaveState.save(st);
  } else {
    st = SaveState.load();
    if (!st) { st = buildInitialState('pvp', Math.floor(Math.random() * 1e9)); SaveState.save(st); }
  }
  loadIntoGame(st);
  Render.resize();
  Render.autoZoom(); // small boards: fill the viewport (also after buy/upgrade returns here)
  UI.refresh();
  // If the AI is set to move first, let it take its opening turn immediately.
  if (Game.mode === 'pve' && Game.winner === null && Game.turn === Game.aiPlayer) runAiTurn();
}

window.addEventListener('resize', () => Render.resize());
wireInput();
boot();

// expose for the page buttons / sidebar controls
window.Game = Game;
window.nextRound = nextRound;
window.inPlacement = inPlacement;
window.pendingForTurn = pendingForTurn;
window.setSelectAll = setSelectAll;
window.toggleUnitInSelection = toggleUnitInSelection;
window.selectNextWithMoves = selectNextWithMoves;
window.isUnlocked = isUnlocked;
window.unlockType = unlockType;
window.templateStats = templateStats;
window.templateCost = templateCost;
window.templateComp = templateComp;
window.templateSize = templateSize;
window.canRefitUnit = canRefitUnit;
window.unitCostFromParts = unitCostFromParts;
window.refitUnitsTo = refitUnitsTo;
window.canBuild = canBuild;
window.buildStructure = buildStructure;
window.structureAt = structureAt;
window.canSplitUnit = canSplitUnit;
window.splitUnit = splitUnit;
window.totalSubunits = totalSubunits;
window.canCombineUnits = canCombineUnits;
window.combineUnits = combineUnits;
window.selectTile = selectTile;
window.isHqUnit = isHqUnit;
window.rallyAllUnits = rallyAllUnits;
window.executeOrders = executeOrders;
window.clearAllOrders = clearAllOrders;
window.committedUnitIds = committedUnitIds;
window.runAiTakeover = runAiTakeover;
// Creative-mode cheat: hand the current player a pile of gold.
window.creativeGrant = function () {
  if (!Game.creative || Game.winner !== null) return;
  Game.economy[Game.turn] += 171717;
  persist();
  UI.refresh();
};
window.startNewGame = (mode) => { SaveState.setIntent({ action: 'new', mode }); location.reload(); };
