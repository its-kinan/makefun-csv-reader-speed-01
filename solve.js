// Fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
// Written from the RULES.txt spec: same answers, much less work per byte.
//
// Strategy:
//  - Most records are plain lines: no quote anywhere, no stray CR. For those,
//    one slice + native split(',') parses the whole record, and the line
//    break is found with a single native indexOf('\n').
//  - Anything with a quote or a stray CR takes the slow path, which still
//    avoids per-character string building: unquoted fields are found with a
//    native regex search for the next delimiter, quoted fields with
//    indexOf('"') to find the closing quote, and quoted content is sliced
//    whole unless it needs "" -> " collapsing or CR/LF -> LF normalising.
//  - No allocation is done for fields that need no repair; error objects are
//    only built when an error actually occurs.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Unquoted field starting at pos, with `init` already in the value
  // (the opening quote of an unterminated field, or a quoted field's
  // value before its junk). Returns {value, ended, added}: added counts
  // the characters kept by this call (not those already in init).
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    for (;;) {
      // Next comma / LF, whichever is nearer (or the end of the text).
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      let end = n;
      let ended = END;
      if (ci !== -1 && (ni === -1 || ci < ni)) {
        end = ci;
        ended = COMMA;
      } else if (ni !== -1) {
        end = ni;
        ended = LINE_BREAK;
      }
      // A CR inside [pos, end): a CRLF line break when it sits right
      // before the LF, else a stray CR to drop (and keep scanning).
      let ri = -1;
      for (let i = pos; i < end; i++) {
        if (text.charCodeAt(i) === 13) {
          ri = i;
          break;
        }
      }
      if (ri !== -1 && text.charCodeAt(ri + 1) !== 10) {
        err('stray_cr');
        if (ri > pos) {
          value += text.slice(pos, ri);
          added += ri - pos;
        }
        pos = ri + 1;
        continue;
      }
      if (end > pos) {
        const stop = ri === -1 ? end : ri;
        value += text.slice(pos, stop);
        added += stop - pos;
      }
      if (ended === COMMA) pos = end + 1;
      else if (ended === LINE_BREAK) {
        pos = end + 1;
        line += 1;
      } else {
        pos = end;
      }
      return { value, ended, added };
    }
  }

  // Repair pass over quoted content [from, to): "" -> ", CR/CRLF -> LF,
  // counting every line break it crosses. Only called when the content
  // actually holds a doubled quote or a CR/LF.
  function repairQuoted(from, to) {
    let v = '';
    let i = from;
    while (i < to) {
      const c = text[i];
      if (c === '"') {
        v += '"';
        i += 2;
      } else if (c === '\r') {
        v += '\n';
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
      } else {
        if (c === '\n') line += 1;
        v += c;
        i += 1;
      }
    }
    return v;
  }

  // Quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let search = pos + 1;
    let escaped = false;
    let close = -1;
    for (;;) {
      const q = text.indexOf('"', search);
      if (q === -1) {
        // Never closes: the quote is literal, the rest is read unquoted.
        pos = open + 1;
        line = openLine;
        err('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        escaped = true;
        search = q + 2;
        continue;
      }
      close = q;
      break;
    }
    let value;
    if (!escaped) {
      // Bounded scan of the content only: any CR or LF in it needs the
      // repair pass (and its line counting); otherwise one slice is exact.
      let bad = false;
      for (let i = pos + 1; i < close; i++) {
        const cc = text.charCodeAt(i);
        if (cc === 10 || cc === 13) {
          bad = true;
          break;
        }
      }
      if (!bad) {
        value = text.slice(pos + 1, close);
      } else {
        value = repairQuoted(pos + 1, close);
      }
    } else {
      value = repairQuoted(pos + 1, close);
    }
    pos = close + 1;
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // Junk after the closing quote, up to the next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) err('quote_junk');
    return junk;
  }

  // Finish one parsed record: header capture or width pad/cut.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Blank lines are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? n : lf;
    // Fast path: the line holds no quote and no stray CR. A trailing CR
    // before the LF is the CRLF line break, not a stray one.
    const end = lf !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    const seg = text.slice(pos, end);
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      const fields = seg.split(',');
      pos = lf === -1 ? n : lf + 1;
      if (lf !== -1) line += 1;
      if (fields.length === 1 && fields[0] === '') continue;
      finishRecord(fields);
      continue;
    }

    // Slow path: at least one quoted field or stray CR on this record.
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);
    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    finishRecord(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
