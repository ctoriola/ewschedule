// Second-opinion check of the Groq result using Google Gemini with Google
// Search. Gemini identifies each song (official title and artist), fixes part
// labels and flags songs that were split in two. It never changes lyric text:
// it only returns titles, artists, labels and merge flags, which are applied
// in code. (Files starting with "_" are not deployed as API routes.)

import { geminiJson, parseJson } from './_gemini.js';

const JUDGE_SYSTEM = `You check the running order of a church service lyrics document before it is projected in EasyWorship. Another AI already split the document into section title slides and songs, and labelled each song's parts. You review that work and identify the songs.

You receive the songs numbered #1, #2, ... with their current title, artist and parts. Each part shows its label in brackets followed by its lyric lines.

For EVERY song:
1. Identify the song. Use Google Search with one or two distinctive lyric lines in quotes (plus words like "lyrics" or "gospel song") to find which published song these lyrics are from. Many are Nigerian or African gospel songs, often in Pidgin, Yoruba, Igbo, Hausa or Efik, as well as international worship songs.
   - If you find it with confidence (the search results show these lyrics under that title), give the official song title and the main artist, spelled as the artist publishes it.
   - If it is a traditional or congregational chorus with no clear single artist, give its commonly used title and artist "".
   - If you cannot identify it, keep the current title (clean it up: Title Case, no "Lyrics", no trailing punctuation) and keep the current artist.
   - The document's own heading is a strong hint; only replace it when the search clearly shows the correct name. Never invent an artist.
2. Check the part labels. Return exactly one label per part, in the same order and the same count as given. Allowed: "Verse 1", "Verse 2", ..., "Chorus", "Pre-Chorus", "Bridge" (or numbered), "Refrain" (or numbered), "Intro", "Outro", "Tag", "Vamp", "Call & Response", or "" for a single-part song. A part whose lines repeat elsewhere in the song, or the song's main hook, is "Chorus" every time it appears. Number verses in order. Keep labels that are already right, including numbered ones from the document.
3. Set "merge_with_previous": true only if this song is clearly the continuation of the song right before it (the same song wrongly split in two). Otherwise false.

Reply with only JSON, no other text:
{"songs":[{"n":1,"title":"...","artist":"...","labels":["Verse 1","Chorus"],"merge_with_previous":false,"identified":true}]}
Include every song number exactly once. "identified" is true only when you confirmed the song through search.`;

function render(items) {
  const out = [];
  let n = 0;
  for (const it of items) {
    if (it.kind === 'section') {
      out.push('== Section: ' + it.title);
      continue;
    }
    n++;
    out.push('#' + n + ' title="' + it.title + '" artist="' + (it.author || '') + '"');
    for (const p of it.parts) {
      out.push('  [' + (p.label || '') + ']');
      for (const l of p.lines) out.push('    ' + l);
    }
  }
  return out.join('\n');
}

async function askGemini(items) {
  const parsed = await geminiJson(JUDGE_SYSTEM, render(items));
  if (!Array.isArray(parsed.songs)) throw new Error('Gemini reply has no songs list');
  return parsed.songs;
}

// Apply the judge's verdicts. helpers: { cleanLabel, cleanTitle, titleCase }
function apply(items, verdicts, helpers) {
  const songs = items.filter((it) => it.kind === 'song');
  const byN = new Map();
  for (const v of verdicts) if (v && Number.isInteger(+v.n)) byN.set(+v.n, v);
  let changed = 0;

  songs.forEach((song, i) => {
    const v = byN.get(i + 1);
    if (!v) return;
    const title = helpers.titleCase(helpers.cleanTitle(String(v.title || '')).replace(/\s+lyrics$/i, ''));
    if (title && title !== song.title) {
      song.title = title;
      changed++;
    }
    if (typeof v.artist === 'string') {
      const artist = helpers.cleanTitle(v.artist);
      // only take an artist the judge actually confirmed, or keep the document's
      if (artist && v.identified && artist !== song.author) {
        song.author = artist;
        changed++;
      }
    }
    if (Array.isArray(v.labels) && v.labels.length === song.parts.length) {
      v.labels.forEach((l, k) => {
        const label = helpers.cleanLabel(l);
        if (label !== song.parts[k].label) {
          song.parts[k].label = label;
          changed++;
        }
      });
    }
    song.merge = v.merge_with_previous === true;
  });

  // merge songs flagged as continuations into the song before them
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.kind === 'song' && it.merge && prev && prev.kind === 'song') {
      prev.parts.push(...it.parts);
      changed++;
      continue;
    }
    delete it.merge;
    out.push(it);
  }
  for (const it of out) delete it.merge;
  return { items: out, changed };
}

export async function judge(items, helpers) {
  if (!process.env.GEMINI_API_KEY || !items.some((it) => it.kind === 'song')) {
    return { items, checked: false };
  }
  try {
    const verdicts = await askGemini(items);
    const { items: fixed, changed } = apply(items, verdicts, helpers);
    const identified = verdicts.filter((v) => v && v.identified).length;
    return { items: fixed, checked: true, changed, identified };
  } catch (err) {
    console.error('Judge failed:', err.message);
    return { items, checked: false, judgeError: err.message.slice(0, 300) };
  }
}

export const _test = { render, apply, parseJson };
