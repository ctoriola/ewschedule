# Lyrics → EasyWorship

Upload a `.docx` of song lyrics and download an EasyWorship 7 schedule (`.ewsx`), split two lines per slide (configurable). Everything runs in the browser; files never leave the device.

- `index.html` – the page (upload, review/edit songs, slide preview, download)
- `core.js` – docx parsing, song splitting and `.ewsx` generation (also usable from Node)
- `template.db` – an EasyWorship schedule database used as the layout/theme template

A `.ewsx` is a zip containing `main.db` (SQLite). The generator clones the template song's slide structure for each new slide.

Serve the folder with any static host (e.g. `python3 -m http.server`) — `template.db` is loaded with `fetch`, so opening the file directly won't work.
