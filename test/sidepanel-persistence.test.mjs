import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../sidepanel/sidepanel.js', import.meta.url), 'utf8');

function extractFunction(name, { async = false } = {}) {
  const marker = `${async ? 'async ' : ''}function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing function ${name}`);

  const signatureEnd = source.indexOf(') {', start);
  if (signatureEnd < 0) throw new Error(`Missing function body for ${name}`);
  const bodyStart = source.indexOf('{', signatureEnd);
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
  const mailWaitSecondsInput = { value: '60' };
  const writes = [];
  const saved = {
    baseUrl: 'https://saved.example.com',
    email: 'saved-admin@example.com',
    password: 'saved-sub2api-password',
    groupName: 'saved group',
    loginEmail: 'saved-openai@example.com',
    loginPassword: 'saved-openai-password',
    mailWaitSeconds: '90',
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
    'mailWaitSecondsInput',
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
    mailWaitSecondsInput,
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
      mailWaitSeconds: '60',
    },
  ]);

  fields.password.value = '';
  loginPasswordInput.value = '';
  await api.restoreSettings();
  assert.equal(fields.password.value, 'saved-sub2api-password');
  assert.equal(loginEmailInput.value, 'saved-openai@example.com');
  assert.equal(loginPasswordInput.value, 'saved-openai-password');
  assert.equal(mailWaitSecondsInput.value, '90');
});

test('side panel validates and forwards the configured QQ mailbox wait time', async () => {
  const verificationCodeInput = { value: '', focus() {} };
  const mailWaitSecondsInput = { value: '75', focus() {} };
  const sent = [];
  const statuses = [];
  const api = new Function(
    'clearVerificationCode',
    'ensureQqMailPermission',
    'getMailboxWaitSeconds',
    'setLearningStatus',
    'sendLearningMessage',
    'verificationCodeInput',
    'saveVerificationCode',
    `
      ${extractAsyncFunction('fetchQqOpenAiLoginCode')}
      return { fetchQqOpenAiLoginCode };
    `
  )(
    async () => {},
    async () => {},
    () => Number(mailWaitSecondsInput.value),
    (message, kind) => statuses.push({ message, kind }),
    async (message) => {
      sent.push(message);
      return { code: '123456' };
    },
    verificationCodeInput,
    async () => {}
  );

  const result = await api.fetchQqOpenAiLoginCode({ runId: 'demo-1' });

  assert.equal(result.code, '123456');
  assert.deepEqual(sent, [{
    type: 'FETCH_QQ_OPENAI_LOGIN_CODE',
    runId: 'demo-1',
    mailWaitSeconds: 75,
  }]);
  assert.match(statuses[0].message, /最长 75 秒/);
});

test('side panel rejects an invalid QQ mailbox wait time', () => {
  const mailWaitSecondsInput = {
    value: '0',
    focused: false,
    focus() { this.focused = true; },
  };
  const api = new Function(
    'mailWaitSecondsInput',
    `
      ${extractFunction('getMailboxWaitSeconds')}
      return { getMailboxWaitSeconds };
    `
  )(mailWaitSecondsInput);

  assert.throws(() => api.getMailboxWaitSeconds(), /1 到 600/);
  assert.equal(mailWaitSecondsInput.focused, true);
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

test('password continue opens QQ Mail first and does not submit the password without a mailbox baseline', async () => {
  const statuses = [];
  let pageStepCalls = 0;
  const api = new Function(
    'captureQqMailBaseline',
    'runPageLearningStep',
    'setLearningStatus',
    'formatActionResult',
    `
      ${extractAsyncFunction('handleLearningAction')}
      return { handleLearningAction };
    `
  )(
    async () => ({ available: false, needsLogin: true, openedMailTab: true }),
    async () => { pageStepCalls += 1; return {}; },
    (message, kind) => statuses.push({ message, kind }),
    (_result, fallback) => fallback
  );

  const result = await api.handleLearningAction('continue-after-password');

  assert.deepEqual(result, {
    baseline: { available: false, needsLogin: true, openedMailTab: true },
  });
  assert.equal(pageStepCalls, 0);
  assert.deepEqual(statuses, [{
    message: '已自动打开 QQ 邮箱，请完成登录并进入收件箱后重新点击第 4 步。',
    kind: 'pending',
  }]);
});

test('email continue waits for the password page before it reports step 2 complete', async () => {
  const events = [];
  const statuses = [];
  let resolvePasswordPage;
  const passwordPage = new Promise((resolve) => {
    resolvePasswordPage = resolve;
  });
  const api = new Function(
    'runPageLearningStep',
    'waitForOpenAiPasswordPage',
    'setLearningStatus',
    `
      ${extractAsyncFunction('handleLearningAction')}
      return { handleLearningAction };
    `
  )(
    async (...args) => {
      events.push({ type: 'click', args });
      return { action: 'login-continue-clicked' };
    },
    async (...args) => {
      events.push({ type: 'wait', args });
      return passwordPage;
    },
    (message, kind) => statuses.push({ message, kind })
  );

  const pending = api.handleLearningAction('continue-after-email', {
    useOpenAiAuthTab: true,
    runId: 'demo-password-page',
  });
  await Promise.resolve();

  assert.deepEqual(events, [
    {
      type: 'click',
      args: ['continue-after-email', {}, { useOpenAiAuthTab: true, runId: 'demo-password-page' }],
    },
    {
      type: 'wait',
      args: [{ runId: 'demo-password-page' }],
    },
  ]);
  assert.deepEqual(statuses, [{
    message: '已点击邮箱页的继续按钮，正在等待密码页加载…',
    kind: 'pending',
  }]);

  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  resolvePasswordPage({ ready: true, url: 'https://auth.openai.com/log-in' });
  const result = await pending;

  assert.equal(result.passwordPage.ready, true);
  assert.deepEqual(statuses.at(-1), {
    message: '已进入密码页，可以填写密码。',
    kind: 'success',
  });
});

test('OAuth continue retries instead of entering callback wait when its click has no effect', async () => {
  const statuses = [];
  const pageCalls = [];
  const api = new Function(
    'armCallbackCapture',
    'runPageLearningStep',
    'waitForOpenAiOauthProgress',
    'setLearningStatus',
    'formatActionResult',
    `
      ${extractAsyncFunction('handleLearningAction')}
      return { handleLearningAction };
    `
  )(
    async () => ({}),
    async (...args) => {
      pageCalls.push(args);
      return { url: 'https://auth.openai.com/consent' };
    },
    async () => ({ progressed: false }),
    (message, kind) => statuses.push({ message, kind }),
    (_result, fallback) => fallback
  );

  await assert.rejects(
    api.handleLearningAction('oauth-continue', { oauthStrategy: 'nativeClick' }),
    /OAuth 授权点击未生效/
  );
  assert.deepEqual(pageCalls, [[
    'oauth-continue',
    { strategy: 'nativeClick' },
    { useOpenAiAuthTab: false, runId: '' },
  ]]);
  assert.deepEqual(statuses, []);
});

test('full demo retries OAuth with a different click strategy before it waits for the callback', async () => {
  const calls = [];
  const api = new Function(
    'throwIfFullDemoStopped',
    'setLearningStatus',
    'learningActionLabels',
    'handleLearningAction',
    'waitForFullDemoDelay',
    'isFullDemoStoppedError',
    'isRetryableDemoError',
    'FULL_DEMO_PAGE_RETRY_COUNT',
    'FULL_DEMO_PAGE_RETRY_DELAY_MS',
    'FULL_DEMO_STEP_DELAY_MS',
    'FULL_DEMO_OAUTH_CLICK_STRATEGIES',
    'setFullDemoProgress',
    `
      ${extractAsyncFunction('runFullDemoStep')}
      return { runFullDemoStep };
    `
  )(
    () => {},
    () => {},
    {},
    async (_action, options) => {
      calls.push(options.oauthStrategy);
      if (calls.length < 3) throw new Error('OAuth 授权点击未生效，页面仍停留在授权确认页。');
      return { accepted: true };
    },
    async () => {},
    () => false,
    (error) => /OAuth 授权点击未生效/.test(error.message),
    3,
    0,
    0,
    ['requestSubmit', 'nativeClick', 'dispatchClick'],
    () => {}
  );

  const result = await api.runFullDemoStep(8, 'oauth-continue', { retry: true, runId: 'run-1' });

  assert.deepEqual(calls, ['requestSubmit', 'nativeClick', 'dispatchClick']);
  assert.deepEqual(result, { accepted: true });
});

test('full demo treats an unstable OAuth consent page as retryable', () => {
  const api = new Function(
    `
      ${extractFunction('isRetryableDemoError')}
      return { isRetryableDemoError };
    `
  )();

  assert.equal(api.isRetryableDemoError(new Error('OAuth 授权确认页尚未稳定，暂时不能点击“继续”。')), true);
  assert.equal(api.isRetryableDemoError(new Error('OAuth 授权页的“继续”按钮没有可点击尺寸。')), true);
  assert.equal(api.isRetryableDemoError(new Error('邮箱页的继续已点击，但密码页尚未出现。')), true);
});

test('full demo progress displays the current mailbox and settled counts', () => {
  const panel = { hidden: true };
  const count = { textContent: '' };
  const phase = { textContent: '' };
  const completed = { textContent: '' };
  const skipped = { textContent: '' };
  const attributes = {};
  const track = {
    setAttribute(name, value) {
      attributes[name] = value;
    },
  };
  const bar = { style: {} };
  const api = new Function(
    'fullDemoProgressPanel',
    'fullDemoProgressCount',
    'fullDemoProgressTrack',
    'fullDemoProgressBar',
    'fullDemoProgressPhase',
    'fullDemoProgressCompleted',
    'fullDemoProgressSkipped',
    `
      let fullDemoProgressState = {
        total: 0,
        current: 0,
        completed: 0,
        skipped: 0,
        phase: '等待开始',
      };
      ${extractFunction('renderFullDemoProgress')}
      ${extractFunction('resetFullDemoProgress')}
      ${extractFunction('setFullDemoProgress')}
      return { resetFullDemoProgress, setFullDemoProgress };
    `
  )(panel, count, track, bar, phase, completed, skipped);

  api.resetFullDemoProgress(5);
  api.setFullDemoProgress({
    current: 3,
    completed: 1,
    skipped: 1,
    phase: '第 5 步未获取到验证码，已跳过邮箱 #12',
  });

  assert.equal(panel.hidden, false);
  assert.equal(count.textContent, '3 / 5');
  assert.equal(phase.textContent, '第 5 步未获取到验证码，已跳过邮箱 #12');
  assert.equal(completed.textContent, '1');
  assert.equal(skipped.textContent, '1');
  assert.equal(attributes['aria-valuemax'], '5');
  assert.equal(attributes['aria-valuenow'], '2');
  assert.equal(bar.style.width, '40%');
});

function createFullDemoHarness({
  accounts = [{ id: 10, email: 'first@example.com' }],
  rounds = 1,
  callbackUrl = 'http://localhost:1455/auth/callback?code=test&state=state',
  onAction = async (action) => {
    if (action === 'continue-after-password') return { baseline: { available: true } };
    if (action === 'fetch-qq-code') return { code: '111111' };
    return {};
  },
  ensureFullDemoPermissions = async () => {},
} = {}) {
  const actions = [];
  const messages = [];
  const statuses = [];
  const busyStates = [];
  const progressUpdates = [];
  const closedRounds = [];
  const demoRoundsInput = {
    value: String(rounds),
    focus() {},
  };
  const verificationCodeInput = { value: '' };
  const stopFullDemoButton = { disabled: false, hidden: true };
  const api = new Function(
    'setLearningStatus',
    'ensureFullDemoPermissions',
    'clearVerificationCode',
    'sendLearningMessage',
    'renderCallbackState',
    'latestQuery',
    'queryReauthAccounts',
    'handleLearningAction',
    'getVerificationCode',
    'waitForOpenAiOauthProgress',
    'console',
    'demoRoundsInput',
    'verificationCodeInput',
    'stopFullDemoButton',
    'form',
    'setLearningBusy',
    'setBusy',
    'resetFullDemoProgress',
    'setFullDemoProgress',
    'closeFullDemoRound',
    `
      const FULL_DEMO_PAGE_RETRY_COUNT = 2;
      const FULL_DEMO_PAGE_RETRY_DELAY_MS = 0;
      const FULL_DEMO_CALLBACK_TIMEOUT_MS = 100;
      const FULL_DEMO_STEP_DELAY_MS = 0;
      const FULL_DEMO_OAUTH_CONSENT_SETTLE_MS = 0;
      const FULL_DEMO_OAUTH_CLICK_STRATEGIES = ['requestSubmit', 'nativeClick', 'dispatchClick'];
      const FULL_DEMO_STOPPED_ERROR = '完整演示已停止。';
      const learningActionLabels = {};
      let fullDemoRunning = false;
      let fullDemoRunId = '';
      let fullDemoStopRequested = false;
      let fullDemoDelayWake = null;
      ${extractFunction('createFullDemoRunId')}
      ${extractFunction('getDemoRounds')}
      ${extractFunction('isCurrentFullDemoRun')}
      ${extractFunction('throwIfFullDemoStopped')}
      ${extractFunction('waitForFullDemoDelay')}
      ${extractFunction('isFullDemoStoppedError')}
      ${extractFunction('isRetryableDemoError')}
      ${extractFunction('isMissingVerificationCodeError')}
      ${extractAsyncFunction('runFullDemoStep')}
      ${extractAsyncFunction('waitForFullDemoCallback')}
      ${extractFunction('setFullDemoBusy')}
      ${extractAsyncFunction('runFullDemoForAccount')}
      ${extractAsyncFunction('runFullDemo')}
      ${extractAsyncFunction('stopFullDemo')}
      function armForStop(runId) {
        fullDemoRunning = true;
        fullDemoRunId = runId;
        fullDemoStopRequested = false;
      }
      return {
        runFullDemo,
        runFullDemoStep,
        stopFullDemo,
        waitForFullDemoDelay,
        armForStop,
        snapshot: () => ({ fullDemoRunning, fullDemoRunId, fullDemoStopRequested }),
      };
    `
  )(
    (message, kind) => statuses.push({ message, kind }),
    ensureFullDemoPermissions,
    async () => { verificationCodeInput.value = ''; },
    async (message) => {
      messages.push(message);
      if (message.type === 'GET_OPENAI_CALLBACK_CAPTURE') return { callbackUrl };
      return {};
    },
    () => {},
    { accounts },
    async () => { throw new Error('query should not run'); },
    async (action, options) => {
      actions.push({ action, options });
      return onAction(action, options);
    },
    () => '111111',
    async () => ({ progressed: true }),
    { error() {}, warn() {} },
    demoRoundsInput,
    verificationCodeInput,
    stopFullDemoButton,
    { querySelectorAll() { return []; } },
    (isBusy) => busyStates.push(isBusy),
    () => {},
    (total = 0) => progressUpdates.push({ type: 'reset', total }),
    (update = {}) => progressUpdates.push({ type: 'update', ...update }),
    async (runId) => closedRounds.push(runId)
  );

  return {
    actions,
    api,
    busyStates,
    closedRounds,
    messages,
    progressUpdates,
    statuses,
    stopFullDemoButton,
  };
}

test('full demo validates restored SUB2API settings before requesting site permissions', async () => {
  let permissionRequested = false;
  const harness = createFullDemoHarness({
    ensureFullDemoPermissions: async () => {
      permissionRequested = true;
      throw new Error('完整演示尚未开始：请先填写 SUB2API 地址。');
    },
  });

  await harness.api.runFullDemo();

  assert.equal(permissionRequested, true);
  assert.equal(harness.actions.length, 0);
  assert.match(harness.statuses.at(-1).message, /请先填写 SUB2API 地址/);
  assert.equal(harness.statuses.at(-1).kind, 'error');
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

test('full demo processes the requested number of accounts from the start', async () => {
  const accounts = [
    { id: 10, email: 'one@example.com' },
    { id: 11, email: 'two@example.com' },
    { id: 12, email: 'three@example.com' },
  ];
  const harness = createFullDemoHarness({ accounts, rounds: 3 });

  await harness.api.runFullDemo();

  const expectedActions = [
    'open-first-reauth',
    'fill-email',
    'continue-after-email',
    'fill-password',
    'continue-after-password',
    'fetch-qq-code',
    'fill-code',
    'submit-code',
    'oauth-continue',
    'push-callback',
  ];
  assert.deepEqual(
    accounts.map((account) => harness.actions
      .filter((entry) => entry.options.account.id === account.id)
      .map((entry) => entry.action)),
    [expectedActions, expectedActions, expectedActions]
  );
  assert.match(harness.statuses.at(-1).message, /已重授权 3 个账号/);
  assert.equal(harness.closedRounds.length, 3);
  assert.equal(new Set(harness.closedRounds).size, 1);
});

test('full demo skips a mailbox with no fresh code and continues to the next mailbox', async () => {
  const accounts = [
    { id: 10, email: 'no-code@example.com' },
    { id: 11, email: 'has-code@example.com' },
  ];
  const harness = createFullDemoHarness({
    accounts,
    rounds: 2,
    onAction: async (action, { account }) => {
      if (action === 'continue-after-password') return { baseline: { available: true } };
      if (action === 'fetch-qq-code' && account.id === 10) return { needsFreshCode: true };
      if (action === 'fetch-qq-code') return { code: '111111' };
      return {};
    },
  });

  await harness.api.runFullDemo();

  assert.deepEqual(
    harness.actions
      .filter((entry) => entry.options.account.id === 10)
      .map((entry) => entry.action),
    [
      'open-first-reauth',
      'fill-email',
      'continue-after-email',
      'fill-password',
      'continue-after-password',
      'fetch-qq-code',
    ]
  );
  assert.equal(
    harness.actions
      .filter((entry) => entry.options.account.id === 11)
      .at(-1)
      .action,
    'push-callback'
  );
  assert.match(harness.statuses.at(-1).message, /已重授权 1 个账号，因未获取验证码跳过 1 个账号/);
  assert.equal(harness.statuses.at(-1).kind, 'pending');
  assert.deepEqual(harness.progressUpdates.at(-1), {
    type: 'update',
    current: 2,
    completed: 1,
    skipped: 1,
    phase: '本轮演示完成',
  });
  assert.equal(harness.closedRounds.length, 2);
});

test('full demo stops at step 4 after it opens an unsigned-in QQ mailbox', async () => {
  const harness = createFullDemoHarness({
    onAction: async (action) => {
      if (action === 'continue-after-password') {
        return { baseline: { available: false, needsLogin: true, openedMailTab: true } };
      }
      return {};
    },
  });

  await harness.api.runFullDemo();

  assert.equal(harness.actions.at(-1).action, 'continue-after-password');
  assert.match(harness.statuses.at(-1).message, /已自动打开 QQ 邮箱/);
  assert.equal(harness.statuses.at(-1).kind, 'error');
});

test('full demo adds a one-second delay after a completed learning step', async () => {
  const delays = [];
  const api = new Function(
    'throwIfFullDemoStopped',
    'setLearningStatus',
    'learningActionLabels',
    'handleLearningAction',
    'waitForFullDemoDelay',
    'isFullDemoStoppedError',
    'isRetryableDemoError',
    'FULL_DEMO_PAGE_RETRY_COUNT',
    'FULL_DEMO_PAGE_RETRY_DELAY_MS',
    'FULL_DEMO_STEP_DELAY_MS',
    'setFullDemoProgress',
    `
      ${extractAsyncFunction('runFullDemoStep')}
      return { runFullDemoStep };
    `
  )(
    () => {},
    () => {},
    {},
    async () => ({}),
    async (ms) => { delays.push(ms); },
    () => false,
    () => false,
    2,
    900,
    1_000,
    () => {}
  );

  await api.runFullDemoStep(1, 'fill-email', { runId: 'run-1' });

  assert.deepEqual(delays, [1_000]);
});

test('stop control cancels the active run and wakes its pending delay', async () => {
  const harness = createFullDemoHarness();
  harness.api.armForStop('run-stop');
  const pendingDelay = harness.api.waitForFullDemoDelay(10_000, 'run-stop');
  await harness.api.stopFullDemo();

  await assert.rejects(pendingDelay, /完整演示已停止/);
  assert.deepEqual(harness.messages.at(-1), {
    type: 'CANCEL_OPENAI_LEARNING_RUN',
    runId: 'run-stop',
  });
  assert.equal(harness.stopFullDemoButton.disabled, true);
});
