import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('popup keeps its content in an internal scroll region and shows one learning step at a time', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../popup/popup.html', import.meta.url), 'utf8'),
    readFile(new URL('../popup/popup.css', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /data-popup-view-button="connection"/);
  assert.match(html, /data-popup-view-button="flow"/);
  assert.match(html, /data-learning-step-panel="10"/);
  assert.match(css, /height: 600px;/);
  assert.match(css, /\.popup-main\s*\{[\s\S]*?overflow-y: auto;/);
  assert.match(css, /\.learning-step\[hidden\]\s*\{[\s\S]*?display: none;/);
});
