// Cloudflare Pages Function: POST /api/lead — релей заявок в Яндекс Форму.
// Демо-вариант функции из api/lead.js (Vercel) под формат Pages Functions.
const SURVEY_URL = 'https://forms.yandex.ru/u/6ab55d7e1f1eb5484e6e0f33/';
const GATEWAY = 'https://forms.yandex.ru/u/gateway/root/form/';
const SURVEY_ID = '6ab55d7e1f1eb5484e6e0f33';

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

export async function onRequestPost(context) {
  const url = new URL(context.request.url);
  let body = {};
  try { body = await context.request.json(); } catch { body = {}; }
  if (body._hp) return Response.json({ ok: true });
  const source = String(body.source || '').slice(0, 40);
  const name = String(body.name || '').slice(0, 100);
  const phone = String(body.phone || '').slice(0, 30);
  const details = String(body.details || '').slice(0, 2000);
  if (phone.replace(/\D/g, '').length < 10) {
    return Response.json({ ok: false, error: 'phone' }, { status: 400 });
  }
  const dry = url.searchParams.get('dry') === '1';

  try {
    const page = await fetch(SURVEY_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await page.text();
    const m = html.match(/csrf-token" content="([^"]+)"/);
    if (!m) throw new Error('no csrf');
    const csrf = m[1];
    const setCookies =
      typeof page.headers.getSetCookie === 'function' ? page.headers.getSetCookie() : [];
    const cookie = setCookies.map((c) => String(c).split(';')[0]).join('; ');
    const gwHeaders = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      Origin: 'https://forms.yandex.ru',
      Referer: SURVEY_URL,
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0',
    };
    const schema = await (
      await fetch(GATEWAY + 'getSurvey', {
        method: 'POST',
        headers: gwHeaders,
        body: JSON.stringify({ surveyId: SURVEY_ID }),
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
    const text = [source && ('Источник: ' + source), name && ('Имя: ' + name)]
      .filter(Boolean)
      .join('\n');
    if (qName && name) values[qName.id] = name;
    if (qPhone) values[qPhone.id] = phone;
    const detailsText = [text, details && ('Подробности: ' + details)].filter(Boolean).join('\n');
    if (qDetails) values[qDetails.id] = detailsText || text || phone;
    if (!Object.keys(values).length) throw new Error('no fields');
    const postRes = await fetch(GATEWAY + 'postSurvey', {
      method: 'POST',
      headers: gwHeaders,
      body: JSON.stringify({ surveyId: SURVEY_ID, values, parent: '', dryRun: dry }),
    });
    const result = await postRes.json();
    if (!postRes.ok || result.error) throw new Error(result.error || 'http ' + postRes.status);
    return Response.json({ ok: true, dry, answer_id: result.answer_id || null });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e).slice(0, 200) }, { status: 502 });
  }
}
