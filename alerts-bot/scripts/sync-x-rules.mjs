import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManagedRules, MANAGED_RULE_PREFIX } from '../lib/x-primary-source.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const filename of ['.env.local', '.env.role.local']) {
  try {
    for (const raw of (await readFile(resolve(projectDir, filename), 'utf8')).split(/\r?\n/)) {
      const separator = raw.indexOf('=');
      if (separator > 0) process.env[raw.slice(0, separator).trim()] ||= raw.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
}
if (!process.env.X_BEARER_TOKEN) throw new Error('X_BEARER_TOKEN is not configured');
const registry = JSON.parse(await readFile(resolve(projectDir, process.env.X_SOURCE_REGISTRY || 'data/x-source-registry.json'), 'utf8'));
const configuredAccounts = registry.accounts || registry;
const activeAccounts = configuredAccounts.filter(account => account.xUserId);
if (!activeAccounts.length) throw new Error('No hydrated X accounts are available; run radar:x-hydrate-ids first');
const rules = buildManagedRules(activeAccounts);
const endpoint = 'https://api.x.com/2/tweets/search/stream/rules';
const headers = { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`, 'Content-Type': 'application/json' };
const existingResponse = await fetch(endpoint, { headers });
if (!existingResponse.ok) throw new Error(`X rules lookup HTTP ${existingResponse.status}`);
const existing = await existingResponse.json();
const managedIds = (existing.data || []).filter(rule => String(rule.tag || '').startsWith(MANAGED_RULE_PREFIX)).map(rule => rule.id);
if (managedIds.length) {
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ delete: { ids: managedIds } }) });
  if (!response.ok) throw new Error(`X rules delete HTTP ${response.status}`);
}
for (let index = 0; index < rules.length; index += 25) {
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ add: rules.slice(index, index + 25) }) });
  if (!response.ok) throw new Error(`X rules add HTTP ${response.status}: ${await response.text()}`);
}
console.log(`Installed ${rules.length} managed X rules for ${activeAccounts.length} accounts (${configuredAccounts.length - activeAccounts.length} unresolved handles skipped).`);
