const form = document.querySelector('#query-form');
const button = document.querySelector('#query-button');
const resultCount = document.querySelector('#result-count');
const queryState = document.querySelector('#query-state');
const errorState = document.querySelector('#error-state');
const tableWrap = document.querySelector('#results-table-wrap');
const resultsBody = document.querySelector('#results-body');
const savedConnectionFieldNames = ['baseUrl', 'email', 'password', 'groupName'];
const savedLearningFieldNames = ['loginEmail', 'loginPassword', 'mailWaitSeconds'];
const learningButtons = Array.from(document.querySelectorAll('[data-learning-action]'));
const loginEmailInput = document.querySelector('#login-email');
const loginPasswordInput = document.querySelector('#login-password');
const verificationCodeInput = document.querySelector('#verification-code');
const callbackUrl = document.querySelector('#callback-url');
const clearCallbackButton = document.querySelector('#clear-callback');
const learningStatus = document.querySelector('#learning-status');
const preparedAccount = document.querySelector('#prepared-account');
const fullDemoButton = document.querySelector('#run-full-demo');
const stopFullDemoButton = document.querySelector('#stop-full-demo');
const demoRoundsInput = document.querySelector('#demo-rounds');
const mailWaitSecondsInput = document.querySelector('#mail-wait-seconds');
const fullDemoProgressPanel = document.querySelector('#full-demo-progress');
const fullDemoProgressCount = document.querySelector('#full-demo-progress-count');
const fullDemoProgressTrack = document.querySelector('#full-demo-progress-track');
const fullDemoProgressBar = document.querySelector('#full-demo-progress-bar');
const fullDemoProgressPhase = document.querySelector('#full-demo-progress-phase');
const fullDemoProgressCompleted = document.querySelector('#full-demo-progress-completed');
const fullDemoProgressSkipped = document.querySelector('#full-demo-progress-skipped');
const openAiLearningOrigins = [
  'https://*.openai.com/*',
  'https://chatgpt.com/*',
  'http://localhost/*',
  'https://localhost/*',
];
const qqMailOrigins = [
  'https://mail.qq.com/*',
  'https://wx.mail.qq.com/*',
];
const QQ_VERIFICATION_CODE_STORAGE_KEY = 'openAiLearningVerificationCode';
const QQ_MAIL_CODE_STATUS_POLL_INTERVAL_MS = 800;
const FULL_DEMO_PAGE_RETRY_COUNT = 12;
const FULL_DEMO_PAGE_RETRY_DELAY_MS = 900;
const FULL_DEMO_CALLBACK_TIMEOUT_MS = 45_000;
const FULL_DEMO_STEP_DELAY_MS = 1_000;
const FULL_DEMO_OAUTH_CONSENT_SETTLE_MS = 2_000;
const FULL_DEMO_OAUTH_CLICK_STRATEGIES = ['requestSubmit', 'nativeClick', 'dispatchClick'];
const FULL_DEMO_STOPPED_ERROR = '完整演示已停止。';
const learningActionLabels = {
  'open-first-reauth': '第 0 步：打开重授权页',
  'fill-email': '第 1 步：填写邮箱',
  'continue-after-email': '第 2 步：继续',
  'fill-password': '第 3 步：填写密码',
  'continue-after-password': '第 4 步：继续',
  'fetch-qq-code': '第 5 步：从 QQ 邮箱获取验证码',
  'fill-code': '第 6 步：填写验证码',
  'submit-code': '第 7 步：继续',
  'oauth-continue': '第 8 步：确认 OAuth 授权',
  'arm-callback': '第 9 步：开始监听回调',
  'push-callback': '第 10 步：推送重授权结果',
};
let latestQuery = null;
let verificationCodeRestoreGeneration = 0;
let fullDemoRunning = false;
let fullDemoRunId = '';
let fullDemoStopRequested = false;
let fullDemoDelayWake = null;
let settingsRestorePromise = Promise.resolve();
let fullDemoProgressState = {
  total: 0,
  current: 0,
  completed: 0,
  skipped: 0,
  phase: '等待开始',
};

function setBusy(isBusy) {
  button.disabled = isBusy || fullDemoRunning;
  button.textContent = isBusy ? '查询中…' : '查询账号';
}

function renderResultCount(count = 0) {
  const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
  resultCount.textContent = `邮箱总数 ${normalizedCount}`;
}

function renderFullDemoProgress() {
  const total = Math.max(0, Math.floor(Number(fullDemoProgressState.total) || 0));
  const current = Math.min(total, Math.max(0, Math.floor(Number(fullDemoProgressState.current) || 0)));
  const completed = Math.min(total, Math.max(0, Math.floor(Number(fullDemoProgressState.completed) || 0)));
  const skipped = Math.min(total - completed, Math.max(0, Math.floor(Number(fullDemoProgressState.skipped) || 0)));
  const settled = Math.min(total, completed + skipped);

  fullDemoProgressPanel.hidden = false;
  fullDemoProgressCount.textContent = `${current} / ${total}`;
  fullDemoProgressPhase.textContent = fullDemoProgressState.phase || '正在准备…';
  fullDemoProgressCompleted.textContent = String(completed);
  fullDemoProgressSkipped.textContent = String(skipped);
  fullDemoProgressTrack.setAttribute('aria-valuemax', String(total));
  fullDemoProgressTrack.setAttribute('aria-valuenow', String(settled));
  fullDemoProgressTrack.setAttribute('aria-valuetext', `已处理 ${settled} / ${total} 个邮箱`);
  fullDemoProgressBar.style.width = total ? `${Math.round((settled / total) * 100)}%` : '0%';
}

function resetFullDemoProgress(total = 0) {
  fullDemoProgressState = {
    total: Math.max(0, Math.floor(Number(total) || 0)),
    current: 0,
    completed: 0,
    skipped: 0,
    phase: '正在准备…',
  };
  renderFullDemoProgress();
}

function setFullDemoProgress(update = {}) {
  fullDemoProgressState = { ...fullDemoProgressState, ...update };
  renderFullDemoProgress();
}

function createCell(value, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = value || '—';
  return cell;
}

function renderAccounts(accounts) {
  resultsBody.replaceChildren();
  for (const account of accounts) {
    const row = document.createElement('tr');
    row.append(
      createCell(String(account.id ?? '—'), 'mono'),
      createCell(account.email || account.name, 'account-name'),
      createCell(account.status, 'status-cell'),
      createCell(account.proxyId ? `#${account.proxyId}` : '未配置', 'mono'),
      createCell(account.errorMessage || '未返回错误详情', 'error-copy')
    );
    resultsBody.append(row);
  }
}

function renderPreparedAccount(account = null) {
  if (!account) {
    preparedAccount.textContent = '请先完成上方分组查询。';
    return;
  }

  const proxyLabel = account.proxyId ? ` · 代理 #${account.proxyId}` : ' · 未配置代理';
  preparedAccount.textContent = `首个候选：#${account.id} · ${account.email || account.name}${proxyLabel}`;
}

function normalizeInputUrl(value = '') {
  const rawValue = String(value || '').trim();
  if (!rawValue) throw new Error('请填写 SUB2API 地址。');
  const parsed = new URL(/^https?:\/\//i.test(rawValue) ? rawValue : `http://${rawValue}`);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('SUB2API 地址必须使用 HTTP 或 HTTPS。');
  }
  return parsed;
}

function getPermissionPattern(baseUrl) {
  const parsed = normalizeInputUrl(baseUrl);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

async function ensureHostPermission(baseUrl) {
  const origin = getPermissionPattern(baseUrl);
  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  if (hasPermission) return;

  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error(`未授予访问 ${origin} 的权限。`);
  }
}

async function restoreSettings() {
  const saved = await chrome.storage.local.get([
    ...savedConnectionFieldNames,
    ...savedLearningFieldNames,
  ]);
  for (const fieldName of savedConnectionFieldNames) {
    const input = form.elements.namedItem(fieldName);
    if (input && Object.hasOwn(saved, fieldName)) input.value = saved[fieldName];
  }
  if (Object.hasOwn(saved, 'loginEmail')) loginEmailInput.value = saved.loginEmail;
  if (Object.hasOwn(saved, 'loginPassword')) loginPasswordInput.value = saved.loginPassword;
  if (Object.hasOwn(saved, 'mailWaitSeconds')) mailWaitSecondsInput.value = saved.mailWaitSeconds;
}

async function restoreVerificationCode() {
  const generation = verificationCodeRestoreGeneration;
  const stored = await chrome.storage.session.get(QQ_VERIFICATION_CODE_STORAGE_KEY);
  if (generation === verificationCodeRestoreGeneration && stored[QQ_VERIFICATION_CODE_STORAGE_KEY]) {
    verificationCodeInput.value = stored[QQ_VERIFICATION_CODE_STORAGE_KEY];
  }
}

async function saveConnectionFields() {
  await chrome.storage.local.set(getConnection());
}

async function saveLearningFields() {
  await chrome.storage.local.set({
    loginEmail: String(loginEmailInput.value || '').trim(),
    loginPassword: String(loginPasswordInput.value || ''),
    mailWaitSeconds: String(mailWaitSecondsInput.value || '').trim(),
  });
}

async function saveVerificationCode() {
  const code = String(verificationCodeInput.value || '').replace(/\s+/g, '');
  if (code) {
    await chrome.storage.session.set({ [QQ_VERIFICATION_CODE_STORAGE_KEY]: code });
    return;
  }
  await chrome.storage.session.remove(QQ_VERIFICATION_CODE_STORAGE_KEY);
}

async function clearVerificationCode() {
  verificationCodeRestoreGeneration += 1;
  verificationCodeInput.value = '';
  await chrome.storage.session.remove(QQ_VERIFICATION_CODE_STORAGE_KEY);
}

function getConnection() {
  return {
    baseUrl: String(form.elements.namedItem('baseUrl')?.value || '').trim(),
    email: String(form.elements.namedItem('email')?.value || '').trim(),
    password: String(form.elements.namedItem('password')?.value || ''),
    groupName: String(form.elements.namedItem('groupName')?.value || '').trim(),
  };
}

async function queryAccounts(event) {
  event.preventDefault();
  await queryReauthAccounts();
}

async function queryReauthAccounts({ throwOnError = false } = {}) {
  const connection = getConnection();

  setBusy(true);
  errorState.hidden = true;
  tableWrap.hidden = true;
  queryState.textContent = '正在查询…';
  latestQuery = null;
  renderResultCount(0);
  renderPreparedAccount();

  try {
    await ensureHostPermission(connection.baseUrl);
    await saveConnectionFields();
    const response = await chrome.runtime.sendMessage({
      type: 'QUERY_REAUTH_CANDIDATES',
      connection,
    });
    if (!response?.ok) {
      throw new Error(response?.error || '查询失败。');
    }

    const accounts = Array.isArray(response.result?.accounts) ? response.result.accounts : [];
    latestQuery = {
      connection,
      accounts,
    };
    renderAccounts(accounts);
    renderPreparedAccount(accounts[0]);
    renderResultCount(accounts.length);
    tableWrap.hidden = accounts.length === 0;
    queryState.textContent = accounts.length
      ? `${response.result.group.name} · ${response.result.statuses.join(' / ')}`
      : '没有匹配的账号';
  } catch (error) {
    latestQuery = null;
    renderPreparedAccount();
    renderResultCount(0);
    errorState.textContent = error.message || '查询失败。';
    errorState.hidden = false;
    queryState.textContent = '查询未完成';
    if (throwOnError) throw error;
    return null;
  } finally {
    setBusy(false);
  }

  return latestQuery;
}

function setLearningStatus(message, kind = 'idle') {
  learningStatus.textContent = message;
  learningStatus.dataset.kind = kind;
}

function setLearningBusy(isBusy) {
  for (const learningButton of learningButtons) {
    learningButton.disabled = isBusy;
  }
  fullDemoButton.disabled = isBusy;
  demoRoundsInput.disabled = isBusy;
  mailWaitSecondsInput.disabled = isBusy;
  stopFullDemoButton.hidden = !isBusy;
  stopFullDemoButton.disabled = !isBusy;
  fullDemoButton.textContent = isBusy ? '完整演示进行中…' : '演示完整流程';
}

async function ensureOpenAiLearningPermission() {
  const hasPermission = await chrome.permissions.contains({ origins: openAiLearningOrigins });
  if (hasPermission) return;

  const granted = await chrome.permissions.request({ origins: openAiLearningOrigins });
  if (!granted) {
    throw new Error('需要 OpenAI 和 localhost 的站点访问权限才能执行学习流程。');
  }
}

async function ensureQqMailPermission() {
  const hasPermission = await chrome.permissions.contains({ origins: qqMailOrigins });
  if (hasPermission) return;

  const granted = await chrome.permissions.request({ origins: qqMailOrigins });
  if (!granted) {
    throw new Error('需要 QQ 邮箱站点访问权限才能读取验证码。');
  }
}

function markInvalidConnectionField(fieldName) {
  const input = form.elements.namedItem(fieldName);
  if (!input) return;
  input.setAttribute('aria-invalid', 'true');
  input.focus();
}

function validateFullDemoConnection(connection = getConnection()) {
  const requiredFields = [
    ['baseUrl', 'SUB2API 地址'],
    ['email', 'SUB2API 账号'],
    ['password', 'SUB2API 密码'],
    ['groupName', '分组'],
  ];
  const missing = requiredFields.find(([fieldName]) => !String(connection[fieldName] || '').trim());
  if (missing) {
    markInvalidConnectionField(missing[0]);
    throw new Error(`完整演示尚未开始：请先填写 ${missing[1]}。`);
  }

  try {
    normalizeInputUrl(connection.baseUrl);
  } catch (error) {
    markInvalidConnectionField('baseUrl');
    throw error;
  }

  return connection;
}

async function ensureFullDemoPermissions() {
  // 侧边栏刚打开时，storage 读取仍可能进行中；完整演示要等恢复完成后再读取表单。
  await settingsRestorePromise;
  const connection = validateFullDemoConnection();
  const origins = [...new Set([
    getPermissionPattern(connection.baseUrl),
    ...openAiLearningOrigins,
    ...qqMailOrigins,
  ])];
  const hasPermission = await chrome.permissions.contains({ origins });
  if (hasPermission) return connection;

  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    throw new Error('完整演示需要 SUB2API、OpenAI、localhost 和 QQ 邮箱的站点访问权限。');
  }
  return connection;
}

async function sendLearningMessage(message, { retryOnChannelClosed = false } = {}) {
  let response;
  let lastError = null;
  const attempts = retryOnChannelClosed ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      response = await chrome.runtime.sendMessage(message);
      break;
    } catch (error) {
      lastError = error;
      const detail = String(error?.message || error || '').trim();
      const channelClosed = /message channel closed|asynchronous response|receiving end does not exist/i.test(detail);
      if (!retryOnChannelClosed || !channelClosed || attempt === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  if (lastError && !response) {
    const detail = String(lastError?.message || lastError || '').trim();
    if (retryOnChannelClosed && /message channel closed|asynchronous response|receiving end does not exist/i.test(detail)) {
      const error = new Error('浏览器切到后台时中断了这次短消息；验证码任务仍会继续。');
      error.code = 'BACKGROUND_CHANNEL_CLOSED';
      throw error;
    }
    const suffix = detail ? `：${detail}` : '';
    throw new Error(`无法连接扩展后台${suffix}。请在 chrome://extensions 重新加载 “sub2api reoauth” 后重试。`);
  }
  if (!response) {
    throw new Error('扩展后台没有返回。请在 chrome://extensions 重新加载 “sub2api reoauth” 后重试。');
  }
  if (!response?.ok) {
    throw new Error(response?.error || '学习步骤未完成。');
  }
  return response.result || {};
}

function getDemoAccount(index = 0) {
  return latestQuery?.accounts?.[index] || null;
}

async function openOpenAiReauthForAccount(account = getDemoAccount(), { runId = '' } = {}) {
  if (!account) {
    throw new Error('请先查询上方分组，取得至少一个待重授权账号。');
  }

  if (runId) throwIfFullDemoStopped(runId);
  await ensureHostPermission(latestQuery.connection.baseUrl);
  if (runId) throwIfFullDemoStopped(runId);
  const result = await sendLearningMessage({
    type: 'OPEN_FIRST_OPENAI_REAUTH',
    connection: latestQuery.connection,
    account,
    runId,
  });
  if (runId) throwIfFullDemoStopped(runId);

  loginEmailInput.value = result.account.email;
  await saveLearningFields();
  renderPreparedAccount(result.account);
  setLearningStatus(`已打开 #${result.account.id} 的重授权页，并带入邮箱 ${result.account.email}。`, 'success');
  return result;
}

async function openFirstOpenAiReauth() {
  return openOpenAiReauthForAccount();
}

function getVerificationCode() {
  return String(verificationCodeInput.value || '').replace(/\s+/g, '');
}

function getMailboxWaitSeconds() {
  const seconds = Number(mailWaitSecondsInput.value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
    mailWaitSecondsInput.focus();
    throw new Error('邮箱等待时长需填写 1 到 600 之间的整数秒。');
  }
  mailWaitSecondsInput.value = String(seconds);
  return seconds;
}

function createQqMailCodeJobId(runId = '') {
  const prefix = runId || 'manual';
  return `${prefix}-qq-code-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isWaitingForQqMailCodeJob(job = {}) {
  return ['waiting', 'checking'].includes(String(job.state || ''));
}

async function waitForQqMailCodeJobDelay(ms, runId = '') {
  if (runId) return waitForFullDemoDelay(ms, runId);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQqMailCodeJob(jobId, { runId = '' } = {}) {
  for (;;) {
    if (runId) throwIfFullDemoStopped(runId);
    let job;
    try {
      job = await sendLearningMessage(
        { type: 'GET_QQ_OPENAI_LOGIN_CODE_STATUS', jobId },
        { retryOnChannelClosed: true }
      );
    } catch (error) {
      if (error?.code !== 'BACKGROUND_CHANNEL_CLOSED') throw error;
      await waitForQqMailCodeJobDelay(QQ_MAIL_CODE_STATUS_POLL_INTERVAL_MS, runId);
      continue;
    }
    if (job.state === 'completed') return job.result || {};
    if (job.state === 'needs-login' || job.state === 'needs-fresh-code') return job.result || {};
    if (job.state === 'timed-out' || job.state === 'failed' || job.state === 'cancelled') {
      throw new Error(job.error || 'QQ 邮箱验证码任务未完成。');
    }
    if (job.state === 'missing') {
      throw new Error('QQ 邮箱验证码任务已丢失，请重新点击第 5 步。');
    }
    if (!isWaitingForQqMailCodeJob(job)) {
      throw new Error('QQ 邮箱验证码任务状态异常，请重新点击第 5 步。');
    }
    await waitForQqMailCodeJobDelay(QQ_MAIL_CODE_STATUS_POLL_INTERVAL_MS, runId);
  }
}

async function fetchQqOpenAiLoginCode({ runId = '' } = {}) {
  await clearVerificationCode();
  await ensureQqMailPermission();
  const mailWaitSeconds = getMailboxWaitSeconds();
  setLearningStatus(`正在从 QQ 邮箱等待验证码，最长 ${mailWaitSeconds} 秒…`, 'pending');
  const jobId = createQqMailCodeJobId(runId);
  try {
    await sendLearningMessage({
      type: 'FETCH_QQ_OPENAI_LOGIN_CODE',
      jobId,
      runId,
      mailWaitSeconds,
    }, { retryOnChannelClosed: true });
  } catch (error) {
    // The worker may have saved the job before Chrome closed this short response.
    if (error?.code !== 'BACKGROUND_CHANNEL_CLOSED') throw error;
  }
  const result = await waitForQqMailCodeJob(jobId, { runId });
  if (result.needsLogin) {
    setLearningStatus('已打开 QQ 邮箱标签页，请完成 QQ 登录后回到 OpenAI 标签再点击此步骤。', 'pending');
    return result;
  }
  if (result.needsFreshCode) {
    setLearningStatus('为避免填入旧验证码，请在 OpenAI 页面重新发送验证码后，再点击此步骤。', 'pending');
    return result;
  }

  verificationCodeInput.value = result.code;
  await saveVerificationCode();
  setLearningStatus(`已从 QQ 邮箱取得 ${result.code.length} 位验证码，并切回 OpenAI 标签。`, 'success');
  return result;
}

async function captureQqMailBaseline({ runId = '' } = {}) {
  try {
    await ensureQqMailPermission();
    return await sendLearningMessage({ type: 'SNAPSHOT_QQ_MAIL_BASELINE', runId });
  } catch (error) {
    return { available: false, error: String(error?.message || 'QQ 邮箱基线获取失败。') };
  }
}

async function pushReauthCallbackToSub2Api({ runId = '' } = {}) {
  const connection = getConnection();
  await ensureHostPermission(connection.baseUrl);
  await saveConnectionFields();
  const result = await sendLearningMessage({
    type: 'SUBMIT_OPENAI_REAUTH_CALLBACK',
    connection,
    runId,
  });
  setLearningStatus(result.status || '已将重授权结果推送到 SUB2API。', 'success');
  return result;
}

async function runPageLearningStep(action, value = {}, { useOpenAiAuthTab = false, runId = '' } = {}) {
  await ensureOpenAiLearningPermission();
  return sendLearningMessage({
    type: 'RUN_OPENAI_LEARNING_STEP',
    action,
    value,
    useOpenAiAuthTab,
    runId,
  });
}

function formatActionResult(result, fallback) {
  if (result?.buttonText) return `${fallback}（${result.buttonText}）`;
  return fallback;
}

function renderCallbackState(state = {}) {
  const url = String(state.callbackUrl || '');
  callbackUrl.value = url;
  clearCallbackButton.hidden = !url && !state.active;

  if (url) {
    setLearningStatus('已捕获 localhost 回调地址。', 'success');
  } else if (state.active) {
    setLearningStatus('正在监听 localhost 回调地址…', 'pending');
  }
}

async function refreshCallbackState() {
  const state = await sendLearningMessage({ type: 'GET_OPENAI_CALLBACK_CAPTURE' });
  renderCallbackState(state);
}

async function armCallbackCapture({ runId = '' } = {}) {
  await ensureOpenAiLearningPermission();
  const state = await sendLearningMessage({ type: 'ARM_OPENAI_CALLBACK_CAPTURE', runId });
  renderCallbackState(state);
  return state;
}

async function waitForOpenAiOauthProgress(expectedUrl, { runId = '' } = {}) {
  return sendLearningMessage({
    type: 'WAIT_FOR_OPENAI_OAUTH_PROGRESS',
    expectedUrl,
    runId,
  });
}

async function waitForOpenAiPasswordPage({ runId = '' } = {}) {
  return sendLearningMessage({ type: 'WAIT_FOR_OPENAI_PASSWORD_PAGE', runId });
}

async function handleLearningAction(action, {
  useOpenAiAuthTab = false,
  account = null,
  runId = '',
  oauthStrategy = '',
} = {}) {
  switch (action) {
    case 'open-first-reauth':
      return openOpenAiReauthForAccount(account || getDemoAccount(), { runId });
    case 'fill-email': {
      await saveLearningFields();
      const result = await runPageLearningStep(action, { email: loginEmailInput.value }, { useOpenAiAuthTab, runId });
      setLearningStatus(formatActionResult(result, '邮箱已填入页面。'), 'success');
      return result;
    }
    case 'continue-after-email': {
      const result = await runPageLearningStep(action, {}, { useOpenAiAuthTab, runId });
      setLearningStatus('已点击邮箱页的继续按钮，正在等待密码页加载…', 'pending');
      const passwordPage = await waitForOpenAiPasswordPage({ runId });
      if (!passwordPage.ready) {
        throw new Error('邮箱页的继续已点击，但密码页尚未出现。');
      }
      setLearningStatus('已进入密码页，可以填写密码。', 'success');
      return { ...result, passwordPage };
    }
    case 'fill-password': {
      await saveLearningFields();
      const result = await runPageLearningStep(action, { password: loginPasswordInput.value }, { useOpenAiAuthTab, runId });
      setLearningStatus(formatActionResult(result, '密码已填入页面。'), 'success');
      return result;
    }
    case 'continue-after-password': {
      const baseline = await captureQqMailBaseline({ runId });
      if (!baseline.available) {
        const fallback = baseline.needsLogin
          ? (baseline.openedMailTab
            ? '已自动打开 QQ 邮箱，请完成登录并进入收件箱后重新点击第 4 步。'
            : 'QQ 邮箱需要登录，请完成登录并进入收件箱后重新点击第 4 步。')
          : (baseline.error || 'QQ 收件箱尚未就绪，请进入收件箱后重新点击第 4 步。');
        setLearningStatus(fallback, baseline.error ? 'error' : 'pending');
        return { baseline };
      }
      const result = await runPageLearningStep(action, {}, { useOpenAiAuthTab, runId });
      setLearningStatus(formatActionResult(result, '已点击密码页的继续按钮。'), 'success');
      return { baseline, result };
    }
    case 'fetch-qq-code':
      return fetchQqOpenAiLoginCode({ runId });
    case 'fill-code': {
      const result = await runPageLearningStep(action, { code: getVerificationCode() }, { useOpenAiAuthTab, runId });
      setLearningStatus(formatActionResult(result, '验证码已填入页面。'), 'success');
      return result;
    }
    case 'submit-code': {
      const result = await runPageLearningStep(action, {}, { useOpenAiAuthTab, runId });
      await clearVerificationCode();
      setLearningStatus(formatActionResult(result, '已提交验证码。'), 'success');
      return result;
    }
    case 'arm-callback':
      return armCallbackCapture({ runId });
    case 'oauth-continue': {
      // 必须先监听再点击，否则极快的本地跳转可能在监听器注册前发生。
      await armCallbackCapture({ runId });
      const result = await runPageLearningStep(
        action,
        { strategy: oauthStrategy || 'requestSubmit' },
        { useOpenAiAuthTab, runId }
      );
      const progress = await waitForOpenAiOauthProgress(result.url, { runId });
      if (!progress.progressed) {
        throw new Error('OAuth 授权点击未生效，页面仍停留在授权确认页。');
      }
      setLearningStatus(formatActionResult(result, '已确认 OAuth 授权，正在等待 localhost 回调。'), 'pending');
      return { ...result, progress };
    }
    case 'push-callback':
      return pushReauthCallbackToSub2Api({ runId });
    default:
      throw new Error('未知的学习步骤。');
  }
}

function createFullDemoRunId() {
  return `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getDemoRounds() {
  const rounds = Number(demoRoundsInput.value);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) {
    demoRoundsInput.focus();
    throw new Error('演示轮数需填写 1 到 50 之间的整数。');
  }
  demoRoundsInput.value = String(rounds);
  return rounds;
}

function isCurrentFullDemoRun(runId = '') {
  return Boolean(fullDemoRunning && runId && runId === fullDemoRunId);
}

function throwIfFullDemoStopped(runId = '') {
  if (!isCurrentFullDemoRun(runId) || fullDemoStopRequested) {
    throw new Error(FULL_DEMO_STOPPED_ERROR);
  }
}

function waitForFullDemoDelay(ms, runId = '') {
  throwIfFullDemoStopped(runId);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fullDemoDelayWake === finish) fullDemoDelayWake = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    fullDemoDelayWake = finish;
  }).then(() => throwIfFullDemoStopped(runId));
}

function isFullDemoStoppedError(error) {
  return String(error?.message || error || '').includes(FULL_DEMO_STOPPED_ERROR);
}

function isRetryableDemoError(error) {
  return /无法连接当前页面|当前页面没有可见|未找到.*(?:输入框|继续|提交|授权)|页面步骤未完成|密码页尚未出现|当前页面不是 OAuth|OAuth 授权(?:点击未生效|确认页尚未稳定|页.*没有可点击尺寸)/i.test(
    String(error?.message || error || '')
  );
}

function isMissingVerificationCodeError(error) {
  const message = String(error?.message || error || '');
  return /(?:等待\s*\d+\s*秒后.*(?:验证码|verification)|(?:未获取到|未找到|未返回|没有).*?(?:验证码|verification)|本次新发.*(?:验证码|verification))/i.test(message);
}

async function runFullDemoStep(step, action, options = {}) {
  const {
    retry = false,
    account = null,
    runId = '',
  } = options;
  const attempts = retry ? FULL_DEMO_PAGE_RETRY_COUNT : 1;
  const label = learningActionLabels[action] || `第 ${step} 步`;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfFullDemoStopped(runId);
    setLearningStatus(
      `完整演示：正在执行第 ${step} 步 ${label}${attempts > 1 ? `（${attempt}/${attempts}）` : ''}…`,
      'pending'
    );
    setFullDemoProgress({ phase: `第 ${step} 步：${label}` });
    try {
      const result = await handleLearningAction(action, {
        useOpenAiAuthTab: step > 0 && step < 9,
        account,
        runId,
        oauthStrategy: action === 'oauth-continue'
          ? FULL_DEMO_OAUTH_CLICK_STRATEGIES[Math.min(attempt - 1, FULL_DEMO_OAUTH_CLICK_STRATEGIES.length - 1)]
          : '',
      });
      await waitForFullDemoDelay(FULL_DEMO_STEP_DELAY_MS, runId);
      return result;
    } catch (error) {
      if (isFullDemoStoppedError(error)) throw error;
      lastError = error;
      if (!retry || !isRetryableDemoError(error) || attempt === attempts) break;
      await waitForFullDemoDelay(FULL_DEMO_PAGE_RETRY_DELAY_MS, runId);
    }
  }

  throw lastError || new Error(`第 ${step} 步未完成。`);
}

async function waitForFullDemoCallback(runId = '', accountOrdinal = 1, accountTotal = 1) {
  const deadline = Date.now() + FULL_DEMO_CALLBACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfFullDemoStopped(runId);
    const state = await sendLearningMessage({ type: 'GET_OPENAI_CALLBACK_CAPTURE' });
    if (state.callbackUrl) {
      renderCallbackState(state);
      return state;
    }
    setLearningStatus(`完整演示：账号 ${accountOrdinal}/${accountTotal} 的第 9 步正在等待 localhost 回调地址…`, 'pending');
    await waitForFullDemoDelay(FULL_DEMO_STEP_DELAY_MS, runId);
  }
  throw new Error('完整演示停在第 9 步：等待 localhost 回调超时。');
}

async function closeFullDemoRound(runId = '') {
  if (!runId) return;
  try {
    await sendLearningMessage({ type: 'CLOSE_OPENAI_LEARNING_ROUND', runId });
  } catch (error) {
    console.warn('[sub2api reauth] 无法关闭本轮自动打开的标签页：', error);
  }
}

function setFullDemoBusy(isBusy, { disableForm = true } = {}) {
  fullDemoRunning = isBusy;
  setLearningBusy(isBusy);
  if (disableForm) {
    for (const element of form.querySelectorAll('input, button')) {
      if (element === stopFullDemoButton) continue;
      element.disabled = isBusy;
    }
  }
  setBusy(false);
}

async function runFullDemoForAccount(account, accountOrdinal, accountTotal, runId) {
  throwIfFullDemoStopped(runId);
  verificationCodeInput.value = '';
  await clearVerificationCode();
  const clearedCallback = await sendLearningMessage({ type: 'CLEAR_OPENAI_CALLBACK_CAPTURE' });
  renderCallbackState(clearedCallback);

  await runFullDemoStep(0, 'open-first-reauth', { account, runId });
  await runFullDemoStep(1, 'fill-email', { retry: true, account, runId });
  await runFullDemoStep(2, 'continue-after-email', { retry: true, account, runId });
  await runFullDemoStep(3, 'fill-password', { retry: true, account, runId });
  const passwordResult = await runFullDemoStep(4, 'continue-after-password', {
    retry: true,
    account,
    runId,
  });
  if (!passwordResult?.baseline?.available) {
    const baseline = passwordResult?.baseline || {};
    if (baseline.needsLogin) {
      const prefix = baseline.openedMailTab ? '已自动打开 QQ 邮箱，' : '';
      throw new Error(`完整演示停在第 4 步：${prefix}请完成登录并进入收件箱后重新开始完整演示。`);
    }
    if (baseline.error) {
      throw new Error(`完整演示停在第 4 步：${baseline.error}`);
    }
    throw new Error('完整演示停在第 4 步：QQ 收件箱未就绪，无法建立本次验证码的邮件快照。');
  }

  const codeResult = await runFullDemoStep(5, 'fetch-qq-code', { account, runId });
  if (codeResult?.needsLogin) {
    throw new Error('完整演示停在第 5 步：请先登录 QQ 邮箱后重新开始。');
  }
  if (codeResult?.needsFreshCode || !getVerificationCode()) {
    return {
      outcome: 'skipped-no-verification-code',
      reason: '未获取到本次验证码。',
    };
  }

  await runFullDemoStep(6, 'fill-code', { retry: true, account, runId });
  await runFullDemoStep(7, 'submit-code', { retry: true, account, runId });
  setLearningStatus(`完整演示：账号 ${accountOrdinal}/${accountTotal} 正在等待 OAuth 授权确认页稳定…`, 'pending');
  await waitForFullDemoDelay(FULL_DEMO_OAUTH_CONSENT_SETTLE_MS, runId);
  await runFullDemoStep(8, 'oauth-continue', { retry: true, account, runId });
  await waitForFullDemoCallback(runId, accountOrdinal, accountTotal);
  await waitForFullDemoDelay(FULL_DEMO_STEP_DELAY_MS, runId);
  await runFullDemoStep(10, 'push-callback', { account, runId });
  return { outcome: 'completed' };
}

async function runFullDemo() {
  // 保持输入框可用，直到前置校验完成；这样缺失字段可以获得焦点并滚动到可见位置。
  setFullDemoBusy(true, { disableForm: false });
  const runId = createFullDemoRunId();
  fullDemoRunId = runId;
  fullDemoStopRequested = false;
  resetFullDemoProgress();
  try {
    setLearningStatus('完整演示：正在恢复已保存的配置并检查前置条件…', 'pending');
    await ensureFullDemoPermissions();
    throwIfFullDemoStopped(runId);
    const rounds = getDemoRounds();
    setFullDemoBusy(true);

    if (!latestQuery) {
      setLearningStatus('完整演示：正在查询待重授权账号…', 'pending');
      await queryReauthAccounts({ throwOnError: true });
    }
    const accounts = Array.isArray(latestQuery?.accounts)
      ? latestQuery.accounts.slice(0, rounds)
      : (latestQuery?.accounts ? [latestQuery.accounts] : []);
    if (!accounts.length) {
      throw new Error('完整演示无法开始：查询结果中没有待重授权账号。');
    }
    resetFullDemoProgress(accounts.length);
    if (accounts.length < rounds) {
      setLearningStatus(`完整演示：只查询到 ${accounts.length} 个待重授权账号，将依次处理。`, 'pending');
      await waitForFullDemoDelay(FULL_DEMO_STEP_DELAY_MS, runId);
    }

    let completed = 0;
    let skipped = 0;
    for (const [index, account] of accounts.entries()) {
      throwIfFullDemoStopped(runId);
      setFullDemoProgress({
        current: index + 1,
        completed,
        skipped,
        phase: `正在处理邮箱 #${account.id}（${account.email || account.name || '未命名'}）`,
      });
      setLearningStatus(`完整演示：开始处理账号 ${index + 1}/${accounts.length}（#${account.id}）。`, 'pending');
      await waitForFullDemoDelay(FULL_DEMO_STEP_DELAY_MS, runId);
      let outcome;
      try {
        outcome = await runFullDemoForAccount(account, index + 1, accounts.length, runId);
      } catch (error) {
        if (!isMissingVerificationCodeError(error)) throw error;
        outcome = { outcome: 'skipped-no-verification-code', reason: String(error.message || error) };
      }

      if (outcome?.outcome === 'skipped-no-verification-code') {
        skipped += 1;
        setFullDemoProgress({
          completed,
          skipped,
          phase: `第 5 步未获取到验证码，已跳过邮箱 #${account.id}`,
        });
        setLearningStatus(`完整演示：账号 ${index + 1}/${accounts.length}（#${account.id}）未获取到验证码，自动继续下一个邮箱。`, 'pending');
      } else {
        completed += 1;
        setFullDemoProgress({
          completed,
          skipped,
          phase: `邮箱 #${account.id} 已完成重授权`,
        });
        setLearningStatus(`完整演示：账号 ${index + 1}/${accounts.length}（#${account.id}）已完成。`, 'success');
      }
      await closeFullDemoRound(runId);
      if (index < accounts.length - 1) {
        await waitForFullDemoDelay(FULL_DEMO_STEP_DELAY_MS, runId);
      }
    }
    setFullDemoProgress({
      current: accounts.length,
      completed,
      skipped,
      phase: '本轮演示完成',
    });
    setLearningStatus(`完整演示已完成：已重授权 ${completed} 个账号，因未获取验证码跳过 ${skipped} 个账号。`, skipped ? 'pending' : 'success');
  } catch (error) {
    if (isFullDemoStoppedError(error) || fullDemoStopRequested) {
      setFullDemoProgress({ phase: '完整演示已停止' });
      setLearningStatus('完整演示已停止，未开始处理后续账号。', 'pending');
    } else {
      setFullDemoProgress({ phase: '完整演示未完成' });
      console.error('[sub2api reauth] 完整演示失败：', error);
      setLearningStatus(error.message || '完整演示未完成。', 'error');
    }
  } finally {
    if (fullDemoRunId === runId) {
      fullDemoDelayWake = null;
      fullDemoRunId = '';
      fullDemoStopRequested = false;
      setFullDemoBusy(false);
    }
  }
}

async function stopFullDemo() {
  if (!fullDemoRunning || !fullDemoRunId) return;
  const runId = fullDemoRunId;
  fullDemoStopRequested = true;
  stopFullDemoButton.disabled = true;
  setLearningStatus('正在停止完整演示…', 'pending');
  fullDemoDelayWake?.();
  try {
    await sendLearningMessage({ type: 'CANCEL_OPENAI_LEARNING_RUN', runId });
  } catch (error) {
    console.warn('[sub2api reauth] 无法通知后台停止演示：', error);
  }
}

async function handleLearningButtonClick(event) {
  const action = event.currentTarget.dataset.learningAction;
  if (!action) return;

  const actionLabel = learningActionLabels[action] || action;
  setLearningStatus(`正在执行：${actionLabel}…`, 'pending');
  console.info(`[sub2api reauth] 开始执行：${action}`);
  setLearningBusy(true);
  try {
    await handleLearningAction(action);
  } catch (error) {
    console.error(`[sub2api reauth] 执行失败：${action}`, error);
    setLearningStatus(error.message || '学习步骤未完成。', 'error');
  } finally {
    setLearningBusy(false);
  }
}

async function clearCallbackCapture() {
  try {
    const state = await sendLearningMessage({ type: 'CLEAR_OPENAI_CALLBACK_CAPTURE' });
    renderCallbackState(state);
    setLearningStatus('已清除本次回调地址。', 'idle');
  } catch (error) {
    setLearningStatus(error.message || '无法清除回调地址。', 'error');
  }
}

form.addEventListener('submit', queryAccounts);
form.addEventListener('input', (event) => {
  latestQuery = null;
  renderResultCount(0);
  renderPreparedAccount();
  if (savedConnectionFieldNames.includes(event.target.name)) {
    event.target.removeAttribute('aria-invalid');
    saveConnectionFields().catch(() => {});
  }
});
loginEmailInput.addEventListener('input', () => saveLearningFields().catch(() => {}));
loginPasswordInput.addEventListener('input', () => saveLearningFields().catch(() => {}));
mailWaitSecondsInput.addEventListener('input', () => saveLearningFields().catch(() => {}));
verificationCodeInput.addEventListener('input', () => saveVerificationCode().catch(() => {}));
fullDemoButton.addEventListener('click', runFullDemo);
stopFullDemoButton.addEventListener('click', stopFullDemo);
for (const learningButton of learningButtons) {
  learningButton.addEventListener('click', handleLearningButtonClick);
}
clearCallbackButton.addEventListener('click', clearCallbackCapture);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'OPENAI_CALLBACK_CAPTURED') {
    renderCallbackState(message.state);
  }
});

settingsRestorePromise = restoreSettings().catch((error) => {
  console.warn('[sub2api reauth] 无法恢复已保存的配置：', error);
});
restoreVerificationCode().catch(() => {});
refreshCallbackState().catch(() => {});
