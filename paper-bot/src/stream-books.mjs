import { normalizeOrderbook } from './dydx.mjs';

function levelMap(rows = []) {
  return new Map(rows.map(row => [String(row.price), Number(row.size)]).filter(([, size]) => size > 0));
}

function mapBook(bids, asks) {
  return {
    bids: [...bids].map(([price, size]) => ({ price: Number(price), size })).filter(x => x.price > 0 && x.size > 0).sort((a, b) => b.price - a.price),
    asks: [...asks].map(([price, size]) => ({ price: Number(price), size })).filter(x => x.price > 0 && x.size > 0).sort((a, b) => a.price - b.price),
  };
}

export function applyDydxDelta(current, contents, snapshot = false) {
  const next = snapshot || !current
    ? { bids: levelMap(normalizeOrderbook({ bids: contents?.bids || [] }).bids), asks: levelMap(normalizeOrderbook({ asks: contents?.asks || [] }).asks) }
    : { bids: new Map(current.bids), asks: new Map(current.asks) };
  if (!snapshot) {
    for (const [side, rows] of [['bids', contents?.bids], ['asks', contents?.asks]]) {
      for (const row of rows || []) {
        const price = String(row?.price ?? row?.[0]);
        const size = Number(row?.size ?? row?.[1]);
        if (size > 0) next[side].set(price, size); else next[side].delete(price);
      }
    }
  }
  return next;
}

export class ReconnectingStream {
  constructor(url, onBook, {
    connectTimeoutMs = 30_000,
    staleTimeoutMs = 90_000,
    watchdogIntervalMs = 15_000,
  } = {}) {
    this.url = url;
    this.onBook = onBook;
    this.subscriptions = new Set();
    this.books = new Map();
    this.connected = false;
    this.closed = false;
    this.reconnects = 0;
    this.consecutiveReconnects = 0;
    this.lastClose = null;
    this.connectTimeoutMs = connectTimeoutMs;
    this.staleTimeoutMs = staleTimeoutMs;
    this.watchdogIntervalMs = watchdogIntervalMs;
    this.connectionStartedAtMs = 0;
    this.lastMessageAtMs = 0;
    this.watchdogRestarts = 0;
    this.lastWatchdogRestart = null;
    this.connectionGeneration = 0;
  }
  start() {
    this.closed = false;
    if (!this.connected && this.socket?.readyState !== WebSocket.CONNECTING) this.connect();
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => this.checkHealth(), this.watchdogIntervalMs);
    return this;
  }
  connect() {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    const generation = ++this.connectionGeneration;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.connectionStartedAtMs = Date.now();
    this.lastMessageAtMs = 0;
    socket.onopen = () => {
      if (generation !== this.connectionGeneration) return;
      this.connected = true;
      this.connectionStartedAtMs = Date.now();
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = setTimeout(() => { this.consecutiveReconnects = 0; }, 60_000);
      for (const symbol of this.subscriptions) this.sendSubscribe(symbol);
      this.onOpen?.();
    };
    socket.onmessage = event => {
      if (generation !== this.connectionGeneration) return;
      this.lastMessageAtMs = Date.now();
      try { this.handle(JSON.parse(event.data)); } catch {}
    };
    socket.onerror = () => {};
    socket.onclose = event => {
      if (generation !== this.connectionGeneration) return;
      this.connected = false;
      this.socket = null;
      clearTimeout(this.stabilityTimer);
      this.lastClose = { at: new Date().toISOString(), code: event?.code ?? null, reason: event?.reason || null };
      if (!this.closed) this.scheduleReconnect();
    };
  }
  scheduleReconnect(delayMs = Math.min(30_000, 1000 * 2 ** Math.min(this.consecutiveReconnects + 1, 5))) {
    if (this.closed || this.reconnectTimer) return;
    this.reconnects += 1;
    this.consecutiveReconnects += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
  checkHealth(now = Date.now()) {
    if (this.closed || this.subscriptions.size === 0) return;
    const connectingTooLong = this.socket?.readyState === WebSocket.CONNECTING
      && now - this.connectionStartedAtMs > this.connectTimeoutMs;
    const referenceAtMs = this.lastMessageAtMs || this.connectionStartedAtMs;
    const streamStale = this.connected && referenceAtMs > 0 && now - referenceAtMs > this.staleTimeoutMs;
    if (connectingTooLong || streamStale || (!this.connected && !this.socket && !this.reconnectTimer)) {
      this.forceReconnect(connectingTooLong ? 'CONNECT_TIMEOUT' : streamStale ? 'STALE_STREAM' : 'DISCONNECTED_WITHOUT_RETRY');
    }
  }
  forceReconnect(reason) {
    if (this.closed) return;
    const staleSocket = this.socket;
    this.connected = false;
    this.socket = null;
    this.connectionGeneration += 1;
    clearInterval(this.pingTimer);
    clearTimeout(this.stabilityTimer);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.watchdogRestarts += 1;
    this.lastWatchdogRestart = { at: new Date().toISOString(), reason };
    try { staleSocket?.close(); } catch {}
    this.scheduleReconnect(0);
  }
  subscribe(symbol) {
    const existed = this.subscriptions.has(symbol);
    this.subscriptions.add(symbol);
    if (this.connected && !existed) this.sendSubscribe(symbol);
  }
  close() {
    this.closed = true;
    this.connected = false;
    clearInterval(this.pingTimer);
    clearInterval(this.watchdogTimer);
    clearTimeout(this.stabilityTimer);
    clearTimeout(this.reconnectTimer);
    try { this.socket?.close(); } catch {}
  }
  get(symbol) { return this.books.get(symbol) || null; }
}

function stableShard(key, count) {
  let hash = 2166136261;
  for (const char of String(key)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return Math.abs(hash) % count;
}

export class StreamPool {
  constructor(count, factory, { lazy = false } = {}) {
    this.streams = Array.from({ length: count }, (_, index) => factory(index));
    this.lazy = lazy;
    this.activeShards = new Set();
  }
  start() {
    if (!this.lazy) for (const [index, stream] of this.streams.entries()) { this.activeShards.add(index); stream.start(); }
    return this;
  }
  subscribe(symbol) {
    const index = stableShard(symbol, this.streams.length);
    const stream = this.streams[index];
    stream.subscribe(symbol);
    if (!this.activeShards.has(index)) { this.activeShards.add(index); stream.start(); }
  }
  unsubscribe(symbol) {
    const index = stableShard(symbol, this.streams.length);
    const stream = this.streams[index];
    stream.subscriptions.delete(symbol);
    stream.books.delete(symbol);
    if (stream.rawBooks) stream.rawBooks.delete(symbol);
    if (this.lazy && stream.subscriptions.size === 0) { stream.close(); this.activeShards.delete(index); }
  }
  get(symbol) { return this.streams[stableShard(symbol, this.streams.length)].get(symbol); }
  close() { for (const stream of this.streams) stream.close(); }
  get connected() { return [...this.activeShards].every(index => this.streams[index].connected); }
  get reconnects() { return this.streams.reduce((sum, stream) => sum + stream.reconnects, 0); }
  get details() {
    return this.streams.map((stream, index) => ({
      index, active: this.activeShards.has(index), connected: stream.connected, subscriptions: stream.subscriptions.size,
      books: stream.books.size, reconnects: stream.reconnects,
      consecutiveReconnects: stream.consecutiveReconnects, lastClose: stream.lastClose,
      lastMessageAt: stream.lastMessageAtMs ? new Date(stream.lastMessageAtMs).toISOString() : null,
      watchdogRestarts: stream.watchdogRestarts, lastWatchdogRestart: stream.lastWatchdogRestart,
    }));
  }
}

export class HyperliquidBookStream extends ReconnectingStream {
  constructor(onBook, options) { super('wss://api.hyperliquid.xyz/ws', onBook, options); }
  onOpen() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => { if (this.connected) this.socket.send(JSON.stringify({ method: 'ping' })); }, 30_000);
  }
  sendSubscribe(symbol) { this.socket.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: symbol } })); }
  handle(message) {
    if (message?.channel !== 'l2Book') return;
    const data = message.data;
    const book = {
      bids: (data?.levels?.[0] || []).map(row => ({ price: Number(row.px), size: Number(row.sz) })),
      asks: (data?.levels?.[1] || []).map(row => ({ price: Number(row.px), size: Number(row.sz) })),
    };
    const value = { book, receivedAtMs: Date.now(), venueTimeMs: Number(data?.time) || null };
    this.books.set(data.coin, value);
    this.onBook?.('Hyperliquid', data.coin, value);
  }
}

export class DydxBookStream extends ReconnectingStream {
  constructor(onBook) { super('wss://indexer.dydx.trade/v4/ws', onBook); this.rawBooks = new Map(); }
  sendSubscribe(ticker) { this.socket.send(JSON.stringify({ type: 'subscribe', channel: 'v4_orderbook', id: ticker })); }
  handle(message) {
    if (message?.channel !== 'v4_orderbook' || !message.id) return;
    const snapshot = message.type === 'subscribed';
    const raw = applyDydxDelta(this.rawBooks.get(message.id), message.contents || {}, snapshot);
    this.rawBooks.set(message.id, raw);
    const value = { book: mapBook(raw.bids, raw.asks), receivedAtMs: Date.now(), venueTimeMs: null, messageId: message.message_id ?? null };
    this.books.set(message.id, value);
    this.onBook?.('dYdX', message.id, value);
  }
}

export class LighterBookStream extends ReconnectingStream {
  constructor(onBook) { super('wss://mainnet.zklighter.elliot.ai/stream', onBook); this.rawBooks = new Map(); this.nonces = new Map(); }
  onOpen() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => { if (this.connected) this.socket.send(JSON.stringify({ type: 'ping' })); }, 30_000);
  }
  sendSubscribe(marketId) { this.socket.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${marketId}` })); }
  handle(message) {
    const marketId = String(message?.market_id ?? message?.order_book?.market_id ?? String(message?.channel || '').split(':')[1] ?? '');
    const contents = message?.order_book || message?.contents || message?.data;
    if (!marketId || !contents || (!contents.bids && !contents.asks)) return;
    const snapshot = message.type !== 'update/order_book';
    const previousNonce = this.nonces.get(marketId);
    const beginNonce = Number(contents.begin_nonce);
    if (!snapshot && previousNonce != null && Number.isFinite(beginNonce) && beginNonce !== previousNonce) {
      this.rawBooks.delete(marketId); this.nonces.delete(marketId);
      try { this.socket.close(); } catch {}
      return;
    }
    const raw = applyDydxDelta(this.rawBooks.get(marketId), contents, snapshot);
    this.rawBooks.set(marketId, raw);
    const nonce = Number(contents.nonce); if (Number.isFinite(nonce)) this.nonces.set(marketId, nonce);
    const value = { book: mapBook(raw.bids, raw.asks), receivedAtMs: Date.now(), venueTimeMs: Number(message?.timestamp) || null };
    if (!value.book.bids.length || !value.book.asks.length || value.book.bids[0].price >= value.book.asks[0].price) return;
    this.books.set(marketId, value);
    this.onBook?.('Lighter', marketId, value);
  }
}
