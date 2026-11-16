// markdown-fast: a dependency-free Markdown renderer whose output is byte-for-byte
// the HTML that marked 18.1.3 produces with its default options (GFM on, breaks off).
//
// The implementation is an original, scanner-based design: block structure is found
// by walking lines with explicit character checks (no grammar mega-regexes), inline
// text is consumed by a single index-driven pass, and emphasis/strikethrough are
// resolved by a delimiter-run engine that works on a masked copy of the source
// (link destinations, code spans and HTML are blanked out before closers are
// located, so delimiters inside them can never be chosen). Everything is computed
// from the argument on every call: no caching, no state between calls.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const HTML_SPECIAL_RE = /[<>"'&]/g;

// Escape HTML. With `encode` set, every special char is escaped; without it, an
// ampersand that already introduces a character reference is left alone.
function escapeHtml(text, encode) {
  if (!text) return text;
  HTML_SPECIAL_RE.lastIndex = 0;
  let out = '';
  let start = 0;
  let m;
  while ((m = HTML_SPECIAL_RE.exec(text)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '&' && !encode && entityAhead(text, i)) continue;
    out += text.slice(start, i) + HTML_ESCAPES[c];
    start = i + 1;
  }
  return start === 0 ? text : out + text.slice(start);
}

// Does the '&' at text[i] begin something that looks like a character reference
// (&#123; &#x1F; or &name;) and so must not be re-escaped?
function entityAhead(text, i) {
  let j = i + 1;
  if (text[j] === '#') {
    j++;
    if (text[j] === 'x' || text[j] === 'X') {
      j++;
      let n = 0;
      while (j < text.length && n < 6 && isHex(text[j])) { j++; n++; }
      return n > 0 && text[j] === ';';
    }
    let n = 0;
    while (j < text.length && n < 7 && isDigit(text[j])) { j++; n++; }
    return n > 0 && text[j] === ';';
  }
  let n = 0;
  while (j < text.length && (isAlnum(text[j]) || text[j] === '_')) { j++; n++; }
  return n > 0 && text[j] === ';';
}

function isDigit(c) { return c >= '0' && c <= '9'; }
function isHex(c) { return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
function isAlnum(c) { return isDigit(c) || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

// Decode numeric character references in a text run (named references are left
// untouched). A bare '&' that starts no reference becomes '&amp;' — but only
// when the run holds at least one numeric reference, matching the reference
// renderer's two-step behaviour.
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([0-9A-Fa-f]{1,6}));/;
function decodeNumericRefs(text) {
  if (!text.includes('&#') || !NUMERIC_REF.test(text)) return text;
  return text.replace(/&#(?:(\d{1,7})|[Xx]([0-9A-Fa-f]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][0-9a-fA-F]{1,6}|\w+);)/g,
    (m, dec, hex) => {
      if (dec === undefined && hex === undefined) return '&amp;';
      const v = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      if (v === 0 || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) return '\uFFFD';
      if (v === 38) return '&amp;';
      return String.fromCodePoint(v);
    });
}

// URL cleaning for link/image destinations: percent-encode as encodeURI does,
// then undo the encoding of '%' itself; a URIError (lone surrogate) makes the
// destination unusable and the link renders as its text only.
function cleanUrl(href) {
  // Fast path: encodeURI is the identity and the %25-undo is a no-op.
  if (!href.includes('%25')) {
    let clean = true;
    for (let i = 0; i < href.length; i++) {
      const c = href.charCodeAt(i);
      if (c < 0x21 || c >= 0x7F || c === 0x22 || c === 0x3C || c === 0x3E ||
          c === 0x5B || c === 0x5C || c === 0x5D || c === 0x5E || c === 0x60 ||
          c === 0x7B || c === 0x7C || c === 0x7D) { clean = false; break; }
    }
    if (clean) return href;
  }
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Link label normalisation: trim, collapse whitespace, fold case (the double
// fold through upper case matters for a few Unicode letters).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove a trailing run of `ch` characters.
function stripTrailing(text, ch) {
  let end = text.length;
  while (end > 0 && text[end - 1] === ch) end--;
  return text.slice(0, end);
}

// Drop trailing blank lines of a code/html block's raw text, keeping the text
// whole when at most one blank line trails.
function dropTrailingBlankLines(text) {
  const lines = text.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last])) last--;
  if (lines.length - last <= 2) return text;
  return lines.slice(0, last + 1).join('\n');
}

// Expand tabs to spaces, a tab advancing to the next multiple of 4 columns,
// counting from column `startCol`.
function expandTabs(text, startCol) {
  if (!text.includes('\t')) return text;
  let out = '';
  let col = startCol;
  for (const ch of text) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Find the closing bracket matching the opener implied by `pair` ("()" or "[]")
// in `text`, honouring backslash escapes. Returns the index of the closer, -1
// when the text is balanced, and -2 when an opener is left unclosed.
function findClosing(text, pair) {
  if (!text.includes(pair[0]) && !text.includes(pair[1])) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === pair[0]) depth++;
    else if (c === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row into cells: unescaped pipes separate cells, a pipe preceded
// by an odd run of backslashes is literal. Cells are trimmed and '\|' unescaped.
function splitCells(row, maxCells) {
  let markedRow = '';
  let slashes = 0;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\') { slashes++; markedRow += c; continue; }
    if (c === '|') {
      markedRow += slashes % 2 === 1 ? '|' : ' |';
      slashes = 0;
      continue;
    }
    slashes = 0;
    markedRow += c;
  }
  const cells = markedRow.split(' |');
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  if (maxCells !== undefined) {
    if (cells.length > maxCells) cells.splice(maxCells);
    while (cells.length < maxCells) cells.push('');
  }
  return cells.map(c => c.trim().replace(/\\\|/g, '|'));
}

// ---------------------------------------------------------------------------
// Character classes used by the inline grammar
// ---------------------------------------------------------------------------

const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]/u;
const SPACE_OR_PUNCT_OR_SYMBOL = /[\s\p{P}\p{S}]/u;
const ALPHA_NUMERIC = /[\p{L}\p{N}]/u;
const JS_SPACE = /\s/;

// ASCII class bits for the delimiter predicates: for code points below 128,
// \s is {9,10,11,12,13,32} and \p{P}\p{S} is exactly the printable characters
// that are not letters or digits. Anything else defers to the regexes.
const CLASS_SPACE = 1;
const CLASS_PUNCT = 2;
const ASCII_CLASS = (() => {
  const table = new Uint8Array(128);
  for (const code of [9, 10, 11, 12, 13, 32]) table[code] |= CLASS_SPACE;
  for (let code = 33; code < 127; code++) {
    const alnum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);
    if (!alnum) table[code] |= CLASS_PUNCT;
  }
  return table;
})();

// Punctuation in the GFM delimiter senses: the asterisk rules exclude '~' from
// the punctuation classes (a tilde counts as a word character there instead).
function isPunct(c) {
  if (c === undefined) return false;
  if (c.length === 1) {
    const code = c.charCodeAt(0);
    if (code < 128) return (ASCII_CLASS[code] & CLASS_PUNCT) !== 0;
  }
  return PUNCT_OR_SYMBOL.test(c);
}
function isPunctNoTilde(c) { return c !== '~' && isPunct(c); }
function isSpacePunct(c) {
  if (c === undefined) return false;
  if (c.length === 1) {
    const code = c.charCodeAt(0);
    if (code < 128) return (ASCII_CLASS[code] & (CLASS_SPACE | CLASS_PUNCT)) !== 0;
  }
  return SPACE_OR_PUNCT_OR_SYMBOL.test(c);
}
function isSpacePunctNoTilde(c) { return c !== '~' && isSpacePunct(c); }
// "Not punctuation/space" in the asterisk sense: anything else, or '~' itself.
function isWordyAst(c) { return c === '~' || !isSpacePunct(c); }
function isWordy(c) { return !isSpacePunct(c); }
function isJsSpace(c) {
  if (c === undefined) return false;
  if (c.length === 1) {
    const code = c.charCodeAt(0);
    if (code < 128) return (ASCII_CLASS[code] & CLASS_SPACE) !== 0;
  }
  return JS_SPACE.test(c);
}

// The code point ending at index `end` of `s` (handles surrogate pairs), or ''
// when `end` is 0.
function codePointBefore(s, end) {
  if (end <= 0) return '';
  const c = s.charCodeAt(end - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && end >= 2) {
    const c2 = s.charCodeAt(end - 2);
    if (c2 >= 0xD800 && c2 <= 0xDBFF) return s.slice(end - 2, end);
  }
  return s[end - 1];
}

// The code point starting at index `i` of `s`, or ''.
function codePointAt(s, i) {
  if (i >= s.length) return '';
  const c = s.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
    const c2 = s.charCodeAt(i + 1);
    if (c2 >= 0xDC00 && c2 <= 0xDFFF) return s.slice(i, i + 2);
  }
  return s[i];
}

// ---------------------------------------------------------------------------
// Inline scanners shared by the link machinery, the mask and the main loop
// ---------------------------------------------------------------------------

// Given the end of an opening backtick run, find where the code span closes:
// the next maximal backtick run of exactly the same length. Returns the index
// just past the closing run, or -1.
function findCodeSpanClose(src, from, runLen) {
  let i = from;
  while (i < src.length) {
    if (src[i] !== '`') { i++; continue; }
    let j = i;
    while (j < src.length && src[j] === '`') j++;
    if (j - i === runLen) return j;
    i = j;
  }
  return -1;
}

// Length of the code span starting at src[i] (a backtick), or -1.
function matchCodeSpanAt(src, i) {
  let run = 0;
  while (src[i + run] === '`') run++;
  if (run === 0) return -1;
  const close = findCodeSpanClose(src, i + run, run);
  return close === -1 ? -1 : close - i;
}

// The code-span item inside a link label differs from an inline code span:
// its closing run may have any length. Given an opening run at src[i] of
// length run, return the index just past the closing run, or -1.
function labelCodeSpanEnd(src, i, run) {
  let k = i + run;
  while (k < src.length && src[k] !== '`') k++;
  if (k >= src.length) return -1;
  while (k < src.length && src[k] === '`') k++;
  return k;
}

// Scan a link label starting just after '['. Walks the label grammar (nested
// bracket groups two levels deep, escapes, code spans, any other char except
// the closers) and returns the candidate indices of the ']' that could end
// the label, shortest first. A backtick run directly before a ']' is one
// candidate (the run as a label item of its own); a code span starting at
// the same run may carry the label further, so the walk continues past it
// and later candidates follow.
function scanLabelEnds(src, start) {
  // Fast path: with no escape, backtick or '[' before the first ']', that
  // ']' is the only candidate end.
  const firstClose = src.indexOf(']', start);
  if (firstClose === -1) return [];
  const esc = src.indexOf('\\', start);
  const tick = src.indexOf('`', start);
  const brack = src.indexOf('[', start);
  if ((esc === -1 || esc >= firstClose) &&
      (tick === -1 || tick >= firstClose) &&
      (brack === -1 || brack >= firstClose)) {
    return [firstClose];
  }
  const ends = [];
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === ']') { ends.push(i); return ends; }
    if (c === '`') {
      let run = 0;
      while (src[i + run] === '`') run++;
      // A run of at least two backticks directly before the ']' can be a
      // label item of its own, ending the label there.
      if (run >= 2 && src[i + run] === ']') ends.push(i + run);
      const close = labelCodeSpanEnd(src, i, run);
      if (close !== -1) { i = close; continue; }
      return ends;
    }
    if (c === '[') {
      const groupEnd = scanBracketGroup(src, i);
      if (groupEnd === -1) return ends;
      i = groupEnd;
      continue;
    }
    i++;
  }
  return ends;
}

// A bracket group inside a label: '[' ... ']' whose contents are escapes,
// plain chars (no brackets) and one further level of bracket groups.
function scanBracketGroup(src, start) {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === ']') return i + 1;
    if (c === '[') {
      // Deepest level: escapes and plain chars only, no more brackets.
      i++;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === ']') { closed = true; i++; break; }
        if (d === '[') return -1;
        i++;
      }
      if (!closed) return -1;
      continue;
    }
    i++;
  }
  return -1;
}

// Scan a reference label (the kind link definitions and shortcut references
// use): escapes and any chars except brackets, with newlines allowed only
// when they do not cross a blank line. Returns the index of the closing ']'.
function scanRefLabelEnd(src, start) {
  let i = start;
  let count = 0;
  let allBlank = true;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; count += 2; allBlank = false; continue; }
    if (c === ']') {
      if (count === 0 || allBlank) return -1;
      return i;
    }
    if (c === '[') return -1;
    if (c === '\n') {
      // A newline may not be followed by a blank line.
      let j = i + 1;
      while (src[j] === ' ' || src[j] === '\t') j++;
      if (src[j] === '\n') return -1;
      i++;
      count++;
      continue;
    }
    if (c !== ' ' && c !== '\t') allBlank = false;
    i++;
    count++;
  }
  return -1;
}

const TAG_NAME_CHAR = /[a-zA-Z0-9-]/;
const ATTR_NAME_START = /[a-zA-Z:_]/;
const ATTR_NAME_CHAR = /[\w.:-]/;

// Length of the inline HTML tag starting at src[i] ('<'), or -1. Covers
// comments, closing tags, open tags with attributes, processing instructions,
// declarations and CDATA sections.
function matchTagAt(src, i) {
  if (src[i] !== '<') return -1;
  // Comment: <!-- ... --> with the <!--> and <!---> short forms.
  if (src.startsWith('<!--', i)) {
    if (src[i + 4] === '>') return 5;
    if (src[i + 4] === '-' && src[i + 5] === '>') return 6;
    const end = src.indexOf('-->', i + 4);
    return end === -1 ? -1 : end + 3 - i;
  }
  // Closing tag.
  if (src[i + 1] === '/') {
    let j = i + 2;
    if (!/[a-zA-Z]/.test(src[j] ?? '')) return -1;
    j++;
    while (j < src.length && TAG_NAME_CHAR.test(src[j])) j++;
    while (j < src.length && isJsSpace(src[j])) j++;
    return src[j] === '>' ? j + 1 - i : -1;
  }
  // Processing instruction.
  if (src[i + 1] === '?') {
    const end = src.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2 - i;
  }
  // CDATA or declaration.
  if (src[i + 1] === '!') {
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      return end === -1 ? -1 : end + 3 - i;
    }
    let j = i + 2;
    if (!/[a-zA-Z]/.test(src[j] ?? '')) return -1;
    while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
    if (!isJsSpace(src[j])) return -1;
    const end = src.indexOf('>', j);
    return end === -1 ? -1 : end + 1 - i;
  }
  // Open tag with attributes.
  let j = i + 1;
  if (!/[a-zA-Z]/.test(src[j] ?? '')) return -1;
  j++;
  while (j < src.length && TAG_NAME_CHAR.test(src[j])) j++;
  for (;;) {
    let k = j;
    while (k < src.length && isJsSpace(src[k])) k++;
    if (src[k] === '>') return k + 1 - i;
    if (src[k] === '/' && src[k + 1] === '>') return k + 2 - i;
    if (k === j) return -1; // attributes need leading whitespace
    j = k;
    if (!ATTR_NAME_START.test(src[j] ?? '')) return -1;
    j++;
    while (j < src.length && ATTR_NAME_CHAR.test(src[j])) j++;
    // Optional = value.
    let m = j;
    while (m < src.length && isJsSpace(src[m])) m++;
    if (src[m] === '=') {
      m++;
      while (m < src.length && isJsSpace(src[m])) m++;
      const q = src[m];
      if (q === '"' || q === "'") {
        const end = src.indexOf(q, m + 1);
        if (end === -1) return -1;
        j = end + 1;
      } else {
        let v = m;
        while (v < src.length && !isJsSpace(src[v]) && src[v] !== '"' && src[v] !== "'" &&
               src[v] !== '=' && src[v] !== '<' && src[v] !== '>' && src[v] !== '`') v++;
        if (v === m) return -1;
        j = v;
      }
    }
  }
}

const EMAIL_LOCAL = /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]/;
// Fast membership test for the email local-part class, indexed by char code.
const EMAIL_LOCAL_TABLE = (() => {
  const table = new Uint8Array(128);
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";
  for (let k = 0; k < chars.length; k++) table[chars.charCodeAt(k)] = 1;
  return table;
})();

function isEmailLocalChar(c) {
  const code = c.charCodeAt(0);
  return code < 128 && EMAIL_LOCAL_TABLE[code] === 1;
}
const AUTOLINK_LOCAL = /[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]/;

// Scan an email address at src[i]: local part, '@', dotted domain whose labels
// start and end alphanumerically. Returns the end index or -1.
function scanEmail(src, i) {
  let j = i;
  while (j < src.length && AUTOLINK_LOCAL.test(src[j])) j++;
  if (j === i || src[j] !== '@') return -1;
  j++;
  let labels = 0;
  for (;;) {
    const start = j;
    if (!isAlnum(src[j])) return -1;
    j++;
    while (j < src.length && (isAlnum(src[j]) || src[j] === '-')) j++;
    if (src[j - 1] === '-') return -1;
    if (j - start > 63) return -1;
    labels++;
    if (src[j] === '.') { j++; continue; }
    break;
  }
  if (labels < 2) return -1;
  if (src[j] === '-' || src[j] === '_') return -1;
  return j;
}

// The autolink starting at src[i] ('<scheme:...>' or '<email>'):
// { len, email } or null.
function matchAutolinkAt(src, i) {
  if (src[i] !== '<') return null;
  // Scheme form.
  let j = i + 1;
  if (/[a-zA-Z]/.test(src[j] ?? '')) {
    let k = j + 1;
    while (k < src.length && /[a-zA-Z0-9+.-]/.test(src[k])) k++;
    if (k - j >= 2 && k - j <= 32 && src[k] === ':') {
      let m = k + 1;
      while (m < src.length && !isJsSpace(src[m]) && src[m] !== '<' && src[m] !== '>' &&
             src.charCodeAt(m) > 0x1F) m++;
      if (src[m] === '>') return { len: m + 1 - i, email: false };
    }
  }
  const end = scanEmail(src, i + 1);
  if (end !== -1 && src[end] === '>') return { len: end + 1 - i, email: true };
  return null;
}

// Does this link label contain an HTML tag or autolink that reaches past the
// label's end? Such a label does not form a link at all.
function linkSpansHtml(src, label, offset) {
  if (!label.includes('<')) return false;
  let s = 0;
  while (s < label.length) {
    const c = label[s];
    if (c === '\\') { s += 2; continue; }
    if (c === '`') {
      const span = matchCodeSpanAt(label, s);
      if (span !== -1) { s += span; continue; }
    }
    if (c !== '<') { s++; continue; }
    const rest = src.slice(offset + s);
    let len = matchTagAt(rest, 0);
    if (len === -1) {
      const auto = matchAutolinkAt(rest, 0);
      if (auto) len = auto.len;
    }
    if (len !== -1) {
      if (len > label.length - s) return true;
      s += len;
      continue;
    }
    s++;
  }
  return false;
}

// Backslash-escaped punctuation loses its backslash.
function unescapePunct(text) {
  return text ? text.replace(/\\([\p{P}\p{S}])/gu, '$1') : text;
}

// Build the link/image token once its destination is known, tokenising the
// label text. A link whose text itself emitted a link is suppressed (nested
// links are not allowed); the caller then falls through to other tokenisers.
function outputLink(ctx, raw, href, title, label, isImage) {
  const text = label.replace(/\\([\[\]])/g, '$1');
  const prevInLink = ctx.state.inLink;
  const prevEmitted = ctx.state.linkEmitted;
  const prevRawBlock = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  const tokens = inlineTokens(ctx, text);
  const emitted = ctx.state.linkEmitted;
  ctx.state.linkEmitted = prevEmitted;
  ctx.state.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      ctx.state.inRawBlock = prevRawBlock;
      return null;
    }
    ctx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title: title || null, text, tokens };
}

// ---------------------------------------------------------------------------
// Link destination scanning
// ---------------------------------------------------------------------------

function isInlineWs(c) { return c === ' ' || c === '\t' || c === '\n'; }

// The whitespace run that may separate a link destination from its title: a
// run of spaces/tabs optionally ending in one newline, or a bare newline,
// each followed by optional spaces/tabs. Returns the end index or -1.
function titleSeparatorEnd(src, i) {
  if (src[i] === ' ' || src[i] === '\t') {
    let j = i;
    while (src[j] === ' ' || src[j] === '\t') j++;
    if (src[j] === '\n') {
      j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
    }
    return j;
  }
  if (src[i] === '\n') {
    let j = i + 1;
    while (src[j] === ' ' || src[j] === '\t') j++;
    return j;
  }
  return -1;
}

// A link title starting at src[i]: "double", 'single' or (paren) quoted.
// Returns { raw, end } or null.
function scanTitle(src, i) {
  const open = src[i];
  if (open === '"' || open === "'") {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === open) return { raw: src.slice(i, j + 1), end: j + 1 };
      j++;
    }
    return null;
  }
  if (open === '(') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === ')') return { raw: src.slice(i, j + 1), end: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

// After a link destination at position p: an optional title and the closing
// paren. Returns { titleRaw, end } or null.
function linkTail(src, p) {
  const sep = titleSeparatorEnd(src, p);
  if (sep !== -1) {
    const title = scanTitle(src, sep);
    if (title) {
      let q = title.end;
      while (q < src.length && isInlineWs(src[q])) q++;
      if (src[q] === ')') return { titleRaw: title.raw, end: q + 1 };
    }
  }
  let q = p;
  while (q < src.length && isInlineWs(src[q])) q++;
  if (src[q] === ')') return { titleRaw: undefined, end: q + 1 };
  return null;
}

// Scan an inline link or image at src[i] ('[' or '!'). Mirrors the reference
// grammar exactly, including its backtracking: an angle destination whose
// tail fails falls back to the bare-run form, and a bare run shrinks to its
// last usable closing paren.
function scanInlineLink(src, i) {
  const isImage = src[i] === '!';
  const bracketAt = i + (isImage ? 1 : 0);
  if (src[bracketAt] !== '[') return null;
  const labelStart = bracketAt + 1;
  for (const labelEnd of scanLabelEnds(src, labelStart)) {
    if (src[labelEnd + 1] !== '(') continue;
    const result = inlineLinkTailParse(src, i, isImage, labelStart, labelEnd);
    if (result) return result;
  }
  return null;
}

// Parse the destination and title of an inline link whose label ends at
// labelEnd (src[labelEnd + 1] is '('). Null when this label choice fails.
function inlineLinkTailParse(src, i, isImage, labelStart, labelEnd) {
  const label = src.slice(labelStart, labelEnd);
  let j = labelEnd + 2;
  while (j < src.length && isInlineWs(src[j])) j++;
  let hrefRaw;
  let tail = null;
  // Angle destination form.
  if (src[j] === '<') {
    let k = j + 1;
    let closed = false;
    while (k < src.length) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '>') { closed = true; break; }
      if (c === '\n' || c === '<') break;
      k++;
    }
    if (closed && k > j + 1) {
      tail = linkTail(src, k + 1);
      if (tail) hrefRaw = src.slice(j, k + 1);
    }
  }
  if (!tail) {
    // Bare-run destination form (also the empty destination).
    if (src[j] === ')') {
      hrefRaw = '';
      tail = linkTail(src, j);
      if (!tail) return null;
    } else {
      let runEnd = j;
      while (runEnd < src.length && src[runEnd] > ' ') runEnd++;
      tail = linkTail(src, runEnd);
      if (tail) {
        hrefRaw = src.slice(j, runEnd);
      } else {
        let p = runEnd - 1;
        while (p >= j && src[p] !== ')') p--;
        if (p < j) return null;
        hrefRaw = src.slice(j, p);
        tail = { titleRaw: undefined, end: p + 1 };
      }
    }
  }
  return {
    label,
    hrefRaw,
    titleRaw: tail.titleRaw,
    raw: src.slice(i, tail.end),
    isImage,
  };
}

// The inline link attempt, including the reference implementation's
// post-match validation of the destination (angle-bracket parity and the
// balanced-paren truncation).
function tryLink(ctx, src, i) {
  if (!ctx.state.linkParenPossible) return null;
  const parsed = scanInlineLink(src, i);
  if (!parsed) return null;
  if (linkSpansHtml(src, parsed.label, i + (parsed.isImage ? 2 : 1))) return null;
  let hrefRaw = parsed.hrefRaw;
  let raw = parsed.raw;
  let titleRaw = parsed.titleRaw;
  const s = hrefRaw.trim();
  if (s.startsWith('<')) {
    if (!s.endsWith('>')) return null;
    const inner = stripTrailing(s.slice(0, -1), '\\');
    if ((s.length - inner.length) % 2 === 0) return null;
  } else {
    const p = findClosing(hrefRaw, '()');
    if (p === -2) return null;
    if (p > -1) {
      const h = (raw.indexOf('!') === 0 ? 5 : 4) + parsed.label.length + p;
      hrefRaw = hrefRaw.substring(0, p);
      raw = raw.substring(0, h).trim();
      titleRaw = '';
    }
  }
  const unescapedTail = stripTrailing(raw.slice(0, -1), '\\');
  if ((raw.length - unescapedTail.length) % 2 === 0) return null;
  let href = hrefRaw.trim();
  if (href.startsWith('<')) href = href.slice(1, -1);
  const title = titleRaw ? titleRaw.slice(1, -1) : '';
  return outputLink(ctx, raw, unescapePunct(href), unescapePunct(title), parsed.label, parsed.isImage);
}

// Scan a full reference link at src[i]: label, then [ref]. Null if absent.
function scanReflink(src, i) {
  const isImage = src[i] === '!';
  const bracketAt = i + (isImage ? 1 : 0);
  if (src[bracketAt] !== '[') return null;
  const labelStart = bracketAt + 1;
  for (const labelEnd of scanLabelEnds(src, labelStart)) {
    if (src[labelEnd + 1] !== '[') continue;
    const refEnd = scanRefLabelEnd(src, labelEnd + 2);
    if (refEnd === -1) continue;
    return {
      label: src.slice(labelStart, labelEnd),
      ref: src.slice(labelEnd + 2, refEnd),
      raw: src.slice(i, refEnd + 1),
      isImage,
    };
  }
  return null;
}

// Scan a shortcut reference (or its []-suffixed form) at src[i].
function scanNolink(src, i) {
  const isImage = src[i] === '!';
  const bracketAt = i + (isImage ? 1 : 0);
  if (src[bracketAt] !== '[') return null;
  const labelStart = bracketAt + 1;
  const labelEnd = scanRefLabelEnd(src, labelStart);
  if (labelEnd === -1) return null;
  let end = labelEnd + 1;
  if (src[end] === '[' && src[end + 1] === ']') end += 2;
  const label = src.slice(labelStart, labelEnd);
  return { label, ref: label, raw: src.slice(i, end), isImage };
}

function tryReflink(ctx, src, i) {
  const parsed = scanReflink(src, i) ?? scanNolink(src, i);
  if (!parsed) return null;
  if (linkSpansHtml(src, parsed.label, i + (parsed.isImage ? 2 : 1))) return null;
  const link = ctx.links[normalizeLabel(parsed.ref || parsed.label)];
  if (!link) {
    // An unresolved reference renders as its first character only.
    return { type: 'text', raw: src[i], text: src[i], escaped: false };
  }
  return outputLink(ctx, parsed.raw, link.href, link.title, parsed.label, parsed.isImage);
}

// ---------------------------------------------------------------------------
// The emphasis mask. Emphasis matching runs on a masked copy of the source
// where constructs that cannot take part (resolved references, code spans,
// link destinations, HTML tags, escaped punctuation) are blanked to inert
// characters of the same length, so indices stay aligned with the source.
// ---------------------------------------------------------------------------

// All blockSkip spans (link destinations, code spans, HTML tags) in a text.
function blockSkipSpans(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    // Jump to the next position that can open a span.
    let idx = -1;
    const ka = text.indexOf('[', i);
    if (ka !== -1) idx = ka;
    const kb = text.indexOf('!', i);
    if (kb !== -1 && (idx === -1 || kb < idx)) idx = kb;
    const kc = text.indexOf('`', i);
    if (kc !== -1 && (idx === -1 || kc < idx)) idx = kc;
    const kd = text.indexOf('<', i);
    if (kd !== -1 && (idx === -1 || kd < idx)) idx = kd;
    if (idx === -1) break;
    i = idx;
    const c = text[i];
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const end = blockSkipLinkEnd(text, i);
      if (end !== -1) { spans.push({ start: i, end, codeRun: 0 }); i = end; continue; }
    } else if (c === '`' && text[i - 1] !== '`') {
      const span = blockSkipCodeSpan(text, i);
      if (span) { spans.push({ start: i, end: span.end, codeRun: span.run }); i = span.end; continue; }
    } else if (c === '<') {
      const end = blockSkipHtmlEnd(text, i);
      if (end !== -1) { spans.push({ start: i, end, codeRun: 0 }); i = end; continue; }
    }
    i++;
  }
  return spans;
}

// End of a blockSkip link span starting at src[i], or -1. Its label allows
// plain chars and code spans (no brackets, no escapes); its destination
// allows escapes and one level of balanced parens.
function blockSkipLinkEnd(src, i) {
  let j = i + (src[i] === '!' ? 2 : 1);
  for (;;) {
    if (j >= src.length) return -1;
    const c = src[j];
    if (c === ']') break;
    if (c === '[') return -1;
    if (c === '`') {
      const span = matchCodeSpanAt(src, j);
      if (span === -1) return -1;
      j += span;
      continue;
    }
    j++;
  }
  if (src[j + 1] !== '(') return -1;
  j += 2;
  for (;;) {
    if (j >= src.length) return -1;
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === ')') return j + 1;
    if (c === '(') {
      j++;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ')') { closed = true; j++; break; }
        if (src[j] === '(') return -1;
        j++;
      }
      if (!closed) return -1;
      continue;
    }
    j++;
  }
}

// A blockSkip code span: a backtick run, non-backtick content, and a closing
// run of exactly the same length. Returns { end, run } or null.
function blockSkipCodeSpan(src, i) {
  let run = 0;
  while (src[i + run] === '`') run++;
  let k = i + run;
  while (k < src.length && src[k] !== '`') k++;
  if (k >= src.length || k === i + run) return null;
  let close = 0;
  while (src[k + close] === '`') close++;
  if (close !== run) return null;
  return { end: k + close, run };
}

// A blockSkip HTML span: '<', not followed by a space, up to the first '>'
// with no '<' in between.
function blockSkipHtmlEnd(src, i) {
  if (src[i + 1] === ' ') return -1;
  const k = src.indexOf('>', i + 1);
  if (k === -1) return -1;
  if (src.slice(i + 1, k).includes('<')) return -1;
  return k + 1;
}

// Does this text contain a real link? Used when masking references whose
// label might itself hold a link (which changes how the outer one masks).
function linkInText(ctx, text) {
  if (!text.includes('[')) return false;
  for (const span of blockSkipSpans(text)) {
    const raw = text.slice(span.start, span.end);
    const parsed = scanInlineLink(raw, 0);
    if (parsed && parsed.raw === raw && text[span.start - 1] !== '!') return true;
  }
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      let parsed = scanReflink(text, i);
      if (!parsed) {
        const n = scanNolink(text, i);
        if (n && text[i + n.raw.length] !== '(') parsed = n;
      }
      if (parsed) {
        const s = parsed.raw;
        const r = s.lastIndexOf('[');
        if (!(s.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(s.slice(r + 1, -1)))) &&
            !(r > 1 && linkInText(ctx, s.slice(1, r - 1)))) return true;
        i += s.length;
        continue;
      }
    }
    i++;
  }
  return false;
}

// The mask replacement for one reference match: unresolved references stay
// as they are; resolved ones become inert 'a's, keeping the bracket frame.
// A resolved reference whose label itself contains a link keeps its label
// (recursively masked) and only blanks the reference part.
function reflinkMaskReplacement(ctx, raw) {
  const o = raw.lastIndexOf('[');
  if (!Object.hasOwn(ctx.links, normalizeLabel(raw.slice(o + 1, -1)))) return raw;
  if (o > 1 && raw[0] !== '!') {
    const inner = raw.slice(1, o - 1);
    if (linkInText(ctx, inner)) {
      return '[' + maskReflinks(ctx, inner) + '][' + 'a'.repeat(raw.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(raw.length - 2) + ']';
}

// Mask step 1: blank out resolved reference links and images.
function maskReflinks(ctx, text) {
  // Copy-on-write: segments without a resolved reference are returned as-is.
  let parts = null;
  let last = 0;
  let i = 0;
  while (i < text.length) {
    let idx = -1;
    const ka = text.indexOf('[', i);
    if (ka !== -1) idx = ka;
    const kb = text.indexOf('!', i);
    if (kb !== -1 && (idx === -1 || kb < idx)) idx = kb;
    if (idx === -1) break;
    i = idx;
    const c = text[i];
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      let parsed = scanReflink(text, i);
      if (!parsed) {
        const n = scanNolink(text, i);
        if (n && text[i + n.raw.length] !== '(') parsed = n;
      }
      if (parsed) {
        const rep = reflinkMaskReplacement(ctx, parsed.raw);
        if (rep !== parsed.raw) {
          if (parts === null) parts = [];
          parts.push(text.slice(last, i), rep);
          last = i + parsed.raw.length;
        }
        i += parsed.raw.length;
        continue;
      }
    }
    i++;
  }
  if (parts === null) return text;
  parts.push(text.slice(last));
  return parts.join('');
}

// Mask step 2: escaped punctuation becomes '+'; backticks inside code spans
// become '+' (the span's own runs stay).
function maskPunctuationOutsideCode(text) {
  // Identity when there is no escape to mask and no code span whose interior
  // backticks would be rewritten.
  if (!text.includes('\\') && !text.includes('`')) return text;
  // Copy-on-write: unchanged regions are never materialised; when nothing
  // changes the input string is returned as-is.
  let parts = null;
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '`') {
      let run = 0;
      while (text[i + run] === '`') run++;
      const close = findCodeSpanClose(text, i + run, run);
      if (close !== -1) {
        const content = text.slice(i + run, close - run);
        if (content.includes('`')) {
          if (parts === null) parts = [];
          parts.push(text.slice(last, i + run), content.replace(/`/g, '+'));
          last = close - run;
        }
        i = close;
      } else {
        i += run;
      }
      continue;
    }
    if (c === '\\') {
      const cp = codePointAt(text, i + 1);
      if (cp !== '' && isPunct(cp)) {
        if (parts === null) parts = [];
        parts.push(text.slice(last, i), '+'.repeat(1 + cp.length));
        last = i + 1 + cp.length;
        i = last;
        continue;
      }
    }
    i++;
  }
  if (parts === null) return text;
  parts.push(text.slice(last));
  return parts.join('');
}

// Mask step 3: blank out link destinations, code spans and HTML tags,
// keeping a bracket frame (and a code span's opening run).
function maskBlockSkip(text) {
  const spans = blockSkipSpans(text);
  if (spans.length === 0) return text;
  let out = '';
  let last = 0;
  for (const span of spans) {
    out += text.slice(last, span.start);
    const len = span.end - span.start;
    out += text.slice(span.start, span.start + span.codeRun) +
      '[' + 'a'.repeat(len - span.codeRun - 2) + ']';
    last = span.end;
  }
  return out + text.slice(last);
}

function applyMask(ctx, src) {
  let t = src;
  if (t.includes('[') && t.includes(']')) t = maskReflinks(ctx, t);
  t = maskPunctuationOutsideCode(t);
  // Block-skip spans can only start at a bracket, backtick or angle bracket.
  if (t.includes('[') || t.includes('`') || t.includes('<')) t = maskBlockSkip(t);
  return t;
}

// For each delimiter, the last index where a closer could sit: the start of
// a run whose preceding character is not space-like.
function computeBounds(masked) {
  const bounds = { star: -1, und: -1, tilde: -1 };
  const n = masked.length;
  let s = 0;
  while (s < n) {
    // Jump to the next delimiter run start.
    const a = masked.indexOf('*', s);
    const b = masked.indexOf('_', s);
    const c = masked.indexOf('~', s);
    let idx = -1;
    let r = '';
    if (a !== -1 && (idx === -1 || a < idx)) { idx = a; r = '*'; }
    if (b !== -1 && (idx === -1 || b < idx)) { idx = b; r = '_'; }
    if (c !== -1 && (idx === -1 || c < idx)) { idx = c; r = '~'; }
    if (idx === -1) break;
    const prev = idx === 0 ? '\n' : masked[idx - 1];
    let i = idx + 1;
    while (i < n && masked[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') bounds.tilde = idx;
      else if (r === '*') bounds.star = idx;
      else bounds.und = idx;
    }
    s = i;
  }
  return bounds;
}

// ---------------------------------------------------------------------------
// Right-delimiter scanning. The reference emphasis algorithm scans the masked
// tail with a classified-run pattern: text skips (group 0) alternate with
// delimiter runs whose group (1-6) is decided by the character classes on
// either side. This scanner yields the same match sequence directly.
// ---------------------------------------------------------------------------

// The punctuation test used for "previous/next char is punctuation" checks:
// space, punctuation or symbol, except the emphasis delimiters themselves.
function punctRule(cp) {
  return cp !== '' && cp !== '*' && cp !== '_' && isSpacePunct(cp);
}

// A text skip: a run of non-delimiter characters, matched one short so the
// last character can serve as the next run's context character.
function textSkipLength(src, p, delim) {
  const idx = src.indexOf(delim, p);
  const L = (idx === -1 ? src.length : idx) - p;
  return L >= 2 ? L - 1 : 0;
}

// The next position at or after u holding a '*' or '_', or src.length.
function nextStarOrUnd(src, u) {
  const a = src.indexOf('*', u);
  const b = src.indexOf('_', u);
  if (a === -1) return b === -1 ? src.length : b;
  return b === -1 ? a : Math.min(a, b);
}

// The anchored first skip for '*' and '_' tails: a region shaped
// __ ... * ... up to (not including) another __, mirrored for '_'.
// Every lazy segment is forced to its first possible stop, so this is a
// direct walk. Returns the match end or -1.
function alt1SkipEnd(src, base, kind) {
  const pairChar = kind === 'ast' ? '_' : '*';
  const singleChar = kind === 'ast' ? '*' : '_';
  const u = nextStarOrUnd(src, base);
  if (src[u] !== pairChar || src[u + 1] !== pairChar) return -1;
  const v = nextStarOrUnd(src, u + 2);
  if (src[v] !== singleChar) return -1;
  const w = nextStarOrUnd(src, v + 1);
  if (src[w] !== pairChar || src[w + 1] !== pairChar) return -1;
  return w;
}

// Classify a delimiter run at (ctx, tail) into its group for '*' tails.
function astGroup(ctx, tail) {
  const ctxPunct = ctx !== '*' && isPunctNoTilde(ctx);
  const tailEOS = tail === '';
  if (ctxPunct && (tailEOS || isJsSpace(tail))) return 1;
  if (isWordyAst(ctx) && (tailEOS || isSpacePunctNoTilde(tail))) return 2;
  if (ctx !== '*' && isSpacePunctNoTilde(ctx) && tail !== '' && isWordyAst(tail)) return 3;
  if (isJsSpace(ctx) && tail !== '' && isPunctNoTilde(tail)) return 4;
  if (ctxPunct && tail !== '' && isPunctNoTilde(tail)) return 5;
  if (isWordyAst(ctx) && tail !== '' && isWordyAst(tail)) return 6;
  return 0;
}

// Classify a delimiter run at (ctx, tail) into its group for '_' tails.
function undGroup(ctx, tail) {
  const ctxPunct = ctx !== '_' && isPunct(ctx);
  const tailEOS = tail === '';
  if (ctxPunct && (tailEOS || isJsSpace(tail))) return 1;
  if (isWordy(ctx) && (tailEOS || isSpacePunct(tail))) return 2;
  if (ctx !== '_' && isSpacePunct(ctx) && tail !== '' && isWordy(tail)) return 3;
  if (isJsSpace(ctx) && tail !== '' && isPunct(tail)) return 4;
  if (ctxPunct && tail !== '' && isPunct(tail)) return 5;
  return 0;
}

// Try the classified-run alternatives at position p. For '*'/'_' the run is
// maximal; for '~' it is one or two tildes (longer first, per group).
function matchRDelimGroup(src, p, kind) {
  const ctx = codePointAt(src, p);
  if (ctx === '') return null;
  const delim = kind === 'ast' ? '*' : kind === 'und' ? '_' : '~';
  const runStart = p + ctx.length;
  if (src[runStart] !== delim) return null;
  let avail = 0;
  while (src[runStart + avail] === delim) avail++;
  if (kind === 'del') {
    const runs = avail >= 2 ? [2, 1] : [1];
    for (let g = 1; g <= 6; g++) {
      for (const runLen of runs) {
        if (delGroupOk(g, ctx, src, runStart, runLen)) {
          return { index: p, end: runStart + runLen, group: g, runStart, runLen };
        }
      }
    }
    return null;
  }
  const tail = codePointAt(src, runStart + avail);
  const group = kind === 'ast' ? astGroup(ctx, tail) : undGroup(ctx, tail);
  if (group === 0) return null;
  return { index: p, end: runStart + avail, group, runStart, runLen: avail };
}

function delGroupOk(g, ctx, src, runStart, runLen) {
  const tail = codePointAt(src, runStart + runLen);
  const afterIsTilde = src[runStart + runLen] === '~';
  switch (g) {
    case 1: return isPunctNoTilde(ctx) && (tail === '' || isJsSpace(tail));
    case 2: return isWordy(ctx) && !afterIsTilde && (tail === '' || isSpacePunct(tail));
    case 3: return isSpacePunctNoTilde(ctx) && tail !== '' && isWordy(tail);
    case 4: return isJsSpace(ctx) && !afterIsTilde && tail !== '' && isPunct(tail);
    case 5: return isPunctNoTilde(ctx) && !afterIsTilde && tail !== '' && isPunct(tail);
    case 6: return isWordy(ctx) && tail !== '' && isWordy(tail);
  }
  return false;
}

// Sequential matches over the masked tail starting at base, in the same
// order a global pattern execution would produce them.
function createRDelimScanner(src, kind, base) {
  let pos = base;
  return {
    next() {
      let p = pos;
      while (p < src.length) {
        if (p === base) {
          const end = kind === 'del'
            ? base + textSkipLength(src, base, '~')
            : alt1SkipEnd(src, base, kind);
          if (end > base) {
            pos = end;
            return { index: base, end, group: 0, runStart: base, runLen: 0 };
          }
        }
        if (kind !== 'del') {
          const skip = textSkipLength(src, p, kind === 'ast' ? '*' : '_');
          if (skip > 0) {
            pos = p + skip;
            return { index: p, end: p + skip, group: 0, runStart: p, runLen: 0 };
          }
        }
        const m = matchRDelimGroup(src, p, kind);
        if (m) { pos = m.end; return m; }
        p += codePointAt(src, p).length;
      }
      pos = p;
      return null;
    },
  };
}

// The simple emphasis shape, resolved without the mask or the classified
// scan: content with no delimiter of the same kind, no mask-relevant
// characters and no paired other-delimiter, a wordy final character, and a
// closer run of exactly the opener's length whose following character
// class closes in the full algorithm (for equal run lengths the rule of
// three can never skip the match). Returns the token, or undefined when
// the shape is not simple.
function simpleEmClose(ctx, src, i, k, delim) {
  const base = i + k;
  const closerStart = src.indexOf(delim, base);
  if (closerStart === -1) return undefined;
  let b = 1;
  while (src[closerStart + b] === delim) b++;
  if (b !== k) return undefined;
  const content = src.slice(base, closerStart);
  if (content === '') return undefined;
  if (content.includes('\\') || content.includes('`') ||
      content.includes('[') || content.includes('<')) return undefined;
  if (delim === '*' ? content.includes('__') : content.includes('**')) return undefined;
  const lastCp = codePointBefore(content, content.length);
  if (delim === '*' ? !isWordyAst(lastCp) : !isWordy(lastCp)) return undefined;
  const tail = codePointAt(src, closerStart + b);
  if (delim === '*') {
    if (tail !== '' && !isSpacePunctNoTilde(tail) && !isWordyAst(tail)) return undefined;
  } else if (tail !== '' && !isSpacePunct(tail)) {
    return undefined;
  }
  const raw = src.slice(i, closerStart + b);
  const odd = k % 2 === 1;
  const text = odd ? raw.slice(1, -1) : raw.slice(2, -2);
  return { type: odd ? 'em' : 'strong', raw, text, tokens: inlineTokens(ctx, text) };
}

// The simple strikethrough shape, mirroring simpleEmClose: with a wordy
// final content character, the closer classification always matches.
function simpleDelClose(ctx, src, i, o) {
  const base = i + o;
  const closerStart = src.indexOf('~', base);
  if (closerStart === -1) return undefined;
  let b = 1;
  while (src[closerStart + b] === '~') b++;
  if (b !== o) return undefined;
  const content = src.slice(base, closerStart);
  if (content === '') return undefined;
  if (content.includes('\\') || content.includes('`') ||
      content.includes('[') || content.includes('<')) return undefined;
  const lastCp = codePointBefore(content, content.length);
  if (!isWordy(lastCp)) return undefined;
  const raw = src.slice(i, closerStart + b);
  const text = raw.slice(o, raw.length - o);
  return { type: 'del', raw, text, tokens: inlineTokens(ctx, text) };
}

// The emphasis attempt at src[i] ('*' or '_'), following the reference
// algorithm: validate the opener against its masked surroundings, then scan
// classified closer runs, tracking opener balance and the rule of three.
function tryEmStrong(ctx, frame, src, i, prevChar) {
  const delim = src[i];
  let runEnd = i;
  while (src[runEnd] === delim) runEnd++;
  const runLen = runEnd - i;
  const follower = codePointAt(src, runEnd);
  let punctGroup = false;
  let otherGroup = false;
  if (follower !== '') {
    if (follower !== '~' && isPunct(follower)) punctGroup = true;
    else if (!isJsSpace(follower) && follower !== delim) otherGroup = true;
  }
  if (!punctGroup && !otherGroup) return null;
  // Fast path, valid only when the opener is not the tail of a longer run
  // (so the masked backscan cannot move it) and nothing earlier in the
  // segment failed to tokenise (so no block-skip span can cover the closer).
  if (!frame.risk && prevChar !== delim && (i === 0 || src[i - 1] !== delim)) {
    if (delim === '_' && otherGroup && ALPHA_NUMERIC.test(prevChar)) return null;
    if (punctGroup && prevChar !== '' && !punctRule(prevChar)) return null;
    const fast = simpleEmClose(ctx, src, i, runLen, delim);
    if (fast) return fast;
  }
  ensureMask(ctx, frame, src);
  const masked = frame.masked;
  let n = prevChar;
  const prevIsDelim = n === delim;
  // Backscan over a run the previous token may have partially consumed.
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const before = l > 0 ? codePointBefore(masked, l) : '';
  const beforePunct = before !== '' && isSpacePunct(before);
  if (l < i) n = before;
  const u = l < i ? beforePunct : punctRule(n);
  if (delim === '_' && otherGroup && ALPHA_NUMERIC.test(n)) return null;
  if (punctGroup && n !== '' && !u) return null;
  const k = runLen;
  let m = k;
  let f = 0;
  const y = i - l + k;
  const R = before !== '' && before.trim() !== '' && (punctGroup || (delim === '*' && !beforePunct));
  const lastCloser = delim === '*' ? frame.bounds.star : frame.bounds.und;
  const base = i + k;
  if (lastCloser < base) return null;
  const maxIndex = lastCloser - base;
  const scanner = createRDelimScanner(masked, delim === '*' ? 'ast' : 'und', base);
  let match;
  while ((match = scanner.next()) !== null) {
    const relIndex = match.index - base;
    if (relIndex > maxIndex) break;
    const g = match.group;
    if (g === 0) continue;
    const b = match.runLen;
    if (g === 3 || g === 4) { m += b; continue; }
    if (g === 5 || g === 6 || R) {
      if (prevIsDelim && (g === 5 || g === 6)) break;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    const used = Math.min(b, b + m + f);
    const ctxLen = codePointAt(masked, match.index).length;
    const raw = src.slice(i, i + k + relIndex + ctxLen + used);
    if (Math.min(k, used) % 2 === 1) {
      const text = raw.slice(1, -1);
      return { type: 'em', raw, text, tokens: inlineTokens(ctx, text) };
    }
    const text = raw.slice(2, -2);
    return { type: 'strong', raw, text, tokens: inlineTokens(ctx, text) };
  }
  return null;
}

// The strikethrough attempt at src[i] ('~'): like emphasis, but the closer
// run must have exactly the opener's length.
function tryDel(ctx, frame, src, i, prevChar) {
  const runLen = src[i + 1] === '~' ? 2 : 1;
  const follower = codePointAt(src, i + runLen);
  if (follower === '') return null;
  const punctFollower = isPunctNoTilde(follower);
  const otherFollower = !punctFollower && !isJsSpace(follower) && follower !== '~';
  if (!punctFollower && !otherFollower) return null;
  if (!punctFollower && prevChar !== '' && !punctRule(prevChar)) return null;
  const o = runLen;
  if (!frame.risk) {
    const fast = simpleDelClose(ctx, src, i, o);
    if (fast) return fast;
  }
  ensureMask(ctx, frame, src);
  const masked = frame.masked;
  const base = i + o;
  if (frame.bounds.tilde < base) return null;
  const maxIndex = frame.bounds.tilde - base;
  let p = o;
  const scanner = createRDelimScanner(masked, 'del', base);
  let match;
  while ((match = scanner.next()) !== null) {
    const relIndex = match.index - base;
    if (relIndex > maxIndex) break;
    const g = match.group;
    if (g === 0) continue;
    const len = match.runLen;
    if (len !== o) continue;
    if (g === 3 || g === 4) { p += len; continue; }
    p -= len;
    if (p > 0) continue;
    const used = Math.min(len, len + p);
    const ctxLen = codePointAt(masked, match.index).length;
    const raw = src.slice(i, i + o + relIndex + ctxLen + used);
    const text = raw.slice(o, raw.length - o);
    return { type: 'del', raw, text, tokens: inlineTokens(ctx, text) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Remaining inline tokenisers and the inline loop
// ---------------------------------------------------------------------------

const ESCAPE_CHARS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function tryEscape(src, i) {
  if (src[i] !== '\\') return null;
  const c = src[i + 1];
  if (c === undefined || !ESCAPE_CHARS.includes(c)) return null;
  return { type: 'escape', raw: src.slice(i, i + 2), text: c };
}

const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;

function tryTag(ctx, src, i) {
  const len = matchTagAt(src, i);
  if (len === -1) return null;
  const raw = src.slice(i, i + len);
  if (!ctx.state.inLink && START_A_TAG.test(raw)) ctx.state.inLink = true;
  else if (ctx.state.inLink && END_A_TAG.test(raw)) ctx.state.inLink = false;
  if (!ctx.state.inRawBlock && START_PRE_TAG.test(raw)) ctx.state.inRawBlock = true;
  else if (ctx.state.inRawBlock && END_PRE_TAG.test(raw)) ctx.state.inRawBlock = false;
  return {
    type: 'html', raw, inLink: ctx.state.inLink,
    inRawBlock: ctx.state.inRawBlock, block: false, text: raw,
  };
}

function tryCodespan(src, i) {
  let run = 0;
  while (src[i + run] === '`') run++;
  if (run === 0) return null;
  const close = findCodeSpanClose(src, i + run, run);
  if (close === -1) return null;
  const raw = src.slice(i, close);
  let text = src.slice(i + run, close - run).replace(/\n/g, ' ');
  if (/\S/.test(text) && text.startsWith(' ') && text.endsWith(' ')) {
    text = text.slice(1, -1);
  }
  return { type: 'codespan', raw, text };
}

function tryBr(src, i) {
  let j;
  if (src[i] === '\\') {
    j = i + 1;
  } else if (src[i] === ' ') {
    let k = i;
    while (src[k] === ' ') k++;
    if (k - i < 2) return null;
    j = k;
  } else return null;
  if (src[j] !== '\n') return null;
  // A hard break cannot be the last thing in the text.
  let q = j + 1;
  while (q < src.length && isJsSpace(src[q])) q++;
  if (q >= src.length) return null;
  let end = j + 1;
  while (src[end] === ' ' || src[end] === '\t') end++;
  return { type: 'br', raw: src.slice(i, end) };
}

function tryAutolink(src, i) {
  const m = matchAutolinkAt(src, i);
  if (!m) return null;
  const raw = src.slice(i, i + m.len);
  const text = raw.slice(1, -1);
  return {
    type: 'link', raw, text, href: m.email ? 'mailto:' + text : text,
    autolink: true, tokens: [{ type: 'text', raw: text, text }],
  };
}

const URL_LOCAL = /[A-Za-z0-9._+-]/;
const URL_DOMAIN_CHAR = /[A-Za-z0-9-_]/;

// The domain part shared by the extended email forms: a first label, then
// one or more dot groups each ending in an alphanumeric, and the next char
// must not be a word char or '-'. Returns the end index or -1.
function autolinkDomainEnd(src, j) {
  let k = j;
  while (k < src.length && URL_DOMAIN_CHAR.test(src[k])) k++;
  if (k === j) return -1;
  let groups = 0;
  for (;;) {
    if (src[k] !== '.') break;
    let m = k + 1;
    while (m < src.length && URL_DOMAIN_CHAR.test(src[m])) m++;
    let e = m;
    while (e > k + 1 && !isAlnum(src[e - 1])) e--;
    if (e === k + 1) break;
    k = e;
    groups++;
  }
  if (groups === 0) return -1;
  if (k < src.length && /[\w-]/.test(src[k])) return -1;
  return k;
}

// The extended-autolink attempt at src[i]: mailto:/xmpp: forms, protocol and
// www. forms, and bare emails. Returns { raw, email, www } or null.
function matchUrl(src, i) {
  for (const scheme of ['mailto:', 'xmpp:']) {
    if (src.startsWith(scheme, i)) {
      let j = i + scheme.length;
      const localStart = j;
      while (j < src.length && URL_LOCAL.test(src[j])) j++;
      if (j > localStart && src[j] === '@') {
        const end = autolinkDomainEnd(src, j + 1);
        if (end !== -1) {
          let e = end;
          if (scheme === 'xmpp:' && src[e] === '/') {
            let r = e + 1;
            while (r < src.length && /[A-Za-z0-9@.]/.test(src[r])) r++;
            if (r > e + 1) e = r;
          }
          return { raw: src.slice(i, e), email: false, www: false };
        }
      }
      return null;
    }
  }
  // Protocol or www. form.
  let j = -1;
  let www = false;
  if (src.startsWith('www.', i)) {
    j = i + 4;
    www = true;
  } else {
    const c = src[i];
    if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
      let k = i;
      const word = (w) => {
        for (let x = 0; x < w.length; x++) {
          const ch = src[k + x];
          if (ch === undefined || ch.toLowerCase() !== w[x]) return false;
        }
        return true;
      };
      if (word('http')) {
        k = i + 4;
        if (src[k] === 's' || src[k] === 'S') k++;
        if (src.startsWith('://', k)) j = k + 3;
      } else if (word('ftp')) {
        if (src.startsWith('://', i + 3)) j = i + 6;
      }
    }
  }
  if (j !== -1) {
    if (!/[A-Za-z0-9-]/.test(src[j] ?? '')) return null;
    let e = j;
    while (e < src.length && !isJsSpace(src[e]) && src[e] !== '<') e++;
    return { raw: src.slice(i, e), email: false, www };
  }
  // Bare email form.
  let k = i;
  while (k < src.length && URL_LOCAL.test(src[k])) k++;
  if (k > i && src[k] === '@') {
    const end = autolinkDomainEnd(src, k + 1);
    if (end !== -1) return { raw: src.slice(i, end), email: true, www: false };
  }
  return null;
}

const BACKPEDAL_BAD = new Set(['?', '!', '.', ',', ':', ';', '*', '_', "'", '"', '~', ')']);

// One backpedal pass over an extended-autolink candidate: the longest prefix
// made of good chunks (plain runs, balanced paren groups, ampersands that do
// not end an entity, and bad-char runs that are not at the end).
function backpedalOnce(s) {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(') {
      const close = s.indexOf(')', i + 1);
      if (close === -1) break;
      i = close + 1;
    } else if (c === '&') {
      let j = i + 1;
      while (j < s.length && isAlnum(s[j])) j++;
      if (j > i + 1 && j === s.length - 1 && s[j] === ';') break;
      i++;
    } else if (BACKPEDAL_BAD.has(c)) {
      let j = i;
      while (j < s.length && BACKPEDAL_BAD.has(s[j])) j++;
      if (j === s.length) {
        if (j - i >= 2) { i = j - 1; } else break;
      } else i = j;
    } else {
      let j = i;
      while (j < s.length && !BACKPEDAL_BAD.has(s[j]) && s[j] !== '(' && s[j] !== '&') j++;
      i = j;
    }
  }
  return s.slice(0, i);
}

function tryUrl(ctx, src, i) {
  if (ctx.state.inLink) return null;
  const m = matchUrl(src, i);
  if (!m) return null;
  let text;
  let href;
  if (m.email) {
    text = m.raw;
    href = 'mailto:' + m.raw;
  } else {
    text = m.raw;
    let prev;
    do {
      prev = text;
      text = backpedalOnce(text);
    } while (prev !== text);
    href = m.www ? 'http://' + text : text;
  }
  return {
    type: 'link', raw: text, text, href, autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

// --- plain text ------------------------------------------------------------

function hardBreakAhead(src, p) {
  let k = p;
  while (src[k] === ' ') k++;
  return k - p >= 2 && src[k] === '\n';
}

function emailAhead(src, p) {
  const at = src.indexOf('@', p);
  if (at <= p) return false;
  for (let k = p; k < at; k++) {
    if (!isEmailLocalChar(src[k])) return false;
  }
  return true;
}

function httpAhead(src, q) {
  const a = src[q], b = src[q + 1], c = src[q + 2], d = src[q + 3];
  return (a === 'h' || a === 'H') && (b === 't' || b === 'T') &&
    (c === 't' || c === 'T') && (d === 'p' || d === 'P');
}

function ftpAhead(src, q) {
  const a = src[q], b = src[q + 1], c = src[q + 2];
  return (a === 'f' || a === 'F') && (b === 't' || b === 'T') &&
    (c === 'p' || c === 'P') && src.startsWith('://', q + 3);
}

function wwwAhead(src, q) {
  if (!src.startsWith('www.', q)) return false;
  if (q === 0) return true;
  const prev = src[q - 1];
  return isJsSpace(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(';
}

// Candidate stop positions for the plain-text scan: construct characters,
// scheme and domain prefixes, '@', and space runs that reach a newline.
const TEXT_STOP_RE = /\\|<|!|\[|`|\*|~|_|http|ftp|www\.|mailto:|xmpp:|@| +(?= *\n)/gi;

// How far a plain-text chunk extends from src[i], mirroring the reference
// text pattern: a head (a backtick/tilde run or one char), then either an
// immediate stop or a lazy scan for the next construct that needs handling.
function textAdvance(src, i) {
  const len = src.length;
  // A lone char right before a mailto:/xmpp: scheme is its own chunk.
  if (!isAlnum(src[i]) && (src.startsWith('mailto:', i + 1) || src.startsWith('xmpp:', i + 1))) {
    return i + 1;
  }
  let j;
  if (src[i] === '`' || src[i] === '~') {
    j = i;
    while (src[j] === src[i]) j++;
  } else {
    j = i + 1;
  }
  if (src[j] === '`' || src[j] === '~') return j;
  if (hardBreakAhead(src, j)) return j;
  if (emailAhead(src, j)) return j;
  // Scan for the next position where the chunk must end. The pattern finds
  // every candidate (construct characters, scheme/domain prefixes, '@', and
  // space runs reaching a newline); each candidate is then verified with
  // exactly the rule the reference text pattern applies at that position.
  TEXT_STOP_RE.lastIndex = j;
  let m;
  while ((m = TEXT_STOP_RE.exec(src)) !== null) {
    const p = m.index;
    const t = m[0];
    const c0 = t[0];
    if (c0 === ' ') {
      // A hard break ends the chunk at the start of the space run, unless
      // the run began before the scan position.
      if (t.length >= 2 && src[p - 1] !== ' ') return p;
      continue;
    }
    if (c0 === '@') {
      // An email's local run ends the chunk at the run's start.
      let s = p;
      while (s > j && isEmailLocalChar(src[s - 1])) s--;
      if (s > j) return s;
      continue;
    }
    if (c0 === 'h' || c0 === 'H') {
      const s = emailRunPreempts(src, p, j);
      return s === -1 ? p : s;
    }
    if (c0 === 'f' || c0 === 'F') {
      if (ftpAhead(src, p)) {
        const s = emailRunPreempts(src, p, j);
        return s === -1 ? p : s;
      }
      continue;
    }
    if (c0 === 'w' || c0 === 'W') {
      if (wwwAhead(src, p)) {
        const s = emailRunPreempts(src, p, j);
        return s === -1 ? p : s;
      }
      continue;
    }
    if (c0 === 'm' || c0 === 'x' || c0 === 'M' || c0 === 'X') {
      // mailto:/xmpp: at p ends the chunk at p when the char before the
      // scheme is not alphanumeric (and the scheme really starts there).
      if (p > j && !isAlnum(src[p - 1]) &&
          (src.startsWith('mailto:', p) || src.startsWith('xmpp:', p))) return p;
      continue;
    }
    // A construct character. A backtick can sit inside an email local run;
    // that run's start wins when it forms an email.
    if (c0 === '`') {
      const s = emailRunPreempts(src, p, j);
      if (s !== -1) return s;
    }
    return p;
  }
  return len;
}

// If the maximal email-local run ending at p - 1 starts after j and reaches
// an '@', the reference scan stops at the run's start, before p. Returns
// that start, or -1.
function emailRunPreempts(src, p, j) {
  if (p <= j || !isEmailLocalChar(src[p - 1])) return -1;
  let s = p - 1;
  while (s > j && isEmailLocalChar(src[s - 1])) s--;
  if (s <= j) return -1;
  return emailAhead(src, s) ? s : -1;
}

// Whether a link label is transparent to the emphasis mask's block-skip
// step, whose label grammar only knows plain characters and code spans
// with equal opening and closing runs: any other backtick run, or an angle
// bracket, can make that step lose the link span and pair a label backtick
// with one far ahead, hiding later delimiters.
function labelMaskSafe(label) {
  let i = 0;
  while (i < label.length) {
    const c = label[i];
    if (c === '<') return false;
    if (c === '`') {
      let run = 0;
      while (label[i + run] === '`') run++;
      let k = i + run;
      while (k < label.length && label[k] !== '`') k++;
      if (k >= label.length) return false;
      let closeRun = 0;
      while (label[k + closeRun] === '`') closeRun++;
      if (closeRun !== run) return false;
      i = k + closeRun;
      continue;
    }
    i++;
  }
  return true;
}

// The emphasis mask for one inline segment, built on first use: many
// segments carry delimiter characters only inside constructs the loop
// consumes whole, and never need it.
function ensureMask(ctx, frame, src) {
  if (frame.masked === null) {
    // With no bracket, backtick, angle bracket or backslash in the segment,
    // every mask step is the identity.
    frame.masked = (src.includes('[') || src.includes('`') ||
      src.includes('<') || src.includes('\\')) ? applyMask(ctx, src) : src;
    frame.bounds = computeBounds(frame.masked);
  }
}

// Tokenise one inline string. Reference definitions come from the lexer's
// shared table; nested calls (link labels, emphasis contents) recurse with
// the same state.
function inlineTokens(ctx, src) {
  const prevParen = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = prevParen && src.includes(')');
  const tokens = inlineLoop(ctx, src);
  ctx.state.linkParenPossible = prevParen;
  return tokens;
}

function inlineLoop(ctx, src) {
  const tokens = [];
  const frame = { masked: null, bounds: null, risk: false };
  const hasAt = src.includes('@');
  let i = 0;
  let prevChar = '';
  let keepPrev = false;
  while (i < src.length) {
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    const c = src[i];
    let tok = null;
    if (c === '\\') {
      tok = tryEscape(src, i) ?? tryBr(src, i);
    } else if (c === '<') {
      tok = tryTag(ctx, src, i) ?? tryAutolink(src, i);
      // A '<' that forms no tag can still open a block-skip span in the
      // emphasis mask, so later delimiters must take the full path. A tag
      // whose raw holds an earlier '>' ends that step's span early, which
      // is just as unsafe.
      if (!tok) frame.risk = true;
      else if (tok.type === 'html' && tok.raw.slice(0, -1).includes('>')) frame.risk = true;
    } else if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      tok = tryLink(ctx, src, i) ?? tryReflink(ctx, src, i);
      if (!tok || tok.type === 'text') frame.risk = true;
      else if ((tok.type === 'link' || tok.type === 'image') && !labelMaskSafe(tok.text)) frame.risk = true;
    } else if (c === '*' || c === '_') {
      tok = tryEmStrong(ctx, frame, src, i, prevChar);
    } else if (c === '`') {
      tok = tryCodespan(src, i);
      if (!tok) frame.risk = true;
      else {
        // A code span whose content holds a backtick is paired differently
        // by the mask's block-skip step and can leak a span past its end.
        let run = 0;
        while (tok.raw[run] === '`') run++;
        if (tok.raw.slice(run, tok.raw.length - run).includes('`')) frame.risk = true;
      }
    } else if (c === '~') {
      tok = tryDel(ctx, frame, src, i, prevChar);
    } else if (c === ' ') {
      tok = tryBr(src, i);
    }
    if (!tok && !ctx.state.inLink &&
        ((c === 'w' && src.startsWith('www.', i)) ||
         ((c === 'h' || c === 'H') && httpAhead(src, i)) ||
         ((c === 'f' || c === 'F') && ftpAhead(src, i)) ||
         (c === 'm' && src.startsWith('mailto:', i)) ||
         (c === 'x' && src.startsWith('xmpp:', i)) ||
         (hasAt && isEmailLocalChar(c) && emailAhead(src, i)))) {
      tok = tryUrl(ctx, src, i);
    }
    if (tok) {
      if (tok.type === 'text') {
        // Only an unresolved reference produces a bare text token here; it
        // merges into a preceding text token just like a plain chunk does.
        const prev = tokens[tokens.length - 1];
        if (prev && prev.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else tokens.push(tok);
      } else {
        tokens.push(tok);
      }
      i += tok.raw.length;
      continue;
    }
    const end = textAdvance(src, i);
    const raw = src.slice(i, end);
    const inRaw = ctx.state.inRawBlock;
    const text = inRaw ? raw : decodeNumericRefs(raw);
    if (raw[raw.length - 1] !== '_') prevChar = raw[raw.length - 1];
    keepPrev = true;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.type === 'text') {
      prev.raw += raw;
      prev.text += text;
    } else {
      tokens.push({ type: 'text', raw, text, escaped: inRaw });
    }
    i = end;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Block level. A line-oriented lexer: each tokeniser inspects the remaining
// text and returns a token whose raw is exactly what it consumes (the driver
// advances by raw.length, so a tokeniser may leave trailing newlines behind
// for the space rule, exactly like the reference lexer).
// ---------------------------------------------------------------------------

// Queue inline work for the deferred pass: block tokens hold the tokens
// array, the queue holds the text to tokenise into it later.
function queueInline(ctx, text) {
  const tokens = [];
  ctx.queue.push({ src: text, tokens });
  return tokens;
}

function lineEndAt(src, pos) {
  const e = src.indexOf('\n', pos);
  return e === -1 ? src.length : e;
}

// --- line classifiers (line = one line, no trailing newline) ---------------

const HR_LINE_TEXT = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const HEADING_LINE_TEXT = /^ {0,3}#{1,6}([ \t]|$)/;
const BLOCKQUOTE_LINE_TEXT = /^ {0,3}>/;
const TABLE_DELIM_TEXT = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;

function isHrLineText(line) { return HR_LINE_TEXT.test(line); }

function isFencesLineText(line) {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return false;
  if (m[1][0] === '~') return true;
  return !line.slice(m[0].length).includes('`');
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col ' +
  'colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
  'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ' +
  'ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// The HTML interrupt prefix, case-sensitively (as in the paragraph grammar):
// a block tag followed by space, end of line or '>', or a script/comment/
// processing-instruction/declaration/CDATA opener.
function isHtmlInterruptText(line) {
  let i = 0;
  while (line[i] === ' ' && i < 3) i++;
  if (line[i] !== '<') return false;
  if (line.startsWith('<!--', i)) return true;
  if (line.startsWith('<?', i)) return true;
  if (line.startsWith('<![CDATA[', i)) return true;
  if (line[i + 1] === '!' && /[A-Za-z]/.test(line[i + 2] ?? '')) return true;
  let j = i + 1;
  const closing = line[j] === '/';
  if (closing) j++;
  let name = '';
  while (j < line.length && /[a-z0-9-]/.test(line[j])) { name += line[j]; j++; }
  if (name === '') return false;
  if (!closing && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    const after = line[j];
    return after === undefined || after === '>' || after === ' ' || after === '\t' ||
      after === '\n' || after === '\f' || after === '\r';
  }
  if (!BLOCK_TAGS.has(name)) return false;
  const rest = line.slice(j);
  return rest === '' || rest.startsWith(' ') || rest.startsWith('/>') || rest.startsWith('>');
}

// The first significant character of a line (after at most three spaces),
// which decides whether any interruption pattern can match at all.
function firstSignificant(line) {
  let s = 0;
  while (line[s] === ' ' && s < 3) s++;
  return line[s];
}

function isInterruptChar(c) {
  return c === '#' || c === '>' || c === '`' || c === '~' || c === '-' ||
    c === '*' || c === '_' || c === '+' || c === '1' || c === '<';
}

// Continuation-line interruption checks for the three grammar contexts.
function interruptsParagraph(line, hasNl) {
  const c = firstSignificant(line);
  if (c === undefined) return hasNl;
  if (!isInterruptChar(c)) {
    // Only the blank-line pattern can still fire (space/tab-led lines).
    if (c !== ' ' && c !== '\t') return false;
    return hasNl && line.length > 0 && /^[ \t]*$/.test(line);
  }
  if (line.length > 0 && /^[ \t]*$/.test(line) && hasNl) return true;
  if (isHrLineText(line)) return true;
  if (HEADING_LINE_TEXT.test(line)) return true;
  if (BLOCKQUOTE_LINE_TEXT.test(line)) return true;
  if (isFencesLineText(line)) return true;
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/.test(line)) return true;
  if (isHtmlInterruptText(line)) return true;
  return false;
}

function interruptsQuote(line, hasNl) {
  const c = firstSignificant(line);
  if (c === undefined) return hasNl;
  if (!isInterruptChar(c) && !(c >= '0' && c <= '9')) {
    if (c !== ' ' && c !== '\t') return false;
    return hasNl && line.length > 0 && /^[ \t]*$/.test(line);
  }
  if (line.length > 0 && /^[ \t]*$/.test(line) && hasNl) return true;
  if (isHrLineText(line)) return true;
  if (HEADING_LINE_TEXT.test(line)) return true;
  if (BLOCKQUOTE_LINE_TEXT.test(line)) return true;
  if (isFencesLineText(line)) return true;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])([ \t]|$)/.test(line)) return true;
  if (isHtmlInterruptText(line)) return true;
  return false;
}

function interruptsTableRow(line) {
  const c = firstSignificant(line);
  if (c !== undefined && c !== ' ' && c !== '\t' && !isInterruptChar(c)) return false;
  if (isHrLineText(line)) return true;
  if (HEADING_LINE_TEXT.test(line)) return true;
  if (BLOCKQUOTE_LINE_TEXT.test(line)) return true;
  if (line.startsWith('    ') ? line.length > 4 : /^ {0,3}\t/.test(line) && line.length > /^ {0,3}\t/.exec(line)[0].length) return true;
  if (isFencesLineText(line)) return true;
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(line)) return true;
  if (isHtmlInterruptText(line)) return true;
  return false;
}

// --- simple block tokenisers ------------------------------------------------

function trySpace(ctx, src) {
  let i = 0;
  let reps = 0;
  for (;;) {
    let j = i;
    while (src[j] === ' ' || src[j] === '\t') j++;
    if (src[j] === '\n') { i = j + 1; reps++; continue; }
    if (j === src.length) { i = j; reps++; break; }
    break;
  }
  if (reps === 0) return null;
  return { type: 'space', raw: src.slice(0, i) };
}

const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;

function tryIndentedCode(ctx, src) {
  let i = 0;
  let lines = 0;
  while (i < src.length) {
    let j = i;
    let indentOk = false;
    if (src.startsWith('    ', j)) { j += 4; indentOk = true; } else {
      let k = j;
      while (src[k] === ' ' && k - j < 3) k++;
      if (src[k] === '\t') { j = k + 1; indentOk = true; }
    }
    if (!indentOk) break;
    if (j >= src.length || src[j] === '\n') break;
    while (j < src.length && src[j] !== '\n') j++;
    lines++;
    i = j;
    if (src[i] !== '\n') break;
    // A newline plus any blank lines that follow belong to the match.
    let k = i + 1;
    for (;;) {
      let m = k;
      while (src[m] === ' ' || src[m] === '\t') m++;
      if (src[m] === '\n') { k = m + 1; continue; }
      if (m === src.length) k = m;
      break;
    }
    i = k;
  }
  if (lines === 0) return null;
  const raw = dropTrailingBlankLines(src.slice(0, i));
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(CODE_REMOVE_INDENT, '') };
}

// Remove up to `indent` columns of leading whitespace from each code line.
function fenceContent(raw, content) {
  const m = /^(\s+)(?:```)/.exec(raw);
  if (!m) return content;
  const indent = m[1].length;
  return content.split('\n').map((line) => {
    const b = /^\s+/.exec(line);
    if (!b) return line;
    return line.slice(Math.min(b[0].length, indent));
  }).join('\n');
}

function tryFences(ctx, src) {
  let i = 0;
  while (src[i] === ' ' && i < 3) i++;
  if (src[i] === ' ' && i === 3) return null; // four spaces: not a fence
  const fc = src[i];
  if (fc !== '`' && fc !== '~') return null;
  let runEnd = i;
  while (src[runEnd] === fc) runEnd++;
  const runLen = runEnd - i;
  if (runLen < 3) return null;
  const lineEnd = lineEndAt(src, runEnd);
  const info = src.slice(runEnd, lineEnd);
  if (fc === '`' && info.includes('`')) return null;
  const lang = info ? unescapePunct(info.trim()) : info;
  if (lineEnd === src.length) {
    const raw = src;
    return { type: 'code', raw, lang, text: fenceContent(raw, '') };
  }
  const contentStart = lineEnd + 1;
  // Find the first closing line, or run to the end of input.
  let p = contentStart;
  for (;;) {
    const end = closingFenceEnd(src, p, fc, runLen);
    if (end !== -1) {
      const raw = src.slice(0, end);
      const content = p === contentStart ? '' : src.slice(contentStart, p - 1);
      return { type: 'code', raw, lang, text: fenceContent(raw, content) };
    }
    const nl = src.indexOf('\n', p);
    if (nl === -1) break;
    p = nl + 1;
  }
  let content = src.slice(contentStart);
  if (content.endsWith('\n')) content = content.slice(0, -1);
  return { type: 'code', raw: src, lang, text: fenceContent(src, content) };
}

// If a fence-closing line starts at p, return the raw end (just past its
// trailing spaces); else -1.
function closingFenceEnd(src, p, fc, runLen) {
  let j = p;
  let sp = 0;
  while (src[j] === ' ' && sp < 3) { j++; sp++; }
  if (src[j] !== fc) return -1;
  let run = 0;
  while (src[j + run] === fc) run++;
  if (run < runLen) return -1;
  j += run;
  while (src[j] === ' ') j++;
  if (j >= src.length || src[j] === '\n') return j;
  return -1;
}

function tryHeading(ctx, src) {
  let i = 0;
  while (src[i] === ' ' && i < 3) i++;
  if (src[i] !== '#') return null;
  let j = i;
  while (src[j] === '#') j++;
  const depth = j - i;
  if (depth > 6) return null;
  const after = src[j];
  if (after !== undefined && after !== '\n' && !isJsSpace(after)) return null;
  const lineEnd = lineEndAt(src, j);
  let text = src.slice(j, lineEnd).trim();
  if (text.endsWith('#')) {
    const stripped = stripTrailing(text, '#');
    if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  let end = lineEnd;
  while (src[end] === '\n') end++;
  const raw = stripTrailing(src.slice(0, end), '\n');
  return { type: 'heading', raw, depth, text, tokens: queueInline(ctx, text) };
}

function tryHr(ctx, src) {
  let i = 0;
  while (src[i] === ' ' && i < 3) i++;
  const c = src[i];
  if (c !== '-' && c !== '_' && c !== '*') return null;
  const lineEnd = lineEndAt(src, i);
  const line = src.slice(i, lineEnd);
  let count = 0;
  for (const ch of line) {
    if (ch === c) count++;
    else if (ch !== ' ' && ch !== '\t') return null;
  }
  if (count < 3) return null;
  return { type: 'hr', raw: src.slice(0, lineEnd) };
}

// --- link reference definitions ----------------------------------------------

function defTitleSeparatorEnd(src, j) {
  if (src[j] === ' ') {
    let k = j;
    while (src[k] === ' ') k++;
    if (src[k] === '\n') {
      k++;
      while (src[k] === ' ' || src[k] === '\t') k++;
    }
    return k;
  }
  if (src[j] === '\n') {
    let k = j + 1;
    while (src[k] === ' ' || src[k] === '\t') k++;
    return k;
  }
  return -1;
}

// A definition title: like a link title, but single-quoted forms may not
// cross a blank line and paren forms may not nest.
function scanDefTitle(src, j) {
  const open = src[j];
  if (open === '"') return scanTitle(src, j);
  if (open === "'") {
    let k = j + 1;
    while (k < src.length) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === "'") return { raw: src.slice(j, k + 1), end: k + 1 };
      if (c === '\n' && src[k + 1] === '\n') return null;
      k++;
    }
    return null;
  }
  if (open === '(') {
    let k = j + 1;
    while (k < src.length) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === ')') return { raw: src.slice(j, k + 1), end: k + 1 };
      if (c === '(') return null;
      k++;
    }
    return null;
  }
  return null;
}

function tryDef(ctx, src) {
  let i = 0;
  while (src[i] === ' ' && i < 3) i++;
  if (src[i] !== '[') return null;
  const labelEnd = scanRefLabelEnd(src, i + 1);
  if (labelEnd === -1 || src[labelEnd + 1] !== ':') return null;
  const label = src.slice(i + 1, labelEnd);
  let j = labelEnd + 2;
  while (src[j] === ' ') j++;
  if (src[j] === '\n') {
    j++;
    while (src[j] === ' ' || src[j] === '\t') j++;
  }
  let hrefRaw;
  if (src[j] === '<') {
    const lineEnd = lineEndAt(src, j);
    const gt = src.indexOf('>', j + 1);
    if (gt === -1 || gt > lineEnd) return null;
    hrefRaw = src.slice(j, gt + 1);
    j = gt + 1;
  } else {
    if (j >= src.length || isJsSpace(src[j])) return null;
    let k = j;
    while (k < src.length && !isJsSpace(src[k])) k++;
    hrefRaw = src.slice(j, k);
    j = k;
  }
  let titleRaw;
  let end = -1;
  const sepEnd = defTitleSeparatorEnd(src, j);
  if (sepEnd !== -1) {
    const t = scanDefTitle(src, sepEnd);
    if (t) {
      let k = t.end;
      while (src[k] === ' ') k++;
      if (k >= src.length) { titleRaw = t.raw; end = k; }
      else if (src[k] === '\n') {
        while (src[k] === '\n') k++;
        titleRaw = t.raw;
        end = k;
      }
    }
  }
  if (end === -1) {
    let k = j;
    while (src[k] === ' ') k++;
    if (k >= src.length) end = k;
    else if (src[k] === '\n') {
      while (src[k] === '\n') k++;
      end = k;
    } else return null;
  }
  if (!hrefRaw.startsWith('<') && findClosing(hrefRaw, '()') !== -1) return null;
  const href = unescapePunct(hrefRaw.replace(/^<(.*)>$/, '$1'));
  const title = titleRaw !== undefined ? unescapePunct(titleRaw.slice(1, -1)) : undefined;
  return {
    type: 'def', tag: normalizeLabel(label),
    raw: stripTrailing(src.slice(0, end), '\n'), href, title,
  };
}

// --- HTML blocks ---------------------------------------------------------------

// The end of a type-6/7 HTML block: just past the final newline of the first
// blank-line run at or after `from`, or the end of input.
function htmlBlockEnd(src, from) {
  let p = from;
  while (p < src.length) {
    if (src[p] === '\n') {
      // Blank prefix starting here: only spaces, tabs, newlines.
      let q = p;
      let lastNl = -1;
      let count = 0;
      while (q < src.length && (src[q] === '\n' || src[q] === ' ' || src[q] === '\t')) {
        if (src[q] === '\n') { lastNl = q; count++; }
        q++;
      }
      if (count >= 2) return lastNl + 1;
      p = q;
      continue;
    }
    p++;
  }
  return src.length;
}

// After a construct that ends mid-line: consume the rest of the line and
// any run of newlines.
function restOfLineEnd(src, from) {
  let e = lineEndAt(src, from);
  while (src[e] === '\n') e++;
  return e;
}

function tryHtmlBlock(ctx, src) {
  let i = 0;
  while (src[i] === ' ' && i < 3) i++;
  if (src[i] !== '<') return null;
  const rest = src.slice(i);
  let m;
  // script / pre / style / textarea: raw until the matching close tag.
  if ((m = /^<(script|pre|style|textarea)(?=[\s>])/i.exec(rest))) {
    const name = m[1];
    const closeRe = new RegExp('</' + name, 'i');
    const cm = closeRe.exec(rest.slice(m[0].length));
    let end;
    if (cm) {
      const gt = rest.indexOf('>', m[0].length + cm.index + 2 + name.length);
      end = gt === -1 ? src.length : restOfLineEnd(src, i + gt + 1);
    } else end = src.length;
    const raw = dropTrailingBlankLines(src.slice(0, end));
    return {
      type: 'html', block: true, raw,
      pre: name === 'pre' || name === 'script' || name === 'style', text: raw,
    };
  }
  // Comment.
  if (rest.startsWith('<!--')) {
    let innerEnd;
    if (rest[4] === '>') innerEnd = 5;
    else if (rest[4] === '-' && rest[5] === '>') innerEnd = 6;
    else {
      const idx = rest.indexOf('-->', 4);
      innerEnd = idx === -1 ? rest.length : idx + 3;
    }
    const end = restOfLineEnd(src, i + innerEnd);
    const raw = dropTrailingBlankLines(src.slice(0, end));
    return { type: 'html', block: true, raw, pre: false, text: raw };
  }
  // Processing instruction.
  if (rest.startsWith('<?')) {
    const idx = rest.indexOf('?>', 2);
    const end = idx === -1 ? src.length : restOfLineEnd(src, i + idx + 2);
    const raw = dropTrailingBlankLines(src.slice(0, end));
    return { type: 'html', block: true, raw, pre: false, text: raw };
  }
  // CDATA.
  if (rest.startsWith('<![CDATA[')) {
    const idx = rest.indexOf(']]>', 9);
    const end = idx === -1 ? src.length : restOfLineEnd(src, i + idx + 3);
    const raw = dropTrailingBlankLines(src.slice(0, end));
    return { type: 'html', block: true, raw, pre: false, text: raw };
  }
  // Declaration: <! + letter.
  if (rest[1] === '!' && /[A-Za-z]/.test(rest[2] ?? '')) {
    const idx = rest.indexOf('>', 2);
    const end = idx === -1 ? src.length : restOfLineEnd(src, i + idx + 1);
    const raw = dropTrailingBlankLines(src.slice(0, end));
    return { type: 'html', block: true, raw, pre: false, text: raw };
  }
  // Block-level tag (open or close), case-insensitive at block level.
  if ((m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest))) {
    const name = m[2].toLowerCase();
    const after = rest.slice(m[0].length);
    const follows = after === '' || after.startsWith(' ') || after.startsWith('\t') ||
      after.startsWith('\n') || after.startsWith('>') || after.startsWith('/>');
    if (BLOCK_TAGS.has(name) && follows) {
      const end = htmlBlockEnd(src, i + m[0].length);
      const raw = dropTrailingBlankLines(src.slice(0, end));
      return { type: 'html', block: true, raw, pre: false, text: raw };
    }
    // Type 7: a complete open tag alone on its line.
    if (m[1] === '' && !/^(script|pre|style|textarea)(?![a-z0-9-])/i.test(m[2])) {
      const tagEnd = blockTagLineEnd(rest);
      if (tagEnd !== -1) {
        const end = htmlBlockEnd(src, i + tagEnd);
        const raw = dropTrailingBlankLines(src.slice(0, end));
        return { type: 'html', block: true, raw, pre: false, text: raw };
      }
    }
    // Type 7 closing form: a lone closing tag on its line.
    if (m[1] === '/') {
      const closeEnd = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/.exec(rest);
      if (closeEnd) {
        let k = closeEnd[0].length;
        while (rest[k] === ' ' || rest[k] === '\t') k++;
        if (k >= rest.length || rest[k] === '\n') {
          const end = htmlBlockEnd(src, i + k);
          const raw = dropTrailingBlankLines(src.slice(0, end));
          return { type: 'html', block: true, raw, pre: false, text: raw };
        }
      }
    }
  }
  return null;
}

// A complete type-7 open tag at the start of `rest`, alone on its line:
// returns the index just past the line's trailing spaces, or -1.
function blockTagLineEnd(rest) {
  let j = 1;
  while (j < rest.length && /[a-zA-Z0-9-]/.test(rest[j])) j++;
  for (;;) {
    let k = j;
    while (rest[k] === ' ') k++;
    if (rest[k] === '>') { j = k + 1; break; }
    if (rest[k] === '/' && rest[k + 1] === '>') { j = k + 2; break; }
    if (k === j) return -1;
    j = k;
    if (!/[a-zA-Z:_]/.test(rest[j] ?? '')) return -1;
    j++;
    while (j < rest.length && /[\w.:-]/.test(rest[j])) j++;
    let m2 = j;
    while (rest[m2] === ' ') m2++;
    if (rest[m2] === '=') {
      m2++;
      while (rest[m2] === ' ') m2++;
      const q = rest[m2];
      if (q === '"' || q === "'") {
        const e = rest.indexOf(q, m2 + 1);
        if (e === -1 || rest.slice(m2 + 1, e).includes('\n')) return -1;
        j = e + 1;
      } else {
        let v = m2;
        while (v < rest.length && !isJsSpace(rest[v]) && rest[v] !== '"' && rest[v] !== "'" &&
               rest[v] !== '=' && rest[v] !== '<' && rest[v] !== '>' && rest[v] !== '`') v++;
        if (v === m2) return -1;
        j = v;
      }
    }
  }
  while (rest[j] === ' ' || rest[j] === '\t') j++;
  if (j < rest.length && rest[j] !== '\n') return -1;
  return j;
}

// --- setext headings, paragraphs, plain text -----------------------------------

// The first line of a setext heading may not itself be another block start.
function lheadingFirstLineOk(line) {
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(line)) return false;
  if (/^(?: {4}| {0,3}\t)/.test(line)) return false;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return false;
  if (BLOCKQUOTE_LINE_TEXT.test(line)) return false;
  if (HEADING_LINE_TEXT.test(line)) return false;
  if (/^ {0,3}<[^\n>]+>$/.test(line)) return false;
  if (/^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/.test(line)) return false;
  return true;
}

function lheadingContinuationOk(line) {
  if (/^\s*$/.test(line)) return false;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(line)) return false;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return false;
  if (BLOCKQUOTE_LINE_TEXT.test(line)) return false;
  if (HEADING_LINE_TEXT.test(line)) return false;
  if (isHrLineText(line)) return false;
  if (/^ {0,3}<[^\n>]+>$/.test(line)) return false;
  if (/^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/.test(line)) return false;
  return true;
}

// Pure pattern test for a setext heading in the given text (no side effects):
// a valid first line, valid continuation lines, and an underline line.
function lheadingPatternTest(src) {
  const firstEnd = lineEndAt(src, 0);
  if (firstEnd === 0) return false;
  if (!lheadingFirstLineOk(src.slice(0, firstEnd))) return false;
  let pos = firstEnd;
  for (;;) {
    if (src[pos] !== '\n') return false;
    const start = pos + 1;
    const end = lineEndAt(src, start);
    const line = src.slice(start, end);
    if (/^ {0,3}(=+|-+)[ \t]*$/.test(line)) return true;
    if (!lheadingContinuationOk(line)) return false;
    pos = end;
  }
}

function tryLheading(ctx, src) {
  const firstEnd = lineEndAt(src, 0);
  if (firstEnd === 0) return null;
  const firstLine = src.slice(0, firstEnd);
  if (!lheadingFirstLineOk(firstLine)) return null;
  // Collect text lines until the underline.
  const lines = [firstLine];
  let pos = firstEnd;
  for (;;) {
    if (src[pos] !== '\n') return null;
    const start = pos + 1;
    const end = lineEndAt(src, start);
    const line = src.slice(start, end);
    const um = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (um) {
      const text = lines.join('\n').trim();
      let rawEnd = end;
      while (src[rawEnd] === '\n') rawEnd++;
      return {
        type: 'heading',
        raw: stripTrailing(src.slice(0, rawEnd), '\n'),
        depth: um[1][0] === '=' ? 1 : 2,
        text, tokens: queueInline(ctx, text),
      };
    }
    if (!lheadingContinuationOk(line)) return null;
    lines.push(line);
    pos = end;
  }
}

function tryParagraph(ctx, src) {
  const firstEnd = lineEndAt(src, 0);
  if (firstEnd === 0) return null;
  let end = firstEnd;
  let pos = firstEnd;
  for (;;) {
    if (src[pos] !== '\n') break;
    const start = pos + 1;
    if (start >= src.length) break;
    const lineEnd = lineEndAt(src, start);
    const line = src.slice(start, lineEnd);
    if (line === '') break;
    if (interruptsParagraph(line, lineEnd < src.length)) break;
    // A table starting on the next two lines also interrupts.
    if (matchTable(src, start, true)) break;
    end = lineEnd;
    pos = lineEnd;
  }
  const text = src.slice(0, end);
  return { type: 'paragraph', raw: text, text, tokens: queueInline(ctx, text) };
}

function tryBlockText(ctx, src) {
  const end = lineEndAt(src, 0);
  if (end === 0) return null;
  const raw = src.slice(0, end);
  return { type: 'text', raw, text: raw, tokens: queueInline(ctx, raw) };
}

// --- tables ---------------------------------------------------------------------

// Match the table pattern at src[pos..]: a header line, a delimiter row and
// body rows. With patternOnly set, the extra tokenizer checks (delimiter
// contains ':' or '|', matching cell counts) are skipped — that is the form
// embedded in the paragraph grammar.
function matchTable(src, pos, patternOnly) {
  const headerEnd = lineEndAt(src, pos);
  const headerLine = src.slice(pos, headerEnd);
  const hm = /^ *([^ ].*)$/.exec(headerLine);
  if (!hm) return null;
  if (src[headerEnd] !== '\n') return null;
  const delimStart = headerEnd + 1;
  const delimEnd = lineEndAt(src, delimStart);
  const delimLine = src.slice(delimStart, delimEnd);
  const dm = TABLE_DELIM_TEXT.exec(delimLine);
  if (!dm) return null;
  // Body rows: each row is a line that is neither blank nor a block start.
  let rowsText = '';
  let end = delimEnd;
  let p = delimEnd;
  for (;;) {
    if (src[p] !== '\n') break;
    const start = p + 1;
    const lineEnd = lineEndAt(src, start);
    const line = src.slice(start, lineEnd);
    if (lineEnd < src.length && /^ *$/.test(line)) break;
    if (interruptsTableRow(line)) break;
    rowsText += line + (lineEnd < src.length ? '\n' : '');
    end = lineEnd;
    p = lineEnd;
  }
  let rawEnd = end;
  while (src[rawEnd] === '\n') rawEnd++;
  const raw = stripTrailing(src.slice(pos, rawEnd), '\n');
  if (patternOnly) return { raw };
  if (!/[:|]/.test(dm[1])) return null;
  const headerCells = splitCells(hm[1]);
  const aligns = dm[1].replace(/^\||\| *$/g, '').split('|').map((cell) => {
    if (/^ *-+: *$/.test(cell)) return 'right';
    if (/^ *:-+: *$/.test(cell)) return 'center';
    if (/^ *:-+ *$/.test(cell)) return 'left';
    return null;
  });
  if (headerCells.length !== aligns.length) return null;
  const rowLines = rowsText.trim()
    ? rowsText.replace(/\n[ \t]*$/, '').split('\n')
    : [];
  return { headerCells, aligns, rowLines, raw };
}

function tryTable(ctx, src) {
  const m = matchTable(src, 0, false);
  if (!m) return null;
  const header = m.headerCells.map((cell, idx) => ({
    text: cell, tokens: queueInline(ctx, cell), header: true, align: m.aligns[idx],
  }));
  const rows = m.rowLines.map((line) =>
    splitCells(line, m.headerCells.length).map((cell, idx) => ({
      text: cell, tokens: queueInline(ctx, cell), header: false, align: m.aligns[idx],
    })));
  return { type: 'table', raw: m.raw, header, align: m.aligns, rows };
}

// --- blockquotes ---------------------------------------------------------------

const BLOCKQUOTE_START = /^ {0,3}>/;
const BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const BLOCKQUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_SETEXT2 = /^ {0,3}>[ \t]?/gm;

// The raw span of a blockquote match: consecutive marker lines, each with
// its lazy continuation lines, exactly as the blockquote grammar groups them.
function matchBlockquoteRaw(src) {
  let i = 0;
  let matched = false;
  while (i < src.length) {
    let j = i;
    let sp = 0;
    while (src[j] === ' ' && sp < 3) { j++; sp++; }
    if (src[j] !== '>') break;
    j++;
    if (src[j] === ' ') j++;
    const lineEnd = lineEndAt(src, j);
    const restBlank = /^[ \t]*$/.test(src.slice(j, lineEnd));
    let repEnd = lineEnd;
    if (!restBlank) {
      let k = lineEnd;
      while (src[k] === '\n') {
        const cs = k + 1;
        if (cs >= src.length) break;
        const ce = lineEndAt(src, cs);
        const cline = src.slice(cs, ce);
        if (cline === '') break;
        if (interruptsQuote(cline, ce < src.length)) break;
        repEnd = ce;
        k = ce;
      }
    }
    matched = true;
    i = repEnd;
    if (src[i] === '\n') i++;
    else break;
  }
  return matched ? src.slice(0, i) : null;
}

function tryBlockquote(ctx, src) {
  const matched = matchBlockquoteRaw(src);
  if (matched === null) return null;
  let lines = stripTrailing(matched, '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let seenMarker = false;
    const chunk = [];
    let p = 0;
    for (p = 0; p < lines.length; p++) {
      if (BLOCKQUOTE_START.test(lines[p])) { chunk.push(lines[p]); seenMarker = true; }
      else if (!seenMarker) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const chunkRaw = chunk.join('\n');
    const chunkText = chunkRaw
      .replace(BLOCKQUOTE_MARKER_WS, (g, b, m) => b + expandTabs(m, b.length))
      .replace(BLOCKQUOTE_SETEXT, '\n    $1')
      .replace(BLOCKQUOTE_SETEXT2, '');
    raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
    text = text ? text + '\n' + chunkText : chunkText;
    const prevTop = ctx.state.top;
    ctx.state.top = true;
    blockTokens(ctx, chunkText, tokens, true);
    ctx.state.top = prevTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' ||
                 last.type === 'html' || last.type === 'table')) break;
    if (last && last.type === 'blockquote') {
      const rest = lines.join('\n');
      const merged = tryBlockquote(ctx, last.raw + '\n' + rest.replace(BLOCKQUOTE_SETEXT2, ''));
      tokens[tokens.length - 1] = merged;
      const leftover = (last.raw + '\n' + rest.replace(BLOCKQUOTE_SETEXT2, ''))
        .substring(merged.raw.length).replace(/^\n/, '');
      const used = leftover ? leftover.split('\n').length : 0;
      const kept = used ? lines.slice(0, -used) : lines;
      if (kept.length > 0) raw += '\n' + kept.join('\n');
      text = text.substring(0, text.length - last.text.length) + merged.text;
      lines = lines.slice(kept.length);
      if (lines.length > 0 && BLOCKQUOTE_START.test(lines[0])) continue;
      break;
    }
    if (last && last.type === 'list') {
      const rest = lines.join('\n');
      const merged = tryList(ctx, last.raw + '\n' + rest);
      tokens[tokens.length - 1] = merged;
      const extra = merged.raw.length > last.raw.length
        ? (last.raw + '\n' + rest).slice(last.raw.length + 1, merged.raw.length).split('\n').length
        : 0;
      if (extra > 0) {
        const taken = lines.slice(0, extra).join('\n');
        raw += '\n' + taken;
        text += '\n' + taken;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

// --- lists -----------------------------------------------------------------------

const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const DOUBLE_BLANK_LINE = /\n[ \t]*\n[ \t]*$/;
const ANY_LINE = /\n.*\n/;
const NON_SPACE_CHAR = /[^ ]/;
const LEADING_SPACE_TAB = /^[ \t]+/;

// Scan a list marker at src start: up to 3 spaces, then a bullet or an
// ordered marker. Returns { indent, marker, ordered, delim } or null.
function scanListMarker(src) {
  let i = 0;
  while (src[i] === ' ' && i < 3) i++;
  const c = src[i];
  if (c === '*' || c === '+' || c === '-') {
    return { indent: i, marker: c, ordered: false, delim: c, end: i + 1 };
  }
  if (isDigit(c)) {
    let j = i;
    while (j < src.length && isDigit(src[j]) && j - i < 9) j++;
    if (src[j] === '.' || src[j] === ')') {
      return { indent: i, marker: src.slice(i, j + 1), ordered: true, delim: src[j], end: j + 1 };
    }
  }
  return null;
}

// Match one list item line against the list's bullet kind. Returns
// { markerLen, content } where content includes its leading space and the
// trailing newline, or null.
function matchListItem(src, listKind) {
  let i = 0;
  while (src[i] === ' ' && i < 3) i++;
  let markerEnd;
  if (!listKind.ordered) {
    if (src[i] !== listKind.delim) return null;
    markerEnd = i + 1;
  } else {
    let j = i;
    while (j < src.length && isDigit(src[j]) && j - i < 9) j++;
    if (j === i || src[j] !== listKind.delim) return null;
    markerEnd = j + 1;
  }
  let content = '';
  let pos = markerEnd;
  if (src[pos] === ' ' || src[pos] === '\t') {
    const lineEnd = lineEndAt(src, pos);
    content = src.slice(pos, lineEnd);
    pos = lineEnd;
  }
  if (src[pos] === '\n') { content += '\n'; pos++; }
  else if (pos < src.length) return null;
  return { markerLen: markerEnd, content, rawLen: pos };
}

function beginCheck(line, R, kind) {
  // All begin checks share a literal-space prefix of at most min(R - 1, 3).
  const cap = Math.max(0, Math.min(R - 1, 3));
  let i = 0;
  while (line[i] === ' ' && i < cap) i++;
  const rest = line.slice(i);
  switch (kind) {
    case 'fences': return rest.startsWith('```') || rest.startsWith('~~~');
    case 'heading': {
      const m = /^#{1,6}/.exec(rest);
      if (!m) return false;
      const after = rest[m[0].length];
      return after === undefined || isJsSpace(after);
    }
    case 'blockquote': return rest.startsWith('>');
    case 'html': return isHtmlBeginText(rest);
  }
  return false;
}

// All six list begin checks against one shared capped-indent remainder.
function beginBreaks(line, R) {
  const cap = Math.max(0, Math.min(R - 1, 3));
  let i = 0;
  while (line[i] === ' ' && i < cap) i++;
  const rest = line.slice(i);
  // None of the six checks can fire unless the remainder starts with one of
  // these characters (a marker, a fence/quote/heading/html opener, or a
  // digit for an ordered marker).
  const c0 = rest[0];
  if (c0 !== '`' && c0 !== '~' && c0 !== '>' && c0 !== '#' && c0 !== '<' &&
      c0 !== '-' && c0 !== '*' && c0 !== '+' && c0 !== '_' && !isDigit(c0)) {
    return false;
  }
  if (rest.startsWith('```') || rest.startsWith('~~~')) return true;
  if (rest.startsWith('>')) return true;
  if (rest[0] === '#') {
    const m = /^#{1,6}/.exec(rest);
    const after = rest[m[0].length];
    if (after === undefined || isJsSpace(after)) return true;
  }
  if (isHtmlBeginText(rest)) return true;
  const markerLen = markerAtExact(rest);
  if (markerLen > 0) {
    const after = rest[markerLen];
    if (after === undefined || after === ' ' || after === '\t') return true;
  }
  return hrBodyOk(rest);
}

// An hr body with no indent allowance left: only the marker char and
// spaces/tabs, at least three markers, to the end of the line.
function hrBodyOk(rest) {
  const c = rest[0];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let count = 0;
  for (const ch of rest) {
    if (ch === c) count++;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return count >= 3;
}

const HTML_BEGIN = /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|$|\/?>)/i;

function isHtmlBeginText(rest) {
  if (HTML_BEGIN.test(rest)) return true;
  if (/^<(script|pre|style|textarea)([\s>]|$)/i.test(rest)) return true;
  if (rest.startsWith('<!--')) return true;
  if (rest.startsWith('<?')) return true;
  if (/^<![A-Za-z]/.test(rest)) return true;
  if (rest.startsWith('<![CDATA[')) return true;
  return false;
}

function tryList(ctx, src) {
  const first = scanListMarker(src);
  if (!first) return null;
  // The list gate: marker plus optional line content, then newline or end.
  {
    let p = first.end;
    if (src[p] === ' ' || src[p] === '\t') p = lineEndAt(src, p);
    if (p < src.length && src[p] !== '\n') return null;
  }
  const markerText = src.slice(first.indent, first.end);
  const ordered = first.ordered;
  const list = {
    type: 'list', raw: '', ordered,
    start: ordered ? parseInt(markerText.slice(0, -1), 10) : '',
    loose: false, items: [],
  };
  const kind = { ordered, delim: first.delim };
  let rest = src;
  let prevItemBlankEnd = false;
  while (rest.length > 0) {
    const itemMatch = matchListItem(rest, kind);
    if (!itemMatch) break;
    // The hr check can only fire on a line led by -, * or _.
    const sig = firstSignificant(rest.slice(0, 4));
    if ((sig === '-' || sig === '*' || sig === '_') &&
        isHrLineText(rest.slice(0, lineEndAt(rest, 0)))) break;
    const itemStart = src.length - rest.length;
    rest = rest.substring(itemMatch.rawLen);
    const g = itemMatch.content.endsWith('\n') ? itemMatch.content.slice(0, -1) : itemMatch.content;
    const b = itemMatch.markerLen;
    // Tab expansion of the leading run is the identity when it has no tab.
    let m = g;
    {
      let li = 0;
      while (g[li] === ' ' || g[li] === '\t') li++;
      if (g.slice(0, li).includes('\t')) m = g.replace(LEADING_SPACE_TAB, (v) => expandTabs(v, b));
    }
    let isBlank = !m.trim();
    let R = 0;
    let text = '';
    if (isBlank) {
      R = b + 1;
    } else {
      R = m.search(NON_SPACE_CHAR);
      if (R > 4) R = 1;
      text = m.slice(R);
      R += b;
    }
    let endsList = false;
    if (isBlank) {
      const firstNl = rest.indexOf('\n');
      const firstLineOfRest = firstNl === -1 ? rest : rest.slice(0, firstNl);
      if (/^[ \t]*$/.test(firstLineOfRest)) {
        rest = rest.substring(firstLineOfRest.length + 1);
        endsList = true;
      }
    }
    if (!endsList) {
      while (rest.length > 0) {
        const nl = rest.indexOf('\n');
        const line = nl === -1 ? rest : rest.slice(0, nl);
        const firstCode = line.charCodeAt(0);
        let expanded = line;
        if (firstCode === 32 || firstCode === 9) {
          let li = 0;
          while (line[li] === ' ' || line[li] === '\t') li++;
          if (line.slice(0, li).includes('\t')) {
            expanded = line.replace(LEADING_SPACE_TAB, (v) => expandTabs(v, 0));
          }
        }
        if (beginBreaks(line, R)) break;
        if (expanded.search(NON_SPACE_CHAR) >= R || !line.trim()) {
          text += '\n' + expanded.slice(R);
        } else {
          if (isBlank || indentOfPrevLine(m) >= 4 ||
              beginCheck(m, R, 'fences') || beginCheck(m, R, 'heading') ||
              beginCheck(m, R, 'html') || hrBeginAt(m, R)) break;
          let piece = line;
          if (/^ {0,3}(?:=+|-+) *$/.test(line) && lheadingPatternTest(m + '\n' + line)) {
            piece = '    ' + expanded.replace(/^ {0,3}/, '');
          }
          text += '\n' + piece;
        }
        isBlank = !line.trim();
        rest = nl === -1 ? '' : rest.substring(nl + 1);
        m = expanded.slice(R);
      }
    }
    const itemRaw = src.slice(itemStart, src.length - rest.length);
    if (!list.loose) {
      if (prevItemBlankEnd) list.loose = true;
      else if (DOUBLE_BLANK_LINE.test(itemRaw)) prevItemBlankEnd = true;
    }
    list.items.push({
      type: 'list_item', raw: itemRaw,
      task: LIST_IS_TASK.test(text), loose: false, text, tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(0, src.length - rest.length).trimEnd();
  for (const item of list.items) {
    ctx.state.top = false;
    item.tokens = blockTokens(ctx, item.text, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter((tok) => tok.type === 'space');
      if (spaces.length > 0 && spaces.some((tok) => ANY_LINE.test(tok.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && firstTok && (firstTok.type === 'text' || firstTok.type === 'paragraph')) {
      item.text = item.text.replace(LIST_REPLACE_TASK, '');
      firstTok.raw = firstTok.raw.replace(LIST_REPLACE_TASK, '');
      firstTok.text = firstTok.text.replace(LIST_REPLACE_TASK, '');
      for (let gi = ctx.queue.length - 1; gi >= 0; gi--) {
        if (LIST_IS_TASK.test(ctx.queue[gi].src)) {
          ctx.queue[gi].src = ctx.queue[gi].src.replace(LIST_REPLACE_TASK, '');
          break;
        }
      }
      const km = LIST_TASK_CHECKBOX.exec(item.raw);
      if (km) {
        const checkbox = { type: 'checkbox', raw: km[0] + ' ', checked: km[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          const head = item.tokens[0];
          if (head && (head.type === 'paragraph' || head.type === 'text') && head.tokens) {
            head.raw = checkbox.raw + head.raw;
            head.text = checkbox.raw + head.text;
            head.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
}

function indentOfPrevLine(m) {
  return m.replace(/\t/g, '    ').search(NON_SPACE_CHAR);
}

// A list marker at the very start of `rest` (no indent allowed). Returns its
// length or 0.
function markerAtExact(rest) {
  const c = rest[0];
  if (c === '*' || c === '+' || c === '-') return 1;
  if (isDigit(c)) {
    let j = 0;
    while (j < rest.length && isDigit(rest[j]) && j < 9) j++;
    if (rest[j] === '.' || rest[j] === ')') return j + 1;
  }
  return 0;
}

// nextBulletRegex(R): a capped-indent marker, then a line-shaped tail (a
// space-led rest of line, or the end of the line).
function nextBulletAt(line, R) {
  const cap = Math.max(0, Math.min(R - 1, 3));
  let i = 0;
  while (line[i] === ' ' && i < cap) i++;
  const rest = line.slice(i);
  const markerLen = markerAtExact(rest);
  if (markerLen === 0) return false;
  const after = rest[markerLen];
  return after === undefined || after === ' ' || after === '\t';
}

// hrRegex(R): capped-indent hr body to end of line.
function hrBeginAt(line, R) {
  const cap = Math.max(0, Math.min(R - 1, 3));
  let i = 0;
  while (line[i] === ' ' && i < cap) i++;
  return hrBodyOk(line.slice(i));
}

// --- block driver --------------------------------------------------------------

function blockTokens(ctx, src, tokens, inRecursion) {
  let rest = src;
  let lastLen = Infinity;
  // marked gates the paragraph merge on a flag that starts as the recursion
  // flag and is cleared after the first paragraph token of the call, so in a
  // multi-chunk recursion only the first paragraph can merge with the last
  // token produced by the previous chunk.
  let canMergePara = inRecursion;
  while (rest.length > 0) {
    if (rest.length < lastLen) lastLen = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    let tok;
    if ((tok = trySpace(ctx, rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    if ((tok = tryIndentedCode(ctx, rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    if ((tok = tryFences(ctx, rest))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tryHeading(ctx, rest))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tryHr(ctx, rest))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tryBlockquote(ctx, rest))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tryList(ctx, rest))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tryHtmlBlock(ctx, rest))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tryDef(ctx, rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        if (!ctx.links[tok.tag]) ctx.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = tryTable(ctx, rest))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tryLheading(ctx, rest))) { rest = rest.substring(tok.raw.length); tokens.push(tok); continue; }
    if (ctx.state.top && (tok = tryParagraph(ctx, rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      const mergePara = canMergePara;
      canMergePara = false;
      if (mergePara && prev && prev.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    if ((tok = tryBlockText(ctx, rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  ctx.state.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`; break;
      case 'code': out += renderCode(tok); break;
      case 'table': out += renderTable(tok); break;
      case 'blockquote': out += `<blockquote>\n${renderTokens(tok.tokens)}</blockquote>\n`; break;
      case 'list': out += renderList(tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'html': out += tok.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(tok.tokens)}</p>\n`; break;
      case 'text': out += renderTextToken(tok); break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderCode(tok) {
  const langWord = (tok.lang || '').match(/^\S*/)[0];
  const body = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
  const content = tok.escaped ? body : escapeHtml(body, true);
  return langWord
    ? `<pre><code class="language-${escapeHtml(langWord)}">${content}</code></pre>\n`
    : `<pre><code>${content}</code></pre>\n`;
}

function renderList(list) {
  let body = '';
  for (const item of list.items) {
    body += `<li>${renderTokens(item.tokens)}</li>\n`;
  }
  const tag = list.ordered ? 'ol' : 'ul';
  const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
  return `<${tag}${start}>\n${body}</${tag}>\n`;
}

function renderCheckbox(tok) {
  return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTable(table) {
  let headerCells = '';
  for (const cell of table.header) headerCells += renderTableCell(cell);
  let body = '';
  for (const row of table.rows) {
    let cells = '';
    for (const cell of row) cells += renderTableCell(cell);
    body += `<tr>\n${cells}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n<tr>\n${headerCells}</tr>\n</thead>\n${body}</table>\n`;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return `${open}${renderInline(cell.tokens)}</${tag}>\n`;
}

function renderTextToken(tok) {
  if (tok.tokens) return renderInline(tok.tokens);
  if ('escaped' in tok && tok.escaped) return tok.text;
  return escapeHtml(tok.text);
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += renderTextToken(tok); break;
      case 'html': out += tok.text; break;
      case 'link': out += renderLink(tok); break;
      case 'image': out += renderImage(tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'strong': out += `<strong>${renderInline(tok.tokens)}</strong>`; break;
      case 'em': out += `<em>${renderInline(tok.tokens)}</em>`; break;
      case 'codespan': out += `<code>${escapeHtml(tok.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInline(tok.tokens)}</del>`; break;
      case 'text': out += renderTextToken(tok); break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderLink(tok) {
  const body = tok.autolink ? escapeHtml(tok.text, true) : renderInline(tok.tokens);
  const cleaned = cleanUrl(tok.href);
  if (cleaned === null) return body;
  let out = `<a href="${escapeHtml(cleaned, tok.autolink)}"`;
  if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
  return out + '>' + body + '</a>';
}

function renderImage(tok) {
  const alt = tok.tokens ? renderInlineTextOnly(tok.tokens) : tok.text;
  const cleaned = cleanUrl(tok.href);
  if (cleaned === null) return escapeHtml(alt);
  let out = `<img src="${escapeHtml(cleaned)}" alt="${escapeHtml(alt)}"`;
  if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
  return out + '>';
}

// The plain-text rendering used for image alt text: constructs render as
// their textual content.
function renderInlineTextOnly(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text': out += tok.text; break;
      case 'escape': out += tok.text; break;
      case 'html': out += tok.text; break;
      case 'codespan': out += tok.text; break;
      case 'br': break;
      case 'checkbox': out += tok.raw; break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += tok.tokens ? renderInlineTextOnly(tok.tokens) : tok.text;
        break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const ctx = {
    links: Object.create(null),
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
    queue: [],
    tokens: [],
  };
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  blockTokens(ctx, src, ctx.tokens, false);
  for (let q = 0; q < ctx.queue.length; q++) {
    const entry = ctx.queue[q];
    ctx.state.inRawBlock = false;
    for (const tok of inlineTokens(ctx, entry.src)) entry.tokens.push(tok);
  }
  return renderTokens(ctx.tokens);
}
