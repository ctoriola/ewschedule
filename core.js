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

  function parseLines(lines) {
    var songs = [];
    var song = null;
    var stanza = [];

    function flushStanza() {
      if (song && stanza.length) song.stanzas.push(stanza);
      stanza = [];
    }
    function flushSong() {
      flushStanza();
      if (song && song.stanzas.length) songs.push(song);
      song = null;
    }
    function startSong(title, author) {
      flushSong();
      song = { title: title || '', author: author || '', stanzas: [] };
    }
    function hasContent() { return song && (song.stanzas.length || stanza.length); }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var next = lines[i + 1] || '';
      if (!line) { flushStanza(); continue; }
      if (DATE.test(line)) continue;
      if (SECTIONS.test(line)) { flushSong(); continue; }

      var m = line.match(LYRICS);
      if (m) {
        var parts = m[1].split(/\s+by\s+/i);
        var author = parts.length > 1 ? parts.pop() : '';
        var title = cleanTitle(parts.join(' by '));
        if (song && !hasContent()) { song.title = title; song.author = author; }
        else startSong(title, author);
        continue;
      }

      m = line.match(NUMBER);
      if (m && (!m[2] || /^[A-Za-z(]/.test(m[2]))) {
        startSong('', '');
        if (m[2]) stanza.push(m[2]);
        continue;
      }

      if (LABEL.test(line)) { flushStanza(); continue; }

      // ALL-CAPS line standing alone -> title of a new song
      if (isTitleCaps(line) && !next && (!song || hasContent() || !song.title)) {
        if (song && !hasContent()) song.title = cleanTitle(titleCase(line));
        else startSong(cleanTitle(titleCase(line)), '');
        continue;
      }

      if (!song) startSong('', '');
      stanza.push(line);
    }
    flushSong();

    songs.forEach(function (s) {
      if (!s.title) s.title = shortTitle(s.stanzas[0][0]);
    });
    return songs;
  }

  function shortTitle(line) {
    var t = cleanTitle(line);
    if (t.length <= 48) return t;
    return cleanTitle(t.slice(0, 48).replace(/\s+\S*$/, ''));
  }

  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s(\-'])([a-z])/g, function (_, a, b) { return a + b.toUpperCase(); });
  }

  // song <-> editable text (blank line between stanzas)
  function stanzasToText(stanzas) {
    return stanzas.map(function (s) { return s.join('\n'); }).join('\n\n');
  }
  function textToStanzas(text) {
    return text.split(/\n\s*\n/).map(function (b) {
      return b.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    }).filter(function (s) { return s.length; });
  }

  function toSlides(stanzas, perSlide) {
    var slides = [];
    stanzas.forEach(function (st) {
      for (var i = 0; i < st.length; i += perSlide) slides.push(st.slice(i, i + perSlide));
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

  // songs: [{title, author, slides: [[line, line], ...]}]
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
    stanzasToText: stanzasToText, textToStanzas: textToStanzas, toSlides: toSlides,
    slideRtf: slideRtf, buildDatabase: buildDatabase, buildEwsx: buildEwsx
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EWCore = api;
})(this);
