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
if (!process.env.COINMARKETCAP_API_KEY) throw new Error('COINMARKETCAP_API_KEY is not configured');

const target = Math.max(50, Math.min(1200, Number(process.env.X_SOURCE_TARGET || 600)));
const curatedInfrastructure = [
  ['near_intents', 'NEAR', 'NEAR Intents', 'bridge'],
  ['coinbase', '', 'Coinbase', 'exchange'], ['krakenfx', '', 'Kraken', 'exchange'],
  ['binance', '', 'Binance', 'exchange'], ['Bybit_Official', '', 'Bybit', 'exchange'],
  ['okx', '', 'OKX', 'exchange'], ['BitgetGlobal', '', 'Bitget', 'exchange'],
  ['Gemini', '', 'Gemini', 'exchange'], ['RobinhoodApp', '', 'Robinhood', 'exchange'],
  ['HyperliquidX', 'HYPE', 'Hyperliquid', 'perp-dex'], ['GMX_IO', 'GMX', 'GMX', 'perp-dex'],
  ['dYdX', 'DYDX', 'dYdX', 'perp-dex'], ['Aster_DEX', '', 'Aster', 'perp-dex'],
  ['Lighter_xyz', '', 'Lighter', 'perp-dex'], ['JupiterExchange', 'JUP', 'Jupiter', 'dex'],
  ['wormhole', 'W', 'Wormhole', 'bridge'], ['LayerZero_Core', 'ZRO', 'LayerZero', 'bridge'],
  ['AcrossProtocol', 'ACX', 'Across', 'bridge'], ['StargateFinance', 'STG', 'Stargate', 'bridge'],
  ['SynapseProtocol', 'SYN', 'Synapse', 'bridge'], ['deBridgeFinance', 'DBR', 'deBridge', 'bridge'],
  ['lifiprotocol', '', 'LI.FI', 'bridge'], ['FireblocksHQ', '', 'Fireblocks', 'custody'],
  ['BitGo', '', 'BitGo', 'custody'], ['Anchorage', '', 'Anchorage Digital', 'custody'],
  ['CopperHQ', '', 'Copper', 'custody'], ['BlackRock', '', 'BlackRock', 'institution'],
  ['Fidelity', '', 'Fidelity', 'institution'], ['Grayscale', '', 'Grayscale', 'institution'],
  ['BitwiseInvest', '', 'Bitwise', 'institution'], ['SECGov', '', 'SEC', 'regulator'],
  ['CFTC', '', 'CFTC', 'regulator'], ['FDICgov', '', 'FDIC', 'regulator'],
  ['The_DTCC', '', 'DTCC', 'market-infrastructure'], ['Visa', '', 'Visa', 'payments'],
  ['Mastercard', '', 'Mastercard', 'payments'], ['PayPal', '', 'PayPal', 'payments'],
].map(([handle, symbol, name, category]) => ({ handle, symbol, name, category, tier: 'B', curated: true, tags: [category] }));
const headers = { 'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY, Accept: 'application/json' };
const api = async url => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`CoinMarketCap HTTP ${response.status}: ${await response.text()}`);
  return response.json();
};
const listings = (await api(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?start=1&limit=${Math.min(5000, target * 3)}&convert=USD`)).data || [];
const stable = row => (row.tags || []).some(tag => /stablecoin/i.test(String(tag))) || /(?:USD|EUR|GBP)\s*(?:coin|stable)/i.test(row.name || '');
const utilityMeme = row => (row.tags || []).some(tag => /(?:mineable|payments|layer-1|platform|ecosystem|smart-contracts)/i.test(String(tag)));
const eligible = listings.filter(row => !stable(row) && (!(row.tags || []).some(tag => /memes?/i.test(String(tag))) || utilityMeme(row)));
const details = {};
for (let index = 0; index < eligible.length; index += 100) {
  const ids = eligible.slice(index, index + 100).map(row => row.id).join(',');
  Object.assign(details, (await api(`https://pro-api.coinmarketcap.com/v2/cryptocurrency/info?id=${ids}&aux=urls,logo,description,tags`)).data || {});
}
const handleFrom = urls => {
  for (const url of urls?.twitter || []) {
    const match = String(url).match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i);
    if (match && /^[A-Za-z0-9_]{1,15}$/.test(match[1]) && !['intent', 'share', 'home'].includes(match[1].toLowerCase())) return match[1];
  }
  return '';
};
let previousAccounts = [];
try { previousAccounts = JSON.parse(await readFile(resolve(projectDir, process.env.X_SOURCE_REGISTRY || 'data/x-source-registry.json'), 'utf8')).accounts || []; } catch {}
const previousIds = new Map(previousAccounts.filter(account => account.xUserId).map(account => [String(account.handle).toLowerCase(), account.xUserId]));
const seen = new Set();
const cmcAccounts = eligible.map(row => ({ row, info: details[row.id] || {}, handle: handleFrom(details[row.id]?.urls) }))
  .filter(entry => entry.handle && !seen.has(entry.handle.toLowerCase()) && seen.add(entry.handle.toLowerCase()))
  .map((entry, index) => ({
    handle: entry.handle,
    symbol: String(entry.row.symbol || '').toUpperCase(),
    name: entry.row.name,
    cmcId: entry.row.id,
    cmcRank: entry.row.cmc_rank,
    tier: index < 100 ? 'A' : 'B',
    tags: (entry.row.tags || []).slice(0, 12),
  }));
const accounts = [];
const selected = new Set();
const add = account => {
  const key = account.handle.toLowerCase();
  if (accounts.length >= target || selected.has(key)) return;
  selected.add(key);
  accounts.push({ ...account, xUserId: previousIds.get(key) || account.xUserId || '' });
};
cmcAccounts.filter(account => account.tier === 'A').forEach(add);
curatedInfrastructure.forEach(add);
cmcAccounts.filter(account => account.tier === 'B').forEach(add);
await writeJsonAtomic(resolve(projectDir, process.env.X_SOURCE_REGISTRY || 'data/x-source-registry.json'), {
  generatedAt: new Date().toISOString(), target, accounts,
  policy: { tierA: 'All original posts', tierB: 'Catalyst-keyword posts', stablecoinsExcluded: true, utilityMemesRetained: true, curatedInfrastructureIncluded: true },
});
console.log(`Wrote ${accounts.length} official X accounts (${accounts.filter(row => row.tier === 'A').length} Tier A, ${accounts.filter(row => row.tier === 'B').length} Tier B).`);
