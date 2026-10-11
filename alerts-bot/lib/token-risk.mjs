const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

const CHAIN_IDS = {
  ethereum: '1', 'bnb smart chain': '56', bnb: '56', polygon: '137',
  avalanche: '43114', arbitrum: '42161', optimism: '10', base: '8453',
  fantom: '250', cronos: '25', linea: '59144', scroll: '534352',
};

const HARD_FLAGS = {
  is_honeypot: 'honeypot behavior',
  cannot_buy: 'buying restricted',
  cannot_sell_all: 'full position cannot be sold',
  is_blacklisted: 'blacklist controls',
  transfer_pausable: 'transfers can be paused',
  owner_change_balance: 'owner can change holder balances',
  hidden_owner: 'hidden owner privileges',
  selfdestruct: 'contract can self-destruct',
  personal_slippage_modifiable: 'owner can alter wallet-specific slippage',
  slippage_modifiable: 'owner can alter trading slippage',
};

const flag = value => String(value ?? '') === '1';
const tax = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function evaluateTokenSecurity(data = {}) {
  const blockers = [];
  const warnings = [];
  for (const [field, label] of Object.entries(HARD_FLAGS)) if (flag(data[field])) blockers.push(label);
  const buyTax = tax(data.buy_tax);
  const sellTax = tax(data.sell_tax);
  if (buyTax != null && buyTax >= 0.1) blockers.push(`buy tax ${(buyTax * 100).toFixed(1)}%`);
  if (sellTax != null && sellTax >= 0.1) blockers.push(`sell tax ${(sellTax * 100).toFixed(1)}%`);
  if (String(data.is_open_source ?? '') === '0') blockers.push('contract source is not open');
  if (flag(data.is_mintable)) warnings.push('token supply is mintable');
  if (flag(data.is_proxy)) warnings.push('upgradeable proxy contract');
  const liquidity = Array.isArray(data.dex) ? data.dex.reduce((sum, venue) => sum + (Number(venue?.liquidity) || 0), 0) : null;
  return { blocked: blockers.length > 0, riskLevel: blockers.length ? 'HIGH' : warnings.length ? 'ELEVATED' : 'LOW', blockers, warnings, liquidityUsd: liquidity };
}

const normalizedPlatform = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function checkTokenRisk(identity, { fetchImpl = fetch, now = Date.now() } = {}) {
  const primaryPlatform = normalizedPlatform(identity?.primaryPlatform);
  const contracts = (identity?.contracts || []).map(contract => ({
    ...contract,
    normalizedPlatform: normalizedPlatform(contract.platform),
    chainId: CHAIN_IDS[normalizedPlatform(contract.platform)],
    address: String(contract.address || '').trim().toLowerCase(),
  })).filter(contract => contract.chainId && /^0x[a-f0-9]{40}$/.test(contract.address));
  if (!contracts.length) return { checked: false, blocked: false, riskLevel: 'NOT_APPLICABLE', reason: 'no_supported_contract', contracts: [] };

  const results = await Promise.all(contracts.map(async contract => {
    const key = `${contract.chainId}:${contract.address}`;
    let cached = cache.get(key);
    if (!cached || now - cached.checkedAt >= CACHE_MS) {
      try {
        const response = await fetchImpl(`https://api.gopluslabs.io/api/v1/token_security/${contract.chainId}?contract_addresses=${encodeURIComponent(contract.address)}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'CryptoAlerts/3.0' }, signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const data = payload?.result?.[contract.address] || payload?.result?.[contract.address.toLowerCase()] || Object.values(payload?.result || {})[0];
        if (!data) throw new Error('empty security result');
        cached = { checkedAt: now, assessment: evaluateTokenSecurity(data) };
        cache.set(key, cached);
      } catch (error) {
        cached = { checkedAt: now, assessment: { blocked: false, riskLevel: 'UNKNOWN', blockers: [], warnings: [], error: error instanceof Error ? error.message : String(error) } };
        cache.set(key, cached);
      }
    }
    return { platform: contract.platform, address: contract.address, ...cached.assessment };
  }));
  const hasDeclaredPrimary = Boolean(primaryPlatform);
  const primaryResults = hasDeclaredPrimary
    ? results.filter(result => normalizedPlatform(result.platform) === primaryPlatform)
    : results;
  const secondaryResults = hasDeclaredPrimary
    ? results.filter(result => normalizedPlatform(result.platform) !== primaryPlatform)
    : [];
  const blockers = primaryResults.flatMap(result => result.blockers.map(reason => `${result.platform}: ${reason}`));
  const warnings = [
    ...results.flatMap(result => result.warnings.map(reason => `${result.platform}: ${reason}`)),
    ...secondaryResults.flatMap(result => result.blockers.map(reason => `${result.platform} secondary contract: ${reason}`)),
  ];
  const checked = results.some(result => result.riskLevel !== 'UNKNOWN');
  return {
    checked,
    blocked: blockers.length > 0,
    riskLevel: blockers.length ? 'HIGH' : checked ? (warnings.length ? 'ELEVATED' : 'LOW') : 'UNKNOWN',
    blockers,
    warnings,
    contracts: results,
  };
}

export function clearTokenRiskCache() { cache.clear(); }
