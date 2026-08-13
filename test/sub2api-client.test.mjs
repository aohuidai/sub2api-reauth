import assert from 'node:assert/strict';
import test from 'node:test';
import { createSub2ApiClient } from '../background/sub2api-client.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test('falls back to a nested unfiltered group response before querying candidates', async () => {
  const calls = [];
  const client = createSub2ApiClient({
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      calls.push({ path: parsed.pathname, method: options.method || 'GET', search: parsed.search });

      if (parsed.pathname === '/api/v1/auth/login') {
        return jsonResponse({ code: 0, data: { access_token: 'admin-token' } });
      }
      if (parsed.pathname === '/api/v1/admin/groups/all') {
        if (parsed.searchParams.get('platform') === 'openai') {
          return jsonResponse({ code: 0, data: { items: [] } });
        }
        return jsonResponse({
          code: 0,
          data: {
            groups: [
              { id: 2, name: 'codex', platform: 'shared' },
              { id: 26, name: 'codex all', platform: 'shared' },
            ],
          },
        });
      }
      if (parsed.pathname === '/api/v1/admin/accounts') {
        const status = parsed.searchParams.get('status');
        if (status === 'error') {
          return jsonResponse({
            code: 0,
            data: {
              total: 3,
              items: [
                {
                  id: 9,
                  name: 'wrong-group@example.com',
                  platform: 'openai',
                  type: 'oauth',
                  status: 'error',
                  group_ids: [2],
                  credentials: { email: 'wrong-group@example.com' },
                },
                {
                  id: 10,
                  name: 'target@example.com',
                  platform: 'openai',
                  type: 'oauth',
                  status: 'error',
                  group_ids: [26],
                  proxy_id: 8,
                  credentials: { email: 'target@example.com', model_mapping: { default: 'gpt-5' } },
                  error_message: 'Token revoked',
                },
                {
                  id: 11,
                  name: 'wrong-type@example.com',
                  platform: 'openai',
                  type: 'api_key',
                  status: 'error',
                  group_ids: [26],
                  credentials: { email: 'wrong-type@example.com' },
                },
              ],
            },
          });
        }
        if (status === 'temp_unschedulable') {
          return jsonResponse({
            code: 0,
            data: {
              total: 1,
              items: [
                {
                  id: 12,
                  name: 'blocked@example.com',
                  platform: 'openai',
                  type: 'oauth',
                  status: 'temp_unschedulable',
                  groups: [{ name: 'codex all' }],
                  credentials: { email: 'blocked@example.com' },
                  temp_unschedulable_reason: 'Retry later',
                },
              ],
            },
          });
        }
      }

      return jsonResponse({ code: 1, message: 'Unexpected request' }, 404);
    },
  });

  const result = await client.queryReauthCandidates({
    baseUrl: 'http://localhost:8080/admin/accounts',
    email: 'admin@sub2api.local',
    password: 'not-stored',
    groupName: 'codex all',
  });

  assert.deepEqual(result.group, { id: 26, name: 'codex all' });
  assert.equal(result.accounts.length, 2);
  assert.deepEqual(result.accounts.map((account) => account.id), [10, 12]);
  assert.equal(result.accounts[0].proxyId, 8);
  assert.equal(result.accounts[1].errorMessage, 'Retry later');
  assert.deepEqual(
    calls.filter((call) => call.method !== 'GET').map((call) => [call.method, call.path]),
    [['POST', '/api/v1/auth/login']]
  );
  assert.equal(calls.some((call) => call.method === 'PUT'), false);
  assert.equal(calls.some((call) => call.path.includes('exchange-code')), false);
  assert.equal(calls.some((call) => call.path.includes('generate-auth-url')), false);
  assert.equal(
    calls.filter((call) => call.path === '/api/v1/admin/groups/all').length,
    2
  );
});

test('rejects a missing group without making an account-list request', async () => {
  const calls = [];
  const client = createSub2ApiClient({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.pathname);
      if (parsed.pathname === '/api/v1/auth/login') {
        return jsonResponse({ code: 0, data: { access_token: 'admin-token' } });
      }
      return jsonResponse({ code: 0, data: [] });
    },
  });

  await assert.rejects(
    client.queryReauthCandidates({
      baseUrl: 'http://localhost:8080',
      email: 'admin@sub2api.local',
      password: 'not-stored',
      groupName: 'does not exist',
    }),
    /未找到分组/
  );
  assert.equal(calls.includes('/api/v1/admin/accounts'), false);
});

test('generates a reauthorization URL for the selected first account without updating it', async () => {
  const calls = [];
  const client = createSub2ApiClient({
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path: parsed.pathname, method: options.method || 'GET', body });

      if (parsed.pathname === '/api/v1/auth/login') {
        return jsonResponse({ code: 0, data: { access_token: 'admin-token' } });
      }
      if (parsed.pathname === '/api/v1/admin/openai/generate-auth-url') {
        assert.deepEqual(body, {
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
    },
  });

  const result = await client.prepareReauthForAccount({
    baseUrl: 'http://localhost:8080/admin/accounts',
    email: 'admin@sub2api.local',
    password: 'not-stored',
  }, {
    id: 10,
    email: 'target@example.com',
    proxyId: 8,
  });

  assert.deepEqual(result.account, { id: 10, email: 'target@example.com', proxyId: 8 });
  assert.equal(result.sessionId, 'reauth-session');
  assert.equal(result.oauthState, 'reauth-state');
  assert.equal(result.oauthUrl, 'https://auth.openai.com/oauth/authorize?state=reauth-state');
  assert.equal(calls.some((call) => call.method === 'PUT'), false);
  assert.equal(calls.some((call) => call.path.endsWith('/clear-error')), false);
});

test('exchanges a localhost callback and updates only the original OAuth account', async () => {
  const calls = [];
  let updateBody = null;
  const client = createSub2ApiClient({
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path: parsed.pathname, method: options.method || 'GET', body });

      if (parsed.pathname === '/api/v1/auth/login') {
        return jsonResponse({ code: 0, data: { access_token: 'admin-token' } });
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
            expires_in: 3600,
          },
        });
      }
      if (parsed.pathname === '/api/v1/admin/accounts/10' && options.method === 'PUT') {
        updateBody = body;
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
    },
  });

  const result = await client.submitReauthCallback({
    baseUrl: 'http://localhost:8080/admin/accounts',
    email: 'admin@sub2api.local',
    password: 'not-stored',
  }, {
    account: { id: 10, email: 'target@example.com', proxyId: 8 },
    sessionId: 'reauth-session',
    oauthState: 'reauth-state',
    redirectUri: 'http://localhost:1455/auth/callback',
  }, 'http://localhost:1455/auth/callback?code=callback-code&state=reauth-state');

  assert.equal(result.accountId, 10);
  assert.equal(result.email, 'target@example.com');
  assert.match(result.status, /已重授权账号 #10/);
  assert.equal(Object.hasOwn(result, 'updatedAccount'), false);
  assert.equal(updateBody.credentials.access_token, 'new-token');
  assert.equal(updateBody.credentials.refresh_token, 'new-refresh-token');
  assert.equal(updateBody.credentials.auth_mode, 'oauth');
  assert.equal(updateBody.extra.reauth_mode, 'oauth');
  assert.equal(updateBody.status, 'active');
  assert.deepEqual(updateBody.group_ids, [26]);
  assert.equal(calls.some((call) => call.path.endsWith('/clear-error')), true);
  assert.equal(calls.some((call) => call.path.endsWith('/schedulable')), true);
  assert.match(result.status, /已恢复调度/);
});
