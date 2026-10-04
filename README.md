# Lyrics → EasyWorship

Upload a `.docx` of song lyrics in any layout and download an EasyWorship 7 schedule (`.ewsx`).

- **AI clean-up** (`api/structure.js`): Claude sorts the document into title slides (Praise, Worship, Special Songs…) and songs, labels verses / choruses / bridges, and tidies the text without changing the lyrics. If AI is off or unavailable, a rule-based parser is used instead.
- **Review**: edit titles and lyrics, drag to reorder the schedule, add title slides or songs, and preview every slide.
- **Slides**: 2 lines per slide by default; long lines get their own slide, and a `(translation)` line stays with the line it translates.

## Files

- `index.html` – the app
- `core.js` – docx text extraction, rule-based parser, slide splitting and `.ewsx` generation
- `api/structure.js` – Vercel serverless function that calls the Claude API
- `template.db` – EasyWorship schedule database used as the layout/theme template

A `.ewsx` is a zip containing `main.db` (SQLite). The generator clones the template song's slide structure for each new slide.

## Deploying (Vercel)

1. Import the repo into Vercel (no build step needed).
2. Add an environment variable `ANTHROPIC_API_KEY` with your Claude API key.

Without the key the app still works, using the rule-based parser.

Only the extracted text of the document is sent to the API; the `.ewsx` is built in the browser.
