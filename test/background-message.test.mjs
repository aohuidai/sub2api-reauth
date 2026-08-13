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

test('service worker handles a side panel query through the read-only client', async () => {
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
    sidePanel: {
      setPanelBehavior: async () => {},
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
    sidePanel: {
      setPanelBehavior: async () => {},
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
        runId: 'demo-1',
      }, {}, resolve);
      assert.equal(handled, true);
    });

    assert.equal(response.ok, true);
    assert.equal(response.result.account.email, 'target@example.com');
    assert.deepEqual(openedTabs, [{
      url: 'https://auth.openai.com/oauth/authorize?state=reauth-state',
      active: true,
    }]);
    assert.deepEqual(storage.read('openAiLearningOwnedTabsByRun'), { 'demo-1': [77] });
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test('service worker closes only tabs it opened for a completed demo round', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const removedTabs = [];
  const storage = createSessionStorage({
    openAiLearningAuthTabId: 77,
    openAiLearningOwnedTabsByRun: { 'demo-1': [77, 9], 'demo-2': [88] },
    openAiQqMailBaseline: { mailTabId: 9 },
    openAiLearningVerificationCode: '123456',
    sub2apiReauthContext: { account: { id: 10 } },
  });

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage,
    tabs: {
      remove: async (tabId) => removedTabs.push(tabId),
    },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });

  try {
    await import(`../background/background.js?test=${Date.now()}-close-round`);
    const response = await sendToBackground(listeners.onMessage, {
      type: 'CLOSE_OPENAI_LEARNING_ROUND',
      runId: 'demo-1',
    });

    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { closedTabCount: 2 });
    assert.deepEqual(removedTabs, [77, 9]);
    assert.deepEqual(storage.read('openAiLearningOwnedTabsByRun'), { 'demo-2': [88] });
    assert.equal(storage.read('openAiLearningAuthTabId'), undefined);
    assert.equal(storage.read('openAiQqMailBaseline'), undefined);
    assert.equal(storage.read('openAiLearningVerificationCode'), undefined);
    assert.equal(storage.read('sub2apiReauthContext'), undefined);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test('service worker keeps full-demo page actions on the prepared OpenAI tab', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const injected = [];
  const storage = createSessionStorage({ openAiLearningAuthTabId: 42 });

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage,
    tabs: {
      query: async () => {
        assert.fail('the full demo should use the stored OpenAI tab instead of the active tab');
      },
      sendMessage: async (tabId, message) => {
        assert.equal(tabId, 42);
        assert.deepEqual(message, {
          type: 'RUN_OPENAI_LEARNING_STEP',
          action: 'fill-email',
          value: { email: 'target@example.com' },
        });
        return { ok: true, result: { action: 'email-filled' } };
      },
    },
    scripting: {
      executeScript: async (details) => injected.push(details),
    },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });

  try {
    await import(`../background/background.js?test=${Date.now()}-stored-auth-tab`);
    const response = await sendToBackground(listeners.onMessage, {
      type: 'RUN_OPENAI_LEARNING_STEP',
      action: 'fill-email',
      value: { email: 'target@example.com' },
      useOpenAiAuthTab: true,
    });

    assert.equal(response.ok, true);
    assert.deepEqual(injected, [{
      target: { tabId: 42 },
      files: ['content/openai-login-learning.js'],
    }]);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test('service worker waits for the password input before confirming the email-page transition', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const listeners = {};
  const injected = [];
  let pageStateRequests = 0;
  const storage = createSessionStorage({ openAiLearningAuthTabId: 42 });

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage,
    tabs: {
      get: async (tabId) => {
        assert.equal(tabId, 42);
        return { id: 42, url: 'https://auth.openai.com/log-in' };
      },
      sendMessage: async (tabId, message) => {
        assert.equal(tabId, 42);
        assert.deepEqual(message, { type: 'GET_OPENAI_LOGIN_PAGE_STATE_V2' });
        pageStateRequests += 1;
        return {
          ok: true,
          result: {
            url: 'https://auth.openai.com/log-in',
            passwordPageReady: pageStateRequests >= 2,
          },
        };
      },
      onUpdated: { addListener(listener) { listeners.onTabUpdated = listener; } },
    },
    scripting: {
      executeScript: async (details) => injected.push(details),
    },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });
  globalThis.setTimeout = (callback) => {
    callback();
    return 1;
  };

  try {
    await import(`../background/background.js?test=${Date.now()}-password-page-ready`);
    const response = await sendToBackground(listeners.onMessage, {
      type: 'WAIT_FOR_OPENAI_PASSWORD_PAGE',
      runId: 'demo-password-page',
    });

    assert.equal(response.ok, true);
    assert.deepEqual(response.result, {
      ready: true,
      url: 'https://auth.openai.com/log-in',
    });
    assert.equal(pageStateRequests, 2);
    assert.deepEqual(injected, [
      { target: { tabId: 42 }, files: ['content/openai-login-learning.js'] },
      { target: { tabId: 42 }, files: ['content/openai-login-learning.js'] },
    ]);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  }
});

test('service worker uses the dedicated stable OAuth click command for step 8', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const injected = [];
  const storage = createSessionStorage({ openAiLearningAuthTabId: 42 });

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage,
    tabs: {
      sendMessage: async (tabId, message) => {
        assert.equal(tabId, 42);
        assert.deepEqual(message, {
          type: 'RUN_OPENAI_OAUTH_CONTINUE_V2',
          value: { strategy: 'nativeClick' },
        });
        return { ok: true, result: { action: 'oauth-continue-triggered', url: 'https://auth.openai.com/consent' } };
      },
    },
    scripting: {
      executeScript: async (details) => injected.push(details),
    },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });

  try {
    await import(`../background/background.js?test=${Date.now()}-oauth-v2-command`);
    const response = await sendToBackground(listeners.onMessage, {
      type: 'RUN_OPENAI_LEARNING_STEP',
      action: 'oauth-continue',
      value: { strategy: 'nativeClick' },
      useOpenAiAuthTab: true,
    });

    assert.equal(response.ok, true);
    assert.equal(response.result.action, 'oauth-continue-triggered');
    assert.deepEqual(injected, [{
      target: { tabId: 42 },
      files: ['content/openai-login-learning.js'],
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
    sidePanel: { setPanelBehavior: async () => {} },
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

test('service worker opens QQ Mail before snapshotting a missing inbox tab', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const openedTabs = [];
  const injected = [];
  const storage = createSessionStorage({ openAiLearningAuthTabId: 42 });

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage,
    tabs: {
      query: async ({ url }) => {
        assert.deepEqual(url, ['https://mail.qq.com/*', 'https://wx.mail.qq.com/*']);
        return [];
      },
      create: async (details) => {
        openedTabs.push(details);
        return { id: 9, active: true, status: 'complete', url: 'https://wx.mail.qq.com/' };
      },
      sendMessage: async (tabId, message) => {
        assert.equal(tabId, 9);
        assert.deepEqual(message, { type: 'SNAPSHOT_QQ_MAIL_BASELINE_V2' });
        return { ok: true, result: { needsLogin: true } };
      },
    },
    scripting: {
      executeScript: async (details) => injected.push(details),
    },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });

  try {
    await import(`../background/background.js?test=${Date.now()}-qq-open`);
    const response = await sendToBackground(listeners.onMessage, {
      type: 'SNAPSHOT_QQ_MAIL_BASELINE',
    });

    assert.equal(response.ok, true);
    assert.deepEqual(response.result, {
      available: false,
      needsLogin: true,
      openedMailTab: true,
      mailTabId: 9,
    });
    assert.deepEqual(openedTabs, [{ url: 'https://wx.mail.qq.com/', active: true }]);
    assert.deepEqual(injected, [{
      target: { tabId: 9 },
      files: ['content/qq-mail-learning.js'],
    }]);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test('service worker opens a fresh QQ Mail tab when an existing tab has no inbox list', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const openedTabs = [];
  const injected = [];
  const snapshotTabIds = [];
  const activatedTabs = [];
  const storage = createSessionStorage({ openAiLearningAuthTabId: 42 });

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage,
    tabs: {
      query: async ({ url }) => {
        assert.deepEqual(url, ['https://mail.qq.com/*', 'https://wx.mail.qq.com/*']);
        return [{ id: 8, active: true, status: 'complete', url: 'https://wx.mail.qq.com/mail/detail' }];
      },
      create: async (details) => {
        openedTabs.push(details);
        return { id: 9, active: true, status: 'complete', url: 'https://wx.mail.qq.com/' };
      },
      update: async (tabId, updateInfo) => activatedTabs.push({ tabId, updateInfo }),
      sendMessage: async (tabId, message) => {
        assert.deepEqual(message, { type: 'SNAPSHOT_QQ_MAIL_BASELINE_V2' });
        snapshotTabIds.push(tabId);
        if (tabId === 8) {
          return { ok: false, error: '未找到 QQ 邮箱收件箱列表，请先打开收件箱。' };
        }
        return { ok: true, result: { mailIds: ['mail-old'] } };
      },
    },
    scripting: {
      executeScript: async (details) => injected.push(details),
    },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });

  try {
    await import(`../background/background.js?test=${Date.now()}-qq-fresh-inbox`);
    const response = await sendToBackground(listeners.onMessage, {
      type: 'SNAPSHOT_QQ_MAIL_BASELINE',
    });

    assert.equal(response.ok, true);
    assert.deepEqual(response.result, {
      available: true,
      openedMailTab: true,
      mailTabId: 9,
    });
    assert.deepEqual(openedTabs, [{ url: 'https://wx.mail.qq.com/', active: true }]);
    assert.deepEqual(snapshotTabIds, [8, 9]);
    assert.deepEqual(injected, [
      { target: { tabId: 8 }, files: ['content/qq-mail-learning.js'] },
      { target: { tabId: 9 }, files: ['content/qq-mail-learning.js'] },
    ]);
    assert.deepEqual(activatedTabs, [{ tabId: 42, updateInfo: { active: true } }]);
    assert.equal(storage.read('openAiQqMailBaseline').mailTabId, 9);
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
    sidePanel: { setPanelBehavior: async () => {} },
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
    sidePanel: { setPanelBehavior: async () => {} },
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
    if (parsed.pathname === '/api/v1/admin/accounts/10/schedulable') {
      assert.deepEqual(body, { schedulable: true });
      return jsonResponse({ code: 0, data: { id: 10, schedulable: true } });
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

test('service worker captures a localhost callback from the auth tab when navigation events were missed', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const storage = createSessionStorage({
    openAiLearningAuthTabId: 77,
    openAiLearningCallback: {
      active: true,
      callbackUrl: '',
      startedAt: Date.now(),
      capturedAt: null,
    },
  });

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
      sendMessage: async () => {},
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage,
    tabs: {
      get: async (tabId) => {
        assert.equal(tabId, 77);
        return {
          id: 77,
          url: 'http://localhost:1455/auth/callback?code=missed-code&state=reauth-state',
        };
      },
      onUpdated: { addListener(listener) { listeners.onTabUpdated = listener; } },
    },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });

  try {
    await import(`../background/background.js?test=${Date.now()}-callback-tab-fallback`);
    const response = await sendToBackground(listeners.onMessage, {
      type: 'GET_OPENAI_CALLBACK_CAPTURE',
    });

    assert.equal(response.ok, true);
    assert.equal(response.result.active, false);
    assert.match(response.result.callbackUrl, /missed-code/);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test('service worker does not mistake a transient missing OAuth button for a successful click', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const listeners = {};
  const storage = createSessionStorage({
    openAiLearningAuthTabId: 77,
    openAiLearningCallback: {
      active: true,
      callbackUrl: '',
      startedAt: Date.now(),
      capturedAt: null,
    },
  });

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage,
    tabs: {
      get: async () => ({ id: 77, url: 'https://auth.openai.com/consent' }),
      sendMessage: async (_tabId, message) => {
        assert.equal(message.type, 'GET_OPENAI_OAUTH_PAGE_STATE_V2');
        return {
          ok: true,
          result: {
            url: 'https://auth.openai.com/consent',
            oauthConsentPage: false,
            oauthConsentReady: false,
          },
        };
      },
      onUpdated: { addListener(listener) { listeners.onTabUpdated = listener; } },
    },
    scripting: { executeScript: async () => {} },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });
  globalThis.setTimeout = (callback) => {
    callback();
    return 1;
  };

  try {
    await import(`../background/background.js?test=${Date.now()}-oauth-stuck`);
    const response = await sendToBackground(listeners.onMessage, {
      type: 'WAIT_FOR_OPENAI_OAUTH_PROGRESS',
      expectedUrl: 'https://auth.openai.com/consent',
    });

    assert.equal(response.ok, true);
    assert.deepEqual(response.result, {
      progressed: false,
      stillOnConsent: false,
      url: 'https://auth.openai.com/consent',
    });
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  }
});

test('service worker keeps waiting when only an OAuth consent query parameter changes', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const listeners = {};
  const storage = createSessionStorage({
    openAiLearningAuthTabId: 77,
    openAiLearningCallback: {
      active: true,
      callbackUrl: '',
      startedAt: Date.now(),
      capturedAt: null,
    },
  });

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage,
    tabs: {
      get: async () => ({ id: 77, url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent?render=2' }),
      sendMessage: async (_tabId, message) => {
        assert.equal(message.type, 'GET_OPENAI_OAUTH_PAGE_STATE_V2');
        return {
          ok: true,
          result: {
            url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent?render=2',
            oauthConsentPage: false,
            oauthConsentReady: false,
          },
        };
      },
      onUpdated: { addListener(listener) { listeners.onTabUpdated = listener; } },
    },
    scripting: { executeScript: async () => {} },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });
  globalThis.setTimeout = (callback) => {
    callback();
    return 1;
  };

  try {
    await import(`../background/background.js?test=${Date.now()}-oauth-consent-query`);
    const response = await sendToBackground(listeners.onMessage, {
      type: 'WAIT_FOR_OPENAI_OAUTH_PROGRESS',
      expectedUrl: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
    });

    assert.equal(response.ok, true);
    assert.deepEqual(response.result, {
      progressed: false,
      stillOnConsent: true,
      url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent?render=2',
    });
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  }
});

test('service worker stop message marks a demo run cancelled and signals QQ Mail', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const mailMessages = [];
  const storage = createSessionStorage();

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage,
    tabs: {
      query: async () => [{ id: 9, url: 'https://wx.mail.qq.com/' }],
      sendMessage: async (tabId, message) => {
        mailMessages.push({ tabId, message });
        return { ok: true };
      },
    },
  };
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });

  try {
    await import(`../background/background.js?test=${Date.now()}-cancel-run`);
    const cancelled = await sendToBackground(listeners.onMessage, {
      type: 'CANCEL_OPENAI_LEARNING_RUN',
      runId: 'demo-stop',
    });
    const blocked = await sendToBackground(listeners.onMessage, {
      type: 'RUN_OPENAI_LEARNING_STEP',
      action: 'fill-email',
      runId: 'demo-stop',
    });

    assert.equal(cancelled.ok, true);
    assert.deepEqual(cancelled.result, { cancelled: true });
    assert.deepEqual(mailMessages, [{
      tabId: 9,
      message: { type: 'CANCEL_QQ_OPENAI_LOGIN_CODE_V2', runId: 'demo-stop' },
    }]);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /完整演示已停止/);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});
