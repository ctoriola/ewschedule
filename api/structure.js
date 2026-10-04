// POST /api/structure  { lines: string[] }  ->  { items: [...] }
// Uses an LLM on Groq to turn the raw text of a lyrics document into a structured
// running order: section title slides plus songs split into labelled parts.

const MAX_CHARS = 60000;

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'title', 'author', 'parts'],
        properties: {
          kind: { type: 'string', enum: ['section', 'song'] },
          title: { type: 'string' },
          author: { type: 'string' },
          parts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'lines'],
              properties: {
                label: { type: 'string' },
                lines: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `You turn the text of a church service lyrics document into a running order for EasyWorship projection.

The document arrives one paragraph per line, inside <document> tags. Layouts vary: numbered or unnumbered songs, "Lyrics: Title by Artist" headers, ALL-CAPS titles, verse labels with or without brackets, translations in parentheses, Leader/Choir call-and-response, dates and notes.

OUTPUT
Return {"items": [...]} in document order. Each item is one of:

1. A section title slide: {"kind":"section","title":"Praise","author":"","parts":[]}
   Use for headings that group songs in the service: Praise, Worship, Special Song(s), Ministration, Thanksgiving, Offering, Hymn(s), Opening, Closing, Altar Call, Communion and similar. Title Case ("PRAISE" -> "Praise", "SPECIAL SONGS" -> "Special Songs"). Never put lyrics in a section.

2. A song: {"kind":"song","title":"...","author":"...","parts":[{"label":"...","lines":["...", "..."]}]}
   - title: the song's name. From "Lyrics: <title> by <artist>" take <title>. From an ALL-CAPS heading above lyrics, use it in Title Case. Otherwise use a short phrase from the first line (max ~6 words), no trailing punctuation.
   - author: the artist after "by", otherwise "".
   - parts: every block of the song, in order.

WHERE SONGS START
A new song starts at: a number like "2." or "3)", a "Lyrics:" line, an ALL-CAPS song heading, or a section heading. Lines after a number belong to that numbered song until the next number/heading. Never merge two numbered songs; never split one song into two.

PART LABELS (be consistent)
- Use the document's own label if it has one ("[Verse 1]", "Chorus", "Pre-Chorus", "Bridge"...), written exactly as one of: "Verse 1", "Verse 2", ..., "Chorus", "Pre-Chorus", "Bridge", "Refrain", "Intro", "Outro", "Tag", "Vamp", "Call & Response".
- If unlabelled: a block that appears more than once, or the short repeated hook, is "Chorus"; other blocks are "Verse 1", "Verse 2"... in order; Leader:/Choir: blocks are "Call & Response".
- A song with only one block gets label "".
- Blank lines in the document separate blocks. A label line starts a new block. Do not merge blocks or split a block.

LINES
- Copy every lyric line, one sung line per entry, in the original order. Do not drop, add, merge, reorder or summarise lines. If a block is repeated in the document, include it again each time.
- Keep the exact words and spelling, especially Nigerian Pidgin, Yoruba, Igbo, Hausa, Efik and other non-English words, and informal spellings like "dey", "don", "wey", "oo", "o". Never translate or "correct" them.
- Allowed fixes only: trim spaces, collapse doubled spaces/punctuation, fix obvious English misspellings, and capitalise the first letter of each line.
- Keep a translation in parentheses on its own line directly after the line it translates.
- Keep "Leader:" and "Choir:" prefixes.
- Remove repeat markers such as "x3", "(x2)", "[3x]", "2ce" and keep the line once.

NOT LYRICS (drop them)
Dates, song numbers, the "Lyrics:" header line, label lines (they become part labels), and editorial notes such as "repeat chorus" or "slow".

EXAMPLE
<document>
04/10/2026
PRAISE

1.
Lyrics: Come And See by Akpororo

come and see oo what the Lord has done x2
Precious One o, Sweety Father eh

Come and see oo what the Lord has done

2.
Kai kadai [3x] Ubangiji
(You alone our Saviour)
WORSHIP
NIGERIA ARISE
Leader: We speak peace over Nigeria!
Choir: we speak peace in our land
</document>
Correct output:
{"items":[
{"kind":"section","title":"Praise","author":"","parts":[]},
{"kind":"song","title":"Come And See","author":"Akpororo","parts":[
 {"label":"Chorus","lines":["Come and see oo what the Lord has done","Precious One o, Sweety Father eh"]},
 {"label":"Chorus","lines":["Come and see oo what the Lord has done"]}]},
{"kind":"song","title":"Kai Kadai Ubangiji","author":"","parts":[
 {"label":"","lines":["Kai kadai Ubangiji","(You alone our Saviour)"]}]},
{"kind":"section","title":"Worship","author":"","parts":[]},
{"kind":"song","title":"Nigeria Arise","author":"","parts":[
 {"label":"Call & Response","lines":["Leader: We speak peace over Nigeria!","Choir: We speak peace in our land"]}]}
]}

Before answering, check: every lyric line from the document appears exactly once per occurrence, no words were changed, and each numbered song is its own item.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }
  if (!process.env.GROQ_API_KEY) {
    res.status(503).json({ error: 'AI clean-up is not configured on this server.' });
    return;
  }

  const lines = req.body && Array.isArray(req.body.lines) ? req.body.lines.map(String) : null;
  if (!lines || !lines.length) {
    res.status(400).json({ error: 'No text received.' });
    return;
  }
  const text = lines.join('\n');
  if (text.length > MAX_CHARS) {
    res.status(413).json({ error: 'That document is too long for AI clean-up.' });
    return;
  }

  let best = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await callGroq(text);
    } catch (err) {
      lastError = err;
      if (err.retry) continue;
      break;
    }
    const items = clean(result.items);
    const score = coverage(lines, items);
    if (!best || score > best.score) best = { items, score };
    if (score >= 0.97) break;
  }

  if (!best) {
    res.status(lastError.status || 502).json({ error: lastError.message });
    return;
  }
  if (best.score < 0.85) {
    res.status(422).json({ error: 'The AI result left out too many lyrics.' });
    return;
  }
  res.status(200).json({ items: best.items, coverage: Math.round(best.score * 100) / 100 });
}

async function callGroq(text) {
  let r;
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.GROQ_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_completion_tokens: 32768,
        reasoning_effort: 'high',
        temperature: 0.2,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'running_order', strict: true, schema: SCHEMA },
        },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: '<document>\n' + text + '\n</document>' },
        ],
      }),
    });
  } catch {
    const e = httpError(502, 'Could not reach the AI service.');
    e.retry = true;
    throw e;
  }
  if (!r.ok) {
    // Keep Groq's own explanation: it is the only way to tell what went wrong.
    let detail = '';
    try {
      const body = await r.json();
      detail = (body.error && (body.error.message || body.error.code)) || '';
      console.error('Groq error', r.status, JSON.stringify(body.error || body).slice(0, 2000));
    } catch {
      console.error('Groq error', r.status);
    }
    if (r.status === 429) throw httpError(429, 'The AI is busy right now (rate limit). Try again in a minute.');
    const e = httpError(502, 'The AI service returned an error (' + r.status + (detail ? ': ' + detail.slice(0, 300) : '') + ').');
    // 400s here are usually a failed JSON generation, and 5xx are transient: worth one retry.
    e.retry = r.status === 400 || r.status >= 500;
    throw e;
  }

  let data;
  try {
    data = await r.json();
  } catch {
    throw httpError(502, 'The AI returned an unexpected response.');
  }
  const choice = data.choices && data.choices[0];
  if (!choice) throw httpError(502, 'The AI returned an unexpected response.');
  if (choice.finish_reason === 'length') throw httpError(413, 'That document is too long for AI clean-up.');
  try {
    const parsed = JSON.parse(choice.message.content);
    if (!Array.isArray(parsed.items)) throw new Error();
    return parsed;
  } catch {
    throw httpError(502, 'The AI returned an unexpected response.');
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- post-processing ----------

const REPEAT = /\s*(?:[([]\s*(?:x\s*\d+|\d+\s*x)\s*[)\]]|\b(?:x\s*\d+|\d+\s*x)\b|\b\d+ce\b)\s*/gi;
const LABELS = {
  chorus: 'Chorus', refrain: 'Refrain', bridge: 'Bridge', intro: 'Intro', outro: 'Outro',
  tag: 'Tag', vamp: 'Vamp', 'pre-chorus': 'Pre-Chorus', prechorus: 'Pre-Chorus', 'pre chorus': 'Pre-Chorus',
};

function capitalise(line) {
  // first letter, skipping leading brackets/quotes and a "Leader:"/"Choir:" prefix
  const m = line.match(/^((?:leader|choir|all|congregation)\s*:\s*)?([^\p{L}\p{N}]*)(\p{L})/iu);
  if (!m) return line;
  const prefix = m[1] ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : '';
  const at = m[0].length - m[3].length;
  return prefix + line.slice(m[1] ? m[1].length : 0, at) + m[3].toUpperCase() + line.slice(at + 1);
}

function cleanLine(line) {
  return capitalise(String(line).replace(REPEAT, ' ').replace(/\s+/g, ' ').trim());
}

function cleanLabel(label) {
  const l = String(label || '').replace(/[[\]():]/g, '').trim();
  if (!l) return '';
  const key = l.toLowerCase();
  if (LABELS[key]) return LABELS[key];
  const v = key.match(/^verse\s*(\d+)?$/);
  if (v) return v[1] ? 'Verse ' + v[1] : 'Verse';
  return l.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function cleanTitle(t) {
  t = String(t || '').replace(/\s+/g, ' ').replace(/[\s,;:.!]+$/, '').trim();
  // ALL-CAPS -> Title Case
  if (/\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t)) t = t.toLowerCase().replace(/(^|[\s(\-'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  return t;
}

function clean(items) {
  const out = [];
  for (const it of items) {
    if (it.kind === 'section') {
      const title = cleanTitle(it.title);
      if (title) out.push({ kind: 'section', title: capitalise(title), author: '', parts: [] });
      continue;
    }
    const parts = (it.parts || [])
      .map((p) => ({ label: cleanLabel(p.label), lines: (p.lines || []).map(cleanLine).filter(Boolean) }))
      .filter((p) => p.lines.length);
    if (!parts.length) continue;
    const title = cleanTitle(it.title) || cleanTitle(parts[0].lines[0]);
    out.push({ kind: 'song', title: capitalise(title), author: cleanTitle(it.author), parts });
  }
  return out;
}

// Share of the document's lyric words that made it into the result.
function words(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/\p{L}+/gu) || [];
}
function coverage(lines, items) {
  const META = /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,3}[.)]?|lyrics?\s*[:-].*|\[.*\]|(verse|chorus|pre-?chorus|bridge|refrain|intro|outro|tag|vamp)\s*\d*\s*:?)$/i;
  const source = lines.filter((l) => l.trim() && !META.test(l.trim())).flatMap((l) => words(l.replace(REPEAT, ' ')));
  if (!source.length) return 1;
  const have = new Map();
  for (const it of items) {
    for (const w of words(it.title + ' ' + it.author)) have.set(w, (have.get(w) || 0) + 1);
    for (const p of it.parts) for (const l of p.lines) for (const w of words(l)) have.set(w, (have.get(w) || 0) + 1);
  }
  let found = 0;
  for (const w of source) {
    const n = have.get(w);
    if (n) { found++; have.set(w, n - 1); }
  }
  return found / source.length;
}

export const _test = { clean, coverage, capitalise };
