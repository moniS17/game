/*
 * render.js — everything that draws the board onto the <canvas>.
 *
 * Pure presentation: reads window.Game and the data modules, owns the camera
 * (pan/zoom), and exposes helpers that game.js's input code uses to translate
 * screen coordinates to tiles. No game rules or state mutation here.
 *
 * Hexagonal grid: pointy-top hexagons with odd-r offset (odd rows shift right).
 *
 * Exposes window.Render: { canvas, cam, render, resize, clamp, cellFromPoint,
 *                          MIN_CELL, MAX_CELL }.
 */
window.Render = (function () {
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');

  const cam = { x: 0, y: 0, cell: 14 }; // cell = hex size (center to vertex)
  const MIN_CELL = 5, MAX_CELL = 48;
  const PAD_TILES = 3;

  const S3 = Math.sqrt(3);

  // Hex geometry helpers
  function hexW(size) { return S3 * size; }
  function rowH(size) { return 1.5 * size; }
  function hexCenter(r, c, size) {
    const w = hexW(size);
    return {
      x: w * (c + 0.5) + (r & 1) * w * 0.5,
      y: size + r * rowH(size)
    };
  }
  function boardWidth(size) { return hexW(size) * (Board.COLS + 0.5); }
  function boardHeight(size) { return rowH(size) * (Board.ROWS - 1) + 2 * size; }

  // Draw a pointy-top hexagon path centered at (cx, cy) with given size
  function hexPath(cx, cy, size) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 3 * i - Math.PI / 6;
      const vx = cx + size * Math.cos(angle);
      const vy = cy + size * Math.sin(angle);
      if (i === 0) ctx.moveTo(vx, vy);
      else ctx.lineTo(vx, vy);
    }
    ctx.closePath();
  }

  // Preload SVG art so it can be drawn when zoomed in.
  const images = {};
  function preload() {
    const sources = { city: 'assets/city.svg', village: 'assets/village.svg', forest: 'assets/forest.svg', water: 'assets/water.svg' };
    for (const k in PIECES) if (PIECES[k].art) sources[k] = PIECES[k].art;
    if (typeof STRUCTURES !== 'undefined') for (const k in STRUCTURES) if (STRUCTURES[k].art) sources[k] = STRUCTURES[k].art;
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
    const pad = PAD_TILES * cam.cell * 1.5;
    cam.x = clampAxis(cam.x, boardWidth(cam.cell), canvas.width, pad);
    cam.y = clampAxis(cam.y, boardHeight(cam.cell), canvas.height, pad);
  }

  function clampAxis(v, boardPx, viewPx, pad) {
    const lo = -pad, hi = boardPx - viewPx + pad;
    if (hi < lo) return (boardPx - viewPx) / 2;
    return Math.min(Math.max(v, lo), hi);
  }

  function autoZoom() {
    if (!canvas.width || !canvas.height || !Board.COLS || !Board.ROWS) return false;
    const fitW = canvas.width / (S3 * (Board.COLS + 0.5));
    const fitH = canvas.height / (1.5 * (Board.ROWS - 1) + 2);
    const target = Math.min(Math.floor(Math.min(fitW, fitH)), MAX_CELL);
    if (target > cam.cell) {
      cam.cell = target;
      clamp();
      render();
      return true;
    }
    return false;
  }

  function centerOn(r, c) {
    if (!canvas.width || !canvas.height) return;
    const center = hexCenter(r, c, cam.cell);
    cam.x = center.x - canvas.width / 2;
    cam.y = center.y - canvas.height / 2;
    clamp();
    render();
  }

  // Pixel-to-hex: find which hex a world-pixel falls in (odd-r offset, pointy-top)
  function cellFromPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left + cam.x;
    const py = clientY - rect.top + cam.y;
    const size = cam.cell;
    const w = hexW(size);
    const rh = rowH(size);
    // Estimate row from y
    const rowEst = (py - size) / rh;
    const row = Math.round(rowEst);
    // Estimate col from x, accounting for odd-row offset
    const colEst = (px - (row & 1) * w * 0.5) / w - 0.5;
    const col = Math.round(colEst);
    // Check this hex and its neighbors to find the closest center
    let bestR = row, bestC = col, bestD = Infinity;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const tr = row + dr, tc = col + dc;
        const center = hexCenter(tr, tc, size);
        const dx = px - center.x, dy = py - center.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestR = tr; bestC = tc; }
      }
    }
    return { r: bestR, c: bestC };
  }

  function render() {
    const G = window.Game;
    if (!G || !G.terrain.length) return;
    ctx.fillStyle = '#6a6f76';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const size = cam.cell;
    const COLS = Board.COLS, ROWS = Board.ROWS;
    const w = hexW(size);
    const rh = rowH(size);
    const detailed = size >= 22;
    const ZONE = Board.zone();
    const placing = window.inPlacement && window.inPlacement();

    const territory = G.territory;
    const innerSize = size * 0.83;

    // Viewport culling: determine visible row/col range
    const r0 = Math.max(0, Math.floor((cam.y - size) / rh));
    const r1 = Math.min(ROWS, Math.ceil((cam.y + canvas.height + size) / rh) + 1);
    const c0 = Math.max(0, Math.floor((cam.x - w) / w));
    const c1 = Math.min(COLS, Math.ceil((cam.x + canvas.width + w) / w) + 1);

    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const center = hexCenter(r, c, size);
        const sx = center.x - cam.x, sy = center.y - cam.y;
        // Skip if clearly off screen
        if (sx < -size * 1.2 || sx > canvas.width + size * 1.2 ||
            sy < -size * 1.2 || sy > canvas.height + size * 1.2) continue;

        const tkey = G.terrain[r][c];
        const terr = TERRAIN[tkey];
        const owner = territory && territory[r] ? territory[r][c] : null;

        // Territory fill (outer hex)
        if (owner === 0 || owner === 1) {
          ctx.globalAlpha = 0.7;
          ctx.fillStyle = PLAYERS[owner].color;
        } else {
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#8a9099';
        }
        hexPath(sx, sy, size);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Terrain content (inner hex)
        ctx.fillStyle = terr.color;
        hexPath(sx, sy, innerSize);
        ctx.fill();

        if (detailed && images[tkey] && images[tkey].complete) {
          const imgSize = innerSize * 1.2;
          ctx.drawImage(images[tkey], sx - imgSize / 2, sy - imgSize / 2, imgSize, imgSize);
        }
      }
    }

    // Front-line borders between opposing territories
    if (territory) {
      ctx.save();
      ctx.lineWidth = Math.max(2, size * 0.12);
      ctx.strokeStyle = '#3a3f45';
      ctx.globalAlpha = 0.85;
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          const own = territory[r] ? territory[r][c] : null;
          if (own !== 0 && own !== 1) continue;
          const opp = own === 0 ? 1 : 0;
          const dirs = (r & 1) ? Rules.DIRS_ODD : Rules.DIRS_EVEN;
          const center = hexCenter(r, c, size);
          const sx = center.x - cam.x, sy = center.y - cam.y;
          for (let i = 0; i < 6; i++) {
            const [dr, dc] = dirs[i];
            const nr = r + dr, nc = c + dc;
            if (!Board.inBounds(nr, nc)) continue;
            if (territory[nr] && territory[nr][nc] === opp) {
              // Draw the shared edge
              const a1 = Math.PI / 3 * i - Math.PI / 6;
              const a2 = Math.PI / 3 * ((i + 1) % 6) - Math.PI / 6;
              ctx.beginPath();
              ctx.moveTo(sx + size * Math.cos(a1), sy + size * Math.sin(a1));
              ctx.lineTo(sx + size * Math.cos(a2), sy + size * Math.sin(a2));
              ctx.stroke();
            }
          }
        }
      }
      ctx.restore();
    }

    // During placement, brighten the current player's zone
    if (placing) {
      const me = G.turn;
      const zc0 = me === 0 ? 0 : COLS - ZONE;
      const zc1 = me === 0 ? ZONE : COLS;
      for (let r = r0; r < r1; r++) {
        for (let c = Math.max(c0, zc0); c < Math.min(c1, zc1); c++) {
          if (G.terrain[r][c] === 'water') continue;
          const center = hexCenter(r, c, size);
          const sx = center.x - cam.x, sy = center.y - cam.y;
          ctx.fillStyle = 'rgba(255,255,0,0.18)';
          hexPath(sx, sy, innerSize);
          ctx.fill();
        }
      }
    }

    // City/village ownership rings
    const sites = G.villages ? G.cities.concat(G.villages) : G.cities;
    for (const ci of sites) {
      if (ci.r < r0 || ci.r >= r1 || ci.c < c0 || ci.c >= c1) continue;
      const center = hexCenter(ci.r, ci.c, size);
      const sx = center.x - cam.x, sy = center.y - cam.y;
      ctx.strokeStyle = ci.owner == null ? '#9aa4ad' : PLAYERS[ci.owner].color;
      ctx.lineWidth = Math.max(1.5, innerSize * 0.12);
      hexPath(sx, sy, innerSize * 0.88);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Built structures — icon in top-right area
    if (G.structures && size >= 10) {
      for (const s of G.structures) {
        if (s.r < r0 || s.r >= r1 || s.c < c0 || s.c >= c1) continue;
        const img = images[s.type];
        if (!img || !img.complete) continue;
        const center = hexCenter(s.r, s.c, size);
        const sx = center.x - cam.x, sy = center.y - cam.y;
        const iconSize = Math.max(6, innerSize * 0.38);
        const ix = sx + innerSize * 0.25, iy = sy - innerSize * 0.55;
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = PLAYERS[s.owner].color;
        ctx.fillRect(ix - 1, iy - 1, iconSize + 2, iconSize + 2);
        ctx.globalAlpha = 1;
        ctx.drawImage(img, ix, iy, iconSize, iconSize);
      }
    }

    // Reachable highlight
    if (G.previewPath) {
      for (const k of G.reachable.keys()) {
        const [r, c] = k.split(',').map(Number);
        if (r < r0 || r >= r1 || c < c0 || c >= c1) continue;
        const center = hexCenter(r, c, size);
        const sx = center.x - cam.x, sy = center.y - cam.y;
        ctx.fillStyle = 'rgba(255,255,0,0.12)';
        hexPath(sx, sy, innerSize);
        ctx.fill();
      }
    } else {
      for (const k of G.reachable.keys()) {
        const [r, c] = k.split(',').map(Number);
        if (r < r0 || r >= r1 || c < c0 || c >= c1) continue;
        const center = hexCenter(r, c, size);
        const sx = center.x - cam.x, sy = center.y - cam.y;
        ctx.fillStyle = 'rgba(255,255,0,0.35)';
        hexPath(sx, sy, innerSize);
        ctx.fill();
      }
    }

    // Path preview
    if (G.previewPath && G.previewPath.length > 1) {
      const path = G.previewPath;
      for (const p of path) {
        if (p.r < r0 || p.r >= r1 || p.c < c0 || p.c >= c1) continue;
        const center = hexCenter(p.r, p.c, size);
        const sx = center.x - cam.x, sy = center.y - cam.y;
        ctx.fillStyle = 'rgba(76,175,80,0.45)';
        hexPath(sx, sy, innerSize);
        ctx.fill();
      }
      // Draw arrows between consecutive tiles
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = Math.max(2, size * 0.08);
      ctx.lineCap = 'round';
      const arrowLen = innerSize * 0.22;
      for (let i = 0; i < path.length - 1; i++) {
        const from = path[i], to = path[i + 1];
        const fc = hexCenter(from.r, from.c, size);
        const tc = hexCenter(to.r, to.c, size);
        const fx = fc.x - cam.x, fy = fc.y - cam.y;
        const tx = tc.x - cam.x, ty = tc.y - cam.y;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        // Arrowhead
        const dx = tx - fx, dy = ty - fy;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / len, uy = dy / len;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - ux * arrowLen - uy * arrowLen * 0.5, ty - uy * arrowLen + ux * arrowLen * 0.5);
        ctx.lineTo(tx - ux * arrowLen + uy * arrowLen * 0.5, ty - uy * arrowLen - ux * arrowLen * 0.5);
        ctx.closePath();
        ctx.fill();
      }
      // Destination outline
      const dest = path[path.length - 1];
      if (dest.r >= r0 && dest.r < r1 && dest.c >= c0 && dest.c < c1) {
        const dc = hexCenter(dest.r, dest.c, size);
        const dx = dc.x - cam.x, dy = dc.y - cam.y;
        ctx.strokeStyle = '#4caf50';
        ctx.lineWidth = Math.max(2, size * 0.1);
        hexPath(dx, dy, innerSize * 0.9);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Unit stacks
    for (const [k, stack] of G.unitAt) {
      if (!stack.length) continue;
      const [r, c] = k.split(',').map(Number);
      if (r < r0 || r >= r1 || c < c0 || c >= c1) continue;
      drawStack(G, stack, r, c, size, detailed, innerSize);
    }

    // Selection outline
    if (G.selTile) {
      const u = G.selTile;
      const center = hexCenter(u.r, u.c, size);
      const sx = center.x - cam.x, sy = center.y - cam.y;
      ctx.strokeStyle = '#ffeb3b'; ctx.lineWidth = 2;
      hexPath(sx, sy, innerSize * 0.9);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  const SUBS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
  function toSub(n) { return String(n).split('').map((d) => SUBS[+d]).join(''); }

  function drawStack(G, stack, r, c, size, detailed, innerSize) {
    const u = stack[stack.length - 1];
    const center = hexCenter(r, c, size);
    const sx = center.x - cam.x, sy = center.y - cam.y;
    const def = PIECES[u.type];
    const color = PLAYERS[u.owner].color;

    if (detailed && images[u.type] && images[u.type].complete) {
      ctx.globalAlpha = 0.6; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(sx, sy, innerSize * 0.35, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.7;
      const imgS = innerSize * 0.55;
      ctx.drawImage(images[u.type], sx - imgS / 2, sy - imgS / 2, imgS, imgS);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = 0.65; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(sx, sy, innerSize * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      if (innerSize >= 9) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.floor(innerSize * 0.495)}px monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const label = stack.length > 1 ? def.code + toSub(stack.length) : def.code;
        ctx.fillText(label, sx, sy + 0.5);
      }
    }

    // Count badge
    if (stack.length > 1 && innerSize >= 12) {
      const bs = Math.max(8, innerSize * 0.42);
      const bx = sx + innerSize * 0.3, by = sy + innerSize * 0.3;
      ctx.fillStyle = 'rgba(0,0,0,0.78)';
      ctx.fillRect(bx, by, bs, bs);
      ctx.fillStyle = '#ffeb3b';
      ctx.font = `bold ${Math.floor(bs * 0.72)}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(stack.length), bx + bs / 2, by + bs / 2 + 0.5);
    }

    // HP bar
    if (innerSize >= 14 && u.hp < u.maxHp) {
      const bw = innerSize * 0.8, bx = sx - bw / 2, by = sy - innerSize * 0.5;
      ctx.fillStyle = '#000'; ctx.fillRect(bx, by, bw, 3);
      ctx.fillStyle = '#4caf50'; ctx.fillRect(bx, by, bw * (u.hp / u.maxHp), 3);
    }
  }

  preload();
  return { canvas, cam, render, resize, clamp, autoZoom, centerOn, cellFromPoint, MIN_CELL, MAX_CELL };
})();
