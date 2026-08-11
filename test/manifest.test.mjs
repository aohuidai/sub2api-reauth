import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('manifest declares a minimal MV3 side panel extension', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background/background.js');
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.side_panel.default_path, 'sidepanel/sidepanel.html');
  assert.deepEqual(manifest.permissions, ['sidePanel', 'storage', 'scripting', 'tabs', 'webNavigation']);
  assert.equal(Object.hasOwn(manifest, 'host_permissions'), false);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
});
