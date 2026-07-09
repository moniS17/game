/*
 * ai.js — PvE artificial intelligence: movement, combat, purchasing, deployment.
 *
 * Extracted from game.js for readability. All functions access the global
 * Game object and helpers from game.js (stackAt, moveGroup, doAttack, etc.)
 * which are exposed via window.* before this file loads.
 *
 * Depends on: units.js, board.js, rules.js, game.js (core)
 */

// ---------------------------------------------------------------------------
// Helpers — queries the AI uses to evaluate the board
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
    if (!Board.inBounds(nr, nc)) continue;
    const s = window._stackAt(nr, nc);
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

function aiUnitCount(owner) {
  return Game.units.filter(u => u.owner === owner).length;
}

function aiStackCount(owner) {
  let n = 0;
  for (const [, s] of Game.unitAt) if (s.length && s[0].owner === owner) n++;
  return n;
}

function aiInSupplyRange(r, c, owner) {
  const range = REGEN.heavyRange;
  const supplyHubs = Game.structures.filter(s => s.type === 'supply');
  return window._nearOwnedSite(r, c, Game.cities, owner, range.city) ||
         window._nearOwnedSite(r, c, Game.villages, owner, range.village) ||
         window._nearOwnedSite(r, c, supplyHubs, owner, range.village);
}

function aiEnemyHasTanks(me) {
  for (const u of Game.units) {
    if (u.owner === me) continue;
    if ((u.parts || []).some(p => p.type === 'tank' && p.count > 0)) return true;
  }
  return false;
}

// Terrain-aware total ATK of a stack standing on (r,c).
function aiStackAtkOn(stack, r, c) {
  const terr = Game.terrain[r][c];
  let s = 0;
  for (const u of stack) s += Rules.unitAttackOn(u, terr);
  return s;
}

// Raw total ATK (no terrain).
function aiStackAtk(stack) {
  return stack.reduce((s, u) => s + Rules.unitAttack(u), 0);
}

// Total HP of a stack.
function aiStackHp(stack) {
  return stack.reduce((s, u) => s + u.hp, 0);
}

// Find the largest friendly stack tile (by unit count), excluding HQ-only tiles.
function aiBiggestFriendlyStack(me) {
  let best = null, bestCount = 0;
  for (const [k, s] of Game.unitAt) {
    if (!s.length || s[0].owner !== me) continue;
    const nonHq = s.filter(u => !window.isHqUnit(u));
    if (nonHq.length > bestCount) {
      bestCount = nonHq.length;
      const [r, c] = k.split(',').map(Number);
      best = { r, c, count: nonHq.length };
    }
  }
  return best;
}

// Nearest enemy distance to a tile.
function aiNearestEnemyDist(r, c, me) {
  let best = Infinity;
  for (const u of Game.units) {
    if (u.owner === me) continue;
    const d = Rules.hexDist(u.r, u.c, r, c);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Targeting — smarter than "nearest enemy"
// ---------------------------------------------------------------------------

function aiBestTarget(r, c, me) {
  const enemy = 1 - me;
  let best = null, bestScore = -Infinity;

  for (const [k, s] of Game.unitAt) {
    if (!s.length || s[0].owner === me) continue;
    const [er, ec] = k.split(',').map(Number);
    const dist = Rules.hexDist(er, ec, r, c);
    if (dist === 0) continue;
    const hp = aiStackHp(s);
    const onCity = Game.terrain[er][ec] === 'city' || Game.terrain[er][ec] === 'village';
    const score = -dist * 2 - hp / 10 + (onCity ? 15 : 0);
    if (score > bestScore) { bestScore = score; best = { r: er, c: ec }; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Spending — research, purchasing, deployment
// ---------------------------------------------------------------------------

function aiThreatRow(me) {
  let best = null, bestC = me === 1 ? -1 : Board.COLS;
  for (const u of Game.units) {
    if (u.owner === me) continue;
    if (me === 1 ? u.c > bestC : u.c < bestC) { bestC = u.c; best = u.r; }
  }
  return best == null ? Math.floor(Board.ROWS / 2) : best;
}

function compTemplate(name, comp) {
  const cells = new Array(TEMPLATE_CELLS).fill(null);
  let i = 0;
  for (const type in comp) for (let k = 0; k < comp[type] && i < TEMPLATE_CELLS; k++) cells[i++] = type;
  return { id: 'adhoc', name, cells };
}

function aiBuyUnits(me) {
  const roster = Object.keys(PIECES)
    .filter(t => t !== 'hq' && window.isUnlocked(me, t))
    .sort((a, b) => PIECES[a].cost - PIECES[b].cost);
  if (!roster.length) return [];
  const cheapest = PIECES[roster[0]].cost;
  const units = [];
  let budget = Game.economy[me];

  const earlyInfBudget = Math.floor(budget * 0.85);
  const infCost = PIECES.infantry.cost;
  let infSpent = 0;
  while (infSpent + infCost <= earlyInfBudget && units.length < 100) {
    const size = Math.max(1, Math.min(5, Math.floor((earlyInfBudget - infSpent) / infCost / 2) || 1));
    let n = 0;
    while (n < size && infSpent + infCost <= earlyInfBudget) { infSpent += infCost; n++; }
    units.push({ type: 'infantry', size: n });
  }
  budget -= infSpent;

  const enemyTanks = aiEnemyHasTanks(me);
  if (enemyTanks && window.isUnlocked(me, 'cannon')) {
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

  while (budget >= cheapest && units.length < 100) {
    const affordable = roster.filter(t => PIECES[t].cost <= budget);
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

function aiResearchTech(me) {
  if (typeof TECH === 'undefined') return;
  if (aiEnemyHasTanks(me) && !window.isUnlocked(me, 'cannon')) {
    if (Game.economy[me] >= TECH.cannon * 3) { window.unlockType(me, 'cannon'); return; }
  }
  const locked = Object.keys(TECH)
    .filter(t => !window.isUnlocked(me, t))
    .sort((a, b) => TECH[a] - TECH[b]);
  for (const t of locked) {
    if (Game.economy[me] >= TECH[t] * 3) { window.unlockType(me, t); break; }
  }
}

function aiEnemyTankRow(me) {
  let best = null, bestC = me === 1 ? -1 : Board.COLS;
  for (const u of Game.units) {
    if (u.owner === me) continue;
    if (!(u.parts || []).some(p => p.type === 'tank' && p.count > 0)) continue;
    if (me === 1 ? u.c > bestC : u.c < bestC) { bestC = u.c; best = u.r; }
  }
  return best;
}

function aiDeployUnits(me, specs) {
  if (!specs.length) return 0;
  const cols = Board.COLS, rows = Board.ROWS, zone = Board.zone();
  const frontCol = me === 1 ? cols - zone : zone - 1;
  const targetRow = aiThreatRow(me);
  const tankRow = aiEnemyTankRow(me);
  const noCities = aiHasNoCities(me);

  function buildCands(tRow) {
    const cands = [];
    for (let c = 0; c < cols; c++) {
      if (!window._inZone(me, c)) continue;
      for (let r = 0; r < rows; r++) {
        if (Game.terrain[r][c] === 'water') continue;
        const s = window._stackAt(r, c);
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
    const dest = pool.find(cand => window._stackAt(cand.r, cand.c).length < Rules.STACK_LIMIT)
              || defaultCands.find(cand => window._stackAt(cand.r, cand.c).length < Rules.STACK_LIMIT);
    if (!dest) break;
    const tmpl = compTemplate(PIECES[spec.type].name, { [spec.type]: spec.size });
    const u = window._makeUnit(me, tmpl, dest.r, dest.c, { acted: true, movesLeft: 0 });
    if (!u) continue;
    Game.units.push(u);
    window._addToStack(u);
    placed++;
  }
  for (let i = placed; i < specs.length; i++) Game.economy[me] += PIECES[specs[i].type].cost * specs[i].size;
  return placed;
}

function aiSpendAndReinforce(me) {
  if (Game.economy[me] < 1) return;
  aiResearchTech(me);
  const specs = aiBuyUnits(me);
  const placed = aiDeployUnits(me, specs);
  if (placed) {
    const counts = {};
    for (let i = 0; i < placed; i++) counts[specs[i].type] = (counts[specs[i].type] || 0) + specs[i].size;
    const names = Object.keys(counts).map(t => `${PIECES[t].name} ×${counts[t]}`);
    UI.log(`${PLAYERS[me].name} reinforced with ${names.join(', ')}.`);
  }
}

// ---------------------------------------------------------------------------
// HQ protection — decide whether to flee to edge or escort with largest stack
// ---------------------------------------------------------------------------

function aiProtectHq(hqUnit, me, enemy) {
  if (!hqUnit || hqUnit.movesLeft <= 0) return;

  const nearestEnDist = aiNearestEnemyDist(hqUnit.r, hqUnit.c, me);
  const bigStack = aiBiggestFriendlyStack(me);
  const edgeCol = me === 0 ? 0 : Board.COLS - 1;

  // Decide strategy: escort (move toward biggest stack) or flee (move to edge).
  // Escort when: biggest stack is large (>=4) and closer than the nearest enemy,
  // or HQ is already near the edge and the stack is reasonably close.
  let strategy = 'flee';
  if (bigStack && bigStack.count >= 4) {
    const distToStack = Rules.hexDist(hqUnit.r, hqUnit.c, bigStack.r, bigStack.c);
    const stackEnemyDist = aiNearestEnemyDist(bigStack.r, bigStack.c, me);
    // Escort if the stack is safer than the HQ's current position, or within
    // reach and has enough troops to protect.
    if (distToStack <= nearestEnDist && stackEnemyDist > 2) {
      strategy = 'escort';
    } else if (distToStack <= 3 && bigStack.count >= 6) {
      strategy = 'escort';
    }
  }

  Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, [hqUnit]);
  const urgent = nearestEnDist <= 3;

  let bestKey = null, bestScore = -Infinity;
  for (const kk of Game.reachable.keys()) {
    const [rr, cc] = kk.split(',').map(Number);
    const enemyAdj = aiCountNeighborUnits(rr, cc, enemy);
    const friendNear = aiCountNeighborUnits(rr, cc, me);
    let enemy2 = 0, enemy3 = 0;
    for (const u of Game.units) {
      if (u.owner === me) continue;
      const d = Rules.hexDist(u.r, u.c, rr, cc);
      if (d <= 2) enemy2++;
      if (d <= 3) enemy3++;
    }

    let score;
    if (strategy === 'escort' && bigStack) {
      // Prefer tiles closer to the biggest friendly stack.
      const distToStack = Rules.hexDist(rr, cc, bigStack.r, bigStack.c);
      score = -distToStack * 4 - enemyAdj * 20 - enemy2 * 12 - enemy3 * 4 + friendNear * 5;
    } else {
      // Flee: prefer tiles closer to own edge.
      const edgeDist = Math.abs(cc - edgeCol);
      const edgeW = urgent ? 1 : 3;
      score = -edgeDist * edgeW - enemyAdj * 20 - enemy2 * 15 - enemy3 * 5 + friendNear * 3;
    }

    if (score > bestScore) { bestScore = score; bestKey = [rr, cc]; }
  }

  if (bestKey && (bestKey[0] !== hqUnit.r || bestKey[1] !== hqUnit.c)) {
    window._moveGroup([hqUnit], bestKey[0], bestKey[1]);
  }
}

// ---------------------------------------------------------------------------
// Attack decision — terrain-aware force comparison with numeric thresholds
// ---------------------------------------------------------------------------

// Compute terrain-aware force ratio and decide whether to attack.
// hpRatio thresholds: 2x = always attack, 1.75x/1.5x/1.25x progressively
// lower the required forceRatio.
function aiShouldAttack(group, r, c, defStack, tr, tc, aggressive) {
  const atkTerr = Game.terrain[r][c];
  const defTerr = Game.terrain[tr][tc];

  // Terrain-aware ATK: how much damage we actually deal from our tile.
  const myAtk = aiStackAtkOn(group, r, c);
  const myHp = aiStackHp(group);
  const defAtk = aiStackAtkOn(defStack, tr, tc);
  const defHp = aiStackHp(defStack);

  // Defender's terrain defense reduces our effective damage.
  const defDef = 1 - (TERRAIN[defTerr].defense || 0);
  const effectiveAtkDmg = myAtk * defDef;

  // Force ratio: our effective damage * our HP vs their effective damage * their HP.
  const forceRatio = (effectiveAtkDmg * myHp) / Math.max(1, defAtk * defHp);

  // HP ratio: simple numeric advantage.
  const hpRatio = myHp / Math.max(1, defHp);

  // 2x HP advantage: attack no matter what.
  if (hpRatio >= 2.0) return true;

  // Aggressive mode (global numeric superiority): attack unless suicidal.
  if (aggressive) return forceRatio >= 0.3;

  // Numeric advantage lowers the threshold for attacking.
  // 1.75x HP -> need forceRatio >= 0.4
  // 1.50x HP -> need forceRatio >= 0.55
  // 1.25x HP -> need forceRatio >= 0.65
  // Otherwise use terrain-based thresholds.
  if (hpRatio >= 1.75) return forceRatio >= 0.4;
  if (hpRatio >= 1.5)  return forceRatio >= 0.55;
  if (hpRatio >= 1.25) return forceRatio >= 0.65;

  // No numeric advantage: terrain determines caution.
  const enemyOnDefensive = defTerr === 'city' || defTerr === 'village' ||
                           defTerr === 'forest' || defTerr === 'water';
  if (enemyOnDefensive) return forceRatio >= 2.0;
  return forceRatio >= 0.7;
}

// Check if there's a reachable enemy stack we outnumber 2x in HP — if so,
// move to attack it regardless of other considerations.
function aiFindOverwhelmTarget(group, r, c, me) {
  const enemy = 1 - me;
  const myHp = aiStackHp(group);
  Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, group);

  let best = null, bestRatio = 0;
  for (const [nr, nc] of Rules.neighbors(r, c)) {
    if (!Board.inBounds(nr, nc)) continue;
    const s = window._stackAt(nr, nc);
    if (!s.length || s[0].owner !== enemy) continue;
    const eHp = aiStackHp(s);
    const ratio = myHp / Math.max(1, eHp);
    if (ratio >= 2.0 && ratio > bestRatio) {
      bestRatio = ratio;
      best = { r: nr, c: nc };
    }
  }
  if (best) return best;

  // Check tiles within movement range (not just adjacent).
  for (const kk of Game.reachable.keys()) {
    const [rr, cc] = kk.split(',').map(Number);
    // Check if this tile is adjacent to an enemy we overwhelm.
    for (const [nr, nc] of Rules.neighbors(rr, cc)) {
      if (!Board.inBounds(nr, nc)) continue;
      const s = window._stackAt(nr, nc);
      if (!s.length || s[0].owner !== enemy) continue;
      const eHp = aiStackHp(s);
      const ratio = myHp / Math.max(1, eHp);
      if (ratio >= 2.0 && ratio > bestRatio) {
        bestRatio = ratio;
        best = { staging: { r: rr, c: cc }, target: { r: nr, c: nc } };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Main AI loop — move and fight
// ---------------------------------------------------------------------------

function runAiFor(me) {
  const tiles = [];
  for (const [k, s] of Game.unitAt) if (s.length && s[0].owner === me) tiles.push(k);

  const noCities = aiHasNoCities(me);
  const fewCities = aiMyCityCount(me) < 5;
  const enemy = 1 - me;

  const myUnits = aiUnitCount(me);
  const enemyUnits = aiUnitCount(enemy);
  const aggressive = myUnits > enemyUnits * 1.4;

  const playerStacks = aiStackCount(enemy);
  const playerSpreading = playerStacks >= 5;
  const shouldConcentrate = !playerSpreading && playerStacks <= 3;

  for (const k0 of tiles) {
    let [r, c] = k0.split(',').map(Number);
    let group = window._stackAt(r, c).filter(u => u.owner === me);
    if (!group.length) continue;

    // --- HQ protection: flee to edge or escort with biggest stack ---
    const hqInGroup = group.find(u => window.isHqUnit(u));
    if (hqInGroup && hqInGroup.movesLeft > 0) {
      aiProtectHq(hqInGroup, me, enemy);
      group = window._stackAt(r, c).filter(u => u.owner === me);
      if (!group.length) continue;
    }

    const avgHpRatio = group.reduce((s, u) => s + u.hp / u.maxHp, 0) / group.length;

    // --- Healing: rest in supply range when low HP ---
    if (avgHpRatio < 0.5 && aiInSupplyRange(r, c, me)) continue;

    const nearbyEnemies = aiCountNeighborUnits(r, c, enemy);
    const nearbyFriendlies = aiCountNeighborUnits(r, c, me);

    // --- Overwhelm check: if we outnumber a reachable enemy 2x, attack it ---
    const overwhelm = aiFindOverwhelmTarget(group, r, c, me);
    if (overwhelm) {
      if (overwhelm.staging) {
        // Move to staging tile, then attack.
        Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, group);
        if (Game.reachable.has(Board.key(overwhelm.staging.r, overwhelm.staging.c))) {
          window._moveGroup(group, overwhelm.staging.r, overwhelm.staging.c);
          r = overwhelm.staging.r; c = overwhelm.staging.c;
          group = window._stackAt(r, c).filter(u => u.owner === me);
        }
        if (group.length && Rules.isHexNeighbor(r, c, overwhelm.target.r, overwhelm.target.c)) {
          window._doAttack(group, overwhelm.target.r, overwhelm.target.c);
        }
      } else {
        // Already adjacent.
        window._doAttack(group, overwhelm.r, overwhelm.c);
      }
      continue;
    }

    // --- Retreat: outnumbered, seek defensive terrain ---
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
        let bestD2 = Infinity;
        for (const kk of Game.reachable.keys()) {
          const [rr, cc] = kk.split(',').map(Number);
          const en = aiCountNeighborUnits(rr, cc, enemy);
          if (en < bestD2) { bestD2 = en; bestRetreat = [rr, cc]; }
        }
      }
      if (bestRetreat) {
        window._moveGroup(group, bestRetreat[0], bestRetreat[1]);
      }
      continue;
    }

    // --- Target selection: prioritise weak targets and cities ---
    let target;
    if (noCities || fewCities) {
      target = nearestUnownedCityOrVillage(r, c, me) || aiBestTarget(r, c, me) || nearestEnemyTile(r, c, me);
    } else if (shouldConcentrate) {
      target = aiLargestEnemyCluster(me) || nearestEnemyTile(r, c, me);
    } else {
      target = aiBestTarget(r, c, me) || nearestEnemyTile(r, c, me);
    }
    if (!target) break;

    // --- Move toward target ---
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
        window._moveGroup(group, chosen[0], chosen[1]);
        r = chosen[0]; c = chosen[1];
        group = window._stackAt(r, c).filter(u => u.owner === me);
        if (noCities || fewCities) {
          target = nearestUnownedCityOrVillage(r, c, me) || aiBestTarget(r, c, me) || nearestEnemyTile(r, c, me);
        } else if (shouldConcentrate) {
          target = aiLargestEnemyCluster(me) || nearestEnemyTile(r, c, me);
        } else {
          target = aiBestTarget(r, c, me) || nearestEnemyTile(r, c, me);
        }
      }
    }

    // --- Attack decision: terrain-aware force comparison with numeric thresholds ---
    if (target && group.length && Rules.isHexNeighbor(r, c, target.r, target.c)) {
      const defStack = window._stackAt(target.r, target.c);
      if (defStack.length && defStack[0].owner !== me) {
        if (aiShouldAttack(group, r, c, defStack, target.r, target.c, aggressive)) {
          window._doAttack(group, target.r, target.c);
        } else if (!isDefensiveTerrain(r, c)) {
          // Can't win: find a defensive tile to hold instead.
          Game.reachable = Rules.reachable(Game.terrain, Game.unitAt, group);
          let bestDef = null, bestDD = Infinity;
          for (const kk of Game.reachable.keys()) {
            const [rr, cc] = kk.split(',').map(Number);
            if (!isDefensiveTerrain(rr, cc)) continue;
            const d = Rules.hexDist(rr, cc, target.r, target.c);
            if (d < bestDD) { bestDD = d; bestDef = [rr, cc]; }
          }
          if (bestDef) {
            window._moveGroup(group, bestDef[0], bestDef[1]);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Turn drivers — called by game.js
// ---------------------------------------------------------------------------

function runAiTurn() {
  const me = Game.aiPlayer;
  const logStart = (window.UI && UI.entries) ? UI.entries.length : 0;
  runAiFor(me);
  if (Game.winner === null) aiSpendAndReinforce(me);
  Game.reachable = new Map();
  window._persist();
  UI.refresh();
  Render.render();
  if (window.UI && UI.showEnemyMoves) UI.showEnemyMoves(UI.entries.slice(logStart));
  window._advanceTo(1 - me);
}

function runAiTakeover() {
  if (Game.winner !== null) return;
  if (window.inPlacement()) { UI.log('Deploy your units first.'); UI.refresh(); return; }
  if (Game.orderQueue.length) window.clearAllOrders();
  const me = Game.turn;
  const logStart = (window.UI && UI.entries) ? UI.entries.length : 0;
  runAiFor(me);
  if (Game.winner === null) aiSpendAndReinforce(me);
  Game.reachable = new Map();
  window._persist();
  UI.refresh();
  Render.render();
  if (window.UI && UI.showEnemyMoves) UI.showEnemyMoves(UI.entries.slice(logStart));
  window._advanceTo(1 - me);
}

// Expose to game.js and index.html
window.runAiTurn = runAiTurn;
window.runAiTakeover = runAiTakeover;
