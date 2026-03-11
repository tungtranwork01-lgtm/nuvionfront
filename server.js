require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
