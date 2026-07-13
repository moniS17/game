/*
 * game.js — game state, turns, economy, persistence, and boot.
 *
 * This is the orchestrator. It owns the live Game state and connects the
 * separated modules:
 *   units.js      - unit / player / economy data
 *   board.js      - terrain + board helpers
 *   algorithms.js - map generation
 *   rules.js      - movement & combat rules (no rules live here)
 *   render.js     - all canvas drawing
 *   state.js      - localStorage persistence
 *   ai.js         - PvE artificial intelligence
 *   input.js      - mouse/touch input handling
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
  cities: [],           // [{r, c, owner}]  owner: 0..N-1 | null (neutral)
  villages: [],         // [{r, c, owner}]  capturable; each pays 50% of a city
  structures: [],       // [{type, r, c, owner}]  fort / supply hub — built by players
  units: [],            // Unit[] — board pieces built from templates (see makeUnitFromTemplate)
  unitAt: new Map(),    // "r,c" -> Unit[]  (a stack, all same owner)
  territory: [],        // ROWS×COLS grid of 0..N-1 | null — which player owns each tile's colour

  playerCount: 2,
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
  eliminated: new Set(),
  diplomacy: [],        // NxN matrix: diplomacy[a][b] = 'war' | 'peace' | 'alliance'
  damageDealt: [],      // NxN matrix: accumulated combat damage for peace deals
  aiStrategy: [],       // per-player: 'attack' | 'defend' | 'balanced' | null
  spawnCenters: [],     // [{r,c}] per-player spawn center for circle-based deployment
  noUnitTurns: [0, 0],
  noCityTurns: [0, 0],
  winner: null,
  winReason: null,
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
  // Primary subunit (drawn on the board): >50% majority wins; fallback to most numerous, ties broken by cost.
  const total = templateSize(tmpl);
  let primary = null, best = -1;
  for (const type in comp) {
    if (comp[type] * 2 > total) { primary = type; break; }
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
// A player's default starting template library: one "Infantry" regiment (4 battalions of 4 infantry = 16 companies).
function defaultTemplates() {
  const cells = new Array(TEMPLATE_CELLS).fill(null);
  for (let i = 0; i < 16; i++) cells[i] = 'infantry';
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

// Placement-zone test for a column: each player gets cols/N columns.
function inZone(owner, c, r) {
  if (Game.spawnCenters && Game.spawnCenters.length > owner) {
    if (r == null) return Game.territory.some(row => row[c] === owner);
    return Game.territory[r] && Game.territory[r][c] === owner;
  }
  const n = Game.playerCount || 2;
  const cols = COLS();
  const c0 = Math.floor(owner * cols / n);
  const c1 = Math.floor((owner + 1) * cols / n);
  return c >= c0 && c < c1;
}

// Diplomacy helpers
function initDiplomacy(n) {
  const d = [];
  for (let i = 0; i < n; i++) {
    d[i] = [];
    for (let j = 0; j < n; j++) d[i][j] = i === j ? 'self' : 'war';
  }
  return d;
}
function initDamageDealt(n) {
  const d = [];
  for (let i = 0; i < n; i++) { d[i] = []; for (let j = 0; j < n; j++) d[i][j] = 0; }
  return d;
}
function isAtWar(a, b) {
  if (a === b) return false;
  return !Game.diplomacy.length || !Game.diplomacy[a] || Game.diplomacy[a][b] === 'war';
}
function isAlly(a, b) {
  if (a === b) return true;
  return Game.diplomacy.length && Game.diplomacy[a] && Game.diplomacy[a][b] === 'alliance';
}
function setDiplomacy(a, b, state) {
  if (!Game.diplomacy.length) return;
  Game.diplomacy[a][b] = state;
  Game.diplomacy[b][a] = state;
}
function getEnemies(player) {
  const enemies = [];
  for (let i = 0; i < Game.playerCount; i++) {
    if (i !== player && !Game.eliminated.has(i) && isAtWar(player, i)) enemies.push(i);
  }
  return enemies;
}
function getAllies(player) {
  const allies = [];
  for (let i = 0; i < Game.playerCount; i++) {
    if (i !== player && !Game.eliminated.has(i) && isAlly(player, i)) allies.push(i);
  }
  return allies;
}
function nextPlayer(current) {
  const n = Game.playerCount || 2;
  for (let i = 1; i <= n; i++) {
    const p = (current + i) % n;
    if (!Game.eliminated.has(p)) return p;
  }
  return current;
}
function firstSurvivingPlayer() {
  for (let i = 0; i < (Game.playerCount || 2); i++) {
    if (!Game.eliminated.has(i)) return i;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Territory — a per-tile ownership grid (0..N-1 | null) painted in each player's
// colour. Each side's deployment zone starts claimed; moving units paint their
// path and destination, and deploying claims the drop tile. Combat uses it for
// the "surrounded by enemy colour" double-damage rule (rules.js).
// ---------------------------------------------------------------------------
// Compute spawn-center positions for each player.
// `random` = true  → scatter randomly with min distance max(rows,cols)/n.
// `random` = false → place at corners/edges first, then along edges if >4.
function computeSpawnCenters(rows, cols, n, random, rng) {
  const inB = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols;
  const margin = (dim) => Math.max(1, Math.floor(dim * 0.12));

  if (!random) {
    // Fixed positions: corners first, then edge midpoints, then subdivide.
    const mr = margin(rows), mc = margin(cols);
    const fixed = [
      { r: mr, c: mc },                              // top-left
      { r: rows - 1 - mr, c: cols - 1 - mc },        // bottom-right
      { r: mr, c: cols - 1 - mc },                    // top-right
      { r: rows - 1 - mr, c: mc },                    // bottom-left
      { r: mr, c: Math.floor(cols / 2) },             // top-mid
      { r: rows - 1 - mr, c: Math.floor(cols / 2) },  // bottom-mid
      { r: Math.floor(rows / 2), c: mc },             // mid-left
      { r: Math.floor(rows / 2), c: cols - 1 - mc },  // mid-right
    ];
    return fixed.slice(0, n);
  }

  // Random placement with minimum separation.
  const minDist = Math.floor(Math.max(rows, cols) / n);
  const centers = [];
  const mr = margin(rows), mc = margin(cols);
  for (let owner = 0; owner < n; owner++) {
    let best = null, bestMin = -1;
    for (let attempt = 0; attempt < 5000; attempt++) {
      const r = mr + Math.floor(rng() * (rows - 2 * mr));
      const c = mc + Math.floor(rng() * (cols - 2 * mc));
      let nearest = Infinity;
      for (const prev of centers) {
        const d = Math.abs(prev.r - r) + Math.abs(prev.c - c);
        if (d < nearest) nearest = d;
      }
      if (nearest >= minDist) { centers.push({ r, c }); best = null; break; }
      if (nearest > bestMin) { bestMin = nearest; best = { r, c }; }
    }
    if (best) centers.push(best); // fallback: best we found
  }
  return centers;
}

// Compute the spawn radius so the initial circle is proportional to the board.
// Returns a hex radius guaranteed ≥ 2 (so the circle always covers several tiles).
function spawnRadius(rows, cols, n) {
  const dim = Math.min(rows, cols);
  // Scale: at 34×34 with 2 players → radius ~4; at 100×100 with 2 → ~12.
  const raw = Math.floor(dim / (n + 2));
  return Math.max(2, Math.min(raw, Math.floor(dim / 3)));
}

function buildInitialTerritory(rows, cols, n, centers) {
  n = n || Game.playerCount || 2;
  const grid = [];
  for (let r = 0; r < rows; r++) grid.push(new Array(cols).fill(null));

  if (!centers || !centers.length) {
    // Legacy fallback: column-band territory.
    for (let r = 0; r < rows; r++) {
      for (let p = 0; p < n; p++) {
        const c0 = Math.floor(p * cols / n);
        const c1 = Math.floor((p + 1) * cols / n);
        const zoneW = Math.max(1, Math.min(17, Math.floor((c1 - c0) / 3)));
        for (let c = c0; c < c0 + zoneW && c < c1; c++) grid[r][c] = p;
      }
    }
    return grid;
  }

  // Voronoi-style territory: each tile within spawn radius goes to the nearest
  // center (by hex distance), breaking ties by lower player index.
  const rad = spawnRadius(rows, cols, n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let bestP = -1, bestD = Infinity;
      for (let p = 0; p < n; p++) {
        const d = Rules.hexDist(centers[p].r, centers[p].c, r, c);
        if (d <= rad && d < bestD) { bestD = d; bestP = p; }
      }
      if (bestP >= 0) grid[r][c] = bestP;
    }
  }

  // Equalize territory sizes: trim each player to the smallest count so every
  // country starts with the same area.
  const counts = new Array(n).fill(0);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) if (grid[r][c] !== null) counts[grid[r][c]]++;
  const target = Math.min(...counts);
  for (let p = 0; p < n; p++) {
    if (counts[p] <= target) continue;
    // Collect this player's tiles sorted by descending distance from center.
    const tiles = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        if (grid[r][c] === p) tiles.push({ r, c, d: Rules.hexDist(centers[p].r, centers[p].c, r, c) });
    tiles.sort((a, b) => b.d - a.d);
    const excess = counts[p] - target;
    for (let i = 0; i < excess; i++) grid[tiles[i].r][tiles[i].c] = null;
  }
  return grid;
}
function claimTile(r, c, owner) {
  if (!inBounds(r, c)) return;
  if (!Game.territory[r]) Game.territory[r] = new Array(COLS()).fill(null);
  Game.territory[r][c] = owner;
}
// Compact save form: one string per row, chars '0'–'7' for owners, '.' for null.
function serializeTerritory() {
  return (Game.territory || []).map((row) =>
    row.map((v) => (v != null && v >= 0 && v <= 7 ? String(v) : '.')).join(''));
}
function deserializeTerritory(rows, cols, data) {
  if (!Array.isArray(data) || data.length !== rows) return buildInitialTerritory(rows, cols, Game.playerCount || 2);
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const s = data[r] || '';
    const row = new Array(cols).fill(null);
    for (let c = 0; c < cols; c++) {
      const ch = s[c];
      if (ch >= '0' && ch <= '7') row[c] = Number(ch);
      else row[c] = null;
    }
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
  const n = Game.playerCount || 2;
  const out = {
    seed: Game.seed,
    rows: Board.ROWS,
    cols: Board.COLS,
    mode: Game.mode,
    playerCount: n,
    turn: Game.turn,
    round: Game.round,
    creative: Game.creative,
    aiPlayer: Game.aiPlayer,
    difficulty: Game.difficulty,
    incomeMult: (Game.incomeMult || []).slice(),
    noUnitTurns: (Game.noUnitTurns || []).slice(),
    noCityTurns: (Game.noCityTurns || []).slice(),
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
    upgrades: Game.upgrades.map(u => ({ ...u })),
    ecoUpgrades: (Game.ecoUpgrades || []).map(e => ({ ...e })),
    unlocked: Game.unlocked.map(u => ({ ...u })),
    templates: Game.templates.map(arr => (arr || []).map(cloneTemplate)),
    pendingSpawns: [],
    eliminated: [...Game.eliminated],
    diplomacy: Game.diplomacy.map(row => row.slice()),
    damageDealt: Game.damageDealt.map(row => row.slice()),
    aiStrategy: (Game.aiStrategy || []).slice(),
    players: PLAYERS.map(p => ({ name: p.name, color: p.color })),
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
function buildInitialState(mode, seed, rows, cols, creative, startPlayer, aiPlayer, difficulty, startUnits, randomStart, playerCount, playerNames) {
  const maxP = Algorithms.maxPlayers(rows || Algorithms.GRID, cols || Algorithms.GRID);
  const n = Math.min(maxP, playerCount || 2);
  if (playerNames) window.initPlayers(n, playerNames);
  else window.initPlayers(n);
  const { terrain, cities, villages } = Board.fromSeed(seed, rows || Algorithms.GRID, cols || Algorithms.GRID, n);
  const templates = [];
  for (let i = 0; i < n; i++) { templates.push(defaultTemplates()); templates[i].push(makeHqTemplate()); }
  const count = (startUnits != null && startUnits >= 0) ? startUnits : 1;

  // Compute spawn centers using seeded PRNG.
  const spawnRng = Algorithms.makeRng(seed || 0);
  const centers = computeSpawnCenters(Board.ROWS, Board.COLS, n, randomStart !== false, spawnRng);

  // Assign cities/villages to the nearest spawn center (within spawn radius).
  const rad = spawnRadius(Board.ROWS, Board.COLS, n);
  for (const site of cities.concat(villages || [])) {
    let bestOwner = null, bestDist = Infinity;
    for (let p = 0; p < n; p++) {
      const d = Rules.hexDist(centers[p].r, centers[p].c, site.r, site.c);
      if (d <= rad && d < bestDist) { bestDist = d; bestOwner = p; }
    }
    site.owner = bestOwner;
  }

  const territoryGrid = buildInitialTerritory(Board.ROWS, Board.COLS, n, centers);
  const units = buildInitialArmies(terrain, templates, count, centers, seed, n, cities, territoryGrid);
  const ai = mode === 'pve' ? ((aiPlayer === 0 || aiPlayer === 1) ? aiPlayer : 1) : null;
  const diff = (difficulty === 'easy' || difficulty === 'hard') ? difficulty : 'normal';
  const incomeMult = new Array(n).fill(1);
  if (ai !== null) {
    const aiMult = diff === 'easy' ? 0.17 : diff === 'hard' ? 1.7 : 1;
    for (let i = 0; i < n; i++) if (i !== (n > 2 ? 0 : (1 - ai))) incomeMult[i] = aiMult;
  }
  const startGold = new Array(n).fill(ECONOMY.start);
  if (ai !== null) {
    for (let i = 0; i < n; i++) if (i !== (n > 2 ? 0 : (1 - ai))) startGold[i] = 170;
  }
  return {
    seed, mode, rows: Board.ROWS, cols: Board.COLS, playerCount: n,
    turn: startPlayer === 1 ? 1 : 0, round: 1,
    creative: !!creative, aiPlayer: ai,
    difficulty: diff, incomeMult,
    noUnitTurns: new Array(n).fill(0), noCityTurns: new Array(n).fill(0),
    economy: startGold,
    territory: territoryGrid
      .map((row) => row.map((v) => (v != null ? String(v) : '.')).join('')),
    cities, villages: villages || [], structures: [], units, toPlace: [],
    upgrades: Array.from({ length: n }, () => ({})),
    unlocked: Array.from({ length: n }, () => ({ infantry: true })),
    ecoUpgrades: Array.from({ length: n }, () => ({})),
    templates, pendingSpawns: [],
    eliminated: [],
    diplomacy: initDiplomacy(n),
    damageDealt: initDamageDealt(n),
    aiStrategy: new Array(n).fill(null),
    spawnCenters: centers,
    players: PLAYERS.map(p => ({ name: p.name, color: p.color })),
  };
}

function buildCustomMapState(mode, customMap, creative, startPlayer, aiPlayer, difficulty, playerCount, playerNames) {
  const n = playerCount || 2;
  if (playerNames) window.initPlayers(n, playerNames);
  else window.initPlayers(n);
  const rows = customMap.rows, cols = customMap.cols;
  Board.setDims(rows, cols);
  const diff = (difficulty === 'easy' || difficulty === 'hard') ? difficulty : 'normal';
  const ai = mode === 'pve' ? ((aiPlayer === 0 || aiPlayer === 1) ? aiPlayer : 1) : null;
  const incomeMult = new Array(n).fill(1);
  if (ai !== null) {
    const aiMult = diff === 'easy' ? 0.17 : diff === 'hard' ? 1.7 : 1;
    for (let i = 0; i < n; i++) if (i !== (n > 2 ? 0 : (1 - ai))) incomeMult[i] = aiMult;
  }
  const templates = [];
  for (let i = 0; i < n; i++) { templates.push(defaultTemplates()); templates[i].push(makeHqTemplate()); }
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
  // Assign cities to player zones using spawn centers.
  const spawnRng = Algorithms.makeRng(0);
  const centers = computeSpawnCenters(rows, cols, n, false, spawnRng);
  const rad = spawnRadius(rows, cols, n);
  for (const s of cities.concat(villages)) {
    let bestOwner = null, bestDist = Infinity;
    for (let p = 0; p < n; p++) {
      const d = Rules.hexDist(centers[p].r, centers[p].c, s.r, s.c);
      if (d <= rad && d < bestDist) { bestDist = d; bestOwner = p; }
    }
    if (s.owner == null) s.owner = bestOwner;
  }
  // Guarantee at least one city per player so no one is eliminated on round 1.
  // Build territory first so we can place cities inside the country's own tiles.
  const territoryGrid = buildInitialTerritory(rows, cols, n, centers);
  for (let p = 0; p < n; p++) {
    if (cities.some(ci => ci.owner === p)) continue;
    // Find a non-water tile inside this player's territory.
    let placed = false;
    // Try center first.
    const cr = centers[p].r, cc = centers[p].c;
    if (cr < rows && cc < cols && territoryGrid[cr] && territoryGrid[cr][cc] === p &&
        terrain[cr] && terrain[cr][cc] !== 'water') {
      terrain[cr][cc] = 'city';
      cities.push({ r: cr, c: cc, owner: p });
      placed = true;
    }
    if (!placed) {
      // Scan territory tiles by distance from center.
      for (let d = 0; d <= rad && !placed; d++) {
        for (let r2 = cr - d; r2 <= cr + d && !placed; r2++) {
          for (let c2 = cc - d; c2 <= cc + d && !placed; c2++) {
            if (r2 >= 0 && r2 < rows && c2 >= 0 && c2 < cols &&
                territoryGrid[r2] && territoryGrid[r2][c2] === p &&
                terrain[r2] && terrain[r2][c2] !== 'water') {
              terrain[r2][c2] = 'city';
              cities.push({ r: r2, c: c2, owner: p });
              placed = true;
            }
          }
        }
      }
    }
  }
  const startGold = new Array(n).fill(ECONOMY.start);
  if (customMap.economy) for (let i = 0; i < Math.min(customMap.economy.length, n); i++) startGold[i] = customMap.economy[i];
  if (ai !== null) { for (let i = 0; i < n; i++) if (i !== (n > 2 ? 0 : (1 - ai))) startGold[i] = Math.max(startGold[i], 170); }
  return {
    seed: 0, mode, rows, cols, playerCount: n,
    turn: startPlayer === 1 ? 1 : 0, round: 1,
    creative: !!creative, aiPlayer: ai,
    difficulty: diff, incomeMult,
    noUnitTurns: new Array(n).fill(0), noCityTurns: new Array(n).fill(0),
    economy: startGold,
    territory: territoryGrid
      .map((row) => row.map((v) => (v != null ? String(v) : '.')).join('')),
    cities, villages,
    structures: [], units: (customMap.units || []).map((u, i) => ({ ...u, id: i + 1 })),
    toPlace: [],
    upgrades: Array.from({ length: n }, () => ({})),
    unlocked: Array.from({ length: n }, () => ({ ...allUnlocked })),
    ecoUpgrades: Array.from({ length: n }, () => ({})),
    templates, pendingSpawns: [],
    eliminated: [],
    diplomacy: initDiplomacy(n),
    damageDealt: initDamageDealt(n),
    aiStrategy: new Array(n).fill(null),
    spawnCenters: centers,
    players: PLAYERS.map(p => ({ name: p.name, color: p.color })),
    customTerrain: customMap.terrain,
  };
}

// Seed each player's starting force inside a circle around their spawn center.
// `count` units per side, placed within the spawn circle. Each unit uses the
// default Infantry template. A HQ is placed at each center. If no city exists
// in a player's circle, one is created under their HQ to guarantee survival.
function buildInitialArmies(terrain, templates, count, centers, seed, playerCount, cities, territoryGrid) {
  const units = [];
  const dry = (r, c) => inBounds(r, c) && terrain[r][c] !== 'water';
  const n = playerCount || 2;
  const rows = Board.ROWS, cols = Board.COLS;
  const stackLimit = typeof Rules !== 'undefined' ? Rules.STACK_LIMIT : 17;
  const rad = spawnRadius(rows, cols, n);

  let s = ((seed || 0) ^ 0x5f3759df) >>> 0;
  const rng = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

  for (let owner = 0; owner < n; owner++) {
    const center = centers[owner];
    const tmpl = templates[owner][0];

    // Collect dry tiles inside the spawn circle.
    const candidates = [];
    for (let r = Math.max(0, center.r - rad); r <= Math.min(rows - 1, center.r + rad); r++) {
      for (let c = Math.max(0, center.c - rad); c <= Math.min(cols - 1, center.c + rad); c++) {
        if (dry(r, c) && Rules.hexDist(center.r, center.c, r, c) <= rad) {
          candidates.push({ r, c });
        }
      }
    }
    // Shuffle candidates for variety.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    // Sort by distance from center so units cluster near center first.
    candidates.sort((a, b) =>
      Rules.hexDist(center.r, center.c, a.r, a.c) - Rules.hexDist(center.r, center.c, b.r, b.c));

    // Place units.
    if (count > 0) {
      const placed = new Map();
      let idx = 0;
      for (let nn = 0; nn < count && idx < candidates.length * stackLimit; ) {
        const spot = candidates[idx % candidates.length];
        const k = spot.r + ',' + spot.c;
        const cur = placed.get(k) || 0;
        if (cur >= stackLimit) { idx++; continue; }
        const u = makeUnitFromTemplate(owner, tmpl, spot.r, spot.c, { acted: false });
        if (u) { units.push(u); placed.set(k, cur + 1); nn++; }
        idx++;
      }
    }
  }

  // Place 1 HQ per side at (or spiralling from) their center.
  for (let owner = 0; owner < n; owner++) {
    const center = centers[owner];
    const hqTmpl = templates[owner].find(t => t.isHq) || makeHqTemplate();
    let placed = false;
    // Spiral outward from the center to find a valid tile.
    for (let dr = 0; dr <= rad + 5; dr++) {
      for (let rr = center.r - dr; rr <= center.r + dr; rr++) {
        for (let cc = center.c - dr; cc <= center.c + dr; cc++) {
          if (!inBounds(rr, cc) || !dry(rr, cc)) continue;
          if (Math.abs(rr - center.r) !== dr && Math.abs(cc - center.c) !== dr) continue;
          const ss = units.filter(u => u.r === rr && u.c === cc);
          if (ss.length >= stackLimit) continue;
          const hq = makeUnitFromTemplate(owner, hqTmpl, rr, cc, { acted: false });
          if (hq) { units.push(hq); placed = true; }
          break;
        }
        if (placed) break;
      }
      if (placed) break;
    }

    // Guarantee at least one city in this player's territory.
    const hasCity = cities.some(ci => ci.owner === owner);
    if (!hasCity) {
      let placed = false;
      // Try HQ position first.
      const hqUnit = units.find(u => u.owner === owner && u.templateId === 'hq');
      const cr = hqUnit ? hqUnit.r : center.r;
      const cc = hqUnit ? hqUnit.c : center.c;
      if (inBounds(cr, cc) && terrain[cr][cc] !== 'water' &&
          (!territoryGrid || (territoryGrid[cr] && territoryGrid[cr][cc] === owner))) {
        terrain[cr][cc] = 'city';
        cities.push({ r: cr, c: cc, owner: owner });
        placed = true;
      }
      // Fallback: find a dry tile inside own territory, nearest to center.
      if (!placed) {
        for (let d = 0; d <= rad && !placed; d++) {
          for (let r2 = center.r - d; r2 <= center.r + d && !placed; r2++) {
            for (let c2 = center.c - d; c2 <= center.c + d && !placed; c2++) {
              if (inBounds(r2, c2) && terrain[r2][c2] !== 'water' &&
                  (!territoryGrid || (territoryGrid[r2] && territoryGrid[r2][c2] === owner))) {
                terrain[r2][c2] = 'city';
                cities.push({ r: r2, c: c2, owner: owner });
                placed = true;
              }
            }
          }
        }
      }
      // Last resort: any dry tile near center (no territory check).
      if (!placed) {
        for (let d = 0; d <= rad && !placed; d++) {
          for (let r2 = center.r - d; r2 <= center.r + d && !placed; r2++) {
            for (let c2 = center.c - d; c2 <= center.c + d && !placed; c2++) {
              if (inBounds(r2, c2) && terrain[r2][c2] !== 'water') {
                terrain[r2][c2] = 'city';
                cities.push({ r: r2, c: c2, owner: owner });
                placed = true;
              }
            }
          }
        }
      }
    }
  }
  return units;
}

// Load a saved state object into the live Game (regenerating the map).
function loadIntoGame(st) {
  const n = st.playerCount || 2;
  Game.playerCount = n;
  if (st.players && st.players.length) {
    window.initPlayers(st.players.length, st.players.map(p => p.name));
    for (let i = 0; i < st.players.length; i++) if (st.players[i].color) PLAYERS[i].color = st.players[i].color;
  } else {
    window.initPlayers(n);
  }
  Game.seed = st.seed;
  Game.mode = st.mode || 'pvp';
  Game.aiPlayer = (st.aiPlayer != null && st.aiPlayer >= 0) ? st.aiPlayer : (Game.mode === 'pve' ? 1 : null);
  Game.creative = !!st.creative;
  Game.difficulty = (st.difficulty === 'easy' || st.difficulty === 'hard') ? st.difficulty : 'normal';
  Game.incomeMult = Array.isArray(st.incomeMult) ? st.incomeMult.slice() : new Array(n).fill(1);
  Game.noUnitTurns = Array.isArray(st.noUnitTurns) ? st.noUnitTurns.slice() : new Array(n).fill(0);
  Game.noCityTurns = Array.isArray(st.noCityTurns) ? st.noCityTurns.slice() : new Array(n).fill(0);
  // Pad arrays to N if save had fewer players
  while (Game.incomeMult.length < n) Game.incomeMult.push(1);
  while (Game.noUnitTurns.length < n) Game.noUnitTurns.push(0);
  while (Game.noCityTurns.length < n) Game.noCityTurns.push(0);
  // Restore board
  if (st.customTerrain && Array.isArray(st.customTerrain)) {
    Board.setDims(st.rows, st.cols);
    Game.terrain = st.customTerrain.map(row => row.slice());
    Game.customTerrain = true;
  } else {
    Game.terrain = Board.fromSeed(st.seed, st.rows || Algorithms.GRID, st.cols || Algorithms.GRID, st.playerCount || 2).terrain;
    Game.customTerrain = false;
  }
  Game.territory = deserializeTerritory(Board.ROWS, Board.COLS, st.territory);
  Game.turn = st.turn || 0;
  Game.round = st.round || 1;
  Game.economy = (st.economy || new Array(n).fill(ECONOMY.start)).slice();
  while (Game.economy.length < n) Game.economy.push(ECONOMY.start);
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
  Game.upgrades = Array.from({ length: n }, (_, i) => ({ ...(st.upgrades && st.upgrades[i]) }));
  Game.ecoUpgrades = Array.from({ length: n }, (_, i) => ({ ...(st.ecoUpgrades && st.ecoUpgrades[i]) }));
  Game.unlocked = Array.from({ length: n }, (_, i) => ({ infantry: true, ...(st.unlocked && st.unlocked[i]) }));
  Game.templates = Array.from({ length: n }, (_, i) =>
    (st.templates && st.templates[i] && st.templates[i].length) ? st.templates[i].map(cloneTemplate) : defaultTemplates()
  );
  for (let p = 0; p < n; p++) {
    if (!Game.templates[p].some(t => t.isHq)) Game.templates[p].push(makeHqTemplate());
  }
  // Diplomacy and damage
  Game.eliminated = new Set(st.eliminated || []);
  Game.diplomacy = (st.diplomacy && st.diplomacy.length === n) ? st.diplomacy.map(r => r.slice()) : initDiplomacy(n);
  Game.damageDealt = (st.damageDealt && st.damageDealt.length === n) ? st.damageDealt.map(r => r.slice()) : initDamageDealt(n);
  Game.aiStrategy = (st.aiStrategy || new Array(n).fill(null)).slice();
  while (Game.aiStrategy.length < n) Game.aiStrategy.push(null);
  Game.spawnCenters = st.spawnCenters || [];

  rebuildUnitAt();
  nextId = Game.units.reduce((m, u) => Math.max(m, u.id), 0) + 1;
  Game.winner = null;
  Game.winReason = null;
  clearSelection();
  checkWinner();

  Game.toPlace = (st.toPlace || []).filter((s) => s && s.templateId);
  for (const sp of st.pendingSpawns || []) if (sp && sp.templateId) Game.toPlace.push({ templateId: sp.templateId, owner: sp.owner });
  persist();
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
  if (!inZone(owner, c, r)) { UI.log('Deploy inside your own deployment zone.'); return; }
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
    UI.log('That template needs a unit type you have not researched yet.');
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
  for (const u of acting) { u.acted = true; u.moved = true; u.movesLeft = Math.floor(u.movesLeft / 2); }

  const foe = defenders.length ? defenders[0].owner : (acting.length ? acting[0].owner : 0);

  // Track damage dealt for peace deals
  if (Game.damageDealt && Game.damageDealt[Game.turn]) {
    Game.damageDealt[Game.turn][foe] = (Game.damageDealt[Game.turn][foe] || 0) + dmgToDef;
  }

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

  // Capture: surviving attackers move onto the target tile if cleared
  const remainingDef = stackAt(tr, tc).filter(u => u.owner === foe);
  if (!remainingDef.length) {
    const survivors = acting.filter(u => Game.units.includes(u));
    const toEnter = survivors.length > Rules.STACK_LIMIT
      ? survivors.sort((a, b) => b.hp - a.hp).slice(0, Rules.STACK_LIMIT) : survivors;
    for (const u of toEnter) {
      removeFromStack(u);
      u.r = tr; u.c = tc;
      addToStack(u);
    }
    claimTile(tr, tc, Game.turn);
    captureIfCity(tr, tc, Game.turn);
    captureIfStructure(tr, tc, Game.turn);
  }

  checkWinner();
}

// Sample the board once per turn hand-off and advance each side's elimination
// streaks: a side with zero units (or zero owned cities) has its counter bumped,
// otherwise it resets. Call exactly once per turn transition (see advanceTo).
function updateEliminationStreaks() {
  const n = Game.playerCount || 2;
  const units = new Array(n).fill(0), cities = new Array(n).fill(0);
  for (const u of Game.units) if (u.owner < n) units[u.owner]++;
  for (const ci of Game.cities) if (ci.owner != null && ci.owner < n) cities[ci.owner]++;
  for (let p = 0; p < n; p++) {
    if (Game.eliminated.has(p)) continue;
    Game.noUnitTurns[p] = units[p] === 0 ? (Game.noUnitTurns[p] || 0) + 1 : 0;
    Game.noCityTurns[p] = cities[p] === 0 ? (Game.noCityTurns[p] || 0) + 1 : 0;
  }
}

function eliminatePlayer(p) {
  if (Game.eliminated.has(p)) return;
  Game.eliminated.add(p);
  // Peace deal: redistribute eliminated player's cities/villages to attackers
  const attackers = [];
  for (let i = 0; i < (Game.playerCount || 2); i++) {
    if (i === p || Game.eliminated.has(i)) continue;
    const dmg = (Game.damageDealt && Game.damageDealt[i] && Game.damageDealt[i][p]) || 0;
    if (dmg > 0) attackers.push({ id: i, dmg });
  }
  const totalDmg = attackers.reduce((s, a) => s + a.dmg, 0);
  const sites = Game.cities.concat(Game.villages || []).filter(s => s.owner === p);
  if (sites.length && attackers.length) {
    // Score sites: cities worth 2, villages worth 1
    const scored = sites.map(s => ({ s, score: Game.terrain[s.r] && Game.terrain[s.r][s.c] === 'city' ? 2 : 1 }));
    scored.sort((a, b) => b.score - a.score);
    // Distribute proportionally by damage dealt
    let distributed = 0;
    for (const site of scored) {
      const target = attackers.reduce((best, a) => {
        const share = a.dmg / totalDmg;
        const owned = sites.filter(ss => ss.s.owner === a.id).length;
        const deficit = share * scored.length - owned;
        return deficit > (best ? best.deficit : -Infinity) ? { ...a, deficit } : best;
        }, null);
      if (target) { site.s.owner = target.id; distributed++; }
    }
    UI.log(`☮️ Peace deal: ${PLAYERS[p].name} eliminated — ${distributed} site(s) redistributed.`);
  } else if (sites.length) {
    for (const s of sites) s.owner = null;
    UI.log(`${PLAYERS[p].name} eliminated — territories became neutral.`);
  } else {
    UI.log(`${PLAYERS[p].name} has been eliminated.`);
  }
  // Remove eliminated player's remaining units
  for (const u of Game.units.filter(u => u.owner === p)) {
    removeFromStack(u);
  }
  Game.units = Game.units.filter(u => u.owner !== p);
  // Show peace deal via UI if available
  if (window.showPeaceDeal) {
    const title = `☮️ ${PLAYERS[p].name} Eliminated`;
    let body = '';
    if (attackers.length) {
      body = attackers.map(a => `<div class="pd-row"><span style="color:${PLAYERS[a.id].color}">${PLAYERS[a.id].name}</span><span>Damage: ${a.dmg} · ${sites.filter(ss => ss.owner === a.id).length} site(s) gained</span></div>`).join('');
    } else {
      body = '<div style="color:#9aa4ad">No attacker claims — territory became neutral.</div>';
    }
    window.showPeaceDeal(title, body);
  }
}

function checkWinner() {
  if (Game.winner !== null) return;
  const n = Game.playerCount || 2;
  // HQ destruction: instant elimination
  for (let p = 0; p < n; p++) {
    if (Game.eliminated.has(p)) continue;
    const hadHq = (Game.templates[p] || []).some(t => t.isHq);
    if (hadHq && !Game.units.some(u => u.owner === p && isHqUnit(u))) {
      eliminatePlayer(p);
      Game.winReason = `${PLAYERS[p].name} lost their HQ`;
    }
  }
  // Delayed elimination (units / cities)
  for (let p = 0; p < n; p++) {
    if (Game.eliminated.has(p)) continue;
    if ((Game.noUnitTurns[p] || 0) >= LOSE_TURNS) {
      eliminatePlayer(p);
      Game.winReason = `${PLAYERS[p].name} lost all units`;
    } else if ((Game.noCityTurns[p] || 0) >= LOSE_CITY_TURNS) {
      eliminatePlayer(p);
      Game.winReason = `${PLAYERS[p].name} lost all cities`;
    }
  }
  // Check if only 1 player (or allied bloc) remains
  const alive = [];
  for (let i = 0; i < n; i++) if (!Game.eliminated.has(i)) alive.push(i);
  // PVE: if the human player is eliminated, game ends immediately
  if (Game.mode === 'pve') {
    const human = n > 2 ? 0 : (Game.aiPlayer != null ? (1 - Game.aiPlayer) : 0);
    if (Game.eliminated.has(human)) {
      let best = alive[0] || 0, bestUnits = 0;
      for (const p of alive) {
        const cnt = Game.units.filter(u => u.owner === p).length;
        if (cnt > bestUnits) { bestUnits = cnt; best = p; }
      }
      Game.winner = best;
      Game.winReason = `${PLAYERS[human].name} was eliminated`;
      return;
    }
  }
  if (alive.length <= 1) {
    Game.winner = alive[0] != null ? alive[0] : 0;
    return;
  }
  // Check if all alive players are allied with each other
  let allAllied = true;
  for (let i = 0; i < alive.length && allAllied; i++) {
    for (let j = i + 1; j < alive.length && allAllied; j++) {
      if (!isAlly(alive[i], alive[j])) allAllied = false;
    }
  }
  if (allAllied) {
    // Find the strongest allied player as "winner"
    let best = alive[0], bestUnits = 0;
    for (const p of alive) {
      const cnt = Game.units.filter(u => u.owner === p).length;
      if (cnt > bestUnits) { bestUnits = cnt; best = p; }
    }
    Game.winner = best;
    Game.winReason = `${alive.map(p => PLAYERS[p].name).join(' & ')} alliance victory`;
  }
}

// ---------------------------------------------------------------------------
// Unit refit — swap a deployed unit to a different template (in supply zone)
// ---------------------------------------------------------------------------
function canRefitUnit(u) {
  if (u.owner !== Game.turn || Game.winner !== null) return false;
  if (inPlacement()) return false;
  if (isHqUnit(u)) return false;
  // Check if surrounded by any enemy territory
  const enemies = getEnemies(u.owner);
  if (enemies.some(e => Rules.surroundedBy(Game.territory, u.r, u.c, e))) return false;
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
    if (Game.units.includes(u)) { u.acted = true; u.moved = true; u.movesLeft = Math.floor(u.movesLeft / 2); }
  }

  const foe = defenders.length ? defenders[0].owner : Game.turn;

  // Track damage dealt for peace deals
  if (Game.damageDealt && Game.damageDealt[Game.turn]) {
    Game.damageDealt[Game.turn][foe] = (Game.damageDealt[Game.turn][foe] || 0) + dmgToDef;
  }

  const stkCount = groups.length > 1 ? ` (${groups.length} stacks)` : '';
  UI.log(`${PLAYERS[Game.turn].name}${stkCount} (${allAttackers.length}) struck ` +
    `${PLAYERS[foe].name} for ${dmgToDef} (took ${dmgToAtk} back split). ` +
    `Destroyed ${defKilled} / lost ${atkKilled}.`);

  // Capture: surviving attackers move onto the target tile if cleared
  const remainingDef = stackAt(tr, tc).filter(u => u.owner === foe);
  if (!remainingDef.length) {
    const survivors = allAttackers.filter(u => Game.units.includes(u));
    const toEnter = survivors.length > Rules.STACK_LIMIT
      ? survivors.sort((a, b) => b.hp - a.hp).slice(0, Rules.STACK_LIMIT) : survivors;
    for (const u of toEnter) {
      removeFromStack(u);
      u.r = tr; u.c = tc;
      addToStack(u);
    }
    claimTile(tr, tc, Game.turn);
    captureIfCity(tr, tc, Game.turn);
    captureIfStructure(tr, tc, Game.turn);
  }

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
  updateEliminationStreaks();
  checkWinner();
  if (Game.winner !== null) { persist(); UI.refresh(); Render.render(); return; }
  // Skip eliminated players
  while (Game.eliminated.has(player)) player = nextPlayer(player);
  if (player === firstSurvivingPlayer()) Game.round++;
  grantIncome(player);
  startTurn(player);
  persist();
  UI.refresh();
  Render.render();
  Render.autoZoom();
  // AI turn: in PvE mode, all non-human players are AI
  const isAi = Game.mode === 'pve' && player !== (Game.playerCount > 2 ? 0 : (Game.aiPlayer != null ? (1 - Game.aiPlayer) : 0));
  if (isAi) window.runAiTurn();
}

function nextRound() {
  if (Game.winner !== null) return;
  if (inPlacement()) { UI.log('Deploy your bought units first.'); UI.refresh(); return; }
  if (Game.orderQueue.length) executeOrders();
  advanceTo(nextPlayer(Game.turn));
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
  let removed = 0;
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
    }
    // Remove all non-HQ units in the group from the game
    for (const u of group) {
      removeFromStack(u);
      Game.units = Game.units.filter(x => x !== u);
      removed++;
    }
  }
  Game.reachable = new Map();
  if (removed) UI.log(`HQ disbanded ${removed} unit(s) marching toward (${targetR},${targetC}).`);
  persist();
  return removed;
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
    const pc = intent.playerCount || 2;
    if (intent.customMap) {
      st = buildCustomMapState(mode, intent.customMap, intent.creative, start, aiPlayer, intent.difficulty, pc, intent.playerNames);
    } else {
      st = buildInitialState(mode, Math.floor(Math.random() * 1e9), intent.rows, intent.cols, intent.creative, start, aiPlayer, intent.difficulty, intent.startUnits, intent.randomStart, pc, intent.playerNames);
    }
    SaveState.save(st);
  } else {
    st = SaveState.load();
    if (!st) { st = buildInitialState('pvp', Math.floor(Math.random() * 1e9)); SaveState.save(st); }
  }
  loadIntoGame(st);
  Render.resize();
  Render.autoZoom();
  UI.refresh();
  // If the AI is set to move first, let it take its opening turn immediately.
  const isAi = Game.mode === 'pve' && Game.winner === null &&
    Game.turn !== (Game.playerCount > 2 ? 0 : (Game.aiPlayer != null ? (1 - Game.aiPlayer) : 0));
  if (isAi) window.runAiTurn();
}

window.addEventListener('resize', () => Render.resize());
wireInput(); // from input.js
boot();

// Expose for the page buttons / sidebar controls
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
// Creative-mode cheat: hand the current player a pile of gold.
window.creativeGrant = function () {
  if (!Game.creative || Game.winner !== null) return;
  Game.economy[Game.turn] += 171717;
  persist();
  UI.refresh();
};
window.startNewGame = (mode) => { SaveState.setIntent({ action: 'new', mode }); location.reload(); };

// Internal helpers exposed for ai.js and input.js
window._stackAt = stackAt;
window._moveGroup = moveGroup;
window._doAttack = doAttack;
window._addToStack = addToStack;
window._makeUnit = makeUnitFromTemplate;
window._persist = persist;
window._advanceTo = advanceTo;
window._nearOwnedSite = nearOwnedSite;
window._inZone = inZone;
window._placeAt = placeAt;
window._addOrder = addOrder;
window._getPath = getPath;
window._bestAdjacentForAttack = bestAdjacentForAttack;
// Diplomacy helpers for ai.js and diplomacy.html
window.isAtWar = isAtWar;
window.isAlly = isAlly;
window.setDiplomacy = setDiplomacy;
window.getEnemies = getEnemies;
window.getAllies = getAllies;
window.nextPlayer = nextPlayer;
