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
const REAUTH_CONTEXT_KEY = 'sub2apiReauthContext';
const QQ_MAIL_BASELINE_KEY = 'openAiQqMailBaseline';
const QQ_VERIFICATION_CODE_KEY = 'openAiLearningVerificationCode';
const QQ_MAIL_POLL_MESSAGE = 'POLL_QQ_OPENAI_LOGIN_CODE_V2';
const QQ_MAIL_SNAPSHOT_MESSAGE = 'SNAPSHOT_QQ_MAIL_BASELINE_V2';
const QQ_MAIL_BASELINE_MAX_AGE_MS = 10 * 60 * 1000;
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
  'SUBMIT_OPENAI_REAUTH_CALLBACK',
  'RUN_OPENAI_LEARNING_STEP',
  'CONFIRM_MANUAL_VERIFICATION_CODE',
  'ARM_OPENAI_CALLBACK_CAPTURE',
  'GET_OPENAI_CALLBACK_CAPTURE',
  'CLEAR_OPENAI_CALLBACK_CAPTURE',
]);

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

async function getReauthContext() {
  const stored = await chrome.storage.session.get(REAUTH_CONTEXT_KEY);
  return stored[REAUTH_CONTEXT_KEY] || null;
}

async function activateTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  await chrome.tabs.update(tabId, { active: true });
}

async function notifyCallbackCaptured(state) {
  // Popup 在切换标签时会关闭；没有接收者时无需把这当成错误。
  try {
    await chrome.runtime.sendMessage?.({
      type: 'OPENAI_CALLBACK_CAPTURED',
      state,
    });
  } catch (_) {
    // Ignore a missing popup receiver.
  }
}

async function captureLocalhostCallback(details) {
  if (details?.frameId !== 0 || !isLocalhostCallbackUrl(details?.url)) return;

  const pending = await getOpenAiCallbackState();
  if (!pending.active) return;

  const state = createCapturedCallbackState(details.url);
  await chrome.storage.session.set({ [CALLBACK_CAPTURE_KEY]: state });
  await notifyCallbackCaptured(state);
}

// FlowPilot 的 confirm-oauth.js 同时监听导航开始、提交和标签页更新。
// 教学版保留前两个导航事件；这样 localhost 没有启动服务器、页面无法提交时也能看见 URL。
chrome.webNavigation?.onBeforeNavigate?.addListener((details) => {
  captureLocalhostCallback(details).catch(() => {});
});
chrome.webNavigation?.onCommitted?.addListener((details) => {
  captureLocalhostCallback(details).catch(() => {});
});

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!Number.isInteger(tab?.id)) {
    throw new Error('没有可操作的当前标签页。');
  }
  return tab.id;
}

async function runOpenAiLearningStep(message = {}) {
  const action = String(message.action || '');
  if (!LEARNING_ACTIONS.has(action)) {
    throw new Error('未知的学习步骤。');
  }

  const tabId = await getActiveTabId();
  await setOpenAiAuthTabId(tabId);
  try {
    // 内容脚本只在用户主动操作时注入，避免在不相关网页运行。
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/openai-login-learning.js'],
    });
  } catch (_) {
    throw new Error('无法连接当前页面。请先切换到 OpenAI 登录或授权页面，并授予站点访问权限。');
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'RUN_OPENAI_LEARNING_STEP',
      action,
      value: message.value || {},
    });
    if (!response?.ok) {
      throw new Error(response?.error || '页面步骤未完成。');
    }
    return response.result || {};
  } catch (error) {
    throw new Error(String(error?.message || '页面步骤未完成。'));
  }
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

async function getQqMailBaseline() {
  const stored = await chrome.storage.session.get(QQ_MAIL_BASELINE_KEY);
  const baseline = stored[QQ_MAIL_BASELINE_KEY];
  if (!baseline || Date.now() - Number(baseline.capturedAt || 0) > QQ_MAIL_BASELINE_MAX_AGE_MS) {
    return null;
  }
  return baseline;
}

async function captureQqMailBaseline() {
  const mailTab = await findQqMailTab();
  if (!mailTab) {
    await chrome.storage.session.remove(QQ_MAIL_BASELINE_KEY);
    return { available: false };
  }

  const authTabId = await getOpenAiAuthTabId();
  const shouldRestoreAuthTab = Number.isInteger(authTabId) && authTabId !== mailTab.id;
  try {
    // QQ Mail only exposes its list after the detail view is left. Bringing this
    // tab forward makes the inbox transition reliable on its virtualized UI.
    if (shouldRestoreAuthTab) await activateTab(mailTab.id);
    await injectQqMailLearningScript(mailTab.id);
    const response = await chrome.tabs.sendMessage(mailTab.id, {
      type: QQ_MAIL_SNAPSHOT_MESSAGE,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'QQ 邮箱未返回当前邮件基线。');
    }
    if (response.result?.needsLogin) {
      await chrome.storage.session.remove(QQ_MAIL_BASELINE_KEY);
      return { available: false, needsLogin: true, mailTabId: mailTab.id };
    }
    const baseline = {
      ...(response.result || {}),
      capturedAt: Date.now(),
      mailTabId: mailTab.id,
    };
    await chrome.storage.session.set({ [QQ_MAIL_BASELINE_KEY]: baseline });
    return { available: true, mailTabId: mailTab.id };
  } catch (error) {
    await chrome.storage.session.remove(QQ_MAIL_BASELINE_KEY);
    return { available: false, error: String(error?.message || 'QQ 邮箱基线获取失败。') };
  } finally {
    if (shouldRestoreAuthTab) {
      await activateTab(authTabId).catch(() => {});
    }
  }
}

async function fetchQqOpenAiLoginCode() {
  const authTabId = await getOpenAiAuthTabId();
  let baseline = await getQqMailBaseline();
  await chrome.storage.session.remove(QQ_VERIFICATION_CODE_KEY);
  if (!baseline) {
    const prepared = await captureQqMailBaseline();
    if (prepared.needsLogin) return prepared;
    if (prepared.error) throw new Error(prepared.error);
    const currentMailTab = await findQqMailTab();
    if (!prepared.available && !currentMailTab) {
      const openedMailTab = await chrome.tabs.create({ url: 'https://wx.mail.qq.com/', active: true });
      return {
        needsLogin: true,
        mailTabId: Number.isInteger(openedMailTab?.id) ? openedMailTab.id : null,
      };
    }
    return { needsFreshCode: true };
  }
  let mailTab = await findQqMailTab(baseline.mailTabId);
  if (!mailTab) {
    mailTab = await chrome.tabs.create({ url: 'https://wx.mail.qq.com/', active: true });
    return {
      needsLogin: true,
      mailTabId: Number.isInteger(mailTab?.id) ? mailTab.id : null,
    };
  }
  if (mailTab.id !== baseline.mailTabId) {
    await chrome.storage.session.remove(QQ_MAIL_BASELINE_KEY);
    return { needsFreshCode: true };
  }

  const mailTabId = mailTab.id;
  let shouldRestoreAuthTab = Number.isInteger(authTabId) && authTabId !== mailTabId;
  try {
    await activateTab(mailTabId);
    await injectQqMailLearningScript(mailTabId);
    const response = await chrome.tabs.sendMessage(mailTabId, {
      type: QQ_MAIL_POLL_MESSAGE,
      payload: {
        maxAttempts: 8,
        intervalMs: 3_000,
        baseline,
      },
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'QQ 邮箱未返回验证码。');
    }
    if (response.result?.needsLogin) {
      shouldRestoreAuthTab = false;
      return {
        needsLogin: true,
        mailTabId,
      };
    }
    if (response.result?.needsFreshCode) {
      return { needsFreshCode: true };
    }
    const code = normalizeVerificationCode(response.result?.code);
    await chrome.storage.session.set({ [QQ_VERIFICATION_CODE_KEY]: code });
    return {
      ...response.result,
      code,
      needsLogin: false,
      mailTabId,
      authTabId,
    };
  } finally {
    if (shouldRestoreAuthTab) {
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

async function handleMessage(message = {}) {
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
    return { result: await fetchQqOpenAiLoginCode() };
  }

  if (message.type === 'SNAPSHOT_QQ_MAIL_BASELINE') {
    return { result: await captureQqMailBaseline() };
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
    return { result: await getOpenAiCallbackState() };
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
