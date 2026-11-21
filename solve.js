// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Hand-written from the reference semantics, not copied from it: one left-to-right
// pass over the text, returning {columns, rows, errors} with csv-reader's exact
// broken-row policy (BOM dropped, LF/CRLF record ends, stray CR dropped with a
// stray_cr error, doubled quotes, quote junk, unterminated quotes re-read as
// unquoted, short/long rows padded or cut to the first record's width).
//
// Speed comes from never walking character by character on the hot path:
//   - a whole plain record (no quotes, no stray CR) is sliced and split(',') at once;
//   - an unquoted field is cut with indexOf for its next comma or line break, and
//     any CR is found only inside that already-cut slice, never by scanning ahead;
//   - a quoted field is cut span by span between quotes with indexOf('"'), and a
//     span's CR/CRLF line breaks are normalised with one replace only when the
//     span actually holds a CR;
//   - readers return the field string directly and report how it ended through
//     shared locals, so no per-field result object is allocated.
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;
  // How the last field read ended: 0 comma, 1 line break, 2 end of text.
  let fEnded = 2;
  // Characters kept by the last unquoted read (stray CRs do not count).
  let fAdded = 0;

  const pushErr = (code) => {
    errors.push({ code, line: recordLine, row: recordRow });
  };

  const countLF = (s) => {
    let c = 0;
    let i = s.indexOf('\n');
    while (i !== -1) {
      c += 1;
      i = s.indexOf('\n', i + 1);
    }
    return c;
  };

  // Append the quoted span text[from, to) to value: every CRLF or lone CR in it
  // becomes one LF, and each such line break (plus each LF) moves `line` on.
  const addSpan = (value, from, to) => {
    if (from === to) return value;
    const span = text.slice(from, to);
    if (span.indexOf('\r') === -1) {
      if (span.indexOf('\n') === -1) return value + span;
      line += countLF(span);
      return value + span;
    }
    const fixed = span.replace(/\r\n?/g, '\n');
    line += countLF(fixed);
    return value + fixed;
  };

  // Read an unquoted field starting from `value` ('' normally, '"' for an
  // unterminated quote re-read, the quoted value for quote junk). Sets fEnded
  // and fAdded; returns the field.
  function readUnquoted(value) {
    const startLen = value.length;
    for (;;) {
      if (pos >= n) {
        fEnded = 2;
        fAdded = value.length - startLen;
        return value;
      }
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      let m = -1;
      if (ci !== -1 && ni !== -1) m = ci < ni ? ci : ni;
      else m = ci !== -1 ? ci : ni;
      const end = m === -1 ? n : m;
      const seg = text.slice(pos, end);
      const ri = seg.indexOf('\r');
      if (ri === -1) {
        value += seg;
        if (m === -1) {
          pos = n;
          fEnded = 2;
        } else {
          pos = m + 1;
          if (m === ci) fEnded = 0;
          else {
            line += 1;
            fEnded = 1;
          }
        }
        fAdded = value.length - startLen;
        return value;
      }
      value += seg.slice(0, ri);
      const cr = pos + ri;
      if (cr + 1 === ni) {
        // CR directly before the next LF: one CRLF ends the record.
        pos = ni + 1;
        line += 1;
        fEnded = 1;
        fAdded = value.length - startLen;
        return value;
      }
      pushErr('stray_cr');
      pos = cr + 1;
    }
  }

  // Read a quoted field whose opening quote is at pos. Sets fEnded; returns the field.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after
        // it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        pushErr('unterminated_quote');
        return readUnquoted('"');
      }
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        value = addSpan(value, pos, q);
        value += '"';
        pos = q + 2;
        continue;
      }
      value = addSpan(value, pos, q);
      pos = q + 1;
      break;
    }
    if (pos >= n) {
      fEnded = 2;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fEnded = 0;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fEnded = 1;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fEnded = 1;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (fAdded > 0) pushErr('quote_junk');
    return junk;
  }

  // Finish one record: a line that held only stray CRs is no record; the first
  // record sets the width (and is the header when header is true); the rest are
  // padded or cut to that width.
  function commit(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
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

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a whole record on one line with no quotes and no stray CR
    // (a CR is allowed only as the last character before its LF, i.e. CRLF).
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? n : nl;
    const seg = text.slice(pos, end);
    if (seg.indexOf('"') === -1) {
      const ri = seg.indexOf('\r');
      if (ri === -1 || (nl !== -1 && ri === seg.length - 1)) {
        const fields = (ri === -1 ? seg : seg.slice(0, -1)).split(',');
        pos = nl === -1 ? n : nl + 1;
        if (nl !== -1) line += 1;
        commit(fields, false);
        continue;
      }
    }

    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (fEnded === 0);
    commit(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
