import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCapturedCallbackState,
  createPendingCallbackCaptureState,
  isLocalhostCallbackUrl,
  normalizeVerificationCode,
  pollFreshVerificationCode,
} from '../background/openai-learning.js';

test('only treats http(s) localhost addresses as OAuth callback candidates', () => {
  assert.equal(isLocalhostCallbackUrl('http://localhost:1455/auth/callback?code=test'), true);
  assert.equal(isLocalhostCallbackUrl('https://localhost/callback'), true);
  assert.equal(isLocalhostCallbackUrl('https://example.com/?next=localhost'), false);
  assert.equal(isLocalhostCallbackUrl('http://127.0.0.1/callback'), false);
  assert.equal(isLocalhostCallbackUrl('not a url'), false);
});

test('creates session-safe callback capture states', () => {
  assert.deepEqual(createPendingCallbackCaptureState(100), {
    active: true,
    callbackUrl: '',
    startedAt: 100,
    capturedAt: null,
  });
  assert.deepEqual(createCapturedCallbackState('http://localhost:1455/callback?code=abc', 200), {
    active: false,
    callbackUrl: 'http://localhost:1455/callback?code=abc',
    startedAt: null,
    capturedAt: 200,
  });
});

test('uses an injected mailbox adapter instead of storing mailbox credentials', async () => {
  const result = await pollFreshVerificationCode(8, { email: 'ignored@example.com' }, {
    fetchLatestCode: async ({ step, state }) => {
      assert.equal(step, 8);
      assert.equal(state.email, 'ignored@example.com');
      return { code: ' 123456 ', emailTimestamp: 1234 };
    },
  });

  assert.deepEqual(result, { code: '123456', emailTimestamp: 1234 });
  assert.equal(normalizeVerificationCode(' A1 b2 '), 'A1b2');
  await assert.rejects(
    pollFreshVerificationCode(8, {}, null),
    /未配置邮箱读取器/
  );
});
