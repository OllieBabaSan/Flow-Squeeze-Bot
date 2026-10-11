const PRE_MARKET_LANGUAGE = /\b(upcoming|coming soon|will (?:be )?list(?:ed)?|to (?:be )?list(?:ed)?|scheduled (?:to|for)|trading (?:opens?|begins?|starts?))\b/i;

const TOKEN_CHAINS = {
  INF8: 'Solana (SPL)', BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', HYPE: 'Hyperliquid L1', MON: 'Monad',
  SUI: 'Sui', XRP: 'XRP Ledger', ADA: 'Cardano', AVAX: 'Avalanche', TRX: 'Tron', TON: 'TON',
};

const CHAIN_PATTERNS = [
  ['Solana (SPL)', /\bsolana\b|\bSPL token\b/i],
  ['Ethereum (ERC-20)', /\bethereum\b|\bERC[ -]?20\b/i],
  ['Base', /\bBase (?:network|chain|mainnet|L2)\b/i],
  ['Arbitrum', /\barbitrum\b/i],
  ['Optimism', /\boptimism\b|\bOP Mainnet\b/i],
  ['BNB Smart Chain (BEP-20)', /\bBNB Smart Chain\b|\bBSC\b|\bBEP[ -]?20\b/i],
  ['Avalanche', /\bavalanche\b|\bC-Chain\b/i],
  ['Sui', /\bSui (?:network|chain|mainnet)\b/i],
  ['TON', /\bTON (?:network|chain|blockchain)\b|\bThe Open Network\b/i],
  ['Monad', /\bMonad (?:network|chain|mainnet|L1)\b/i],
];

export function identifyChain({ token = '', title = '', description = '' }) {
  if (TOKEN_CHAINS[token]) return TOKEN_CHAINS[token];
  const text = `${title} ${description}`;
  return CHAIN_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || 'Not identified — verify source';
}

export function classifyMarketStatus({ eventType, token = '', title = '', description = '', market = null }) {
  const untracked = !market;
  const preMarket = eventType === 'Listing' && PRE_MARKET_LANGUAGE.test(`${title} ${description}`);
  const labels = [];
  if (untracked) labels.push('UNTRACKED');
  if (preMarket) labels.push('PRE-MARKET');
  return {
    untracked, preMarket, labels, label: labels.length ? labels.join(' · ') : 'LIVE MARKET',
    chain: identifyChain({ token, title, description }),
  };
}
