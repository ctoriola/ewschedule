/* Lyrics .docx -> EasyWorship 7 schedule (.ewsx) conversion.
   Works in the browser (window.EWCore) and in Node (module.exports). */
(function (root) {
  'use strict';

  // ---------- DOCX -> lines ----------

  function decodeXml(s) {
    return s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(+d); })
      .replace(/&amp;/g, '&');
  }

  // document.xml -> array of text lines (one per paragraph / soft line break)
  function docxXmlToLines(xml) {
    var body = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');
    var paras = body.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) || [];
    var lines = [];
    paras.forEach(function (p) {
      var text = '';
      var re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(br|cr)\b[^>]*\/>|<w:tab\/>/g, m;
      while ((m = re.exec(p))) {
        if (m[1] !== undefined) text += decodeXml(m[1]);
        else if (m[2]) text += '\n';
        else text += ' ';
      }
      text.split('\n').forEach(function (l) { lines.push(l.replace(/\s+/g, ' ').trim()); });
    });
    return lines;
  }

  // ---------- lines -> songs ----------

  var SECTIONS = /^(praise|praises|worship|ministration|thanksgiving|offering|opening|closing|special number|hymns?|choruses|songs?|altar call|response|communion|praise and worship|praise & worship)\s*:?$/i;
  var LABEL = /^(\[.*\]|\(?(verse|chorus|pre[- ]?chorus|bridge|refrain|outro|intro|tag|hook|vamp|interlude|ending|response|call)\s*\d*\s*\)?\s*:?)$/i;
  var DATE = /^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/;
  var NUMBER = /^(\d{1,3})[.)]\s*(.*)$/;
  var LYRICS = /^lyrics?\s*[:\-]\s*(.+)$/i;

  function isTitleCaps(line) {
    return /[A-Z]/.test(line) && !/[a-z]/.test(line) && line.split(' ').length <= 6 && line.length <= 50;
  }

  function cleanTitle(t) {
    return t.replace(/[\s,;:.!]+$/, '').trim();
  }

  // Rule-based fallback for when AI clean-up is unavailable.
  // Returns items: [{kind: 'section'|'song', title, author, parts: [{label, lines}]}]
  function parseLines(lines) {
    var items = [];
    var song = null;
    var part = null;
    var pendingLabel = '';

    function flushPart() {
      if (song && part && part.lines.length) song.parts.push(part);
      part = null;
    }
    function flushSong() {
      flushPart();
      if (song && song.parts.length) items.push(song);
      song = null;
      pendingLabel = '';
    }
    function startSong(title, author) {
      flushSong();
      song = { kind: 'song', title: title || '', author: author || '', parts: [] };
    }
    function hasContent() { return song && (song.parts.length || (part && part.lines.length)); }
    function push(line) {
      if (!song) startSong('', '');
      if (!part) { part = { label: pendingLabel, lines: [] }; pendingLabel = ''; }
      part.lines.push(line);
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var next = lines[i + 1] || '';
      if (!line) { flushPart(); continue; }
      if (DATE.test(line)) continue;
      if (SECTIONS.test(line)) {
        flushSong();
        items.push({ kind: 'section', title: cleanTitle(titleCase(line)), author: '', parts: [] });
        continue;
      }

      var m = line.match(LYRICS);
      if (m) {
        var bits = m[1].split(/\s+by\s+/i);
        var author = bits.length > 1 ? bits.pop() : '';
        var title = cleanTitle(bits.join(' by '));
        if (song && !hasContent()) { song.title = title; song.author = author; }
        else startSong(title, author);
        continue;
      }

      m = line.match(NUMBER);
      if (m && (!m[2] || /^[A-Za-z(]/.test(m[2]))) {
        startSong('', '');
        if (m[2]) push(m[2]);
        continue;
      }

      if (LABEL.test(line)) {
        flushPart();
        pendingLabel = cleanTitle(titleCase(line.replace(/^[\[(]|[\])]$/g, '').replace(/:$/, '')));
        continue;
      }

      // ALL-CAPS line standing alone -> title of a new song
      if (isTitleCaps(line) && !next && (!song || hasContent() || !song.title)) {
        if (song && !hasContent()) song.title = cleanTitle(titleCase(line));
        else startSong(cleanTitle(titleCase(line)), '');
        continue;
      }

      push(line);
    }
    flushSong();

    items.forEach(function (s) {
      if (s.kind === 'song' && !s.title) s.title = shortTitle(s.parts[0].lines[0]);
    });
    return items;
  }

  function shortTitle(line) {
    var t = cleanTitle(line);
    if (t.length <= 48) return t;
    return cleanTitle(t.slice(0, 48).replace(/\s+\S*$/, ''));
  }

  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s(\-'])([a-z])/g, function (_, a, b) { return a + b.toUpperCase(); });
  }

  // Song parts <-> editable text. "[Label]" lines name a part; blank lines split parts.
  function partsToText(parts) {
    return parts.map(function (p) {
      return (p.label ? '[' + p.label + ']\n' : '') + p.lines.join('\n');
    }).join('\n\n');
  }
  function textToParts(text) {
    var parts = [], part = null;
    text.split('\n').forEach(function (raw) {
      var line = raw.trim();
      var m = line.match(/^\[(.+)\]$/);
      if (!line) { if (part && part.lines.length) parts.push(part); part = null; return; }
      if (m) {
        if (part && part.lines.length) parts.push(part);
        part = { label: m[1].trim(), lines: [] };
        return;
      }
      if (!part) part = { label: '', lines: [] };
      part.lines.push(line);
    });
    if (part && part.lines.length) parts.push(part);
    return parts;
  }

  // Plain lyrics (blank line between stanzas) -> labelled parts. A stanza that
  // appears more than once is the Chorus; the others are numbered verses.
  function lyricsToParts(text) {
    var blocks = String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map(function (b) {
      return b.split('\n').map(function (l) { return l.trim(); }).filter(function (l) {
        return l && !/^\[.*\]$/.test(l) && !/^\(?(verse|chorus|bridge|pre-?chorus|refrain|intro|outro|tag)\s*\d*\)?:?$/i.test(l);
      });
    }).filter(function (b) { return b.length; });
    if (blocks.length === 1) return [{ label: '', lines: blocks[0] }];
    var key = function (b) { return b.join(' ').toLowerCase().replace(/[^a-z0-9À-￿]+/g, ' ').trim(); };
    var counts = {};
    blocks.forEach(function (b) { counts[key(b)] = (counts[key(b)] || 0) + 1; });
    var verse = 0;
    return blocks.map(function (b) {
      return { label: counts[key(b)] > 1 ? 'Chorus' : 'Verse ' + (++verse), lines: b };
    });
  }

  // Capitalise the first letter of a line (after any brackets/quotes or a
  // "Leader:"/"Choir:" prefix).
  function capitalise(line) {
    return line.replace(/^((?:leader|choir|all|congregation)\s*:\s*)?([^A-Za-z0-9\u00C0-\uFFFF]*)([a-z\u00DF-\u00FF\u0100-\u024F\u1E00-\u1EFF])/i,
      function (_, pre, lead, ch) { return (pre ? pre.charAt(0).toUpperCase() + pre.slice(1) : '') + lead + ch.toUpperCase(); });
  }

  // Split parts into slides of up to perSlide lines. A "(translation)" line
  // stays on the same slide as the line before it, and any line longer than
  // maxChars gets a slide to itself (with its translation, if any).
  function toSlides(parts, perSlide, maxChars) {
    var slides = [];
    maxChars = maxChars || Infinity;
    parts.forEach(function (p) {
      var units = [];
      p.lines.map(capitalise).forEach(function (line) {
        var prev = units[units.length - 1];
        if (/^\(.*\)$/.test(line) && prev && prev.lines.length === 1 && !/^\(.*\)$/.test(prev.lines[0])) {
          prev.lines.push(line);
        } else {
          units.push({ lines: [line], long: line.length > maxChars });
        }
      });
      var cur = [], curLong = false;
      units.forEach(function (u) {
        var size = Math.max(perSlide, u.lines.length);
        if (cur.length && (u.long || curLong || cur.length + u.lines.length > size)) {
          slides.push({ label: p.label, lines: cur });
          cur = []; curLong = false;
        }
        cur = cur.concat(u.lines);
        curLong = curLong || u.long;
      });
      if (cur.length) slides.push({ label: p.label, lines: cur });
    });
    return slides;
  }

  // ---------- EasyWorship database ----------

  function rtfEscape(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i], c = s.charCodeAt(i);
      if (ch === '\\' || ch === '{' || ch === '}') out += '\\' + ch;
      else if (c < 128) out += ch;
      else out += '\\u' + (c > 32767 ? c - 65536 : c) + '?';
    }
    return out;
  }

  function slideRtf(lines) {
    var fs = '\\fs146{\\*\\sdfsreal 72.9000015258789}{\\*\\sdfsdef 72.9000015258789}\\sdfsauto ';
    var paras = lines.map(function (l, i) {
      var head = i === 0
        ? '{\\pard\\sdlistlevel0\\qc\\qdef\\sdewparatemplatestyle101{\\*\\sdasfactor 1}{\\*\\sdasbaseline 72.9000015258789}\\sdastextstyle101\\plain\\sdewtemplatestyle101'
        : '{\\pard\\qc\\qdef\\sdewparatemplatestyle101{\\*\\sdasfactor 0}\\plain\\sdewtemplatestyle101';
      return head + fs + rtfEscape(l) + '\\par}';
    });
    return '{\\rtf1\\ansi\\deff0\\sdeasyworship2\r\n{\\fonttbl{\\f0 Tahoma;}}\r\n{\\colortbl ;}\r\n' + paras.join('\r\n') + '\r\n}';
  }

  function uid() {
    var h = '0123456789ABCDEF', s = '';
    for (var i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
    return '1-' + s.slice(0, 8) + '-' + s.slice(8, 12) + '-4' + s.slice(13, 16) + '-' +
      h[8 + Math.floor(Math.random() * 4)] + s.slice(17, 20) + '-' + s.slice(20, 32);
  }
  function hash32() { return (Math.random() * 4294967296 | 0); }

  var TPL_PRES = 1, TPL_SLIDE = 2;
  var NOW_FILETIME = "CAST((julianday('now') - 2305813.5) * 864000000000 AS INTEGER)";

  // presentations: [{title, author, slides: [[line, line], ...]}]
  function buildDatabase(SQL, templateBytes, songs) {
    var db = new SQL.Database(templateBytes);
    var cols = {};
    function columns(t) {
      if (!cols[t]) cols[t] = db.exec('PRAGMA table_info("' + t + '")')[0].values.map(function (r) { return r[1]; });
      return cols[t];
    }
    var next = {};
    function newId(t) {
      if (next[t] === undefined) next[t] = (db.exec('SELECT IFNULL(MAX(rowid),0) FROM "' + t + '"')[0].values[0][0]) + 1;
      return next[t]++;
    }
    // copy a row, overriding some columns (value or {sql: expr}); big ints stay inside SQLite
    function clone(t, srcId, over) {
      var id = newId(t), params = [];
      over = Object.assign({ rowid: id }, over);
      var names = columns(t);
      var sel = names.map(function (c) {
        if (!(c in over)) return '"' + c + '"';
        var v = over[c];
        if (v && typeof v === 'object' && 'sql' in v) return v.sql;
        params.push(v); return '?';
      });
      params.push(srcId);
      db.run('INSERT INTO "' + t + '" (' + names.map(function (c) { return '"' + c + '"'; }).join(',') +
        ') SELECT ' + sel.join(',') + ' FROM "' + t + '" WHERE rowid=?', params);
      return id;
    }
    function rows(q, p) {
      var r = db.exec(q, p)[0];
      return r ? r.values : [];
    }

    var tplElements = rows('SELECT rowid, element_uid, background_resource_id, foreground_resource_id, shape_resource_id FROM element WHERE slide_id=? ORDER BY order_index', [TPL_SLIDE]);

    function cloneResource(resId, rtf) {
      if (!resId) return null;
      var nid = clone('resource', resId, { resource_uid: uid(), resource_hash: hash32() });
      rows('SELECT rowid FROM resource_text WHERE resource_id=?', [resId]).forEach(function (r) {
        clone('resource_text', r[0], rtf != null ? { resource_id: nid, rtf: rtf } : { resource_id: nid });
      });
      rows('SELECT rowid FROM resource_shape WHERE resource_id=?', [resId]).forEach(function (r) {
        clone('resource_shape', r[0], { resource_id: nid });
      });
      return nid;
    }

    db.run('BEGIN');
    songs.forEach(function (song, si) {
      var pid = clone('presentation', TPL_PRES, {
        presentation_uid: uid(), presentation_rev_uid: uid(), order_index: si,
        title: song.title, author: song.author || '', modified_date: { sql: NOW_FILETIME }, thumbnail: null
      });
      song.slides.forEach(function (lines, idx) {
        var sid = clone('slide', TPL_SLIDE, { presentation_id: pid, slide_uid: uid(), order_index: idx, thumbnail: null });
        tplElements.forEach(function (e) {
          var isLyrics = e[1] === 'CONTENT_SONG';
          var eid = clone('element', e[0], {
            slide_id: sid,
            background_resource_id: cloneResource(e[2]),
            foreground_resource_id: cloneResource(e[3], isLyrics ? slideRtf(lines) : null),
            shape_resource_id: cloneResource(e[4])
          });
          rows('SELECT rowid FROM element_property_group WHERE link_id=?', [e[0]]).forEach(function (g) {
            var gid = clone('element_property_group', g[0], { link_id: eid });
            rows('SELECT rowid FROM element_property WHERE group_id=?', [g[0]]).forEach(function (p) {
              clone('element_property', p[0], { group_id: gid });
            });
          });
        });
      });
    });

    // remove the template song
    var tplEls = 'SELECT rowid FROM element WHERE slide_id=' + TPL_SLIDE;
    var tplRes = 'SELECT background_resource_id FROM element WHERE slide_id=' + TPL_SLIDE +
      ' UNION SELECT foreground_resource_id FROM element WHERE slide_id=' + TPL_SLIDE +
      ' UNION SELECT shape_resource_id FROM element WHERE slide_id=' + TPL_SLIDE;
    db.run('DELETE FROM element_property WHERE group_id IN (SELECT rowid FROM element_property_group WHERE link_id IN (' + tplEls + '))');
    db.run('DELETE FROM element_property_group WHERE link_id IN (' + tplEls + ')');
    db.run('DELETE FROM resource_text WHERE resource_id IN (' + tplRes + ')');
    db.run('DELETE FROM resource_shape WHERE resource_id IN (' + tplRes + ')');
    db.run('DELETE FROM resource WHERE rowid IN (' + tplRes + ')');
    db.run('DELETE FROM element WHERE slide_id=' + TPL_SLIDE);
    db.run('DELETE FROM slide WHERE rowid=' + TPL_SLIDE);
    db.run('DELETE FROM presentation WHERE rowid=' + TPL_PRES);
    db.run("UPDATE sqlite_sequence SET seq=(SELECT MAX(rowid) FROM presentation) WHERE name='presentation'");
    db.run("UPDATE sqlite_sequence SET seq=(SELECT MAX(rowid) FROM slide) WHERE name='slide'");
    db.run('COMMIT');

    var out = db.export();
    db.close();
    return out;
  }

  // Package main.db the same way EasyWorship does (zip: main.db + empty media entry)
  function buildEwsx(JSZip, dbBytes) {
    var zip = new JSZip();
    zip.file('main.db', dbBytes);
    zip.file('media', '');
    return zip;
  }

  var api = {
    docxXmlToLines: docxXmlToLines, parseLines: parseLines,
    partsToText: partsToText, capitalise: capitalise, lyricsToParts: lyricsToParts, textToParts: textToParts, toSlides: toSlides,
    slideRtf: slideRtf, buildDatabase: buildDatabase, buildEwsx: buildEwsx
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EWCore = api;
})(typeof window !== "undefined" ? window : globalThis);
