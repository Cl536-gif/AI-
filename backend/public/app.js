(function () {
  const USER_ID_KEY = 'dietSecretary.userId';

  const messagesEl = document.getElementById('messages');
  const composerEl = document.getElementById('composer');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');

  let sessionId = null;
  let sending = false;

  function getOrCreateUserId() {
    let id = localStorage.getItem(USER_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || `u-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(USER_ID_KEY, id);
    }
    return id;
  }

  const userId = getOrCreateUserId();

  function appendBubble(text, role, extraClass) {
    const row = document.createElement('div');
    row.className = `bubble-row bubble-row--${role === 'user' ? 'user' : 'ai'}`;

    const bubble = document.createElement('div');
    bubble.className = `bubble bubble--${role === 'user' ? 'user' : 'ai'}${extraClass ? ` ${extraClass}` : ''}`;
    bubble.textContent = text;

    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 120)}px`;
  }

  async function postJson(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `请求失败（${res.status}）`);
    }
    return data;
  }

  async function loadGreeting() {
    const pending = appendBubble('AI秘书正在输入…', 'ai', 'bubble--pending');
    try {
      const data = await postJson('/api/chat/greeting', { userId });
      sessionId = data.sessionId || null;
      pending.textContent = data.reply;
      pending.classList.remove('bubble--pending');
    } catch (err) {
      pending.textContent = `打招呼失败：${err.message}`;
      pending.classList.remove('bubble--pending');
      pending.classList.add('bubble--error');
    }
  }

  async function sendMessage(text) {
    appendBubble(text, 'user');
    const pending = appendBubble('AI秘书正在输入…', 'ai', 'bubble--pending');

    try {
      const data = await postJson('/api/chat', { userId, message: text, sessionId });
      sessionId = data.sessionId || sessionId;
      pending.textContent = data.reply;
      pending.classList.remove('bubble--pending');
    } catch (err) {
      pending.textContent = `发送失败：${err.message}`;
      pending.classList.remove('bubble--pending');
      pending.classList.add('bubble--error');
    }
  }

  composerEl.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sending) return;

    const text = inputEl.value.trim();
    if (!text) return;

    sending = true;
    sendEl.disabled = true;
    inputEl.value = '';
    autoGrow();

    sendMessage(text).finally(() => {
      sending = false;
      sendEl.disabled = false;
      inputEl.focus();
    });
  });

  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composerEl.requestSubmit();
    }
  });

  loadGreeting();
})();
