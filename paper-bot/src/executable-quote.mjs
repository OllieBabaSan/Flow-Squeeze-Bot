export function quoteForNotional(book, side, notionalUsd) {
  const levels = side === 'BUY' ? book?.asks : book?.bids;
  let remaining = Number(notionalUsd);
  let quantity = 0;
  let cost = 0;
  let levelsUsed = 0;
  for (const level of levels || []) {
    if (!(remaining > 0)) break;
    const price = Number(level.price), size = Number(level.size);
    if (!(price > 0 && size > 0)) continue;
    const takeQuantity = Math.min(size, remaining / price);
    const takeCost = takeQuantity * price;
    quantity += takeQuantity;
    cost += takeCost;
    remaining -= takeCost;
    levelsUsed += 1;
  }
  const filledNotionalUsd = cost;
  return {
    side,
    requestedNotionalUsd: Number(notionalUsd),
    filledNotionalUsd,
    fillRatio: notionalUsd > 0 ? Math.min(1, filledNotionalUsd / notionalUsd) : 0,
    quantity,
    vwap: quantity > 0 ? cost / quantity : null,
    levelsUsed,
  };
}

export function summarizeBook(book, notionalUsd) {
  const bid = Number(book?.bids?.[0]?.price) || null;
  const ask = Number(book?.asks?.[0]?.price) || null;
  const mid = bid && ask ? (bid + ask) / 2 : null;
  return {
    bid,
    ask,
    mid,
    spreadBps: mid ? ((ask - bid) / mid) * 10_000 : null,
    buy: quoteForNotional(book, 'BUY', notionalUsd),
    sell: quoteForNotional(book, 'SELL', notionalUsd),
  };
}
