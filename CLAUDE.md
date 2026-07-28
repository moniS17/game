# Battlegrid

A 100x100 hex-grid turn-based strategy game. PWA, offline-capable, with Android WebView wrapper.

## Tech Stack

- **Pure vanilla JavaScript** — no frameworks, no npm, no bundler, no TypeScript
- **HTML5 Canvas** for hex board rendering
- **CSS** inline per page (except `chat.css`)
- **Service Worker** (`sw.js`) for cache-first offline support
- **localStorage** for game state persistence
- **llama-server** (llama.cpp) for local LLM AI via OpenAI-compatible API

## Running

1. Serve the directory over HTTP (e.g. `python3 -m http.server 8080`)
2. Open `login.html` in browser
3. Credentials: `1:1` or `q:1`
4. For AI games: `./start-minicpm.sh` to launch llama-server on port 18766

## File Structure

| File | Purpose |
|------|---------|
| `login.html` | Entry point, auth against users.txt |
| `menu.html` | Main menu (new game / continue) |
| `mode.html` | Game setup (board size, AI engine, difficulty) |
| `index.html` | Main game page (canvas + sidebar) |
| `buy.html` | Unit shop |
| `tech.html` | Tech research tree |
| `template.html` | Unit template editor |
| `editor.html` | Map editor (creative mode) |
| `info.html` | Field manual / docs |
| `diplomacy.html` | Diplomacy management |
| `units.js` | Unit roster, stats, player colors |
| `board.js` | Terrain definitions, Board API |
| `algorithms.js` | Procedural map generation (seeded PRNG) |
| `terrain-weights.js` | Configurable terrain density |
| `rules.js` | Movement, combat, economy rules |
| `render.js` | Canvas hex grid renderer |
| `game.js` | Game state orchestrator |
| `state.js` | localStorage save/load |
| `input.js` | Mouse/touch/keyboard input |
| `ai.js` | Algorithmic AI (movement, combat, purchasing) |
| `minicpm.js` | MiniCPM LLM strategic decision engine |
| `chat.js` | AI Advisor conversational chat panel |
| `chat.css` | Chat panel styles |
| `wasm-cpm.js` | In-browser WASM inference fallback |
| `llm-scan.js` | Local LLM server scanner |
| `auth.js` | Client-side credential check |
| `ai-background.txt` | System prompt for MiniCPM AI |
| `sw.js` | Service worker (cache-first) |
| `manifest.json` | PWA manifest |

## Patterns

- **i18n**: Each page has an `i18n` or `GAME_I18N` object with `en`/`zh` keys. Language stored in `localStorage.getItem('battlegrid.lang')`. Helper: `_t(key)`.
- **Modules**: IIFE pattern exposing on `window` (e.g. `window.MiniCPM`, `window.AdvisorChat`).
- **Service Worker**: All assets listed in `sw.js` ASSETS array. Bump `CACHE_NAME` version on changes.
- **No build step**: Edit files directly, refresh browser.

## MiniCPM Integration

Two modes of AI integration:

1. **Strategic Decision Engine** (`minicpm.js`): Receives game state, returns JSON `{strategy, research, buy, targets}`. Used for AI-controlled players and "AI takeover" feature.

2. **Conversational Advisor** (`chat.js`): Slide-out chat panel where the player asks strategy questions. Streams responses via SSE with `<think>` block support. Injects game state as context automatically.

Both connect to the same llama-server endpoint (`http://127.0.0.1:18766/v1/chat/completions`). Can also use OpenAI API with a key.

## Android Build

- `android/` directory contains Gradle project with WebView wrapper
- `build-android-apk.sh` / `deploy-android.sh` for building
- Uses WebViewAssetLoader to serve local files
