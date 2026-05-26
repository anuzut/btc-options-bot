const https = require("https");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID        = process.env.CHAT_ID;

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0 btc-options-bot/2.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Parse error: " + url.slice(0, 80))); }
      });
    }).on("error", reject);
  });
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown", disable_web_page_preview: true });
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function calcRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return 50;
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

function calcATR(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function roundStrike(price, step = 500) {
  return Math.round(price / step) * step;
}

async function fetchMarketData() {
  // Bybit V5 API — works reliably from GitHub Actions
  const [tickerRes, klines4hRes, klines1hRes, fundingRes, dvolRes] = await Promise.all([
    fetchJSON("https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT"),
    fetchJSON("https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=240&limit=32"),
    fetchJSON("https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=50"),
    fetchJSON("https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT"),
    fetchJSON(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${Date.now() - 30 * 864e5}&end_timestamp=${Date.now()}&resolution=86400`),
  ]);

  // Bybit kline format: [startTime, open, high, low, close, volume, turnover] — newest first, so reverse
  const raw4h = (klines4hRes?.result?.list || []).reverse();
  const raw1h = (klines1hRes?.result?.list || []).reverse();

  if (raw4h.length === 0) throw new Error("Bybit 4H klines unavailable — API may be down, retrying next cycle");

  const closes4h = raw4h.map(k => parseFloat(k[4]));
  const highs4h  = raw4h.map(k => parseFloat(k[2]));
  const lows4h   = raw4h.map(k => parseFloat(k[3]));
  const closes1h = raw1h.map(k => parseFloat(k[4]));

  const tickerData = tickerRes?.result?.list?.[0] || {};
  const price    = parseFloat(tickerData.lastPrice || tickerData.markPrice || closes4h[closes4h.length - 1]);
  const funding  = parseFloat(tickerData.fundingRate || 0) * 100;

  const rsi4h  = calcRSI(closes4h);
  const rsi1h  = calcRSI(closes1h);
  const atr4h  = calcATR(highs4h, lows4h, closes4h) || (price * 0.02);
  const atrPct = (atr4h / price) * 100;

  // ATR expansion check
  const atrRecent = calcATR(highs4h.slice(-9), lows4h.slice(-9), closes4h.slice(-9), 7);
  const atrOlder  = calcATR(highs4h.slice(-17,-8), lows4h.slice(-17,-8), closes4h.slice(-17,-8), 7);
  const atrExpanding = (atrRecent && atrOlder) ? atrRecent > atrOlder * 1.15 : false;

  // Trend
  const last8  = closes4h.slice(-8);
  const last20 = closes4h.slice(-20);
  const sma8   = last8.reduce((a,b) => a+b,0) / last8.length;
  const sma20  = last20.reduce((a,b) => a+b,0) / last20.length;
  const trend  = price > sma8 && sma8 > sma20 ? "BULLISH"
               : price < sma8 && sma8 < sma20 ? "BEARISH" : "NEUTRAL";

  // DVOL / IV from Deribit
  let iv = 65, ivLow = 40, ivHigh = 100, ivr = 50;
  const dvol = dvolRes?.result?.data || [];
  if (dvol.length > 0) {
    const vals = dvol.map(d => d[4]).filter(Boolean);
    if (vals.length > 0) {
      iv = vals[vals.length - 1];
      ivLow  = Math.min(...vals);
      ivHigh = Math.max(...vals);
      ivr    = ivHigh === ivLow ? 50 : ((iv - ivLow) / (ivHigh - ivLow)) * 100;
    }
  }

  const sdLevels = [7, 14, 21].map(dte => {
    const sd1 = price * (iv / 100) * Math.sqrt(dte / 365);
    const sd2 = sd1 * 2;
    return { dte, sd1: Math.round(sd1), sd2: Math.round(sd2),
      up1: roundStrike(price + sd1), dn1: roundStrike(price - sd1),
      up2: roundStrike(price + sd2), dn2: roundStrike(price - sd2) };
  });

  const high20 = Math.max(...closes4h.slice(-20));
  const low20  = Math.min(...closes4h.slice(-20));

  return { price, rsi4h, rsi1h, atr4h, atrPct, atrExpanding,
    funding, iv, ivLow, ivHigh, ivr, trend, sma8, sma20,
    sdLevels, high20, low20,
    distToResistancePct: ((high20 - price) / price) * 100,
    distToSupportPct:    ((price - low20)  / price) * 100 };
}

function analyzeSignal(m) {
  const checks = {
    ivr_elevated:    { pass: m.ivr > 35,                               label: "IVR > 35",             value: `${m.ivr.toFixed(0)}%`      },
    rsi_neutral:     { pass: m.rsi4h >= 38 && m.rsi4h <= 62,          label: "RSI 4H in 38–62",      value: m.rsi4h.toFixed(1)          },
    funding_neutral: { pass: m.funding >= -0.05 && m.funding <= 0.10, label: "Funding neutral",       value: `${m.funding.toFixed(4)}%`  },
    atr_stable:      { pass: !m.atrExpanding,                          label: "ATR not expanding",    value: m.atrExpanding ? "EXPANDING":"STABLE" },
    iv_reasonable:   { pass: m.iv >= 40 && m.iv <= 120,               label: "IV in range 40–120%",  value: `${m.iv.toFixed(1)}%`       },
  };
  const passed = Object.values(checks).filter(c => c.pass).length;
  const total  = Object.keys(checks).length;

  let dte = 7, dteRationale = "";
  if (m.iv > 80)      { dte = 7;  dteRationale = `IV elevated ${m.iv.toFixed(0)}% — 7 DTE maximises theta burn`; }
  else if (m.iv >= 55){ dte = 10; dteRationale = `IV moderate ${m.iv.toFixed(0)}% — 10 DTE balances decay vs gamma`; }
  else                { dte = 14; dteRationale = `IV lower ${m.iv.toFixed(0)}% — 14 DTE needed for sufficient premium`; }

  const sdKey = m.sdLevels.reduce((p, c) => Math.abs(c.dte-dte) < Math.abs(p.dte-dte) ? c : p);
  const spreadWidth = roundStrike(m.price * 0.04, 500);

  let strategy, stratRationale, shortCall, longCall, shortPut, longPut;
  if (m.trend === "BULLISH" && m.rsi4h < 55) {
    strategy = "Bull Put Spread"; stratRationale = "BTC bullish — selling puts below 2SD only";
    shortPut = sdKey.dn2; longPut = roundStrike(sdKey.dn2 - spreadWidth); shortCall = null; longCall = null;
  } else if (m.trend === "BEARISH" && m.rsi4h > 45) {
    strategy = "Bear Call Spread"; stratRationale = "BTC bearish — selling calls above 2SD only";
    shortCall = sdKey.up2; longCall = roundStrike(sdKey.up2 + spreadWidth); shortPut = null; longPut = null;
  } else {
    strategy = "Iron Condor"; stratRationale = "BTC neutral — Iron Condor on both sides within 2SD";
    shortCall = sdKey.up2; longCall = roundStrike(sdKey.up2 + spreadWidth);
    shortPut  = sdKey.dn2; longPut  = roundStrike(sdKey.dn2 - spreadWidth);
  }

  const approxDelta = Math.max(0.10, Math.min(0.20, 0.15 * Math.sqrt(7/dte) * (65/m.iv))).toFixed(2);
  const minPremium   = Math.round(spreadWidth * 0.20);
  const maxPremium   = Math.round(spreadWidth * 0.28);
  const profitTarget = Math.round((minPremium + maxPremium) / 2 * 0.50);
  const stopLoss     = Math.round((minPremium + maxPremium) / 2 * 2.0);

  const istHour = new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"})).getHours();
  const entryTiming =
    (istHour>=19&&istHour<=23) ? "✅ US market hours (7–11 PM IST) — best liquidity" :
    (istHour>=13&&istHour<=16) ? "✅ US pre-market (1–4 PM IST) — good fills" :
    (istHour>=8 &&istHour<=11) ? "⚠️ Asia session — verify OI before entering" :
    "⚠️ Off-peak hours — check bid-ask spread carefully";

  let signal = "WAIT", avoidReason = "";
  if (passed >= 4) { signal = "ENTER_TRADE"; }
  else if (!checks.funding_neutral.pass) { signal = "AVOID"; avoidReason = `Funding ${m.funding.toFixed(4)}% extreme — strong directional bias, wait for neutral.`; }
  else if (!checks.ivr_elevated.pass)    { signal = "WAIT";  avoidReason = `IVR ${m.ivr.toFixed(0)}% too low — premium thin, not worth selling yet. Need IVR > 35.`; }
  else if (!checks.rsi_neutral.pass)     { signal = "WAIT";  avoidReason = `RSI ${m.rsi4h.toFixed(1)} outside 38–62 — momentum too strong, spread may be breached.`; }
  else                                   { signal = "WAIT";  avoidReason = `${passed}/${total} conditions met — waiting for full alignment.`; }

  const risks = [
    m.iv > 80 ? `High IV ${m.iv.toFixed(0)}% — larger moves expected, strikes may be tested` : `IV ${m.iv.toFixed(0)}% moderate — reasonable spread safety`,
    m.funding > 0.08 ? `High funding ${m.funding.toFixed(4)}% — longs may unwind, watch for drop` : `Funding ${m.funding.toFixed(4)}% controlled`,
    m.atrExpanding ? "ATR expanding — volatility rising, honour stops strictly" : "ATR stable — good for premium selling",
    "Close 1 DTE before expiry — gamma spikes in final hours",
    "Keep 50%+ capital free — Delta Exchange margin calls on flash crashes",
  ];

  return { signal, avoidReason, strategy, stratRationale, dte, dteRationale,
    shortCall, longCall, shortPut, longPut, spreadWidth, minPremium, maxPremium,
    profitTarget, stopLoss, approxDelta, checks, passed, total, entryTiming, risks, sdKey };
}

function buildMessage(m, a) {
  const ts = new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata",dateStyle:"medium",timeStyle:"short"});
  const e  = {ENTER_TRADE:"🟢",WAIT:"🟡",AVOID:"🔴"}[a.signal]||"🟡";
  const checkRows = Object.values(a.checks).map(c=>`${c.pass?"✅":"❌"} ${c.label}: *${c.value}*`).join("\n");

  if (a.signal !== "ENTER_TRADE") {
    return `${e} *BTC OPTIONS: ${a.signal}*\n🕐 ${ts} IST\n\n*Conditions: ${a.passed}/${a.total} passed*\n${checkRows}\n\n💰 BTC: *$${Math.round(m.price).toLocaleString()}* | Trend: *${m.trend}*\n🌊 DVOL: *${m.iv.toFixed(1)}%* | IVR: *${m.ivr.toFixed(0)}%*\n\n⚠️ *Reason:* _${a.avoidReason}_\n\n_Checking every 5 min. Alert when ENTER conditions met._`;
  }

  const strikes = a.strategy === "Iron Condor"
    ? `🔴 Sell Call: *$${a.shortCall?.toLocaleString()}* (Δ≈${a.approxDelta})\n🔵 Buy Call:  *$${a.longCall?.toLocaleString()}*\n🔴 Sell Put:  *$${a.shortPut?.toLocaleString()}* (Δ≈${a.approxDelta})\n🔵 Buy Put:   *$${a.longPut?.toLocaleString()}*`
    : a.strategy === "Bull Put Spread"
    ? `🔴 Sell Put: *$${a.shortPut?.toLocaleString()}* (Δ≈${a.approxDelta})\n🔵 Buy Put:  *$${a.longPut?.toLocaleString()}*\n📌 No call side — trend bullish`
    : `🔴 Sell Call: *$${a.shortCall?.toLocaleString()}* (Δ≈${a.approxDelta})\n🔵 Buy Call:  *$${a.longCall?.toLocaleString()}*\n📌 No put side — trend bearish`;

  return `${e} *⚡ ENTER TRADE — ${a.strategy} ⚡*\n🕐 ${ts} IST | *${a.passed}/${a.total} conditions met*\n\n━━━━━━━━━━━━━━━━━\n*📊 MARKET*\n💰 BTC: *$${Math.round(m.price).toLocaleString()}* | Trend: *${m.trend}*\n📊 RSI 4H: *${m.rsi4h.toFixed(1)}* | Funding: *${m.funding.toFixed(4)}%*\n🌊 DVOL: *${m.iv.toFixed(1)}%* | IVR: *${m.ivr.toFixed(0)}%*\n\n━━━━━━━━━━━━━━━━━\n*✅ CHECKLIST*\n${checkRows}\n\n━━━━━━━━━━━━━━━━━\n*🎯 ${a.strategy}*\n_${a.stratRationale}_\n📅 *${a.dte} DTE* — ${a.dteRationale}\n\n${strikes}\n\n━━━━━━━━━━━━━━━━━\n*💰 EXITS*\nCollect: *$${a.minPremium}–$${a.maxPremium}* (≥20% of $${a.spreadWidth.toLocaleString()} width)\n✅ Profit exit: *$${a.profitTarget}* (50% of premium)\n🛑 Stop loss: *$${a.stopLoss}* (2× premium)\n⏰ *Close 1 DTE always — no exceptions*\n\n━━━━━━━━━━━━━━━━━\n*📐 2SD RANGE (${a.sdKey.dte} DTE)*\nPut side: *$${a.sdKey.dn2.toLocaleString()}* | Call side: *$${a.sdKey.up2.toLocaleString()}*\n\n${a.entryTiming}\n\n*⚠️ RISKS*\n${a.risks.slice(0,3).map(r=>`• ${r}`).join("\n")}\n\n*🏦 DELTA EXCHANGE*\n• European USDT options — no early assignment risk\n• Limit orders only — sell first, hedge immediately\n• Use Mark Price not Last Price\n\n_⚠️ Not financial advice. Verify before trading._`;
}

async function main() {
  console.log(`[${new Date().toISOString()}] BTC Options Bot v2 (Bybit) running...`);
  if (!TELEGRAM_TOKEN || !CHAT_ID) { console.error("Missing env vars"); process.exit(1); }

  const m = await fetchMarketData();
  const a = analyzeSignal(m);
  console.log(`Signal: ${a.signal} | BTC: $${Math.round(m.price)} | RSI: ${m.rsi4h.toFixed(1)} | IVR: ${m.ivr.toFixed(0)}% | Funding: ${m.funding.toFixed(4)}% | Trend: ${m.trend}`);

  const runNumber = parseInt(process.env.GITHUB_RUN_NUMBER || "1");
  const isManual  = process.env.TRIGGER === "manual";
  const isHourly  = runNumber % 12 === 0;

  if (a.signal === "ENTER_TRADE" || isManual || isHourly) {
    await sendTelegram(buildMessage(m, a));
    console.log("✅ Telegram sent");
  } else {
    console.log("⏭  No alert — WAIT signal (next: manual or hourly)");
  }
}

main().catch(async (err) => {
  console.error("Fatal:", err.message);
  try { await sendTelegram(`⚠️ *Bot Error*\n\`${err.message}\`\n_Check GitHub Actions logs_`); } catch(_) {}
  process.exit(1);
});
