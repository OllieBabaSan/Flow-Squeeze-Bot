const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function editorialUsageCost(usage = {}, rates = {}) {
  const inputTokens = number(usage.input_tokens);
  const outputTokens = number(usage.output_tokens);
  const cacheWriteTokens = Math.min(inputTokens, number(usage.input_tokens_details?.cache_write_tokens));
  const cachedTokens = Math.min(inputTokens - cacheWriteTokens, number(usage.input_tokens_details?.cached_tokens));
  const uncachedTokens = Math.max(0, inputTokens - cacheWriteTokens - cachedTokens);
  const perMillion = {
    input: number(rates.input ?? 2),
    cachedInput: number(rates.cachedInput ?? 0.2),
    cacheWrite: number(rates.cacheWrite ?? 2.5),
    output: number(rates.output ?? 12),
  };
  const usd = (
    uncachedTokens * perMillion.input
    + cachedTokens * perMillion.cachedInput
    + cacheWriteTokens * perMillion.cacheWrite
    + outputTokens * perMillion.output
  ) / 1_000_000;
  return {
    usd,
    inputTokens,
    uncachedTokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens,
  };
}
