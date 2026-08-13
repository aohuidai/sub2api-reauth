(() => {
  const MAIL_ITEM_SELECTORS = [
    '.mail-list-page-item[data-mailid]',
    '[data-mailid]',
    '[data-mail-id]',
  ];
  const MAIL_DETAIL_SELECTORS = [
    '.mail-detail-basic',
    '.mail-detail-subject',
    '.mail-detail-content',
    '.mail-reader-body',
    '.mail-list-page-reader-body',
  ];
  const MAIL_LIST_ROOT_SELECTOR = '.mail-list-page-items';
  const POLL_MESSAGE = 'POLL_QQ_OPENAI_LOGIN_CODE_V2';
  const SNAPSHOT_MESSAGE = 'SNAPSHOT_QQ_MAIL_BASELINE_V2';
  const CANCEL_MESSAGE = 'CANCEL_QQ_OPENAI_LOGIN_CODE_V2';
  const OPENAI_MAIL_PATTERN = /openai|chatgpt|noreply@.*openai/i;
  const STOPPED_ERROR = '完整演示已停止。';
  const DEFAULT_POLL_WAIT_SECONDS = 60;
  const MAX_POLL_WAIT_SECONDS = 600;
  const POLL_INTERVAL_MS = 3_000;
  const cancelledRunIds = new Set();
  const pendingRunSleeps = new Map();

  if (globalThis.__sub2apiReauthQqMailLearningHandler) {
    chrome.runtime.onMessage.removeListener(globalThis.__sub2apiReauthQqMailLearningHandler);
  }

  function normalizeRunId(value = '') {
    return String(value || '').trim();
  }

  function throwIfRunCancelled(runId = '') {
    const normalizedRunId = normalizeRunId(runId);
    if (normalizedRunId && cancelledRunIds.has(normalizedRunId)) {
      throw new Error(STOPPED_ERROR);
    }
  }

  function cancelRun(runId = '') {
    const normalizedRunId = normalizeRunId(runId);
    if (!normalizedRunId) return false;
    cancelledRunIds.add(normalizedRunId);
    pendingRunSleeps.get(normalizedRunId)?.();
    return true;
  }

  function sleep(ms, runId = '') {
    const normalizedRunId = normalizeRunId(runId);
    throwIfRunCancelled(normalizedRunId);
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (normalizedRunId && pendingRunSleeps.get(normalizedRunId) === finish) {
          pendingRunSleeps.delete(normalizedRunId);
        }
        resolve();
      };
      timer = setTimeout(finish, ms);
      if (normalizedRunId && !settled) pendingRunSleeps.set(normalizedRunId, finish);
    }).then(() => throwIfRunCancelled(normalizedRunId));
  }

  function normalizeText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && element.getClientRects().length > 0;
  }

  function getMailItems() {
    const seen = new Set();
    const items = [];
    for (const selector of MAIL_ITEM_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        const item = element.closest('.mail-list-page-item, [data-mailid], [data-mail-id]') || element;
        if (!seen.has(item) && isVisible(item)) {
          seen.add(item);
          items.push(item);
        }
      }
    }
    return items;
  }

  function getMailId(item, index) {
    return item.getAttribute('data-mailid')
      || item.getAttribute('data-mail-id')
      || `visible-mail-${index}`;
  }

  function getMailText(item) {
    const sender = item.querySelector('.cmp-account-nick, .mail-sender, [class*="sender"], [class*="from"]')?.textContent || '';
    const subject = item.querySelector('.mail-subject, [class*="subject"]')?.textContent || '';
    const digest = item.querySelector('.mail-digest, [class*="digest"], [class*="preview"]')?.textContent || '';
    return normalizeText(`${sender} ${subject} ${digest} ${item.innerText || ''}`);
  }

  function getOpenedMailText() {
    const sections = [];
    const seen = new Set();
    for (const selector of MAIL_DETAIL_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element) || !isVisible(element)) continue;
        seen.add(element);
        sections.push(element.innerText || element.textContent || '');
      }
    }
    return normalizeText(sections.join(' '));
  }

  function createMailboxBaseline() {
    const items = getMailItems();
    return {
      mailIds: items.map(getMailId).slice(0, 500),
    };
  }

  function normalizeBaseline(value = {}) {
    const mailIds = new Set((Array.isArray(value?.mailIds) ? value.mailIds : []).map(String));
    return { mailIds };
  }

  function extractVerificationCode(text = '') {
    const value = String(text || '');
    const patterns = [
      /(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/i,
      /(?:log-?in\s+code|enter\s+this\s+code)[^0-9]{0,24}(\d{6})/i,
      /(?:code\s*(?:is)?\s*[:：]?\s*)(\d{6})/i,
      /\b(\d{6})\b/,
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match?.[1]) return match[1];
    }
    return '';
  }

  function clickControl(element) {
    try {
      element.scrollIntoView?.({ block: 'nearest' });
    } catch (_) {
      // Scrolling is only a convenience for virtualized QQ Mail navigation.
    }
    element.click();
  }

  async function readCodeFromMailItem(item, summary, runId = '') {
    throwIfRunCancelled(runId);
    const directCode = extractVerificationCode(summary);
    if (directCode) return directCode;

    clickControl(item);
    await sleep(700, runId);
    return extractVerificationCode(getOpenedMailText());
  }

  function isInboxLabel(value = '') {
    return /^收件箱(?:\s*\d+)?$/.test(normalizeText(value));
  }

  function findInboxControl() {
    const primary = Array.from(document.querySelectorAll('.frame-sidebar-menu[data-sidebar-dir-id]'))
      .find((element) => isVisible(element) && isInboxLabel(element.innerText));
    if (primary) return primary;

    return Array.from(document.querySelectorAll('a, button, [role="button"], [class*="item"], [class*="folder"]'))
      .find((element) => isVisible(element) && isInboxLabel(element.innerText));
  }

  async function openInbox() {
    const inbox = findInboxControl();
    if (!inbox) return false;
    clickControl(inbox);
    return true;
  }

  async function refreshInbox(runId = '') {
    throwIfRunCancelled(runId);
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const refresh = controls.find((element) => isVisible(element) && /刷新|refresh/i.test(
      `${element.getAttribute('title') || ''} ${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`
    ));
    if (refresh) {
      clickControl(refresh);
      await sleep(700, runId);
      return;
    }
    await openInbox();
  }

  function isQqMailLoginPage() {
    if (document.querySelector('input[type="password"], input[name*="password" i], input[id*="password" i]')) {
      return true;
    }
    const pageText = normalizeText(document.body?.innerText || document.body?.textContent || '');
    return /(?:QQ\s*邮箱|QQ\s*Mail).{0,48}(?:登录|login)|(?:扫码|帐号|账号)登录/i.test(pageText);
  }

  async function waitForMailList(timeoutMs = 10_000, runId = '') {
    throwIfRunCancelled(runId);
    let items = getMailItems();
    const hasListRoot = () => isVisible(document.querySelector(MAIL_LIST_ROOT_SELECTOR));
    if (items.length || hasListRoot()) return items;

    await openInbox();
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      throwIfRunCancelled(runId);
      items = getMailItems();
      if (items.length || hasListRoot()) return items;
      await sleep(250, runId);
    }

    if (isQqMailLoginPage()) {
      throw new Error('QQ 邮箱尚未登录，请在该标签页完成登录后再次点击“从 QQ 邮箱获取”。');
    }
    throw new Error('未找到 QQ 邮箱收件箱列表，请先打开收件箱。');
  }

  async function snapshotMailboxBaseline(payload = {}) {
    const runId = normalizeRunId(payload.runId);
    throwIfRunCancelled(runId);
    if (isQqMailLoginPage()) {
      return { needsLogin: true };
    }
    await waitForMailList(10_000, runId);
    return createMailboxBaseline();
  }

  async function pollQqOpenAiLoginCode(payload = {}) {
    const runId = normalizeRunId(payload.runId);
    throwIfRunCancelled(runId);
    const maxWaitSeconds = Math.max(
      1,
      Math.min(MAX_POLL_WAIT_SECONDS, Number(payload.maxWaitSeconds) || DEFAULT_POLL_WAIT_SECONDS)
    );
    const deadline = Date.now() + maxWaitSeconds * 1_000;
    const excludedCodes = new Set((payload.excludeCodes || []).map(String));
    if (isQqMailLoginPage()) {
      return { needsLogin: true };
    }
    if (!payload.baseline || !Number(payload.baseline.capturedAt)) {
      return { needsFreshCode: true };
    }

    const baseline = normalizeBaseline(payload.baseline);
    await waitForMailList(10_000, runId);

    for (let attempt = 1; ; attempt += 1) {
      throwIfRunCancelled(runId);
      if (attempt > 1) await refreshInbox(runId);

      const items = getMailItems();
      for (const [index, item] of items.entries()) {
        const mailId = getMailId(item, index);
        if (baseline.mailIds.has(mailId)) continue;

        const summary = getMailText(item);
        if (!OPENAI_MAIL_PATTERN.test(summary)) continue;

        const code = await readCodeFromMailItem(item, summary, runId);
        if (code && !excludedCodes.has(code)) {
          return {
            code,
            mailId,
            emailTimestamp: Date.now(),
            source: 'new-mail',
          };
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(POLL_INTERVAL_MS, remainingMs), runId);
    }

    throw new Error(`等待 ${maxWaitSeconds} 秒后仍未在 QQ 邮箱中找到本次新发的 OpenAI/ChatGPT 登录验证码，请重新发送验证码后重试。`);
  }

  const handler = (message, _sender, sendResponse) => {
    if (message?.type === CANCEL_MESSAGE) {
      sendResponse({ ok: true, result: { cancelled: cancelRun(message.runId) } });
      return false;
    }
    if (message?.type === SNAPSHOT_MESSAGE) {
      snapshotMailboxBaseline(message.payload || {})
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({
          ok: false,
          error: String(error?.message || 'QQ 邮箱基线获取失败。'),
        }));
      return true;
    }
    if (message?.type !== POLL_MESSAGE) return undefined;

    pollQqOpenAiLoginCode(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || 'QQ 邮箱验证码读取失败。'),
      }));
    return true;
  };

  chrome.runtime.onMessage.addListener(handler);
  globalThis.__sub2apiReauthQqMailLearningHandler = handler;
})();
