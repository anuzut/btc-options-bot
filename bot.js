const https = require("https");

// ─── CONFIG (injected via GitHub Secrets) ──────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID        = process.env.CHAT_ID;

// ─── HTTP HELPER ───────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "btc-options-bot/1.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Parse error for: " + url)); }
      });
    }).on("error", reject);
  });
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── INDICATORS ────────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses += Math.abs(d);
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcATR(klines, period = 14) {
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = parseFloat(klines[i][2]);
    const l = parseFloat(klines[i][3]);
    const pc = parseFloat(klines[i - 1][4]);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function roundStrike(price, step = 500) {
  return Math.round(price / step) * step;
}

// ─── MARKET DATA ───────────────────────────────────────────────────────────
async function fetchMarketData() {
  const [priceRes, klines4h, klines1h, fundingRes, dvolRes] = await Promise.all([
    fetchJSON("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
    fetchJSON("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=30"),
    fetchJSON("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=48"),
    fetchJSON("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT"),
    fetchJSON(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${Date.now() - 30 * 864e5}&end_timestamp=${Date.now()}&resolution=86400`),
  ]);

  const price    = parseFloat(priceRes.price);
  const closes4h = klines4h.map((k) => parseFloat(k[4]));
  const closes1h = klines1h.map((k) => parseFloat(k[4]));
  const rsi4h    = calcRSI(closes4h);
  const rsi1h    = calcRSI(closes1h);
  const atr4h    = calcATR(klines4h);
  const atrPct   = atr4h ? (atr4h / price) * 100 : null;
  const funding  = parseFloat(fundingRes.lastFundingRate) * 100;

  // Detect trend from 4H closes
  const last8 = closes4h.slice(-8);
  const sma8  = last8.reduce((a, b) => a + b, 0) / last8.length;
  const last20 = closes4h.slice(-20);
  const sma20  = last20.reduce((a, b) => a + b, 0) / last20.length;
  const trend  = price > sma8 && sma8 > sma20 ? "BULLISH"
               : price < sma8 && sma8 < sma20 ? "BEARISH"
               : "NEUTRAL";

  // ATR expansion check — is volatility expanding?
  const atrRecent = calcATR({ map: () => klines4h.slice(-8) } === null ? klines4h.slice(-8) : klines4h.slice(-8), 7);
  const atrExpanding = atr4h && atrRecent ? atrRecent > atr4h * 1.15 : false;

  // DVOL / IV
  let iv = 65, ivLow = 40, ivHigh = 100, ivr = 50;
  const dvol = dvolRes?.result?.data || [];
  if (dvol.length > 0) {
    const vals = dvol.map((d) => d[4]).filter(Boolean);
    iv     = vals[vals.length - 1];
    ivLow  = Math.min(...vals);
    ivHigh = Math.max(...vals);
    ivr    = ivHigh === ivLow ? 50 : ((iv - ivLow) / (ivHigh - ivLow)) * 100;
  }

  // SD levels for 7, 14, 21 DTE
  const sdLevels = [7, 14, 21].map((dte) => {
    const sd1 = price * (iv / 100) * Math.sqrt(dte / 365);
    const sd2 = sd1 * 2;
    return {
      dte,
      sd1: Math.round(sd1),
      sd2: Math.round(sd2),
      up1: roundStrike(price + sd1),
      dn1: roundStrike(price - sd1),
      up2: roundStrike(price + sd2),
      dn2: roundStrike(price - sd2),
    };
  });

  // Support / Resistance (simple: recent 20-period high/low on 4H)
  const high20 = Math.max(...closes4h.slice(-20));
  const low20  = Math.min(...closes4h.slice(-20));
  const distToResistancePct = ((high20 - price) / price) * 100;
  const distToSupportPct    = ((price - low20)  / price) * 100;

  return {
    price, rsi4h, rsi1h, atr4h, atrPct, atrExpanding,
    funding, iv, ivLow, ivHigh, ivr,
    trend, sma8, sma20,
    sdLevels,
    high20, low20,
    distToResistancePct, distToSupportPct,
  };
}

// ─── RULE-BASED STRATEGY ENGINE ────────────────────────────────────────────
function analyzeSignal(m) {
  const checks = {
    ivr_elevated:    { pass: m.ivr > 35,                           label: "IVR > 35",             value: `${m.ivr.toFixed(0)}%`                },
    rsi_neutral:     { pass: m.rsi4h >= 38 && m.rsi4h <= 62,      label: "RSI 4H: 38–62",        value: m.rsi4h.toFixed(1)                    },
    funding_neutral: { pass: m.funding >= -0.05 && m.funding <= 0.10, label: "Funding neutral",   value: `${m.funding.toFixed(4)}%`            },
    atr_stable:      { pass: !m.atrExpanding,                      label: "ATR not expanding",    value: m.atrExpanding ? "EXPANDING ⚠" : "STABLE" },
    iv_reasonable:   { pass: m.iv >= 40 && m.iv <= 120,           label: "IV in range (40–120%)", value: `${m.iv.toFixed(1)}%`                 },
  };

  const passed = Object.values(checks).filter((c) => c.pass).length;
  const total  = Object.keys(checks).length;

  // ── Determine DTE ──────────────────────────────────────────────────────
  // Higher IV → shorter DTE to capture premium faster
  // Stable/low IV → slightly longer for more credit
  let dte = 7;
  let dteRationale = "";
  if (m.iv > 80) {
    dte = 7;
    dteRationale = `IV is elevated at ${m.iv.toFixed(0)}% — shorter 7 DTE maximises theta burn on high premium`;
  } else if (m.iv >= 55) {
    dte = 10;
    dteRationale = `IV at ${m.iv.toFixed(0)}% is moderate-high — 10 DTE balances theta decay and gamma risk`;
  } else {
    dte = 14;
    dteRationale = `IV at ${m.iv.toFixed(0)}% is lower — 14 DTE needed to collect sufficient premium`;
  }

  // ── Pick SD level for selected DTE ─────────────────────────────────────
  const sdKey  = m.sdLevels.reduce((prev, cur) =>
    Math.abs(cur.dte - dte) < Math.abs(prev.dte - dte) ? cur : prev
  );

  // ── Strategy bias from trend ────────────────────────────────────────────
  let strategy = "Iron Condor";
  let stratRationale = "";
  let shortCall, longCall, shortPut, longPut;
  const spreadWidth = roundStrike(m.price * 0.04, 500); // ~4% of price

  if (m.trend === "BULLISH" && m.rsi4h < 55) {
    strategy      = "Bull Put Spread";
    stratRationale = `BTC trend is BULLISH (price > SMA8 > SMA20) and RSI not overbought — selling puts is safer than calls`;
    shortPut  = sdKey.dn2;
    longPut   = roundStrike(sdKey.dn2 - spreadWidth);
    shortCall = null; longCall = null;
  } else if (m.trend === "BEARISH" && m.rsi4h > 45) {
    strategy      = "Bear Call Spread";
    stratRationale = `BTC trend is BEARISH (price < SMA8 < SMA20) and RSI not oversold — selling calls is safer`;
    shortCall = sdKey.up2;
    longCall  = roundStrike(sdKey.up2 + spreadWidth);
    shortPut  = null; longPut = null;
  } else {
    strategy      = "Iron Condor";
    stratRationale = `BTC is in a NEUTRAL trend — Iron Condor captures premium on both sides within the 2SD range`;
    shortCall = sdKey.up2;
    longCall  = roundStrike(sdKey.up2  + spreadWidth);
    shortPut  = sdKey.dn2;
    longPut   = roundStrike(sdKey.dn2  - spreadWidth);
  }

  // ── Estimated delta for short strikes ──────────────────────────────────
  // At 2SD: delta ≈ 0.023 * (100/IV) * sqrt(365/DTE) — approximation
  const approxDelta = (0.15 * Math.sqrt(7 / dte) * (65 / m.iv)).toFixed(2);

  // ── Premium estimate: ~20-25% of spread width ──────────────────────────
  const minPremium = Math.round(spreadWidth * 0.20);
  const maxPremium = Math.round(spreadWidth * 0.28);
  const profitTarget = Math.round((minPremium + maxPremium) / 2 * 0.50);
  const stopLoss     = Math.round((minPremium + maxPremium) / 2 * 2.0);

  // ── Entry timing ───────────────────────────────────────────────────────
  const istHour = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).getHours();
  let entryTiming = "";
  if (istHour >= 13 && istHour <= 16) {
    entryTiming = "✅ Good time — US pre-market overlap (1–4 PM IST) often brings stable liquidity on Delta";
  } else if (istHour >= 19 && istHour <= 23) {
    entryTiming = "✅ US market hours active (7–11 PM IST) — highest liquidity window, best fills";
  } else if (istHour >= 8 && istHour <= 11) {
    entryTiming = "⚠️ Asia session (8–11 AM IST) — decent liquidity but check OI on Delta before entering";
  } else {
    entryTiming = "⚠️ Off-peak hours — verify bid-ask spread is ≤1.5% of premium before entering";
  }

  // ── Signal decision ────────────────────────────────────────────────────
  let signal = "WAIT";
  let avoidReason = "";

  if (passed >= 4) {
    signal = "ENTER_TRADE";
  } else if (!checks.ivr_elevated.pass) {
    signal = "WAIT";
    avoidReason = `IVR too low (${m.ivr.toFixed(0)}%) — premium not worth selling yet. Wait for IVR > 35.`;
  } else if (!checks.rsi_neutral.pass) {
    signal = "WAIT";
    avoidReason = `RSI ${m.rsi4h.toFixed(1)} is outside neutral zone — directional momentum too strong, spread could be breached.`;
  } else if (!checks.funding_neutral.pass) {
    signal = "AVOID";
    avoidReason = `Funding rate ${m.funding.toFixed(4)}% is extreme — large directional perpetual bias, avoid until funding normalises.`;
  } else if (checks.atr_expanding && !checks.atr_stable.pass) {
    signal = "WAIT";
    avoidReason = `ATR is expanding — volatility of volatility increasing, gamma risk elevated. Wait for stabilisation.`;
  }

  // ── Risks ──────────────────────────────────────────────────────────────
  const risks = [];
  if (m.iv > 80)  risks.push(`High IV (${m.iv.toFixed(0)}%) means larger potential moves — strikes may be tested`);
  if (m.funding > 0.08) risks.push(`Elevated positive funding (${m.funding.toFixed(4)}%) — longs may unwind causing sharp drop`);
  if (m.funding < -0.03) risks.push(`Negative funding (${m.funding.toFixed(4)}%) — shorts being paid, potential short squeeze`);
  if (m.atrExpanding) risks.push("ATR is expanding — realized volatility rising, respect stops strictly");
  if (m.distToResistancePct < 3) risks.push(`BTC only ${m.distToResistancePct.toFixed(1)}% below resistance — breakout could breach call spread`);
  if (m.distToSupportPct < 3) risks.push(`BTC only ${m.distToSupportPct.toFixed(1)}% above support — breakdown could breach put spread`);
  risks.push("Always close 1 DTE before expiry — gamma risk spikes in final hours");
  risks.push("Flash crashes on crypto can gap through strikes — keep 50% capital free for margin");

  return {
    signal, avoidReason, strategy, stratRationale,
    dte, dteRationale,
    shortCall, longCall, shortPut, longPut,
    spreadWidth, minPremium, maxPremium, profitTarget, stopLoss,
    approxDelta, checks, passed, total,
    entryTiming, risks, sdKey,
  };
}

// ─── TELEGRAM MESSAGE BUILDER ──────────────────────────────────────────────
function buildMessage(m, a) {
  const ts = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const emoji = { ENTER_TRADE: "🟢", WAIT: "🟡", AVOID: "🔴" };
  const e     = emoji[a.signal] || "🟡";

  const checkRows = Object.values(a.checks)
    .map((c) => `${c.pass ? "✅" : "❌"} ${c.label}: *${c.value}*`)
    .join("\n");

  if (a.signal === "WAIT" || a.signal === "AVOID") {
    return `${e} *BTC OPTIONS SIGNAL: ${a.signal}*
🕐 ${ts} IST

*Conditions (${a.passed}/${a.total} passed)*
${checkRows}

📊 BTC: *$${Math.round(m.price).toLocaleString()}*
📈 Trend: *${m.trend}* | IVR: *${m.ivr.toFixed(0)}%* | DVOL: *${m.iv.toFixed(1)}%*

⚠️ *Why not trading now:*
_${a.avoidReason || "Waiting for all conditions to align"}._

🔄 _Auto-checking every 5 min. Will alert when ENTER conditions met._`;
  }

  // ── ENTER_TRADE full message ────────────────────────────────────────────
  const strikeSection = a.strategy === "Iron Condor"
    ? `*CALL SPREAD (sell above)*
🔴 Sell Call: *$${a.shortCall?.toLocaleString()}* (Δ ≈ ${a.approxDelta})
🔵 Buy Call:  *$${a.longCall?.toLocaleString()}* (protection)

*PUT SPREAD (sell below)*
🔴 Sell Put: *$${a.shortPut?.toLocaleString()}* (Δ ≈ ${a.approxDelta})
🔵 Buy Put:  *$${a.longPut?.toLocaleString()}* (protection)`
    : a.strategy === "Bull Put Spread"
    ? `*PUT SPREAD ONLY (bullish)*
🔴 Sell Put: *$${a.shortPut?.toLocaleString()}* (Δ ≈ ${a.approxDelta})
🔵 Buy Put:  *$${a.longPut?.toLocaleString()}* (protection)
📌 No call side — trend is bullish`
    : `*CALL SPREAD ONLY (bearish)*
🔴 Sell Call: *$${a.shortCall?.toLocaleString()}* (Δ ≈ ${a.approxDelta})
🔵 Buy Call:  *$${a.longCall?.toLocaleString()}* (protection)
📌 No put side — trend is bearish`;

  return `${e} *⚡ ENTER TRADE — ${a.strategy} ⚡*
🕐 ${ts} IST
✅ Conditions Met: *${a.passed}/${a.total}*

━━━━━━━━━━━━━━━━━━
*📊 MARKET SNAPSHOT*
💰 BTC Price: *$${Math.round(m.price).toLocaleString()}*
📈 Trend: *${m.trend}* (SMA8: $${Math.round(m.sma8).toLocaleString()})
🌊 DVOL: *${m.iv.toFixed(1)}%* | IVR: *${m.ivr.toFixed(0)}%*
📊 RSI 4H: *${m.rsi4h.toFixed(1)}* | Funding: *${m.funding.toFixed(4)}%*

━━━━━━━━━━━━━━━━━━
*✅ ENTRY CHECKLIST*
${checkRows}

━━━━━━━━━━━━━━━━━━
*🎯 TRADE SETUP*
Strategy: *${a.strategy}*
_${a.stratRationale}_

📅 Expiry: *${a.dte} DTE*
_${a.dteRationale}_

${strikeSection}

━━━━━━━━━━━━━━━━━━
*📐 SD REFERENCE (${a.sdKey.dte} DTE)*
2SD Range: *$${a.sdKey.dn2.toLocaleString()}* ↔ *$${a.sdKey.up2.toLocaleString()}*
1SD Range: *$${a.sdKey.dn1.toLocaleString()}* ↔ *$${a.sdKey.up1.toLocaleString()}*
Spread Width: *$${a.spreadWidth.toLocaleString()}* per side

━━━━━━━━━━━━━━━━━━
*💰 PREMIUM & EXITS*
🎯 Collect target: *$${a.minPremium}–$${a.maxPremium}* per spread (≥20% of width)
✅ Profit EXIT: Close at *$${a.profitTarget}* profit (50% of premium)
🛑 Stop LOSS: Close if loss hits *$${a.stopLoss}* (2× premium)
⏰ Time EXIT: *Close 1 DTE before expiry — no exceptions*

━━━━━━━━━━━━━━━━━━
*📋 EXECUTION (Delta Exchange India)*
1. Go to Options chain on Delta Exchange
2. Confirm OI > 100 on your short strikes
3. Check bid-ask spread ≤ 1.5% of premium
4. Sell short strike first (limit order only)
5. Immediately buy the long strike for protection
6. Set GTC limit order for profit exit now
7. Set price alert for stop loss level

⏰ *${a.entryTiming}*

━━━━━━━━━━━━━━━━━━
*⚠️ KEY RISKS*
${a.risks.slice(0, 4).map((r) => `• ${r}`).join("\n")}

━━━━━━━━━━━━━━━━━━
*🏦 DELTA EXCHANGE NOTES*
• Options are USDT-margined, European-style
• Leg in manually: sell first, buy hedge immediately after
• Use *Mark Price* not Last Price for PnL tracking
• Keep 50%+ capital free as margin buffer
• Never use market orders — limit orders only

_⚡ Free bot · No AI API · Pure rule-based strategy_
_⚠️ NOT financial advice. Always verify before trading._`;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] BTC Options Bot running...`);

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_TOKEN or CHAT_ID env vars");
    process.exit(1);
  }

  const m = await fetchMarketData();
  const a = analyzeSignal(m);

  console.log(`Signal: ${a.signal} | BTC: $${Math.round(m.price)} | RSI: ${m.rsi4h?.toFixed(1)} | IVR: ${m.ivr?.toFixed(0)}% | Funding: ${m.funding.toFixed(4)}%`);
  console.log(`Conditions: ${a.passed}/${a.total} | Strategy: ${a.strategy} | DTE: ${a.dte}`);

  // Always send on ENTER_TRADE
  // On WAIT/AVOID: only send if this run was triggered manually (workflow_dispatch)
  // or every ~1 hour (every 12th run at 5-min intervals)
  const runNumber = parseInt(process.env.GITHUB_RUN_NUMBER || "1");
  const isManual  = process.env.TRIGGER === "manual";
  const isHourly  = runNumber % 12 === 0;

  if (a.signal === "ENTER_TRADE" || isManual || isHourly) {
    const msg = buildMessage(m, a);
    await sendTelegram(msg);
    console.log("✅ Telegram message sent");
  } else {
    console.log("⏭  WAIT signal — skipping Telegram (next hourly update or manual trigger)");
  }
}

main().catch(async (err) => {
  console.error("Fatal error:", err.message);
  try {
    await sendTelegram(`⚠️ *Bot Error*\n\`${err.message}\`\n_Check GitHub Actions logs_`);
  } catch (_) {}
  process.exit(1);
});
