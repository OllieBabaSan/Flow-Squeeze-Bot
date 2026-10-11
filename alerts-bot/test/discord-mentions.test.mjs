import test from 'node:test';
import assert from 'node:assert/strict';
import { roleMention } from '../lib/discord-mentions.mjs';

test('valid Discord role ID creates an explicit allowed role mention', () => {
  assert.deepEqual(roleMention('123456789012345678'), {
    content: '<@&123456789012345678>',
    allowed_mentions: { roles: ['123456789012345678'] },
  });
});

test('missing or malformed role ID suppresses all mentions', () => {
  assert.deepEqual(roleMention('Crypto-Alerts'), { allowed_mentions: { parse: [] } });
  assert.deepEqual(roleMention(''), { allowed_mentions: { parse: [] } });
});
