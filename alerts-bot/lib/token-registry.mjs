const cache = new Map();
const CACHE_MS = 6 * 60 * 60 * 1000;

function cleanSymbol(value = '') {
  return String(value).toUpperCase().replace(/^\$/, '').replace(/[^A-Z0-9]/g, '');
}

function rank(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.MAX_SAFE_INTEGER;
}

const normalizedText = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isNativeAddressMarker = value => /^0x[eE]{40}$/.test(String(value || '').trim());

const PLATFORM_LABELS = {
  ethereum: 'Ethereum', 'binance-smart-chain': 'BNB Smart Chain', 'polygon-pos': 'Polygon',
  solana: 'Solana', base: 'Base', 'arbitrum-one': 'Arbitrum', 'optimistic-ethereum': 'Optimism',
  avalanche: 'Avalanche', sui: 'Sui', 'the-open-network': 'TON', tron: 'Tron',
};

function platformLabel(value = '') {
  const key = String(value).toLowerCase().trim();
  return PLATFORM_LABELS[key] || String(value).replaceAll('-', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function cleanContracts(platforms = {}) {
  return Object.entries(platforms).map(([platform, address]) => ({
    platform: platformLabel(platform), address: String(address || '').trim(),
  })).filter(item => item.platform && item.address && item.address.length <= 160);
}

async function coinGeckoContracts(id, fetchImpl, env = {}) {
  const request = coinGeckoRequest(env);
  const response = await fetchImpl(`${request.baseUrl}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`, {
    headers: { Accept: 'application/json', 'User-Agent': 'CryptoAlerts/2.0', ...request.headers },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return { contracts: [], contractStatus: 'unavailable', categories: [], primaryPlatform: '' };
  const payload = await response.json();
  const contracts = cleanContracts(payload.platforms || {});
  const categories = Array.isArray(payload.categories) ? payload.categories.map(String).filter(Boolean) : [];
  return { contracts, contractStatus: contracts.length ? 'verified' : payload.asset_platform_id == null ? 'native' : 'unavailable', categories, primaryPlatform: platformLabel(payload.asset_platform_id || '') };
}

async function coinMarketCapMetadata(id, apiKey, fetchImpl) {
  if (!apiKey) return { contracts: [], categories: [] };
  const response = await fetchImpl(`https://pro-api.coinmarketcap.com/v2/cryptocurrency/info?id=${encodeURIComponent(id)}`, {
    headers: { Accept: 'application/json', 'X-CMC_PRO_API_KEY': apiKey }, signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return { contracts: [], categories: [] };
  const payload = await response.json();
  const info = payload?.data?.[id] || payload?.data?.[String(id)] || {};
  const contracts = (Array.isArray(info.contract_address) ? info.contract_address : []).map(entry => ({
    platform: platformLabel(entry?.platform?.name || entry?.platform?.slug || 'Contract'),
    address: String(entry?.contract_address || '').trim(),
  })).filter(item => item.address && item.address.length <= 160);
  return { contracts, categories: Array.isArray(info.tags) ? info.tags.map(String).filter(Boolean) : [] };
}

function coinGeckoRequest(env = {}) {
  if (env.COINGECKO_PRO_API_KEY) return { baseUrl: 'https://pro-api.coingecko.com/api/v3', headers: { 'x-cg-pro-api-key': env.COINGECKO_PRO_API_KEY } };
  return { baseUrl: 'https://api.coingecko.com/api/v3', headers: env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': env.COINGECKO_API_KEY } : {} };
}

async function priceMap(ids, fetchImpl, env = {}) {
  if (!ids.length) return {};
  const request = coinGeckoRequest(env);
  const response = await fetchImpl(`${request.baseUrl}/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true`, {
    headers: { Accept: 'application/json', 'User-Agent': 'CryptoAlerts/2.0', ...request.headers }, signal: AbortSignal.timeout(12000),
  });
  return response.ok ? response.json() : {};
}

async function coinGeckoIdentity(symbol, fetchImpl, { contextText = '', referencePrice = null, env = {} } = {}) {
  const request = coinGeckoRequest(env);
  const response = await fetchImpl(`${request.baseUrl}/search?query=${encodeURIComponent(symbol)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'CryptoAlerts/2.0', ...request.headers },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const matches = (payload.coins || []).filter(coin => cleanSymbol(coin.symbol) === symbol);
  if (!matches.length) return null;
  const prices = await priceMap(matches.map(coin => coin.id), fetchImpl, env).catch(() => ({}));
  const context = normalizedText(contextText);
  const contextMatches = matches.filter(coin => context && context.includes(normalizedText(coin.name)));
  let coin = contextMatches.length === 1 ? contextMatches[0] : null;
  if (!coin && Number(referencePrice) > 0) {
    const priced = matches.map(candidate => ({ candidate, price: Number(prices[candidate.id]?.usd) }))
      .filter(item => item.price > 0)
      .sort((a, b) => Math.abs(Math.log(a.price / referencePrice)) - Math.abs(Math.log(b.price / referencePrice)));
    if (priced[0] && Math.abs(Math.log(priced[0].price / referencePrice)) <= Math.log(2)) coin = priced[0].candidate;
  }
  if (!coin && matches.length === 1) coin = matches[0];
  // Exact ticker matches are not sufficient when registries contain multiple
  // unrelated assets. Ambiguity fails closed unless name or live price resolves it.
  if (!coin) return null;
  const market = prices[coin.id] || {};
  const contractData = await coinGeckoContracts(coin.id, fetchImpl, env).catch(() => ({ contracts: [], contractStatus: 'unavailable', categories: [], primaryPlatform: '' }));
  return {
    symbol,
    name: String(coin.name || '').trim(),
    id: String(coin.id || '').trim(),
    provider: 'CoinGecko',
    marketCapRank: rank(coin.market_cap_rank) === Number.MAX_SAFE_INTEGER ? null : rank(coin.market_cap_rank),
    currentPrice: Number(market.usd) || null,
    marketCapUsd: Number(market.usd_market_cap) || null,
    volume24hUsd: Number(market.usd_24h_vol) || null,
    url: `https://www.coingecko.com/en/coins/${encodeURIComponent(String(coin.id || '').trim())}`,
    ...contractData,
  };
}

async function coinMarketCapIdentity(symbol, apiKey, fetchImpl, { contextText = '' } = {}) {
  const baseUrl = apiKey ? 'https://pro-api.coinmarketcap.com' : 'https://pro-api.coinmarketcap.com/public-api';
  const response = await fetchImpl(`${baseUrl}/v1/cryptocurrency/map?symbol=${encodeURIComponent(symbol)}&listing_status=active`, {
    headers: { Accept: 'application/json', ...(apiKey ? { 'X-CMC_PRO_API_KEY': apiKey } : {}) },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const matches = (payload.data || []).filter(entry => cleanSymbol(entry.symbol) === symbol && entry.is_active !== 0);
  const context = normalizedText(contextText);
  const named = matches.filter(entry => context && context.includes(normalizedText(entry.name)));
  const ranked = [...matches].sort((a, b) => rank(a.rank) - rank(b.rank));
  const dominant = ranked[0] && rank(ranked[0].rank) <= 500 && (!ranked[1] || rank(ranked[1].rank) > rank(ranked[0].rank) * 5) ? ranked[0] : null;
  const coin = named.length === 1 ? named[0] : matches.length === 1 ? matches[0] : dominant;
  if (!coin) return null;
  const platform = coin.platform && typeof coin.platform === 'object' ? coin.platform : null;
  const mapContracts = platform?.token_address ? [{ platform: platformLabel(platform.name || platform.slug || platform.symbol || 'Contract'), address: String(platform.token_address).trim() }] : [];
  const metadata = await coinMarketCapMetadata(coin.id, apiKey, fetchImpl).catch(() => ({ contracts: [], categories: [] }));
  const contracts = metadata.contracts.length ? metadata.contracts : mapContracts;
  return {
    symbol,
    name: String(coin.name || '').trim(),
    id: String(coin.id || '').trim(),
    provider: apiKey ? 'CoinMarketCap' : 'CoinMarketCap Public',
    marketCapRank: rank(coin.rank) === Number.MAX_SAFE_INTEGER ? null : rank(coin.rank),
    url: `https://coinmarketcap.com/currencies/${encodeURIComponent(String(coin.slug || '').trim())}/`,
    contracts,
    contractStatus: contracts.length ? 'verified' : platform == null ? 'native' : 'unavailable',
    categories: metadata.categories,
    primaryPlatform: platformLabel(platform?.name || platform?.slug || platform?.symbol || ''),
  };
}

export async function resolveTrackedToken(symbolValue, { env = process.env, fetchImpl = fetch, now = Date.now(), contextText = '', referencePrice = null } = {}) {
  const symbol = cleanSymbol(symbolValue);
  if (!symbol) return null;
  const cacheKey = `${symbol}:${normalizedText(contextText).slice(0,80)}:${Number(referencePrice) > 0 ? Number(referencePrice).toPrecision(4) : ''}`;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.checkedAt < CACHE_MS) return cached.identity;
  let identity = null;
  try { identity = await coinGeckoIdentity(symbol, fetchImpl, { contextText, referencePrice, env }); } catch {}
  if (!identity) {
    try { identity = await coinMarketCapIdentity(symbol, env.COINMARKETCAP_API_KEY, fetchImpl, { contextText }); } catch {}
  }
  cache.set(cacheKey, { checkedAt: now, identity });
  return identity;
}

export async function fetchCoinGeckoPrices(ids, { fetchImpl = fetch, env = process.env } = {}) {
  return priceMap([...new Set(ids.filter(Boolean))], fetchImpl, env);
}

export function registryLabel(identity) {
  if (!identity) return 'Unverified';
  const rankText = identity.marketCapRank ? ` · rank #${identity.marketCapRank}` : '';
  return `[${identity.name} ($${identity.symbol})](${identity.url})\nVerified by ${identity.provider}${rankText}`;
}

export function contractAddressLabel(identity, preferredChain = '') {
  if (!identity) return 'Unavailable — token identity not verified';
  const contracts = Array.isArray(identity.contracts) ? identity.contracts : [];
  if (!contracts.length) return identity.contractStatus === 'native'
    ? 'Native asset — no contract address'
    : `Not supplied by ${identity.provider}`;
  const preferred = normalizedText(preferredChain);
  const matches = (contract, wanted) => wanted && (wanted.includes(normalizedText(contract.platform)) || normalizedText(contract.platform).includes(wanted));
  const primary = normalizedText(identity.primaryPlatform);
  // Some registries list wrapped versions before the native chain. Their
  // 0xeeee... entry is a native-asset marker, not a usable token contract.
  // Honor an explicitly requested chain first; otherwise prefer the registry's
  // primary platform and then the native marker over an arbitrary wrapper.
  const contract = contracts.find(item => matches(item, preferred))
    || contracts.find(item => matches(item, primary))
    || contracts.find(item => isNativeAddressMarker(item.address))
    || contracts[0];
  if (isNativeAddressMarker(contract.address)) return `Native asset on **${contract.platform}** — no contract address`;
  return `**${contract.platform}:** \`${contract.address}\``;
}

export function hasVerifiedContract(identity) {
  return identity?.contractStatus === 'verified' && Array.isArray(identity.contracts)
    && identity.contracts.some(contract => String(contract.address || '').trim() && !isNativeAddressMarker(contract.address));
}

export function isMemeToken(identity, { title = '', description = '' } = {}) {
  const registryCategories = Array.isArray(identity?.categories) ? identity.categories.join(' ') : '';
  return /\bmeme(?:coin| coin| token|s)?\b/i.test(`${registryCategories} ${title} ${description}`);
}

export function clearTokenRegistryCache() { cache.clear(); }
