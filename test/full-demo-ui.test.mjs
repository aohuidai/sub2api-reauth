import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('side panel exposes a single full-demo command', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../sidepanel/sidepanel.html', import.meta.url), 'utf8'),
    readFile(new URL('../sidepanel/sidepanel.css', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="run-full-demo"/);
  assert.match(html, />演示完整流程</);
  assert.match(css, /\.full-demo-button/);
});
