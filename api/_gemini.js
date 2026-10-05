// Shared Gemini call: Google Search grounding on, reply expected as JSON
// (parsed leniently, since structured output with search is still preview).

// Models tried in order until one has quota. Free-tier quotas differ per
// model and per project, so a 429/404 moves on to the next one.
export const GEMINI_MODELS = (process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [])
  .concat(['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.6-flash'])
  .filter((m, i, a) => a.indexOf(m) === i);

// remember the last model that worked (per warm function instance)
let preferred = null;

export function parseJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function geminiJson(system, userText, opts = {}) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  const models = preferred ? [preferred].concat(GEMINI_MODELS.filter((m) => m !== preferred)) : GEMINI_MODELS;
  const errors = [];
  // with Google Search first; then once more without it, in case search is what has no quota
  for (const search of opts.search === false ? [false] : [true, false]) {
    for (const model of models) {
      try {
        const out = await callModel(model, system, userText, { ...opts, search });
        preferred = model;
        Object.defineProperty(out, '_model', { value: model + (search ? '' : ' (no search)') });
        return out;
      } catch (err) {
        errors.push(model + (search ? '' : '/nosearch') + ': ' + err.message.slice(0, 160));
        if (err.status !== 429 && err.status !== 404 && err.status !== 403) throw err;
      }
    }
  }
  const e = new Error('No Gemini model available: ' + errors.join(' | '));
  e.status = 429;
  throw e;
}

async function callModel(model, system, userText, { search = true, maxTokens = 16384 } = {}) {
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
    {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        tools: search ? [{ google_search: {} }] : undefined,
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
      }),
    },
  );
  if (!r.ok) {
    let detail = '';
    try {
      const err = (await r.json()).error || {};
      detail = (err.message || '') + ' ' + JSON.stringify(err.details || '').slice(0, 400);
    } catch {}
    const e = new Error('Gemini ' + r.status + ' ' + detail);
    e.status = r.status;
    throw e;
  }
  const data = await r.json();
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts)
    ? cand.content.parts.map((p) => p.text || '').join('')
    : '';
  const parsed = parseJson(text);
  if (!parsed) {
    const e = new Error('Gemini returned unusable output (' + (cand && cand.finishReason) + '): ' + text.slice(0, 300));
    e.finishReason = cand && cand.finishReason;
    throw e;
  }
  return parsed;
}
