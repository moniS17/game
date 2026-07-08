/*
 * state.js — shared save/load glue between the pages (menu, game, shop).
 *
 * The whole game state lives in localStorage so the shop page and the game
 * page can hand off to each other. The map itself is NOT stored tile-by-tile;
 * only the `seed` is, and the board is regenerated deterministically via
 * Algorithms.generateMap(seed). What does change during play (unit positions,
 * hp, economy, whose turn, city ownership, queued purchases) is stored.
 *
 * Exposes window.SaveState.
 */
window.SaveState = (function () {
  const SAVE_KEY = 'battlegrid.save';
  const INTENT_KEY = 'battlegrid.intent';
  const MAPS_KEY = 'battlegrid.maps';

  return {
    // Intent is a one-shot hand-off from the menu to the game page:
    //   { action: 'new' | 'continue', mode: 'pve' | 'pvp' }
    setIntent(obj) { localStorage.setItem(INTENT_KEY, JSON.stringify(obj)); },
    takeIntent() {
      const raw = localStorage.getItem(INTENT_KEY);
      localStorage.removeItem(INTENT_KEY);
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    },

    load() {
      const raw = localStorage.getItem(SAVE_KEY);
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    },
    save(state) { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); },
    exists() { return !!localStorage.getItem(SAVE_KEY); },
    clear() { localStorage.removeItem(SAVE_KEY); },

    loadMaps() {
      const raw = localStorage.getItem(MAPS_KEY);
      try { return raw ? JSON.parse(raw) : []; } catch { return []; }
    },
    saveMaps(maps) { localStorage.setItem(MAPS_KEY, JSON.stringify(maps)); },
  };
})();
