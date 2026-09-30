// POST /api/lead — релей заявок сайта в Яндекс Форму.
// Принимает JSON {source, name, phone, details}, кладёт в форму
// surveyId. Поля формы ищутся по названиям (Имя/Телефон/Подробности),
// поэтому ID полей заранее знать не нужно.
const SURVEY_URL = 'https://forms.yandex.ru/u/6ab55d7e1f1eb5484e6e0f33/';
const GATEWAY = 'https://forms.yandex.ru/u/gateway/root/form/';
const SURVEY_ID = '6ab55d7e1f1eb5484e6e0f33';

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
  // Вопрос: есть id и текст/заголовок/подпись и тип
  if (node.id && (node.text || node.title || node.label) && node.type) {
    out.push({ id: node.id, type: node.type, title: node.text || node.title || node.label });
    return;
  }
  Object.values(node).forEach((x) => findQuestions(x, out));
}

function norm(s) {
  return String(s || '').toLowerCase();
}

function matchField(questions, keys) {
  for (const q of questions) {
    const t = norm(q.title || '');
    if (keys.some((k) => t.includes(k))) return q;
  }
  return null;
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
  // honeypot
  if (body._hp) {
    res.status(200).json({ ok: true });
    return;
  }
  const source = String(body.source || '').slice(0, 40);
  const name = String(body.name || '').slice(0, 100);
  const phone = String(body.phone || '').slice(0, 30);
  const details = String(body.details || '').slice(0, 2000);
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) {
    res.status(400).json({ ok: false, error: 'phone' });
    return;
  }
  const dry = req.query && (req.query.dry === '1' || req.query.dry === 'true');

  // Ретрай: шлюз Яндекса иногда отвечает 500 на ровном месте (видно в логах).
  // Две попытки с нуля (свежие cookies + csrf), между ними пауза 1.5с.
  let lastError = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const answerId = await sendYandex({ source, name, phone, details, dry });
      res.status(200).json({ ok: true, dry: !!dry, answer_id: answerId, attempt });
      return;
    } catch (e) {
      lastError = String((e && e.message) || e).slice(0, 200);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  res.status(502).json({ ok: false, error: lastError });
}

async function sendYandex({ source, name, phone, details, dry }) {
  const t = (ms) => AbortSignal.timeout(ms);
  try {
    // 1. Забираем страницу формы: cookies + csrf-токен
    const page = await fetch(SURVEY_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: t(15000),
    });
    const html = await page.text();
    const rawCookies =
      typeof page.headers.getSetCookie === 'function'
        ? page.headers.getSetCookie()
        : page.headers.get('set-cookie');
    const cookie = pickCookies(rawCookies);
    const m = html.match(/csrf-token" content="([^"]+)"/);
    if (!m) throw new Error('no csrf');
    const csrf = m[1];
    const gwHeaders = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      Origin: 'https://forms.yandex.ru',
      Referer: SURVEY_URL,
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0',
    };

    // 2. Схема формы → ищем поля по названиям
    const schemaRes = await fetch(GATEWAY + 'getSurvey', {
      method: 'POST',
      headers: gwHeaders,
      body: JSON.stringify({ surveyId: SURVEY_ID }),
      signal: t(15000),
    });
    const schema = await schemaRes.json();
    const questions = [];
    findQuestions(schema.pages || schema, questions);
    const qName = matchField(questions, ['имя', 'name']);
    const qPhone = matchField(questions, ['телефон', 'phone', 'tel']);
    const qDetails =
      matchField(questions, ['подробност', 'детал', 'комментар', 'ответ', 'details']) ||
      questions.find((q) => q !== qName && q !== qPhone);

    const values = {};
    const text = [source && ('Источник: ' + source), name && ('Имя: ' + name)]
      .filter(Boolean)
      .join('\n');
    if (qName && name) values[qName.id] = name;
    if (qPhone) values[qPhone.id] = phone;
    const detailsText = [text, details && ('Подробности: ' + details)]
      .filter(Boolean)
      .join('\n');
    if (qDetails) values[qDetails.id] = detailsText || text || phone;
    if (!Object.keys(values).length) {
      if (questions.length) values[questions[0].id] = [text, phone, details].filter(Boolean).join('\n');
      else throw new Error('no fields');
    }

    // 3. Отправка (только surveyId/values/parent/dryRun — лишние поля роняют шлюз с 500)
    const postRes = await fetch(GATEWAY + 'postSurvey', {
      method: 'POST',
      headers: gwHeaders,
      body: JSON.stringify({
        surveyId: SURVEY_ID,
        values,
        parent: '',
        dryRun: !!dry,
      }),
      signal: t(15000),
    });
    const result = await postRes.json();
    if (!postRes.ok || result.error) throw new Error(result.error || ('http ' + postRes.status));
    return result.answer_id || null;
  } catch (e) {
    throw e;
  }
}
