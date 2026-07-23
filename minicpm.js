/*
 * minicpm.js — MiniCPM LLM AI integration for Battlegrid.
 *
 * Talks to a local llama-server (OpenAI-compatible) running the MiniCPM5
 * GGUF model, with fallback to in-browser WASM inference (wasm-cpm.js).
 * The model receives a compact game-state summary and returns strategic
 * decisions: strategy, tech research, purchases, deployment priorities,
 * and attack targets. The existing algorithmic AI handles pathfinding
 * and combat execution, guided by the model's target list.
 *
 * Depends on: units.js, board.js, rules.js, game.js (core), ai.js
 */

const MiniCPM = (function () {
  let _apiBase = 'http://127.0.0.1:18766';
  let _modelName = 'minicpm';
  let _serverLabel = 'MiniCPM';
  let _apiKey = null;

  function chatUrl() { return _apiBase + '/v1/chat/completions'; }
  function healthUrl() { return _apiBase + '/health'; }

  function configure(baseUrl, modelName, serverName, apiKey) {
    _apiBase = baseUrl.replace(/\/+$/, '');
    _modelName = modelName || 'default';
    _serverLabel = serverName || 'LLM';
    _apiKey = apiKey || null;
  }

  // ── Health check ──────────────────────────────────────────────────────
  async function available() {
    try {
      const r = await fetch(healthUrl(), { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  }

  // ── Loading overlay ───────────────────────────────────────────────────
  let overlay = null;
  function showLoading() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'cpmOverlay';
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(0,0,0,0.55);' +
        '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);';
      const box = document.createElement('div');
      box.style.cssText =
        'background:#23282e;padding:1.5rem 2.5rem;border-radius:12px;' +
        'text-align:center;color:#e6e6e6;font-size:1.1rem;font-weight:600;' +
        'box-shadow:0 8px 30px rgba(0,0,0,.5);';
      box.innerHTML = _serverLabel + ' is thinking<span id="cpmDots">...</span>';
      overlay.appendChild(box);
    }
    document.body.appendChild(overlay);
    let n = 0;
    overlay._interval = setInterval(() => {
      const dots = document.getElementById('cpmDots');
      if (dots) dots.textContent = '.'.repeat((n++ % 3) + 1);
    }, 400);
  }
  function hideLoading() {
    if (overlay && overlay.parentNode) {
      clearInterval(overlay._interval);
      overlay.remove();
    }
  }

  // ── Game state → prompt ───────────────────────────────────────────────
  function serializeState(me) {
    const n = Game.playerCount || 2;
    const myCities = Game.cities.filter(c => c.owner === me);
    const enemyCities = Game.cities.filter(c => c.owner !== me && c.owner != null && window.isAtWar(me, c.owner));
    const neutralCities = Game.cities.filter(c => c.owner == null);
    const myVillages = Game.villages.filter(v => v.owner === me);

    const myUnits = [];
    const enemyUnits = [];
    for (const u of Game.units) {
      const subs = (u.parts || []).reduce((s, p) => s + p.count, 0);
      const entry = { r: u.r, c: u.c, type: u.type, hp: u.hp, maxHp: u.maxHp, subs };
      if (u.owner === me) myUnits.push(entry);
      else if (window.isAtWar(me, u.owner)) enemyUnits.push({ ...entry, owner: u.owner });
    }

    const roster = Object.keys(PIECES)
      .filter(t => window.isUnlocked(me, t) || t === 'hq')
      .map(t => ({ type: t, cost: PIECES[t].cost, atk: PIECES[t].attack, hp: PIECES[t].hp }));

    // Tech tree state
    const lockedTech = [];
    if (typeof TECH !== 'undefined') {
      for (const t in TECH) {
        if (t !== 'infantry' && !window.isUnlocked(me, t)) {
          lockedTech.push({ type: t, cost: TECH[t], atk: PIECES[t].attack, hp: PIECES[t].hp });
        }
      }
    }

    // Diplomacy summary for multiplayer
    let diploLines = '';
    if (n > 2) {
      const rels = [];
      for (let p = 0; p < n; p++) {
        if (p === me || Game.eliminated.has(p)) continue;
        const rel = Game.diplomacy[me] ? Game.diplomacy[me][p] : 'war';
        const units = Game.units.filter(u => u.owner === p).length;
        rels.push(`p${p}(${PLAYERS[p].name}): ${rel}, ${units} units`);
      }
      diploLines = `Diplomacy: ${rels.join('; ')}`;
    }

    // Structures
    const myForts = Game.structures.filter(s => s.owner === me && s.type === 'fort');
    const mySupply = Game.structures.filter(s => s.owner === me && s.type === 'supply');

    const lines = [
      `Board: ${Board.COLS}x${Board.ROWS}. Round ${Game.round}. You are player ${me} (${PLAYERS[me].name}).`,
      `Gold: ${Game.economy[me]}. Income: ~${Rules.income(Game.cities, Game.villages, me, Game.ecoUpgrades && Game.ecoUpgrades[me])}/turn.`,
      `Your cities (${myCities.length}): ${myCities.slice(0, 15).map(c => `[${c.r},${c.c}]`).join(' ')}`,
      `Your villages (${myVillages.length}): ${myVillages.slice(0, 10).map(v => `[${v.r},${v.c}]`).join(' ')}`,
      `Neutral cities: ${neutralCities.slice(0, 10).map(c => `[${c.r},${c.c}]`).join(' ') || 'none'}`,
      `Enemy cities (${enemyCities.length}): ${enemyCities.slice(0, 15).map(c => `[${c.r},${c.c}] p${c.owner}`).join(' ')}`,
      `Your units (${myUnits.length}): ${myUnits.slice(0, 20).map(u => `[${u.r},${u.c}] ${u.type} ${u.hp}/${u.maxHp} x${u.subs}`).join('; ')}`,
      `Enemy units (${enemyUnits.length}): ${enemyUnits.slice(0, 20).map(u => `[${u.r},${u.c}] ${u.type} ${u.hp}/${u.maxHp} p${u.owner}`).join('; ')}`,
      `Buyable: ${roster.map(r => `${r.type}(${r.cost}g,${r.atk}atk,${r.hp}hp)`).join(', ')}`,
    ];
    if (lockedTech.length) {
      lines.push(`Researchable: ${lockedTech.map(t => `${t.type}(${t.cost}g to unlock, ${t.atk}atk, ${t.hp}hp)`).join(', ')}`);
    }
    if (myForts.length || mySupply.length) {
      lines.push(`Your structures: ${myForts.length} forts, ${mySupply.length} supply hubs`);
    }
    if (diploLines) lines.push(diploLines);
    return lines.join('\n');
  }

  let _background = '';
  (function loadBackground() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'ai-background.txt', true);
    xhr.onload = function () { _background = xhr.responseText || ''; };
    xhr.send();
  })();

  const RESPONSE_FORMAT =
    'Reply with ONLY valid JSON, no markdown.\n' +
    'Format: {"strategy":"attack|defend|balanced",' +
    '"research":"unit_type_to_unlock_or_null",' +
    '"buy":[{"type":"infantry","size":4}],' +
    '"targets":[[row,col]]}.\n' +
    'Fields:\n' +
    '- "strategy": overall aggression level for movement.\n' +
    '- "research": a locked unit type to research (spend gold to unlock), or null if none.\n' +
    '- "buy": units to purchase. "type" is the unit type, "size" is companies per unit (1-12). Cost = type_cost * size. Stay within gold budget AFTER research.\n' +
    '- "targets": enemy or neutral positions [row,col] to prioritize attacking/capturing, most important first. Include enemy cities, weak enemy stacks, and neutral cities worth grabbing.';

  function systemPrompt() {
    return (_background ? _background + '\n\n' : '') + RESPONSE_FORMAT;
  }

  // ── Call the model ────────────────────────────────────────────────────
  async function query(me, extraHint) {
    const state = serializeState(me);
    const userMsg = state + (extraHint ? '\n' + extraHint : '');

    const body = {
      model: _modelName,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.3,
      max_tokens: 384,
      stream: false,
    };

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (_apiKey) headers['Authorization'] = 'Bearer ' + _apiKey;
      const resp = await fetch(chatUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) throw new Error('llama-server returned ' + resp.status);
      const data = await resp.json();
      return (data.choices && data.choices[0] && data.choices[0].message &&
        data.choices[0].message.content) || '';
    } catch (serverErr) {
      if (window.WasmCPM && window.WasmCPM.isReady()) {
        console.log('MiniCPM: server offline, using in-browser WASM');
        return await window.WasmCPM.complete(systemPrompt(), userMsg);
      }
      throw serverErr;
    }
  }

  function parseResponse(text) {
    let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    clean = clean.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(clean.slice(start, end + 1));
    } catch { return null; }
  }

  // ── Parse and validate model targets ─────────────────────────────────
  function parseTargets(raw) {
    if (!Array.isArray(raw)) return [];
    const targets = [];
    for (const t of raw) {
      if (!Array.isArray(t) || t.length < 2) continue;
      const r = parseInt(t[0]), c = parseInt(t[1]);
      if (isNaN(r) || isNaN(c)) continue;
      if (!Board.inBounds(r, c)) continue;
      targets.push([r, c]);
    }
    return targets;
  }

  // ── Execute model decisions using the existing AI engine ──────────────
  function applyDecisions(me, decisions) {
    const strategy = ['attack', 'defend', 'balanced'].includes(decisions.strategy)
      ? decisions.strategy : 'balanced';
    Game.aiStrategy[me] = strategy;

    // Tech research
    if (decisions.research && typeof decisions.research === 'string' && decisions.research !== 'null') {
      const techType = decisions.research;
      if (typeof TECH !== 'undefined' && TECH[techType] && !window.isUnlocked(me, techType)) {
        if (Game.economy[me] >= TECH[techType]) {
          window.unlockType(me, techType);
          UI.log(`${PLAYERS[me].name} (CPM) researched ${PIECES[techType].name}.`);
        }
      }
    }

    // Purchases
    if (Array.isArray(decisions.buy) && decisions.buy.length) {
      const specs = [];
      let budget = Game.economy[me];
      for (const item of decisions.buy) {
        const type = (item.type && PIECES[item.type]) ? item.type : 'infantry';
        if (type !== 'hq' && !window.isUnlocked(me, type)) continue;
        const size = Math.max(1, Math.min(25, parseInt(item.size) || 4));
        const cost = PIECES[type].cost * size;
        if (cost > budget) continue;
        budget -= cost;
        specs.push({ type, size });
      }
      if (specs.length) {
        Game.economy[me] = budget;
        window.aiDeployUnits(me, specs);
        const counts = {};
        for (const s of specs) counts[s.type] = (counts[s.type] || 0) + s.size;
        const names = Object.keys(counts).map(t => `${PIECES[t].name} x${counts[t]}`);
        UI.log(`${PLAYERS[me].name} (CPM) reinforced with ${names.join(', ')}.`);
      }
    }

    // Parse targets from model response
    const targets = parseTargets(decisions.targets);

    // Movement: use model-provided targets to guide the algorithmic movement
    window.runAiFor(me, strategy, targets.length ? targets : undefined);
  }

  // ── Public turn drivers ───────────────────────────────────────────────
  async function runTurn(me) {
    showLoading();
    try {
      const text = await query(me);
      const decisions = parseResponse(text);
      if (decisions) {
        applyDecisions(me, decisions);
      } else {
        console.warn('MiniCPM: unparseable response, falling back to algorithm');
        UI.log(`${PLAYERS[me].name} (CPM fallback) using algorithm.`);
        window.runAiFor(me);
        window.aiSpendAndReinforce(me);
      }
    } catch (err) {
      console.error('MiniCPM error:', err);
      UI.log(`${PLAYERS[me].name} (CPM offline) using algorithm.`);
      window.runAiFor(me);
      window.aiSpendAndReinforce(me);
    }
    hideLoading();
  }

  async function runCpmTurn() {
    const me = Game.turn;
    const logStart = (window.UI && UI.entries) ? UI.entries.length : 0;
    try {
      window.aiDiplomacy && window.aiDiplomacy(me);
      window.aiSendGold && window.aiSendGold(me);
      window.aiSplitForExpansion && window.aiSplitForExpansion(me);
      await runTurn(me);
    } catch (e) {
      console.error('CPM turn error:', e);
    }
    Game.reachable = new Map();
    window._persist();
    UI.refresh();
    Render.render();
    if (window.UI && UI.showEnemyMoves) UI.showEnemyMoves(UI.entries.slice(logStart));
    window._advanceTo(window.nextPlayer(me));
  }

  async function runCpmTakeover(strategy) {
    if (Game.winner !== null) return;
    if (window.inPlacement()) { UI.log('Deploy your units first.'); UI.refresh(); return; }
    if (Game.orderQueue.length) window.clearAllOrders();
    const me = Game.turn;
    const logStart = (window.UI && UI.entries) ? UI.entries.length : 0;
    showLoading();
    try {
      const hint = strategy ? `Preferred strategy: ${strategy}.` : '';
      const text = await query(me, hint);
      const decisions = parseResponse(text);
      if (decisions) {
        if (strategy) decisions.strategy = strategy;
        applyDecisions(me, decisions);
      } else {
        window.runAiFor(me, strategy || 'balanced');
        if (Game.winner === null) window.aiSpendAndReinforce(me);
      }
    } catch (err) {
      console.error('CPM takeover error:', err);
      window.runAiFor(me, strategy || 'balanced');
      if (Game.winner === null) window.aiSpendAndReinforce(me);
    }
    hideLoading();
    Game.reachable = new Map();
    window._persist();
    UI.refresh();
    Render.render();
    if (window.UI && UI.showEnemyMoves) UI.showEnemyMoves(UI.entries.slice(logStart));
    window._advanceTo(window.nextPlayer(me));
  }

  async function ensureRunning() {
    if (_apiKey) return;
    if (await available()) return;
    if (window.WasmCPM && window.WasmCPM.isCached()) {
      const toast = document.createElement('div');
      toast.style.cssText =
        'position:fixed;top:1rem;left:50%;transform:translateX(-50%);z-index:9999;' +
        'background:#2e7d32;color:#fff;padding:.8rem 1.4rem;border-radius:8px;' +
        'font-size:.85rem;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.5);text-align:center;';
      toast.textContent = 'Loading in-browser AI model...';
      document.body.appendChild(toast);
      try {
        await window.WasmCPM.load();
        toast.textContent = 'In-browser AI ready';
        setTimeout(() => toast.remove(), 3000);
        return;
      } catch (e) {
        console.error('WASM load failed:', e);
        toast.remove();
      }
    }
    const toast = document.createElement('div');
    toast.style.cssText =
      'position:fixed;top:1rem;left:50%;transform:translateX(-50%);z-index:9999;' +
      'background:#b8412f;color:#fff;padding:.8rem 1.4rem;border-radius:8px;' +
      'font-size:.85rem;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.5);text-align:center;';
    toast.textContent = _serverLabel + ' server not reachable — run ./start-minicpm.sh then reload';
    document.body.appendChild(toast);
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 3000));
      if (await available()) { toast.remove(); return; }
    }
  }

  return { available, ensureRunning, runCpmTurn, runCpmTakeover, configure };
})();

window.MiniCPM = MiniCPM;
window.runCpmTurn = MiniCPM.runCpmTurn;
window.runCpmTakeover = MiniCPM.runCpmTakeover;
