/**
 * Bybit MACD SCREENER (default) + optional paper-trading bot for Cloudflare Workers.
 *
 * MODE "screen" (default): no trading. Every closed 15m candle it scans Bybit Innovation Zone
 *   coins (or all USDT spot pairs, SCREEN_SCOPE="all") and lists those whose MACD just crossed,
 *   split into LONG (crossed up) and SHORT (crossed down) on the dashboard.
 * MODE "trade": the MACD stop-and-reverse paper trader described below.
 *
 * - Cron trigger every 5 min. State lives in Workers KV.
 * - Universe: Bybit spot USDT pairs flagged as Innovation Zone by Bybit's official public API,
 *   filtered by liquidity, traded several at once.
 * - Signal: MACD ONLY. MACD line crossing above its signal line -> go LONG (closing any short).
 *   Crossing below -> go SHORT (closing any long). Stop-and-reverse on every cross.
 * - Orders fill at the next bar's open with fees + slippage. Signals use CLOSED bars only.
 * - Risk limits (position size, exposure, daily loss, drawdown kill switch) are portfolio
 *   safety rails, not signals. A wide safety stop is on by default (set SAFETY_STOP_PCT=0 to
 *   make the bot exit strictly on MACD crosses).
 *
 * IMPORTANT: Bybit SPOT cannot be shorted. Shorts here are SIMULATED (1x, with a funding/borrow
 * cost estimate). Real shorting needs perpetuals or margin, which many innovation coins lack.
 *
 * Endpoints: GET /  (dashboard)   GET /api/status   GET /api/trades   GET /api/universe
 *            POST /api/run  POST /api/reset   (both need: Authorization: Bearer <ADMIN_TOKEN>)
 *
 * Educational only. Not financial advice.
 */

// ============================== CONFIG ==============================
// Any of these can be overridden in wrangler.toml [vars].
const DEFAULTS = {
  GRANULARITY: 900,           // bar size in seconds: 900 (15m), 3600, 14400, 86400
  MODE: "screen",             // "screen" = dashboard screener only, "trade" = paper trading
  SCREEN_SCOPE: "innovation", // "innovation" = Innovation Zone coins, "all" = every liquid USDT spot pair
  SCREEN_BATCH: 40,           // coins scanned per run (free plan: max 50 subrequests per run)
  START_CASH: 10000,
  FEE: 0.001,                 // per side
  SLIPPAGE: 0.0015,           // per side; small caps are thin
  SHORT_CARRY_HOURLY: 0.0000125, // simulated funding/borrow cost for shorts (~0.01% per 8h)

  MACD_FAST: 12, MACD_SLOW: 26, MACD_SIGNAL: 9,

  POSITION_PCT: 0.10,         // each position uses 10% of equity (1x, no leverage)
  MAX_EXPOSURE: 0.80,         // max 80% of equity in open positions
  MAX_POSITIONS: 8,           // simultaneous positions (longs + shorts)
  SAFETY_STOP_PCT: 0.15,      // emergency stop at 15% adverse move; 0 = MACD-only exits
  DAILY_LOSS_LIMIT: 0.04,     // no new entries after -4% on the day
  MAX_DRAWDOWN: 0.20,         // kill switch: flatten + pause
  HALT_DAYS: 5,

  MAX_SYMBOLS: 60,            // coins watched. Screen mode batches the scan; trade mode needs <= 40 on free plan
  MIN_QUOTE_VOLUME: 1000000,  // skip coins trading under $1M/day
  UNIVERSE_REFRESH_H: 6,
  KLINE_LIMIT: 300,
  DATA_HOST: "https://api.bybit.com", // public endpoints, no key. If blocked, try https://api.bytick.com
};

const STABLES = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "USDT", "EUR", "AEUR", "XUSD", "USD1"]);
const INTERVALS = { 900: "15", 3600: "60", 14400: "240", 86400: "D" };   // Bybit interval codes

function getCfg(env) {
  const c = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = env[k];
    if (v !== undefined && v !== "") c[k] = typeof DEFAULTS[k] === "number" ? Number(v) : v;
  }
  return c;
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ============================ INDICATORS ============================
function ema(v, n) {
  const out = new Array(v.length).fill(null);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += v[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

function macd(c, fast, slow, sig) {
  const ef = ema(c, fast), es = ema(c, slow);
  const line = c.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const signal = new Array(c.length).fill(null);
  const first = line.findIndex((v) => v != null);
  if (first >= 0) ema(line.slice(first), sig).forEach((v, i) => { signal[first + i] = v; });
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

/** candles: [[t(sec), low, high, open, close, volume], ...] oldest first */
function compute(candles, cfg) {
  const m = macd(candles.map((x) => x[4]), cfg.MACD_FAST, cfg.MACD_SLOW, cfg.MACD_SIGNAL);
  return {
    t: candles.map((x) => x[0]), l: candles.map((x) => x[1]), h: candles.map((x) => x[2]),
    o: candles.map((x) => x[3]), c: candles.map((x) => x[4]), hist: m.hist,
  };
}

// ============================== SIGNAL ==============================
/** +1 = MACD crossed above signal (go long), -1 = crossed below (go short), 0 = no cross on this bar. */
function macdCross(ind, i) {
  const a = ind.hist[i - 1], b = ind.hist[i];
  if (i < 1 || a == null || b == null) return 0;
  if (a <= 0 && b > 0) return 1;
  if (a >= 0 && b < 0) return -1;
  return 0;
}

// ============================== ENGINE ==============================
function newState(cfg) {
  return {
    cash: cfg.START_CASH, pos: {}, pending: {}, peak: cfg.START_CASH, day: null,
    dayStartEq: cfg.START_CASH, halted: false, haltUntil: 0, lastBar: {},
    closed: [], events: [], curve: [], mark: {}, equity: cfg.START_CASH,
    stats: { n: 0, wins: 0, gw: 0, gl: 0, sumPct: 0, longN: 0, longPnl: 0, shortN: 0, shortPnl: 0 },
    universe: [], universeAt: 0, universeSource: "", universeNote: "", zone: {},
    screen: {}, screenBar: {},
    startedAt: nowSec(), lastTick: 0, lastError: null,
  };
}

const SIDE = (x) => (x > 0 ? "LONG" : "SHORT");

class Engine {
  constructor(cfg, s) { this.cfg = cfg; this.s = s; this.px = { ...(s.mark || {}) }; }

  emit(kind, sym, t, price, qty, info) {
    this.s.events.unshift({ t, kind, sym, price, qty, info });
    if (this.s.events.length > 60) this.s.events.length = 60;
  }
  // Each position locks `margin` cash (1x). Value = margin + unrealised P&L (never below 0 = liquidated).
  value(k, p) { const px = this.px[k] ?? p.entry; return Math.max(0, p.margin + p.side * (px - p.entry) * p.qty); }
  equity() { return Object.entries(this.s.pos).reduce((e, [k, p]) => e + this.value(k, p), this.s.cash); }
  exposure() { return Object.entries(this.s.pos).reduce((e, [k, p]) => e + p.qty * (this.px[k] ?? p.entry), 0); }
  dailyLimitHit() { return 1 - this.equity() / this.s.dayStartEq >= this.cfg.DAILY_LOSS_LIMIT; }

  _open(sym, price, t, side) {
    const { cfg, s } = this;
    if (s.halted || this.dailyLimitHit() || Object.keys(s.pos).length >= cfg.MAX_POSITIONS) return;
    const eq = this.equity();
    const fill = price * (1 + side * cfg.SLIPPAGE);                       // buys pay up, shorts sell lower
    const notional = Math.min(eq * cfg.POSITION_PCT, eq * cfg.MAX_EXPOSURE - this.exposure(), s.cash / (1 + cfg.FEE));
    if (notional < 10) return;
    const qty = notional / fill, fees = notional * cfg.FEE;
    s.cash -= notional + fees;
    const stop = cfg.SAFETY_STOP_PCT > 0 ? fill * (1 - side * cfg.SAFETY_STOP_PCT) : null;
    s.pos[sym] = { side, qty, entry: fill, margin: notional, stop, t, fees };
    this.emit("OPEN " + SIDE(side), sym, t, fill, qty, `$${notional.toFixed(0)}${stop ? ", safety stop " + stop.toPrecision(5) : ""}`);
  }

  _close(sym, price, t, reason) {
    const { cfg, s } = this;
    const pos = s.pos[sym];
    delete s.pos[sym];
    const fill = price * (1 - pos.side * cfg.SLIPPAGE);                   // closing a long sells lower, a short buys higher
    const gross = pos.side * (fill - pos.entry) * pos.qty;
    const exitFee = pos.qty * fill * cfg.FEE;
    const carry = pos.side < 0 ? pos.margin * cfg.SHORT_CARRY_HOURLY * ((t - pos.t) / 3600) : 0;
    const proceeds = Math.max(0, pos.margin + gross - exitFee - carry);
    s.cash += proceeds;
    const pnl = proceeds - (pos.margin + pos.fees), pct = pnl / pos.margin;
    s.closed.push({ sym, side: pos.side, tIn: pos.t, tOut: t, entry: pos.entry, exit: fill, qty: pos.qty, pnl, pct, reason });
    if (s.closed.length > 300) s.closed.shift();
    const st = s.stats;
    st.n++; st.sumPct += pct;
    if (pnl > 0) { st.wins++; st.gw += pnl; } else st.gl += -pnl;
    if (pos.side > 0) { st.longN++; st.longPnl += pnl; } else { st.shortN++; st.shortPnl += pnl; }
    this.emit("CLOSE " + SIDE(pos.side), sym, t, fill, pos.qty, `${reason}, P&L $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
  }

  /** Processes one CLOSED bar. Returns a new-entry candidate for a flat symbol (or null). */
  processBar(sym, ind, i) {
    const { cfg, s } = this;
    const t = ind.t[i], o = ind.o[i], h = ind.h[i], l = ind.l[i], c = ind.c[i];

    const day = Math.floor(t / 86400);
    if (s.day !== day) { s.day = day; s.dayStartEq = this.equity(); }

    // 1) fill orders decided on the previous bar at this bar's open
    const order = s.pending[sym];
    delete s.pending[sym];
    if (order === "close") { if (s.pos[sym]) this._close(sym, o, t, "kill switch"); }
    else if (order && typeof order === "object" && t <= order.t + 2 * cfg.GRANULARITY) {
      const p = s.pos[sym];
      if (p && p.side !== order.side) { this._close(sym, o, t, "MACD flip"); this._open(sym, o, t, order.side); }
      else if (!p) this._open(sym, o, t, order.side);
    }

    // 2) emergency stop inside this bar (checked before anything else: conservative)
    const pos = s.pos[sym];
    if (pos && pos.stop) {
      if (pos.side > 0 && l <= pos.stop) this._close(sym, Math.min(o, pos.stop), t, "safety stop");
      else if (pos.side < 0 && h >= pos.stop) this._close(sym, Math.max(o, pos.stop), t, "safety stop");
    }

    // 3) mark to market, portfolio risk checks
    this.px[sym] = c;
    const eq = this.equity();
    s.peak = Math.max(s.peak, eq);
    if (s.halted && t >= s.haltUntil) { s.halted = false; s.peak = eq; this.emit("RESUME", sym, t, c, 0, "cooldown over"); }
    if (!s.halted && 1 - eq / s.peak >= cfg.MAX_DRAWDOWN) {
      s.halted = true;
      s.haltUntil = t + cfg.HALT_DAYS * 86400;
      s.pending = Object.fromEntries(Object.keys(s.pos).map((k) => [k, "close"]));
      this.emit("HALT", sym, t, c, 0, `drawdown ${((1 - eq / s.peak) * 100).toFixed(1)}%, flattening`);
    }
    if (s.halted) return null;

    // 4) the only signal: a MACD cross on this closed bar
    const side = macdCross(ind, i);
    if (!side) return null;
    const p = s.pos[sym];
    if (p) { if (p.side !== side) s.pending[sym] = { side, t }; return null; }   // reverse: close + open at next open
    if (this.dailyLimitHit()) return null;
    return { sym, t, side, score: Math.abs(ind.hist[i]) / c };                  // histogram strength, scaled by price
  }

  /** Fills free position slots with the strongest crosses first. */
  assignEntries(cands) {
    const { cfg, s } = this;
    if (s.halted) return;
    const queued = Object.entries(s.pending).filter(([k, v]) => typeof v === "object" && !s.pos[k]).length;
    let free = cfg.MAX_POSITIONS - Object.keys(s.pos).length - queued;
    for (const c of cands.sort((a, b) => b.score - a.score)) {
      if (free <= 0) break;
      if (s.pending[c.sym] || s.pos[c.sym]) continue;
      s.pending[c.sym] = { side: c.side, t: c.t };
      free--;
      this.emit("SIGNAL", c.sym, c.t, 0, 0, `MACD cross -> ${SIDE(c.side)}; fills next bar`);
    }
  }
}

// ============================== DATA ================================
async function bybit(cfg, path, params) {
  const r = await fetch(`${cfg.DATA_HOST}${path}?${new URLSearchParams(params)}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(`Bybit ${j.retCode}: ${j.retMsg}`);
  return j.result;
}

/** One call returns the live price and 24h USDT turnover of every spot pair. */
async function fetchTickers(cfg) {
  const res = await bybit(cfg, "/v5/market/tickers", { category: "spot" });
  const prices = {}, volumes = {};
  for (const t of res.list) {
    if (!t.symbol.endsWith("USDT")) continue;
    prices[t.symbol] = Number(t.lastPrice);
    volumes[t.symbol] = Number(t.turnover24h);
  }
  return { prices, volumes };
}

async function fetchKlines(cfg, sym, now) {
  const iv = INTERVALS[cfg.GRANULARITY];
  if (!iv) throw new Error("Unsupported GRANULARITY");
  const res = await bybit(cfg, "/v5/market/kline", { category: "spot", symbol: sym, interval: iv, limit: String(cfg.KLINE_LIMIT) });
  return res.list                                                              // newest first: [start ms, open, high, low, close, vol, turnover]
    .map((k) => [Math.floor(+k[0] / 1000), +k[3], +k[2], +k[1], +k[4], +k[5]]) // -> [t, low, high, open, close, vol]
    .sort((a, b) => a[0] - b[0])
    .filter((c) => c[0] + cfg.GRANULARITY <= now);                             // closed bars only
}

/** Innovation Zone flag comes straight from Bybit's official instruments-info endpoint. */
async function discoverInnovation(cfg) {
  const res = await bybit(cfg, "/v5/market/instruments-info", { category: "spot" });
  const trading = res.list.filter((p) => p.status === "Trading" && p.quoteCoin === "USDT");
  const isIz = (p) => p.symbolType === "innovation" || p.innovation === "1";
  return {
    innovation: trading.filter(isIz).map((p) => p.symbol),
    all: trading.map((p) => p.symbol),
    types: [...new Set(res.list.map((p) => p.symbolType).filter(Boolean))],
  };
}

async function refreshUniverse(env, cfg, s, now, volumes) {
  let list = [], source = "", note = "", zone = new Set();
  if ((env.UNIVERSE_MODE || "auto") === "auto") {
    try {
      const d = await discoverInnovation(cfg);
      zone = new Set(d.innovation);
      if (cfg.SCREEN_SCOPE === "all") { list = d.all; source = "all USDT spot pairs"; }
      else {
        list = d.innovation; source = "auto (Bybit Innovation Zone)";
        if (!list.length) note = `auto-discovery found 0 innovation pairs (symbolTypes seen: ${d.types.join(", ") || "none"})`;
      }
    } catch (e) { note = "auto-discovery failed: " + e.message; }
  }
  if (!list.length && env.SYMBOLS) {
    list = env.SYMBOLS.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)
      .map((x) => (x.endsWith("USDT") ? x : x + "USDT"));
    source = "manual list (SYMBOLS)";
  }
  const found = list.length;
  list = list
    .filter((sym) => volumes[sym] >= cfg.MIN_QUOTE_VOLUME && !STABLES.has(sym.replace(/USDT$/, "")) && !/\d+[LS]USDT$/.test(sym))
    .sort((a, b) => volumes[b] - volumes[a])
    .slice(0, cfg.MAX_SYMBOLS);
  s.universe = list;
  s.universeAt = now;
  s.universeSource = source || "none";
  s.zone = Object.fromEntries(list.filter((x) => zone.has(x)).map((x) => [x, 1]));
  for (const k of Object.keys(s.screen)) if (!list.includes(k)) delete s.screen[k];
  s.universeNote = (note ? note + ". " : "") + `${found} candidates, ${list.length} pass liquidity filter`;
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); }
  });
  await Promise.all(workers);
}

// ============================= SCREENER =============================
const MAX_CROSS_AGE = 5;   // remember crosses up to 5 closed candles old; the dashboard filters by age

/** Scans up to SCREEN_BATCH coins that haven't been checked for the latest closed candle. */
async function screenScan(cfg, s, volumes, now, lastClosedOpen) {
  const need = s.universe.filter((sym) => (s.screenBar[sym] || 0) < lastClosedOpen).slice(0, cfg.SCREEN_BATCH);
  const klines = {};
  await mapLimit(need, 6, async (sym) => {
    try { klines[sym] = await fetchKlines(cfg, sym, now); }
    catch (e) { s.lastError = `klines ${sym}: ${e.message}`; }               // retried on the next tick
  });
  for (const sym of need) {
    const kl = klines[sym];
    if (!kl) continue;
    const ind = compute(kl, cfg), last = ind.t.length - 1;
    s.screenBar[sym] = last >= 0 ? ind.t[last] : lastClosedOpen;
    delete s.screen[sym];
    for (let k = 0; k < MAX_CROSS_AGE && last - k >= 1; k++) {
      const side = macdCross(ind, last - k);
      if (!side) continue;
      s.screen[sym] = { side, age: k + 1, crossT: ind.t[last - k], barT: ind.t[last], price: ind.c[last],
        hist: ind.hist[last], strength: Math.abs(ind.hist[last - k]) / ind.c[last - k], vol: volumes[sym] ?? 0 };
      break;                                                                  // most recent cross only
    }
  }
}

/** Dashboard data. `age` = max candles since the cross (1 = it happened on the latest closed candle). */
function screenData(s, cfg, age, now = nowSec()) {
  const gran = cfg.GRANULARITY, latest = Math.floor(now / gran) * gran - gran;
  const rows = Object.entries(s.screen)
    .filter(([sym]) => s.universe.includes(sym))
    .map(([sym, r]) => ({ sym, ...r, iz: !!s.zone[sym], age: r.age + Math.round((latest - r.barT) / gran) }))  // stale rows keep ageing
    .filter((r) => r.age <= age)
    .sort((a, b) => a.age - b.age || b.vol - a.vol);
  const scanned = s.universe.filter((x) => (s.screenBar[x] || 0) >= latest).length;
  return {
    mode: "screen", timeframe: `${gran / 60}m`, maxAge: age, latestCandleOpen: latest,
    scanned, total: s.universe.length, scope: s.universeSource, note: s.universeNote,
    long: rows.filter((r) => r.side > 0), short: rows.filter((r) => r.side < 0),
    lastTick: s.lastTick, lastError: s.lastError,
  };
}

// =============================== TICK ===============================
async function loadState(env, cfg) {
  const saved = await env.BOT_KV.get("state", "json");
  return saved ? { ...newState(cfg), ...saved } : newState(cfg);
}

async function tick(env) {
  const cfg = getCfg(env);
  const s = await loadState(env, cfg);
  const eng = new Engine(cfg, s);
  const now = nowSec(), gran = cfg.GRANULARITY;
  const lastClosedOpen = Math.floor(now / gran) * gran - gran;
  s.lastTick = now;
  s.lastError = null;

  let prices = {}, volumes = {};
  try { ({ prices, volumes } = await fetchTickers(cfg)); } catch (e) { s.lastError = "tickers: " + e.message; }

  if (Object.keys(volumes).length && (!s.universe.length || now - s.universeAt > cfg.UNIVERSE_REFRESH_H * 3600)) {
    try { await refreshUniverse(env, cfg, s, now, volumes); } catch (e) { s.lastError = "universe: " + e.message; }
  }

  if (cfg.MODE !== "trade") {
    await screenScan(cfg, s, volumes, now, lastClosedOpen);
    await env.BOT_KV.put("state", JSON.stringify(s));
    return screenData(s, cfg, 1, now);
  }

  // Watch the universe plus anything we hold or have queued
  const watch = [...new Set([...s.universe, ...Object.keys(s.pos), ...Object.keys(s.pending)])];
  const need = [];
  for (const sym of watch) {
    if (s.lastBar[sym] === undefined) s.lastBar[sym] = lastClosedOpen;   // newly seen: start fresh, no replay
    else if (s.lastBar[sym] < lastClosedOpen) need.push(sym);            // a new bar has closed
  }

  const klines = {};
  await mapLimit(need, 6, async (sym) => {
    try { klines[sym] = await fetchKlines(cfg, sym, now); }
    catch (e) { s.lastError = `klines ${sym}: ${e.message}`; }           // retried on next tick
  });

  const cands = [];
  for (const sym of need) {
    const kl = klines[sym];
    if (!kl || !kl.length) continue;
    const ind = compute(kl, cfg);
    const last = ind.t.length - 1;
    for (let i = 0; i <= last; i++) {
      if (ind.t[i] <= s.lastBar[sym]) continue;
      const cand = eng.processBar(sym, ind, i);
      s.lastBar[sym] = ind.t[i];
      if (cand && i === last) cands.push(cand);                          // only fres
