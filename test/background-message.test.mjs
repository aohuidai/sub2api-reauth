import assert from 'node:assert/strict';
import test from 'node:test';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
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
    tabs: {
      create: async (details) => openedTabs.push(details),
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
