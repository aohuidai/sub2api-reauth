import { createSub2ApiClient } from './sub2api-client.js';
import {
  CALLBACK_CAPTURE_KEY,
  createCapturedCallbackState,
  createPendingCallbackCaptureState,
  isLocalhostCallbackUrl,
  pollFreshVerificationCode,
} from './openai-learning.js';

const sub2ApiClient = createSub2ApiClient();
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
  'RUN_OPENAI_LEARNING_STEP',
  'CONFIRM_MANUAL_VERIFICATION_CODE',
  'ARM_OPENAI_CALLBACK_CAPTURE',
  'GET_OPENAI_CALLBACK_CAPTURE',
  'CLEAR_OPENAI_CALLBACK_CAPTURE',
]);

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
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

  if (message.type === 'RUN_OPENAI_LEARNING_STEP') {
    return { result: await runOpenAiLearningStep(message) };
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

  handleMessage(message)
    .then((payload) => {
      sendResponse({ ok: true, ...payload });
    })
    .catch((error) => sendResponse({
      ok: false,
      error: String(error?.message || '操作失败。'),
    }));

  return true;
});
