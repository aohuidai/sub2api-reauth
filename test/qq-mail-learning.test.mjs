import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../content/qq-mail-learning.js', import.meta.url), 'utf8');

class FakeElement {
  constructor({ attributes = {}, text = '', children = {}, onClick = null } = {}) {
    this.attributes = attributes;
    this.innerText = text;
    this.textContent = text;
    this.children = children;
    this.onClick = onClick;
  }

  getAttribute(name) {
    return this.attributes[name] || '';
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  querySelector(selector) {
    return Object.entries(this.children).find(([key]) => selector.includes(key))?.[1] || null;
  }

  querySelectorAll() {
    return [];
  }

  closest() {
    return this;
  }

  getClientRects() {
    return [{}];
  }

  scrollIntoView() {}

  click() {
    this.onClick?.();
  }
}

function createMailItem(mailId, sender, subject, digest) {
  return new FakeElement({
    attributes: { 'data-mailid': mailId },
    text: `${sender} ${subject} ${digest}`,
    children: {
      '.cmp-account-nick': { textContent: sender },
      '.mail-subject': { textContent: subject },
      '.mail-digest': { textContent: digest },
    },
  });
}

function createQqMailHarness({
  bodyText = '',
  detailText = '',
  detailMailId = '',
  hasPasswordInput = false,
  initialItems = [],
  refreshedItems = initialItems,
  startInInbox = true,
} = {}) {
  let listener = null;
  let items = initialItems;
  let inInbox = startInInbox;
  let inboxClicks = 0;
  let now = 0;
  let openedDetailMailId = detailMailId;
  const detail = new FakeElement({
    attributes: detailMailId ? { 'data-mailid': detailMailId } : {},
    text: detailText,
  });
  const listRoot = new FakeElement();
  const inboxControl = new FakeElement({
    attributes: { 'data-sidebar-dir-id': '1' },
    text: '收件箱 934',
    onClick() {
      inboxClicks += 1;
      inInbox = true;
    },
  });
  const refreshControl = new FakeElement({
    attributes: { title: '刷新' },
    text: '刷新',
    onClick() {
      items = refreshedItems;
    },
  });
  for (const item of refreshedItems) {
    const originalClick = item.onClick;
    item.onClick = () => {
      originalClick?.();
      const mailId = item.getAttribute('data-mailid');
      for (const candidate of [...initialItems, ...refreshedItems]) {
        candidate.setAttribute('aria-selected', String(candidate === item));
      }
      openedDetailMailId = mailId;
      detail.setAttribute('data-mailid', openedDetailMailId);
    };
  }
  const document = {
    body: { innerText: bodyText },
    querySelectorAll(selector) {
      if ([
        '.mail-list-page-item[data-mailid]',
        '[data-mailid]',
        '[data-mail-id]',
      ].includes(selector)) {
        return inInbox ? items : [];
      }
      if ([
        '.mail-detail-basic',
        '.mail-detail-subject',
        '.mail-detail-content',
        '.mail-reader-body',
        '.mail-list-page-reader-body',
      ].includes(selector)) {
        return detailText ? [detail] : [];
      }
      if (selector === '.frame-sidebar-menu[data-sidebar-dir-id]') return [inboxControl];
      if (selector === 'button, a, [role="button"]') return [refreshControl];
      if (selector === 'a, button, [role="button"], [class*="item"], [class*="folder"]') return [inboxControl];
      return [];
    },
    querySelector(selector) {
      if (selector === '.mail-list-page-items') return inInbox ? listRoot : null;
      if (hasPasswordInput && selector.includes('password')) return {};
      return null;
    },
  };
  const context = {
    HTMLElement: FakeElement,
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) {
            listener = callback;
          },
          removeListener(callback) {
            if (listener === callback) listener = null;
          },
        },
      },
    },
    console: { error() {}, info() {}, log() {}, warn() {} },
    document,
    Date: { now() { return now; } },
    setTimeout(callback, ms = 0) {
      now += Number(ms) || 0;
      callback();
      return 1;
    },
    window: {
      getComputedStyle() {
        return { display: 'block', visibility: 'visible' };
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'qq-mail-learning.js' });

  return {
    async send(message) {
      assert.equal(typeof listener, 'function');
      return new Promise((resolve, reject) => {
        const expectsAsyncResponse = message.type === 'SNAPSHOT_QQ_MAIL_BASELINE_V2';
        let returned;
        let responseReady = false;
        let response;
        const sendResponse = (value) => {
          response = value;
          responseReady = true;
          if (returned !== undefined) resolve(response);
        };
        try {
          returned = listener(message, {}, sendResponse);
          assert.equal(returned, expectsAsyncResponse);
          if (responseReady) resolve(response);
        } catch (error) {
          reject(error);
        }
      });
    },
    get inboxClicks() {
      return inboxClicks;
    },
    openMail(mailId) {
      openedDetailMailId = mailId;
      detail.setAttribute('data-mailid', openedDetailMailId);
      for (const candidate of [...initialItems, ...refreshedItems]) {
        candidate.setAttribute('aria-selected', String(candidate.getAttribute('data-mailid') === mailId));
      }
    },
  };
}

test('QQ Mail snapshots the inbox before a password submit, even from a mail detail page', async () => {
  const oldMail = createMailItem(
    'mail-old',
    'OpenAI',
    'Your OpenAI verification code',
    'Enter this code to continue: 111111'
  );
  const newMail = createMailItem(
    'mail-new',
    'OpenAI',
    'Your OpenAI verification code',
    'Enter this code to continue: 222222'
  );
  const harness = createQqMailHarness({
    detailText: 'An old OpenAI message is currently open.',
    initialItems: [oldMail],
    refreshedItems: [newMail, oldMail],
    startInInbox: false,
  });

  const snapshot = await harness.send({ type: 'SNAPSHOT_QQ_MAIL_BASELINE_V2' });
  assert.equal(snapshot.ok, true);
  assert.deepEqual([...snapshot.result.mailIds], ['mail-old']);
  assert.equal(harness.inboxClicks, 1);

  const firstCheck = await harness.send({
    type: 'CHECK_QQ_OPENAI_LOGIN_CODE_V3',
    payload: {
      baseline: { ...snapshot.result, capturedAt: Date.now() },
      checkCount: 0,
    },
  });
  assert.equal(firstCheck.ok, true);
  assert.equal(firstCheck.result.code, undefined);

  const response = await harness.send({
    type: 'CHECK_QQ_OPENAI_LOGIN_CODE_V3',
    payload: {
      baseline: { ...snapshot.result, capturedAt: Date.now() },
      checkCount: 1,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.code, '222222');
  assert.equal(response.result.mailId, 'mail-new');
  assert.equal(response.result.source, 'new-mail');
});

test('QQ Mail never falls back to an old matching verification email', async () => {
  const oldMail = createMailItem(
    'mail-old',
    'OpenAI',
    'Your OpenAI verification code',
    'Enter this code to continue: 111111'
  );
  const harness = createQqMailHarness({ initialItems: [oldMail] });
  const snapshot = await harness.send({ type: 'SNAPSHOT_QQ_MAIL_BASELINE_V2' });

  const response = await harness.send({
    type: 'CHECK_QQ_OPENAI_LOGIN_CODE_V3',
    payload: {
      baseline: { ...snapshot.result, capturedAt: Date.now() },
      checkCount: 1,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.code, undefined);
  assert.equal(response.result.candidateMailId, '');
});

test('QQ Mail does not accept a changed detail view unless it belongs to the candidate mail', async () => {
  const oldMail = createMailItem(
    'mail-old',
    'OpenAI',
    'Your OpenAI verification code',
    'Enter this code to continue: 111111'
  );
  const candidateMail = createMailItem(
    'mail-new',
    'OpenAI',
    'Your OpenAI verification code',
    'Open this message to view the code'
  );
  const harness = createQqMailHarness({
    detailText: 'A different old message has verification code 222222',
    detailMailId: 'mail-old',
    initialItems: [oldMail],
    refreshedItems: [candidateMail, oldMail],
  });
  const snapshot = await harness.send({ type: 'SNAPSHOT_QQ_MAIL_BASELINE_V2' });

  const firstCheck = await harness.send({
    type: 'CHECK_QQ_OPENAI_LOGIN_CODE_V3',
    payload: {
      baseline: { ...snapshot.result, capturedAt: Date.now() },
      checkCount: 1,
    },
  });
  assert.equal(firstCheck.ok, true);
  assert.equal(firstCheck.result.candidateMailId, 'mail-new');
  harness.openMail('mail-old');

  const secondCheck = await harness.send({
    type: 'CHECK_QQ_OPENAI_LOGIN_CODE_V3',
    payload: {
      baseline: { ...snapshot.result, capturedAt: Date.now() },
      candidateMailId: 'mail-new',
      candidateDetailFingerprint: firstCheck.result.candidateDetailFingerprint,
      checkCount: 2,
    },
  });

  assert.equal(secondCheck.ok, true);
  assert.equal(secondCheck.result.code, undefined);
  assert.equal(secondCheck.result.clearCandidate, true);
});

test('QQ Mail reads a changed detail view when it still belongs to the candidate mail', async () => {
  const oldMail = createMailItem(
    'mail-old',
    'OpenAI',
    'Your OpenAI verification code',
    'Enter this code to continue: 111111'
  );
  const candidateMail = createMailItem(
    'mail-new',
    'OpenAI',
    'Your OpenAI verification code',
    'Open this message to view the code'
  );
  const harness = createQqMailHarness({
    detailText: 'Enter this code to continue: 333333',
    detailMailId: 'mail-new',
    initialItems: [oldMail],
    refreshedItems: [candidateMail, oldMail],
  });
  const snapshot = await harness.send({ type: 'SNAPSHOT_QQ_MAIL_BASELINE_V2' });
  harness.openMail('mail-new');

  const response = await harness.send({
    type: 'CHECK_QQ_OPENAI_LOGIN_CODE_V3',
    payload: {
      baseline: { ...snapshot.result, capturedAt: Date.now() },
      candidateMailId: 'mail-new',
      candidateDetailFingerprint: '0:0',
      checkCount: 2,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.code, '333333');
  assert.equal(response.result.mailId, 'mail-new');
});

test('QQ Mail requires a baseline before it accepts a verification code', async () => {
  const harness = createQqMailHarness({
    initialItems: [createMailItem('mail-1', 'OpenAI', 'Verification code', '333333')],
  });
  const response = await harness.send({ type: 'CHECK_QQ_OPENAI_LOGIN_CODE_V3' });

  assert.equal(response.ok, true);
  assert.equal(response.result.needsFreshCode, true);
});

test('QQ Mail returns from a single check without holding a long-lived message response', async () => {
  const harness = createQqMailHarness({
    initialItems: [createMailItem('mail-old', 'OpenAI', 'Verification code', '111111')],
  });
  const response = await harness.send({
    type: 'CHECK_QQ_OPENAI_LOGIN_CODE_V3',
    payload: {
      baseline: { mailIds: ['mail-old'], capturedAt: 1 },
      checkCount: 1,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.code, undefined);
});

test('QQ Mail reports an unsigned-in mailbox without polling', async () => {
  const harness = createQqMailHarness({
    bodyText: 'QQ Mail login',
    hasPasswordInput: true,
  });
  const response = await harness.send({ type: 'CHECK_QQ_OPENAI_LOGIN_CODE_V3' });

  assert.equal(response.ok, true);
  assert.equal(response.result.needsLogin, true);
});

test('QQ Mail recognizes the QR-code login page before it waits for an inbox', async () => {
  const harness = createQqMailHarness({
    bodyText: 'QQ邮箱 扫码登录',
    hasPasswordInput: false,
  });
  const response = await harness.send({ type: 'SNAPSHOT_QQ_MAIL_BASELINE_V2' });

  assert.equal(response.ok, true);
  assert.equal(response.result.needsLogin, true);
});

test('QQ Mail rejects a cancelled run before reading a verification code', async () => {
  const harness = createQqMailHarness({
    initialItems: [createMailItem('mail-1', 'OpenAI', 'Verification code', '333333')],
  });
  const cancelled = await harness.send({
    type: 'CANCEL_QQ_OPENAI_LOGIN_CODE_V2',
    runId: 'demo-stop',
  });
  const response = await harness.send({
    type: 'CHECK_QQ_OPENAI_LOGIN_CODE_V3',
    payload: {
      runId: 'demo-stop',
      baseline: { mailIds: [], capturedAt: Date.now() },
    },
  });

  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(response.ok, false);
  assert.match(response.error, /完整演示已停止/);
});
