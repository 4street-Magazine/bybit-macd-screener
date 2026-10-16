/**
 * MACD SCREENER (OKX data) + optional paper-trading bot for Cloudflare Workers.
 *
 * MODE "screen" (default): no trading. Every closed 15m candle it scans the most-traded
 *   OKX USDT spot pairs and lists those whose MACD just crossed, split into LONG (crossed up)
 *   and SHORT (crossed down). Each cross is rated VERY STRONG / STRONG / MODERATE / WEAK using
 *   ADX (trend strength), the 200-EMA, the MACD zero line, cross sharpness and RSI.
 *   Times are shown in EAT (UTC+3).
 * MODE "trade": the MACD stop-and-reverse PAPER trader (fake money).
 *
 * - Cron trigger. State lives in Workers KV.
 * - Data: OKX public market endpoints, no API key needed.
 * - Signal: MACD ONLY. Signals use CLOSED bars only.
 *
 * Endpoints: GET /  (dashboard)   GET /api/status   GET /api/trades   GET /api/universe
 *            POST /api/run  POST /api/reset   (both need: Authorization: Bearer <ADMIN_TOKEN>)
 *
 * Educational only. Not financial advice.
 */

// ============================== CONFIG ==============================
const OKX_HOST = "https://www.okx.com";

const DEFAULTS = {
  GRANULARITY: 900,           // bar size in seconds: 900 (15m), 3600, 14400, 86400
  MODE: "screen",             // "screen" = dashboard screener only, "trade" = paper trading
  SCREEN_BATCH: 40,           // coins scanned per run (free plan: max 50 subrequests per run)
  START_CASH: 10000,
  FEE: 0.001,
  SLIPPAGE: 0.0015,
  SHORT_CARRY_HOURLY: 0.0000125,

  MACD_FAST: 12, MACD_SLOW: 26, MACD_SIGNAL: 9,

  POSITION_PCT: 0.10,
  MAX_EXPOSURE: 0.80,
  MAX_POSITIONS: 8,
  SAFETY_STOP_PCT: 0.15,
  DAILY_LOSS_LIMIT: 0.04,
  MAX_DRAWDOWN: 0.20,
  HALT_DAYS: 5,

  MAX_SYMBOLS: 60,            // coins watched (top by 24h volume)
  MIN_QUOTE_VOLUME: 1000000,  // skip coins trading under $1M/day
  UNIVERSE_REFRESH_H: 6,
  KLINE_LIMIT: 300,
};

const STABLES = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "USDT", "EUR", "AEUR", "XUSD", "USD1", "PYUSD"]);
const INTERVALS = { 900: "15m", 3600: "1H", 14400: "4H", 86400: "1D" };   // OKX bar codes

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

/** RSI (Wilder smoothing). Returns the latest value, or null if not enough data. */
function rsi14(c, n = 14) {
  if (c.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

/** ADX with +DI / -DI (Wilder smoothing). Returns the latest values, or null if not enough data. */
function adx14(h, l, c, n = 14) {
  const len = c.length;
  if (len < 2 * n + 2) return null;
  let str = 0, spdm = 0, smdm = 0;
  const dxs = [];
  for (let i = 1; i < len; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= n) { str += tr; spdm += pdm; smdm += mdm; }
    else { str = str - str / n + tr; spdm = spdm - spdm / n + pdm; smdm = smdm - smdm / n + mdm; }
    if (i >= n) {
      const pdi = str ? (100 * spdm) / str : 0, mdi = str ? (100 * smdm) / str : 0;
      const sum = pdi + mdi;
      dxs.push({ dx: sum ? (100 * Math.abs(pdi - mdi)) / sum : 0, pdi, mdi });
    }
  }
  if (dxs.length < n) return null;
  let a = 0;
  for (let i = 0; i < n; i++) a += dxs[i].dx;
  a /= n;
  for (let i = n; i < dxs.length; i++) a = (a * (n - 1) + dxs[i].dx) / n;
  const lastD = dxs[dxs.length - 1];
  return { adx: a, pdi: lastD.pdi, mdi: lastD.mdi };
}

/** candles: [[t(sec), low, high, open, close, volume], ...] oldest first */
function compute(candles, cfg) {
  const m = macd(candles.map((x) => x[4]), cfg.MACD_FAST, cfg.MACD_SLOW, cfg.MACD_SIGNAL);
  return {
    t: candles.map((x) => x[0]), l: candles.map((x) => x[1]), h: candles.map((x) => x[2]),
    o: candles.map((x) => x[3]), c: candles.map((x) => x[4]), hist: m.hist, line: m.line,
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

/**
 * Rates a cross out of 8 points:
 *   ADX >= 40: +3, >= 25: +2, >= 20: +1      (how strong is the trend)
 *   +DI/-DI agree with the cross direction: +1
 *   price on the right side of the 200-EMA: +2
 *   MACD line on the right side of zero at the cross: +1
 *   cross much sharper than recent candles: +1
 *   RSI stretched against the cross (LONG > 75, SHORT < 25): -1
 * 7-8 VERY STRONG, 5-6 STRONG, 3-4 MODERATE, 0-2 WEAK.
 */
function rate(side, ind, last, ci) {
  const c = ind.c;
  const a = adx14(ind.h, ind.l, c);
  const r = rsi14(c);
  const e = ema(c, 200), eLast = e[e.length - 1];
  let pts = 0;

  let trend = "no data";
  if (a) {
    pts += a.adx >= 40 ? 3 : a.adx >= 25 ? 2 : a.adx >= 20 ? 1 : 0;
    if (side > 0 ? a.pdi > a.mdi : a.mdi > a.pdi) pts += 1;
    const dir = a.pdi > a.mdi ? "uptrend" : "downtrend";
    trend = a.adx >= 50 ? `very strong ${dir}` : a.adx >= 40 ? `strong ${dir}` : a.adx >= 25 ? dir
      : a.adx >= 20 ? `weak ${dir}` : "choppy, no clear trend";
  }

  const emaOk = eLast != null && (side > 0 ? c[last] > eLast : c[last] < eLast);
  if (emaOk) pts += 2;

  const lineAtCross = ind.line[ci];
  const zeroOk = lineAtCross != null && (side > 0 ? lineAtCross > 0 : lineAtCross < 0);
  if (zeroOk) pts += 1;

  let sum = 0, n = 0;
  for (let j = Math.max(1, ci - 50); j < ci; j++) if (ind.hist[j] != null) { sum += Math.abs(ind.hist[j]); n++; }
  const ratio = n && sum ? Math.abs(ind.hist[ci]) / (sum / n) : 1;
  if (ratio >= 1.5) pts += 1;

  if (r != null && (side > 0 ? r > 75 : r < 25)) pts -= 1;

  const score = Math.max(0, pts);
  const label = score >= 7 ? "VERY STRONG" : score >= 5 ? "STRONG" : score >= 3 ? "MODERATE" : "WEAK";
  return { score, label, trend, adx: a ? a.adx : null, rsi: r, emaOk, zeroOk, ratio };
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
  value(k, p) { const px = this.px[k] ?? p.entry; return Math.max(0, p.margin + p.side * (px - p.entry) * p.qty); }
  equity() { return Object.entries(this.s.pos).reduce((e, [k, p]) => e + this.value(k, p), this.s.cash); }
  exposure() { return Object.entries(this.s.pos).reduce((e, [k, p]) => e + p.qty * (this.px[k] ?? p.entry), 0); }
  dailyLimitHit() { return 1 - this.equity() / this.s.dayStartEq >= this.cfg.DAILY_LOSS_LIMIT; }

  _open(sym, price, t, side) {
    const { cfg, s } = this;
    if (s.halted || this.dailyLimitHit() || Object.keys(s.pos).length >= cfg.MAX_POSITIONS) return;
    const eq = this.equity();
    const fill = price * (1 + side * cfg.SLIPPAGE);
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
    const fill = price * (1 - pos.side * cfg.SLIPPAGE);
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

  processBar(sym, ind, i) {
    const { cfg, s } = this;
    const t = ind.t[i], o = ind.o[i], h = ind.h[i], l = ind.l[i], c = ind.c[i];

    const day = Math.floor(t / 86400);
    if (s.day !== day) { s.day = day; s.dayStartEq = this.equity(); }

    const order = s.pending[sym];
    delete s.pending[sym];
    if (order === "close") { if (s.pos[sym]) this._close(sym, o, t, "kill switch"); }
    else if (order && typeof order === "object" && t <= order.t + 2 * cfg.GRANULARITY) {
      const p = s.pos[sym];
      if (p && p.side !== order.side) { this._close(sym, o, t, "MACD flip"); this._open(sym, o, t, order.side); }
      else if (!p) this._open(sym, o, t, order.side);
    }

    const pos = s.pos[sym];
    if (pos && pos.stop) {
      if (pos.side > 0 && l <= pos.stop) this._close(sym, Math.min(o, pos.stop), t, "safety stop");
      else if (pos.side < 0 && h >= pos.stop) this._close(sym, Math.max(o, pos.stop), t, "safety stop");
    }

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

    const side = macdCross(ind, i);
    if (!side) return null;
    const p = s.pos[sym];
    if (p) { if (p.side !== side) s.pending[sym] = { side, t }; return null; }
    if (this.dailyLimitHit()) return null;
    return { sym, t, side, score: Math.abs(ind.hist[i]) / c };
  }

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

// ============================== DATA (OKX) ==========================
// Internally coins are named like "BTCUSDT"; OKX calls them "BTC-USDT".
const toInst = (sym) => sym.replace(/USDT$/, "-USDT");

async function okx(path, params) {
  const r = await fetch(`${OKX_HOST}${path}?${new URLSearchParams(params)}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  const j = await r.json();
  if (j.code !== "0") throw new Error(`OKX ${j.code}: ${j.msg}`);
  return j.data;
}

/** One call returns the live price and 24h USDT turnover of every spot pair. */
async function fetchTickers(cfg) {
  const list = await okx("/api/v5/market/tickers", { instType: "SPOT" });
  const prices = {}, volumes = {};
  for (const t of list) {
    if (!t.instId.endsWith("-USDT")) continue;
    const sym = t.instId.replace("-", "");
    prices[sym] = Number(t.last);
    volumes[sym] = Number(t.volCcy24h);     // 24h volume in quote currency (USDT)
  }
  return { prices, volumes };
}

async function fetchKlines(cfg, sym, now) {
  const bar = INTERVALS[cfg.GRANULARITY];
  if (!bar) throw new Error("Unsupported GRANULARITY");
  const list = await okx("/api/v5/market/candles", { instId: toInst(sym), bar, limit: String(Math.min(300, cfg.KLINE_LIMIT)) });
  return list                                                                  // newest first: [ts ms, open, high, low, close, vol, ...]
    .map((k) => [Math.floor(+k[0] / 1000), +k[3], +k[2], +k[1], +k[4], +k[5]]) // -> [t, low, high, open, close, vol]
    .sort((a, b) => a[0] - b[0])
    .filter((c) => c[0] + cfg.GRANULARITY <= now);                             // closed bars only
}

async function discoverPairs() {
  const list = await okx("/api/v5/public/instruments", { instType: "SPOT" });
  return list.filter((p) => p.state === "live" && p.quoteCcy === "USDT").map((p) => p.instId.replace("-", ""));
}

async function refreshUniverse(env, cfg, s, now, volumes) {
  let list = [], source = "", note = "";
  if ((env.UNIVERSE_MODE || "auto") === "auto") {
    try {
      list = await discoverPairs();
      source = "OKX top USDT pairs by volume";
    } catch (e) { note = "pair discovery failed: " + e.message; }
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
  s.zone = {};
  for (const k of Object.keys(s.screen)) if (!list.includes(k)) delete s.screen[k];
  s.universeNote = (note ? note + ". " : "") + `${found} candidates, ${list.length} pass liquidity filter`;
}

// Runs fn over items one at a time with a pause, to stay under OKX's rate limit.
async function mapLimit(items, limit, fn) {
  for (const item of items) {
    await fn(item);
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ============================= SCREENER =============================
const MAX_CROSS_AGE = 5;

async function screenScan(cfg, s, volumes, now, lastClosedOpen) {
  const need = s.universe.filter((sym) => (s.screenBar[sym] || 0) < lastClosedOpen).slice(0, cfg.SCREEN_BATCH);
  const klines = {};
  await mapLimit(need, 4, async (sym) => {
    try { klines[sym] = await fetchKlines(cfg, sym, now); }
    catch (e) { s.lastError = `klines ${sym}: ${e.message}`; }
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
      const rt = rate(side, ind, last, last - k);
      s.screen[sym] = { side, age: k + 1, crossT: ind.t[last - k], barT: ind.t[last], price: ind.c[last],
        hist: ind.hist[last], strength: Math.abs(ind.hist[last - k]) / ind.c[last - k], vol: volumes[sym] ?? 0, ...rt };
      break;
    }
  }
}

function screenData(s, cfg, age, now = nowSec()) {
  const gran = cfg.GRANULARITY, latest = Math.floor(now / gran) * gran - gran;
  const rows = Object.entries(s.screen)
    .filter(([sym]) => s.universe.includes(sym))
    .map(([sym, r]) => ({ sym, ...r, iz: !!s.zone[sym], age: r.age + Math.round((latest - r.barT) / gran) }))
    .filter((r) => r.age <= age)
    .sort((a, b) => a.age - b.age || (b.score ?? -1) - (a.score ?? -1) || b.vol - a.vol);
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

  const watch = [...new Set([...s.universe, ...Object.keys(s.pos), ...Object.keys(s.pending)])];
  const need = [];
  for (const sym of watch) {
    if (s.lastBar[sym] === undefined) s.lastBar[sym] = lastClosedOpen;
    else if (s.lastBar[sym] < lastClosedOpen) need.push(sym);
  }

  const klines = {};
  await mapLimit(need, 4, async (sym) => {
    try { klines[sym] = await fetchKlines(cfg, sym, now); }
    catch (e) { s.lastError = `klines ${sym}: ${e.message}`; }
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
      if (cand && i === last) cands.push(cand);
    }
  }
  eng.assignEntries(cands);

  for (const k of Object.keys(s.pos)) if (prices[k]) eng.px[k] = prices[k];
  for (const [sym, p] of Object.entries(s.pos)) {
    const px = prices[sym];
    if (px && p.stop && (p.side > 0 ? px <= p.stop : px >= p.stop)) eng._close(sym, px, now, "safety stop (live)");
  }

  s.mark = {};
  for (const k of Object.keys(s.pos)) s.mark[k] = eng.px[k];
  s.equity = eng.equity();
  s.peak = Math.max(s.peak, s.equity);
  const lastPt = s.curve[s.curve.length - 1];
  if (!lastPt || now - lastPt[0] >= 3600) { s.curve.push([now, s.equity]); if (s.curve.length > 720) s.curve.shift(); }

  await env.BOT_KV.put("state", JSON.stringify(s));
  return summary(s, cfg);
}

function summary(s, cfg) {
  const st = s.stats;
  return {
    equity: s.equity, returnPct: (s.equity / cfg.START_CASH - 1) * 100, cash: s.cash,
    drawdownPct: (1 - s.equity / s.peak) * 100, halted: s.halted,
    openPositions: Object.entries(s.pos).map(([sym, p]) => ({
      sym, side: SIDE(p.side), qty: p.qty, entry: p.entry, price: s.mark[sym], stop: p.stop,
      pnlPct: s.mark[sym] ? p.side * (s.mark[sym] / p.entry - 1) * 100 : null })),
    pendingOrders: s.pending,
    trades: { count: st.n, winRate: st.n ? st.wins / st.n : null,
      profitFactor: st.gl > 0 ? st.gw / st.gl : null, avgPct: st.n ? (st.sumPct / st.n) * 100 : null,
      long: { count: st.longN, pnl: st.longPnl }, short: { count: st.shortN, pnl: st.shortPnl } },
    universe: { source: s.universeSource, note: s.universeNote, size: s.universe.length },
    lastTick: s.lastTick, lastError: s.lastError,
  };
}

// ============================ DASHBOARD =============================
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n) => (n >= 100 ? n.toFixed(2) : n.toPrecision(5));
const ago = (t) => { if (!t) return "never"; const m = Math.round((nowSec() - t) / 60); return m < 1 ? "just now" : m < 120 ? m + " min ago" : Math.round(m / 60) + " h ago"; };
const clr = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");

function sparkline(curve) {
  if (curve.length < 2) return "";
  const ys = curve.map((p) => p[1]), min = Math.min(...ys), max = Math.max(...ys), rng = max - min || 1;
  const pts = ys.map((y, i) => `${((i / (ys.length - 1)) * 300).toFixed(1)},${(58 - ((y - min) / rng) * 52).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 300 60" preserveAspectRatio="none" class="spark"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--text:#14171c;--mute:#737b88;--line:#e4e7ec;--up:#0a8f4f;--down:#d13b3b}
@media(prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#171b22;--text:#e8ebf0;--mute:#8a93a1;--line:#262c36;--up:#3ccf86;--down:#ff6b6b}}
body{margin:0;padding:16px;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,sans-serif}
.wrap{max-width:760px;margin:auto}h1{font-size:18px;margin:0 0 2px}.mute{color:var(--mute)}.up{color:var(--up)}.down{color:var(--down)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.big{font-size:26px;font-weight:650}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:var(--mute);font-weight:500}td,th{padding:6px 4px;border-top:1px solid var(--line);vertical-align:top}
.scroll{overflow-x:auto}.spark{width:100%;height:60px;color:var(--text)}ul{padding-left:18px;margin:6px 0}h2{font-size:14px;margin:0 0 8px;color:var(--mute);font-weight:600}
.warn{color:var(--down)} .tag{font-size:10px;padding:1px 5px;border-radius:6px;border:1px solid var(--line);color:var(--mute);margin-left:4px}
.tabs a{display:inline-block;margin-right:8px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;color:var(--text);text-decoration:none;font-size:13px}
.tabs a.on{background:var(--text);color:var(--bg)}
.lv3{font-weight:800}.lv2{font-weight:700}.lv1{font-weight:600}.lv0{font-weight:500;color:var(--mute)}.small{font-size:12px}`;

const usd = (n) => (n >= 1e6 ? "$" + (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? "$" + Math.round(n / 1e3) + "K" : "$" + Math.round(n));
// Times are shown in EAT (UTC+3)
const hhmm = (t) => new Date((t + 3 * 3600) * 1000).toISOString().slice(11, 16);

function ratingCell(r) {
  if (!r.label) return `<span class="mute">updating...</span>`;
  const lv = r.score >= 7 ? 3 : r.score >= 5 ? 2 : r.score >= 3 ? 1 : 0;
  return `<span class="lv${lv}">${r.label}</span> <span class="mute">${r.score}/8</span><br>
    <span class="mute small">${esc(r.trend)}${r.adx != null ? " · ADX " + Math.round(r.adx) : ""}${r.rsi != null ? " · RSI " + Math.round(r.rsi) : ""}<br>
    200-EMA ${r.emaOk ? "✓" : "✗"} · zero-line ${r.zeroOk ? "✓" : "✗"}</span>`;
}

function screenPage(s, cfg, age) {
  const d = screenData(s, cfg, age);
  const ageTxt = (r) => (r.age === 1 ? "last candle" : `${r.age} candles ago`);
  const tbl = (rows, cls) => `<div class="scroll"><table><tr><th>Coin</th><th>Crossed</th><th>Rating</th><th>Price</th><th>24h vol</th></tr>${
    rows.map((r) => `<tr><td><b>${esc(r.sym.replace("USDT", ""))}</b>${r.iz ? ' <span class="tag">IZ</span>' : ""}</td>
      <td class="${cls}">${hhmm(r.crossT + cfg.GRANULARITY)} EAT<br><span class="mute">${ageTxt(r)}</span></td>
      <td class="${cls}">${ratingCell(r)}</td>
      <td>${num(r.price)}</td><td>${usd(r.vol)}</td></tr>`).join("")
    || `<tr><td colspan="5" class="mute">No coins match right now</td></tr>`}</table></div>`;
  const tabs = [1, 2, 3].map((n) => `<a href="?age=${n}" class="${n === age ? "on" : ""}">${n === 1 ? "Last candle" : "≤ " + n + " candles"}</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>MACD Screener</title><style>${STYLE}</style></head><body><div class="wrap">
<h1>MACD Screener (OKX) · ${d.timeframe}</h1>
<div class="mute">Scanned ${d.scanned}/${d.total} coins for the ${hhmm(d.latestCandleOpen + cfg.GRANULARITY)} EAT candle close · ${esc(d.scope)} · updated ${ago(s.lastTick)}</div>
${d.lastError ? `<div class="warn">Last error: ${esc(d.lastError)}</div>` : ""}
<div class="card tabs">${tabs}<div class="mute" style="margin-top:8px;font-size:13px">Shows coins whose MACD (${cfg.MACD_FAST}/${cfg.MACD_SLOW}/${cfg.MACD_SIGNAL}) crossed its signal line within this many closed candles. Times in EAT. Best-rated first.</div></div>
<div class="card"><h2 class="up">LONG · MACD crossed UP (${d.long.length})</h2>${tbl(d.long, "up")}</div>
<div class="card"><h2 class="down">SHORT · MACD crossed DOWN (${d.short.length})</h2>${tbl(d.short, "down")}</div>
<div class="card small mute"><b>How to read the rating (out of 8).</b> ADX measures how strong the trend is: under 20 choppy, 25+ trending, 40+ strong, 50+ very strong. Points are added when the trend direction agrees with the cross, price is on the right side of the 200-EMA, the MACD line is on the right side of zero, and the cross is sharper than recent candles. A point is removed if RSI is already stretched (LONG above 75, SHORT below 25). VERY STRONG = 7-8, STRONG = 5-6, MODERATE = 3-4, WEAK = 0-2. ✓ means the check passed. This is a guide to trend quality on this timeframe, not a prediction.</div>
<div class="mute" style="font-size:12px">${esc(d.note)}. Screener only: no trades are placed. Educational, not financial advice.</div></div></body></html>`;
}

function page(s, cfg) {
  const m = summary(s, cfg);
  const rows = m.openPositions.map((p) => `<tr><td>${esc(p.sym.replace("USDT", ""))}</td><td class="${p.side === "LONG" ? "up" : "down"}">${p.side}</td><td>${num(p.entry)}</td><td>${p.price ? num(p.price) : "-"}</td>
    <td class="${clr(p.pnlPct)}">${p.pnlPct == null ? "-" : p.pnlPct.toFixed(2) + "%"}</td></tr>`).join("")
    || `<tr><td colspan="5" class="mute">No open positions</td></tr>`;
  const trades = s.closed.slice(-12).reverse().map((t) => `<tr><td>${esc(t.sym.replace("USDT", ""))}</td><td>${t.side > 0 ? "LONG" : "SHORT"}</td>
    <td class="${clr(t.pnl)}">${money(t.pnl)}</td><td class="mute">${esc(t.reason)}</td></tr>`).join("")
    || `<tr><td colspan="4" class="mute">No closed trades yet</td></tr>`;
  const events = s.events.slice(0, 10).map((e) => `<li><b>${esc(e.kind)}</b> ${esc(e.sym.replace("USDT", ""))} <span class="mute">${esc(e.info)}</span></li>`).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>MACD Paper Bot</title><style>${STYLE}</style></head><body><div class="wrap">
<h1>MACD Paper Bot (OKX data)</h1><div class="mute">Fake money · updated ${ago(s.lastTick)} · ${esc(m.universe.source)}, ${m.universe.size} coins watched</div>
${m.lastError ? `<div class="warn">Last error: ${esc(m.lastError)}</div>` : ""}${m.halted ? `<div class="warn">Kill switch active: trading paused</div>` : ""}
<div class="card"><div class="grid"><div><div class="mute">Equity</div><div class="big">${money(m.equity)}</div></div>
<div><div class="mute">Return</div><div class="big ${clr(m.returnPct)}">${m.returnPct.toFixed(2)}%</div></div>
<div><div class="mute">Cash</div>${money(m.cash)}</div><div><div class="mute">Drawdown</div>${m.drawdownPct.toFixed(2)}%</div></div>${sparkline(s.curve)}</div>
<div class="card"><h2>OPEN POSITIONS (${m.openPositions.length}/${cfg.MAX_POSITIONS})</h2><div class="scroll"><table><tr><th>Coin</th><th>Side</th><th>Entry</th><th>Now</th><th>P&amp;L</th></tr>${rows}</table></div></div>
<div class="card"><h2>CLOSED TRADES · ${m.trades.count} total${m.trades.winRate != null ? ` · ${(m.trades.winRate * 100).toFixed(0)}% win · PF ${m.trades.profitFactor ? m.trades.profitFactor.toFixed(2) : "∞"} · avg ${m.trades.avgPct.toFixed(2)}%` : ""}</h2>
<div class="mute" style="margin-bottom:6px">Longs: ${m.trades.long.count} trades, ${money(m.trades.long.pnl)} · Shorts (simulated): ${m.trades.short.count} trades, ${money(m.trades.short.pnl)}</div>
<div class="scroll"><table><tr><th>Coin</th><th>Side</th><th>P&amp;L</th><th>Exit</th></tr>${trades}</table></div></div>
<div class="card"><h2>RECENT EVENTS</h2><ul>${events || '<li class="mute">Nothing yet</li>'}</ul></div>
<div class="mute" style="font-size:12px">${esc(m.universe.note)}. Shorts are simulated. Educational only, not financial advice.</div></div></body></html>`;
}

// ============================== ROUTES ==============================
const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env).catch((e) => console.error("tick failed:", e)));
  },

  async fetch(req, env) {
    const url = new URL(req.url), cfg = getCfg(env);
    const authed = env.ADMIN_TOKEN && req.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`;

    if (req.method === "POST" && url.pathname === "/api/run") {
      return authed ? json(await tick(env)) : json({ error: "unauthorized" }, 401);
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      if (!authed) return json({ error: "unauthorized" }, 401);
      await env.BOT_KV.delete("state");
      return json({ ok: true, message: "Paper account reset" });
    }

    const s = await loadState(env, cfg);
    const age = Math.min(MAX_CROSS_AGE, Math.max(1, parseInt(url.searchParams.get("age") || "1", 10) || 1));
    if (cfg.MODE !== "trade" && (url.pathname === "/api/screen" || url.pathname === "/api/status")) return json(screenData(s, cfg, age));
    if (url.pathname === "/api/status") return json(summary(s, cfg));
    if (url.pathname === "/api/trades") return json(s.closed);
    if (url.pathname === "/api/universe") return json({ source: s.universeSource, note: s.universeNote, symbols: s.universe });
    const html = cfg.MODE === "trade" ? page(s, cfg) : screenPage(s, cfg, age);
    return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
  },
};
