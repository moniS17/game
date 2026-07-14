/*
 * wasm-cpm.js — In-browser WASM inference for MiniCPM via wllama.
 *
 * Loads the wllama library from CDN, downloads the GGUF model from GitHub
 * Releases, caches it in the browser, and runs inference entirely client-side.
 * Used as a fallback when no local llama-server is running.
 */

const WasmCPM = (function () {
  const MODEL_URL =
    'https://github.com/moniS17/game/releases/download/model-v1/' +
    'MiniCPM5-1B-Claude-Opus-Fable5-Thinking-Q4_K_M.gguf';
  const WLLAMA_CDN = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@2/esm';
  const CACHE_KEY = 'cpm_wasm_downloaded';

  let wllama = null;
  let modelReady = false;
  let busy = false;

  async function loadEngine() {
    if (wllama) return;
    const [mod, cdn] = await Promise.all([
      import(WLLAMA_CDN + '/index.js'),
      import(WLLAMA_CDN + '/wasm-from-cdn.js'),
    ]);
    wllama = new mod.Wllama(cdn.default);
  }

  function isReady() { return modelReady && !busy; }

  function isCached() { return localStorage.getItem(CACHE_KEY) === '1'; }

  async function download(onProgress) {
    if (busy) return false;
    busy = true;
    try {
      await loadEngine();
      await wllama.loadModelFromUrl(MODEL_URL, {
        progressCallback: function (p) {
          if (onProgress) onProgress(p);
        },
      });
      modelReady = true;
      localStorage.setItem(CACHE_KEY, '1');
      return true;
    } finally {
      busy = false;
    }
  }

  async function load() {
    if (modelReady) return true;
    return download();
  }

  async function complete(systemPrompt, userPrompt) {
    if (!modelReady) throw new Error('WASM model not loaded');
    busy = true;
    try {
      if (typeof wllama.createChatCompletion === 'function') {
        const result = await wllama.createChatCompletion(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          { nPredict: 384, sampling: { temp: 0.3, top_k: 40, top_p: 0.9 } }
        );
        return typeof result === 'string' ? result : result.content || String(result);
      }
      var prompt =
        '<|im_start|>system\n' + systemPrompt + '<|im_end|>\n' +
        '<|im_start|>user\n' + userPrompt + '<|im_end|>\n' +
        '<|im_start|>assistant\n';
      var text = await wllama.createCompletion(prompt, {
        nPredict: 384,
        sampling: { temp: 0.3, top_k: 40, top_p: 0.9 },
      });
      var stop = text.indexOf('<|im_end|>');
      if (stop >= 0) text = text.slice(0, stop);
      return text.trim();
    } finally {
      busy = false;
    }
  }

  return { isReady, isCached, download, load, complete };
})();

window.WasmCPM = WasmCPM;
