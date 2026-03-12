require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const startTelegramBot = require('./telegram-bot');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

const BINANCE_MAINNET = 'https://api.binance.com';
const BINANCE_TESTNET = 'https://testnet.binance.vision';

function signBinanceQuery(secret, queryString) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function binanceRequest(account, pathname, params = {}) {
  const config = account.config || {};
  const apiKey = config.apiKey || config.api_key;
  const secret = config.secretKey || config.secret_key;
  const baseUrl = config.testnet ? BINANCE_TESTNET : BINANCE_MAINNET;
  if (!apiKey || !secret) throw new Error('Thiếu apiKey hoặc secretKey trong config tài khoản');
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...params, timestamp: String(timestamp) });
  const signature = signBinanceQuery(secret, query.toString());
  query.set('signature', signature);
  const url = `${baseUrl}${pathname}?${query.toString()}`;
  const res = await fetch(url, { headers: { 'X-MBX-APIKEY': apiKey } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Binance API ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function seedApiAccountIfEmpty() {
  try {
    const { count, error } = await supabase.from('api_account').select('*', { count: 'exact', head: true });
    if (error) {
      console.warn('[api_account] Không thể kiểm tra bảng:', error.message);
      return;
    }
    if (count > 0) return;
    const { error: insertErr } = await supabase.from('api_account').insert({
      config: {
        apiKey: 'XnBzL1Ynkz70n2nE64TJLJGyRQq01f3v5vRftGR23C7gox8sny1gb588fswtTNUO',
        secretKey: 'S50V703nXe9zSxldBwXzHA0gBUv0kpe9xEDK0bx5HP6i99V4bdhAi2B1opyK2Fvu',
        testnet: true,
      },
      Name: 'Binance Testnet',
      Platform: 'Binance',
    });
    if (insertErr) {
      console.warn('[api_account] Không thể seed tài khoản testnet:', insertErr.message);
      return;
    }
    console.log('[api_account] Đã thêm 1 tài khoản Binance Testnet vào api_account.');
  } catch (e) {
    console.warn('[api_account] Seed lỗi:', e.message);
  }
}

app.use(express.json());

app.get('/api/btcjpy', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 500;
    const offset = parseInt(req.query.offset) || 0;

    const { data, error, count } = await supabase
      .from('BTCJPY')
      .select('*', { count: 'exact' })
      .order('open_time', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({ data, count });
  } catch (err) {
    console.error('Error fetching data:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/btcjpy/latest', async (req, res) => {
  try {
    const total = parseInt(req.query.limit) || 1000;
    const PAGE_SIZE = 1000;
    let allData = [];
    let page = 0;

    while (allData.length < total) {
      const from = page * PAGE_SIZE;
      const to = Math.min(from + PAGE_SIZE - 1, total - 1);

      const { data, error } = await supabase
        .from('BTCJPY')
        .select('*')
        .order('open_time', { ascending: false })
        .range(from, to);

      if (error) throw error;
      if (!data || data.length === 0) break;

      allData = allData.concat(data);
      page++;

      if (data.length < PAGE_SIZE) break;
    }

    res.json({ data: allData.reverse() });
  } catch (err) {
    console.error('Error fetching latest data:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('api_account')
      .select('id, created_at, "Name", "Platform"')
      .order('id', { ascending: true });
    if (error) throw error;
    const list = (data || []).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      Name: row.Name ?? row.name ?? '',
      Platform: row.Platform ?? row.platform ?? '',
    }));
    res.json({ data: list });
  } catch (err) {
    console.error('GET /api/accounts:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/accounts/:id/balance', async (req, res) => {
  try {
    const id = req.params.id;
    const { data: row, error } = await supabase
      .from('api_account')
      .select('id, config, "Name", "Platform"')
      .eq('id', id)
      .single();
    if (error || !row) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    }
    const account = row;
    const pathname = '/api/v3/account';
    const accountInfo = await binanceRequest(account, pathname);
    const balances = (accountInfo.balances || []).filter(
      (b) => ['BTC', 'USDT', 'FDUSD', 'JPY'].includes(b.asset)
    );
    const baseUrl = (account.config && account.config.testnet) ? BINANCE_TESTNET : BINANCE_MAINNET;
    const priceRes = await fetch(`${baseUrl}/api/v3/ticker/price`);
    const prices = {};
    if (priceRes.ok) {
      const arr = await priceRes.json();
      if (Array.isArray(arr)) {
        arr.forEach((p) => { prices[p.symbol] = parseFloat(p.price, 10); });
      }
    }
    const btcUsdt = prices.BTCUSDT || 0;
    const fdusdUsdt = prices.FDUSDUSDT !== undefined ? prices.FDUSDUSDT : 1;
    const usdtJpy = prices.USDTJPY || 0;
    let totalUsdt = 0;
    const items = balances.map((b) => {
      const free = parseFloat(b.free, 10) || 0;
      const locked = parseFloat(b.locked, 10) || 0;
      const total = free + locked;
      let usdtValue = 0;
      if (b.asset === 'USDT') usdtValue = total;
      else if (b.asset === 'BTC') usdtValue = total * btcUsdt;
      else if (b.asset === 'FDUSD') usdtValue = total * fdusdUsdt;
      else if (b.asset === 'JPY') usdtValue = usdtJpy > 0 ? total / usdtJpy : 0;
      totalUsdt += usdtValue;
      return { asset: b.asset, free, locked, total, usdtValue };
    });
    res.json({ data: { balances: items, totalUsdt, accountName: account.Name } });
  } catch (err) {
    console.error('GET /api/accounts/:id/balance:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/accounts/:id/trades', async (req, res) => {
  try {
    const id = req.params.id;
    const { data: row, error } = await supabase
      .from('api_account')
      .select('id, config, "Name"')
      .eq('id', id)
      .single();
    if (error || !row) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    }
    const account = row;
    const symbols = ['BTCUSDT', 'BTCFDUSD', 'BTCJPY', 'FDUSDUSDT', 'USDTJPY', 'FDUSDJPY'];
    let allTrades = [];
    for (const symbol of symbols) {
      try {
        const pathname = '/api/v3/myTrades';
        const data = await binanceRequest(account, pathname, { symbol });
        if (Array.isArray(data)) {
          allTrades = allTrades.concat(data.map((t) => ({ ...t, symbol })));
        }
      } catch (e) {
        if (!e.message.includes('Invalid symbol')) console.warn(`myTrades ${symbol}:`, e.message);
      }
    }
    allTrades.sort((a, b) => (a.time || 0) - (b.time || 0));
    allTrades.reverse();
    res.json({ data: allTrades.slice(0, 200) });
  } catch (err) {
    console.error('GET /api/accounts/:id/trades:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { model, messages, max_tokens, reasoning_effort } = req.body;
    const apiKey = process.env.AI_API_KEY;
    const baseUrl = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

    if (!apiKey) {
      return res.status(400).json({ error: 'AI_API_KEY chưa được cấu hình trong file .env' });
    }

    const url = `${baseUrl}/chat/completions`;
    const selectedModel = model || 'gpt-4o-mini';
    const isReasoningModel = /^(o1|o3|o4)/.test(selectedModel);

    console.log(`[Chat] POST ${url} | model=${selectedModel} | reasoning=${isReasoningModel}`);

    const payload = { model: selectedModel };

    if (isReasoningModel) {
      payload.messages = messages.map(m => m.role === 'system' ? { ...m, role: 'developer' } : m);
      payload.max_completion_tokens = max_tokens || 16000;
      if (reasoning_effort) payload.reasoning_effort = reasoning_effort;
    } else {
      payload.messages = messages;
      payload.temperature = 0.7;
      payload.max_tokens = max_tokens || 4096;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`[Chat] API error ${response.status}:`, responseText.slice(0, 300));
      throw new Error(`API ${response.status}: ${responseText.slice(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error('[Chat] Non-JSON response:', responseText.slice(0, 300));
      throw new Error('AI API trả về dữ liệu không hợp lệ (không phải JSON)');
    }

    res.json({
      content: data.choices[0].message.content,
      model: data.model,
      usage: data.usage,
    });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, async () => {
  await seedApiAccountIfEmpty();
  startTelegramBot(supabase);
  console.log(`Server running at http://localhost:${PORT}`);
});
