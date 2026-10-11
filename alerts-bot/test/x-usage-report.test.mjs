import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('X stream avoids redundant author expansion reads', async () => {
  const source = await readFile(new URL('../lib/x-primary-source.mjs', import.meta.url), 'utf8');
  const expansion = source.match(/expansions:\s*'([^']+)'/)?.[1] || '';
  assert.doesNotMatch(expansion, /(?:^|,)author_id(?:,|$)/);
  assert.doesNotMatch(source, /'user\.fields'/);
});
