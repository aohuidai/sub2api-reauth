import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../sidepanel/sidepanel.js', import.meta.url), 'utf8');

function extractFunction(name, { async = false } = {}) {
  const marker = `${async ? 'async ' : ''}function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing function ${name}`);

  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated function ${name}`);
}

function extractAsyncFunction(name) {
  return extractFunction(name, { async: true });
}

test('side panel persists and restores both connection and OpenAI passwords', async () => {
  const fields = Object.fromEntries([
    'baseUrl',
    'email',
    'password',
    'groupName',
  ].map((name) => [name, { value: '' }]));
  Object.assign(fields, {
    baseUrl: { value: 'https://sub2api.example.com/admin/accounts' },
    email: { value: 'admin@example.com' },
    password: { value: 'sub2api-password' },
    groupName: { value: 'codex error' },
  });
  const form = {
    elements: {
      namedItem(name) {
        return fields[name] || null;
      },
    },
  };
  const loginEmailInput = { value: 'openai@example.com' };
  const loginPasswordInput = { value: 'openai-password' };
  const writes = [];
  const saved = {
    baseUrl: 'https://saved.example.com',
    email: 'saved-admin@example.com',
    password: 'saved-sub2api-password',
    groupName: 'saved group',
    loginEmail: 'saved-openai@example.com',
    loginPassword: 'saved-openai-password',
  };
  const chrome = {
    storage: {
      local: {
        async get() {
          return saved;
        },
        async set(value) {
          writes.push(value);
        },
      },
    },
  };
  const savedConnectionFieldNames = ['baseUrl', 'email', 'password', 'groupName'];
  const savedLearningFieldNames = ['loginEmail', 'loginPassword'];
  const api = new Function(
    'form',
    'chrome',
    'loginEmailInput',
    'loginPasswordInput',
    'savedConnectionFieldNames',
    'savedLearningFieldNames',
    `
      ${extractAsyncFunction('restoreSettings')}
      ${extractFunction('getConnection')}
      ${extractAsyncFunction('saveConnectionFields')}
      ${extractAsyncFunction('saveLearningFields')}
      return { restoreSettings, saveConnectionFields, saveLearningFields };
    `
  )(
    form,
    chrome,
    loginEmailInput,
    loginPasswordInput,
    savedConnectionFieldNames,
    savedLearningFieldNames
  );

  await api.saveConnectionFields();
  await api.saveLearningFields();
  assert.deepEqual(writes, [
    {
      baseUrl: 'https://sub2api.example.com/admin/accounts',
      email: 'admin@example.com',
      password: 'sub2api-password',
      groupName: 'codex error',
    },
    {
      loginEmail: 'openai@example.com',
      loginPassword: 'openai-password',
    },
  ]);

  fields.password.value = '';
  loginPasswordInput.value = '';
  await api.restoreSettings();
  assert.equal(fields.password.value, 'saved-sub2api-password');
  assert.equal(loginEmailInput.value, 'saved-openai@example.com');
  assert.equal(loginPasswordInput.value, 'saved-openai-password');
});

test('side panel keeps the connection values when full demo disables the form controls', async () => {
  const fields = {
    baseUrl: { value: 'https://sub2api.example.com/admin/accounts', disabled: true },
    email: { value: 'admin@example.com', disabled: true },
    password: { value: 'sub2api-password', disabled: true },
    groupName: { value: 'codex error', disabled: true },
  };
  const writes = [];
  const api = new Function(
    'form',
    'chrome',
    `
      ${extractFunction('getConnection')}
      ${extractAsyncFunction('saveConnectionFields')}
      return { getConnection, saveConnectionFields };
    `
  )({
    elements: {
      namedItem(name) {
        return fields[name] || null;
      },
    },
  }, {
    storage: {
      local: {
        async set(value) {
          writes.push(value);
        },
      },
    },
  });

  assert.deepEqual(api.getConnection(), {
    baseUrl: 'https://sub2api.example.com/admin/accounts',
    email: 'admin@example.com',
    password: 'sub2api-password',
    groupName: 'codex error',
  });
  await api.saveConnectionFields();
  assert.deepEqual(writes, [{
    baseUrl: 'https://sub2api.example.com/admin/accounts',
    email: 'admin@example.com',
    password: 'sub2api-password',
    groupName: 'codex error',
  }]);
});

test('side panel explains a missing background response instead of showing a generic error', async () => {
  const api = new Function(
    'chrome',
    `
      ${extractAsyncFunction('sendLearningMessage')}
      return { sendLearningMessage };
    `
  )({
    runtime: {
      sendMessage: async () => undefined,
    },
  });

  await assert.rejects(
    api.sendLearningMessage({ type: 'FETCH_QQ_OPENAI_LOGIN_CODE' }),
    /扩展后台没有返回。请在 chrome:\/\/extensions 重新加载 “sub2api reoauth” 后重试。/
  );
});

test('side panel restores a temporary QQ verification code after it is reconstructed', async () => {
  const verificationCodeInput = { value: '' };
  const QQ_VERIFICATION_CODE_STORAGE_KEY = 'openAiLearningVerificationCode';
  const api = new Function(
    'chrome',
    'verificationCodeInput',
    'QQ_VERIFICATION_CODE_STORAGE_KEY',
    `
      let verificationCodeRestoreGeneration = 0;
      ${extractAsyncFunction('restoreVerificationCode')}
      return { restoreVerificationCode };
    `
  )({
    storage: {
      session: {
        async get() {
          return { [QQ_VERIFICATION_CODE_STORAGE_KEY]: '111111' };
        },
      },
    },
  }, verificationCodeInput, QQ_VERIFICATION_CODE_STORAGE_KEY);

  await api.restoreVerificationCode();
  assert.equal(verificationCodeInput.value, '111111');
});

test('side panel restores a temporary QQ verification code without reviving a cleared value', async () => {
  const verificationCodeInput = { value: '' };
  const QQ_VERIFICATION_CODE_STORAGE_KEY = 'openAiLearningVerificationCode';
  let resolveRead;
  const removed = [];
  const chrome = {
    storage: {
      session: {
        get() {
          return new Promise((resolve) => {
            resolveRead = resolve;
          });
        },
        async remove(key) {
          removed.push(key);
        },
      },
    },
  };
  const api = new Function(
    'chrome',
    'verificationCodeInput',
    'QQ_VERIFICATION_CODE_STORAGE_KEY',
    `
      let verificationCodeRestoreGeneration = 0;
      ${extractAsyncFunction('restoreVerificationCode')}
      ${extractAsyncFunction('clearVerificationCode')}
      return { restoreVerificationCode, clearVerificationCode };
    `
  )(chrome, verificationCodeInput, QQ_VERIFICATION_CODE_STORAGE_KEY);

  const pendingRestore = api.restoreVerificationCode();
  await Promise.resolve();
  await api.clearVerificationCode();
  resolveRead({ [QQ_VERIFICATION_CODE_STORAGE_KEY]: '111111' });
  await pendingRestore;

  assert.equal(verificationCodeInput.value, '');
  assert.deepEqual(removed, [QQ_VERIFICATION_CODE_STORAGE_KEY]);
});

test('full demo validates restored SUB2API settings before requesting site permissions', async () => {
  const statuses = [];
  let permissionRequested = false;
  let queryRequested = false;
  const api = new Function(
    'setFullDemoBusy',
    'setLearningStatus',
    'ensureFullDemoPermissions',
    'clearVerificationCode',
    'sendLearningMessage',
    'renderCallbackState',
    'latestQuery',
    'queryReauthAccounts',
    'runFullDemoStep',
    'getVerificationCode',
    'waitForFullDemoCallback',
    'console',
    `
      ${extractAsyncFunction('runFullDemo')}
      return { runFullDemo };
    `
  )(
    () => {},
    (message, kind) => statuses.push({ message, kind }),
    async () => {
      permissionRequested = true;
      throw new Error('完整演示尚未开始：请先填写 SUB2API 地址。');
    },
    async () => {},
    async () => ({}),
    () => {},
    null,
    async () => { queryRequested = true; },
    async () => { throw new Error('steps should not run'); },
    () => '',
    async () => { throw new Error('callback should not be read'); },
    { error() {} }
  );

  await api.runFullDemo();

  assert.equal(permissionRequested, true);
  assert.equal(queryRequested, false);
  assert.match(statuses.at(-1).message, /请先填写 SUB2API 地址/);
  assert.equal(statuses.at(-1).kind, 'error');
});

test('full demo permission setup waits for saved settings before reading the connection fields', async () => {
  let resolveSettings;
  const settingsRestorePromise = new Promise((resolve) => {
    resolveSettings = resolve;
  });
  let connection = { baseUrl: '' };
  const containsCalls = [];
  const requestedOrigins = [];
  const api = new Function(
    'settingsRestorePromise',
    'validateFullDemoConnection',
    'getPermissionPattern',
    'openAiLearningOrigins',
    'qqMailOrigins',
    'chrome',
    `
      ${extractAsyncFunction('ensureFullDemoPermissions')}
      return { ensureFullDemoPermissions };
    `
  )(
    settingsRestorePromise,
    () => connection,
    (baseUrl) => `https://${new URL(baseUrl).hostname}/*`,
    ['https://*.openai.com/*'],
    ['https://mail.qq.com/*'],
    {
      permissions: {
        async contains(details) {
          containsCalls.push(details);
          return false;
        },
        async request(details) {
          requestedOrigins.push(details.origins);
          return true;
        },
      },
    }
  );

  const pending = api.ensureFullDemoPermissions();
  await Promise.resolve();
  assert.equal(containsCalls.length, 0);

  connection = { baseUrl: 'https://sub2api.example.com/admin/accounts' };
  resolveSettings();
  const result = await pending;

  assert.equal(result, connection);
  assert.deepEqual(containsCalls, [{
    origins: [
      'https://sub2api.example.com/*',
      'https://*.openai.com/*',
      'https://mail.qq.com/*',
    ],
  }]);
  assert.deepEqual(requestedOrigins, [[
    'https://sub2api.example.com/*',
    'https://*.openai.com/*',
    'https://mail.qq.com/*',
  ]]);
});

test('full demo runs the existing learning actions in order and pushes the callback result last', async () => {
  const steps = [];
  const statuses = [];
  const api = new Function(
    'setFullDemoBusy',
    'setLearningStatus',
    'ensureFullDemoPermissions',
    'clearVerificationCode',
    'sendLearningMessage',
    'renderCallbackState',
    'latestQuery',
    'queryReauthAccounts',
    'runFullDemoStep',
    'getVerificationCode',
    'waitForFullDemoCallback',
    'console',
    `
      ${extractAsyncFunction('runFullDemo')}
      return { runFullDemo };
    `
  )(
    () => {},
    (message, kind) => statuses.push({ message, kind }),
    async () => {},
    async () => {},
    async () => ({}),
    () => {},
    { accounts: [{ id: 10 }] },
    async () => { throw new Error('query should not run'); },
    async (step, action) => {
      steps.push([step, action]);
      if (action === 'continue-after-password') return { baseline: { available: true } };
      if (action === 'fetch-qq-code') return { code: '111111' };
      return {};
    },
    () => '111111',
    async () => ({ callbackUrl: 'http://localhost:1455/auth/callback?code=test' }),
    { error() {} }
  );

  await api.runFullDemo();

  assert.deepEqual(steps, [
    [0, 'open-first-reauth'],
    [1, 'fill-email'],
    [2, 'continue-after-email'],
    [3, 'fill-password'],
    [4, 'continue-after-password'],
    [5, 'fetch-qq-code'],
    [6, 'fill-code'],
    [7, 'submit-code'],
    [8, 'oauth-continue'],
    [10, 'push-callback'],
  ]);
  assert.match(statuses.at(-1).message, /完整演示已完成/);
});

test('full demo stops after the QQ code step when no fresh code is available', async () => {
  const steps = [];
  const statuses = [];
  const api = new Function(
    'setFullDemoBusy',
    'setLearningStatus',
    'ensureFullDemoPermissions',
    'clearVerificationCode',
    'sendLearningMessage',
    'renderCallbackState',
    'latestQuery',
    'queryReauthAccounts',
    'runFullDemoStep',
    'getVerificationCode',
    'waitForFullDemoCallback',
    'console',
    `
      ${extractAsyncFunction('runFullDemo')}
      return { runFullDemo };
    `
  )(
    () => {},
    (message, kind) => statuses.push({ message, kind }),
    async () => {},
    async () => {},
    async () => ({}),
    () => {},
    { accounts: [{ id: 10 }] },
    async () => { throw new Error('query should not run'); },
    async (step, action) => {
      steps.push([step, action]);
      if (action === 'continue-after-password') return { baseline: { available: true } };
      if (action === 'fetch-qq-code') return { needsFreshCode: true };
      return {};
    },
    () => '',
    async () => { throw new Error('callback should not be read'); },
    { error() {} }
  );

  await api.runFullDemo();

  assert.deepEqual(steps.at(-1), [5, 'fetch-qq-code']);
  assert.match(statuses.at(-1).message, /停在第 5 步/);
  assert.equal(statuses.at(-1).kind, 'error');
});
