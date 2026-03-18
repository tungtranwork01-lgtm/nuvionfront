const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '.macd-monitor.json');
const DEFAULT_POLL_MS = 60_000;
const HISTORY_CANDLES = 5000;
const BINANCE_MAINNET = 'https://api.binance.com';
const BINANCE_TESTNET = 'https://testnet.binance.vision';

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { /* ignore */ }
  return { subscribers: {}, autoOrder: false, orderSymbol: 'BTCUSDT', orderQuantity: 0.001 };
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }
  catch (e) { console.error('[Monitor] saveConfig:', e.message); }
}

module.exports = function startMacdMonitor(supabase, bot) {
  const aiKey = process.env.AI_API_KEY;
  const aiBase = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const pollMs = parseInt(process.env.MONITOR_POLL_MS) || DEFAULT_POLL_MS;

  let config = loadConfig();
  let lastCrossoverTs = null;
  let lastSignal = null;
  let timer = null;
  let running = false;

  /* ────────────── Supabase ────────────── */

  async function fetchLatest(limit = 20) {
    const { data, error } = await supabase
      .from('BTCJPY').select('*')
      .order('open_time', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data || []).reverse();
  }

  async function fetchHistory(limit = HISTORY_CANDLES) {
    const PAGE = 1000;
    let all = [], page = 0;
    while (all.length < limit) {
      const from = page * PAGE;
      const to = Math.min(from + PAGE - 1, limit - 1);
      const { data, error } = await supabase
        .from('BTCJPY').select('*')
        .order('open_time', { ascending: false }).range(from, to);
      if (error) throw error;
      if (!data || !data.length) break;
      all = all.concat(data);
      page++;
      if (data.length < PAGE) break;
    }
    return all.reverse();
  }

  /* ────────────── MACD helpers (mirrors frontend) ────────────── */

  function toSec(t) { return new Date(t).getTime() / 1000; }

  function fillHigherTF(data) {
    if (!data?.length) return data;
    const PERIOD = { '1h': 3600, '4h': 14400, '1d': 86400 };
    const out = data.map(r => ({ ...r }));
    for (const tf of ['1h', '4h', '1d']) {
      const ps = PERIOD[tf], key = `hist_${tf}`;
      let i = 0;
      while (i < out.length) {
        const t0 = Math.floor(toSec(out[i].open_time) / ps) * ps;
        let j = i;
        while (j < out.length && Math.floor(toSec(out[j].open_time) / ps) * ps === t0) j++;
        const val = Number(out[j - 1][key]) || 0;
        for (let k = i; k < j; k++) out[k][key] = val;
        i = j;
      }
    }
    return out;
  }

  function regionIndices(data) {
    const regions = [];
    let cur = null;
    for (let i = 0; i < data.length; i++) {
      if ((Number(data[i].hist_5m) || 0) > 0) {
        if (!cur) cur = [];
        cur.push(i);
      } else if (cur) { regions.push(cur); cur = null; }
    }
    if (cur) regions.push(cur);
    return regions;
  }

  function buildMeta(data, indices) {
    return indices.map(idx => {
      const open = Number(data[idx[0]].open) || 1;
      let hi = -Infinity, lo = Infinity;
      for (const i of idx) {
        const h = Number(data[i].high) || 0;
        const l = Number(data[i].low) || 0;
        if (h > hi) hi = h;
        if (l < lo) lo = l;
      }
      return {
        count: idx.length,
        highOpen: 100 * (hi - open) / open,
        openLow: 100 * (open - lo) / open,
      };
    });
  }

  function pct(arr, p) {
    if (!arr.length) return NaN;
    const s = [...arr].sort((a, b) => a - b);
    const i = (s.length - 1) * p;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] * (1 - (i - lo)) + s[hi] * (i - lo);
  }

  const avg = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;

  function calcStats(data, macdNow) {
    const filled = fillHigherTF(data);
    let regions = regionIndices(data);

    if (macdNow.hist_1h > 0)
      regions = regions.filter(idx => idx.every(i => Number(filled[i].hist_1h) > 0));
    if (macdNow.hist_4h > 0)
      regions = regions.filter(idx => idx.every(i => Number(filled[i].hist_4h) > 0));
    if (macdNow.hist_1d > 0)
      regions = regions.filter(idx => idx.every(i => Number(filled[i].hist_1d) > 0));

    const meta = buildMeta(data, regions);
    if (!meta.length) return null;

    const ho = meta.map(m => m.highOpen);
    const ol = meta.map(m => m.openLow);
    const mHO = avg(ho), mOL = avg(ol);
    return {
      count: meta.length,
      meanHO: mHO, meanOL: mOL,
      medianHO: pct(ho, 0.5), medianOL: pct(ol, 0.5),
      p25HO: pct(ho, 0.25), p75HO: pct(ho, 0.75),
      p25OL: pct(ol, 0.25), p75OL: pct(ol, 0.75),
      rr: mOL > 0 ? mHO / mOL : null,
      filter: filterLabel(macdNow),
    };
  }

  function filterLabel(s) {
    const p = [];
    if (s.hist_1h > 0) p.push('1h dương');
    if (s.hist_4h > 0) p.push('4h dương');
    if (s.hist_1d > 0) p.push('1d dương');
    return p.length ? p.join(' + ') : 'Không lọc';
  }

  /* ────────────── AI ────────────── */

  async function askAI(prompt) {
    if (!aiKey) return '(AI_API_KEY chưa cấu hình)';
    const model = process.env.MONITOR_AI_MODEL || 'gpt-4.1-mini';
    const res = await fetch(`${aiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'Bạn là chuyên gia phân tích giao dịch BTCJPY dựa trên MACD histogram. '
              + 'Trả lời ngắn gọn (tối đa 150 từ), cụ thể, bằng tiếng Việt. '
              + 'Tập trung vào: mức độ tin cậy của tín hiệu, khuyến nghị LONG/HOLD/SKIP, mức TP/SL hợp lý, và rủi ro chính.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.4,
        max_tokens: 600,
      }),
    });
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const d = await res.json();
    return d.choices[0].message.content;
  }

  /* ────────────── Binance ────────────── */

  function sign(secret, qs) {
    return crypto.createHmac('sha256', secret).update(qs).digest('hex');
  }

  async function binanceOrder(acctConfig, params) {
    const apiKey = acctConfig.apiKey || acctConfig.api_key;
    const secret = acctConfig.secretKey || acctConfig.secret_key;
    const base = acctConfig.testnet ? BINANCE_TESTNET : BINANCE_MAINNET;
    const qs = new URLSearchParams({ ...params, timestamp: String(Date.now()) });
    qs.set('signature', sign(secret, qs.toString()));
    const res = await fetch(`${base}/api/v3/order?${qs}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': apiKey },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Binance ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  /* ────────────── Notification builder ────────────── */

  const fp = p => Number(p).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const fpct = p => Number(p).toFixed(3) + '%';
  const icon = v => (v > 0 ? '🟢' : v < 0 ? '🔴' : '⚪');

  function buildMsg(candle, macd, stats, tp, sl) {
    const t = new Date(candle.open_time).toLocaleString('vi-VN', { timeZone: 'Asia/Tokyo' });
    let m = '🟢 *MACD Hist 5m → DƯƠNG*\n';
    m += '━━━━━━━━━━━━━━━━━━━━━\n';
    m += `⏰ ${t} (JST)\n`;
    m += `💰 Open: ¥${fp(candle.open)}\n\n`;

    m += '📊 *Trạng thái MACD:*\n';
    m += `├ 1h: ${icon(macd.hist_1h)} ${Number(macd.hist_1h).toFixed(1)}\n`;
    m += `├ 4h: ${icon(macd.hist_4h)} ${Number(macd.hist_4h).toFixed(1)}\n`;
    m += `└ 1d: ${icon(macd.hist_1d)} ${Number(macd.hist_1d).toFixed(1)}\n\n`;

    if (stats) {
      m += `📈 *Thống kê lịch sử [${stats.filter}]:*\n`;
      m += `├ Miền tương tự: ${stats.count}\n`;
      m += `├ Kỳ vọng (High−Open)/Open: ${fpct(stats.meanHO)}\n`;
      m += `├ Median HO%: ${fpct(stats.medianHO)}\n`;
      m += `├ P25–P75 HO%: ${fpct(stats.p25HO)} – ${fpct(stats.p75HO)}\n`;
      m += `├ Kỳ vọng (Open−Low)/Open: ${fpct(stats.meanOL)}\n`;
      m += `└ RR: ${stats.rr != null ? stats.rr.toFixed(2) : '--'}\n\n`;
      if (tp != null) m += `🎯 *TP:* ¥${fp(tp)} (+${fpct(stats.meanHO)})\n`;
      if (sl != null) m += `🛡 *SL:* ¥${fp(sl)} (−${fpct(stats.p75OL)})\n`;
    } else {
      m += '📈 _Không đủ dữ liệu thống kê cho bộ lọc hiện tại._\n';
    }
    return m;
  }

  /* ────────────── Core polling ────────────── */

  async function poll() {
    try {
      const candles = await fetchLatest(20);
      if (candles.length < 2) return;

      let crossIdx = -1;
      for (let i = candles.length - 1; i >= 1; i--) {
        const prev = Number(candles[i - 1].hist_5m) || 0;
        const curr = Number(candles[i].hist_5m) || 0;
        if (prev <= 0 && curr > 0) { crossIdx = i; break; }
      }
      if (crossIdx < 0) return;

      const candle = candles[crossIdx];
      const t = new Date(candle.open_time).getTime();
      if (lastCrossoverTs && t <= lastCrossoverTs) return;
      lastCrossoverTs = t;

      const openPrice = Number(candle.open);
      const macd = {
        hist_1h: Number(candle.hist_1h) || 0,
        hist_4h: Number(candle.hist_4h) || 0,
        hist_1d: Number(candle.hist_1d) || 0,
      };

      console.log(`[Monitor] 🟢 Crossover @ ${candle.open_time}, open=¥${fp(openPrice)}`);

      const history = await fetchHistory();
      const stats = calcStats(history, macd);

      const tp = stats ? openPrice * (1 + stats.meanHO / 100) : null;
      const sl = stats ? openPrice * (1 - stats.p75OL / 100) : null;

      let msg = buildMsg(candle, macd, stats, tp, sl);

      let aiText = '';
      try {
        aiText = await askAI(buildAIPrompt(candle, macd, stats, tp, sl));
      } catch (e) {
        aiText = `_(Lỗi AI: ${e.message})_`;
        console.error('[Monitor] AI error:', e.message);
      }
      msg += `\n🤖 *AI Phân tích:*\n${aiText}`;

      lastSignal = {
        time: candle.open_time,
        openPrice,
        macd,
        stats: stats ? {
          count: stats.count, meanHO: stats.meanHO, meanOL: stats.meanOL,
          medianHO: stats.medianHO, rr: stats.rr, filter: stats.filter,
        } : null,
        tp, sl, aiText,
        detectedAt: new Date().toISOString(),
      };

      const subs = activeSubs();
      for (const chatId of subs) {
        try {
          await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
            .catch(() => bot.sendMessage(chatId, msg));
        } catch (e) {
          console.error(`[Monitor] send ${chatId}:`, e.message);
        }
      }

      if (config.autoOrder && subs.length > 0) {
        await autoOrder(stats, tp, subs);
      }

      console.log(`[Monitor] Notified ${subs.length} subscriber(s)`);
    } catch (e) {
      console.error('[Monitor] poll error:', e.message);
    }
  }

  function buildAIPrompt(candle, macd, stats, tp, sl) {
    const lines = [
      'Tín hiệu MACD 5m histogram vừa chuyển từ ÂM sang DƯƠNG (crossover).',
      `Giá Open nến 5m: ¥${fp(candle.open)}`,
      `MACD 1h: ${macd.hist_1h > 0 ? 'DƯƠNG' : 'ÂM'} (${Number(macd.hist_1h).toFixed(1)})`,
      `MACD 4h: ${macd.hist_4h > 0 ? 'DƯƠNG' : 'ÂM'} (${Number(macd.hist_4h).toFixed(1)})`,
      `MACD 1d: ${macd.hist_1d > 0 ? 'DƯƠNG' : 'ÂM'} (${Number(macd.hist_1d).toFixed(1)})`,
    ];
    if (stats) {
      lines.push(
        `Bộ lọc áp dụng: ${stats.filter}`,
        `Số miền dương tương tự trong lịch sử: ${stats.count}`,
        `Kỳ vọng (High−Open)/Open%: ${fpct(stats.meanHO)}`,
        `Median HO%: ${fpct(stats.medianHO)}, P25=${fpct(stats.p25HO)}, P75=${fpct(stats.p75HO)}`,
        `Kỳ vọng (Open−Low)/Open%: ${fpct(stats.meanOL)}`,
        `RR: ${stats.rr != null ? stats.rr.toFixed(2) : '--'}`,
      );
    }
    if (tp != null) lines.push(`TP gợi ý: ¥${fp(tp)}`);
    if (sl != null) lines.push(`SL gợi ý: ¥${fp(sl)}`);
    lines.push('', 'Phân tích tín hiệu này: mức độ tin cậy, nên LONG hay SKIP, mức TP/SL tối ưu, rủi ro chính?');
    return lines.join('\n');
  }

  /* ────────────── Auto-order ────────────── */

  async function autoOrder(stats, tp, chatIds) {
    try {
      const { data: acct, error } = await supabase
        .from('api_account').select('id, config, "Name"')
        .order('id', { ascending: true }).limit(1).single();
      if (error || !acct) throw new Error('Không tìm thấy tài khoản');

      const ac = acct.config || {};
      const symbol = config.orderSymbol || 'BTCUSDT';
      const qty = config.orderQuantity || 0.001;

      const buyRes = await binanceOrder(ac, {
        symbol, side: 'BUY', type: 'MARKET', quantity: String(qty),
      });

      let orderMsg = '\n\n✅ *Đặt lệnh tự động:*\n';
      orderMsg += `├ ${symbol} MARKET BUY ${qty}\n`;
      orderMsg += `├ Status: ${buyRes.status}\n`;
      orderMsg += `└ OrderId: ${buyRes.orderId}\n`;

      if (tp && stats) {
        try {
          const tpPrice = Math.round(tp * 100) / 100;
          const sellRes = await binanceOrder(ac, {
            symbol, side: 'SELL', type: 'LIMIT', timeInForce: 'GTC',
            quantity: String(qty), price: String(tpPrice),
          });
          orderMsg += `\n🎯 *TP Order:*\n`;
          orderMsg += `├ LIMIT SELL @ ¥${fp(tpPrice)}\n`;
          orderMsg += `└ OrderId: ${sellRes.orderId}\n`;
        } catch (e) {
          orderMsg += `\n⚠️ _TP order lỗi: ${e.message.slice(0, 200)}_\n`;
        }
      }

      for (const cid of chatIds) {
        try { await bot.sendMessage(cid, orderMsg, { parse_mode: 'Markdown' }); } catch { /* skip */ }
      }
    } catch (e) {
      console.error('[Monitor] autoOrder error:', e.message);
      const errMsg = `⚠️ *Lỗi đặt lệnh tự động:* ${e.message.slice(0, 300)}`;
      for (const cid of chatIds) {
        try { await bot.sendMessage(cid, errMsg, { parse_mode: 'Markdown' }); } catch { /* skip */ }
      }
    }
  }

  /* ────────────── Lifecycle ────────────── */

  function activeSubs() {
    return Object.keys(config.subscribers).filter(id => config.subscribers[id]);
  }

  function start() {
    if (running) return;
    running = true;
    timer = setInterval(poll, pollMs);
    poll();
    console.log(`[Monitor] Started (poll=${pollMs / 1000}s)`);
  }

  function stop() {
    if (!running) return;
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    console.log('[Monitor] Stopped');
  }

  if (activeSubs().length > 0) start();

  /* ────────────── Public API ────────────── */

  return {
    subscribe(chatId) {
      config.subscribers[String(chatId)] = true;
      saveConfig(config);
      if (!running) start();
    },

    unsubscribe(chatId) {
      delete config.subscribers[String(chatId)];
      saveConfig(config);
      if (activeSubs().length === 0) stop();
    },

    isSubscribed(chatId) {
      return !!config.subscribers[String(chatId)];
    },

    setAutoOrder(enabled) {
      config.autoOrder = !!enabled;
      saveConfig(config);
    },

    setOrderConfig({ symbol, quantity } = {}) {
      if (symbol) config.orderSymbol = symbol.toUpperCase();
      if (quantity != null && quantity > 0) config.orderQuantity = quantity;
      saveConfig(config);
    },

    getStatus() {
      return {
        running,
        autoOrder: config.autoOrder,
        orderSymbol: config.orderSymbol || 'BTCUSDT',
        orderQuantity: config.orderQuantity || 0.001,
        subscribers: activeSubs().length,
        lastCrossover: lastCrossoverTs ? new Date(lastCrossoverTs).toISOString() : null,
        pollIntervalSec: pollMs / 1000,
      };
    },

    getLastSignal() {
      return lastSignal;
    },
  };
};
