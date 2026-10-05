// Shared Gemini call: Google Search grounding on, reply expected as JSON
// (parsed leniently, since structured output with search is still preview).

export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

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

export async function geminiJson(system, userText, { search = true, maxTokens = 16384 } = {}) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(GEMINI_MODEL) + ':generateContent',
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
      detail = JSON.stringify((await r.json()).error || '').slice(0, 1000);
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
