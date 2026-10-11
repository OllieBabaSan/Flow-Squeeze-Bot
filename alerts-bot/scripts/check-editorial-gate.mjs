import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewEditorialCandidate } from '../lib/editorial-gate.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const filename of ['.env.local', '.env.role.local']) {
  try {
    const text = await readFile(resolve(projectDir, filename), 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      process.env[key] ||= value;
    }
  } catch {}
}

const now = new Date().toISOString();
const cases = [
  {
    name: 'incidental-hyperliquid', expectedApproved: false,
    signal: { tokens:['HYPE'], title:'Robinhood engineers charged with fraud after trades executed on Hyperliquid', source:'Connection test', publishedAt:now, eventType:'Legal / enforcement', direction:'BEARISH' },
    article: { title:'Robinhood engineers charged with fraud after trades executed on Hyperliquid', source:'Connection test', description:'Authorities charged two Robinhood engineers with fraud. Their personal trades used Hyperliquid, which was not accused of wrongdoing.' },
  },
  {
    name: 'limewire-wrong-jst', expectedApproved: false,
    signal: { tokens:['JST'], title:'Remember LimeWire? A Meme Coin Just Bought the Legacy P2P Brand', source:'Bitcoin News', publishedAt:now, eventType:'Acquisition / strategic investment', direction:'BULLISH' },
    article: { title:'Remember LimeWire? A Meme Coin Just Bought the Legacy P2P Brand', source:'Bitcoin News', description:'BabyDoge acquired LimeWire. LMWR remains the platform native utility token. The word just is ordinary English and does not refer to JST.' },
  },
  {
    name: 'limewire-correct-lmwr', expectedApproved: true,
    signal: { tokens:['LMWR'], title:'Remember LimeWire? A Meme Coin Just Bought the Legacy P2P Brand', source:'Bitcoin News', publishedAt:now, eventType:'Acquisition / strategic investment', direction:'BULLISH' },
    article: { title:'Remember LimeWire? A Meme Coin Just Bought the Legacy P2P Brand', source:'Bitcoin News', description:'BabyDoge acquired LimeWire. As part of the acquisition, LMWR becomes the native utility token of the LimeWire platform for decentralized storage and AI tools.' },
  },
];

let failed = false;
for (const testCase of cases) {
  const result = await reviewEditorialCandidate({ signal:testCase.signal, article:testCase.article, recentAlerts:[] });
  console.log(JSON.stringify({
    case: testCase.name,
    connected: !String(result.reason).startsWith('openai_') && !String(result.reason).startsWith('editorial_error') && result.reason !== 'missing_openai_api_key',
    expectedApproved: testCase.expectedApproved,
    approved: result.approved,
    reason: result.reason,
    relationship: result.verdict?.relationship || null,
    affectedAsset: result.verdict?.affected_asset || null,
    novelty: result.verdict?.novelty || null,
    direction: result.verdict?.direction || null,
    confidence: result.verdict?.confidence ?? null,
    usage: result.usage || null,
  }, null, 2));
  if (result.approved !== testCase.expectedApproved) failed = true;
}

if (failed) process.exitCode = 2;
