import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../lib/state-file.mjs';

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
const path = resolve(projectDir, process.env.X_SOURCE_REGISTRY || 'data/x-source-registry.json');
const registry = JSON.parse(await readFile(path, 'utf8'));
const accounts = (registry.accounts || registry).filter(account => /^[A-Za-z0-9_]{1,15}$/.test(String(account.handle || '')));
const byHandle = new Map(accounts.filter(account => account.xUserId).map(account => [String(account.handle).toLowerCase(), String(account.xUserId)]));
const unresolved = accounts.filter(account => !account.xUserId);
for (let index = 0; index < unresolved.length; index += 100) {
  const usernames = unresolved.slice(index, index + 100).map(account => account.handle).join(',');
  const response = await fetch(`https://api.x.com/2/users/by?usernames=${encodeURIComponent(usernames)}&user.fields=username,name`, {
    headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`X user lookup HTTP ${response.status}: ${await response.text()}`);
  for (const user of (await response.json()).data || []) byHandle.set(String(user.username).toLowerCase(), String(user.id));
}
const hydrated = accounts.map(account => ({ ...account, xUserId: byHandle.get(String(account.handle).toLowerCase()) || account.xUserId || '' }));
await writeJsonAtomic(path, { ...registry, xIdsHydratedAt: new Date().toISOString(), accounts: hydrated });
console.log(`Resolved ${hydrated.filter(account => account.xUserId).length}/${hydrated.length} X account IDs.`);
