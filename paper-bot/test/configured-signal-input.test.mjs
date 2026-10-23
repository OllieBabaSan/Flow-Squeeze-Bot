import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('automation accepts an explicit parent signal path instead of requiring a sibling checkout', async () => {
  const source = await readFile(new URL('../scripts/run-paper.mjs', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.FLOW_SIGNAL_FILE/);
  assert.match(source, /argumentValue\('--signal-file'\)/);
  assert.doesNotMatch(source, /const signalPath = resolve\(projectDir, config\.signalFile\)/);
});
