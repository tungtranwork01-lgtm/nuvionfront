const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

const BINANCE_MAINNET = 'https://api.binance.com';
const BINANCE_TESTNET = 'https://testnet.binance.vision';

const HISTORY_LIMIT = 40;
const MAX_TOOL_LOOPS = 6;

function signQuery(secret, qs) {
  return crypto.createHmac('sha256', secret).update(qs).digest('hex');
}

async function binanceReq(config, pathname, params = {}, method = 'GET') {
  const apiKey = config.apiKey || config.api_key;
  const secret = config.secretKey || config.secret_key;
  const base = config.testnet ? BINANCE_TESTNET : BINANCE_MAINNET;
  const ts = Date.now();
  const qs = new URLSearchParams({ ...params, timestamp: String(ts) });
  qs.set('signature', signQuery(secret, qs.toString()));
  const url = `${base}${pathname}?${qs.toString()}`;
  const opts = { method, headers: { 'X-MBX-APIKEY': apiKey } };
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Binance ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_account_balance',
      description: 'Lấy số dư tài khoản Binance (BTC, USDT, FDUSD, JPY) và tổng quy đổi USDT. Nếu không truyền account_id thì lấy tài khoản đầu tiên.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'number', description: 'ID tài khoản trong bảng api_account (tuỳ chọn)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_trade_history',
      description: 'Lấy lịch sử giao dịch gần nhất (BTC, USDT, FDUSD, JPY).',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'number', description: 'ID tài khoản (tuỳ chọn)' },
          limit: { type: 'number', description: 'Số giao dịch tối đa (mặc định 20)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_price',
      description: 'Lấy giá hiện tại của một cặp giao dịch trên Binance.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Ví dụ: BTCUSDT, BTCJPY' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'place_order',
      description: 'Đặt lệnh mua/bán trên Binance. QUAN TRỌNG: Luôn xác nhận lại với user trước khi thực hiện lệnh.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'number', description: 'ID tài khoản (tuỳ chọn)' },
          symbol: { type: 'string', description: 'Cặp giao dịch, ví dụ BTCUSDT' },
          side: { type: 'string', enum: ['BUY', 'SELL'], description: 'BUY hoặc SELL' },
          type: { type: 'string', enum: ['MARKET', 'LIMIT'], description: 'Loại lệnh' },
          quantity: { type: 'number', description: 'Số lượng' },
          price: { type: 'number', description: 'Giá (chỉ cho lệnh LIMIT)' },
          timeInForce: { type: 'string', enum: ['GTC', 'IOC', 'FOK'], description: 'Chỉ cho lệnh LIMIT, mặc định GTC' },
        },
        required: ['symbol', 'side', 'type', 'quantity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_open_orders',
      description: 'Xem danh sách lệnh đang mở (open orders) trên Binance.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'number', description: 'ID tài khoản (tuỳ chọn)' },
          symbol: { type: 'string', description: 'Cặp giao dịch (tuỳ chọn, nếu không truyền sẽ lấy tất cả)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_order',
      description: 'Huỷ một lệnh đang mở trên Binance.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'number', description: 'ID tài khoản (tuỳ chọn)' },
          symbol: { type: 'string', description: 'Cặp giao dịch' },
          orderId: { type: 'number', description: 'Order ID cần huỷ' },
        },
        required: ['symbol', 'orderId'],
      },
    },
  },
];

const SYSTEM_PROMPT = `Bạn là trợ lý giao dịch crypto thông minh tên Nuvion Bot. Bạn có thể:
- Xem số dư tài khoản Binance (BTC, USDT, FDUSD, JPY)
- Xem lịch sử giao dịch
- Lấy giá crypto hiện tại
- Đặt lệnh mua/bán (MARKET hoặc LIMIT)
- Xem và huỷ lệnh đang mở

Quy tắc quan trọng:
1. Khi user yêu cầu mua/bán, LUÔN xác nhận lại chi tiết (symbol, side, quantity, giá) trước khi đặt lệnh.
2. Trả lời bằng tiếng Việt, ngắn gọn, dễ hiểu.
3. Khi hiển thị số liệu tài chính, format rõ ràng.
4. Nếu user hỏi chung chung, hãy dùng tool để lấy dữ liệu rồi trả lời.
5. Tài khoản hiện tại là Binance Testnet — nhắc user nếu cần.`;

module.exports = function startTelegramBot(supabase) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const aiKey = process.env.AI_API_KEY;
  const aiBase = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

  if (!token) {
    console.warn('[TelegramBot] TELEGRAM_BOT_TOKEN chưa cấu hình — bỏ qua.');
    return;
  }
  if (!aiKey) {
    console.warn('[TelegramBot] AI_API_KEY chưa cấu hình — bỏ qua.');
    return;
  }

  const bot = new TelegramBot(token, { polling: true });
  console.log('[TelegramBot] Bot đã khởi động, đang polling...');

  async function getAccount(accountId) {
    let q = supabase.from('api_account').select('id, config, "Name", "Platform"');
    if (accountId) q = q.eq('id', accountId);
    else q = q.order('id', { ascending: true }).limit(1);
    const { data, error } = await q.single();
    if (error || !data) throw new Error('Không tìm thấy tài khoản' + (accountId ? ` id=${accountId}` : ''));
    return data;
  }

  async function toolGetBalance(args) {
    const acct = await getAccount(args.account_id);
    const config = acct.config || {};
    const info = await binanceReq(config, '/api/v3/account');
    const tracked = ['BTC', 'USDT', 'FDUSD', 'JPY'];
    const balances = (info.balances || []).filter((b) => tracked.includes(b.asset));
    const base = config.testnet ? BINANCE_TESTNET : BINANCE_MAINNET;
    const pr = await fetch(`${base}/api/v3/ticker/price`);
    const prices = {};
    if (pr.ok) {
      const arr = await pr.json();
      if (Array.isArray(arr)) arr.forEach((p) => { prices[p.symbol] = parseFloat(p.price); });
    }
    const btcUsdt = prices.BTCUSDT || 0;
    const fdusdUsdt = prices.FDUSDUSDT ?? 1;
    const usdtJpy = prices.USDTJPY || 0;
    let totalUsdt = 0;
    const items = balances.map((b) => {
      const total = parseFloat(b.free) + parseFloat(b.locked);
      let uv = 0;
      if (b.asset === 'USDT') uv = total;
      else if (b.asset === 'BTC') uv = total * btcUsdt;
      else if (b.asset === 'FDUSD') uv = total * fdusdUsdt;
      else if (b.asset === 'JPY') uv = usdtJpy > 0 ? total / usdtJpy : 0;
      totalUsdt += uv;
      return { asset: b.asset, free: b.free, locked: b.locked, total: total.toFixed(8), usdtValue: uv.toFixed(2) };
    });
    return JSON.stringify({ accountName: acct.Name, testnet: !!config.testnet, balances: items, totalUsdt: totalUsdt.toFixed(2) });
  }

  async function toolGetTrades(args) {
    const acct = await getAccount(args.account_id);
    const config = acct.config || {};
    const symbols = ['BTCUSDT', 'BTCFDUSD', 'BTCJPY', 'FDUSDUSDT', 'USDTJPY', 'FDUSDJPY'];
    let all = [];
    for (const sym of symbols) {
      try {
        const data = await binanceReq(config, '/api/v3/myTrades', { symbol: sym });
        if (Array.isArray(data)) all = all.concat(data.map((t) => ({ ...t, symbol: sym })));
      } catch (_) { /* skip invalid symbols */ }
    }
    all.sort((a, b) => (b.time || 0) - (a.time || 0));
    const limit = args.limit || 20;
    return JSON.stringify(all.slice(0, limit).map((t) => ({
      time: new Date(t.time).toISOString(),
      symbol: t.symbol,
      side: t.isBuyer ? 'BUY' : 'SELL',
      price: t.price,
      qty: t.qty,
      quoteQty: t.quoteQty,
    })));
  }

  async function toolGetPrice(args) {
    const symbol = (args.symbol || '').toUpperCase();
    const res = await fetch(`${BINANCE_MAINNET}/api/v3/ticker/price?symbol=${symbol}`);
    if (!res.ok) {
      const res2 = await fetch(`${BINANCE_TESTNET}/api/v3/ticker/price?symbol=${symbol}`);
      if (!res2.ok) throw new Error(`Không tìm thấy cặp ${symbol}`);
      return JSON.stringify(await res2.json());
    }
    return JSON.stringify(await res.json());
  }

  async function toolPlaceOrder(args) {
    const acct = await getAccount(args.account_id);
    const config = acct.config || {};
    const params = {
      symbol: (args.symbol || '').toUpperCase(),
      side: args.side,
      type: args.type,
    };
    if (args.type === 'LIMIT') {
      params.timeInForce = args.timeInForce || 'GTC';
      params.price = String(args.price);
    }
    params.quantity = String(args.quantity);
    const result = await binanceReq(config, '/api/v3/order', params, 'POST');
    return JSON.stringify({
      orderId: result.orderId,
      symbol: result.symbol,
      side: result.side,
      type: result.type,
      status: result.status,
      executedQty: result.executedQty,
      price: result.price,
      fills: result.fills,
    });
  }

  async function toolGetOpenOrders(args) {
    const acct = await getAccount(args.account_id);
    const config = acct.config || {};
    const params = {};
    if (args.symbol) params.symbol = args.symbol.toUpperCase();
    const data = await binanceReq(config, '/api/v3/openOrders', params);
    return JSON.stringify((data || []).map((o) => ({
      orderId: o.orderId,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      price: o.price,
      origQty: o.origQty,
      executedQty: o.executedQty,
      status: o.status,
      time: new Date(o.time).toISOString(),
    })));
  }

  async function toolCancelOrder(args) {
    const acct = await getAccount(args.account_id);
    const config = acct.config || {};
    const result = await binanceReq(config, '/api/v3/order', {
      symbol: (args.symbol || '').toUpperCase(),
      orderId: String(args.orderId),
    }, 'DELETE');
    return JSON.stringify({ orderId: result.orderId, status: result.status, symbol: result.symbol });
  }

  const toolHandlers = {
    get_account_balance: toolGetBalance,
    get_trade_history: toolGetTrades,
    get_price: toolGetPrice,
    place_order: toolPlaceOrder,
    get_open_orders: toolGetOpenOrders,
    cancel_order: toolCancelOrder,
  };

  let dbAvailable = true;

  async function saveMsg(chatId, role, content, toolCalls, toolCallId, name) {
    if (!dbAvailable) return;
    try {
      const row = { chat_id: chatId, role, content: content || null };
      if (toolCalls) row.tool_calls = toolCalls;
      if (toolCallId) row.tool_call_id = toolCallId;
      if (name) row.name = name;
      const { error } = await supabase.from('telegram_messages').insert(row);
      if (error) {
        console.error('[TelegramBot] saveMsg error:', error.message);
        if (error.message.includes('does not exist') || error.code === '42P01') {
          dbAvailable = false;
          console.warn('[TelegramBot] Bảng telegram_messages chưa tồn tại — chạy SQL trong supabase_function.sql. Bot vẫn hoạt động nhưng không lưu lịch sử.');
        }
      }
    } catch (e) {
      console.error('[TelegramBot] saveMsg exception:', e.message);
    }
  }

  async function loadHistory(chatId) {
    if (!dbAvailable) return [];
    try {
      const { data, error } = await supabase
        .from('telegram_messages')
        .select('role, content, tool_calls, tool_call_id, name')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT);
      if (error) {
        console.error('[TelegramBot] loadHistory error:', error.message);
        return [];
      }
      if (!data || data.length === 0) return [];
      const msgs = data.reverse().map((r) => {
        const m = { role: r.role };
        if (r.role === 'tool') {
          m.content = r.content || '';
          if (r.tool_call_id) m.tool_call_id = r.tool_call_id;
        } else if (r.role === 'assistant' && r.tool_calls && r.tool_calls.length > 0) {
          m.content = r.content || null;
          m.tool_calls = r.tool_calls;
        } else {
          m.content = r.content || '';
        }
        return m;
      });
      return msgs;
    } catch (e) {
      console.error('[TelegramBot] loadHistory exception:', e.message);
      return [];
    }
  }

  async function callAI(messages) {
    const url = `${aiBase}/chat/completions`;
    const model = process.env.TELEGRAM_AI_MODEL || 'gpt-4.1-mini';
    const payload = {
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.5,
      max_tokens: 4096,
    };
    console.log(`[TelegramBot] AI call: model=${model}, messages=${messages.length}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiKey}` },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[TelegramBot] AI error ${res.status}:`, text.slice(0, 400));
      throw new Error(`AI API ${res.status}: ${text.slice(0, 300)}`);
    }
    const parsed = JSON.parse(text);
    const choice = parsed.choices && parsed.choices[0];
    if (choice && choice.message) {
      const tc = choice.message.tool_calls;
      console.log(`[TelegramBot] AI response: tool_calls=${tc ? tc.length : 0}, content_len=${(choice.message.content || '').length}`);
    }
    return parsed;
  }

  async function handleMessage(chatId, userText) {
    console.log(`[TelegramBot] handleMessage chatId=${chatId}: "${userText.slice(0, 80)}"`);

    await saveMsg(chatId, 'user', userText);

    const history = await loadHistory(chatId);
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

    if (history.length > 0) {
      const lastIsCurrentUser = history.length > 0
        && history[history.length - 1].role === 'user'
        && history[history.length - 1].content === userText;
      messages.push(...history);
      if (!lastIsCurrentUser) {
        messages.push({ role: 'user', content: userText });
      }
    } else {
      messages.push({ role: 'user', content: userText });
    }

    console.log(`[TelegramBot] Total messages for AI: ${messages.length} (history=${history.length})`);

    let loops = 0;
    while (loops < MAX_TOOL_LOOPS) {
      loops++;
      const aiRes = await callAI(messages);
      const choice = aiRes.choices[0];
      const msg = choice.message;

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const reply = msg.content || '(Không có phản hồi)';
        await saveMsg(chatId, 'assistant', reply);
        return reply;
      }

      console.log(`[TelegramBot] AI wants to call ${msg.tool_calls.length} tool(s): ${msg.tool_calls.map(t => t.function.name).join(', ')}`);

      messages.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      });
      await saveMsg(chatId, 'assistant', msg.content || null, msg.tool_calls);

      for (const tc of msg.tool_calls) {
        const fn = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
        console.log(`[TelegramBot] Executing tool: ${fn}(${JSON.stringify(args).slice(0, 100)})`);
        let result;
        try {
          const handler = toolHandlers[fn];
          if (!handler) throw new Error(`Không có tool: ${fn}`);
          result = await handler(args);
          console.log(`[TelegramBot] Tool ${fn} OK, result_len=${result.length}`);
        } catch (e) {
          console.error(`[TelegramBot] Tool ${fn} ERROR:`, e.message);
          result = JSON.stringify({ error: e.message });
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        await saveMsg(chatId, 'tool', result, null, tc.id, fn);
      }
    }
    const fallback = 'Xin lỗi, tôi đã thực hiện quá nhiều bước. Vui lòng thử lại với câu hỏi đơn giản hơn.';
    await saveMsg(chatId, 'assistant', fallback);
    return fallback;
  }

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    if (text === '/start') {
      const welcome = '👋 Xin chào! Tôi là *Nuvion Bot* — trợ lý giao dịch crypto.\n\nBạn có thể hỏi tôi:\n• Số dư tài khoản\n• Giá crypto hiện tại\n• Đặt lệnh mua/bán\n• Xem lịch sử giao dịch\n• Xem/huỷ lệnh đang mở\n\nGõ `/clear` để xoá lịch sử hội thoại.';
      bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/clear') {
      await supabase.from('telegram_messages').delete().eq('chat_id', chatId);
      bot.sendMessage(chatId, '🗑 Đã xoá lịch sử hội thoại.');
      return;
    }

    bot.sendChatAction(chatId, 'typing');

    try {
      const reply = await handleMessage(chatId, text);
      const chunks = splitMessage(reply, 4000);
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(() => {
          bot.sendMessage(chatId, chunk);
        });
      }
    } catch (err) {
      console.error('[TelegramBot] Error:', err.message);
      bot.sendMessage(chatId, `❌ Lỗi: ${err.message.slice(0, 500)}`);
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[TelegramBot] Polling error:', err.message);
  });

  return bot;
};

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxLen) { parts.push(rest); break; }
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.3) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return parts;
}
