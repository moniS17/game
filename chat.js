/*
 * chat.js — AI Advisor Chat Panel for Battlegrid.
 *
 * Provides a slide-out conversational interface with MiniCPM.
 * Streams responses via SSE, renders <think> blocks as collapsible
 * sections, and injects game state context automatically.
 */

const AdvisorChat = (function () {
  const CHAT_I18N = {
    en: {
      title: 'AI Advisor',
      placeholder: 'Ask about strategy...',
      send: 'Send',
      thinking: 'Thinking...',
      thinkProcess: 'Thinking process',
      stop: 'Stop',
      clear: 'Clear',
      offline: 'AI server offline. Run ./start-minicpm.sh or enable WASM.',
      error: 'Error communicating with AI.',
    },
    zh: {
      title: 'AI 顾问',
      placeholder: '询问战略建议...',
      send: '发送',
      thinking: '思考中...',
      thinkProcess: '思考过程',
      stop: '停止',
      clear: '清空',
      offline: 'AI服务器离线。请运行 ./start-minicpm.sh 或启用WASM。',
      error: 'AI通信错误。',
    }
  };

  function t(key) {
    const lang = localStorage.getItem('battlegrid.lang') || 'en';
    return (CHAT_I18N[lang] && CHAT_I18N[lang][key]) || CHAT_I18N.en[key] || key;
  }

  let messages = [];
  let abortCtrl = null;
  let isGenerating = false;

  const ADVISOR_SYSTEM = 'You are the player\'s strategic advisor in Battlegrid, a hex-grid turn-based strategy game. ' +
    'Answer questions about the game state, explain the situation, suggest tactics, and give concise strategic advice. ' +
    'Keep responses brief (2-5 sentences) unless the player asks for detail. Use markdown formatting where helpful.';

  // ── Lightweight Markdown renderer ─────────────────────────────────────
  function renderMarkdown(text) {
    let html = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/```([\s\S]*?)```/g, (_, code) => '<pre><code>' + code.trim() + '</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    html = html.split('\n\n').map(p => {
      p = p.trim();
      if (!p) return '';
      if (p.startsWith('<h') || p.startsWith('<pre') || p.startsWith('<ul') || p.startsWith('<ol')) return p;
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('');

    return html;
  }

  // ── Think block parser ────────────────────────────────────────────────
  function parseThinking(text) {
    const openIdx = text.indexOf('<think>');
    if (openIdx < 0) return { thinking: '', response: text, isThinking: false };

    const afterOpen = text.slice(openIdx + 7);
    const closeIdx = afterOpen.indexOf('</think>');
    if (closeIdx < 0) {
      return { thinking: afterOpen, response: '', isThinking: true };
    }
    return {
      thinking: afterOpen.slice(0, closeIdx),
      response: afterOpen.slice(closeIdx + 8).trim(),
      isThinking: false
    };
  }

  // ── DOM helpers ───────────────────────────────────────────────────────
  function getPanel() { return document.getElementById('chatPanel'); }
  function getMsgContainer() { return document.getElementById('chatMessages'); }
  function getInput() { return document.getElementById('chatInput'); }
  function getSendBtn() { return document.getElementById('chatSendBtn'); }
  function getStopBtn() { return document.getElementById('chatStopBtn'); }

  function scrollToBottom() {
    const el = getMsgContainer();
    if (el) el.scrollTop = el.scrollHeight;
  }

  function createAiBubble(id) {
    const div = document.createElement('div');
    div.className = 'chat-msg ai';
    div.id = 'ai-msg-' + id;
    div.innerHTML = '<span class="chat-dots"></span>';
    getMsgContainer().appendChild(div);
    scrollToBottom();
    return div;
  }

  function updateAiBubble(id, fullText) {
    const div = document.getElementById('ai-msg-' + id);
    if (!div) return;

    const parsed = parseThinking(fullText);
    let html = '';

    if (parsed.thinking) {
      const expanded = parsed.isThinking;
      html += '<div class="think-section">';
      html += '<div class="think-header" onclick="AdvisorChat._toggleThink(this)">';
      html += '<span class="think-arrow' + (expanded ? ' expanded' : '') + '">&#9654;</span>';
      html += '<span class="think-label">' + (parsed.isThinking ? t('thinking') : t('thinkProcess')) + '</span>';
      html += '</div>';
      html += '<div class="think-body' + (expanded ? ' visible' : '') + '">' + renderMarkdown(parsed.thinking) + '</div>';
      html += '</div>';
    }

    if (parsed.response) {
      html += renderMarkdown(parsed.response);
    } else if (!parsed.thinking && !fullText) {
      html = '<span class="chat-dots"></span>';
    }

    div.innerHTML = html;
    scrollToBottom();
  }

  function addUserBubble(text) {
    const div = document.createElement('div');
    div.className = 'chat-msg user';
    div.textContent = text;
    getMsgContainer().appendChild(div);
    scrollToBottom();
  }

  function showError(msg) {
    const div = document.createElement('div');
    div.className = 'chat-msg ai error';
    div.textContent = msg;
    getMsgContainer().appendChild(div);
    scrollToBottom();
  }

  // ── Toggle think section ──────────────────────────────────────────────
  function _toggleThink(header) {
    const arrow = header.querySelector('.think-arrow');
    const body = header.nextElementSibling;
    if (!body) return;
    const show = !body.classList.contains('visible');
    body.classList.toggle('visible', show);
    arrow.classList.toggle('expanded', show);
  }

  // ── Build API messages array ──────────────────────────────────────────
  function buildApiMessages(userText) {
    let systemContent = ADVISOR_SYSTEM;
    if (window.MiniCPM && MiniCPM.getBackground) {
      const bg = MiniCPM.getBackground();
      if (bg) systemContent = bg + '\n\n' + ADVISOR_SYSTEM;
    }

    const apiMsgs = [{ role: 'system', content: systemContent }];

    let gameContext = '';
    if (window.MiniCPM && MiniCPM.serializeState && window.Game && Game.turn != null) {
      try {
        gameContext = MiniCPM.serializeState(Game.turn);
      } catch (e) {}
    }

    for (const m of messages) {
      apiMsgs.push({ role: m.role, content: m.content });
    }

    const userContent = gameContext
      ? '[Current game state]\n' + gameContext + '\n\n[Player question]\n' + userText
      : userText;
    apiMsgs.push({ role: 'user', content: userContent });

    return apiMsgs;
  }

  // ── Streaming request ─────────────────────────────────────────────────
  async function sendMessage() {
    const input = getInput();
    const text = input.value.trim();
    if (!text || isGenerating) return;

    input.value = '';
    input.style.height = 'auto';
    addUserBubble(text);
    messages.push({ role: 'user', content: text });

    const msgId = Date.now();
    createAiBubble(msgId);
    setGenerating(true);

    const apiMessages = buildApiMessages(text);

    const apiBase = (window.MiniCPM && MiniCPM.getApiBase) ? MiniCPM.getApiBase() : 'http://127.0.0.1:18766';
    const apiKey = (window.MiniCPM && MiniCPM.getApiKey) ? MiniCPM.getApiKey() : null;
    const modelName = (window.MiniCPM && MiniCPM.getModelName) ? MiniCPM.getModelName() : 'minicpm';

    const url = apiBase.replace(/\/+$/, '') + '/v1/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

    abortCtrl = new AbortController();
    let fullText = '';

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelName,
          messages: apiMessages,
          temperature: 0.6,
          max_tokens: 1024,
          stream: true,
        }),
        signal: abortCtrl.signal,
      });

      if (!resp.ok) {
        throw new Error('Server returned ' + resp.status);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
            if (delta && delta.content) {
              fullText += delta.content;
              updateAiBubble(msgId, fullText);
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // User stopped generation
      } else {
        const isOffline = err.message.includes('fetch') || err.message.includes('network') || err.message.includes('Failed');
        showError(isOffline ? t('offline') : t('error') + ' ' + err.message);
      }
    }

    if (fullText) {
      const parsed = parseThinking(fullText);
      const cleanResponse = parsed.response || fullText;
      messages.push({ role: 'assistant', content: cleanResponse });
      updateAiBubble(msgId, fullText);
    }

    setGenerating(false);
    abortCtrl = null;
  }

  function stopGeneration() {
    if (abortCtrl) abortCtrl.abort();
  }

  function setGenerating(val) {
    isGenerating = val;
    const sendBtn = getSendBtn();
    const stopBtn = getStopBtn();
    if (sendBtn) sendBtn.disabled = val;
    if (stopBtn) stopBtn.classList.toggle('visible', val);
  }

  // ── Panel open/close ──────────────────────────────────────────────────
  function open() {
    const panel = getPanel();
    if (panel) {
      panel.classList.add('open');
      applyI18n();
      setTimeout(() => { const inp = getInput(); if (inp) inp.focus(); }, 300);
    }
  }

  function close() {
    const panel = getPanel();
    if (panel) panel.classList.remove('open');
  }

  function toggle() {
    const panel = getPanel();
    if (panel && panel.classList.contains('open')) close();
    else open();
  }

  function clearChat() {
    messages = [];
    const container = getMsgContainer();
    if (container) container.innerHTML = '';
  }

  // ── i18n apply ────────────────────────────────────────────────────────
  function applyI18n() {
    const panel = getPanel();
    if (!panel) return;
    const title = panel.querySelector('.chat-header h3');
    if (title) title.textContent = t('title');
    const input = getInput();
    if (input) input.placeholder = t('placeholder');
    const sendBtn = getSendBtn();
    if (sendBtn) sendBtn.textContent = t('send');
    const stopBtn = getStopBtn();
    if (stopBtn) stopBtn.textContent = t('stop');
    const clearBtn = panel.querySelector('.chat-clear');
    if (clearBtn) clearBtn.textContent = t('clear');
  }

  // ── Init (called after DOM ready) ─────────────────────────────────────
  function init() {
    const input = getInput();
    if (!input) return;

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });

    getSendBtn().addEventListener('click', sendMessage);
    getStopBtn().addEventListener('click', stopGeneration);

    const closeBtn = getPanel().querySelector('.chat-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    const clearBtn = getPanel().querySelector('.chat-clear');
    if (clearBtn) clearBtn.addEventListener('click', clearChat);

    applyI18n();
  }

  return {
    init, open, close, toggle, clearChat, applyI18n,
    _toggleThink,
  };
})();

window.AdvisorChat = AdvisorChat;
