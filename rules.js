/*
 * rules.js — all game rules in one place: movement, combat, economy.
 *
 * Keeping every rule here means balance and mechanics can change without
 * touching state management (game.js), the board (board.js) or rendering.
 *
 * STACKING
 *   - Many units of the SAME owner may share a tile (a "stack"), up to
 *     STACK_LIMIT (17). `unitAt` is a Map "r,c" -> Unit[] (the stack).
 *   - Units move and fight as a selected GROUP (1..N units chosen from a tile).
 *
 * MOVEMENT
 *   - Each tile costs its terrain move_cost to enter (board.js / TERRAIN).
 *   - WATER: a single water tile costs 2 to enter; two water tiles in a row are
 *     impassable (a move may never go water -> water). 1-wide rivers cross.
 *   - A moving group is blocked by ENEMY-occupied tiles (walls). It may pass
 *     over its own units; it may only STOP on a tile if the friendly units
 *     already there plus the group fit within STACK_LIMIT.
 *   - A group's speed is its SLOWEST member (min movesLeft).
 *
 * COMBAT (mutual, stack-vs-stack, adjacent only)
 *   - Count both sides first. Each side deals the SUM of its members' attack,
 *     reduced by the OTHER tile's terrain defense and a river penalty.
 *   - The side outnumbered >= 2:1 takes DOUBLE damage ("no matter quality").
 *   - Damage is dealt 1-by-1 down each stack (see game.js applyDamage).
 *
 * ECONOMY
 *   income(player) = base_income + city_income * (cities owned)
 */
window.Rules = (function () {
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const STACK_LIMIT = 17;

  const COMBAT = {
    river_attack_penalty: 2, // attacking while you or your target stands in water
  };

  // Can a unit step from (r,c) to the orthogonally-adjacent (nr,nc)?
  // Enforces the "no two consecutive water tiles" rule. Does not check the
  // movement budget (the caller does that) or occupancy.
  function canStep(terrain, r, c, nr, nc) {
    if (!Board.inBounds(nr, nc)) return false;
    if (Board.isWater(terrain, r, c) && Board.isWater(terrain, nr, nc)) return false;
    return true;
  }

  // Count of units on a tile and the owner of that stack (null if empty).
  function stackInfo(unitAt, r, c) {
    const s = unitAt.get(Board.key(r, c));
    if (!s || !s.length) return { count: 0, owner: null };
    return { count: s.length, owner: s[0].owner };
  }

  // Tiles a GROUP can reach this turn -> Map("r,c" -> movement points left).
  // `group` is an array of units sharing a tile/owner; speed = slowest member.
  // Enemy-occupied tiles are walls; the group may pass over its own units but
  // may only STOP where friendlyCount + group.length <= STACK_LIMIT.
  function reachable(terrain, unitAt, group) {
    const reach = new Map();
    if (!group || !group.length) return reach;
    const owner = group[0].owner;
    const size = group.length;
    const budget0 = Math.min(...group.map((u) => u.movesLeft));
    const sr = group[0].r, sc = group[0].c;
    const start = Board.key(sr, sc);
    reach.set(start, budget0);
    const frontier = [[sr, sc, budget0]];
    while (frontier.length) {
      const [r, c, budget] = frontier.shift();
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (!canStep(terrain, r, c, nr, nc)) continue;
        const info = stackInfo(unitAt, nr, nc);
        if (info.count && info.owner !== owner) continue; // enemy = wall
        const left = budget - TERRAIN[terrain[nr][nc]].move_cost;
        if (left < 0) continue;
        const k = Board.key(nr, nc);
        if (reach.has(k) && reach.get(k) >= left) continue;
        reach.set(k, left);
        frontier.push([nr, nc, left]);
      }
    }
    reach.delete(start);
    // Only keep tiles where the group can actually STOP (capacity check).
    for (const k of [...reach.keys()]) {
      const [r, c] = k.split(',').map(Number);
      const info = stackInfo(unitAt, r, c);
      if (info.count + size > STACK_LIMIT) reach.delete(k);
    }
    return reach;
  }

  // A unit's effective attack = base (units.js) + any in-game upgrade bonus.
  function unitAttack(u) { return PIECES[u.type].attack + (u.atkBonus || 0); }

  function sumAttack(group) {
    let s = 0;
    for (const u of group) s += unitAttack(u);
    return s;
  }

  // Mutual stack-vs-stack damage. Returns total damage each side deals to the
  // other (to be applied 1-by-1 by the caller). attackers/defenders are arrays;
  // they sit on adjacent tiles.
  function resolveCombat(terrain, attackers, defenders) {
    const aTile = attackers[0], dTile = defenders[0];
    const acrossRiver =
      Board.isWater(terrain, aTile.r, aTile.c) ||
      Board.isWater(terrain, dTile.r, dTile.c);
    const river = acrossRiver ? COMBAT.river_attack_penalty : 0;

    let dmgToDef = sumAttack(attackers) - TERRAIN[terrain[dTile.r][dTile.c]].defense - river;
    let dmgToAtk = sumAttack(defenders) - TERRAIN[terrain[aTile.r][aTile.c]].defense - river;
    dmgToDef = Math.max(1, dmgToDef);
    dmgToAtk = Math.max(1, dmgToAtk);

    // The side outnumbered >= 2:1 takes double damage (counts only).
    if (attackers.length >= 2 * defenders.length) dmgToDef *= 2;
    if (defenders.length >= 2 * attackers.length) dmgToAtk *= 2;

    return { dmgToDef, dmgToAtk };
  }

  function isAdjacent(a, b) {
    return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
  }

  function income(cities, player) {
    let owned = 0;
    for (const ci of cities) if (ci.owner === player) owned++;
    return ECONOMY.base_income + ECONOMY.city_income * owned;
  }

  return { DIRS, COMBAT, STACK_LIMIT, canStep, reachable, resolveCombat, isAdjacent, income, unitAttack };
})();
