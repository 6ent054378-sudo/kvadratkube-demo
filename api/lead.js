// POST /api/lead — заявки сайта.
// Основное: сообщение в Telegram Дмитрию (мгновенно, как смс).
// Тихо вдогонку: строка в Яндекс Форме (архив-дубль, ошибки игнорируем).
// Принимает JSON {source, name, phone, details}.
const SURVEY_URL = 'https://forms.yandex.ru/u/6ab55d7e1f1eb5484e6e0f33/';
const GATEWAY = 'https://forms.yandex.ru/u/gateway/root/form/';
const SURVEY_ID = '6ab55d7e1f1eb5484e6e0f33';
const TG_API = 'https://api.telegram.org';

function pickCookies(setCookies) {
  if (!setCookies) return '';
  const list = Array.isArray(setCookies) ? setCookies : [setCookies];
  return list.map((c) => String(c).split(';')[0]).join('; ');
}

function findQuestions(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((x) => findQuestions(x, out));
    return;
  }
  if (node.id && (node.text || node.title || node.label) && node.type) {
    out.push({ id: node.id, type: node.type, title: node.text || node.title || node.label });
    return;
  }
  Object.values(node).forEach((x) => findQuestions(x, out));
}

const norm = (s) => String(s || '').toLowerCase();

function matchField(questions, keys) {
  for (const q of questions) {
    const t = norm(q.title || '');
    if (keys.some((k) => t.includes(k))) return q;
  }
  return null;
}

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

async function sendTelegram({ token, chatId, text }) {
  let lastErr = 'unknown';
  for (let i = 1; i <= 2; i++) {
    try {
      const chat = await resolveChatId(token, chatId);
      await tgCall(token, 'sendMessage', { chat_id: chat, text });
      return chat;
    } catch (e) {
      lastErr = String((e && e.message) || e).slice(0, 200);
      if (i < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(lastErr);
}

// Тихий архив в Яндекс Форму: ошибки глушим, на результат не влияем.
async function archiveYandex({ source, name, phone, details, dry }) {
  const t = (ms) => AbortSignal.timeout(ms);
  const page = await fetch(SURVEY_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: t(12000) });
  const html = await page.text();
  const rawCookies =
    typeof page.headers.getSetCookie === 'function'
      ? page.headers.getSetCookie()
      : page.headers.get('set-cookie');
  const m = html.match(/csrf-token" content="([^"]+)"/);
  if (!m) throw new Error('no csrf');
  const gwHeaders = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': m[1],
    Origin: 'https://forms.yandex.ru',
    Referer: SURVEY_URL,
    Cookie: pickCookies(rawCookies),
    'User-Agent': 'Mozilla/5.0',
  };
  const schema = await (
    await fetch(GATEWAY + 'getSurvey', {
      method: 'POST',
      headers: gwHeaders,
      body: JSON.stringify({ surveyId: SURVEY_ID }),
      signal: t(12000),
    })
  ).json();
  const questions = [];
  findQuestions(schema.pages || schema, questions);
  const qName = matchField(questions, ['имя', 'name']);
  const qPhone = matchField(questions, ['телефон', 'phone', 'tel']);
  const qDetails =
    matchField(questions, ['подробност', 'детал', 'комментар', 'ответ', 'details']) ||
    questions.find((q) => q !== qName && q !== qPhone);
  const values = {};
  const head = [source && ('Источник: ' + source), name && ('Имя: ' + name)].filter(Boolean).join('\n');
  if (qName && name) values[qName.id] = name;
  if (qPhone) values[qPhone.id] = phone;
  const det = [head, details && ('Подробности: ' + details)].filter(Boolean).join('\n');
  if (qDetails) values[qDetails.id] = det || head || phone;
  if (!Object.keys(values).length) throw new Error('no fields');
  const postRes = await fetch(GATEWAY + 'postSurvey', {
    method: 'POST',
    headers: gwHeaders,
    body: JSON.stringify({ surveyId: SURVEY_ID, values, parent: '', dryRun: !!dry }),
    signal: t(12000),
  });
  const result = await postRes.json();
  if (!postRes.ok || result.error) throw new Error(result.error || 'http ' + postRes.status);
  return result.answer_id || null;
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
  try {
    const chat = await sendTelegram({
      token,
      chatId: process.env.TELEGRAM_CHAT_ID || '',
      text,
    });
    archiveYandex({ source, name, phone, details, dry: false }).catch(() => {});
    res.status(200).json({ ok: true, via: 'tg', chat });
  } catch (e) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }
}
