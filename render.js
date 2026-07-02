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
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');

  const cam = { x: 0, y: 0, cell: 12 }; // x,y = world px at canvas top-left (base tile ~30% larger)
  const MIN_CELL = 5, MAX_CELL = 48;
  const PAD_TILES = 3; // gray scroll padding around the board (~3 tiles each side)

  // Preload SVG art so it can be drawn when zoomed in.
  const images = {};
  function preload() {
    const sources = { plains: 'assets/grass.svg', city: 'assets/city.svg', village: 'assets/village.svg', forest: 'assets/forest.svg', water: 'assets/water.svg' };
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
    const pad = PAD_TILES * cam.cell;
    cam.x = clampAxis(cam.x, Board.COLS * cam.cell, canvas.width, pad);
    cam.y = clampAxis(cam.y, Board.ROWS * cam.cell, canvas.height, pad);
  }

  // Keep at most `pad` of gray on each side. If the board is smaller than the
  // viewport (zoomed out / wide screen), center it so both sides match.
  function clampAxis(v, boardPx, viewPx, pad) {
    const lo = -pad, hi = boardPx - viewPx + pad;
    if (hi < lo) return (boardPx - viewPx) / 2;
    return Math.min(Math.max(v, lo), hi);
  }

  // Small-board convenience: if the whole board fits with room to spare, zoom in
  // to fill the viewport (tiles capped at MAX_CELL) and center. Only ever zooms
  // IN — a no-op for big boards (no room without cropping) or when already
  // filling. Returns true if the zoom level changed.
  function autoZoom() {
    if (!canvas.width || !canvas.height || !Board.COLS || !Board.ROWS) return false;
    const fit = Math.floor(Math.min(canvas.width / Board.COLS, canvas.height / Board.ROWS));
    const target = Math.min(fit, MAX_CELL);
    if (target > cam.cell) {
      cam.cell = target;
      clamp();
      render();
      return true;
    }
    return false;
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
    // Gray backdrop shows through the scroll padding around the board edges.
    ctx.fillStyle = '#6a6f76';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const cell = cam.cell;
    const COLS = Board.COLS, ROWS = Board.ROWS;
    const c0 = Math.max(0, Math.floor(cam.x / cell));
    const r0 = Math.max(0, Math.floor(cam.y / cell));
    const c1 = Math.min(COLS, Math.ceil((cam.x + canvas.width) / cell));
    const r1 = Math.min(ROWS, Math.ceil((cam.y + canvas.height) / cell));
    const detailed = cell >= 22;
    const ZONE = Board.zone();
    const placing = window.inPlacement && window.inPlacement();

    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const x = c * cell - cam.x, y = r * cell - cam.y;
        const tkey = G.terrain[r][c];
        const terr = TERRAIN[tkey];

        // Faint deployment-zone tint (ZONE columns each side).
        if (c < ZONE) { ctx.globalAlpha = 0.10; ctx.fillStyle = PLAYERS[0].color; ctx.fillRect(x, y, cell, cell); ctx.globalAlpha = 1; }
        else if (c >= COLS - ZONE) { ctx.globalAlpha = 0.10; ctx.fillStyle = PLAYERS[1].color; ctx.fillRect(x, y, cell, cell); ctx.globalAlpha = 1; }

        ctx.fillStyle = terr.color;
        ctx.fillRect(x, y, cell, cell);

        if (detailed && images[tkey] && images[tkey].complete) {
          ctx.drawImage(images[tkey], x, y, cell, cell);
        }
        if (cell >= 14) { ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.strokeRect(x, y, cell, cell); }
      }
    }

    // During placement, brighten the current player's zone and its dry tiles.
    if (placing) {
      const me = G.turn;
      const zc0 = me === 0 ? 0 : COLS - ZONE;
      const zc1 = me === 0 ? ZONE : COLS;
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
      ctx.beginPath(); ctx.arc(x + cell / 2, y + cell / 2, cell * 0.414, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.drawImage(images[u.type], x + cell * 0.158, y + cell * 0.158, cell * 0.684, cell * 0.684);
    } else {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x + cell / 2, y + cell / 2, cell * 0.36, 0, Math.PI * 2); ctx.fill();
      if (cell >= 9) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.floor(cell * 0.495)}px monospace`;
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
  return { canvas, cam, render, resize, clamp, autoZoom, cellFromPoint, MIN_CELL, MAX_CELL };
})();
