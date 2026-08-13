import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('side panel exposes a single full-demo command and keeps its layout inside a resizable side panel', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../sidepanel/sidepanel.html', import.meta.url), 'utf8'),
    readFile(new URL('../sidepanel/sidepanel.css', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="run-full-demo"/);
  assert.match(html, /id="stop-full-demo"/);
  assert.match(html, /id="demo-rounds"[^>]*min="1"[^>]*max="50"/);
  assert.match(html, /id="mail-wait-seconds"[^>]*min="1"[^>]*max="600"[^>]*value="60"/);
  assert.match(html, /id="result-count"[^>]*>邮箱总数 0</);
  assert.match(html, /id="full-demo-progress"/);
  assert.match(html, /id="full-demo-progress-count"/);
  assert.match(html, /id="full-demo-progress-bar"/);
  assert.match(html, /id="full-demo-progress-skipped"/);
  assert.match(html, />演示完整流程</);
  assert.match(css, /\.full-demo-button/);
  assert.match(css, /\.stop-demo-button/);
  assert.match(css, /\.demo-rounds-field/);
  assert.match(css, /\.mail-wait-field/);
  assert.match(css, /\.full-demo-progress/);
  assert.match(css, /\.full-demo-progress-track/);
  assert.match(css, /html,\s*body\s*\{[\s\S]*?width:\s*100%[\s\S]*?min-width:\s*0/);
  assert.doesNotMatch(css, /body\s*\{[\s\S]*?min-width:\s*320px/);
  assert.doesNotMatch(css, /body\s*\{[\s\S]*?overflow-x:\s*hidden/);
  assert.match(css, /\.app-shell\s*\{[\s\S]*?width:\s*100%[\s\S]*?min-width:\s*0/);
  assert.doesNotMatch(css, /\.app-shell\s*\{[\s\S]*?max-width:\s*720px/);
  assert.match(css, /@media \(max-width:\s*540px\)[\s\S]*?\.step-controls\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
});
