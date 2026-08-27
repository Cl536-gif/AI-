(function () {
  const USER_ID_KEY = 'dietSecretary.userId';
  // 正式首页与 compare-v3 测试台使用不同身份，避免测试时填写的虚构
  // 档案被正式入口误认为同一位用户的长期资料。
  const DEVICE_ID_KEY = 'dietSecretary.home.deviceId';
  const TEST_PERSONA_KEY = 'dietSecretary.home.testPersona';
  const TEST_PERSONA_DEVICE_PREFIX = 'dietSecretary.home.testPersona.device.';

  const messagesEl = document.getElementById('messages');
  const composerEl = document.getElementById('composer');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const developerPersonaEl = document.getElementById('developer-persona');
  const developerPersonaSelectEl = document.getElementById('developer-persona-select');
  const developerPersonaStatusEl = document.getElementById('developer-persona-status');
  const developerDataLinkEl = document.getElementById('developer-data-link');

  let langgraphThreadId = null;
  let privacyOnboardingPending = false;
  let sending = false;
  const REPLY_DELAY_MS = 2000;

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getOrCreateUserId() {
    let id = localStorage.getItem(USER_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || `u-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(USER_ID_KEY, id);
    }
    return id;
  }

  let userId = getOrCreateUserId();

  function getOrCreateDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }

  let deviceId = getOrCreateDeviceId();
  let testPersona = null;

  function createUuid() {
    return crypto.randomUUID();
  }

  function getPersonaDeviceId(persona, { fresh = false } = {}) {
    const key = `${TEST_PERSONA_DEVICE_PREFIX}${persona}`;
    let id = fresh ? null : localStorage.getItem(key);
    if (!id) {
      id = createUuid();
      localStorage.setItem(key, id);
    }
    return id;
  }

  async function configureDeveloperPersona(persona, { fresh = false } = {}) {
    const nextDeviceId = getPersonaDeviceId(persona, {
      fresh: fresh || persona === 'new_contact',
    });
    const nextGreetingUserId = `dev-greeting-${persona}-${nextDeviceId}`;
    const data = await postJson('/api/debug/user-data/test-persona', {
      persona,
      deviceId: nextDeviceId,
      greetingUserId: nextGreetingUserId,
    });
    testPersona = persona;
    deviceId = nextDeviceId;
    userId = nextGreetingUserId;
    localStorage.setItem(TEST_PERSONA_KEY, persona);
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    developerPersonaStatusEl.textContent = data.description;
    developerDataLinkEl.href = `/user-data-dashboard.html?deviceId=${encodeURIComponent(deviceId)}`;
    return data;
  }

  async function initializeDeveloperPersona() {
    try {
      const savedValue = localStorage.getItem(TEST_PERSONA_KEY) || 'new_contact';
      // 企业微信聊天里账号身份不构成一条独立服务路线；旧的“已注册”
      // 测试身份统一迁移成免费用户，聊天只区分免费与长期服务。
      const savedPersona = savedValue === 'registered' ? 'free' : savedValue;
      if (savedValue !== savedPersona) localStorage.setItem(TEST_PERSONA_KEY, savedPersona);
      developerPersonaSelectEl.value = savedPersona;
      const data = await configureDeveloperPersona(savedPersona);
      developerPersonaEl.hidden = false;
      return data;
    } catch (err) {
      developerPersonaEl.hidden = true;
      testPersona = null;
      return null;
    }
  }

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
    const pending = appendBubble('饮食秘书正在输入…', 'ai', 'bubble--pending');
    try {
      const data = await postJson('/api/chat/greeting', {
        userId,
        deviceId,
        ...(testPersona ? { testPersona } : {}),
      });
      privacyOnboardingPending = Boolean(data.privacyOnboardingPending);
      const replies = Array.isArray(data.replies) && data.replies.length ? data.replies : [data.reply];
      pending.textContent = replies[0];
      pending.classList.remove('bubble--pending');
      for (const reply of replies.slice(1)) {
        // eslint-disable-next-line no-await-in-loop
        await wait(REPLY_DELAY_MS);
        appendBubble(reply, 'ai');
      }
    } catch (err) {
      pending.textContent = `打招呼失败：${err.message}`;
      pending.classList.remove('bubble--pending');
      pending.classList.add('bubble--error');
    }
  }

  async function sendMessage(text) {
    appendBubble(text, 'user');
    const pending = appendBubble('饮食秘书正在输入…', 'ai', 'bubble--pending');

    try {
      const data = await postJson('/api/chat-langgraph', {
        message: text,
        deviceId,
        ...(testPersona ? { testPersona } : {}),
        introAlreadyShown: true,
        privacyOnboarding: privacyOnboardingPending,
        ...(langgraphThreadId ? { threadId: langgraphThreadId } : {}),
      });
      langgraphThreadId = data.threadId || langgraphThreadId;
      privacyOnboardingPending = Boolean(data.privacyOnboardingPending);
      const replies = Array.isArray(data.replies) && data.replies.length ? data.replies : [data.reply];
      pending.textContent = replies[0];
      pending.classList.remove('bubble--pending');
      for (const reply of replies.slice(1)) {
        // eslint-disable-next-line no-await-in-loop
        await wait(REPLY_DELAY_MS);
        appendBubble(reply, 'ai');
      }
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

  developerPersonaSelectEl.addEventListener('change', async () => {
    if (sending) return;
    developerPersonaSelectEl.disabled = true;
    try {
      await configureDeveloperPersona(developerPersonaSelectEl.value, {
        fresh: developerPersonaSelectEl.value === 'new_contact',
      });
      langgraphThreadId = null;
      privacyOnboardingPending = false;
      messagesEl.replaceChildren();
      await loadGreeting();
    } catch (err) {
      appendBubble(`切换测试通道失败：${err.message}`, 'ai', 'bubble--error');
    } finally {
      developerPersonaSelectEl.disabled = false;
    }
  });

  initializeDeveloperPersona().finally(loadGreeting);
})();
