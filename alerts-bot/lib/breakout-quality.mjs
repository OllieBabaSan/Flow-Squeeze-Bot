export const BREAKOUT_QUALITY_VERSION = 'breakout-quality-shadow-v1';

const finite = value => Number.isFinite(Number(value));
const points = (components, name, value) => { components[name] = value; return value; };

export function evaluateBreakoutQuality({ observation = {}, market = {}, regime = {} } = {}) {
  const components = {};
  const flags = [];
  const direction = observation.direction;
  const activity = finite(observation.relativeActivity) ? Number(observation.relativeActivity) : null;
  const clearance = finite(observation.clearanceAtr) ? Number(observation.clearanceAtr) : null;
  const channelWidth = finite(observation.channelWidthAtr) ? Number(observation.channelWidthAtr) : null;
  const momentum15 = finite(observation.directedReturn15mPct) ? Number(observation.directedReturn15mPct) : null;
  const momentum60 = finite(observation.directedReturn60mPct) ? Number(observation.directedReturn60mPct) : null;
  const change24h = finite(market.change24hPct) ? Number(market.change24hPct) : null;
  const broadDirected = change24h == null ? null : change24h * (direction === 'BEARISH' ? -1 : 1);

  let score = 0;
  score += points(components, 'openInterest', observation.derivativesContext === 'EXPANDING_OPEN_INTEREST' ? 20
    : observation.derivativesContext === 'STABLE_OPEN_INTEREST' ? 8
      : observation.derivativesContext === 'CONTRACTING_OPEN_INTEREST' ? 3 : 0);
  if (observation.derivativesContext === 'UNAVAILABLE') flags.push('OPEN_INTEREST_UNAVAILABLE');

  score += points(components, 'relativeActivity', activity == null ? 0 : activity >= 1.5 ? 20 : activity >= 0.8 ? 11 : 4);
  if (activity == null) flags.push('ACTIVITY_UNAVAILABLE');
  else if (activity < 0.8) flags.push('LOW_RELATIVE_ACTIVITY');

  const momentumAligned = momentum15 != null && momentum60 != null && momentum15 > 0 && momentum60 > 0;
  score += points(components, 'trendAlignment', momentumAligned ? 16 : (momentum15 ?? -1) > 0 || (momentum60 ?? -1) > 0 ? 7 : 0);
  if (!momentumAligned) flags.push('INCOMPLETE_TREND_ALIGNMENT');
  if (broadDirected != null) {
    score += points(components, 'broadTrend', broadDirected >= 0.25 ? 12 : broadDirected <= -0.25 ? -12 : 4);
    if (broadDirected <= -0.25) flags.push('BROADER_TREND_OPPOSED');
  } else {
    components.broadTrend = 0;
    flags.push('BROAD_TREND_UNAVAILABLE');
  }

  score += points(components, 'clearance', clearance == null ? 0 : clearance >= 0.2 && clearance < 1 ? 14 : clearance >= 1 ? 5 : 2);
  if (clearance != null && clearance >= 1) flags.push('EXTENDED_CLEARANCE');
  score += points(components, 'channelStructure', channelWidth == null ? 0 : channelWidth >= 3 && channelWidth < 6 ? 10 : channelWidth < 3 ? 7 : 4);
  if (channelWidth != null && channelWidth >= 6) flags.push('WIDE_CHANNEL');

  const regimeAligned = regime.state === 'BEARISH' ? direction === 'BEARISH'
    : regime.state === 'BULLISH' ? direction === 'BULLISH' : null;
  score += points(components, 'marketRegime', regimeAligned === true ? 12 : regimeAligned === false ? -10 : regime.state === 'NEUTRAL' ? 7 : 0);
  if (regimeAligned === false) flags.push('REGIME_COUNTERTREND');

  const funding = finite(observation.fundingRate) ? Number(observation.fundingRate) : null;
  const crowdOpposed = funding != null && ((direction === 'BULLISH' && funding < -0.0001) || (direction === 'BEARISH' && funding > 0.0001));
  score += points(components, 'fundingContext', crowdOpposed ? 6 : funding == null ? 0 : 2);
  if (funding == null) flags.push('FUNDING_UNAVAILABLE');

  const frontLoaded = momentum15 != null && momentum60 != null && momentum15 >= 0.75 && momentum60 > 0 && momentum15 / momentum60 >= 0.75;
  components.reversalRisk = frontLoaded ? -10 : 0;
  score += components.reversalRisk;
  if (frontLoaded) flags.push('FRONT_LOADED_MOMENTUM');

  score = Math.max(0, Math.min(100, Math.round(score)));
  const status = score >= 70 ? 'QUALIFIED_SHADOW' : score >= 50 ? 'WATCH_SHADOW' : 'LOW_QUALITY_SHADOW';
  return {
    version: BREAKOUT_QUALITY_VERSION,
    shadowOnly: true,
    status,
    score,
    components,
    flags,
    inputs: { activity, clearance, channelWidth, momentum15, momentum60, broadDirected, regime: regime.state || 'UNKNOWN' },
  };
}
