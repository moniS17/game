/*
 * rules.js — all game rules in one place: movement, combat, economy.
 *
 * Keeping every rule here means balance and mechanics can change without
 * touching state management (game.js), the board (board.js) or rendering.
 *
 * STACKING (units built from templates)
 *   - A board piece is a UNIT built from a template (a 5x5 blueprint of subunits).
 *     Its HP/ATK are the sum of its subunits (see `parts`). Many units may share
 *     one template. Up to STACK_LIMIT (17) units of one owner may share a tile.
 *   - Units move and fight as a selected GROUP (1..N chosen from a tile).
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
 *   - A stack whose FOUR orthogonal neighbours are all the enemy's territory
 *     colour is surrounded and takes DOUBLE damage from that enemy.
 *   - Damage is dealt 1-by-1 down each stack (see game.js applyDamage).
 *
 * ECONOMY
 *   income(player) = base_income + city_income*(cities owned) + 50%*(villages owned)
 */
window.Rules = (function () {
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const STACK_LIMIT = 17; // max UNITS that may stack on one tile (a template's 5x5 = 25 subunits is separate)

  const COMBAT = {
    river_attack_penalty: 0.2, // fraction cut from ATK when you or your target stands in water
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

  // A unit is built from a template: its `parts` are per-subunit-type groups
  // ({type, count, atk, hp, mov}). Effective attack = sum of each part's total
  // attack (count × per-subunit atk, already including upgrades snapshotted at
  // build time). Falls back to a legacy single-type unit if `parts` is absent.
  function unitParts(u) {
    if (u.parts && u.parts.length) return u.parts;
    return [{ type: u.type, count: 1, atk: PIECES[u.type].attack + (u.atkBonus || 0),
      hp: u.maxHp || PIECES[u.type].hp, mov: PIECES[u.type].movement_speed }];
  }
  function unitAttack(u) {
    let s = 0;
    for (const p of unitParts(u)) s += p.count * p.atk;
    return s;
  }

  // Terrain combat modifier: how a subunit type's ATK scales when it fights
  // FROM `terrainType` (the tile it stands on) — units.js / TERRAIN_COMBAT.
  // 1 when unlisted.
  function terrainAtkMult(type, terrainType) {
    const row = (typeof TERRAIN_COMBAT !== 'undefined') && TERRAIN_COMBAT[type];
    return (row && row[terrainType]) || 1;
  }

  // Unit-vs-unit combat modifier: how an attacker subunit `type` fares against a
  // defender of `foeType` (units.js / UNIT_COMBAT). 1 when unlisted.
  function unitMatchupMult(type, foeType) {
    const row = (typeof UNIT_COMBAT !== 'undefined') && UNIT_COMBAT[type];
    return (row && row[foeType]) || 1;
  }

  // A unit's attack while standing on `terrainType`: each part scaled by how
  // its subunit type fights from that terrain, then summed.
  function unitAttackOn(u, terrainType) {
    let s = 0;
    for (const p of unitParts(u)) s += p.count * p.atk * terrainAtkMult(p.type, terrainType);
    return s;
  }

  // A unit's attack while standing on `terrainType` against a `foeType` stack:
  // each part scaled by BOTH its terrain modifier and its unit-vs-unit matchup,
  // then summed.
  function unitAttackOnFoe(u, terrainType, foeType) {
    let s = 0;
    for (const p of unitParts(u)) {
      s += p.count * p.atk * terrainAtkMult(p.type, terrainType) * unitMatchupMult(p.type, foeType);
    }
    return s;
  }

  function sumAttack(group) {
    let s = 0;
    for (const u of group) s += unitAttack(u);
    return s;
  }

  // Sum of a group's attack while standing on `terrainType`.
  function sumAttackOn(group, terrainType) {
    let s = 0;
    for (const u of group) s += unitAttackOn(u, terrainType);
    return s;
  }

  // Sum of a group's attack while standing on `terrainType` against a `foeType`
  // stack (terrain + unit-vs-unit matchup both applied per subunit part).
  function sumAttackOnFoe(group, terrainType, foeType) {
    let s = 0;
    for (const u of group) s += unitAttackOnFoe(u, terrainType, foeType);
    return s;
  }

  // Is the tile (r,c) hemmed in on all FOUR orthogonal sides by `byOwner`'s
  // territory colour? Board-edge tiles (a missing neighbour) are never counted
  // as surrounded.
  function surroundedBy(territory, r, c, byOwner) {
    if (!territory) return false;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (!Board.inBounds(nr, nc)) return false;
      if (!territory[nr] || territory[nr][nc] !== byOwner) return false;
    }
    return true;
  }

  // Mutual stack-vs-stack damage. Returns total damage each side deals to the
  // other (to be applied 1-by-1 by the caller). attackers/defenders are arrays;
  // they sit on adjacent tiles. `territory` (optional) is the per-tile owner grid
  // used for the "surrounded by enemy colour → double damage" rule.
  function resolveCombat(terrain, attackers, defenders, territory) {
    const aTile = attackers[0], dTile = defenders[0];
    const aTerr = terrain[aTile.r][aTile.c], dTerr = terrain[dTile.r][dTile.c];
    const acrossRiver =
      Board.isWater(terrain, aTile.r, aTile.c) ||
      Board.isWater(terrain, dTile.r, dTile.c);
    const riverMult = acrossRiver ? (1 - COMBAT.river_attack_penalty) : 1;

    // Each side's ATK is scaled per-unit by how it fights FROM the tile it
    // stands on (its OWN terrain — e.g. a unit in water fights weakly) AND how
    // its subunits match up against the OTHER stack's front unit type. The total
    // is then cut by its own tile's attack_penalty (e.g. a village debuffs its
    // occupants' outgoing damage) and the river penalty. The DEFENDER's tile
    // defense then reduces damage dealt to them — but the attacker does NOT
    // benefit from their own tile's defense (initiating combat forfeits cover).
    const aType = attackers[0].type, dType = defenders[0].type;
    const aPen = 1 - (TERRAIN[aTerr].attack_penalty || 0);
    const dPen = 1 - (TERRAIN[dTerr].attack_penalty || 0);
    const dDef = 1 - (TERRAIN[dTerr].defense || 0);
    let dmgToDef = sumAttackOnFoe(attackers, aTerr, dType) * aPen * riverMult * dDef;
    let dmgToAtk = sumAttackOnFoe(defenders, dTerr, aType) * dPen * riverMult;
    dmgToDef = Math.max(1, Math.round(dmgToDef));
    dmgToAtk = Math.max(1, Math.round(dmgToAtk));

    // Surrounded penalty: a stack whose four orthogonal neighbours are all the
    // ENEMY's territory colour takes double damage from that enemy.
    const aOwner = aTile.owner, dOwner = dTile.owner;
    const defSurrounded = surroundedBy(territory, dTile.r, dTile.c, aOwner);
    const atkSurrounded = surroundedBy(territory, aTile.r, aTile.c, dOwner);
    if (defSurrounded) dmgToDef *= 2;
    if (atkSurrounded) dmgToAtk *= 2;

    return { dmgToDef, dmgToAtk, defSurrounded, atkSurrounded };
  }

  function isAdjacent(a, b) {
    return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
  }

  // Gold per round for `player`: flat base + city_income per owned city +
  // half that (rounded) per owned village. `villages` may be omitted. `eco` is
  // the player's economy-upgrade levels ({passive, city, village}); each level
  // adds ECO_UPGRADES[stream].gain gold to that stream (see units.js).
  function income(cities, villages, player, eco) {
    eco = eco || {};
    const ecoGain = (typeof ECO_UPGRADES !== 'undefined' && ECO_UPGRADES) || {};
    const g = (k) => (ecoGain[k] && ecoGain[k].gain) || 1;
    let cityOwned = 0, villageOwned = 0;
    for (const ci of (cities || [])) if (ci.owner === player) cityOwned++;
    for (const v of (villages || [])) if (v.owner === player) villageOwned++;
    const perCity = ECONOMY.city_income + (eco.city || 0) * g('city');
    const perVillage = Math.round(ECONOMY.city_income * 0.5) + (eco.village || 0) * g('village');
    return ECONOMY.base_income + (eco.passive || 0) * g('passive') + perCity * cityOwned + perVillage * villageOwned;
  }

  return { DIRS, COMBAT, STACK_LIMIT, canStep, reachable, resolveCombat, isAdjacent, income, unitAttack, unitAttackOn, terrainAtkMult, unitMatchupMult };
})();
