# Time-Stop Comparison

## Rationale

The initial paper rule allowed ten minutes for every trade to show at least 0.25% favorable progress. A behavioral hypothesis suggested that ordinary bullish Flow may require more time to develop than bearish Flow, while a confirmed squeeze should resolve promptly.

Saved Hyperliquid-origin trades that hit the original ten-minute time stop showed:

- Bullish cohort: negative at 15 minutes, but 4 of 7 positive by 30 minutes; mean +0.45% and median +0.40% at 30 minutes relative to approximate entry.
- Bearish cohort: no meaningful improvement by 30 minutes and deterioration by 60 minutes.

The prospective configuration is therefore:

- Bullish ordinary Flow: 20-minute no-movement window
- Bearish ordinary Flow: 10-minute no-movement window
- Bullish or bearish Squeeze Pressure: 10-minute no-movement window

## Coarse historical comparison

Strict Hyperliquid-origin cohort, 52 alerts and 22 approximate entries:

| Metric | Universal 10 minutes | Asymmetric 20/10/10 |
|---|---:|---:|
| Win rate | 45.45% | 54.55% |
| Mean net move | +0.176% | +0.447% |
| Median net move | -0.197% | +0.079% |
| Average R | +0.141 | +0.358 |
| Profit factor | 1.291 | 1.709 |
| Projected return at 1% risk | +2.83% | +7.80% |
| Projected maximum drawdown | -5.68% | -5.52% |

Strict ordinary Flow changed from profit factor 0.998 to 1.429. Bullish alerts changed from profit factor 0.914 and projected -1.04% return to profit factor 1.398 and projected +3.74% return.

## Interpretation warning

This is an exploratory, post-observation change. It was proposed after looking at system behavior and then evaluated on the same historical cohort. The improved result may be real, but it may also be overfit. It must be validated on the prospective paper cohort without further threshold adjustment.

The saved checkpoints are at 15 and 30 minutes rather than exactly 20 minutes, so the historical simulator exits at the first available checkpoint at or after the configured time. The live paper monitor evaluates every 15 seconds and will apply the actual 20-minute rule.

No claim of live readiness should use this retrospective improvement by itself.
