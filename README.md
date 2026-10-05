# Lyrics → EasyWorship

Upload a `.docx` of song lyrics in any layout and download an EasyWorship 7 schedule (`.ewsx`).

- **AI clean-up** (`api/structure.js`): an LLM on Groq (`openai/gpt-oss-120b` by default) sorts the document into title slides (Praise, Worship, Special Songs…) and songs, labels verses / choruses / bridges, and tidies the text without changing the lyrics. If AI is off or unavailable, a rule-based parser is used instead.
- **AI check** (`api/_judge.js`): Google Gemini, with Google Search, reviews the result: it looks songs up by their lyrics to set the official title and artist, fixes part labels (e.g. repeated blocks become Chorus) and re-joins songs that were split. It never changes lyric text. If Gemini is unavailable, the first result is used unchanged.
- **Song search** (`api/song.js`): find a song by title, artist or a remembered line and add it to the schedule. Lyrics come from LRCLIB (free open lyrics database); Gemini with Google Search identifies songs from a lyric line and looks up lyrics LRCLIB lacks. Search and docx uploads can be combined in any order; uploads add to the schedule.
- **Review**: edit titles and lyrics, drag to reorder the schedule, add title slides or songs, and preview every slide.
- **Slides**: 2 lines per slide by default; long lines get their own slide, and a `(translation)` line stays with the line it translates.

## Files

- `index.html` – the app
- `core.js` – docx text extraction, rule-based parser, slide splitting and `.ewsx` generation
- `api/structure.js` – Vercel serverless function that calls the Groq API
- `api/_judge.js` – the Gemini check, used by `api/structure.js`
- `api/song.js` – song search and lyrics lookup
- `api/_gemini.js` – shared Gemini (Google Search) call
- `template.db` – EasyWorship schedule database used as the layout/theme template

A `.ewsx` is a zip containing `main.db` (SQLite). The generator clones the template song's slide structure for each new slide.

## Deploying (Vercel)

1. Import the repo into Vercel (no build step needed).
2. Add an environment variable `GROQ_API_KEY` with your Groq API key (from console.groq.com). Optionally set `GROQ_MODEL`, `GROQ_REASONING` (low/medium/high) and `GROQ_TPM` (your plan's tokens-per-minute limit).
3. Optional: add `GENIUS_ACCESS_TOKEN` (free, from genius.com/api-clients → "Generate Access Token") so song search can find songs from a remembered lyric line.
4. Add `GEMINI_API_KEY` (from aistudio.google.com) to turn on the AI check. Optionally set `GEMINI_MODEL` (default `gemini-3.5-flash`).

Without the key the app still works, using the rule-based parser.

Only the extracted text of the document is sent to the API; the `.ewsx` is built in the browser.
