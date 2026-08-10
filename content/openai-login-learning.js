(() => {
  // executeScript 会在每次按钮点击时调用本文件。全局标记避免重复注册 message listener。
  if (globalThis.__sub2apiReauthOpenAiLearningLoaded) return;
  globalThis.__sub2apiReauthOpenAiLearningLoaded = true;

  const LOGIN_ACTION_PATTERN = /continue|next|sign\s*in|log\s*in|submit|继续|下一步|登录|続行|次へ|ログイン/i;
  const OAUTH_ACTION_PATTERN = /continue|allow|authorize|accept|继续|允许|授权|同意|続行/i;

  function isVisibleElement(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && element.getClientRects().length > 0;
  }

  function isActionEnabled(element) {
    return Boolean(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  }

  function getActionText(element) {
    return [element?.textContent, element?.value, element?.getAttribute('aria-label')]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' ');
  }

  function findFirstVisible(selector) {
    return Array.from(document.querySelectorAll(selector)).find(isVisibleElement) || null;
  }

  function setNativeInputValue(input, value) {
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // FlowPilot 对应函数：getLoginEmailInput。选择器缩小为学习所需的常见输入框。
  function getLoginEmailInput() {
    return findFirstVisible([
      'input[type="email"]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[id*="email" i]',
    ].join(', '));
  }

  // FlowPilot 对应函数：getLoginPasswordInput。
  function getLoginPasswordInput() {
    return findFirstVisible('input[type="password"]');
  }

  // FlowPilot 对应函数：getLoginSubmitButton。
  function getLoginSubmitButton({ allowDisabled = false } = {}) {
    const candidates = Array.from(document.querySelectorAll(
      'button[type="submit"], input[type="submit"], button, [role="button"]'
    ));
    return candidates.find((element) => {
      if (!isVisibleElement(element) || (!allowDisabled && !isActionEnabled(element))) return false;
      return element.matches('button[type="submit"], input[type="submit"]')
        || LOGIN_ACTION_PATTERN.test(getActionText(element));
    }) || null;
  }

  function clickLoginContinue() {
    const button = getLoginSubmitButton();
    if (!button) throw new Error('未找到登录页面的“继续”按钮。');
    button.click();
    return { action: 'login-continue-clicked', buttonText: getActionText(button), url: location.href };
  }

  /**
   * FlowPilot 对应函数：step6LoginFromEmailPage。
   * 原版会填写后立即提交；教学版把“填写”和“点击继续”分成两个按钮，便于观察页面变化。
   */
  function step6LoginFromEmailPage(payload = {}) {
    const email = String(payload.email || '').trim();
    if (!email) throw new Error('请先填写邮箱。');

    const input = getLoginEmailInput();
    if (!input) throw new Error('当前页面没有可见的邮箱输入框。');
    input.focus();
    setNativeInputValue(input, email);
    return { action: 'email-filled', url: location.href };
  }

  // FlowPilot 对应函数：step6LoginFromPasswordPage，教学版同样把提交拆开。
  function step6LoginFromPasswordPage(payload = {}) {
    const password = String(payload.password || '');
    if (!password) throw new Error('请先填写密码。');

    const input = getLoginPasswordInput();
    if (!input) throw new Error('当前页面没有可见的密码输入框。');
    input.focus();
    setNativeInputValue(input, password);
    return { action: 'password-filled', url: location.href };
  }

  // FlowPilot 对应函数：step6_login。它根据页面状态分派到邮箱、密码或提交动作。
  function step6_login(payload = {}) {
    if (payload.email !== undefined) return step6LoginFromEmailPage(payload);
    if (payload.password !== undefined) return step6LoginFromPasswordPage(payload);
    return clickLoginContinue();
  }

  /**
   * FlowPilot 对应函数：getVerificationCodeTarget。
   * OpenAI 页面可能使用一个完整输入框，也可能把验证码拆成多个单字符输入框。
   */
  function getVerificationCodeTarget() {
    const inputs = Array.from(document.querySelectorAll('input')).filter(isVisibleElement);
    const single = inputs.find((input) => {
      const hint = [input.name, input.id, input.autocomplete, input.getAttribute('aria-label')]
        .join(' ')
        .toLowerCase();
      return input.autocomplete === 'one-time-code'
        || /verification|verify|code|otp/.test(hint)
        || (input.inputMode === 'numeric' && Number(input.maxLength) !== 1);
    });
    if (single) return { kind: 'single', inputs: [single] };

    const splitInputs = inputs.filter((input) => Number(input.maxLength) === 1);
    return splitInputs.length >= 4 ? { kind: 'split', inputs: splitInputs } : null;
  }

  /**
   * FlowPilot 对应函数：fillVerificationCode(step, payload)。
   * 这里不自动从邮箱取值，只接收侧边栏中由用户粘贴的验证码。
   */
  function fillVerificationCode(step, payload = {}) {
    if (Number(step) !== 8) throw new Error('教学版仅处理登录验证码步骤。');
    const code = String(payload.code || '').replace(/\s+/g, '');
    if (!code) throw new Error('请先从邮箱复制验证码。');

    const target = getVerificationCodeTarget();
    if (!target) throw new Error('当前页面没有可见的验证码输入框。');

    if (target.kind === 'single') {
      target.inputs[0].focus();
      setNativeInputValue(target.inputs[0], code);
    } else {
      if (target.inputs.length < code.length) {
        throw new Error('页面验证码输入框数量不足。');
      }
      Array.from(code).forEach((character, index) => {
        setNativeInputValue(target.inputs[index], character);
      });
      target.inputs[Math.min(code.length - 1, target.inputs.length - 1)].focus();
    }

    return { action: 'verification-code-filled', target: target.kind, codeLength: code.length, url: location.href };
  }

  function clickVerificationContinue() {
    const target = getVerificationCodeTarget();
    if (!target) throw new Error('当前页面没有可见的验证码输入框。');
    const root = target?.inputs[0]?.closest('form') || document;
    const candidates = Array.from(root.querySelectorAll(
      'button[type="submit"], input[type="submit"], button, [role="button"]'
    ));
    const button = candidates.find((element) => isVisibleElement(element)
      && isActionEnabled(element)
      && (element.matches('button[type="submit"], input[type="submit"]')
        || LOGIN_ACTION_PATTERN.test(getActionText(element))));
    if (!button) throw new Error('未找到验证码页面的“继续”按钮。');
    button.click();
    return { action: 'verification-continue-clicked', buttonText: getActionText(button), url: location.href };
  }

  // FlowPilot 对应函数：getOAuthConsentForm。
  function getOAuthConsentForm() {
    return Array.from(document.querySelectorAll('form')).find((form) => {
      if (!isVisibleElement(form)) return false;
      const text = form.innerText.toLowerCase();
      const consentContext = /codex|chatgpt|authorize|allow access|permissions/.test(text);
      return consentContext
        && Boolean(form.querySelector('button, input[type="submit"], [role="button"]'));
    }) || null;
  }

  // FlowPilot 对应函数：getPrimaryContinueButton。
  function getPrimaryContinueButton() {
    const root = getOAuthConsentForm() || document;
    const candidates = Array.from(root.querySelectorAll(
      'button[type="submit"], input[type="submit"], button, [role="button"]'
    ));
    return candidates.find((element) => isVisibleElement(element)
      && isActionEnabled(element)
      && (element.getAttribute('data-dd-action-name') === 'Continue'
        || OAUTH_ACTION_PATTERN.test(getActionText(element)))) || null;
  }

  // FlowPilot 对应函数：isOAuthConsentPage。
  function isOAuthConsentPage() {
    const text = document.body?.innerText?.toLowerCase() || '';
    return Boolean(getOAuthConsentForm())
      || (text.includes('codex') && text.includes('chatgpt') && Boolean(getPrimaryContinueButton()));
  }

  // FlowPilot 对应函数：step8_findAndClick，教学版先暴露“查找”这一小步。
  function step8_findAndClick() {
    if (!isOAuthConsentPage()) throw new Error('当前页面不是 OAuth 授权确认页。');
    const button = getPrimaryContinueButton();
    if (!button) throw new Error('未找到 OAuth 授权页的“继续”按钮。');
    return { button, buttonText: getActionText(button), url: location.href };
  }

  // FlowPilot 对应函数：step8_triggerContinue。
  function step8_triggerContinue() {
    const result = step8_findAndClick();
    const form = result.button.form || result.button.closest('form');
    if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit(result.button);
    } else {
      result.button.click();
    }
    return { action: 'oauth-continue-triggered', buttonText: result.buttonText, url: result.url };
  }

  function runLearningStep(action, value) {
    switch (action) {
      case 'fill-email':
        return step6_login({ email: value.email });
      case 'continue-after-email':
      case 'continue-after-password':
        return step6_login();
      case 'fill-password':
        return step6_login({ password: value.password });
      case 'fill-code':
        return fillVerificationCode(8, { code: value.code });
      case 'submit-code':
        return clickVerificationContinue();
      case 'oauth-continue':
        return step8_triggerContinue();
      default:
        throw new Error('未知的学习步骤。');
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'RUN_OPENAI_LEARNING_STEP') return undefined;

    try {
      sendResponse({ ok: true, result: runLearningStep(message.action, message.value || {}) });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || '页面步骤未完成。') });
    }
    return true;
  });
})();
