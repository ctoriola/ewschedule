// Song search for adding songs to the schedule by title or by a lyric line.
//
// POST /api/song { q }                    -> { results: [{ title, artist, lyrics, source }] }
// POST /api/song { title, artist, fetch } -> { title, artist, lyrics, source }
//
// Lyrics come from LRCLIB (lrclib.net, a free open lyrics database). Gemini
// with Google Search identifies songs from a remembered line, and is the
// fallback source for lyrics LRCLIB does not have (mostly local gospel songs).
// lyrics is plain text with blank lines between stanzas, or null.
import { geminiJson } from './_gemini.js';

const LRCLIB = 'https://lrclib.net/api';
const UA = 'ewschedule (https://github.com/ctoriola/ewschedule)';

const IDENTIFY_SYSTEM = `You help a church media team find songs. The user types a song title, an artist, or a line they remember from the lyrics. Most are gospel or worship songs, many Nigerian or African, in English, Pidgin, Yoruba, Igbo, Hausa or Efik; the line may be misspelt or partly remembered.

How to search:
1. If the text looks like a lyric line, search Google for the exact words in quotes plus the word lyrics, e.g. "you are the living god o" lyrics. Also try a shorter distinctive part of the line in quotes, and the line without quotes.
2. If it looks like a title or artist, search for it plus the word lyrics.
3. Read the results and keep only songs whose published lyrics (or title) actually contain the user's words. The song's title often differs from the line (e.g. a line from the verse of "Ekwueme").

Reply with only JSON: {"matches":[{"title":"...","artist":"..."}]}
Up to 4 matches, best first, official title and main artist spelling. If nothing matches, return {"matches":[]}. Never invent songs or guess from the meaning of the words.`;

const LYRICS_SYSTEM = `You help a church media team that holds a licence to project song lyrics (e.g. CCLI). Use Google Search to find the full lyrics of the requested song as published on lyrics sites.
Reply with only JSON: {"title":"...","artist":"...","lyrics":"..."}
lyrics: the complete song text, one sung line per line, a blank line between verses/choruses, choruses written out each time they are sung on the page. No section labels, no notes. If you cannot find the actual lyrics, set "lyrics" to "" — never make up lyrics.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }
  const body = req.body || {};
  try {
    if (body.fetch) {
      const title = String(body.title || '').trim().slice(0, 200);
      const artist = String(body.artist || '').trim().slice(0, 200);
      if (!title) {
        res.status(400).json({ error: 'No song title given.' });
        return;
      }
      res.status(200).json(await getLyrics(title, artist));
      return;
    }
    const q = String(body.q || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (q.length < 2) {
      res.status(400).json({ error: 'Type a song title or a line from the song.' });
      return;
    }
    const results = await search(q);
    res.status(200).json({ results, model: lastModel || undefined, identifyError: results.identifyError || undefined });
  } catch (err) {
    console.error('song search failed', err);
    res.status(502).json({ error: 'Song search is not working right now. Try again shortly.' });
  }
}

// ---------- LRCLIB ----------

async function lrclib(params) {
  const r = await fetch(LRCLIB + '/search?' + new URLSearchParams(params), {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('LRCLIB ' + r.status);
  const list = await r.json();
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && x.plainLyrics && !x.instrumental)
    .map((x) => ({ title: x.trackName, artist: x.artistName, lyrics: x.plainLyrics.trim(), source: 'LRCLIB' }));
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function sameSong(a, b) {
  return norm(a.title) === norm(b.title) && (norm(a.artist).includes(norm(b.artist)) || norm(b.artist).includes(norm(a.artist)));
}

// best LRCLIB entry for a known title + artist
async function lrclibFor(title, artist) {
  let list = [];
  try {
    list = await lrclib(artist ? { track_name: title, artist_name: artist } : { track_name: title });
    if (!list.length && artist) list = await lrclib({ q: title + ' ' + artist });
  } catch {
    return null;
  }
  const t = norm(title);
  return list.find((x) => norm(x.title) === t && (!artist || sameSong(x, { title, artist })))
    || list.find((x) => norm(x.title) === t)
    || null;
}

// ---------- search ----------

async function search(q) {
  const [direct, identified] = await Promise.all([
    lrclib({ q }).catch(() => []),
    identify(q),
  ]);

  const results = [];
  const add = (r) => {
    if (results.length < 8 && !results.some((x) => sameSong(x, r))) results.push(r);
  };

  // Songs Gemini recognised (best for remembered lines), with LRCLIB lyrics when available
  const found = await Promise.all(identified.map((m) => lrclibFor(m.title, m.artist)));
  identified.forEach((m, i) => {
    const hit = found[i];
    add(hit ? { ...hit, title: m.title, artist: m.artist || hit.artist } : { title: m.title, artist: m.artist, lyrics: null, source: 'web' });
  });
  // Plain LRCLIB matches (title searches)
  direct.slice(0, 6).forEach(add);
  results.identifyError = lastIdentifyError;
  return results;
}

let lastIdentifyError = null;
let lastModel = null;

async function identify(q) {
  lastIdentifyError = null;
  if (!process.env.GEMINI_API_KEY) return [];
  try {
    const data = await geminiJson(IDENTIFY_SYSTEM, 'Find the song for: ' + q, { maxTokens: 4096 });
    lastModel = data._model;
    return (Array.isArray(data.matches) ? data.matches : [])
      .filter((m) => m && typeof m.title === 'string' && m.title.trim())
      .slice(0, 4)
      .map((m) => ({ title: m.title.trim(), artist: typeof m.artist === 'string' ? m.artist.trim() : '' }));
  } catch (err) {
    console.error('identify failed', err.message);
    lastIdentifyError = err.message.slice(0, 1500);
    return [];
  }
}

// ---------- lyrics for one song ----------

async function getLyrics(title, artist) {
  const hit = await lrclibFor(title, artist);
  if (hit) return { ...hit, title, artist: artist || hit.artist };

  if (process.env.GEMINI_API_KEY) {
    try {
      const data = await geminiJson(LYRICS_SYSTEM, 'Song: ' + title + (artist ? '\nArtist: ' + artist : ''));
      const lyrics = typeof data.lyrics === 'string' ? data.lyrics.trim() : '';
      if (lyrics.split('\n').filter((l) => l.trim()).length >= 2) {
        return { title, artist, lyrics, source: 'web' };
      }
    } catch (err) {
      console.error('lyrics lookup failed', err.message);
    }
  }
  return { title, artist, lyrics: null, source: null };
}
