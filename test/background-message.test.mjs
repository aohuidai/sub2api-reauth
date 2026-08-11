import assert from 'node:assert/strict';
import test from 'node:test';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function createSessionStorage(initial = {}) {
  const values = { ...initial };
  return {
    session: {
      async get(keys) {
        const names = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
        return Object.fromEntries(names.map((key) => [key, values[key]]));
      },
      async set(next) {
        Object.assign(values, next);
      },
      async remove(keys) {
        for (const key of (Array.isArray(keys) ? keys : [keys])) delete values[key];
      },
    },
    read(key) {
      return values[key];
    },
  };
}

function sendToBackground(listener, message) {
  return new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true);
  });
}

test('service worker handles a popup query through the read-only client', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const calls = [];

  globalThis.chrome = {
    runtime: {
      onInstalled: {
        addListener(listener) {
          listeners.onInstalled = listener;
        },
      },
      onMessage: {
        addListener(listener) {
          listeners.onMessage = listener;
        },
      },
    },
  };
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, method: options.method || 'GET' });

    if (parsed.pathname === '/api/v1/auth/login') {
      return jsonResponse({ code: 0, data: { access_token: 'test-token' } });
    }
    if (parsed.pathname === '/api/v1/admin/groups/all') {
      return jsonResponse({ code: 0, data: [{ id: 26, name: 'codex all' }] });
    }
    if (parsed.pathname === '/api/v1/admin/accounts') {
      return jsonResponse({
        code: 0,
        data: {
          total: 0,
          items: [],
        },
      });
    }
    return jsonResponse({ code: 1, message: 'Unexpected request' }, 404);
  };

  try {
    await import(`../background/background.js?test=${Date.now()}`);
    const response = await new Promise((resolve) => {
      const handled = listeners.onMessage({
        type: 'QUERY_REAUTH_CANDIDATES',
        connection: {
          baseUrl: 'http://sub2api.test/admin/accounts',
          email: 'admin@sub2api.test',
          password: 'not-stored',
          groupName: 'codex all',
        },
      }, {}, resolve);
      assert.equal(handled, true);
    });

    assert.equal(response.ok, true);
    assert.deepEqual(response.result.accounts, []);
    assert.deepEqual(
      calls.filter((call) => call.method !== 'GET').map((call) => [call.method, call.path]),
      [['POST', '/api/v1/auth/login']]
    );
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test('service worker generates and opens the selected account reauthorization URL', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const openedTabs = [];
  const storage = createSessionStorage();

  globalThis.chrome = {
    runtime: {
      onInstalled: {
        addListener(listener) {
          listeners.onInstalled = listener;
        },
      },
      onMessage: {
        addListener(listener) {
          listeners.onMessage = listener;
        },
      },
    },
    storage,
    tabs: {
      create: async (details) => {
        openedTabs.push(details);
        return { id: 77 };
      },
    },
  };
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/auth/login') {
      return jsonResponse({ code: 0, data: { access_token: 'test-token' } });
    }
    if (parsed.pathname === '/api/v1/admin/openai/generate-auth-url') {
      assert.deepEqual(JSON.parse(options.body), {
        redirect_uri: 'http://localhost:1455/auth/callback',
        account_id: 10,
        proxy_id: 8,
      });
      return jsonResponse({
        code: 0,
        data: {
          auth_url: 'https://auth.openai.com/oauth/authorize?state=reauth-state',
          session_id: 'reauth-session',
        },
      });
    }
    return jsonResponse({ code: 1, message: 'Unexpected request' }, 404);
  };

  try {
    await import(`../background/background.js?test=${Date.now()}-reauth`);
    const response = await new Promise((resolve) => {
      const handled = listeners.onMessage({
        type: 'OPEN_FIRST_OPENAI_REAUTH',
        connection: {
          baseUrl: 'http://sub2api.test/admin/accounts',
          email: 'admin@sub2api.test',
          password: 'not-stored',
        },
        account: { id: 10, email: 'target@example.com', proxyId: 8 },
      }, {}, resolve);
      assert.equal(handled, true);
    });

    assert.equal(response.ok, true);
    assert.equal(response.result.account.email, 'target@example.com');
    assert.deepEqual(openedTabs, [{
      url: 'https://auth.openai.com/oauth/authorize?state=reauth-state',
      active: true,
    }]);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test('service worker snapshots QQ inbox IDs, then polls only with that baseline', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const activatedTabs = [];
  const injected = [];
  const storage = createSessionStorage({ openAiLearningAuthTabId: 42 });

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    storage,
    tabs: {
      query: async ({ url }) => {
        assert.deepEqual(url, ['https://mail.qq.com/*', 'https://wx.mail.qq.com/*']);
        return [{ id: 9, url: 'https://wx.mail.qq.com/' }];
      },
      update: async (tabId, updateInfo) => activatedTabs.push({ tabId, updateInfo }),
      sendMessage: async (tabId, message) => {
        assert.equal(tabId, 9);
        if (message.type === 'SNAPSHOT_QQ_MAIL_BASELINE_V2') {
          return { ok: true, result: { mailIds: ['mail-old'] } };
        }
        assert.equal(message.type, 'POLL_QQ_OPENAI_LOGIN_CODE_V2');
        assert.deepEqual(message.payload.baseline.mailIds, ['mail-old']);
        assert.equal(message.payload.baseline.mailTabId, 9);
        assert.equal(typeof message.payload.baseline.capturedAt, 'number');
        return { ok: true, result: { code: '123456', mailId: 'mail-new' } };
      },
    },
    scripting: {
      executeScript: async (details) => injected.push(details),
    },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });

  try {
    await import(`../background/background.js?test=${Date.now()}-qq`);
    const snapshot = await sendToBackground(listeners.onMessage, {
      type: 'SNAPSHOT_QQ_MAIL_BASELINE',
    });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.result.available, true);
    assert.deepEqual(storage.read('openAiQqMailBaseline').mailIds, ['mail-old']);
    assert.equal(storage.read('openAiQqMailBaseline').mailTabId, 9);

    const response = await sendToBackground(listeners.onMessage, {
      type: 'FETCH_QQ_OPENAI_LOGIN_CODE',
    });

    assert.equal(response.ok, true);
    assert.equal(response.result.code, '123456');
    assert.equal(storage.read('openAiLearningVerificationCode'), '123456');
    assert.deepEqual(injected, [
      { target: { tabId: 9 }, files: ['content/qq-mail-learning.js'] },
      { target: { tabId: 9 }, files: ['content/qq-mail-learning.js'] },
    ]);
    assert.deepEqual(activatedTabs, [
      { tabId: 9, updateInfo: { active: true } },
      { tabId: 42, updateInfo: { active: true } },
      { tabId: 9, updateInfo: { active: true } },
      { tabId: 42, updateInfo: { active: true } },
    ]);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test('service worker refuses to poll QQ Mail without a fresh inbox baseline', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const storage = createSessionStorage({ openAiLearningAuthTabId: 42 });
  let pollRequested = false;

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    storage,
    tabs: {
      query: async () => [{ id: 9, url: 'https://wx.mail.qq.com/' }],
      update: async () => {},
      sendMessage: async (_tabId, message) => {
        if (message.type === 'SNAPSHOT_QQ_MAIL_BASELINE_V2') {
          return { ok: true, result: { mailIds: ['mail-old'] } };
        }
        if (message.type === 'POLL_QQ_OPENAI_LOGIN_CODE_V2') pollRequested = true;
        return { ok: true, result: { code: '123456' } };
      },
    },
    scripting: { executeScript: async () => {} },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });

  try {
    await import(`../background/background.js?test=${Date.now()}-qq-no-baseline`);
    const response = await sendToBackground(listeners.onMessage, {
      type: 'FETCH_QQ_OPENAI_LOGIN_CODE',
    });

    assert.equal(response.ok, true);
    assert.equal(response.result.needsFreshCode, true);
    assert.equal(pollRequested, false);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test('service worker captures a callback and pushes the selected account reauthorization', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const calls = [];
  const storage = createSessionStorage();

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
      sendMessage: async () => {},
    },
    storage,
    tabs: {
      create: async () => ({ id: 77 }),
    },
    webNavigation: {
      onBeforeNavigate: { addListener(listener) { listeners.onBeforeNavigate = listener; } },
      onCommitted: { addListener(listener) { listeners.onCommitted = listener; } },
    },
  };
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, method: options.method || 'GET', body });

    if (parsed.pathname === '/api/v1/auth/login') {
      return jsonResponse({ code: 0, data: { access_token: 'admin-token' } });
    }
    if (parsed.pathname === '/api/v1/admin/openai/generate-auth-url') {
      return jsonResponse({
        code: 0,
        data: {
          auth_url: 'https://auth.openai.com/oauth/authorize?state=reauth-state',
          session_id: 'reauth-session',
        },
      });
    }
    if (parsed.pathname === '/api/v1/admin/accounts/10' && (options.method || 'GET') === 'GET') {
      return jsonResponse({
        code: 0,
        data: {
          id: 10,
          name: 'target@example.com',
          platform: 'openai',
          type: 'oauth',
          group_ids: [26],
          proxy_id: 8,
          credentials: { email: 'target@example.com', access_token: 'old-token' },
          extra: { original: true },
        },
      });
    }
    if (parsed.pathname === '/api/v1/admin/openai/exchange-code') {
      assert.deepEqual(body, {
        session_id: 'reauth-session',
        code: 'callback-code',
        state: 'reauth-state',
        redirect_uri: 'http://localhost:1455/auth/callback',
        proxy_id: 8,
      });
      return jsonResponse({
        code: 0,
        data: {
          access_token: 'new-token',
          refresh_token: 'new-refresh-token',
          email: 'target@example.com',
        },
      });
    }
    if (parsed.pathname === '/api/v1/admin/accounts/10' && options.method === 'PUT') {
      return jsonResponse({ code: 0, data: { id: 10 } });
    }
    if (parsed.pathname === '/api/v1/admin/accounts/10/clear-error') {
      return jsonResponse({ code: 0, data: {} });
    }
    return jsonResponse({ code: 1, message: 'Unexpected request' }, 404);
  };

  try {
    await import(`../background/background.js?test=${Date.now()}-callback-push`);
    const connection = {
      baseUrl: 'http://sub2api.test/admin/accounts',
      email: 'admin@sub2api.test',
      password: 'not-stored',
    };

    const opened = await sendToBackground(listeners.onMessage, {
      type: 'OPEN_FIRST_OPENAI_REAUTH',
      connection,
      account: { id: 10, email: 'target@example.com', proxyId: 8 },
    });
    assert.equal(opened.ok, true);
    assert.equal(storage.read('sub2apiReauthContext').sessionId, 'reauth-session');

    const armed = await sendToBackground(listeners.onMessage, { type: 'ARM_OPENAI_CALLBACK_CAPTURE' });
    assert.equal(armed.ok, true);
    assert.equal(armed.result.active, true);

    listeners.onBeforeNavigate({
      frameId: 0,
      url: 'http://localhost:1455/auth/callback?code=callback-code&state=reauth-state',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const captured = await sendToBackground(listeners.onMessage, { type: 'GET_OPENAI_CALLBACK_CAPTURE' });
    assert.equal(captured.ok, true);
    assert.equal(captured.result.active, false);
    assert.match(captured.result.callbackUrl, /callback-code/);

    const pushed = await sendToBackground(listeners.onMessage, {
      type: 'SUBMIT_OPENAI_REAUTH_CALLBACK',
      connection,
    });
    assert.equal(pushed.ok, true);
    assert.match(pushed.result.status, /已重授权账号 #10/);
    assert.equal(storage.read('sub2apiReauthContext'), undefined);
    assert.equal(calls.filter((call) => call.path === '/api/v1/admin/accounts/10' && call.method === 'PUT').length, 1);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});
