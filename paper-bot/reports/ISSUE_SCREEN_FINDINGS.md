# Flow/Squeeze Paper Bot — Early Historical Issue Screen

Generated from saved prospective alerts and fixed-horizon outcomes through October 10, 2026.

## Decision

The concept is not obviously nonviable, but the saved data does not support treating the current aggregate result as a demonstrated edge. Continue the prospective paper test without promoting to live trading and without optimizing thresholds against this small cohort.

## Strict Hyperliquid-origin cohort

- 52 alerts
- 22 approximate entries after confirmation/extension gates
- 30 rejected
- 45.45% winning exits
- +0.176% mean net move per approximate trade
- -0.197% median net move
- +0.141 average R
- 1.291 profit factor
- +2.83% projected account return at 1% risk
- -5.68% projected maximum drawdown

The median trade is negative despite positive mean expectancy. Returns are right-skewed and depend on a small number of winners.

## Primary issue found

Ordinary Hyperliquid Flow is approximately break-even after modeled taker fees and slippage:

- 49 alerts
- 21 approximate entries
- -0.001% mean net move
- -0.249% median net move
- -0.001 average R
- 0.998 profit factor
- -0.27% projected account return

The positive combined result is largely explained by one historical Squeeze Pressure example. The strict squeeze cohort contains only three alerts and one approximate entry, so it has no statistical weight.

## Direction asymmetry

Bullish alerts were weak:

- 16 entries
- -0.051 average R
- 0.914 profit factor
- -1.04% projected account return

Bearish alerts were stronger:

- 6 entries
- +0.651 average R
- 4.385 profit factor
- +3.91% projected account return

Six bearish entries are far too few to justify a bearish-only system, but the asymmetry must be monitored prospectively.

## Rejection gates

The rejection logic appears useful rather than arbitrary. Among the 30 rejected strict Hyperliquid alerts:

- Only 33.3% were directionally correct at 15, 60, and 240 minutes.
- Median directed return was -0.40% at 15 minutes.
- Median directed return was -0.59% at 60 minutes.
- Median directed return was -0.91% at 240 minutes.

This supports keeping the confirmation, adverse-move, and late/extended-entry gates during prospective testing.

## Exit behavior

Of 22 approximate entries:

- 11 reached the no-movement time stop.
- 4 reached the target.
- 3 reached the trailing stop.
- 3 reached the hard stop.
- 1 reached maximum hold time.

The large number of time stops is consistent with the system's purpose: reject alerts that fail to produce prompt continuation. Prospective data will show whether ten minutes is the correct window.

## Known distortions

- Saved outcomes are checkpoints, not the complete path.
- A historical stop can appear to lose much more than 1.25% because the next saved checkpoint occurs after the actual stop level. The live paper bot polls every 15 seconds and should not reproduce that artifact under normal market liquidity.
- Historical spread is unavailable and omitted. Fees and 2 bps slippage per side are included.
- Post-alert historical open-interest contraction is unavailable. Historical squeeze results therefore do not enforce the live bot's covering requirement and are an upper bound.
- Current Hyperliquid listings cannot prove that every cross-venue token was listed at the historical alert time. The primary conclusions use Hyperliquid-origin alerts only.

## Prospective questions

1. Does bullish Flow remain negative after complete 15-second observation?
2. Does bearish Flow retain its apparent advantage with a larger sample?
3. Do genuinely confirmed squeezes outperform ordinary Flow?
4. Does the asymmetric 20-minute bullish / 10-minute bearish and squeeze time stop reduce losses without discarding delayed winners?
5. Do rejected opportunities remain negative after exact rejection timestamps?
6. Are results robust across tokens rather than concentrated in one or two names?

No live-wiring decision should be made until these questions have enough prospective evidence.
