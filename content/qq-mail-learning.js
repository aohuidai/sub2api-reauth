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
  const MAIL_ID_ATTRIBUTES = ['data-mailid', 'data-mail-id'];
  const MAIL_LIST_ROOT_SELECTOR = '.mail-list-page-items';
  const SNAPSHOT_MESSAGE = 'SNAPSHOT_QQ_MAIL_BASELINE_V2';
  const CANCEL_MESSAGE = 'CANCEL_QQ_OPENAI_LOGIN_CODE_V2';
  const CHECK_MESSAGE = 'CHECK_QQ_OPENAI_LOGIN_CODE_V3';
  const OPENAI_MAIL_PATTERN = /openai|chatgpt|noreply@.*openai/i;
  const STOPPED_ERROR = '完整演示已停止。';
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
    return getElementMailId(item) || `visible-mail-${index}`;
  }

  function getMailText(item) {
    const sender = item.querySelector('.cmp-account-nick, .mail-sender, [class*="sender"], [class*="from"]')?.textContent || '';
    const subject = item.querySelector('.mail-subject, [class*="subject"]')?.textContent || '';
    const digest = item.querySelector('.mail-digest, [class*="digest"], [class*="preview"]')?.textContent || '';
    return normalizeText(`${sender} ${subject} ${digest} ${item.innerText || ''}`);
  }

  function getElementMailId(element) {
    let current = element;
    while (current instanceof HTMLElement) {
      for (const attribute of MAIL_ID_ATTRIBUTES) {
        const mailId = String(current.getAttribute?.(attribute) || '').trim();
        if (mailId) return mailId;
      }
      current = current.parentElement;
    }
    return '';
  }

  function getOpenedMailSections() {
    const sections = [];
    const seen = new Set();
    for (const selector of MAIL_DETAIL_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element) || !isVisible(element)) continue;
        seen.add(element);
        sections.push(element.innerText || element.textContent || '');
      }
    }
    return { elements: [...seen], text: normalizeText(sections.join(' ')) };
  }

  function getOpenedMailText() {
    return getOpenedMailSections().text;
  }

  function getOpenedMailId() {
    const mailIds = new Set(
      getOpenedMailSections().elements
        .map(getElementMailId)
        .filter(Boolean)
    );
    // 同时看到多个详情 ID 通常表示 QQ 邮箱的虚拟列表正在重绘；此时不猜测正文属于哪封邮件。
    return mailIds.size === 1 ? [...mailIds][0] : '';
  }

  function hasSelectedMailState(element) {
    if (!(element instanceof HTMLElement)) return false;
    const selectedAttributes = ['aria-selected', 'data-selected', 'data-active'];
    if (selectedAttributes.some((attribute) => element.getAttribute?.(attribute) === 'true')) {
      return true;
    }
    if (['true', 'page'].includes(element.getAttribute?.('aria-current'))) return true;

    const className = String(element.className || element.getAttribute?.('class') || '');
    return /(?:^|[\s_-])(?:is-)?(?:active|selected|current)(?:[\s_-]|$)/i.test(className);
  }

  function getSelectedMailId() {
    for (const [index, item] of getMailItems().entries()) {
      if (hasSelectedMailState(item) || hasSelectedMailState(item.querySelector?.('[aria-selected="true"], [data-selected="true"], [data-active="true"], [aria-current="true"], .selected, .active, .current'))) {
        return getMailId(item, index);
      }
    }
    return '';
  }

  function getCandidateMailState(candidateMailId) {
    const openedMailId = getOpenedMailId();
    const selectedMailId = getSelectedMailId();
    if (openedMailId && openedMailId !== candidateMailId) return { clearCandidate: true };
    if (selectedMailId && selectedMailId !== candidateMailId) return { clearCandidate: true };
    return {
      isCandidateOpen: openedMailId === candidateMailId || selectedMailId === candidateMailId,
    };
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

  function createTextFingerprint(text = '') {
    let hash = 0;
    for (const character of String(text || '')) {
      hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
    }
    return `${String(text || '').length}:${hash}`;
  }

  function clickControl(element) {
    try {
      element.scrollIntoView?.({ block: 'nearest' });
    } catch (_) {
      // Scrolling is only a convenience for virtualized QQ Mail navigation.
    }
    element.click();
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

  function refreshInboxOnce() {
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const refresh = controls.find((element) => isVisible(element) && /刷新|refresh/i.test(
      `${element.getAttribute('title') || ''} ${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`
    ));
    if (refresh) {
      clickControl(refresh);
      return true;
    }
    return Boolean(findInboxControl() && openInbox());
  }

  function shouldRefreshInbox(checkCount, candidateMailId) {
    if (candidateMailId) return false;
    // checkCount 来自后台任务，首次值为 1。第一次立即刷新以尽快请求新邮件，
    // 后续每三次刷新一次，兼顾延迟邮件和短检查的响应速度。
    return checkCount === 1 || (checkCount > 1 && checkCount % 3 === 0);
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

  function checkQqOpenAiLoginCode(payload = {}) {
    const runId = normalizeRunId(payload.runId);
    throwIfRunCancelled(runId);
    if (isQqMailLoginPage()) return { needsLogin: true };
    if (!payload.baseline || !Number(payload.baseline.capturedAt)) return { needsFreshCode: true };

    const baseline = normalizeBaseline(payload.baseline);
    const candidateMailId = String(payload.candidateMailId || '');
    const candidateDetailFingerprint = String(payload.candidateDetailFingerprint || '');
    if (candidateMailId) {
      const candidateState = getCandidateMailState(candidateMailId);
      if (candidateState.clearCandidate) return { clearCandidate: true };

      const openedText = getOpenedMailText();
      const openedFingerprint = createTextFingerprint(openedText);
      if (candidateState.isCandidateOpen && openedText && openedFingerprint !== candidateDetailFingerprint) {
        const openedCode = extractVerificationCode(openedText);
        if (openedCode) {
          return {
            code: openedCode,
            mailId: candidateMailId,
            emailTimestamp: Date.now(),
            source: 'new-mail',
          };
        }
      }
    }

    const checkCount = Number(payload.checkCount || 0);
    if (shouldRefreshInbox(checkCount, candidateMailId)) refreshInboxOnce();

    const items = getMailItems();
    for (const [index, item] of items.entries()) {
      const mailId = getMailId(item, index);
      if (baseline.mailIds.has(mailId)) continue;

      const summary = getMailText(item);
      if (!OPENAI_MAIL_PATTERN.test(summary)) continue;
      const code = extractVerificationCode(summary);
      if (code) {
        return {
          code,
          mailId,
          emailTimestamp: Date.now(),
          source: 'new-mail',
        };
      }
      // 记录点击前的详情。QQ 邮箱有时同步、有时异步更新；下次检查只需确认
      // 详情内容已替换，就能可靠判断候选邮件已经渲染完成。
      const detailBeforeOpeningCandidate = createTextFingerprint(getOpenedMailText());
      if (mailId !== candidateMailId) clickControl(item);
      return {
        candidateMailId: mailId,
        candidateDetailFingerprint: detailBeforeOpeningCandidate,
      };
    }

    return {
      candidateMailId,
      candidateDetailFingerprint,
    };
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
    if (message?.type === CHECK_MESSAGE) {
      try {
        sendResponse({ ok: true, result: checkQqOpenAiLoginCode(message.payload || {}) });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || 'QQ 邮箱验证码检查失败。') });
      }
      return false;
    }
    return undefined;
  };

  chrome.runtime.onMessage.addListener(handler);
  globalThis.__sub2apiReauthQqMailLearningHandler = handler;
})();
