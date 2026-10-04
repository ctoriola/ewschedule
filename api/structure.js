// POST /api/structure  { lines: string[] }  ->  { items: [...] }
// Uses Claude to turn the raw text of a lyrics document into a structured
// running order: section title slides plus songs split into labelled parts.
import Anthropic from '@anthropic-ai/sdk';

const MAX_CHARS = 60000;

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

const SYSTEM = `You prepare church service lyric documents for projection in EasyWorship.
You receive the text of a document, one paragraph per line. Documents vary a lot: numbered or unnumbered songs, "Lyrics: Title by Artist" headers, ALL-CAPS titles, verse labels in brackets or not, translations in parentheses, leader/choir call-and-response, dates and other notes.

Return the running order as items, in document order:

- kind "section": a heading that groups songs in the service, such as Praise, Worship, Special Song(s), Ministration, Thanksgiving, Offering, Hymn, Altar Call. Give it a clean Title Case title (e.g. "PRAISE" -> "Praise"). It becomes a title slide. Leave author empty and parts empty.
- kind "song": one song. title = the song's name (from a header if given, otherwise a short title from its first line, without trailing punctuation). author = the artist if stated, else "". parts = the song's verses/choruses in order.

For each part:
- label: "Verse 1", "Verse 2", "Chorus", "Pre-Chorus", "Bridge", "Refrain", "Tag", "Outro", "Intro", "Call & Response" etc. Use labels written in the document when present. When unlabelled, infer them: a block that repeats or is the song's hook is the Chorus; other blocks are numbered verses; a contrasting block late in the song is the Bridge. Use "" only when no label makes sense (e.g. a one-block song).
- lines: the lyric lines of that block, exactly one sung line per entry.

Cleaning rules:
- Keep the lyrics' words, spelling and language exactly as written, including Nigerian Pidgin, Yoruba, Igbo, Hausa, Efik and other languages. Never translate, paraphrase, reorder or "correct" non-English words or deliberate informal spelling.
- You may fix only: stray spaces, doubled punctuation, and obvious English typos.
- Keep translations in parentheses as their own line directly after the line they translate.
- Keep "Leader:" / "Choir:" prefixes.
- Drop things that are not lyrics: dates, the "Lyrics:" header itself, song numbers like "2.", label lines (they become the part label), and repetition notes such as "x3" or "[3x]" at the end of a line (remove the marker; keep the line once).
- If a line is very long and clearly two sung phrases joined together, you may split it into two lines at the natural break.
- Do not invent content and do not drop any lyric line.`;

const client = new Anthropic();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
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

  try {
    const stream = client.beta.messages.stream({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: '<document>\n' + text + '\n</document>' }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      res.status(422).json({ error: 'The AI declined to process this document.' });
      return;
    }
    if (message.stop_reason === 'max_tokens') {
      res.status(413).json({ error: 'That document is too long for AI clean-up.' });
      return;
    }
    const block = message.content.find((b) => b.type === 'text');
    const data = JSON.parse(block.text);
    res.status(200).json(data);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: 'The AI is busy right now. Try again in a minute.' });
    } else if (err instanceof Anthropic.APIError) {
      res.status(502).json({ error: 'The AI service returned an error (' + err.status + ').' });
    } else {
      res.status(500).json({ error: 'AI clean-up failed.' });
    }
  }
}
