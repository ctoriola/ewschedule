// POST /api/structure  { lines: string[] }  ->  { items: [...] }
// Uses an LLM on Groq to work out the running order of a lyrics document:
// section title slides, where each song starts and ends, titles and part
// labels. The model only returns line numbers; the lyric text itself is
// always taken from the document, so nothing can be dropped or rewritten.

const MAX_CHARS = 60000;
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
// Groq counts input + max_completion_tokens against the tokens-per-minute
// limit (8000 on the free tier). Set GROQ_TPM higher on a paid tier.
const TPM = +process.env.GROQ_TPM || 8000;
const EFFORT = process.env.GROQ_REASONING || 'low';

const SYSTEM = `You work out the running order of a church service lyrics document for EasyWorship projection.

The document is given one paragraph per line, each prefixed with its line number ("12| text"). Empty lines separate blocks. Layouts vary: numbered or unnumbered songs, "Lyrics: Title by Artist" headers, "Title Lyrics" headers, ALL-CAPS headings, verse labels with or without brackets, translations in parentheses, Call/Response or Leader/Choir lines, dates and notes.

Return JSON: {"items": [...]}, in document order. Each item is one of:

1. Section title slide: {"kind":"section","title":"Praise","author":"","parts":[]}
   For headings that group songs in the service: Praise (A/B), Worship, Special Song(s), Ministration, Thanksgiving, Offering, Hymn(s), Opening, Closing, Altar Call, Communion and similar. Title Case, keep letters like "A"/"B" ("PRAISE A" -> "Praise A").

2. Song: {"kind":"song","title":"...","author":"...","parts":[{"label":"...","from":N,"to":M}]}
   - title: the song's name in Title Case. From "Lyrics: <title> by <artist>", "<title> by <artist>" or "<title> Lyrics" take <title>. If there is no heading, use a short phrase from the first lyric line.
   - author: the artist after "by", else "".
   - parts: the song's blocks in order. from/to are the first and last line numbers of the block's lyric lines (inclusive). Never include heading lines (numbers, dates, titles, "Lyrics:" lines, label lines, section headings) inside a range.
   - A song whose lyrics are not in the document (only a title, e.g. "2. Awesome God by Kirk Franklin.") gets parts: [].

Where songs start: at a song number ("2.", "3)", or a bare "1"), a "Lyrics:"/"... Lyrics"/"... by ..." title line, an ALL-CAPS song heading, or a section heading. A numbered song runs until the next number or heading. Never merge two numbered songs and never split one song.

Part labels, one per block (a block = consecutive non-empty lines):
- Use the document's label when given ("[Verse]", "Chorus", "Bridge 2", "Verse 1"...). The label line itself is not part of any range; the block after it is.
- Allowed labels: "Verse 1", "Verse 2", ..., "Chorus", "Pre-Chorus", "Bridge" (or "Bridge 1", "Bridge 2"...), "Refrain" (or numbered), "Intro", "Outro", "Tag", "Vamp", "Call & Response".
- When unlabelled: a block that repeats in the song, or is the short hook, is "Chorus" each time it appears; Call:/Resp: or Leader:/Choir: blocks are "Call & Response"; other blocks are "Verse 1", "Verse 2"... in order. A song with a single block uses "".
- Every lyric line of the song must be inside exactly one part. Do not skip blocks.
- Cover the WHOLE document, to the last line: every song and section from the first line to the end.

Example document:
1| 04/10/2026
2| PRAISE
3| 
4| 1.
5| Lyrics: Come And See by Akpororo
6| [Chorus]
7| Come and see oo what the Lord has done x2
8| 
9| Precious One o, Sweety Father eh
10| Daddy moh o, look how You turn my life
11| 
12| Come and see oo what the Lord has done
13| 2.
14| Awesome God by Kirk Franklin.
15| WORSHIP
16| Leader: We speak peace over Nigeria!
17| Choir: We speak peace in our land
Correct output:
{"items":[
{"kind":"section","title":"Praise","author":"","parts":[]},
{"kind":"song","title":"Come And See","author":"Akpororo","parts":[{"label":"Chorus","from":7,"to":7},{"label":"Verse 1","from":9,"to":10},{"label":"Chorus","from":12,"to":12}]},
{"kind":"song","title":"Awesome God","author":"Kirk Franklin","parts":[]},
{"kind":"section","title":"Worship","author":"","parts":[]},
{"kind":"song","title":"We Speak Peace Over Nigeria","author":"","parts":[{"label":"Call & Response","from":16,"to":17}]}
]}

Reply with only the JSON object.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }
  if (!process.env.GROQ_API_KEY) {
    res.status(503).json({ error: 'AI clean-up is not configured on this server.' });
    return;
  }

  const lines = req.body && Array.isArray(req.body.lines) ? req.body.lines.map((l) => String(l).trim()) : null;
  if (!lines || !lines.length) {
    res.status(400).json({ error: 'No text received.' });
    return;
  }
  if (lines.join('\n').length > MAX_CHARS) {
    res.status(413).json({ error: 'That document is too long for AI clean-up.' });
    return;
  }
  const numbered = lines.map((l, i) => i + 1 + '| ' + l).join('\n');

  let best = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      raw = await callGroq(numbered);
    } catch (err) {
      lastError = err;
      if (err.retry) continue;
      break;
    }
    const built = build(raw.list, lines);
    built.debug = raw.debug;
    if (!best || built.coverage > best.coverage) best = built;
    if (built.coverage >= 0.9) break;
  }

  if (!best) {
    res.status(lastError.status || 502).json({ error: lastError.message });
    return;
  }
  res.status(200).json({ items: best.items, coverage: Math.round(best.coverage * 100) / 100, debug: best.debug });
}

async function callGroq(numbered) {
  // rough token estimate (~3 chars per token) plus a safety margin
  const inputTokens = Math.ceil((SYSTEM.length + numbered.length) / 3) + 200;
  const maxTokens = Math.min(16384, TPM - inputTokens);
  if (maxTokens < 1500) throw httpError(413, 'That document is too long for AI clean-up on the current Groq plan.');

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
        max_completion_tokens: maxTokens,
        reasoning_effort: EFFORT,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: numbered },
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
    if (r.status === 429) {
      const perDay = /per day|TPD|RPD/i.test(detail);
      throw httpError(429, perDay
        ? 'The Groq free-tier daily limit has been reached. AI clean-up will work again tomorrow (or upgrade the Groq plan).'
        : 'The AI is busy right now (rate limit). Try again in a minute.');
    }
    const e = httpError(502, 'The AI service returned an error (' + r.status + (detail ? ': ' + detail.slice(0, 300) : '') + ').');
    // 400s here are usually a failed generation, and 5xx are transient: worth one retry.
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
  const list = choice && parseList(choice.message && choice.message.content);
  if (!list) {
    console.error('Groq returned unusable output', choice && choice.finish_reason, String(choice && choice.message && choice.message.content).slice(0, 2000));
    const e = httpError(502, 'The AI returned an unexpected response.');
    e.retry = true;
    throw e;
  }
  return { list, debug: { finish: choice.finish_reason, usage: data.usage && { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens } } };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Accept the model's JSON even if wrapped in text or code fences.
function parseList(content) {
  if (typeof content !== 'string') return null;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(content.slice(start, end + 1));
    const list = Array.isArray(data) ? data : data && data.items;
    return Array.isArray(list) ? list.filter((it) => it && typeof it === 'object') : null;
  } catch {
    return null;
  }
}

// ---------- building the result from line numbers ----------

const META = /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,3}[.)]?|lyrics?\s*[:-].*|.*\blyrics\.?|\[.*\]|(verse|chorus|pre-?chorus|bridge|refrain|intro|outro|tag|vamp)\s*\d*\s*:?)$/i;

function build(list, lines) {
  const used = new Set();
  const items = [];
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

  for (const it of list) {
    if (it.kind === 'section') {
      const title = cleanTitle(it.title);
      if (title) items.push({ kind: 'section', title: capitalise(title), author: '', parts: [] });
      continue;
    }
    const parts = [];
    for (const p of Array.isArray(it.parts) ? it.parts : []) {
      const from = Math.max(1, Math.floor(+p.from));
      const to = Math.min(lines.length, Math.floor(+p.to));
      if (!(from <= to)) continue;
      const label = cleanLabel(p.label);
      // blank or label lines inside a range split it into separate parts
      let cur = null;
      for (let n = from; n <= to; n++) {
        const text = lines[n - 1];
        if (!text || isLabelLine(text) || used.has(n)) {
          cur = null;
          continue;
        }
        used.add(n);
        if (!cur) parts.push((cur = { label, lines: [], at: n }));
        cur.lines.push(text);
      }
    }
    let title = cleanTitle(str(it.title)).replace(/\s+lyrics$/i, '');
    if (!parts.length && !title) continue;
    items.push({ kind: 'song', title, author: cleanTitle(str(it.author)), parts });
  }

  // Lyric-looking lines the model did not place: attach each block to the
  // song it sits in, or make it a song of its own if a song number or
  // heading separates it from the previous song.
  const headings = new Set(items.map((it) => it.title.toLowerCase()));
  const isHeading = (l) => {
    const t = cleanTitle(l).toLowerCase();
    return headings.has(t) || headings.has(t.replace(/\s+by\s+.*$/, '')) || headings.has(t.replace(/\s+lyrics$/, ''));
  };
  // short ALL-CAPS lines are headings, not lyrics
  const isCapsHeading = (l) => /\p{Lu}/u.test(l) && !/\p{Ll}/u.test(l) && l.split(/\s+/).length <= 4;
  const isBoundary = (l) => !!l && (/^\d{1,3}[.)]?$/.test(l) || /^lyrics?\s*[:-]/i.test(l) || isHeading(l) || isCapsHeading(l));
  const isLyric = (l) => !!l && !META.test(l) && !isLabelLine(l) && !isHeading(l) && !isCapsHeading(l);
  let lyric = 0;
  let placed = 0;
  lines.forEach((l, i) => {
    if (!isLyric(l)) return;
    lyric++;
    if (used.has(i + 1)) placed++;
  });

  const lastLine = (song) => Math.max(...song.parts.map((p) => p.at + p.lines.length - 1));
  let block = null;
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!isLyric(l) || used.has(n)) {
      block = null;
      return;
    }
    if (!block) {
      block = { label: '', lines: [], at: n };
      let ownerIndex = -1;
      let nextIndex = -1;
      items.forEach((it, k) => {
        if (it.kind !== 'song' || !it.parts.length) return;
        if (it.parts[0].at < n) ownerIndex = k;
        else if (nextIndex < 0) nextIndex = k;
      });
      const owner = items[ownerIndex];
      const next = items[nextIndex];
      if (owner && !lines.slice(lastLine(owner), n - 1).some(isBoundary)) {
        owner.parts.push(block); // continues the previous song
      } else if (next && !lines.slice(n, next.parts[0].at - 1).some(isBoundary)) {
        next.parts.push(block); // first lines of the next song
      } else {
        items.splice(ownerIndex + 1, 0, { kind: 'song', title: '', author: '', parts: [block] });
      }
    }
    block.lines.push(l);
  });

  for (const it of items) {
    if (it.kind !== 'song') continue;
    it.parts.sort((a, b) => a.at - b.at);
    it.parts = it.parts
      .map((p) => ({ label: p.label, lines: p.lines.map(cleanLine).filter(Boolean) }))
      .filter((p) => p.lines.length);
    // title only (lyrics not in the document): one slide with the title
    if (!it.parts.length) it.parts.push({ label: '', lines: [capitalise(it.title)] });
    it.title = titleCase(it.title || cleanTitle(it.parts[0].lines[0]));
  }
  return { items, coverage: lyric ? placed / lyric : 1 };
}

function isLabelLine(l) {
  return /^(\[.*\]|(verse|chorus|pre-?chorus|bridge|refrain|intro|outro|tag|vamp)\s*\d*\s*:?)$/i.test(l.trim());
}

// ---------- text clean-up ----------

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
  return capitalise(String(line).replace(REPEAT, ' ').replace(/\s+/g, ' ').replace(/([([])\s+/g, '$1').replace(/\s+([)\]])/g, '$1').trim());
}

function cleanLabel(label) {
  const l = String(label || '').replace(/[[\]():]/g, '').replace(/\s+/g, ' ').trim();
  if (!l) return '';
  const m = l.toLowerCase().match(/^(.*?)\s*(\d+)?$/);
  const base = LABELS[m[1]] || (m[1] === 'verse' ? 'Verse' : null);
  if (base) return m[2] ? base + ' ' + m[2] : base === 'Verse' ? 'Verse 1' : base;
  return l.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

// Capitalise each word, leaving the rest of the word as written.
function titleCase(t) {
  return String(t).replace(/(^|[\s(\-"\u201C])(\p{Ll})/gu, (_, a, b) => a + b.toUpperCase());
}

function cleanTitle(t) {
  t = String(t || '').replace(/\s+/g, ' ').replace(/[\s,;:.!]+$/, '').trim();
  // ALL-CAPS -> Title Case
  if (/\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t)) t = t.toLowerCase().replace(/(^|[\s(\-'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  return t;
}

export const _test = { build, capitalise };
