export const CATALYST_FAMILIES = [
  ['security_incident', /\b(exploit(?:ed)?|hack(?:ed)?|breach|attack|drain(?:ed)?|compromis(?:e|ed)|incident|withdrawals? (?:paused|suspended)|halt(?:ed)?|outage)\b/i],
  ['partnership_integration', /\b(partner(?:s|ed|ship)?|collaborat(?:e|es|ed|ion)|integrat(?:e|es|ed|ion)|agreement|teams? up)\b/i],
  ['launch_upgrade', /\b(launch(?:es|ed)?|goes live|went live|mainnet|upgrade|deploy(?:s|ed|ment)?|release(?:s|d)?|roll(?:s|ed)? out|introduc(?:e|es|ed)|unveil(?:s|ed)?)\b/i],
  ['listing_delisting', /\b(list(?:s|ed|ing)|delist(?:s|ed|ing)|trading pair|spot market|perpetual futures?)\b/i],
  ['buyback_burn', /\b(buyback|buy back|repurchas(?:e|es|ed)|burn(?:s|ed|ing)?)\b/i],
  ['regulatory_legal', /\b(approv(?:e|es|ed|al)|regulat(?:e|es|ed|ion)|settlement|investigat(?:e|es|ed|ion)|licen[cs](?:e|es|ed|ing)|court|lawsuit|sec\b|cftc|doj)\b/i],
  ['institutional_adoption', /\b(institution(?:al|s)?|blackrock|jpmorgan|fidelity|visa|mastercard|moody(?:'s|s)?|s&p|etf|treasury|credit rating)\b/i],
  ['acquisition_investment', /\b(acquir(?:e|es|ed|ing)|acquisition|invest(?:s|ed|ment)|strategic stake|takes? a stake)\b/i],
  ['governance_tokenomics', /\b(governance|proposal|vote|tokenomics|emission|unlock|airdrop)\b/i],
  ['protocol_metrics', /\b(record|revenue|volume|tvl|users|transactions|inflows?|outflows?|fees?)\b/i],
];

export const QUALITY_KEYWORDS = [
  ['exploit', /\bexploit(?:ed)?\b/i], ['hack', /\bhack(?:ed)?\b/i], ['breach', /\bbreach\b/i],
  ['withdrawals_paused', /\bwithdrawals? (?:paused|suspended)\b/i], ['halt', /\bhalt(?:ed)?\b/i],
  ['partnership', /\bpartner(?:s|ed|ship)?\b/i], ['collaboration', /\bcollaborat(?:e|es|ed|ion)\b/i],
  ['integration', /\bintegrat(?:e|es|ed|ion)\b/i], ['launch', /\blaunch(?:es|ed)?\b/i],
  ['goes_live', /\b(?:goes|went) live\b/i], ['mainnet', /\bmainnet\b/i], ['upgrade', /\bupgrade\b/i],
  ['listing', /\blist(?:s|ed|ing)\b/i], ['delisting', /\bdelist(?:s|ed|ing)\b/i],
  ['buyback', /\b(?:buyback|buy back|repurchas(?:e|es|ed))\b/i], ['burn', /\bburn(?:s|ed|ing)?\b/i],
  ['approval', /\bapprov(?:e|es|ed|al)\b/i], ['license', /\blicen[cs](?:e|es|ed|ing)\b/i],
  ['settlement', /\bsettlement\b/i], ['investigation', /\binvestigat(?:e|es|ed|ion)\b/i],
  ['acquisition', /\b(?:acquir(?:e|es|ed|ing)|acquisition)\b/i], ['investment', /\binvest(?:s|ed|ment)\b/i],
  ['airdrop', /\bairdrop\b/i], ['governance_vote', /\b(?:governance|proposal|vote)\b/i],
  ['record_metrics', /\brecord.{0,40}\b(?:revenue|volume|tvl|users|transactions|fees)\b|\b(?:revenue|volume|tvl|users|transactions|fees).{0,40}\brecord\b/i],
];

export function classifyCatalystText(value = '') {
  const text = String(value || '');
  const families = CATALYST_FAMILIES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const keywords = QUALITY_KEYWORDS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return { families: families.length ? families : ['other'], keywords };
}

export function movementMetrics({ entryPrice, exitPrice, benchmarkEntryPrice, benchmarkExitPrice, direction = 'UNCLEAR', preEventDailyVolatilityPct = null, horizonMinutes }) {
  const rawReturnPct = ((Number(exitPrice) / Number(entryPrice)) - 1) * 100;
  const benchmarkReturnPct = Number(benchmarkEntryPrice) > 0 && Number(benchmarkExitPrice) > 0
    ? ((Number(benchmarkExitPrice) / Number(benchmarkEntryPrice)) - 1) * 100 : 0;
  const abnormalReturnPct = rawReturnPct - benchmarkReturnPct;
  const sign = direction === 'BEARISH' ? -1 : direction === 'BULLISH' ? 1 : 0;
  const directedAbnormalReturnPct = sign ? abnormalReturnPct * sign : null;
  const dailyVolatility = Number(preEventDailyVolatilityPct);
  const expectedMovePct = dailyVolatility > 0 && Number(horizonMinutes) > 0
    ? dailyVolatility * Math.sqrt(Number(horizonMinutes) / 1440) : null;
  const absoluteMovementToCatalystRatio = expectedMovePct > 0 ? Math.abs(abnormalReturnPct) / expectedMovePct : null;
  const directionalMovementToCatalystRatio = expectedMovePct > 0 && sign ? directedAbnormalReturnPct / expectedMovePct : null;
  return {
    rawReturnPct, benchmarkReturnPct, abnormalReturnPct, directedAbnormalReturnPct, expectedMovePct,
    absoluteMovementToCatalystRatio, directionalMovementToCatalystRatio,
  };
}
