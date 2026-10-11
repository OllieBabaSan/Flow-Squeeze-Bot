import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { editorialUsageCost } from '../lib/project-cost.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const filename of ['.env.local', '.env.role.local']) {
  try {
    for (const raw of (await readFile(resolve(projectDir, filename), 'utf8')).split(/\r?\n/)) {
      const separator = raw.indexOf('=');
      if (separator > 0) process.env[raw.slice(0, separator).trim()] ||= raw.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
}

const now = Date.now();
const periods = { last24Hours: now - 24 * 3600_000, last7Days: now - 7 * 86400_000 };
const counts = Object.fromEntries(Object.keys(periods).map(key => [key, {
  posts: 0, accounts: new Set(), firstAt: 0, lastAt: 0,
  editorialRequests: 0, editorialCostUsd: 0, editorialInputTokens: 0, editorialOutputTokens: 0,
}]));
const editorialRates = {
  input: Number(process.env.OPENAI_INPUT_COST_PER_M || 2),
  cachedInput: Number(process.env.OPENAI_CACHED_INPUT_COST_PER_M || 0.2),
  cacheWrite: Number(process.env.OPENAI_CACHE_WRITE_COST_PER_M || 2.5),
  output: Number(process.env.OPENAI_OUTPUT_COST_PER_M || 12),
};
const input = readline.createInterface({ input: createReadStream(resolve(projectDir, 'data', 'alert-ledger.jsonl')), crlfDelay: Infinity });
for await (const line of input) {
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  const timestamp = Date.parse(event.at);
  for (const [key, start] of Object.entries(periods)) {
    if (timestamp < start) continue;
    const period = counts[key];
    if (event.type === 'news_candidate' && String(event.source || '').startsWith('X ·')) {
      period.posts += 1;
      period.accounts.add(event.source);
    } else if (['editorial_decision', 'editorial_shadow_decision'].includes(event.type) && event.usage) {
      const cost = editorialUsageCost(event.usage, editorialRates);
      period.editorialRequests += 1;
      period.editorialCostUsd += cost.usd;
      period.editorialInputTokens += cost.inputTokens;
      period.editorialOutputTokens += cost.outputTokens;
    } else continue;
    period.firstAt = period.firstAt ? Math.min(period.firstAt, timestamp) : timestamp;
    period.lastAt = Math.max(period.lastAt, timestamp);
  }
}

const costPerPost = Math.max(0, Number(process.env.X_POST_READ_COST_USD || 0.005));
const target = Math.max(1, Number(process.env.PROJECT_MONTHLY_BUDGET_USD || 50));
const fixedMonthlyCost = Math.max(0, Number(process.env.PROJECT_FIXED_MONTHLY_COST_USD || 0));
const summarize = (period, nominalDays) => {
  const observedDays = period.firstAt && period.lastAt ? Math.max((period.lastAt - period.firstAt) / 86400_000, 1 / 24) : nominalDays;
  const postsPerDay = period.posts / Math.min(nominalDays, observedDays);
  const projected30DayPostCostUsd = postsPerDay * 30 * costPerPost;
  const editorialCostPerDay = period.editorialCostUsd / Math.min(nominalDays, observedDays);
  const projected30DayEditorialCostUsd = editorialCostPerDay * 30;
  const projected30DayTotalCostUsd = projected30DayPostCostUsd + projected30DayEditorialCostUsd + fixedMonthlyCost;
  return {
    posts: period.posts, uniqueAccounts: period.accounts.size, postsPerDay: Number(postsPerDay.toFixed(1)),
    estimatedPostReadCostUsd: Number((period.posts * costPerPost).toFixed(2)),
    projected30DayPostCostUsd: Number(projected30DayPostCostUsd.toFixed(2)),
    editorialRequests: period.editorialRequests,
    editorialInputTokens: period.editorialInputTokens,
    editorialOutputTokens: period.editorialOutputTokens,
    estimatedEditorialCostUsd: Number(period.editorialCostUsd.toFixed(2)),
    projected30DayEditorialCostUsd: Number(projected30DayEditorialCostUsd.toFixed(2)),
    fixedMonthlyCostUsd: fixedMonthlyCost,
    projected30DayTotalCostUsd: Number(projected30DayTotalCostUsd.toFixed(2)),
    targetUsd: target,
    overTargetProjection: projected30DayTotalCostUsd > target,
  };
};
const report = {
  generatedAt: new Date(now).toISOString(),
  basis: 'Local X post reads plus recorded GPT-5.6 Terra token usage. Provider billing dashboards remain authoritative.',
  postReadUnitCostUsd: costPerPost,
  editorialRatesPerMillionTokensUsd: editorialRates,
  last24Hours: summarize(counts.last24Hours, 1),
  last7Days: summarize(counts.last7Days, 7),
};
console.log(JSON.stringify(report, null, 2));
if (report.last24Hours.overTargetProjection) process.exitCode = 2;
