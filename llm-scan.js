const LLMScanner = (function () {
  const SERVERS = [
    { name: 'MiniCPM',        port: 18766, health: '/health',    identify: 'health' },
    { name: 'LM Studio',      port: 1234,  health: '/v1/models', identify: 'models' },
    { name: 'Jan',             port: 1337,  health: '/v1/models', identify: 'models' },
    { name: 'Ollama',          port: 11434, health: '/',          identify: 'ollama' },
    { name: 'text-gen-webui',  port: 5000,  health: '/v1/models', identify: 'models' },
    { name: 'LocalAI',        port: 8080,  health: '/v1/models', identify: 'models' },
    { name: 'llama.cpp',      port: 8000,  health: '/health',    identify: 'health' },
    { name: 'llama.cpp',      port: 8081,  health: '/health',    identify: 'health' },
    { name: 'llama.cpp',      port: 8888,  health: '/health',    identify: 'health' },
  ];

  const TIMEOUT = 2000;

  async function probe(server) {
    const base = 'http://127.0.0.1:' + server.port;
    try {
      const r = await fetch(base + server.health, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!r.ok) return null;
      if (server.identify === 'ollama') {
        const txt = await r.text();
        if (!txt.includes('Ollama')) return null;
      }
      return { name: server.name, baseUrl: base };
    } catch { return null; }
  }

  async function fetchModels(baseUrl) {
    try {
      const r = await fetch(baseUrl + '/v1/models', { signal: AbortSignal.timeout(TIMEOUT) });
      if (r.ok) {
        const data = await r.json();
        if (data.data && Array.isArray(data.data)) {
          return data.data.map(function (m) { return { id: m.id || m.name || 'default' }; });
        }
      }
    } catch {}
    try {
      const r = await fetch(baseUrl + '/api/tags', { signal: AbortSignal.timeout(TIMEOUT) });
      if (r.ok) {
        const data = await r.json();
        if (data.models && Array.isArray(data.models)) {
          return data.models.map(function (m) { return { id: m.name || m.model || 'default' }; });
        }
      }
    } catch {}
    return [{ id: 'default' }];
  }

  async function scanAll() {
    var results = await Promise.allSettled(SERVERS.map(probe));
    var alive = [];
    var seen = {};
    for (var i = 0; i < results.length; i++) {
      var s = results[i].status === 'fulfilled' ? results[i].value : null;
      if (!s) continue;
      if (seen[s.baseUrl]) continue;
      seen[s.baseUrl] = true;
      s.models = await fetchModels(s.baseUrl);
      alive.push(s);
    }
    return alive;
  }

  return { scanAll: scanAll };
})();

window.LLMScanner = LLMScanner;
