export const BREAKOUT_QUALITY_VERSION = 'breakout-quality-shadow-v3';

const finite = value => value !== null && value !== '' && Number.isFinite(Number(value));
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
  score += points(components, 'openInterest', observation.derivativesContext === 'EXPANDING_OPEN_INTEREST' ? 12
    : observation.derivativesContext === 'CONTRACTING_OPEN_INTEREST' ? 8
      : observation.derivativesContext === 'STABLE_OPEN_INTEREST' ? 5 : 0);
  if (observation.derivativesContext === 'UNAVAILABLE') flags.push('OPEN_INTEREST_UNAVAILABLE');

  score += points(components, 'relativeActivity', activity == null ? 0 : activity >= 0.8 && activity < 2 ? 10 : activity >= 2 && activity < 3 ? 8 : activity >= 3 ? 4 : 4);
  if (activity == null) flags.push('ACTIVITY_UNAVAILABLE');
  else if (activity < 0.8) flags.push('LOW_RELATIVE_ACTIVITY');

  const momentumAligned = momentum15 != null && momentum60 != null && momentum15 > 0 && momentum60 > 0;
  score += points(components, 'trendAlignment', momentumAligned ? 14 : (momentum15 ?? -1) > 0 || (momentum60 ?? -1) > 0 ? 5 : 0);
  if (!momentumAligned) flags.push('INCOMPLETE_TREND_ALIGNMENT');
  if (broadDirected != null) {
    score += points(components, 'broadTrend', broadDirected >= 0.25 ? 12 : broadDirected <= -0.25 ? -16 : 2);
    if (broadDirected <= -0.25) flags.push('BROADER_TREND_OPPOSED');
  } else {
    components.broadTrend = 0;
    flags.push('BROAD_TREND_UNAVAILABLE');
  }

  score += points(components, 'clearance', clearance == null ? 0 : clearance >= 0.2 && clearance < 0.5 ? 14 : clearance < 1 ? 8 : clearance < 2 ? 2 : 0);
  if (clearance != null && clearance >= 1) flags.push('EXTENDED_CLEARANCE');
  score += points(components, 'channelStructure', channelWidth == null ? 0 : channelWidth >= 3 && channelWidth < 6 ? 8 : 6);
  if (channelWidth != null && channelWidth >= 6) flags.push('WIDE_CHANNEL');

  const regimeAligned = ['BEARISH', 'SEVERE_RISK_OFF'].includes(regime.state) ? direction === 'BEARISH'
    : regime.state === 'BULLISH' ? direction === 'BULLISH' : null;
  score += points(components, 'marketRegime', regime.state === 'NEUTRAL' ? 2
    : regimeAligned === true ? 14 : regimeAligned === false ? -18 : 0);
  if (regimeAligned === false) flags.push('REGIME_COUNTERTREND');
  else if (regimeAligned === true) flags.push('REGIME_ALIGNED');
  else if (regime.state === 'NEUTRAL') flags.push('REGIME_NEUTRAL');

  const funding = finite(observation.fundingRate) ? Number(observation.fundingRate) : null;
  score += points(components, 'fundingContext', funding == null ? 0 : 2);
  if (funding == null) flags.push('FUNDING_UNAVAILABLE');

  const frontLoaded = momentum15 != null && momentum60 != null && momentum15 >= 0.75 && momentum60 > 0 && momentum15 / momentum60 >= 0.75;
  // Front-loaded moves activated slightly more often in v2, but had materially
  // worse average returns and downside tails. Keep a risk penalty without
  // treating every fast move as an automatic failure.
  components.reversalRisk = frontLoaded ? -8 : 0;
  score += components.reversalRisk;
  if (frontLoaded) flags.push('FRONT_LOADED_MOMENTUM');

  score = Math.max(0, Math.min(100, Math.round(score)));
  // A high arithmetic score alone was not enough to separate v2 outcomes.
  // Qualification now requires the signal, broad trend, and market regime to
  // agree, while neutral/countertrend signals remain available for research.
  const structurallyQualified = momentumAligned && broadDirected != null && broadDirected >= 0.25
    && regimeAligned === true && clearance != null && clearance < 1;
  const status = activity == null ? 'ACTIVITY_MISSING_SHADOW'
    : structurallyQualified && score >= 65 ? 'QUALIFIED_SHADOW' : score >= 45 ? 'WATCH_SHADOW' : 'LOW_QUALITY_SHADOW';
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
