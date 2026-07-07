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
};
let nextId = 1;
// Consecutive eliminated turns a side must endure before it loses (see checkWinner).
const LOSE_TURNS = 3;

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
  persist();
  return true;
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
function claimPath(owner, sr, sc, dr, dc, startBudget) {
  const reach = Game.reachable;
  const k = (r, c) => r + ',' + c;
  let cr = dr, cc = dc, guard = 0;
  claimTile(cr, cc, owner);
  while (!(cr === sr && cc === sc) && guard++ < 100000) {
    const cur = reach.has(k(cr, cc)) ? reach.get(k(cr, cc)) : startBudget;
    const cost = TERRAIN[Game.terrain[cr][cc]].move_cost;
    let prev = null;
    for (const [ddr, ddc] of Rules.DIRS) {
      const pr = cr + ddr, pc = cc + ddc;
      if (!inBounds(pr, pc)) continue;
      if (!Rules.canStep(Game.terrain, pr, pc, cr, cc)) continue;
      const isStart = pr === sr && pc === sc;
      const pv = isStart ? startBudget : (reach.has(k(pr, pc)) ? reach.get(k(pr, pc)) : null);
      if (pv == null) continue;
      if (pv - cost === cur) { prev = [pr, pc]; if (isStart) break; }
    }
    if (!prev) break;
    cr = prev[0]; cc = prev[1];
    claimTile(cr, cc, owner);
  }
}

// How many units the player-to-move still has to deploy.
function pendingForTurn() { return Game.toPlace.filter((s) => s.owner === Game.turn).length; }
function inPlacement() { return pendingForTurn() > 0; }

// ---------------------------------------------------------------------------
// State (de)serialization — bridges localStorage and the runtime Game
// ---------------------------------------------------------------------------
function serialize() {
  return {
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
    pendingSpawns: [], // always flushed into toPlace once applied
  };
}
function cloneTemplate(t) { return { id: t.id, name: t.name, cells: (t.cells || []).slice() }; }

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
function buildInitialState(mode, seed, rows, cols, creative, startPlayer, aiPlayer, difficulty) {
  const { terrain, cities, villages } = Board.fromSeed(seed, rows || Algorithms.GRID, cols || Algorithms.GRID);
  const templates = [defaultTemplates(), defaultTemplates()];
  const units = buildInitialArmies(terrain, templates);
  const ai = mode === 'pve' ? ((aiPlayer === 0 || aiPlayer === 1) ? aiPlayer : 1) : null;
  // PvE difficulty tunes gold income: easy gives the human +10%, hard gives the
  // AI +17%, normal leaves both at 1×. Percentages land on whole gold thanks to
  // the ×10-scaled economy (see units.js).
  const diff = (difficulty === 'easy' || difficulty === 'hard') ? difficulty : 'normal';
  const incomeMult = [1, 1];
  if (ai !== null) {
    const human = ai === 0 ? 1 : 0;
    if (diff === 'easy') incomeMult[human] = 1.10;
    else if (diff === 'hard') incomeMult[ai] = 1.17;
  }
  return {
    seed, mode, rows: Board.ROWS, cols: Board.COLS,
    turn: startPlayer === 1 ? 1 : 0, round: 1,
    creative: !!creative, aiPlayer: ai,
    difficulty: diff, incomeMult,
    noUnitTurns: [0, 0], noCityTurns: [0, 0],
    economy: [ECONOMY.start, ECONOMY.start],
    territory: buildInitialTerritory(Board.ROWS, Board.COLS)
      .map((row) => row.map((v) => (v === 0 ? '0' : v === 1 ? '1' : '.')).join('')),
    cities, villages: villages || [], units, toPlace: [], upgrades: [{}, {}],
    unlocked: [{ infantry: true }, { infantry: true }],
    ecoUpgrades: [{}, {}],
    templates, pendingSpawns: [],
  };
}

// Seed each player's starting force: ONE unit built from their default Infantry
// template (4 infantry subunits), placed at the center of that player's
// deployment zone (nudged off water). Everything else must be researched (tech
// tree), designed (templates) and bought (buy page).
function buildInitialArmies(terrain, templates) {
  const units = [];
  const dry = (r, c) => inBounds(r, c) && terrain[r][c] !== 'water';
  // Nearest dry tile to (r,c), scanning outward along the column.
  const dryNear = (r, c) => {
    if (dry(r, c)) return { r, c };
    for (let d = 1; d <= 12; d++) {
      if (dry(r + d, c)) return { r: r + d, c };
      if (dry(r - d, c)) return { r: r - d, c };
    }
    return { r, c };
  };

  const rows = Board.ROWS, cols = Board.COLS, zone = Board.zone();
  const midRow = Math.floor(rows / 2);
  // Center-most column of each player's spawn zone (Blue left, Red right).
  const cLeft = Math.floor((zone - 1) / 2);
  const cRight = cols - 1 - Math.floor((zone - 1) / 2);
  const spots = [dryNear(midRow, cLeft), dryNear(midRow, cRight)];

  for (let owner = 0; owner < 2; owner++) {
    const tmpl = templates[owner][0]; // the default Infantry template
    const u = makeUnitFromTemplate(owner, tmpl, spots[owner].r, spots[owner].c, { acted: false });
    if (u) units.push(u);
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
  // Restore board size (old saves predate this and default to 100x100).
  Game.terrain = Board.fromSeed(st.seed, st.rows || Algorithms.GRID, st.cols || Algorithms.GRID).terrain;
  // Territory grid (old saves predate this: rebuild from the deployment zones).
  Game.territory = deserializeTerritory(Board.ROWS, Board.COLS, st.territory);
  Game.turn = st.turn || 0;
  Game.round = st.round || 1;
  Game.economy = (st.economy || [ECONOMY.start, ECONOMY.start]).slice();
  Game.cities = (st.cities || []).map((c) => ({ ...c }));
  Game.villages = (st.villages || []).map((v) => ({ ...v }));
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
  rebuildUnitAt();
  nextId = Game.units.reduce((m, u) => Math.max(m, u.id), 0) + 1;
  Game.winner = null;
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
    if (Math.abs(s.r - r) + Math.abs(s.c - c) <= dist) return true;
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
  if (nearOwnedSite(u.r, u.c, Game.cities, u.owner, range.city) ||
      nearOwnedSite(u.r, u.c, Game.villages, u.owner, range.village)) {
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
    UI.log('That template needs a subunit you have not researched yet.');
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
// Apply `total` damage to a stack (array of units), front-to-back. Mutates the
// passed array and the global Game.units/unitAt. Returns units destroyed.
function applyDamage(stack, total) {
  let killed = 0;
  while (total > 0 && stack.length) {
    const u = stack[0];
    if (u.hp > total) { u.hp -= total; total = 0; }
    else {
      total -= u.hp;
      stack.shift();
      removeFromStack(u);
      Game.units = Game.units.filter((x) => x !== u);
      killed++;
    }
  }
  return killed;
}

function doAttack(attackers, tr, tc) {
  const defenders = stackAt(tr, tc).slice();
  if (!defenders.length || defenders[0].owner === attackers[0].owner) return;
  const acting = attackers.filter((u) => !u.acted && u.owner === Game.turn);
  if (!acting.length) { UI.log('Those units have already attacked.'); return; }

  const { dmgToDef, dmgToAtk, defSurrounded, atkSurrounded } =
    Rules.resolveCombat(Game.terrain, acting, defenders, Game.territory);
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
  // Surrounded-territory double-damage notes.
  let surrNote = '';
  if (defSurrounded) surrNote += ` [${PLAYERS[foe].name} surrounded: ×2 taken]`;
  if (atkSurrounded) surrNote += ` [${PLAYERS[Game.turn].name} surrounded: ×2 taken]`;

  UI.log(`${PLAYERS[Game.turn].name} (${acting.length + atkKilled}) struck ` +
    `${PLAYERS[foe].name} for ${dmgToDef} (took ${dmgToAtk} back). ` +
    `Destroyed ${defKilled} / lost ${atkKilled}.${terrainNote}${surrNote}`);
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
  for (let p = 0; p < 2; p++) {
    if (Game.noUnitTurns[p] >= LOSE_TURNS || Game.noCityTurns[p] >= LOSE_TURNS) {
      Game.winner = 1 - p;
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
  const enemy = 1 - u.owner;
  if (Rules.surroundedBy(Game.territory, u.r, u.c, enemy)) return false;
  const range = (unitHasType(u, 'cavalry') || unitHasType(u, 'tank')) ? REGEN.heavyRange : REGEN.range;
  return nearOwnedSite(u.r, u.c, Game.cities, u.owner, range.city) ||
         nearOwnedSite(u.r, u.c, Game.villages, u.owner, range.village);
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

  UI.log(`${PLAYERS[owner].name} split ${created.length} subunit(s) off ${u.name}.`);
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

  UI.log(`${PLAYERS[fill.owner].name} combined ${taken} subunit(s) from ${material.name || PIECES[material.type].name} into ${fill.name || PIECES[fill.type].name}.`);
  persist();
  return taken;
}

// ---------------------------------------------------------------------------
function clearSelection() { Game.selTile = null; Game.selUnits = []; Game.reachable = new Map(); }

// Recompute reachable tiles for the units in the current selection that can move.
function recomputeReachable() {
  const g = Game.selUnits.filter((u) => u.owner === Game.turn && u.movesLeft > 0);
  Game.reachable = g.length ? Rules.reachable(Game.terrain, Game.unitAt, g) : new Map();
}

// Inspect a tile: select its whole stack (subset can be unchecked in sidebar).
function selectTile(r, c) {
  const s = stackAt(r, c);
  if (!s.length) { clearSelection(); return; }
  Game.selTile = { r, c };
  Game.selUnits = s.slice();
  recomputeReachable();
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
// number of points; stacks merge at the destination.
function moveGroup(group, r, c) {
  const left = Game.reachable.get(key(r, c));
  if (left === undefined) return false;
  const startBudget = Math.min(...group.map((u) => u.movesLeft));
  const spent = startBudget - left;
  const owner = group[0].owner;
  const sr = group[0].r, sc = group[0].c;
  // Paint the traversed path (and destination) into the mover's territory.
  claimPath(owner, sr, sc, r, c, startBudget);
  for (const u of group) {
    removeFromStack(u);
    u.r = r; u.c = c;
    u.movesLeft = Math.max(0, u.movesLeft - spent);
    u.moved = true; // moved this turn -> no HP regen next turn
    addToStack(u);
  }
  captureIfCity(r, c, owner);
  return true;
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
  advanceTo(1 - Game.turn);
}

// ---------------------------------------------------------------------------
// PvE AI: each of the AI's stacks marches toward the nearest enemy and attacks.
// ---------------------------------------------------------------------------
function nearestEnemyTile(r, c, owner) {
  let best = null, bestD = Infinity;
  for (const [k, s] of Game.unitAt) {
    if (!s.length || s[0].owner === owner) continue;
    const [er, ec] = k.split(',').map(Number);
    const d = Math.abs(er - r) + Math.abs(ec - c);
    if (d < bestD) { bestD = d; best = { r: er, c: ec }; }
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

// Greedily spend the AI's gold on UNLOCKED subunits, packaged into UNITS. Each
// unit is a small single-type template (up to 4 subunits); types are cycled for
// variety. Returns unit specs [{type, size}]. Mirrors the buy page's cost model.
function aiBuyUnits(me) {
  const roster = Object.keys(PIECES)
    .filter((t) => isUnlocked(me, t))
    .sort((a, b) => PIECES[a].cost - PIECES[b].cost);
  if (!roster.length) return [];
  const cheapest = PIECES[roster[0]].cost;
  const units = [];
  let budget = Game.economy[me];
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

// The AI researches the cheapest still-locked subunit it can comfortably afford,
// so over time it fields more than just infantry. Keeps a reserve for units.
function aiResearchTech(me) {
  if (typeof TECH === 'undefined') return;
  const locked = Object.keys(TECH)
    .filter((t) => !isUnlocked(me, t))
    .sort((a, b) => TECH[a] - TECH[b]);
  for (const t of locked) {
    // Only unlock if it still leaves some gold to actually build the new type.
    if (Game.economy[me] >= TECH[t] + PIECES[t].cost) { unlockType(me, t); break; }
  }
}

// Deploy AI unit specs into `me`'s zone, one unit per tile-slot, filling tiles
// closest to (threatRow, front column) first and spilling outward.
function aiDeployUnits(me, specs) {
  if (!specs.length) return 0;
  const cols = COLS(), rows = ROWS(), zone = ZONE();
  const frontCol = me === 1 ? cols - zone : zone - 1; // zone edge facing the enemy
  const targetRow = aiThreatRow(me);

  // Candidate tiles in the zone, nearest the threat first (row distance, then
  // depth back from the front). Skip water and enemy-held tiles.
  const cands = [];
  for (let c = 0; c < cols; c++) {
    if (!inZone(me, c)) continue;
    for (let r = 0; r < rows; r++) {
      if (Game.terrain[r][c] === 'water') continue;
      const s = stackAt(r, c);
      if (s.length && s[0].owner !== me) continue;
      cands.push({ r, c, d: Math.abs(r - targetRow) * 2 + Math.abs(c - frontCol) });
    }
  }
  cands.sort((a, b) => a.d - b.d);

  let placed = 0;
  for (const spec of specs) {
    if (!spec.size) continue;
    const dest = cands.find((cand) => stackAt(cand.r, cand.c).length < Rules.STACK_LIMIT);
    if (!dest) break; // zone full — refund the rest
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
  aiResearchTech(me); // occasionally unlock a new subunit before spending
  const specs = aiBuyUnits(me);
  const placed = aiDeployUnits(me, specs);
  if (placed) {
    const counts = {};
    for (let i = 0; i < placed; i++) counts[specs[i].type] = (counts[specs[i].type] || 0) + specs[i].size;
    const names = Object.keys(counts).map((t) => `${PIECES[t].name} ×${counts[t]}`);
    UI.log(`${PLAYERS[me].name} reinforced with ${names.join(', ')}.`);
  }
}

function runAiTurn() {
  const me = Game.aiPlayer;
  const logStart = (window.UI && UI.entries) ? UI.entries.length : 0;
  const tiles = [];
  for (const [k, s] of Game.unitAt) if (s.length && s[0].owner === me) tiles.push(k);

  for (const k0 of tiles) {
    let [r, c] = k0.split(',').map(Number);
    let group = stackAt(r, c).filter((u) => u.owner === me);
    if (!group.length) continue;
    let enemy = nearestEnemyTile(r, c, me);
    if (!enemy) break;

    if (Math.abs(enemy.r - r) + Math.abs(enemy.c - c) !== 1) {
      Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, group);
      let target = null, bestD = Math.abs(r - enemy.r) + Math.abs(c - enemy.c);
      for (const kk of Game.reachable.keys()) {
        const [rr, cc] = kk.split(',').map(Number);
        const d = Math.abs(rr - enemy.r) + Math.abs(cc - enemy.c);
        if (d < bestD) { bestD = d; target = [rr, cc]; }
      }
      if (target) {
        moveGroup(group, target[0], target[1]);
        r = target[0]; c = target[1];
        group = stackAt(r, c).filter((u) => u.owner === me);
        enemy = nearestEnemyTile(r, c, me);
      }
    }
    if (enemy && group.length && Math.abs(enemy.r - r) + Math.abs(enemy.c - c) === 1) {
      doAttack(group, enemy.r, enemy.c);
    }
  }
  if (Game.winner === null) aiSpendAndReinforce(me); // buy + deploy reinforcements
  Game.reachable = new Map();
  persist();
  UI.refresh();
  Render.render();
  // Show what the enemy did this turn as a pop-up (if the Combat log is on).
  if (window.UI && UI.showEnemyMoves) UI.showEnemyMoves(UI.entries.slice(logStart));
  advanceTo(1 - me); // hand control back to the human
}

// ---------------------------------------------------------------------------
// Input — shared tap handling for mouse clicks and touch taps
// ---------------------------------------------------------------------------
function handleTapAt(r, c) {
  if (Game.winner !== null || !inBounds(r, c)) return;

  // Placement mode: taps deploy bought units into the player's zone.
  if (inPlacement()) { placeAt(r, c); UI.refresh(); Render.render(); Render.autoZoom(); return; }

  const tileStack = stackAt(r, c);
  const movers = Game.selUnits.filter((u) => u.owner === Game.turn);

  if (Game.selTile && movers.length) {
    // Attack: tapped an adjacent enemy-held tile.
    if (tileStack.length && tileStack[0].owner !== Game.turn &&
        Math.abs(Game.selTile.r - r) + Math.abs(Game.selTile.c - c) === 1) {
      doAttack(movers, r, c);
      persist();
      Game.selUnits = Game.selUnits.filter((u) => Game.units.includes(u));
      if (Game.selUnits.length) recomputeReachable(); else clearSelection();
      UI.refresh(); Render.render(); Render.autoZoom(); return;
    }
    // Move: tapped a reachable (own/empty) tile.
    if (Game.reachable.has(key(r, c)) && (!tileStack.length || tileStack[0].owner === Game.turn)) {
      const group = movers.filter((u) => u.movesLeft > 0);
      if (group.length && moveGroup(group, r, c)) {
        persist();
        Game.selTile = { r, c };
        Game.selUnits = group;
        recomputeReachable();
        UI.refresh(); Render.render(); Render.autoZoom(); return;
      }
    }
  }

  // Otherwise inspect the tapped tile.
  if (tileStack.length) selectTile(r, c); else clearSelection();
  UI.refresh(); Render.render();
}

function zoomAt(clientX, clientY, factor) {
  const cam = Render.cam;
  const rect = Render.canvas.getBoundingClientRect();
  const mx = clientX - rect.left, my = clientY - rect.top;
  const wx = (cam.x + mx) / cam.cell, wy = (cam.y + my) / cam.cell;
  const old = cam.cell;
  cam.cell = Math.round(Math.max(Render.MIN_CELL, Math.min(Render.MAX_CELL, cam.cell * factor)));
  if (cam.cell !== old) { cam.x = wx * cam.cell - mx; cam.y = wy * cam.cell - my; Render.clamp(); Render.render(); }
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
    const start = intent.start === 1 ? 1 : 0;               // which side moves first
    // In PvE the human picks a side; the AI takes the other. `human` defaults to
    // Blue (0), so the AI defaults to Red (1) — the classic setup.
    const aiPlayer = mode === 'pve' ? (intent.human === 1 ? 0 : 1) : null;
    st = buildInitialState(mode, Math.floor(Math.random() * 1e9), intent.rows, intent.cols, intent.creative, start, aiPlayer, intent.difficulty);
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
window.canSplitUnit = canSplitUnit;
window.splitUnit = splitUnit;
window.totalSubunits = totalSubunits;
window.canCombineUnits = canCombineUnits;
window.combineUnits = combineUnits;
window.selectTile = selectTile;
// Creative-mode cheat: hand the current player a pile of gold.
window.creativeGrant = function () {
  if (!Game.creative || Game.winner !== null) return;
  Game.economy[Game.turn] += 171717;
  persist();
  UI.refresh();
};
window.startNewGame = (mode) => { SaveState.setIntent({ action: 'new', mode }); location.reload(); };
