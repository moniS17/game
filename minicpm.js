/*
 * minicpm.js — MiniCPM LLM AI integration for Battlegrid.
 *
 * Talks to a local llama-server (OpenAI-compatible) running the MiniCPM5
 * GGUF model. The model receives a compact game-state summary and returns
 * strategic decisions (strategy, purchases, movement targets). The existing
 * algorithmic AI handles pathfinding and combat execution.
 *
 * Depends on: units.js, board.js, rules.js, game.js (core), ai.js
 */

const MiniCPM = (function () {
  const API = 'http://127.0.0.1:18766';
  const CHAT_URL = API + '/v1/chat/completions';
  const HEALTH_URL = API + '/health';

  // ── Health check ──────────────────────────────────────────────────────
  async function available() {
    try {
      const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
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
      box.innerHTML = '🧠 MiniCPM is thinking<span id="cpmDots">...</span>';
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
      .filter(t => t !== 'hq' && window.isUnlocked(me, t))
      .map(t => ({ type: t, cost: PIECES[t].cost, atk: PIECES[t].attack, hp: PIECES[t].hp }));

    return [
      `Board: ${Board.COLS}x${Board.ROWS}. Round ${Game.round}. You are player ${me} (${PLAYERS[me].name}).`,
      `Gold: ${Game.economy[me]}. Income: ~${Rules.income(Game.cities, Game.villages, me, Game.ecoUpgrades && Game.ecoUpgrades[me])}/turn.`,
      `Your cities (${myCities.length}): ${myCities.slice(0, 15).map(c => `[${c.r},${c.c}]`).join(' ')}`,
      `Your villages (${myVillages.length}): ${myVillages.slice(0, 10).map(v => `[${v.r},${v.c}]`).join(' ')}`,
      `Neutral cities: ${neutralCities.slice(0, 10).map(c => `[${c.r},${c.c}]`).join(' ') || 'none'}`,
      `Enemy cities (${enemyCities.length}): ${enemyCities.slice(0, 15).map(c => `[${c.r},${c.c}] p${c.owner}`).join(' ')}`,
      `Your units (${myUnits.length}): ${myUnits.slice(0, 20).map(u => `[${u.r},${u.c}] ${u.type} ${u.hp}/${u.maxHp} x${u.subs}`).join('; ')}`,
      `Enemy units (${enemyUnits.length}): ${enemyUnits.slice(0, 20).map(u => `[${u.r},${u.c}] ${u.type} ${u.hp}/${u.maxHp} p${u.owner}`).join('; ')}`,
      `Buyable: ${roster.map(r => `${r.type}(${r.cost}g)`).join(', ')}`,
    ].join('\n');
  }

  const SYSTEM_PROMPT =
    'You are the AI for a hex-grid strategy game. Given the board state, ' +
    'decide your strategy and purchases. Reply with ONLY valid JSON, no markdown.\n' +
    'Format: {"strategy":"attack|defend|balanced","buy":[{"type":"infantry","size":4}],' +
    '"targets":[[row,col]]}.\n' +
    '"strategy" sets overall aggression. ' +
    '"buy" lists units to purchase (type + company count per unit; cost = type_cost * size). ' +
    'Stay within your gold budget. ' +
    '"targets" lists enemy positions (row,col) to prioritize attacking, most important first.';

  // ── Call the model ────────────────────────────────────────────────────
  async function query(me, extraHint) {
    const state = serializeState(me);
    const userMsg = state + (extraHint ? '\n' + extraHint : '');

    const body = {
      model: 'minicpm',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.3,
      max_tokens: 384,
      stream: false,
    };

    try {
      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        return await window.WasmCPM.complete(SYSTEM_PROMPT, userMsg);
      }
      throw serverErr;
    }
  }

  function parseResponse(text) {
    // Strip markdown fences if present
    let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    // Strip <think>...</think> blocks
    clean = clean.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Find the first { ... } block
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(clean.slice(start, end + 1));
    } catch { return null; }
  }

  // ── Execute model decisions using the existing AI engine ──────────────
  function applyDecisions(me, decisions) {
    const strategy = ['attack', 'defend', 'balanced'].includes(decisions.strategy)
      ? decisions.strategy : 'balanced';
    Game.aiStrategy[me] = strategy;

    // Purchases
    if (Array.isArray(decisions.buy) && decisions.buy.length) {
      const specs = [];
      let budget = Game.economy[me];
      for (const item of decisions.buy) {
        const type = (item.type && PIECES[item.type]) ? item.type : 'infantry';
        if (type === 'hq' || !window.isUnlocked(me, type)) continue;
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

    // Movement: use existing runAiFor with model-selected strategy
    window.runAiFor(me, strategy);
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
    if (await available()) return;
    if (window.WasmCPM && window.WasmCPM.isCached()) {
      const toast = document.createElement('div');
      toast.style.cssText =
        'position:fixed;top:1rem;left:50%;transform:translateX(-50%);z-index:9999;' +
        'background:#2e7d32;color:#fff;padding:.8rem 1.4rem;border-radius:8px;' +
        'font-size:.85rem;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.5);text-align:center;';
      toast.textContent = '🧠 Loading in-browser AI model…';
      document.body.appendChild(toast);
      try {
        await window.WasmCPM.load();
        toast.textContent = '✅ In-browser AI ready';
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
    toast.textContent = '⚠ MiniCPM server not reachable — run ./start-minicpm.sh then reload';
    document.body.appendChild(toast);
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 3000));
      if (await available()) { toast.remove(); return; }
    }
  }

  return { available, ensureRunning, runCpmTurn, runCpmTakeover };
})();

window.MiniCPM = MiniCPM;
window.runCpmTurn = MiniCPM.runCpmTurn;
window.runCpmTakeover = MiniCPM.runCpmTakeover;
