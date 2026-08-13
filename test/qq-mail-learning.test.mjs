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
  const detail = new FakeElement({ text: detailText });
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
        return !inInbox && detailText ? [detail] : [];
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
      return new Promise((resolve) => {
        assert.equal(listener(message, {}, resolve), true);
      });
    },
    get inboxClicks() {
      return inboxClicks;
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

  const response = await harness.send({
    type: 'POLL_QQ_OPENAI_LOGIN_CODE_V2',
    payload: {
      baseline: { ...snapshot.result, capturedAt: Date.now() },
      maxWaitSeconds: 6,
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
    type: 'POLL_QQ_OPENAI_LOGIN_CODE_V2',
    payload: {
      baseline: { ...snapshot.result, capturedAt: Date.now() },
      maxWaitSeconds: 1,
    },
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /本次新发/);
});

test('QQ Mail requires a baseline before it accepts a verification code', async () => {
  const harness = createQqMailHarness({
    initialItems: [createMailItem('mail-1', 'OpenAI', 'Verification code', '333333')],
  });
  const response = await harness.send({ type: 'POLL_QQ_OPENAI_LOGIN_CODE_V2' });

  assert.equal(response.ok, true);
  assert.equal(response.result.needsFreshCode, true);
});

test('QQ Mail waits for the configured number of seconds before reporting no new code', async () => {
  const harness = createQqMailHarness({
    initialItems: [createMailItem('mail-old', 'OpenAI', 'Verification code', '111111')],
  });
  const response = await harness.send({
    type: 'POLL_QQ_OPENAI_LOGIN_CODE_V2',
    payload: {
      baseline: { mailIds: ['mail-old'], capturedAt: 1 },
      maxWaitSeconds: 7,
    },
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /等待 7 秒后/);
});

test('QQ Mail reports an unsigned-in mailbox without polling', async () => {
  const harness = createQqMailHarness({
    bodyText: 'QQ Mail login',
    hasPasswordInput: true,
  });
  const response = await harness.send({ type: 'POLL_QQ_OPENAI_LOGIN_CODE_V2' });

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
    type: 'POLL_QQ_OPENAI_LOGIN_CODE_V2',
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
