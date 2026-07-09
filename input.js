/*
 * input.js — mouse, touch, and keyboard input wiring for the hex board.
 *
 * Extracted from game.js for readability. Translates screen events into
 * game actions (tap, pan, zoom) using helpers exposed by game.js on window.
 *
 * Depends on: board.js, rules.js, render.js, game.js (core)
 */

function handleTapAt(r, c) {
  if (Game.winner !== null || !Board.inBounds(r, c)) return;

  if (window._rallyMode) {
    window._rallyMode = false;
    window.rallyAllUnits(r, c);
    UI.refresh(); Render.render();
    return;
  }

  if (window.inPlacement()) { window._placeAt(r, c); UI.refresh(); Render.render(); Render.autoZoom(); return; }

  const tileStack = window._stackAt(r, c);
  const committed = window.committedUnitIds();
  const movers = Game.selUnits.filter(u => u.owner === Game.turn && !committed.has(u.id));

  if (Game.selTile && movers.length) {
    const group = movers.filter(u => u.movesLeft > 0);
    const selR = Game.selTile.r, selC = Game.selTile.c;

    if (tileStack.length && tileStack[0].owner !== Game.turn && group.length) {
      if (Rules.isHexNeighbor(selR, selC, r, c)) {
        const path = [{ r: selR, c: selC }];
        window._addOrder(group, { r: selR, c: selC }, { r: selR, c: selC }, path, true, { r, c });
        UI.refresh(); Render.render();
        return;
      }
      const adj = window._bestAdjacentForAttack(r, c, Game.reachable, Game.unitAt, Game.turn, group.length);
      if (adj) {
        const startBudget = Math.min(...group.map(u => u.movesLeft));
        const path = window._getPath(selR, selC, adj.r, adj.c, startBudget);
        window._addOrder(group, { r: selR, c: selC }, adj, path, true, { r, c });
        UI.refresh(); Render.render();
        return;
      }
    }

    if (Game.reachable.has(Board.key(r, c)) && (!tileStack.length || tileStack[0].owner === Game.turn) && group.length) {
      const startBudget = Math.min(...group.map(u => u.movesLeft));
      const path = window._getPath(selR, selC, r, c, startBudget);
      window._addOrder(group, { r: selR, c: selC }, { r, c }, path, false, null);
      UI.refresh(); Render.render();
      return;
    }
  }

  window.selectTile(r, c);
  UI.refresh(); Render.render();
}

function zoomAt(clientX, clientY, factor) {
  const cam = Render.cam;
  const rect = Render.canvas.getBoundingClientRect();
  const mx = clientX - rect.left, my = clientY - rect.top;
  const wpx = cam.x + mx, wpy = cam.y + my;
  const S3 = Math.sqrt(3);
  const bw = S3 * cam.cell * (Board.COLS + 0.5);
  const bh = 1.5 * cam.cell * (Board.ROWS - 1) + 2 * cam.cell;
  const fx = wpx / bw, fy = wpy / bh;
  const old = cam.cell;
  cam.cell = Math.round(Math.max(Render.MIN_CELL, Math.min(Render.MAX_CELL, cam.cell * factor)));
  if (cam.cell !== old) {
    const nbw = S3 * cam.cell * (Board.COLS + 0.5);
    const nbh = 1.5 * cam.cell * (Board.ROWS - 1) + 2 * cam.cell;
    cam.x = fx * nbw - mx;
    cam.y = fy * nbh - my;
    Render.clamp(); Render.render();
  }
}

function wireInput() {
  const cv = Render.canvas;
  const cam = Render.cam;

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
