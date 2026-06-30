/*
 * render.js — everything that draws the board onto the <canvas>.
 *
 * Pure presentation: reads window.Game and the data modules, owns the camera
 * (pan/zoom), and exposes helpers that game.js's input code uses to translate
 * screen coordinates to tiles. No game rules or state mutation here.
 *
 * Exposes window.Render: { canvas, cam, render, resize, clamp, cellFromPoint,
 *                          MIN_CELL, MAX_CELL }.
 */
window.Render = (function () {
  const GRID = Board.GRID;
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');

  const cam = { x: 0, y: 0, cell: 9 }; // x,y = world px at canvas top-left
  const MIN_CELL = 5, MAX_CELL = 48;

  // Preload SVG art so it can be drawn when zoomed in.
  const images = {};
  function preload() {
    const sources = { plains: 'assets/grass.svg', city: 'assets/city.svg', forest: 'assets/forest.svg', water: 'assets/water.svg' };
    for (const k in PIECES) if (PIECES[k].art) sources[k] = PIECES[k].art;
    for (const k in sources) {
      const img = new Image();
      img.onload = render;
      img.src = sources[k];
      images[k] = img;
    }
  }

  function resize() {
    const wrap = canvas.parentElement;
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    clamp();
    render();
  }

  function clamp() {
    const maxX = Math.max(0, GRID * cam.cell - canvas.width);
    const maxY = Math.max(0, GRID * cam.cell - canvas.height);
    cam.x = Math.min(Math.max(0, cam.x), maxX);
    cam.y = Math.min(Math.max(0, cam.y), maxY);
  }

  function cellFromPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      r: Math.floor((clientY - rect.top + cam.y) / cam.cell),
      c: Math.floor((clientX - rect.left + cam.x) / cam.cell),
    };
  }

  function render() {
    const G = window.Game;
    if (!G || !G.terrain.length) return; // not booted yet
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cell = cam.cell;
    const c0 = Math.max(0, Math.floor(cam.x / cell));
    const r0 = Math.max(0, Math.floor(cam.y / cell));
    const c1 = Math.min(GRID, Math.ceil((cam.x + canvas.width) / cell));
    const r1 = Math.min(GRID, Math.ceil((cam.y + canvas.height) / cell));
    const detailed = cell >= 22;
    const ZONE = 17;
    const placing = window.inPlacement && window.inPlacement();

    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const x = c * cell - cam.x, y = r * cell - cam.y;
        const tkey = G.terrain[r][c];
        const terr = TERRAIN[tkey];

        // Faint deployment-zone tint (17 columns each side).
        if (c < ZONE) { ctx.globalAlpha = 0.10; ctx.fillStyle = PLAYERS[0].color; ctx.fillRect(x, y, cell, cell); ctx.globalAlpha = 1; }
        else if (c >= GRID - ZONE) { ctx.globalAlpha = 0.10; ctx.fillStyle = PLAYERS[1].color; ctx.fillRect(x, y, cell, cell); ctx.globalAlpha = 1; }

        ctx.fillStyle = terr.color;
        ctx.fillRect(x, y, cell, cell);

        if (detailed && images[tkey] && images[tkey].complete) {
          ctx.drawImage(images[tkey], x, y, cell, cell);
        } else if (cell >= 11 && terr.code !== '.') {
          ctx.fillStyle = 'rgba(0,0,0,0.5)';
          ctx.font = `${Math.floor(cell * 0.55)}px monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(terr.code, x + cell / 2, y + cell / 2);
        }
        if (cell >= 14) { ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.strokeRect(x, y, cell, cell); }
      }
    }

    // During placement, brighten the current player's zone and its dry tiles.
    if (placing) {
      const me = G.turn;
      const zc0 = me === 0 ? 0 : GRID - ZONE;
      const zc1 = me === 0 ? ZONE : GRID;
      for (let r = r0; r < r1; r++) {
        for (let c = Math.max(c0, zc0); c < Math.min(c1, zc1); c++) {
          if (G.terrain[r][c] === 'water') continue;
          ctx.fillStyle = 'rgba(255,255,0,0.18)';
          ctx.fillRect(c * cell - cam.x, r * cell - cam.y, cell, cell);
        }
      }
    }

    // city ownership rings
    for (const ci of G.cities) {
      if (ci.r < r0 || ci.r >= r1 || ci.c < c0 || ci.c >= c1) continue;
      const x = ci.c * cell - cam.x, y = ci.r * cell - cam.y;
      ctx.strokeStyle = PLAYERS[ci.owner].color;
      ctx.lineWidth = Math.max(1.5, cell * 0.12);
      ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
      ctx.lineWidth = 1;
    }

    // reachable highlight for the selected group
    for (const k of G.reachable.keys()) {
      const [r, c] = k.split(',').map(Number);
      if (r < r0 || r >= r1 || c < c0 || c >= c1) continue;
      ctx.fillStyle = 'rgba(255,255,0,0.35)';
      ctx.fillRect(c * cell - cam.x, r * cell - cam.y, cell, cell);
    }

    // one drawing per occupied tile (the stack), top unit + count badge
    for (const [k, stack] of G.unitAt) {
      if (!stack.length) continue;
      const [r, c] = k.split(',').map(Number);
      if (r < r0 || r >= r1 || c < c0 || c >= c1) continue;
      drawStack(G, stack, r, c, cell, detailed);
    }

    // outline the inspected tile and the chosen units' tile
    if (G.selTile) {
      const u = G.selTile;
      ctx.strokeStyle = '#ffeb3b'; ctx.lineWidth = 2;
      ctx.strokeRect(u.c * cell - cam.x + 1, u.r * cell - cam.y + 1, cell - 2, cell - 2);
      ctx.lineWidth = 1;
    }
  }

  // Subscript form of a non-negative integer, e.g. 12 -> "₁₂".
  const SUBS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
  function toSub(n) { return String(n).split('').map((d) => SUBS[+d]).join(''); }

  // Draw a tile's stack: the top unit's icon/code, plus a count badge when >1.
  function drawStack(G, stack, r, c, cell, detailed) {
    const u = stack[stack.length - 1]; // "top" of the stack is what shows
    const x = c * cell - cam.x, y = r * cell - cam.y;
    const def = PIECES[u.type];
    const color = PLAYERS[u.owner].color;

    if (detailed && images[u.type] && images[u.type].complete) {
      ctx.globalAlpha = 0.85; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x + cell / 2, y + cell / 2, cell * 0.46, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.drawImage(images[u.type], x + cell * 0.12, y + cell * 0.12, cell * 0.76, cell * 0.76);
    } else {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x + cell / 2, y + cell / 2, cell * 0.4, 0, Math.PI * 2); ctx.fill();
      if (cell >= 9) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.floor(cell * 0.55)}px monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        // letter + subscript count, e.g. "p₃"
        const label = stack.length > 1 ? def.code + toSub(stack.length) : def.code;
        ctx.fillText(label, x + cell / 2, y + cell / 2 + 0.5);
      }
    }

    // count badge (always legible, including on detailed icons)
    if (stack.length > 1 && cell >= 12) {
      const bs = Math.max(8, cell * 0.42);
      const bx = x + cell - bs, by = y + cell - bs;
      ctx.fillStyle = 'rgba(0,0,0,0.78)';
      ctx.fillRect(bx, by, bs, bs);
      ctx.fillStyle = '#ffeb3b';
      ctx.font = `bold ${Math.floor(bs * 0.72)}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(stack.length), bx + bs / 2, by + bs / 2 + 0.5);
    }

    // HP bar reflects the top unit
    if (cell >= 14 && u.hp < u.maxHp) {
      const bw = cell * 0.8, bx = x + cell * 0.1, by = y + cell * 0.06;
      ctx.fillStyle = '#000'; ctx.fillRect(bx, by, bw, 3);
      ctx.fillStyle = '#4caf50'; ctx.fillRect(bx, by, bw * (u.hp / u.maxHp), 3);
    }
  }

  preload();
  return { canvas, cam, render, resize, clamp, cellFromPoint, MIN_CELL, MAX_CELL };
})();
