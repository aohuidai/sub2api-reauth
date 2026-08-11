// 这个模块没有 Chrome API 依赖，方便直接用 Node 为关键边界写单元测试。

export const CALLBACK_CAPTURE_KEY = 'openAiLearningCallback';

// 这些站点权限只会在用户点击学习流程按钮时请求。
export const OPENAI_LEARNING_ORIGINS = Object.freeze([
  'https://*.openai.com/*',
  'https://chatgpt.com/*',
  'http://localhost/*',
  'https://localhost/*',
]);

export function normalizeVerificationCode(value = '') {
  const code = String(value || '').replace(/\s+/g, '');
  if (!/^[a-z0-9]{4,12}$/i.test(code)) {
    throw new Error('验证码应为 4 到 12 位字母或数字。');
  }
  return code;
}

/**
 * FlowPilot 对应函数：background/verification-flow.js 的 pollFreshVerificationCode。
 *
 * 原项目按不同邮箱服务商轮询 API 或网页。第 5 步的 QQ 邮箱路径由
 * `content/qq-mail-learning.js` 注入已登录的网页实现；这个小函数保留为可测试的
 * 手动输入适配器，不保存邮箱登录态或邮箱密码。
 */
export async function pollFreshVerificationCode(step, state, mail) {
  if (!mail || typeof mail.fetchLatestCode !== 'function') {
    throw new Error('教学版未配置邮箱读取器，请从邮箱手动复制验证码。');
  }

  const result = await mail.fetchLatestCode({ step, state });
  const code = normalizeVerificationCode(
    result && typeof result === 'object' ? result.code : result
  );

  return {
    code,
    emailTimestamp: Number(result?.emailTimestamp) || null,
  };
}

/**
 * FlowPilot 的第 9 步只接收 localhost 回调。这里保留同一边界，
 * 避免把普通网页跳转误当成 OAuth 回调。
 */
export function isLocalhostCallbackUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol)
      && url.hostname.toLowerCase() === 'localhost';
  } catch {
    return false;
  }
}

export function createPendingCallbackCaptureState(startedAt = Date.now()) {
  return {
    active: true,
    callbackUrl: '',
    startedAt: Number(startedAt) || Date.now(),
    capturedAt: null,
  };
}

export function createCapturedCallbackState(callbackUrl, capturedAt = Date.now()) {
  if (!isLocalhostCallbackUrl(callbackUrl)) {
    throw new Error('回调地址必须是 http(s)://localhost/...。');
  }

  return {
    active: false,
    callbackUrl: String(callbackUrl),
    startedAt: null,
    capturedAt: Number(capturedAt) || Date.now(),
  };
}
