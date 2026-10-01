// POST /api/lead — заявки сайта в Telegram Дмитрию.
// Принимает JSON {source, name, phone, details}.
const TG_API = 'https://api.telegram.org';

const norm = (s) => String(s || '').toLowerCase();

async function tgCall(token, method, params) {
  const r = await fetch(TG_API + '/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('tg ' + method + ': ' + (j.description || r.status));
  return j.result;
}

async function resolveChatId(token, forced) {
  if (forced) return forced;
  const upd = await tgCall(token, 'getUpdates', { limit: 20 });
  const chats = (upd || [])
    .map((u) => (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat) || null)
    .filter(Boolean);
  const priv = chats.filter((c) => c.type === 'private').pop();
  if (!priv) throw new Error('no chat: пусть Дмитрий нажмёт START у бота');
  return priv.id;
}

function buildText({ source, name, phone, details }) {
  const lines = ['🔔 Новая заявка' + (source ? ' (' + source + ')' : '')];
  if (name) lines.push('Имя: ' + name);
  lines.push('Тел: ' + phone);
  if (details) lines.push('— ' + details);
  return lines.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  if (body._hp) {
    res.status(200).json({ ok: true });
    return;
  }
  const source = String(body.source || '').slice(0, 40);
  const name = String(body.name || '').slice(0, 100);
  const phone = String(body.phone || '').slice(0, 30);
  const details = String(body.details || '').slice(0, 2000);
  if (phone.replace(/\D/g, '').length < 10) {
    res.status(400).json({ ok: false, error: 'phone' });
    return;
  }
  const dry = req.query && (req.query.dry === '1' || req.query.dry === 'true');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, error: 'no tg token' });
    return;
  }
  const text = buildText({ source, name, phone, details });
  if (dry) {
    res.status(200).json({ ok: true, dry: true, preview: text });
    return;
  }
  let lastErr = 'unknown';
  for (let i = 1; i <= 2; i++) {
    try {
      const chat = await resolveChatId(token, process.env.TELEGRAM_CHAT_ID || '');
      await tgCall(token, 'sendMessage', { chat_id: chat, text });
      res.status(200).json({ ok: true, via: 'tg', chat });
      return;
    } catch (e) {
      lastErr = String((e && e.message) || e).slice(0, 200);
      if (i < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  res.status(502).json({ ok: false, error: lastErr });
}
