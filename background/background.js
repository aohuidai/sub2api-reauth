import { createSub2ApiClient } from './sub2api-client.js';
import {
  CALLBACK_CAPTURE_KEY,
  createCapturedCallbackState,
  createPendingCallbackCaptureState,
  isLocalhostCallbackUrl,
  normalizeVerificationCode,
  pollFreshVerificationCode,
} from './openai-learning.js';

const sub2ApiClient = createSub2ApiClient();
const OPENAI_AUTH_TAB_KEY = 'openAiLearningAuthTabId';
const OPENAI_LEARNING_OWNED_TABS_KEY = 'openAiLearningOwnedTabsByRun';
const REAUTH_CONTEXT_KEY = 'sub2apiReauthContext';
const QQ_MAIL_BASELINE_KEY = 'openAiQqMailBaseline';
const QQ_VERIFICATION_CODE_KEY = 'openAiLearningVerificationCode';
const QQ_MAIL_CODE_JOB_KEY = 'openAiQqMailCodeJob';
const QQ_MAIL_SNAPSHOT_MESSAGE = 'SNAPSHOT_QQ_MAIL_BASELINE_V2';
const QQ_MAIL_CANCEL_MESSAGE = 'CANCEL_QQ_OPENAI_LOGIN_CODE_V2';
const QQ_MAIL_CODE_CHECK_MESSAGE = 'CHECK_QQ_OPENAI_LOGIN_CODE_V3';
const QQ_MAIL_CODE_ALARM_NAME = 'sub2apiReauthQqMailCodeCheck';
const QQ_MAIL_BASELINE_MAX_AGE_MS = 10 * 60 * 1000;
const QQ_MAIL_ENTRY_URL = 'https://wx.mail.qq.com/';
const QQ_MAIL_OPEN_TIMEOUT_MS = 12_000;
const QQ_MAIL_OPEN_POLL_INTERVAL_MS = 250;
const QQ_MAIL_CODE_CHECK_TIMEOUT_MS = 2_500;
const QQ_MAIL_CODE_MIN_CHECK_INTERVAL_MS = 750;
const QQ_MAIL_CODE_ALARM_PERIOD_MINUTES = 0.5;
const OPENAI_OAUTH_PROGRESS_TIMEOUT_MS = 8_000;
const OPENAI_OAUTH_PROGRESS_POLL_INTERVAL_MS = 250;
const OPENAI_PASSWORD_PAGE_TIMEOUT_MS = 15_000;
const OPENAI_PASSWORD_PAGE_POLL_INTERVAL_MS = 250;
const FULL_DEMO_STOPPED_ERROR = '完整演示已停止。';
const cancelledLearningRunIds = new Set();
const qqMailCodeJobChecks = new Map();
// chrome.storage.session 没有“比较后写入”操作。把下面的小状态迁移串行化，
// 可以避免同一次 service worker 生命周期中的旧检查结果覆盖新验证码任务。
let qqMailCodeJobMutation = Promise.resolve();
const QQ_MAIL_URL_PATTERNS = [
  'https://mail.qq.com/*',
  'https://wx.mail.qq.com/*',
];
const LEARNING_ACTIONS = new Set([
  'fill-email',
  'continue-after-email',
  'fill-password',
  'continue-after-password',
  'fill-code',
  'submit-code',
  'oauth-continue',
]);
const HANDLED_MESSAGE_TYPES = new Set([
  'QUERY_REAUTH_CANDIDATES',
  'OPEN_FIRST_OPENAI_REAUTH',
  'SNAPSHOT_QQ_MAIL_BASELINE',
  'FETCH_QQ_OPENAI_LOGIN_CODE',
  'GET_QQ_OPENAI_LOGIN_CODE_STATUS',
  'SUBMIT_OPENAI_REAUTH_CALLBACK',
  'RUN_OPENAI_LEARNING_STEP',
  'CONFIRM_MANUAL_VERIFICATION_CODE',
  'ARM_OPENAI_CALLBACK_CAPTURE',
  'GET_OPENAI_CALLBACK_CAPTURE',
  'CLEAR_OPENAI_CALLBACK_CAPTURE',
  'WAIT_FOR_OPENAI_OAUTH_PROGRESS',
  'WAIT_FOR_OPENAI_PASSWORD_PAGE',
  'CANCEL_OPENAI_LEARNING_RUN',
  'CLOSE_OPENAI_LEARNING_ROUND',
]);

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  resumePendingQqMailCodeJob().catch((error) => {
    console.warn('[sub2api reauth] QQ 邮箱验证码任务恢复失败：', error);
  });
});

chrome.runtime.onStartup?.addListener(() => {
  resumePendingQqMailCodeJob().catch((error) => {
    console.warn('[sub2api reauth] QQ 邮箱验证码任务恢复失败：', error);
  });
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name !== QQ_MAIL_CODE_ALARM_NAME) return;
  getQqMailCodeJob()
    .then((job) => job?.jobId && runQqMailCodeJobCheck(job.jobId))
    .catch((error) => console.warn('[sub2api reauth] QQ 邮箱后台检查失败：', error));
});

async function getOpenAiCallbackState() {
  const stored = await chrome.storage.session.get(CALLBACK_CAPTURE_KEY);
  return stored[CALLBACK_CAPTURE_KEY] || {
    active: false,
    callbackUrl: '',
    startedAt: null,
    capturedAt: null,
  };
}

async function setOpenAiAuthTabId(tabId) {
  if (Number.isInteger(tabId)) {
    await chrome.storage.session.set({ [OPENAI_AUTH_TAB_KEY]: tabId });
  }
}

async function getOpenAiAuthTabId() {
  const stored = await chrome.storage.session.get(OPENAI_AUTH_TAB_KEY);
  return Number.isInteger(stored[OPENAI_AUTH_TAB_KEY]) ? stored[OPENAI_AUTH_TAB_KEY] : null;
}

async function rememberOpenedLearningTab(tabId, runId = '') {
  const normalizedRunId = normalizeLearningRunId(runId);
  if (!Number.isInteger(tabId) || !normalizedRunId) return;

  const stored = await chrome.storage.session.get(OPENAI_LEARNING_OWNED_TABS_KEY);
  const ownedTabsByRun = stored[OPENAI_LEARNING_OWNED_TABS_KEY] || {};
  const tabIds = Array.isArray(ownedTabsByRun[normalizedRunId])
    ? ownedTabsByRun[normalizedRunId].filter(Number.isInteger)
    : [];
  if (!tabIds.includes(tabId)) tabIds.push(tabId);

  await chrome.storage.session.set({
    [OPENAI_LEARNING_OWNED_TABS_KEY]: {
      ...ownedTabsByRun,
      [normalizedRunId]: tabIds,
    },
  });
}

async function takeOpenedLearningTabs(runId = '') {
  const normalizedRunId = normalizeLearningRunId(runId);
  if (!normalizedRunId) return [];

  const stored = await chrome.storage.session.get(OPENAI_LEARNING_OWNED_TABS_KEY);
  const ownedTabsByRun = stored[OPENAI_LEARNING_OWNED_TABS_KEY] || {};
  const tabIds = Array.isArray(ownedTabsByRun[normalizedRunId])
    ? ownedTabsByRun[normalizedRunId].filter(Number.isInteger)
    : [];
  const remainingRuns = { ...ownedTabsByRun };
  delete remainingRuns[normalizedRunId];

  if (Object.keys(remainingRuns).length) {
    await chrome.storage.session.set({ [OPENAI_LEARNING_OWNED_TABS_KEY]: remainingRuns });
  } else {
    await chrome.storage.session.remove(OPENAI_LEARNING_OWNED_TABS_KEY);
  }
  return tabIds;
}

async function closeOpenAiLearningRound(runId = '') {
  const tabIds = await takeOpenedLearningTabs(runId);
  if (typeof chrome.tabs?.remove === 'function') {
    await Promise.all(tabIds.map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));
  }

  const authTabId = await getOpenAiAuthTabId();
  if (tabIds.includes(authTabId)) {
    await chrome.storage.session.remove(OPENAI_AUTH_TAB_KEY);
  }
  // 在一次受保护的状态迁移中删除任务和验证码。等待中的 QQ 返回要么先完成，
  // 随后连同验证码一起被清除；要么看到任务已不存在，因此不会留下新结果。
  await clearQqMailCodeJob(runId, '', { clearVerificationCode: true });
  await chrome.storage.session.remove([
    QQ_MAIL_BASELINE_KEY,
    REAUTH_CONTEXT_KEY,
  ]);
  return { closedTabCount: tabIds.length };
}

async function getReauthContext() {
  const stored = await chrome.storage.session.get(REAUTH_CONTEXT_KEY);
  return stored[REAUTH_CONTEXT_KEY] || null;
}

async function activateTab(tabId) {
  if (!Number.isInteger(tabId) || typeof chrome.tabs?.update !== 'function') return;
  await chrome.tabs.update(tabId, { active: true });
}

function normalizeLearningRunId(value = '') {
  return String(value || '').trim();
}

function isLearningRunCancelled(runId = '') {
  const normalizedRunId = normalizeLearningRunId(runId);
  return Boolean(normalizedRunId && cancelledLearningRunIds.has(normalizedRunId));
}

function throwIfLearningRunCancelled(runId = '') {
  if (isLearningRunCancelled(runId)) {
    throw new Error(FULL_DEMO_STOPPED_ERROR);
  }
}

function rememberCancelledLearningRun(runId = '') {
  const normalizedRunId = normalizeLearningRunId(runId);
  if (!normalizedRunId) return false;
  cancelledLearningRunIds.add(normalizedRunId);
  if (cancelledLearningRunIds.size > 50) {
    cancelledLearningRunIds.delete(cancelledLearningRunIds.values().next().value);
  }
  return true;
}

async function notifyCallbackCaptured(state) {
  // 侧边栏可能已关闭；没有接收者时无需把这当成错误。
  try {
    await chrome.runtime.sendMessage?.({
      type: 'OPENAI_CALLBACK_CAPTURED',
      state,
    });
  } catch (_) {
    // Ignore a missing side panel receiver.
  }
}

async function isExpectedOpenAiCallback(details = {}) {
  const authTabId = await getOpenAiAuthTabId();
  if (Number.isInteger(details.tabId) && Number.isInteger(authTabId) && details.tabId !== authTabId) {
    return false;
  }

  const context = await getReauthContext();
  const expectedState = String(context?.oauthState || '').trim();
  if (!expectedState) return true;

  try {
    return new URL(details.url).searchParams.get('state') === expectedState;
  } catch {
    return false;
  }
}

async function captureLocalhostCallback(details) {
  if (details?.frameId !== 0 || !isLocalhostCallbackUrl(details?.url)) return;
  if (!await isExpectedOpenAiCallback(details)) return;

  const pending = await getOpenAiCallbackState();
  if (!pending.active) return;

  const state = createCapturedCallbackState(details.url);
  await chrome.storage.session.set({ [CALLBACK_CAPTURE_KEY]: state });
  await notifyCallbackCaptured(state);
}

async function captureCallbackFromOpenAiAuthTab() {
  const pending = await getOpenAiCallbackState();
  if (!pending.active || typeof chrome.tabs?.get !== 'function') return pending;

  const authTabId = await getOpenAiAuthTabId();
  if (!Number.isInteger(authTabId)) return pending;

  const tab = await chrome.tabs.get(authTabId).catch(() => null);
  if (tab?.url) {
    await captureLocalhostCallback({ tabId: authTabId, frameId: 0, url: tab.url });
  }
  return getOpenAiCallbackState();
}

// FlowPilot 的 confirm-oauth.js 同时监听导航开始、提交和标签页更新。
// 这样 localhost 没有启动服务器、页面无法提交时也能看见 URL。
chrome.webNavigation?.onBeforeNavigate?.addListener((details) => {
  captureLocalhostCallback(details).catch(() => {});
});
chrome.webNavigation?.onCommitted?.addListener((details) => {
  captureLocalhostCallback(details).catch(() => {});
});
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  const url = String(changeInfo?.url || tab?.url || '');
  if (!url) return;
  captureLocalhostCallback({ tabId, frameId: 0, url }).catch(() => {});
});

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!Number.isInteger(tab?.id)) {
    throw new Error('没有可操作的当前标签页。');
  }
  return tab.id;
}

async function runOpenAiLearningStep(message = {}) {
  const runId = normalizeLearningRunId(message.runId);
  throwIfLearningRunCancelled(runId);
  const action = String(message.action || '');
  if (!LEARNING_ACTIONS.has(action)) {
    throw new Error('未知的学习步骤。');
  }

  const storedAuthTabId = message.useOpenAiAuthTab ? await getOpenAiAuthTabId() : null;
  const tabId = storedAuthTabId || await getActiveTabId();
  throwIfLearningRunCancelled(runId);
  await setOpenAiAuthTabId(tabId);
  try {
    // 内容脚本只在用户主动操作时注入，避免在不相关网页运行。
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/openai-login-learning.js'],
    });
    throwIfLearningRunCancelled(runId);
  } catch (_) {
    if (isLearningRunCancelled(runId)) {
      throw new Error(FULL_DEMO_STOPPED_ERROR);
    }
    throw new Error('无法连接当前页面。请先切换到 OpenAI 登录或授权页面，并授予站点访问权限。');
  }

  try {
    const response = action === 'oauth-continue'
      ? await chrome.tabs.sendMessage(tabId, {
        type: 'RUN_OPENAI_OAUTH_CONTINUE_V2',
        value: message.value || {},
      })
      : await chrome.tabs.sendMessage(tabId, {
        type: 'RUN_OPENAI_LEARNING_STEP',
        action,
        value: message.value || {},
      });
    if (!response?.ok) {
      throw new Error(response?.error || '页面步骤未完成。');
    }
    throwIfLearningRunCancelled(runId);
    return response.result || {};
  } catch (error) {
    if (isLearningRunCancelled(runId)) {
      throw new Error(FULL_DEMO_STOPPED_ERROR);
    }
    throw new Error(String(error?.message || '页面步骤未完成。'));
  }
}

async function getOpenAiLearningPageState(tabId) {
  const tab = typeof chrome.tabs?.get === 'function'
    ? await chrome.tabs.get(tabId).catch(() => null)
    : null;
  const fallback = {
    url: String(tab?.url || ''),
    oauthConsentPage: null,
    oauthConsentReady: null,
  };
  if (!Number.isInteger(tabId)) return fallback;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/openai-login-learning.js'],
    });
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_OPENAI_OAUTH_PAGE_STATE_V2',
    });
    if (response?.ok) {
      return { ...fallback, ...(response.result || {}) };
    }
  } catch (_) {
    // Navigation may replace the page while this observation is in flight.
  }
  return fallback;
}

async function getOpenAiLoginPageState(tabId) {
  const tab = typeof chrome.tabs?.get === 'function'
    ? await chrome.tabs.get(tabId).catch(() => null)
    : null;
  const fallback = {
    url: String(tab?.url || ''),
    passwordPageReady: false,
  };
  if (!Number.isInteger(tabId)) return fallback;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/openai-login-learning.js'],
    });
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_OPENAI_LOGIN_PAGE_STATE_V2',
    });
    if (response?.ok) {
      return { ...fallback, ...(response.result || {}) };
    }
  } catch (_) {
    // The login page can be replaced while its transition is still in flight.
  }
  return fallback;
}

async function waitForOpenAiPasswordPage(message = {}) {
  const runId = normalizeLearningRunId(message.runId);
  const authTabId = await getOpenAiAuthTabId();
  if (!Number.isInteger(authTabId)) {
    throw new Error('缺少 OpenAI 登录标签页，无法确认密码页是否已加载。');
  }

  const deadline = Date.now() + OPENAI_PASSWORD_PAGE_TIMEOUT_MS;
  let latestState = null;
  while (Date.now() < deadline) {
    throwIfLearningRunCancelled(runId);
    const pageState = await getOpenAiLoginPageState(authTabId);
    latestState = pageState;
    if (pageState.passwordPageReady) {
      return { ready: true, url: pageState.url };
    }
    await sleep(OPENAI_PASSWORD_PAGE_POLL_INTERVAL_MS);
  }

  return { ready: false, url: latestState?.url || '' };
}

function isOpenAiOauthConsentUrl(value = '') {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'auth.openai.com'
      && /^\/sign-in-with-chatgpt\/[^/?#]+\/consent\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function waitForOpenAiOauthProgress(message = {}) {
  const runId = normalizeLearningRunId(message.runId);
  const expectedUrl = String(message.expectedUrl || '');
  const authTabId = await getOpenAiAuthTabId();
  if (!Number.isInteger(authTabId)) {
    throw new Error('缺少 OpenAI 认证标签页，无法确认 OAuth 授权是否生效。');
  }

  const deadline = Date.now() + OPENAI_OAUTH_PROGRESS_TIMEOUT_MS;
  let latestState = null;
  while (Date.now() < deadline) {
    throwIfLearningRunCancelled(runId);
    const callback = await captureCallbackFromOpenAiAuthTab();
    if (callback.callbackUrl) {
      return { progressed: true, callbackCaptured: true, callbackUrl: callback.callbackUrl };
    }

    const pageState = await getOpenAiLearningPageState(authTabId);
    latestState = pageState;
    if (isLocalhostCallbackUrl(pageState.url)) {
      await captureLocalhostCallback({ tabId: authTabId, frameId: 0, url: pageState.url });
      const captured = await getOpenAiCallbackState();
      return {
        progressed: true,
        callbackCaptured: Boolean(captured.callbackUrl),
        callbackUrl: captured.callbackUrl || pageState.url,
      };
    }
    // 无论按钮识别状态如何，只要地址仍是点击前的同意页，就不能进入第 9 步。
    // 这避免 React 重绘期间短暂“找不到按钮”被误判为授权已经完成。
    const stillOnConsentPage = pageState.oauthConsentPage === true || isOpenAiOauthConsentUrl(pageState.url);
    if (expectedUrl && pageState.url && pageState.url !== expectedUrl && !stillOnConsentPage) {
      return { progressed: true, callbackCaptured: false, url: pageState.url };
    }

    await sleep(OPENAI_OAUTH_PROGRESS_POLL_INTERVAL_MS);
  }

  return {
    progressed: false,
    stillOnConsent: latestState?.oauthConsentPage === true
      || latestState?.oauthConsentReady === true
      || isOpenAiOauthConsentUrl(latestState?.url),
    url: latestState?.url || expectedUrl,
  };
}

async function findQqMailTab(preferredTabId = null) {
  const tabs = await chrome.tabs.query({ url: QQ_MAIL_URL_PATTERNS });
  return tabs.find((tab) => tab.id === preferredTabId)
    || tabs.find((tab) => tab.active && Number.isInteger(tab?.id))
    || tabs.find((tab) => Number.isInteger(tab?.id))
    || null;
}

async function injectQqMailLearningScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/qq-mail-learning.js'],
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQqMailTabReady(tab, runId = '') {
  if (!Number.isInteger(tab?.id) || tab.status === 'complete' || typeof chrome.tabs.get !== 'function') {
    return tab;
  }

  const deadline = Date.now() + QQ_MAIL_OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfLearningRunCancelled(runId);
    const currentTab = await chrome.tabs.get(tab.id).catch(() => null);
    if (!currentTab || currentTab.status === 'complete') {
      return currentTab || tab;
    }
    await sleep(QQ_MAIL_OPEN_POLL_INTERVAL_MS);
  }
  return tab;
}

async function openQqMailTab(runId = '') {
  throwIfLearningRunCancelled(runId);
  const tab = await chrome.tabs.create({ url: QQ_MAIL_ENTRY_URL, active: true });
  await rememberOpenedLearningTab(tab?.id, runId);
  return waitForQqMailTabReady(tab, runId);
}

async function snapshotQqMailTab(mailTab, runId = '') {
  const readyMailTab = await waitForQqMailTabReady(mailTab, runId);
  if (!Number.isInteger(readyMailTab?.id)) {
    throw new Error('无法打开 QQ 邮箱标签页。');
  }

  throwIfLearningRunCancelled(runId);
  await injectQqMailLearningScript(readyMailTab.id);
  throwIfLearningRunCancelled(runId);
  const snapshotMessage = {
    type: QQ_MAIL_SNAPSHOT_MESSAGE,
  };
  if (runId) snapshotMessage.payload = { runId };
  const response = await chrome.tabs.sendMessage(readyMailTab.id, snapshotMessage);
  throwIfLearningRunCancelled(runId);
  if (!response?.ok) {
    throw new Error(response?.error || 'QQ 邮箱未返回当前邮件基线。');
  }
  return { mailTab: readyMailTab, result: response.result || {} };
}

function shouldOpenFreshQqMailTab(error) {
  const message = String(error?.message || error || '');
  return /未找到 QQ 邮箱收件箱列表|QQ 邮箱未返回当前邮件基线|Receiving end does not exist|message port closed/i.test(message);
}

async function getQqMailBaseline() {
  const stored = await chrome.storage.session.get(QQ_MAIL_BASELINE_KEY);
  const baseline = stored[QQ_MAIL_BASELINE_KEY];
  if (!baseline || Date.now() - Number(baseline.capturedAt || 0) > QQ_MAIL_BASELINE_MAX_AGE_MS) {
    return null;
  }
  return baseline;
}

function normalizeQqMailCodeJobId(value = '') {
  return String(value || '').trim();
}

function isTerminalQqMailCodeJob(job = {}) {
  return ['completed', 'needs-login', 'needs-fresh-code', 'timed-out', 'cancelled', 'failed'].includes(job.state);
}

async function getQqMailCodeJob() {
  const stored = await chrome.storage.session.get(QQ_MAIL_CODE_JOB_KEY);
  return stored[QQ_MAIL_CODE_JOB_KEY] || null;
}

async function saveQqMailCodeJob(job) {
  await chrome.storage.session.set({ [QQ_MAIL_CODE_JOB_KEY]: job });
  return job;
}

/**
 * 每次只执行一个任务状态迁移。
 *
 * 一次邮箱检查会经过注入脚本、读取 QQ 页面、等待消息返回等多个 await。期间用户
 * 可能再次点击第 5 步；这个队列让每次最终写入都重新读取 storage 并拒绝旧任务。
 */
function mutateQqMailCodeJob(mutator) {
  const mutation = qqMailCodeJobMutation.then(mutator, mutator);
  qqMailCodeJobMutation = mutation.catch(() => {});
  return mutation;
}

function hasSameQqMailCodeJobId(currentJob, expectedJob) {
  return Boolean(
    currentJob
    && expectedJob
    && currentJob.jobId === expectedJob.jobId
  );
}

/**
 * 仅当发起本次工作的任务仍是当前任务时才更新它。
 * 返回 null 代表用户的下一次点击已经替换或清除了该任务。
 */
async function updateCurrentQqMailCodeJob(expectedJob, update) {
  return mutateQqMailCodeJob(async () => {
    const currentJob = await getQqMailCodeJob();
    if (!hasSameQqMailCodeJobId(currentJob, expectedJob)) return null;

    const nextJob = {
      ...currentJob,
      ...(typeof update === 'function' ? update(currentJob) : update),
    };
    return saveQqMailCodeJob(nextJob);
  });
}

async function markQqMailCodeJobChecking(job, checkedAt = Date.now()) {
  return updateCurrentQqMailCodeJob(job, (currentJob) => ({
    state: 'checking',
    checkingStartedAt: checkedAt,
    checkCount: Number(currentJob.checkCount || 0) + 1,
  }));
}

async function ensureQqMailCodeJobAlarm() {
  if (typeof chrome.alarms?.create !== 'function') return;
  await chrome.alarms.create(QQ_MAIL_CODE_ALARM_NAME, {
    delayInMinutes: QQ_MAIL_CODE_ALARM_PERIOD_MINUTES,
    periodInMinutes: QQ_MAIL_CODE_ALARM_PERIOD_MINUTES,
  });
}

async function clearQqMailCodeJobAlarm() {
  if (typeof chrome.alarms?.clear !== 'function') return;
  await chrome.alarms.clear(QQ_MAIL_CODE_ALARM_NAME).catch(() => {});
}

async function clearQqMailCodeJob(runId = '', jobId = '', { clearVerificationCode = false } = {}) {
  const normalizedRunId = normalizeLearningRunId(runId);
  const normalizedJobId = normalizeQqMailCodeJobId(jobId);
  return mutateQqMailCodeJob(async () => {
    const job = await getQqMailCodeJob();
    // 完成的任务可能已被移除，但临时验证码仍存在。没有当前任务时，该验证码
    // 已经不属于任何新轮次，调用方可以安全清除它。
    if (!job) {
      if (clearVerificationCode) await chrome.storage.session.remove(QQ_VERIFICATION_CODE_KEY);
      return clearVerificationCode;
    }
    if (normalizedRunId && job.runId !== normalizedRunId) return false;
    if (normalizedJobId && job.jobId !== normalizedJobId) return false;

    const keysToRemove = [QQ_MAIL_CODE_JOB_KEY];
    if (clearVerificationCode) keysToRemove.push(QQ_VERIFICATION_CODE_KEY);
    await chrome.storage.session.remove(keysToRemove);
    await clearQqMailCodeJobAlarm();
    return true;
  });
}

/**
 * 邮箱快照是共享 session 状态。只有发现邮箱标签失效的当前任务才可以清除它，
 * 已被替换的旧任务不能破坏新一次点击建立的快照。
 */
async function clearQqMailBaselineForCurrentJob(job) {
  return mutateQqMailCodeJob(async () => {
    const currentJob = await getQqMailCodeJob();
    if (!hasSameQqMailCodeJobId(currentJob, job)) return false;

    await chrome.storage.session.remove(QQ_MAIL_BASELINE_KEY);
    return true;
  });
}

async function resumePendingQqMailCodeJob() {
  const job = await getQqMailCodeJob();
  if (!job || isTerminalQqMailCodeJob(job)) {
    await clearQqMailCodeJobAlarm();
    return job;
  }
  if (Date.now() >= Number(job.deadlineAt || 0)) {
    return finishQqMailCodeJob(job, 'timed-out', { error: buildQqMailCodeTimeoutError(job) });
  }

  await ensureQqMailCodeJobAlarm();
  runQqMailCodeJobCheck(job.jobId).catch((error) => {
    console.warn('[sub2api reauth] QQ 邮箱验证码恢复检查失败：', error);
  });
  return job;
}

async function finishQqMailCodeJob(job, state, update = {}) {
  return mutateQqMailCodeJob(async () => {
    const currentJob = await getQqMailCodeJob();
    if (!hasSameQqMailCodeJobId(currentJob, job)) return null;

    const finished = await saveQqMailCodeJob({
      ...currentJob,
      ...update,
      state,
      checkingStartedAt: null,
      completedAt: Date.now(),
    });
    await clearQqMailCodeJobAlarm();
    return finished;
  });
}

async function deferQqMailCodeJob(job, update = {}) {
  return mutateQqMailCodeJob(async () => {
    const currentJob = await getQqMailCodeJob();
    if (!hasSameQqMailCodeJobId(currentJob, job)) return null;

    const deferred = await saveQqMailCodeJob({
      ...currentJob,
      ...update,
      state: 'waiting',
      checkingStartedAt: null,
      nextCheckAt: Date.now() + QQ_MAIL_CODE_MIN_CHECK_INTERVAL_MS,
    });
    await ensureQqMailCodeJobAlarm();
    return deferred;
  });
}

/**
 * 在一次操作中提交完成状态和验证码。这是侧边栏临时验证码的唯一写入路径。
 */
async function completeQqMailCodeJob(job, code, result) {
  return mutateQqMailCodeJob(async () => {
    const currentJob = await getQqMailCodeJob();
    if (!hasSameQqMailCodeJobId(currentJob, job)) return null;

    const completedJob = {
      ...currentJob,
      state: 'completed',
      result,
      error: '',
      checkingStartedAt: null,
      completedAt: Date.now(),
    };
    await chrome.storage.session.set({
      [QQ_MAIL_CODE_JOB_KEY]: completedJob,
      [QQ_VERIFICATION_CODE_KEY]: code,
    });
    await clearQqMailCodeJobAlarm();
    return completedJob;
  });
}

function buildQqMailCodeTimeoutError(job = {}) {
  return `等待 ${job.maxWaitSeconds} 秒后仍未在 QQ 邮箱中找到本次新发的 OpenAI/ChatGPT 登录验证码，请重新发送验证码后重试。`;
}

async function startQqMailCodeJob({ jobId = '', runId = '', mailWaitSeconds = 60 } = {}) {
  const normalizedJobId = normalizeQqMailCodeJobId(jobId);
  if (!normalizedJobId) throw new Error('缺少 QQ 邮箱验证码任务标识。');

  const maxWaitSeconds = Math.max(1, Math.min(600, Number(mailWaitSeconds) || 60));
  const startedAt = Date.now();
  const started = await mutateQqMailCodeJob(async () => {
    const existing = await getQqMailCodeJob();
    if (existing?.jobId === normalizedJobId) return { job: existing, created: false };

    const job = await saveQqMailCodeJob({
      jobId: normalizedJobId,
      runId: normalizeLearningRunId(runId),
      maxWaitSeconds,
      startedAt,
      deadlineAt: startedAt + maxWaitSeconds * 1_000,
      state: 'waiting',
      nextCheckAt: startedAt,
      // 此任务已经开始过多少次短 QQ 邮箱检查。
      checkCount: 0,
      // 当前在 QQ 邮箱中打开的新邮件；尚未选中时为空。
      candidateMailId: '',
      // 打开候选邮件前看到的详情文本，用来判断候选详情是否已完成渲染。
      candidateDetailFingerprint: '',
      error: '',
    });
    await chrome.storage.session.remove(QQ_VERIFICATION_CODE_KEY);
    await ensureQqMailCodeJobAlarm();
    return { job, created: true };
  });
  if (started.created) {
    runQqMailCodeJobCheck(started.job.jobId).catch((error) => {
      console.warn('[sub2api reauth] QQ 邮箱验证码初次检查失败：', error);
    });
  }
  return started.job;
}

async function getQqMailCodeJobStatus(jobId = '') {
  const normalizedJobId = normalizeQqMailCodeJobId(jobId);
  const job = await getQqMailCodeJob();
  if (!job || job.jobId !== normalizedJobId) {
    return { jobId: normalizedJobId, state: 'missing' };
  }

  const now = Date.now();
  const staleCheck = job.state === 'checking'
    && now - Number(job.checkingStartedAt || 0) >= QQ_MAIL_CODE_CHECK_TIMEOUT_MS * 2;
  if (!isTerminalQqMailCodeJob(job) && (staleCheck || now >= Number(job.nextCheckAt || 0))) {
    runQqMailCodeJobCheck(job.jobId).catch((error) => {
      console.warn('[sub2api reauth] QQ 邮箱验证码状态检查失败：', error);
    });
  }
  return job;
}

async function sendQqMailCodeCheck(mailTabId, payload) {
  let timeoutId;
  const responsePromise = chrome.tabs.sendMessage(mailTabId, {
    type: QQ_MAIL_CODE_CHECK_MESSAGE,
    payload,
  }).catch((error) => ({ transportError: String(error?.message || error || 'QQ 邮箱检查未响应。') }));
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ transportError: 'QQ 邮箱检查超时。' }), QQ_MAIL_CODE_CHECK_TIMEOUT_MS);
  });
  const response = await Promise.race([responsePromise, timeoutPromise]);
  clearTimeout(timeoutId);
  return response;
}

async function performQqMailCodeJobCheck(jobId = '') {
  let job = await getQqMailCodeJob();
  if (!job || job.jobId !== jobId || isTerminalQqMailCodeJob(job)) return job;

  const now = Date.now();
  if (now >= Number(job.deadlineAt || 0)) {
    return finishQqMailCodeJob(job, 'timed-out', { error: buildQqMailCodeTimeoutError(job) });
  }
  if (job.state === 'checking' && now - Number(job.checkingStartedAt || 0) < QQ_MAIL_CODE_CHECK_TIMEOUT_MS * 2) {
    return job;
  }

  job = await markQqMailCodeJobChecking(job, now);
  if (!job) return null;

  const runId = job.runId;
  try {
    throwIfLearningRunCancelled(runId);
    const baseline = await getQqMailBaseline();
    if (!baseline) {
      const prepared = await captureQqMailBaseline(runId);
      if (prepared.needsLogin) {
        return finishQqMailCodeJob(job, 'needs-login', { result: prepared });
      }
      if (prepared.error) {
        return deferQqMailCodeJob(job, { error: prepared.error });
      }
      return finishQqMailCodeJob(job, 'needs-fresh-code', {
        result: { needsFreshCode: true },
      });
    }

    const authTabId = await getOpenAiAuthTabId();
    let mailTab = await findQqMailTab(baseline.mailTabId);
    if (!mailTab) {
      mailTab = await openQqMailTab(runId);
      return finishQqMailCodeJob(job, 'needs-login', {
        result: {
          needsLogin: true,
          mailTabId: Number.isInteger(mailTab?.id) ? mailTab.id : null,
        },
      });
    }
    if (mailTab.id !== baseline.mailTabId) {
      const clearedBaseline = await clearQqMailBaselineForCurrentJob(job);
      if (!clearedBaseline) return null;
      return finishQqMailCodeJob(job, 'needs-fresh-code', {
        result: { needsFreshCode: true },
      });
    }

    await injectQqMailLearningScript(mailTab.id);
    throwIfLearningRunCancelled(runId);
    const response = await sendQqMailCodeCheck(mailTab.id, {
      runId,
      baseline,
      candidateMailId: job.candidateMailId || '',
      candidateDetailFingerprint: job.candidateDetailFingerprint || '',
      checkCount: job.checkCount,
    });
    throwIfLearningRunCancelled(runId);
    if (response?.transportError || !response?.ok) {
      return deferQqMailCodeJob(job, {
        error: response?.transportError || response?.error || 'QQ 邮箱暂时未响应。',
      });
    }

    const result = response.result || {};
    if (result.needsLogin) {
      return finishQqMailCodeJob(job, 'needs-login', {
        result: { ...result, mailTabId: mailTab.id },
      });
    }
    if (result.needsFreshCode) {
      return finishQqMailCodeJob(job, 'needs-fresh-code', { result });
    }
    const code = normalizeVerificationCode(result.code);
    if (code) {
      const completedResult = {
        ...result,
        code,
        needsLogin: false,
        mailTabId: mailTab.id,
        authTabId,
      };
      const completedJob = await completeQqMailCodeJob(job, code, completedResult);
      // 普通轮询不抢焦点；只有当前任务确实完成后，才回到需要填写验证码的页面。
      if (completedJob) await activateTab(authTabId).catch(() => {});
      return completedJob;
    }
    const candidateWasCleared = result.clearCandidate === true;
    const candidateMailId = candidateWasCleared
      ? ''
      : String(result.candidateMailId || job.candidateMailId || '');
    const candidateDetailFingerprint = candidateWasCleared
      ? ''
      : (candidateMailId === String(result.candidateMailId || '')
        ? String(result.candidateDetailFingerprint || '')
        : String(job.candidateDetailFingerprint || ''));
    return deferQqMailCodeJob(job, {
      candidateMailId,
      candidateDetailFingerprint,
      error: '',
    });
  } catch (error) {
    if (isLearningRunCancelled(runId)) {
      return finishQqMailCodeJob(job, 'cancelled', { error: FULL_DEMO_STOPPED_ERROR });
    }
    return deferQqMailCodeJob(job, { error: String(error?.message || error || 'QQ 邮箱检查失败。') });
  }
}

async function runQqMailCodeJobCheck(jobId = '') {
  const normalizedJobId = normalizeQqMailCodeJobId(jobId);
  if (!normalizedJobId) return null;
  const active = qqMailCodeJobChecks.get(normalizedJobId);
  if (active) return active;

  const task = performQqMailCodeJobCheck(normalizedJobId)
    .finally(() => qqMailCodeJobChecks.delete(normalizedJobId));
  qqMailCodeJobChecks.set(normalizedJobId, task);
  return task;
}

async function captureQqMailBaseline(runId = '') {
  throwIfLearningRunCancelled(runId);
  let mailTab = await findQqMailTab();
  let openedMailTab = false;
  const authTabId = await getOpenAiAuthTabId();
  let shouldRestoreAuthTab = false;
  try {
    if (!mailTab) {
      await chrome.storage.session.remove(QQ_MAIL_BASELINE_KEY);
      mailTab = await openQqMailTab(runId);
      openedMailTab = true;
    }
    if (!Number.isInteger(mailTab?.id)) {
      throw new Error('无法打开 QQ 邮箱标签页。');
    }

    shouldRestoreAuthTab = Number.isInteger(authTabId) && authTabId !== mailTab.id;
    // QQ Mail only exposes its list after the detail view is left. Bringing this
    // tab forward makes the inbox transition reliable on its virtualized UI.
    if (shouldRestoreAuthTab && !mailTab.active) await activateTab(mailTab.id);
    let snapshot;
    try {
      snapshot = await snapshotQqMailTab(mailTab, runId);
    } catch (error) {
      // A pre-existing QQ tab may be a stale detail or landing view. Preserve it,
      // then open a fresh mailbox entry so Step 4 can prepare the inbox itself.
      if (openedMailTab || !shouldOpenFreshQqMailTab(error)) throw error;
      await chrome.storage.session.remove(QQ_MAIL_BASELINE_KEY);
      mailTab = await openQqMailTab(runId);
      openedMailTab = true;
      shouldRestoreAuthTab = Number.isInteger(authTabId) && authTabId !== mailTab?.id;
      snapshot = await snapshotQqMailTab(mailTab, runId);
    }
    mailTab = snapshot.mailTab;
    if (snapshot.result?.needsLogin) {
      await chrome.storage.session.remove(QQ_MAIL_BASELINE_KEY);
      // 登录页面必须留在前台，方便用户完成 QQ 登录后重试第 4 步。
      shouldRestoreAuthTab = false;
      return {
        available: false,
        needsLogin: true,
        openedMailTab,
        mailTabId: mailTab.id,
      };
    }
    const baseline = {
      ...snapshot.result,
      capturedAt: Date.now(),
      mailTabId: mailTab.id,
    };
    await chrome.storage.session.set({ [QQ_MAIL_BASELINE_KEY]: baseline });
    return { available: true, openedMailTab, mailTabId: mailTab.id };
  } catch (error) {
    if (isLearningRunCancelled(runId)) {
      throw new Error(FULL_DEMO_STOPPED_ERROR);
    }
    await chrome.storage.session.remove(QQ_MAIL_BASELINE_KEY);
    // 收件箱尚未出现时，保留 QQ 标签页让用户可以直接完成登录或切换到收件箱。
    shouldRestoreAuthTab = false;
    return {
      available: false,
      openedMailTab,
      mailTabId: Number.isInteger(mailTab?.id) ? mailTab.id : null,
      error: String(error?.message || 'QQ 邮箱基线获取失败。'),
    };
  } finally {
    if (shouldRestoreAuthTab && !isLearningRunCancelled(runId)) {
      await activateTab(authTabId).catch(() => {});
    }
  }
}

async function confirmManualVerificationCode(code) {
  // 用一个手动适配器调用与 FlowPilot 同名的“取码”函数，保留清晰的职责边界。
  return pollFreshVerificationCode(8, {}, {
    fetchLatestCode: async () => ({ code }),
  });
}

async function cancelOpenAiLearningRun(runId = '') {
  const cancelled = rememberCancelledLearningRun(runId);
  if (!cancelled) return { cancelled: false };

  const job = await getQqMailCodeJob();
  if (job?.runId === normalizeLearningRunId(runId) && !isTerminalQqMailCodeJob(job)) {
    await finishQqMailCodeJob(job, 'cancelled', { error: FULL_DEMO_STOPPED_ERROR });
  }

  const mailTab = await findQqMailTab().catch(() => null);
  if (Number.isInteger(mailTab?.id)) {
    await chrome.tabs.sendMessage(mailTab.id, {
      type: QQ_MAIL_CANCEL_MESSAGE,
      runId: normalizeLearningRunId(runId),
    }).catch(() => {});
  }
  return { cancelled: true };
}

async function handleMessage(message = {}) {
  if (message.type === 'CANCEL_OPENAI_LEARNING_RUN') {
    return { result: await cancelOpenAiLearningRun(message.runId) };
  }
  if (message.type === 'CLOSE_OPENAI_LEARNING_ROUND') {
    return { result: await closeOpenAiLearningRound(message.runId) };
  }

  throwIfLearningRunCancelled(message.runId);

  if (message.type === 'QUERY_REAUTH_CANDIDATES') {
    return {
      result: await sub2ApiClient.queryReauthCandidates(message.connection || {}),
    };
  }

  if (message.type === 'OPEN_FIRST_OPENAI_REAUTH') {
    const result = await sub2ApiClient.prepareReauthForAccount(
      message.connection || {},
      message.account || {}
    );
    let openedTab;
    try {
      openedTab = await chrome.tabs.create({ url: result.oauthUrl, active: true });
    } catch (_) {
      throw new Error('已生成重授权地址，但无法在新标签页打开。');
    }
    await rememberOpenedLearningTab(openedTab?.id, message.runId);
    await setOpenAiAuthTabId(openedTab?.id);
    await chrome.storage.session.set({
      [REAUTH_CONTEXT_KEY]: {
        account: result.account,
        sessionId: result.sessionId,
        oauthState: result.oauthState,
        redirectUri: result.redirectUri,
      },
    });
    return { result };
  }

  if (message.type === 'FETCH_QQ_OPENAI_LOGIN_CODE') {
    return {
      result: await startQqMailCodeJob({
        jobId: message.jobId,
        runId: message.runId,
        mailWaitSeconds: message.mailWaitSeconds,
      }),
    };
  }

  if (message.type === 'GET_QQ_OPENAI_LOGIN_CODE_STATUS') {
    return { result: await getQqMailCodeJobStatus(message.jobId) };
  }

  if (message.type === 'SNAPSHOT_QQ_MAIL_BASELINE') {
    return { result: await captureQqMailBaseline(message.runId) };
  }

  if (message.type === 'SUBMIT_OPENAI_REAUTH_CALLBACK') {
    const callback = await getOpenAiCallbackState();
    if (!callback.callbackUrl) {
      throw new Error('尚未捕获 localhost 回调地址。');
    }
    const context = await getReauthContext();
    if (!context) {
      throw new Error('缺少第 0 步重授权上下文，请重新生成重授权链接。');
    }
    const result = await sub2ApiClient.submitReauthCallback(
      message.connection || {},
      context,
      callback.callbackUrl
    );
    await chrome.storage.session.remove(REAUTH_CONTEXT_KEY);
    return { result };
  }

  if (message.type === 'RUN_OPENAI_LEARNING_STEP') {
    const result = await runOpenAiLearningStep(message);
    if (message.action === 'submit-code') {
      await chrome.storage.session.remove(QQ_VERIFICATION_CODE_KEY);
    }
    return { result };
  }

  if (message.type === 'CONFIRM_MANUAL_VERIFICATION_CODE') {
    return { result: await confirmManualVerificationCode(message.code) };
  }

  if (message.type === 'ARM_OPENAI_CALLBACK_CAPTURE') {
    const state = createPendingCallbackCaptureState();
    await chrome.storage.session.set({ [CALLBACK_CAPTURE_KEY]: state });
    return { result: state };
  }

  if (message.type === 'GET_OPENAI_CALLBACK_CAPTURE') {
    return { result: await captureCallbackFromOpenAiAuthTab() };
  }

  if (message.type === 'WAIT_FOR_OPENAI_OAUTH_PROGRESS') {
    return { result: await waitForOpenAiOauthProgress(message) };
  }

  if (message.type === 'WAIT_FOR_OPENAI_PASSWORD_PAGE') {
    return { result: await waitForOpenAiPasswordPage(message) };
  }

  if (message.type === 'CLEAR_OPENAI_CALLBACK_CAPTURE') {
    await chrome.storage.session.remove(CALLBACK_CAPTURE_KEY);
    return { result: await getOpenAiCallbackState() };
  }

  return null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!HANDLED_MESSAGE_TYPES.has(message?.type)) return undefined;

  const messageType = message.type;
  console.info(`[sub2api reauth] 收到消息：${messageType}`);
  handleMessage(message)
    .then((payload) => {
      console.info(`[sub2api reauth] 已完成消息：${messageType}`);
      sendResponse({ ok: true, ...payload });
    })
    .catch((error) => {
      console.error(`[sub2api reauth] 消息失败：${messageType}`, error);
      sendResponse({
        ok: false,
        error: String(error?.message || '操作失败。'),
      });
    });

  return true;
});
