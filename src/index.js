/**
 * MACD SCREENER (OKX data) + paper-trading sim for Cloudflare Workers.
 *
 
 * MODE "screen": scanner only. MODE "sim": leveraged PAPER trades from screener crosses (fake money).
 * MODE "trade": old MACD stop-and-reverse paper bot.
 *
 * OI filter (sim): a MACD cross is only traded when open interest grew at least OI_MIN_CHANGE over OI_LOOKBACK candles.
 *
 * SIM features: BTC-follower leverage (30x) vs other coins (10x), fixed margin per position,
 * TP_USDT: when a position reaches +TP_USDT net profit it is NOT closed; a retracing stop takes over
 * and follows the best price, giving back at most TRAIL_GIVEBACK of the peak profit. All P&L in USDT.
 *
 * Endpoints: GET /  GET /api/oi  GET /api/status  GET /api/trades  GET /api/universe  GET /api/screen  GET /api/followers
 *            POST /api/run  POST /api/reset   (Authorization: Bearer <ADMIN_TOKEN>)
 * Educational only. Not financial advice.
 */

// ============================== CONFIG ==============================
const OKX_HOST = "https://www.okx.com";

const DEFAULTS = {
  GRANULARITY: 900,           // seconds: 300 (5m), 900 (15m), 3600, 14400, 86400
  MODE: "sim",                // "screen" | "sim" | "trade"
  SCREEN_BATCH: 33,           // coins scanned per run (free plan: max 50 subrequests per run; OI filter uses 1)
  START_CASH: 10000,
  FEE: 0.001,
  SLIPPAGE: 0.0015,
  SHORT_CARRY_HOURLY: 0.0000125,

  MACD_FAST: 12, MACD_SLOW: 26, MACD_SIGNAL: 9,

  POSITION_PCT: 0.10,
  MAX_EXPOSURE: 0.80,
  MAX_POSITIONS: 22,
  SAFETY_STOP_PCT: 0.15,
  DAILY_LOSS_LIMIT: 0.04,
  MAX_DRAWDOWN: 0.20,
  HALT_DAYS: 5,

  MAX_SYMBOLS: 60,
  MIN_QUOTE_VOLUME: 1000000,
  UNIVERSE_REFRESH_H: 6,
  KLINE_LIMIT: 300,

  // --- MODE "sim" ---
  LEV_FOLLOW: 30,             // leverage for coins that follow BTC
  LEV_OTHER: 10,              // leverage for everything else
  FOLLOWERS: "",              // comma list of coins always treated as BTC followers, e.g. "DOGE,PEPE,SHIB"
  FOLLOWERS_ONLY: 1,          // 1 = scan and trade only BTC followers
  RESET_ID: "2",              // change this value (e.g. "3", "4") and redeploy to wipe the paper account and start afresh
  BTC_CORR: 0.6,              // a coin "follows BTC" when its return correlation with BTC is at least this
  CORR_BARS: 100,             // candles used for the correlation
  POSITION_MARGIN: 1,         // every position uses this much margin (USDT); size = margin x leverage. 0 = compounding margin
  SIM_MARGIN: 1.1,            // start funds = SIM_MARGIN x MAX_POSITIONS (a little above POSITION_MARGIN to cover fees)
  OI_FILTER: 1,               // 1 = only enter a MACD cross when open interest is rising (new money in the move). 0 = off
  OI_LOOKBACK: 4,             // OI change is measured over this many candles (4 x 15m = 1 hour)
  OI_MIN_CHANGE: 0.005,       // OI must have grown at least this much (0.005 = +0.5%) over the lookback
  MIN_SCORE: 0,               // minimum rating (0-8) to enter. 5 = STRONG only
  TPSL_MODE: "size",          // "size" = TP/SL as % of POSITION SIZE (price move), "atr" = volatility-scaled
  TP_USDT: 0.04,              // NET profit (USDT, after fees) at which the retracing stop switches on. 0 = old fixed-TP mode
  TP_SIZE_PCT: 0.16,          // size mode (only when TP_USDT = 0): take profit = 16% of position size
  SL_SIZE_PCT: 0.053,         // size mode: stop loss = 5.3% of position size (capped at 90% of margin)
  SL_ATR: 1.5,                // stop distance = 1.5 x ATR
  MIN_SL_PCT: 0.0035,         // stop never tighter than 0.35% price move
  MAX_SL_MARGIN: 0.30,        // stop never risks more than 30% of margin
  RR_MIN: 1.5,                // reward:risk for a rating-0 cross
  RR_MAX: 3,                  // reward:risk for a rating-8 cross
  TRAIL: 1,                   // 1 = trailing stop on (must stay on when TP_USDT > 0)
  TRAIL_GIVEBACK: 0.4,        // once trailing, the stop allows giving back at most 40% of the best profit so far
  SIM_FEE: 0.0005,            // taker fee per side, on notional
  SIM_FEE_MAKER: 0.0002,      // maker fee, used for take-profit exits
  SIM_SLIP: 0.0003,           // slippage per fill
  SIM_CHECK_BATCH: 10,        // open positions whose candles are re-fetched per run
};

const STABLES = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "USDT", "EUR", "AEUR", "XUSD", "USD1", "PYUSD"]);
const INTERVALS = { 300: "5m", 900: "15m", 3600: "1H", 14400: "4H", 86400: "1D" };

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

/** Williams %R over the last n candles: 0 = at the high (overbought), -100 = at the low (oversold). */
function wr14(h, l, c, n = 14) {
  if (c.length < n) return null;
  const hh = Math.max(...h.slice(-n)), ll = Math.min(...l.slice(-n));
  return hh === ll ? null : ((hh - c[c.length - 1]) / (hh - ll)) * -100;
}

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

/** ATR as a fraction of the latest close (Wilder smoothing). */
function atrPct(h, l, c, n = 14) {
  if (c.length <= n + 1) return null;
  const tr = (i) => Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  let a = 0;
  for (let i = 1; i <= n; i++) a += tr(i);
  a /= n;
  for (let i = n + 1; i < c.length; i++) a = (a * (n - 1) + tr(i)) / n;
  return a / c[c.length - 1];
}

function compute(candles, cfg) {
  const m = macd(candles.map((x) => x[4]), cfg.MACD_FAST, cfg.MACD_SLOW, cfg.MACD_SIGNAL);
  return {
    t: candles.map((x) => x[0]), l: candles.map((x) => x[1]), h: candles.map((x) => x[2]),
    o: candles.map((x) => x[3]), c: candles.map((x) => x[4]), hist: m.hist, line: m.line,
  };
}

// ============================== SIGNAL ==============================
function macdCross(ind, i) {
  const a = ind.hist[i - 1], b = ind.hist[i];
  if (i < 1 || a == null || b == null) return 0;
  if (a <= 0 && b > 0) return 1;
  if (a >= 0 && b < 0) return -1;
  return 0;
}

/** Rates a cross out of 8 (ADX, DI agreement, 200-EMA side, zero-line side, cross sharpness, RSI stretch). */
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

// ============================== ENGINE (MODE "trade") ==============================
function newState(cfg) {
  return {
    cash: cfg.START_CASH, pos: {}, pending: {}, peak: cfg.START_CASH, day: null,
    dayStartEq: cfg.START_CASH, halted: false, haltUntil: 0, lastBar: {},
    closed: [], events: [], curve: [], mark: {}, equity: cfg.START_CASH,
    stats: { n: 0, wins: 0, gw: 0, gl: 0, sumPct: 0, longN: 0, longPnl: 0, shortN: 0, shortPnl: 0 },
    universe: [], universeAt: 0, universeSource: "", universeNote: "", zone: {},
    screen: {}, screenBar: {}, btc: null, corr: {}, oi: {}, oiNow: {},
    startedAt: nowSec(), lastTick: 0, lastError: null, resetId: String(cfg.RESET_ID ?? ""),
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

// ============================== DATA (OKX + CoinGecko) ==========================
const toInst = (sym) => sym.replace(/USDT$/, "-USDT");

async function okx(path, params) {
  const r = await fetch(`${OKX_HOST}${path}?${new URLSearchParams(params)}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  const j = await r.json();
  if (j.code !== "0") throw new Error(`OKX ${j.code}: ${j.msg}`);
  return j.data;
}

async function fetchTickers(cfg) {
  const list = await okx("/api/v5/market/tickers", { instType: "SPOT" });
  const prices = {}, volumes = {};
  for (const t of list) {
    if (!t.instId.endsWith("-USDT")) continue;
    const sym = t.instId.replace("-", "");
    prices[sym] = Number(t.last);
    volumes[sym] = Number(t.volCcy24h);
  }
  return { prices, volumes };
}

async function fetchKlines(cfg, sym, now) {
  const bar = INTERVALS[cfg.GRANULARITY];
  if (!bar) throw new Error("Unsupported GRANULARITY");
  const list = await okx("/api/v5/market/candles", { instId: toInst(sym), bar, limit: String(Math.min(300, cfg.KLINE_LIMIT)) });
  return list
    .map((k) => [Math.floor(+k[0] / 1000), +k[3], +k[2], +k[1], +k[4], +k[5]])
    .sort((a, b) => a[0] - b[0])
    .filter((c) => c[0] + cfg.GRANULARITY <= now);
}

/** Open interest (USD) for every USDT perpetual, in ONE request. Keys look like "BTCUSDT". */
async function fetchOI() {
  const list = await okx("/api/v5/public/open-interest", { instType: "SWAP" });
  const out = {};
  for (const x of list) {
    if (!x.instId.endsWith("-USDT-SWAP")) continue;
    const v = Number(x.oiUsd);
    if (v > 0) out[x.instId.replace("-USDT-SWAP", "USDT")] = v;
  }
  return out;
}

/** Keeps one OI reading per candle per coin (taken at the first tick of the candle) plus the latest reading. */
function recordOI(cfg, s, oi, now) {
  const gran = cfg.GRANULARITY, bucket = Math.floor(now / gran) * gran;
  if (!s.oi) s.oi = {};
  if (!s.oiNow) s.oiNow = {};
  for (const sym of s.universe) {
    const v = oi[sym];
    if (!v) continue;
    const h = s.oi[sym] || (s.oi[sym] = []);
    if (!h.length || h[h.length - 1][0] < bucket) h.push([bucket, v]);
    while (h.length > cfg.OI_LOOKBACK + 3) h.shift();
    s.oiNow[sym] = v;
  }
}

/** OI change (fraction) over the lookback, or null while there is not enough history yet (warm-up). */
function oiChange(cfg, s, sym, now) {
  const gran = cfg.GRANULARITY, h = s.oi && s.oi[sym], cur = s.oiNow && s.oiNow[sym];
  if (!h || !cur) return null;
  const target = Math.floor(now / gran) * gran - cfg.OI_LOOKBACK * gran;
  let ref = null;
  for (const e of h) if (e[0] <= target) ref = e;
  if (!ref || !ref[1] || target - ref[0] > 2 * gran) return null;
  return cur / ref[1] - 1;
}

function oiData(s, cfg, now = nowSec()) {
  const rows = s.universe.map((sym) => ({ sym, oiUsd: (s.oiNow && s.oiNow[sym]) ?? null, change: oiChange(cfg, s, sym, now) }))
    .sort((a, b) => (b.change ?? -9) - (a.change ?? -9));
  return { filter: !!cfg.OI_FILTER, lookbackCandles: cfg.OI_LOOKBACK, minChange: cfg.OI_MIN_CHANGE,
    ready: rows.filter((r) => r.change != null).length, total: rows.length, coins: rows };
}

/** Pearson correlation of candle-to-candle returns between a coin and BTC (aligned by timestamp). */
function btcCorr(kl, btcMap, n) {
  if (!btcMap) return null;
  const xs = [], ys = [];
  for (let i = 1; i < kl.length; i++) {
    const b0 = btcMap[kl[i - 1][0]], b1 = btcMap[kl[i][0]];
    if (!b0 || !b1) continue;
    xs.push(kl[i][4] / kl[i - 1][4] - 1);
    ys.push(b1 / b0 - 1);
  }
  const m = Math.min(n, xs.length);
  if (m < 30) return null;
  const x = xs.slice(-m), y = ys.slice(-m);
  const mx = x.reduce((a, v) => a + v, 0) / m, my = y.reduce((a, v) => a + v, 0) / m;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < m; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** 30x for BTC followers, 10x for the rest. */
const forced = (cfg) => new Set(String(cfg.FOLLOWERS || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean).map((x) => (x.endsWith("USDT") ? x : x + "USDT")));
/** A coin is a follower if it is in the FOLLOWERS list, or its BTC correlation is high enough. */
const isFollower = (cfg, r, sym) => forced(cfg).has(sym) || (r.corr != null && r.corr >= cfg.BTC_CORR);
const levFor = (cfg, r, sym) => (isFollower(cfg, r, sym) ? cfg.LEV_FOLLOW : cfg.LEV_OTHER);

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

async function mapLimit(items, limit, fn) {
  for (const item of items) {
    await fn(item);
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ============================= SCREENER =============================
const MAX_CROSS_AGE = 5;

async function screenScan(cfg, s, volumes, now, lastClosedOpen) {
  // BTC closes, refreshed once per candle (1 subrequest) and cached in state
  if (!s.btc || s.btc.bar < lastClosedOpen) {
    try {
      const bk = await fetchKlines(cfg, "BTCUSDT", now);
      s.btc = { bar: lastClosedOpen, c: Object.fromEntries(bk.map((k) => [k[0], k[4]])) };
    } catch (e) { s.lastError = "btc: " + e.message; }
  }
  // FOLLOWERS_ONLY: scan listed followers and coins with high BTC correlation. Unknown coins are scanned once
  // to measure correlation; known non-followers are only rechecked about once an hour.
  const fset = forced(cfg);
  const want = (sym) => !cfg.FOLLOWERS_ONLY || fset.has(sym) || s.corr[sym] == null || s.corr[sym] >= cfg.BTC_CORR || (s.screenBar[sym] || 0) < lastClosedOpen - 12 * cfg.GRANULARITY;
  const need = s.universe.filter((sym) => want(sym) && (s.screenBar[sym] || 0) < lastClosedOpen).slice(0, cfg.SCREEN_BATCH);
  const klines = {};
  await mapLimit(need, 4, async (sym) => {
    try { klines[sym] = await fetchKlines(cfg, sym, now); }
    catch (e) { s.lastError = `klines ${sym}: ${e.message}`; }
  });
  for (const sym of need) {
    const kl = klines[sym];
    if (!kl) continue;
    const ind = compute(kl, cfg), last = ind.t.length - 1;
    s.corr[sym] = btcCorr(kl, s.btc && s.btc.c, cfg.CORR_BARS);   // BTC correlation for every scanned coin
    s.screenBar[sym] = last >= 0 ? ind.t[last] : lastClosedOpen;
    delete s.screen[sym];
    for (let k = 0; k < MAX_CROSS_AGE && last - k >= 1; k++) {
      const side = macdCross(ind, last - k);
      if (!side) continue;
      const rt = rate(side, ind, last, last - k);
      s.screen[sym] = { side, age: k + 1, crossT: ind.t[last - k], barT: ind.t[last], price: ind.c[last],
        hist: ind.hist[last], strength: Math.abs(ind.hist[last - k]) / ind.c[last - k], vol: volumes[sym] ?? 0,
        atr: atrPct(ind.h, ind.l, ind.c), wr: wr14(ind.h, ind.l, ind.c), corr: s.corr[sym], ...rt };
      break;
    }
  }
}

function screenData(s, cfg, age, now = nowSec()) {
  const gran = cfg.GRANULARITY, latest = Math.floor(now / gran) * gran - gran;
  const rows = Object.entries(s.screen)
    .filter(([sym, r]) => s.universe.includes(sym) && (!cfg.FOLLOWERS_ONLY || isFollower(cfg, r, sym)))
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

// ========================= LEVERAGED SIM (MODE "sim") =========================
// Stop = SL_SIZE_PCT of position size (or SL_ATR x ATR in "atr" mode).
// Target: when TP_USDT > 0, a position that reaches +TP_USDT NET profit is NOT closed. The retracing
// stop switches on and trails the best price, giving back at most TRAIL_GIVEBACK of the peak profit.
// When TP_USDT = 0 the old fixed take-profit is used.
function newSim(cfg) {
  const start = cfg.SIM_MARGIN * cfg.MAX_POSITIONS;
  return { start, cash: start, base: cfg.SIM_MARGIN, pos: {}, closed: [], events: [], curve: [], mark: {},
    lastCross: {}, stats: { n: 0, wins: 0, gw: 0, gl: 0, pnl: 0 }, peak: start, startedAt: nowSec() };
}

function simEquity(sim) {
  return Object.entries(sim.pos).reduce((e, [k, p]) => {
    const px = sim.mark[k] ?? p.entry;
    return e + Math.max(0, p.margin + p.side * (px - p.entry) * p.qty);
  }, sim.cash);
}

/** Real (net) unrealized P&L in USDT: price move minus the entry fee already paid and the estimated exit fee. */
function posPnl(cfg, p, px) {
  if (!px) return 0;
  return p.side * (px - p.entry) * p.qty - p.fee - p.qty * px * cfg.SIM_FEE;
}

function simEvent(sim, kind, sym, t, info) {
  sim.events.unshift({ kind, sym, t, info });
  if (sim.events.length > 40) sim.events.length = 40;
}

function simOpen(cfg, sim, sym, side, price, t, rt, lev) {
  if (sim.pos[sym] || Object.keys(sim.pos).length >= cfg.MAX_POSITIONS) return false;
  const fill = price * (1 + side * cfg.SIM_SLIP);
  const want = cfg.POSITION_MARGIN > 0 ? cfg.POSITION_MARGIN : sim.base;   // fixed margin: size = margin x leverage
  const margin = Math.min(want, sim.cash / (1 + lev * cfg.SIM_FEE));
  if (margin < 0.05) return false;
  const notional = margin * lev, qty = notional / fill, fee = notional * cfg.SIM_FEE;
  sim.cash -= margin + fee;

  let slMove, tpMove;
  if (cfg.TPSL_MODE === "size") {
    slMove = Math.min(cfg.SL_SIZE_PCT, 0.9 / lev);   // never beyond 90% of margin (liquidation)
    tpMove = cfg.TP_SIZE_PCT;
  } else {
    const atr = rt.atr ?? 0.004;
    slMove = Math.min(Math.max(atr * cfg.SL_ATR, cfg.MIN_SL_PCT), cfg.MAX_SL_MARGIN / lev);
    tpMove = slMove * (cfg.RR_MIN + (cfg.RR_MAX - cfg.RR_MIN) * Math.min(rt.score ?? 0, 8) / 8);
  }

  // TP_USDT: price move that gives +TP_USDT NET profit (entry fee + estimated exit fee included).
  // The position is not closed there: the retracing stop starts trailing from this level.
  let trailStart = 0; // Activated immediately upon position placement
  if (cfg.TP_USDT > 0) {
    tpMove = (cfg.TP_USDT + fee + notional * cfg.SIM_FEE) / notional;
  }
  const rr = tpMove / slMove;

  sim.pos[sym] = {
    side, qty, entry: fill, best: fill, margin, fee, t, lev, btc: isFollower(cfg, rt, sym), corr: rt.corr ?? null,
    chk: Math.floor(t / cfg.GRANULARITY) * cfg.GRANULARITY,
    oi: rt.oi ?? null, label: rt.label, score: rt.score, adx: rt.adx, rsi: rt.rsi, wr: rt.wr ?? null,
    tp: fill * (1 + side * tpMove), sl: fill * (1 - side * slMove),
    ts: trailStart, td: slMove, rr, trailing: false,
  };
  sim.mark[sym] = price;
  const tpTxt = cfg.TP_USDT > 0 ? `trail starts immediately (net target +${cfg.TP_USDT} USDT, move ${(tpMove * 100).toFixed(2)}%)` : `TP ${(tpMove * 100).toFixed(2)}% (${rr.toFixed(1)}R)`;
  simEvent(sim, "OPEN " + SIDE(side), sym, t,
    `${rt.label} ${rt.score}/8, ${rt.oi != null ? `OI ${rt.oi >= 0 ? "+" : ""}${(rt.oi * 100).toFixed(2)}%, ` : ""}${lev}x${isFollower(cfg, rt, sym) ? " BTC-follower" : ""}, margin ${margin.toFixed(3)} USDT, size ${notional.toFixed(2)} USDT, SL ${(slMove * 100).toFixed(2)}%, ${tpTxt}`);
  return true;
}

function simClose(cfg, sim, sym, fill, t, reason) {
  const p = sim.pos[sym];
  delete sim.pos[sym];
  delete sim.mark[sym];
  const gross = p.side * (fill - p.entry) * p.qty;
  const rate = reason.startsWith("take profit") ? cfg.SIM_FEE_MAKER : cfg.SIM_FEE;
  const exitFee = p.qty * fill * rate;
  sim.cash += Math.max(0, p.margin + gross - exitFee);
  const pnl = gross - exitFee - p.fee;
  sim.closed.push({ sym, side: p.side, tIn: p.t, tOut: t, entry: p.entry, exit: fill, margin: p.margin, lev: p.lev, btc: p.btc, pnl, reason, label: p.label, score: p.score, rsi: p.rsi ?? null, wr: p.wr ?? null });
  if (sim.closed.length > 300) sim.closed.shift();
  const st = sim.stats;
  st.n++;
  st.pnl = (st.pnl || 0) + pnl;
  if (pnl > 0) { st.wins++; st.gw += pnl; if (!(cfg.POSITION_MARGIN > 0)) sim.base += pnl / cfg.MAX_POSITIONS; } else st.gl += -pnl;
  simEvent(sim, "CLOSE " + SIDE(p.side), sym, t, `${reason}, P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT`);
}

/** Retracing stop: starts once the position reaches the trail-start level (TP_USDT net, or half the TP distance in the
 *  old mode), then locks in (1 - TRAIL_GIVEBACK) of the best profit reached. Never loosens. */
function simTrail(cfg, p, h, l) {
  if (!cfg.TRAIL || !p.td) return;
  if (p.side > 0) p.best = Math.max(p.best, h); else p.best = Math.min(p.best, l);
  const peak = p.side * (p.best / p.entry - 1);                     // best profit so far, as a price move
  if (peak < p.ts) return;
  const sl = p.entry * (1 + p.side * peak * (1 - cfg.TRAIL_GIVEBACK));
  if (p.side > 0 ? sl > p.sl : sl < p.sl) { p.sl = sl; p.trailing = true; }
}

function simExit(cfg, p, o, h, l) {
  const s = p.side;
  if (s > 0 ? l <= p.sl : h >= p.sl) {
    return { px: (s > 0 ? Math.min(o, p.sl) : Math.max(o, p.sl)) * (1 - s * cfg.SIM_SLIP), reason: p.trailing ? "trailing stop" : "stop loss" };
  }
  if (cfg.TP_USDT > 0 && cfg.TRAIL) return null;   // no hard TP: the retracing stop takes over
  if (s > 0 ? h >= p.tp : l <= p.tp) return { px: s > 0 ? Math.max(o, p.tp) : Math.min(o, p.tp), reason: "take profit" };
  return null;
}

async function simStep(cfg, s, prices, now) {
  const sim = s.sim, gran = cfg.GRANULARITY;
  const latest = Math.floor(now / gran) * gran - gran;

  // 1) exits: replay closed candles after the entry candle, then check the live price
  const syms = Object.keys(sim.pos)
    .filter((k) => (sim.pos[k].chk || 0) < latest)
    .sort((a, b) => (sim.pos[a].chk || 0) - (sim.pos[b].chk || 0))
    .slice(0, cfg.SIM_CHECK_BATCH);
  const klines = {};
  await mapLimit(syms, 4, async (sym) => {
    try { klines[sym] = await fetchKlines(cfg, sym, now); } catch (e) { s.lastError = `sim klines ${sym}: ${e.message}`; }
  });
  for (const sym of syms) {
    let p = sim.pos[sym];
    const entryBar = Math.floor(p.t / gran) * gran;
    for (const k of klines[sym] || []) {
      if (!p || k[0] <= entryBar) continue;
      const x = simExit(cfg, p, k[3], k[2], k[1]);
      if (x) { simClose(cfg, sim, sym, x.px, k[0] + gran, x.reason); p = null; }
      else simTrail(cfg, p, k[2], k[1]);
    }
    if (sim.pos[sym] && klines[sym]) sim.pos[sym].chk = latest;
  }
  for (const sym of Object.keys(sim.pos)) {
    const p = sim.pos[sym], px = prices[sym];
    if (!px) continue;
    const x = simExit(cfg, p, px, px, px);
    if (x) simClose(cfg, sim, sym, x.px, now, x.reason + " (live)");
    else { sim.mark[sym] = px; p.pxT = now; simTrail(cfg, p, px, px); }
  }

  // 2) entries: crosses on the latest closed candle that meet the minimum rating
  const cands = [];
  for (const [sym, r] of Object.entries(s.screen)) {
    if (!s.universe.includes(sym) || sim.pos[sym] || !prices[sym]) continue;
    if (cfg.FOLLOWERS_ONLY && !isFollower(cfg, r, sym)) continue;
    const age = r.age + Math.round((latest - r.barT) / gran);
    if (age !== 1 || r.score == null || r.score < cfg.MIN_SCORE || r.crossT <= (sim.lastCross[sym] || 0)) continue;
    let rr = r;
    if (cfg.OI_FILTER) {
      const chg = oiChange(cfg, s, sym, now);
      if (chg == null || chg < cfg.OI_MIN_CHANGE) continue;   // no OI history yet, or OI not rising: skip this cross
      rr = { ...r, oi: chg };
    }
    cands.push({ sym, r: rr });
  }
  cands.sort((a, b) => b.r.score - a.r.score || b.r.vol - a.r.vol);
  for (const { sym, r } of cands) {
    if (simOpen(cfg, sim, sym, r.side, prices[sym], now, r, levFor(cfg, r, sym))) sim.lastCross[sym] = r.crossT;
  }
  for (const k of Object.keys(sim.lastCross)) if (sim.lastCross[k] < now - 86400) delete sim.lastCross[k];

  const eq = simEquity(sim);
  sim.peak = Math.max(sim.peak, eq);
  const lastPt = sim.curve[sim.curve.length - 1];
  if (!lastPt || now - lastPt[0] >= 900) { sim.curve.push([now, eq]); if (sim.curve.length > 700) sim.curve.shift(); }
}

function simSummary(s, cfg) {
  const sim = s.sim || newSim(cfg), st = sim.stats, eq = simEquity(sim);
  const open = Object.entries(sim.pos).map(([sym, p]) => {
    const px = sim.mark[sym];
    return { sym, side: SIDE(p.side), lev: p.lev || cfg.LEV_OTHER, btc: !!p.btc, corr: p.corr ?? null, entry: p.entry, price: px, tp: p.tp, sl: p.sl,
      trailing: !!p.trailing, pxT: p.pxT || null, margin: p.margin, size: p.margin * (p.lev || cfg.LEV_OTHER), rating: `${p.label} ${p.score}/8`, pnlUsdt: posPnl(cfg, p, px) };
  });
  const unrealized = open.reduce((a, p) => a + p.pnlUsdt, 0);
  const realized = st.pnl || 0;
  return {
    mode: "sim", minScore: cfg.MIN_SCORE,
    equity: eq, start: sim.start, cash: sim.cash, marginInUse: open.reduce((a, p) => a + p.margin, 0),
    totalPnlUsdt: realized + unrealized, realizedPnlUsdt: realized, unrealizedPnlUsdt: unrealized,
    marginPerPosition: sim.base, drawdownUsdt: sim.peak - eq,
    openPositions: open,
    trades: { count: st.n, wins: st.wins, winRate: st.n ? st.wins / st.n : null, profitFactor: st.gl > 0 ? st.gw / st.gl : null },
    lastTick: s.lastTick, lastError: s.lastError,
  };
}

// =============================== TICK ===============================
async function loadState(env, cfg) {
  const saved = await env.BOT_KV.get("state", "json");
  const fresh = newState(cfg);
  // RESET_ID changed since the saved state was written: drop all open positions and history, start afresh
  if (saved && String(saved.resetId ?? "") !== String(cfg.RESET_ID ?? "")) return fresh;
  return saved ? { ...fresh, ...saved } : fresh;
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

  if (cfg.MODE === "sim") {
    if (!s.sim) s.sim = newSim(cfg);
    if (cfg.OI_FILTER) {
      try { recordOI(cfg, s, await fetchOI(), now); } catch (e) { s.lastError = "oi: " + e.message; }
    }
    await screenScan(cfg, s, volumes, now, lastClosedOpen);
    await simStep(cfg, s, prices, now);
    await env.BOT_KV.put("state", JSON.stringify(s));
    return simSummary(s, cfg);
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
/** Signed USDT amount, e.g. +0.1234 USDT */
const usdt = (n, d = 4) => (n > 0 ? "+" : n < 0 ? "-" : "") + Math.abs(n).toFixed(d) + " USDT";
const usdtPlain = (n, d = 2) => n.toFixed(d) + " USDT";

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
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.big{font-size:24px;font-weight:650}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:var(--mute);font-weight:500}td,th{padding:6px 4px;border-top:1px solid var(--line);vertical-align:top}
.scroll{overflow-x:auto}.spark{width:100%;height:60px;color:var(--text)}ul{padding-left:18px;margin:6px 0}h2{font-size:14px;margin:0 0 8px;color:var(--mute);font-weight:600}
.warn{color:var(--down)} .tag{font-size:10px;padding:1px 5px;border-radius:6px;border:1px solid var(--line);color:var(--mute);margin-left:4px}
.tabs a{display:inline-block;margin-right:8px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;color:var(--text);text-decoration:none;font-size:13px}
.tabs a.on{background:var(--text);color:var(--bg)}
.lv3{font-weight:800}.lv2{font-weight:700}.lv1{font-weight:600}.lv0{font-weight:500;color:var(--mute)}.small{font-size:12px}`;

const usd = (n) => (n >= 1e6 ? "$" + (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? "$" + Math.round(n / 1e3) + "K" : "$" + Math.round(n));
const hhmm = (t) => new Date((t + 3 * 3600) * 1000).toISOString().slice(11, 16);   // EAT (UTC+3)

function ratingCell(r) {
  if (!r.label) return `<span class="mute">updating...</span>`;
  const lv = r.score >= 7 ? 3 : r.score >= 5 ? 2 : r.score >= 3 ? 1 : 0;
  return `<span class="lv${lv}">${r.label}</span> <span class="mute">${r.score}/8</span><br>
    <span class="mute small">${esc(r.trend)}${r.adx != null ? " · ADX " + Math.round(r.adx) : ""}${r.rsi != null ? " · RSI " + Math.round(r.rsi) : ""}<br>
    200-EMA ${r.emaOk ? "✓" : "✗"} · zero-line ${r.zeroOk ? "✓" : "✗"}</span>`;
}

function screenTables(d, cfg) {
  const ageTxt = (r) => (r.age === 1 ? "last candle" : `${r.age} candles ago`);
  const tbl = (rows, cls) => `<div class="scroll"><table><tr><th>Coin</th><th>Crossed</th><th>Rating</th><th>RSI</th><th>%R</th><th>Price</th><th>24h vol</th></tr>${
    rows.map((r) => `<tr><td><b>${esc(r.sym.replace("USDT", ""))}</b>${r.iz ? ' <span class="tag">IZ</span>' : ""}${isFollower(cfg, r, r.sym) ? ` <span class="tag">BTC ${cfg.LEV_FOLLOW}x</span>` : ""}${r.corr != null ? `<br><span class="mute small">BTC corr ${r.corr.toFixed(2)}</span>` : ""}</td>
      <td class="${cls}">${hhmm(r.crossT + cfg.GRANULARITY)} EAT<br><span class="mute">${ageTxt(r)}</span></td>
      <td class="${cls}">${ratingCell(r)}</td>
      <td>${r.rsi != null ? Math.round(r.rsi) : "-"}</td>
      <td>${r.wr != null ? Math.round(r.wr) : "-"}</td>
      <td>${num(r.price)}</td><td>${usd(r.vol)}</td></tr>`).join("")
    || `<tr><td colspan="7" class="mute">No coins match right now</td></tr>`}</table></div>`;
  return `<div class="card"><h2 class="up">LONG · MACD crossed UP (${d.long.length})</h2>${tbl(d.long, "up")}</div>
<div class="card"><h2 class="down">SHORT · MACD crossed DOWN (${d.short.length})</h2>${tbl(d.short, "down")}</div>`;
}

/** Every watched coin with its BTC correlation and the leverage it will get. */
function followerData(s, cfg) {
  const rows = s.universe.map((sym) => {
    const corr = s.corr && s.corr[sym] != null ? s.corr[sym] : null;
    const follower = isFollower(cfg, { corr }, sym);
    return { sym, corr, follower, forced: forced(cfg).has(sym), leverage: follower ? cfg.LEV_FOLLOW : cfg.LEV_OTHER };
  }).sort((a, b) => (b.corr ?? -2) - (a.corr ?? -2));
  return { threshold: cfg.BTC_CORR, followers: rows.filter((r) => r.follower).length, total: rows.length, coins: rows };
}

function followersCard(s, cfg) {
  const d = followerData(s, cfg);
  const rows = d.coins.map((r) => `<tr><td><b>${esc(r.sym.replace("USDT", ""))}</b></td><td>${r.corr == null ? "-" : r.corr.toFixed(2)}</td>
    <td class="${r.follower ? "up" : ""}">${r.forced ? "BTC follower (list)" : r.corr == null ? "not scanned yet" : r.follower ? "BTC follower" : "other"}</td><td>${r.corr == null && !r.forced ? "-" : r.leverage + "x"}</td></tr>`).join("");
  return `<div class="card"><h2>BTC FOLLOWERS · ${d.followers} of ${d.total} (correlation ≥ ${d.threshold})</h2>
<div class="mute small" style="margin-bottom:8px">Correlation of ${cfg.GRANULARITY / 60}m returns with BTC over the last ${cfg.CORR_BARS} candles. 1.00 = moves exactly with BTC, 0 = unrelated. Change BTC_CORR to move the line.</div>
<div class="scroll"><table><tr><th>Coin</th><th>BTC corr</th><th>Type</th><th>Leverage</th></tr>${rows}</table></div></div>`;
}

function screenPage(s, cfg, age) {
  const d = screenData(s, cfg, age);
  const tabs = [1, 2, 3].map((n) => `<a href="?age=${n}" class="${n === age ? "on" : ""}">${n === 1 ? "Last candle" : "≤ " + n + " candles"}</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>MACD Screener</title><style>${STYLE}</style></head><body><div class="wrap">
<h1>MACD Screener (OKX) · ${d.timeframe}</h1>
<div class="mute">Scanned ${d.scanned}/${d.total} coins for the ${hhmm(d.latestCandleOpen + cfg.GRANULARITY)} EAT candle close · ${esc(d.scope)} · updated ${ago(s.lastTick)}</div>
${d.lastError ? `<div class="warn">Last error: ${esc(d.lastError)}</div>` : ""}
<div class="card tabs">${tabs}<div class="mute" style="margin-top:8px;font-size:13px">Shows coins whose MACD (${cfg.MACD_FAST}/${cfg.MACD_SLOW}/${cfg.MACD_SIGNAL}) crossed its signal line within this many closed candles. Times in EAT. Best-rated first.</div></div>
${screenTables(d, cfg)}
<div class="card small mute"><b>How to read the rating (out of 8).</b> ADX measures trend strength: under 20 choppy, 25+ trending, 40+ strong, 50+ very strong. Points are added when the trend direction agrees with the cross, price is on the right side of the 200-EMA, the MACD line is on the right side of zero, and the cross is sharper than recent candles. A point is removed if RSI is already stretched. VERY STRONG = 7-8, STRONG = 5-6, MODERATE = 3-4, WEAK = 0-2. RSI and %R are read at the latest closed candle. %R runs from 0 (at the 14-candle high) to -100 (at the low); above -20 is overbought, below -80 oversold.</div>
<div class="mute" style="font-size:12px">${esc(d.note)}. Screener only: no trades are placed. Educational, not financial advice.</div></div></body></html>`;
}

function simPage(s, cfg, tab = "sim", age = 1) {
  const sim = s.sim || newSim(cfg), m = simSummary(s, cfg), scr = screenData(s, cfg, age);
  const tpLabel = cfg.TP_USDT > 0 ? "Trail from" : "TP";
  const rows = m.openPositions.map((p) => `<tr><td><b>${esc(p.sym.replace("USDT", ""))}</b><br><span class="mute small">${p.lev}x${p.btc ? " · BTC" : ""}</span></td><td class="${p.side === "LONG" ? "up" : "down"}">${p.side}</td>
    <td>${num(p.entry)}<br><span class="mute small">${tpLabel} ${num(p.tp)} · SL ${num(p.sl)}${p.trailing ? " · trailing" : ""}</span></td><td>${p.price ? num(p.price) : "-"}<br><span class="mute small">${p.pxT ? ago(p.pxT) : ""}</span></td>
    <td class="${clr(p.pnlUsdt)}">${usdt(p.pnlUsdt)}<br><span class="mute small">size ${p.size.toFixed(2)}</span></td><td class="mute small">${esc(p.rating)}</td></tr>`).join("")
    || `<tr><td colspan="6" class="mute">No open positions</td></tr>`;
  const events = sim.events.slice(0, 10).map((e) => `<li><b>${esc(e.kind)}</b> ${esc(e.sym.replace("USDT", ""))} <span class="mute">${esc(e.info)}</span></li>`).join("");
  const tpHeader = cfg.TP_USDT > 0
    ? `retracing stop starts immediately, SL ${(cfg.SL_SIZE_PCT * 100).toFixed(1)}% of size`
    : cfg.TPSL_MODE === "size" ? `TP ${(cfg.TP_SIZE_PCT * 100).toFixed(1)}% / SL ${(cfg.SL_SIZE_PCT * 100).toFixed(1)}% of position size` : `stop ${cfg.SL_ATR}×ATR, target ${cfg.RR_MIN}-${cfg.RR_MAX}R by rating`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>MACD Leverage Sim</title><style>${STYLE}</style></head><body><div class="wrap">
<h1>MACD Screener Sim · ${cfg.LEV_OTHER}x / ${cfg.LEV_FOLLOW}x paper trades</h1>
<div class="mute">Fake money · ${cfg.GRANULARITY / 60}m candles · ${cfg.FOLLOWERS_ONLY ? "BTC followers only · " : ""}${cfg.MIN_SCORE > 0 ? `enters ${cfg.MIN_SCORE}+/8 crosses` : "trades every cross on the last candle"} · ${cfg.LEV_FOLLOW}x for BTC followers (corr ≥ ${cfg.BTC_CORR}), else ${cfg.LEV_OTHER}x · ${tpHeader}${cfg.OI_FILTER ? ` · OI filter: +${(cfg.OI_MIN_CHANGE * 100).toFixed(1)}% over ${cfg.OI_LOOKBACK} candles` : ""}${cfg.TRAIL ? `, trailing (gives back max ${(cfg.TRAIL_GIVEBACK * 100).toFixed(0)}%)` : ""} · updated ${ago(s.lastTick)}</div>
${m.lastError ? `<div class="warn">Last error: ${esc(m.lastError)}</div>` : ""}
<div class="card tabs"><a href="?tab=sim" class="${tab === "sim" ? "on" : ""}">Sim trades (${m.openPositions.length} open)</a><a href="?tab=coins" class="${tab === "coins" ? "on" : ""}">Coins (${scr.long.length + scr.short.length} crossed)</a><a href="?tab=btc" class="${tab === "btc" ? "on" : ""}">BTC list</a></div>
${tab === "btc" ? followersCard(s, cfg) : tab === "coins" ? `<div class="card tabs"><div class="mute small" style="margin-bottom:8px">Scanned ${scr.scanned}/${scr.total} coins for the${hhmm(scr.latestCandleOpen + cfg.GRANULARITY)} EAT candle close. Coins that crossed on the last closed candle get a trade; the others are shown for reference.</div>${[1, 2, 3].map((n) => `<a href="?tab=coins&age=${n}" class="${n === age ? "on" : ""}">${n === 1 ? "Last candle" : "≤ " + n + " candles"}</a>`).join("")}</div>
${screenTables(scr, cfg)}` : `<div class="card"><div class="grid">
<div><div class="mute">Total P&amp;L (real, after fees)</div><div class="big ${clr(m.totalPnlUsdt)}">${usdt(m.totalPnlUsdt, 4)}</div></div>
<div><div class="mute">Equity (started ${usdtPlain(m.start)})</div><div class="big">${usdtPlain(m.equity, 4)}</div></div>
<div><div class="mute">Realized (closed trades)</div><span class="${clr(m.realizedPnlUsdt)}">${usdt(m.realizedPnlUsdt)}</span></div>
<div><div class="mute">Unrealized (open positions)</div><span class="${clr(m.unrealizedPnlUsdt)}">${usdt(m.unrealizedPnlUsdt)}</span></div>
<div><div class="mute">Margin per position</div>${usdtPlain(cfg.POSITION_MARGIN > 0 ? cfg.POSITION_MARGIN : m.marginPerPosition, 2)} <span class="mute small">(${cfg.LEV_OTHER}x =${((cfg.POSITION_MARGIN > 0 ? cfg.POSITION_MARGIN : m.marginPerPosition) * cfg.LEV_OTHER).toFixed(0)}, ${cfg.LEV_FOLLOW}x =${((cfg.POSITION_MARGIN > 0 ? cfg.POSITION_MARGIN : m.marginPerPosition) * cfg.LEV_FOLLOW).toFixed(0)} USDT size)</span></div>
<div><div class="mute">Free cash</div>${usdtPlain(m.cash, 4)}</div>
<div><div class="mute">Margin in use (${m.openPositions.length} open)</div>${usdtPlain(m.marginInUse, 2)}</div>
<div><div class="mute">Drawdown from peak</div>${usdtPlain(m.drawdownUsdt, 4)}</div></div>${sparkline(sim.curve)}</div>
<div class="card"><h2>OPEN POSITIONS (${m.openPositions.length}/${cfg.MAX_POSITIONS})</h2><div class="scroll"><table><tr><th>Coin</th><th>Side</th><th>Entry</th><th>Now</th><th>P&amp;L (net)</th><th>Rating</th></tr>${rows}</table></div></div>
<div class="card"><h2>TRADE HISTORY · ${m.trades.count} closed</h2><div class="grid">
<div><div class="mute">Wins</div><div class="big up">${m.trades.wins}</div></div>
<div><div class="mute">Losses</div><div class="big down">${m.trades.count - m.trades.wins}</div></div></div>
<div class="mute small" style="margin-top:8px">${m.trades.winRate != null ? `Win rate ${(m.trades.winRate * 100).toFixed(0)}% · profit factor ${m.trades.profitFactor ? m.trades.profitFactor.toFixed(2) : "∞"}` : "No closed trades yet"}</div></div>
<div class="card"><h2>RECENT EVENTS</h2><ul>${events || '<li class="mute">Nothing yet</li>'}</ul></div>`}
<div class="mute" style="font-size:12px">Simulation only. P&amp;L includes entry and exit fees (taker ${(cfg.SIM_FEE * 100).toFixed(2)}%, maker ${(cfg.SIM_FEE_MAKER * 100).toFixed(2)}% on take-profit) and ${(cfg.SIM_SLIP * 100).toFixed(2)}% slippage; no funding. Educational, not financial advice.</div></div></body></html>`;
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
    if (url.pathname === "/api/followers") return json(followerData(s, cfg));
    if (url.pathname === "/api/oi") return json(oiData(s, cfg));
    if (cfg.MODE === "sim") {
      if (url.pathname === "/api/screen") return json(screenData(s, cfg, age));
      if (url.pathname === "/api/status") return json(simSummary(s, cfg));
      if (url.pathname === "/api/trades") return json(s.sim ? s.sim.closed : []);
    }
    if (cfg.MODE !== "trade" && (url.pathname === "/api/screen" || url.pathname === "/api/status")) return json(screenData(s, cfg, age));
    if (url.pathname === "/api/status") return json(summary(s, cfg));
    if (url.pathname === "/api/trades") return json(s.closed);
    if (url.pathname === "/api/universe") return json({ source: s.universeSource, note: s.universeNote, symbols: s.universe });
    const html = cfg.MODE === "trade" ? page(s, cfg)
      : cfg.MODE === "sim" ? simPage(s, cfg, url.searchParams.get("tab") === "btc" ? "btc" : url.searchParams.get("tab") === "coins" || url.searchParams.get("view") === "screen" ? "coins" : "sim", age)
      : screenPage(s, cfg, age);
    return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
  },
};
