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
 *   "r,c" -> Unit[] (a "stack", capped at Rules.STACK_LIMIT = 17). Units move
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
  mode: 'pvp',          // 'pvp' | 'pve' (pve: player 1 is the AI)
  terrain: [],
  cities: [],           // [{r, c, owner}]
  units: [],            // {id, type, owner, r, c, hp, maxHp, movesLeft, acted}
  unitAt: new Map(),    // "r,c" -> Unit[]  (a stack, all same owner)
  economy: [0, 0],
  turn: 0,
  round: 1,
  selTile: null,        // {r, c} currently inspected, or null
  selUnits: [],         // units chosen from selTile (whole stack or a subset)
  selectAll: true,      // "select whole stack" toggle
  reachable: new Map(), // "r,c" -> remaining moves for the selected group
  toPlace: [],          // [{type, owner}] bought units awaiting deployment
  upgrades: [{}, {}],   // per-player, per-type upgrade steps: {pawn:{atk,hp,mov}}
  winner: null,
};
let nextId = 1;

// Upgrade tuning lives in units.js (window.UPGRADES) so the shop/upgrade pages
// share one source of truth. Steps are stored per-player in the save.
const UPGRADE = UPGRADES;
// Steps of `stat` bought for `owner`'s `type` so far (0 if none).
function upgradeSteps(owner, type, stat) {
  const u = Game.upgrades[owner] && Game.upgrades[owner][type];
  return (u && u[stat]) || 0;
}
// Cost of the NEXT step (escalates: baseCost * (steps + 1)).
function upgradeCost(owner, type, stat) {
  return UPGRADE[stat].baseCost * (upgradeSteps(owner, type, stat) + 1);
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
    economy: Game.economy.slice(),
    cities: Game.cities.map((c) => ({ r: c.r, c: c.c, owner: c.owner })),
    units: Game.units.map((u) => ({
      id: u.id, type: u.type, owner: u.owner, r: u.r, c: u.c,
      hp: u.hp, maxHp: u.maxHp, movesLeft: u.movesLeft, acted: u.acted,
      atkBonus: u.atkBonus || 0, movBonus: u.movBonus || 0, hpBonus: u.hpBonus || 0,
    })),
    toPlace: Game.toPlace.slice(),
    upgrades: [ { ...Game.upgrades[0] }, { ...Game.upgrades[1] } ],
    pendingSpawns: [], // always flushed into toPlace once applied
  };
}
function persist() { SaveState.save(serialize()); }

// Build a brand-new game for the given mode, seed and board size.
function buildInitialState(mode, seed, rows, cols) {
  const { terrain, cities } = Board.fromSeed(seed, rows || Algorithms.GRID, cols || Algorithms.GRID);
  const units = buildInitialArmies(terrain);
  return {
    seed, mode, rows: Board.ROWS, cols: Board.COLS, turn: 0, round: 1,
    economy: [ECONOMY.start, ECONOMY.start],
    cities, units, toPlace: [], upgrades: [{}, {}], pendingSpawns: [],
  };
}

// Line up starting armies down the center-most column of each player's spawn
// zone, skipping water tiles. Margins/spacing scale with the board so small
// maps still get a sensible starting force.
function buildInitialArmies(terrain) {
  const units = [];
  let id = 1;
  const occupied = new Set();
  const put = (type, owner, r, c) => {
    const def = PIECES[type];
    units.push({ id: id++, type, owner, r, c, hp: def.hp, maxHp: def.hp,
      movesLeft: def.movement_speed, acted: false });
    occupied.add(key(r, c));
  };
  const dry = (r, c) => inBounds(r, c) && terrain[r][c] !== 'water' && !occupied.has(key(r, c));
  const place = (type, owner, r, c) => {
    if (dry(r, c)) { put(type, owner, r, c); return; }
    for (let d = 1; d <= 4; d++) { // nudge to a nearby dry tile
      if (dry(r + d, c)) return put(type, owner, r + d, c);
      if (dry(r - d, c)) return put(type, owner, r - d, c);
    }
  };
  const rows = Board.ROWS, cols = Board.COLS;
  const margin = Math.max(1, Math.floor(rows * 0.08)); // 8 at rows=100
  const step = Math.max(2, Math.floor(rows / 16));     // 6 at rows=100
  const zone = Board.zone();
  // Center-most column of each player's spawn zone (Blue left, Red right).
  const cLeft = Math.floor((zone - 1) / 2);
  const cRight = cols - 1 - Math.floor((zone - 1) / 2);
  for (let r = margin; r < rows - margin; r += step) {
    place('pawn', 0, r, cLeft);
    place('pawn', 1, r, cRight);
    if ((r / 6) % 2 === 0) { place('cavalry', 0, r, cLeft); place('cavalry', 1, r, cRight); }
    if ((r / 6) % 3 === 0 && cols >= 6) { place('tank', 0, r, cLeft); place('tank', 1, r, cRight); }
  }
  return units;
}

// Load a saved state object into the live Game (regenerating the map).
function loadIntoGame(st) {
  Game.seed = st.seed;
  Game.mode = st.mode || 'pvp';
  // Restore board size (old saves predate this and default to 100x100).
  Game.terrain = Board.fromSeed(st.seed, st.rows || Algorithms.GRID, st.cols || Algorithms.GRID).terrain;
  Game.turn = st.turn || 0;
  Game.round = st.round || 1;
  Game.economy = (st.economy || [ECONOMY.start, ECONOMY.start]).slice();
  Game.cities = (st.cities || []).map((c) => ({ ...c }));
  Game.units = (st.units || []).map((u) => ({ atkBonus: 0, movBonus: 0, hpBonus: 0, ...u }));
  Game.upgrades = [ { ...(st.upgrades && st.upgrades[0]) }, { ...(st.upgrades && st.upgrades[1]) } ];
  rebuildUnitAt();
  nextId = Game.units.reduce((m, u) => Math.max(m, u.id), 0) + 1;
  Game.winner = null;
  clearSelection();
  checkWinner();

  // Units bought in the shop arrive as "to place"; the player deploys them.
  Game.toPlace = (st.toPlace || []).slice();
  for (const sp of st.pendingSpawns || []) Game.toPlace.push({ type: sp.type, owner: sp.owner });
  persist(); // flush pendingSpawns into toPlace
}

// ---------------------------------------------------------------------------
// Cities & deployment
// ---------------------------------------------------------------------------
function cityAt(r, c) {
  return Game.cities.find((ci) => ci.r === r && ci.c === c) || null;
}
function captureIfCity(r, c, owner) {
  const ci = cityAt(r, c);
  if (ci && ci.owner !== owner) {
    ci.owner = owner;
    UI.log(`${PLAYERS[owner].name} captured a city at r${r}, c${c}.`);
  }
}

// Deploy pending units onto a tile in the current player's zone (stacked).
function placeAt(r, c) {
  const owner = Game.turn;
  if (!inZone(owner, c)) { UI.log('Deploy inside your own deployment zone.'); return; }
  if (Game.terrain[r][c] === 'water') { UI.log('Cannot deploy on water.'); return; }
  const stack = stackAt(r, c);
  if (stack.length && stack[0].owner !== owner) { UI.log('Tile is held by the enemy.'); return; }
  let room = Rules.STACK_LIMIT - stack.length;
  if (room <= 0) { UI.log('That tile is full (17).'); return; }

  let placed = 0;
  for (let i = 0; i < Game.toPlace.length && room > 0; ) {
    const sp = Game.toPlace[i];
    if (sp.owner !== owner) { i++; continue; }
    Game.toPlace.splice(i, 1);
    const def = PIECES[sp.type];
    const b = upgradeBonuses(owner, sp.type);
    const maxHp = def.hp + b.hpBonus;
    const u = { id: nextId++, type: sp.type, owner, r, c,
      hp: maxHp, maxHp, movesLeft: 0, acted: true, // arrive; act next turn
      atkBonus: b.atkBonus, movBonus: b.movBonus, hpBonus: b.hpBonus };
    Game.units.push(u);
    addToStack(u);
    room--; placed++;
  }
  UI.log(`Deployed ${placed} unit(s) at r${r}, c${c}.` +
    (pendingForTurn() ? ` ${pendingForTurn()} left to place.` : ''));
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

  const { dmgToDef, dmgToAtk } = Rules.resolveCombat(Game.terrain, acting, defenders);
  const defKilled = applyDamage(defenders, dmgToDef);  // acting array preserved
  const atkKilled = applyDamage(acting, dmgToAtk);     // shifts dead off `acting`

  // Survivors have attacked: mark acted and halve remaining MOV (can still move).
  for (const u of acting) { u.acted = true; u.movesLeft = Math.floor(u.movesLeft / 2); }

  const foe = 1 - Game.turn;
  UI.log(`${PLAYERS[Game.turn].name} (${acting.length + atkKilled}) struck ` +
    `${PLAYERS[foe].name} for ${dmgToDef} (took ${dmgToAtk} back). ` +
    `Destroyed ${defKilled} / lost ${atkKilled}.`);
  checkWinner();
}

function checkWinner() {
  const alive = [0, 0];
  for (const u of Game.units) alive[u.owner]++;
  if (alive[0] === 0 && alive[1] > 0) Game.winner = 1;
  else if (alive[1] === 0 && alive[0] > 0) Game.winner = 0;
}

// ---------------------------------------------------------------------------
// Selection & movement (rules live in rules.js)
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

// Move a group to (r,c). Group speed = slowest member; each loses the same
// number of points; stacks merge at the destination.
function moveGroup(group, r, c) {
  const left = Game.reachable.get(key(r, c));
  if (left === undefined) return false;
  const spent = Math.min(...group.map((u) => u.movesLeft)) - left;
  const owner = group[0].owner;
  for (const u of group) {
    removeFromStack(u);
    u.r = r; u.c = c;
    u.movesLeft = Math.max(0, u.movesLeft - spent);
    addToStack(u);
  }
  captureIfCity(r, c, owner);
  return true;
}

// ---------------------------------------------------------------------------
// Turns & economy
// ---------------------------------------------------------------------------
function grantIncome(player) { Game.economy[player] += Rules.income(Game.cities, player); }

function startTurn(player) {
  Game.turn = player;
  for (const u of Game.units) {
    if (u.owner === player) { u.movesLeft = PIECES[u.type].movement_speed + (u.movBonus || 0); u.acted = false; }
  }
  clearSelection();
}

// Hand the turn to `player`, paying their income first. Drives the AI in PvE.
function advanceTo(player) {
  if (Game.winner !== null) return;
  if (player === 0) Game.round++; // returning to Blue completes a round
  grantIncome(player);
  startTurn(player);
  persist();
  UI.refresh();
  Render.render();
  if (Game.mode === 'pve' && player === 1) runAiTurn();
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

function runAiTurn() {
  const me = 1;
  // Snapshot the AI's starting tiles; resolve each into a live group.
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
  Game.reachable = new Map();
  persist();
  UI.refresh();
  Render.render();
  advanceTo(0); // hand control back to the human
}

// ---------------------------------------------------------------------------
// Input — shared tap handling for mouse clicks and touch taps
// ---------------------------------------------------------------------------
function handleTapAt(r, c) {
  if (Game.winner !== null || !inBounds(r, c)) return;

  // Placement mode: taps deploy bought units into the player's zone.
  if (inPlacement()) { placeAt(r, c); UI.refresh(); Render.render(); return; }

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
      UI.refresh(); Render.render(); return;
    }
    // Move: tapped a reachable (own/empty) tile.
    if (Game.reachable.has(key(r, c)) && (!tileStack.length || tileStack[0].owner === Game.turn)) {
      const group = movers.filter((u) => u.movesLeft > 0);
      if (group.length && moveGroup(group, r, c)) {
        persist();
        Game.selTile = { r, c };
        Game.selUnits = group;
        recomputeReachable();
        UI.refresh(); Render.render(); return;
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
    st = buildInitialState(intent.mode || 'pvp', Math.floor(Math.random() * 1e9), intent.rows, intent.cols);
    SaveState.save(st);
  } else {
    st = SaveState.load();
    if (!st) { st = buildInitialState('pvp', Math.floor(Math.random() * 1e9)); SaveState.save(st); }
  }
  loadIntoGame(st);
  Render.resize();
  UI.refresh();
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
window.startNewGame = (mode) => { SaveState.setIntent({ action: 'new', mode }); location.reload(); };
