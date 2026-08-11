import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8');

function extractAsyncFunction(name) {
  const marker = `async function ${name}(`;
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

class FormDataMock {
  constructor(form) {
    this.values = form.values;
  }

  get(name) {
    return this.values[name];
  }
}

test('popup persists and restores both connection and OpenAI passwords', async () => {
  const fields = Object.fromEntries([
    'baseUrl',
    'email',
    'password',
    'groupName',
  ].map((name) => [name, { value: '' }]));
  const form = {
    values: {
      baseUrl: 'https://sub2api.example.com/admin/accounts',
      email: 'admin@example.com',
      password: 'sub2api-password',
      groupName: 'codex error',
    },
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
    'FormData',
    'savedConnectionFieldNames',
    'savedLearningFieldNames',
    `
      ${extractAsyncFunction('restoreSettings')}
      ${extractAsyncFunction('saveConnectionFields')}
      ${extractAsyncFunction('saveLearningFields')}
      return { restoreSettings, saveConnectionFields, saveLearningFields };
    `
  )(
    form,
    chrome,
    loginEmailInput,
    loginPasswordInput,
    FormDataMock,
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

test('popup explains a missing background response instead of showing a generic error', async () => {
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

test('popup restores a temporary QQ verification code after it is reconstructed', async () => {
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

test('popup restores a temporary QQ verification code without reviving a cleared value', async () => {
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

test('popup restores the latest query after it is reopened', async () => {
  const POPUP_QUERY_STORAGE_KEY = 'sub2apiReauthPopupLatestQuery';
  const savedQuery = {
    connection: { baseUrl: 'https://sub2api.example.com', email: 'admin@example.com', password: 'stored' },
    accounts: [{ id: 10, email: 'target@example.com' }],
    summary: 'codex 错误 · error',
  };
  const rendered = [];
  const api = new Function(
    'chrome',
    'POPUP_QUERY_STORAGE_KEY',
    'renderLatestQuery',
    `
      let latestQuery = null;
      ${extractAsyncFunction('restoreLatestQuery')}
      return { restoreLatestQuery, getLatestQuery: () => latestQuery };
    `
  )({
    storage: {
      session: {
        async get(key) {
          assert.equal(key, POPUP_QUERY_STORAGE_KEY);
          return { [POPUP_QUERY_STORAGE_KEY]: savedQuery };
        },
      },
    },
  }, POPUP_QUERY_STORAGE_KEY, (query) => rendered.push(query));

  await api.restoreLatestQuery();

  assert.equal(api.getLatestQuery().accounts[0].id, 10);
  assert.deepEqual(rendered, [savedQuery]);
});
