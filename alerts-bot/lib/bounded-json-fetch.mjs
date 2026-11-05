const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function fetchJsonBounded(items, request, {
  concurrency = 8,
  retries = 2,
  retryBaseMs = 150,
} = {}) {
  const input = [...items];
  const results = new Array(input.length);
  const attemptsByItem = new Array(input.length).fill(0);
  let cursor = 0;
  const requestedConcurrency = Number(concurrency);
  const workerCount = Math.min(Number.isFinite(requestedConcurrency) ? Math.max(1, Math.trunc(requestedConcurrency)) : 8, input.length || 1);
  const maximumRetries = Number.isFinite(Number(retries)) ? Math.max(0, Math.trunc(Number(retries))) : 2;

  async function worker() {
    while (cursor < input.length) {
      const index = cursor++;
      let lastError;
      for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
        attemptsByItem[index] += 1;
        try {
          results[index] = { status: 'fulfilled', value: await request(input[index], index, attempt) };
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < maximumRetries && error?.retryable !== false) await sleep(retryBaseMs * (2 ** attempt) + Math.floor(Math.random() * 50));
          else break;
        }
      }
      if (lastError) results[index] = { status: 'rejected', reason: lastError };
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    results,
    attemptsByItem,
    attempts: attemptsByItem.reduce((sum, count) => sum + count, 0),
    retriesUsed: attemptsByItem.reduce((sum, count) => sum + Math.max(0, count - 1), 0),
  };
}
