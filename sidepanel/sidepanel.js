const form = document.querySelector('#query-form');
const button = document.querySelector('#query-button');
const resultCount = document.querySelector('#result-count');
const queryState = document.querySelector('#query-state');
const errorState = document.querySelector('#error-state');
const tableWrap = document.querySelector('#results-table-wrap');
const resultsBody = document.querySelector('#results-body');
const savedConnectionFieldNames = ['baseUrl', 'email', 'password', 'groupName'];
const savedLearningFieldNames = ['loginEmail', 'loginPassword'];
const learningButtons = Array.from(document.querySelectorAll('[data-learning-action]'));
const loginEmailInput = document.querySelector('#login-email');
const loginPasswordInput = document.querySelector('#login-password');
const verificationCodeInput = document.querySelector('#verification-code');
const callbackUrl = document.querySelector('#callback-url');
const clearCallbackButton = document.querySelector('#clear-callback');
const learningStatus = document.querySelector('#learning-status');
const preparedAccount = document.querySelector('#prepared-account');
const fullDemoButton = document.querySelector('#run-full-demo');
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
const FULL_DEMO_PAGE_RETRY_COUNT = 12;
const FULL_DEMO_PAGE_RETRY_DELAY_MS = 900;
const FULL_DEMO_CALLBACK_TIMEOUT_MS = 45_000;
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
let settingsRestorePromise = Promise.resolve();

function setBusy(isBusy) {
  button.disabled = isBusy || fullDemoRunning;
  button.textContent = isBusy ? '查询中…' : '查询账号';
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
    resultCount.textContent = String(accounts.length);
    tableWrap.hidden = accounts.length === 0;
    queryState.textContent = accounts.length
      ? `${response.result.group.name} · ${response.result.statuses.join(' / ')}`
      : '没有匹配的账号';
  } catch (error) {
    latestQuery = null;
    renderPreparedAccount();
    resultCount.textContent = '0';
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

async function sendLearningMessage(message) {
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch (error) {
    const detail = String(error?.message || error || '').trim();
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

async function openFirstOpenAiReauth() {
  const account = latestQuery?.accounts?.[0];
  if (!account) {
    throw new Error('请先查询上方分组，取得至少一个待重授权账号。');
  }

  await ensureHostPermission(latestQuery.connection.baseUrl);
  const result = await sendLearningMessage({
    type: 'OPEN_FIRST_OPENAI_REAUTH',
    connection: latestQuery.connection,
    account,
  });

  loginEmailInput.value = result.account.email;
  await saveLearningFields();
  renderPreparedAccount(result.account);
  setLearningStatus(`已打开 #${result.account.id} 的重授权页，并带入邮箱 ${result.account.email}。`, 'success');
  return result;
}

function getVerificationCode() {
  return String(verificationCodeInput.value || '').replace(/\s+/g, '');
}

async function fetchQqOpenAiLoginCode() {
  await clearVerificationCode();
  await ensureQqMailPermission();
  const result = await sendLearningMessage({ type: 'FETCH_QQ_OPENAI_LOGIN_CODE' });
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

async function captureQqMailBaseline() {
  try {
    await ensureQqMailPermission();
    return await sendLearningMessage({ type: 'SNAPSHOT_QQ_MAIL_BASELINE' });
  } catch (error) {
    return { available: false, error: String(error?.message || 'QQ 邮箱基线获取失败。') };
  }
}

async function pushReauthCallbackToSub2Api() {
  const connection = getConnection();
  await ensureHostPermission(connection.baseUrl);
  await saveConnectionFields();
  const result = await sendLearningMessage({
    type: 'SUBMIT_OPENAI_REAUTH_CALLBACK',
    connection,
  });
  setLearningStatus(result.status || '已将重授权结果推送到 SUB2API。', 'success');
  return result;
}

async function runPageLearningStep(action, value = {}, { useOpenAiAuthTab = false } = {}) {
  await ensureOpenAiLearningPermission();
  return sendLearningMessage({
    type: 'RUN_OPENAI_LEARNING_STEP',
    action,
    value,
    useOpenAiAuthTab,
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

async function armCallbackCapture() {
  await ensureOpenAiLearningPermission();
  const state = await sendLearningMessage({ type: 'ARM_OPENAI_CALLBACK_CAPTURE' });
  renderCallbackState(state);
  return state;
}

async function handleLearningAction(action, { useOpenAiAuthTab = false } = {}) {
  switch (action) {
    case 'open-first-reauth':
      return openFirstOpenAiReauth();
    case 'fill-email': {
      await saveLearningFields();
      const result = await runPageLearningStep(action, { email: loginEmailInput.value }, { useOpenAiAuthTab });
      setLearningStatus(formatActionResult(result, '邮箱已填入页面。'), 'success');
      return result;
    }
    case 'continue-after-email': {
      const result = await runPageLearningStep(action, {}, { useOpenAiAuthTab });
      setLearningStatus(formatActionResult(result, '已点击邮箱页的继续按钮。'), 'success');
      return result;
    }
    case 'fill-password': {
      await saveLearningFields();
      const result = await runPageLearningStep(action, { password: loginPasswordInput.value }, { useOpenAiAuthTab });
      setLearningStatus(formatActionResult(result, '密码已填入页面。'), 'success');
      return result;
    }
    case 'continue-after-password': {
      const baseline = await captureQqMailBaseline();
      const result = await runPageLearningStep(action, {}, { useOpenAiAuthTab });
      const fallback = baseline.available
        ? '已点击密码页的继续按钮。'
        : '已提交密码，但未建立 QQ 邮箱基线；请打开收件箱后重新发送验证码，再点击第 5 步。';
      setLearningStatus(formatActionResult(result, fallback), baseline.available ? 'success' : 'pending');
      return { baseline, result };
    }
    case 'fetch-qq-code':
      return fetchQqOpenAiLoginCode();
    case 'fill-code': {
      const result = await runPageLearningStep(action, { code: getVerificationCode() }, { useOpenAiAuthTab });
      setLearningStatus(formatActionResult(result, '验证码已填入页面。'), 'success');
      return result;
    }
    case 'submit-code': {
      const result = await runPageLearningStep(action, {}, { useOpenAiAuthTab });
      await clearVerificationCode();
      setLearningStatus(formatActionResult(result, '已提交验证码。'), 'success');
      return result;
    }
    case 'arm-callback':
      return armCallbackCapture();
    case 'oauth-continue': {
      // 必须先监听再点击，否则极快的本地跳转可能在监听器注册前发生。
      await armCallbackCapture();
      const result = await runPageLearningStep(action, {}, { useOpenAiAuthTab });
      setLearningStatus(formatActionResult(result, '已确认 OAuth 授权，正在等待 localhost 回调。'), 'pending');
      return result;
    }
    case 'push-callback':
      return pushReauthCallbackToSub2Api();
    default:
      throw new Error('未知的学习步骤。');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDemoError(error) {
  return /无法连接当前页面|当前页面没有可见|未找到.*(?:输入框|继续|提交|授权)|页面步骤未完成/i.test(
    String(error?.message || error || '')
  );
}

async function runFullDemoStep(step, action, options = {}) {
  const {
    retry = false,
    pauseAfterMs = 0,
  } = options;
  const attempts = retry ? FULL_DEMO_PAGE_RETRY_COUNT : 1;
  const label = learningActionLabels[action] || `第 ${step} 步`;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    setLearningStatus(
      `完整演示：正在执行第 ${step} 步 ${label}${attempts > 1 ? `（${attempt}/${attempts}）` : ''}…`,
      'pending'
    );
    try {
      const result = await handleLearningAction(action, {
        useOpenAiAuthTab: step > 0 && step < 9,
      });
      if (pauseAfterMs) await sleep(pauseAfterMs);
      return result;
    } catch (error) {
      lastError = error;
      if (!retry || !isRetryableDemoError(error) || attempt === attempts) break;
      await sleep(FULL_DEMO_PAGE_RETRY_DELAY_MS);
    }
  }

  throw lastError || new Error(`第 ${step} 步未完成。`);
}

async function waitForFullDemoCallback() {
  const deadline = Date.now() + FULL_DEMO_CALLBACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await sendLearningMessage({ type: 'GET_OPENAI_CALLBACK_CAPTURE' });
    if (state.callbackUrl) {
      renderCallbackState(state);
      return state;
    }
    setLearningStatus('完整演示：第 9 步正在等待 localhost 回调地址…', 'pending');
    await sleep(1_000);
  }
  throw new Error('完整演示停在第 9 步：等待 localhost 回调超时。');
}

function setFullDemoBusy(isBusy, { disableForm = true } = {}) {
  fullDemoRunning = isBusy;
  setLearningBusy(isBusy);
  if (disableForm) {
    for (const element of form.querySelectorAll('input, button')) {
      element.disabled = isBusy;
    }
  }
  setBusy(false);
}

async function runFullDemo() {
  // 保持输入框可用，直到前置校验完成；这样缺失字段可以获得焦点并滚动到可见位置。
  setFullDemoBusy(true, { disableForm: false });
  try {
    setLearningStatus('完整演示：正在恢复已保存的配置并检查前置条件…', 'pending');
    await ensureFullDemoPermissions();
    setFullDemoBusy(true);
    await clearVerificationCode();
    const clearedCallback = await sendLearningMessage({ type: 'CLEAR_OPENAI_CALLBACK_CAPTURE' });
    renderCallbackState(clearedCallback);

    if (!latestQuery) {
      setLearningStatus('完整演示：正在查询待重授权账号…', 'pending');
      await queryReauthAccounts({ throwOnError: true });
    }
    if (!latestQuery?.accounts?.[0]) {
      throw new Error('完整演示无法开始：查询结果中没有待重授权账号。');
    }

    await runFullDemoStep(0, 'open-first-reauth', { pauseAfterMs: 1_200 });
    await runFullDemoStep(1, 'fill-email', { retry: true });
    await runFullDemoStep(2, 'continue-after-email', { retry: true, pauseAfterMs: 1_000 });
    await runFullDemoStep(3, 'fill-password', { retry: true });
    const passwordResult = await runFullDemoStep(4, 'continue-after-password', {
      retry: true,
      pauseAfterMs: 1_000,
    });
    if (!passwordResult?.baseline?.available) {
      throw new Error('完整演示停在第 4 步：QQ 收件箱未就绪，无法建立本次验证码的邮件快照。');
    }

    const codeResult = await runFullDemoStep(5, 'fetch-qq-code');
    if (codeResult?.needsLogin) {
      throw new Error('完整演示停在第 5 步：请先登录 QQ 邮箱后重新开始。');
    }
    if (codeResult?.needsFreshCode || !getVerificationCode()) {
      throw new Error('完整演示停在第 5 步：未获取到本次验证码，请重新发送验证码后再开始。');
    }

    await runFullDemoStep(6, 'fill-code', { retry: true });
    await runFullDemoStep(7, 'submit-code', { retry: true, pauseAfterMs: 1_000 });
    await runFullDemoStep(8, 'oauth-continue', { retry: true });
    await waitForFullDemoCallback();
    await runFullDemoStep(10, 'push-callback');
    setLearningStatus('完整演示已完成：重授权结果已推送到 SUB2API。', 'success');
  } catch (error) {
    console.error('[sub2api reauth] 完整演示失败：', error);
    setLearningStatus(error.message || '完整演示未完成。', 'error');
  } finally {
    setFullDemoBusy(false);
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
  renderPreparedAccount();
  if (savedConnectionFieldNames.includes(event.target.name)) {
    event.target.removeAttribute('aria-invalid');
    saveConnectionFields().catch(() => {});
  }
});
loginEmailInput.addEventListener('input', () => saveLearningFields().catch(() => {}));
loginPasswordInput.addEventListener('input', () => saveLearningFields().catch(() => {}));
verificationCodeInput.addEventListener('input', () => saveVerificationCode().catch(() => {}));
fullDemoButton.addEventListener('click', runFullDemo);
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
