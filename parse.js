// markdown-fast — a Markdown renderer written from scratch whose output is,
// for every input, byte-for-byte the HTML that marked 18.1.3 emits with its
// default options (gfm: true, breaks: false, pedantic: false), while running
// faster than marked itself.
//
// How it works: the block stage walks the source line by line using small
// hand-written scanners rather than grammar-wide regular expressions, and
// the inline stage makes one index-driven pass over each block's text.
// Emphasis and strikethrough are settled by a delimiter-run search over a
// masked copy of the inline text (code spans, link destinations and raw
// HTML are blanked out first), so delimiters inside those constructs can
// never be picked as closers. parse() derives everything from its argument
// on every call: nothing is cached or carried between calls.

// ---------------------------------------------------------------------------
// Character predicates
// ---------------------------------------------------------------------------

function isDigit(c) { return c >= '0' && c <= '9'; }

function isHexDigit(c) {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

function isWordChar(c) {
  return isDigit(c) || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isAsciiLetter(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// True when the '&' at text[i] opens a character reference of one of the
// shapes the reference renderer refuses to re-escape: &#123; (1-7 digits),
// &#x1F; (1-6 hex digits) or &word; — anything else gets escaped.
function entityFollows(text, i) {
  let j = i + 1;
  if (text[j] === '#') {
    j++;
    if (text[j] === 'x' || text[j] === 'X') {
      j++;
      let n = 0;
      while (j < text.length && isHexDigit(text[j])) { j++; n++; }
      return n >= 1 && n <= 6 && text[j] === ';';
    }
    let n = 0;
    while (j < text.length && isDigit(text[j])) { j++; n++; }
    return n >= 1 && n <= 7 && text[j] === ';';
  }
  let n = 0;
  while (j < text.length && isWordChar(text[j])) { j++; n++; }
  return n >= 1 && text[j] === ';';
}

// Escape the five HTML specials. With `encode` every '&' is escaped too;
// without it, an '&' that already opens a character reference survives.
const ESCAPE_TEST_RE = /[&<>"']/;

function escapeHtml(text, encode) {
  if (!ESCAPE_TEST_RE.test(text)) return text;
  let out = null;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    let rep = null;
    if (c === '&') {
      if (encode || !entityFollows(text, i)) rep = '&amp;';
    } else if (c === '<' || c === '>' || c === '"' || c === "'") {
      rep = ESCAPE_MAP[c];
    }
    if (rep !== null) {
      if (out === null) out = '';
      out += text.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return out === null ? text : out + text.slice(last);
}

// Decode numeric character references (&#65; / &#x41;) to their characters.
// Named references are not decoded here.
function decodeNumericRef(code) {
  if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '�';
  return String.fromCodePoint(code);
}

const NUMERIC_REF_RE = /&#(\d{1,7});|&#[Xx]([0-9A-Fa-f]{1,6});/g;

// In a plain-text run: when the run contains at least one numeric character
// reference, those references are decoded and every other bare '&' is
// escaped; when it contains none, the run is returned untouched and the
// caller's normal escaping applies. A decoded character that is itself an
// HTML special is emitted escaped (so &#38; renders as &amp;, never as a
// fresh '&' that could start another reference).
function decodeNumericRefsInText(text) {
  if (!text.includes('&#')) return text;
  NUMERIC_REF_RE.lastIndex = 0;
  if (!NUMERIC_REF_RE.test(text)) return text;
  return text.replace(/&#(\d{1,7});|&#[Xx]([0-9A-Fa-f]{1,6});|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g,
    (whole, dec, hex) => {
      if (dec !== undefined || hex !== undefined) {
        const ch = decodeNumericRef(parseInt(dec !== undefined ? dec : hex, dec !== undefined ? 10 : 16));
        return ESCAPE_MAP[ch] ?? ch;
      }
      return '&amp;';
    });
}

// ---------------------------------------------------------------------------
// Link destination / title handling
// ---------------------------------------------------------------------------

// Percent-encode a destination the way encodeURI does, then restore any
// literal '%' that encoding produced from an existing '%'. A URIError
// (lone surrogate in the input) makes the destination unusable: null.
// Chars that encodeURI would change, plus '%' (whose %25 round-trip is
// only the identity when nothing else is encoded): when none of them is
// present, the destination passes through unchanged.
const URL_ENCODE_TEST_RE = /%|[^A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/;

function cleanUrl(href) {
  if (!URL_ENCODE_TEST_RE.test(href)) return href;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// The label key under which a link reference is stored: trimmed, internal
// whitespace collapsed to single spaces, case-folded (through upper case
// first, which matters for a few Unicode letters).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove backslash escapes of ASCII punctuation (used for link labels and
// for the text of a link whose destination turned out unusable).
const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function unescapePunct(text) {
  if (!text.includes('\\')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length && ESCAPABLE.includes(text[i + 1])) {
      out += text[i + 1];
      i++;
    } else {
      out += text[i];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

// Expand tabs to runs of spaces, a tab stopping at the next multiple-of-4
// column, counting columns from `startCol`.
function expandTabs(text, startCol) {
  if (!text.includes('\t')) return text;
  let out = '';
  let col = startCol;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += c;
      if (c === '\n') col = 0; else col++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bracket matching
// ---------------------------------------------------------------------------

// Find the bracket that closes the group opened just before `start`, where
// `open`/`close` are the pair characters. Backslash-escaped brackets do not
// count. Returns the index of the closer, or -1 if the group never closes.
function findClosing(text, start, open, close) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Table rows
// ---------------------------------------------------------------------------

// Split a table row into trimmed cells. A pipe preceded by an odd number of
// backslashes is a literal pipe, not a separator; '\|' in a cell is
// unescaped to '|'. One leading and one trailing empty cell (from the
// row's outer pipes) are dropped. At most `maxCells` cells are kept.
function splitRow(row, maxCells) {
  const cells = [];
  let cur = '';
  let slashes = 0;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\') { slashes++; cur += c; continue; }
    if (c === '|' && slashes % 2 === 0) {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
    slashes = 0;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  if (maxCells !== undefined && cells.length > maxCells) cells.length = maxCells;
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Unicode character classes (for delimiter flanking rules)
// ---------------------------------------------------------------------------

const PUNCT_RE = /^[\p{P}\p{S}]$/u;
const SPACE_RE = /^\s$/;
const WORD_RE = /^[\p{L}\p{N}]$/u;

// ASCII fast table: bit 1 = \s, bit 2 = punctuation/symbol. For code points
// below 128, \s is {9,10,11,12,13,32} and \p{P}\p{S} is exactly the printable
// characters that are not letters or digits.
const ASCII_CLASS = (() => {
  const table = new Uint8Array(128);
  for (const code of [9, 10, 11, 12, 13, 32]) table[code] |= 1;
  for (let code = 33; code < 127; code++) {
    const c = String.fromCharCode(code);
    if (!/[a-zA-Z0-9]/.test(c)) table[code] |= 2;
  }
  return table;
})();

function isSpaceCh(c) {
  if (c === undefined || c === '') return false;
  if (c.length === 1) {
    const code = c.charCodeAt(0);
    if (code < 128) return (ASCII_CLASS[code] & 1) !== 0;
  }
  return SPACE_RE.test(c);
}

function isPunctCh(c) {
  if (c === undefined || c === '') return false;
  if (c.length === 1) {
    const code = c.charCodeAt(0);
    if (code < 128) return (ASCII_CLASS[code] & 2) !== 0;
  }
  return PUNCT_RE.test(c);
}

// The asterisk delimiter rules use a punctuation class that leaves '~' out:
// a tilde behaves like a word character there.
function isPunctNoTildeCh(c) { return c !== '~' && isPunctCh(c); }

function isSpaceOrPunctCh(c) { return isSpaceCh(c) || isPunctCh(c); }
function isSpaceOrPunctNoTildeCh(c) { return isSpaceCh(c) || isPunctNoTildeCh(c); }

// The code point starting at src[i] ('' when out of range), and the code
// point ending just before src[i].
function charAt(src, i) {
  if (i < 0 || i >= src.length) return '';
  const code = src.charCodeAt(i);
  if (code >= 0xD800 && code <= 0xDBFF && i + 1 < src.length) {
    const next = src.charCodeAt(i + 1);
    if (next >= 0xDC00 && next <= 0xDFFF) return src.slice(i, i + 2);
  }
  return src[i];
}

function charBefore(src, i) {
  if (i <= 0) return '';
  const code = src.charCodeAt(i - 1);
  if (code >= 0xDC00 && code <= 0xDFFF && i >= 2) {
    const prev = src.charCodeAt(i - 2);
    if (prev >= 0xD800 && prev <= 0xDBFF) return src.slice(i - 2, i);
  }
  return src[i - 1];
}

// ---------------------------------------------------------------------------
// Code spans
// ---------------------------------------------------------------------------

// At src[i] === '`': count the opening run, then look for a later run of
// exactly the same length. Returns { end, content } or null.
function scanCodeSpan(src, i) {
  let n = 0;
  while (src[i + n] === '`') n++;
  let j = i + n;
  while (j < src.length) {
    if (src[j] === '`') {
      let m = 0;
      while (src[j + m] === '`') m++;
      if (m === n) return { end: j + m, content: src.slice(i + n, j) };
      j += m;
    } else {
      j++;
    }
  }
  return null;
}

// The rendered text of a code span: line endings become spaces, and one
// leading and one trailing space are removed when the content has a
// non-space character and both ends are spaces.
function codeSpanText(content) {
  let text = content.replace(/\n/g, ' ');
  if (/[^ ]/.test(text) && text.startsWith(' ') && text.endsWith(' ')) {
    text = text.slice(1, -1);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Inline HTML tags
// ---------------------------------------------------------------------------

const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*/;
const ATTR_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*/;

// Scan an HTML tag / comment / processing instruction / declaration / CDATA
// section starting at src[i] === '<'. Returns { end, raw } or null.
function scanTag(src, i) {
  const n = src.length;
  let j = i + 1;
  if (j >= n) return null;
  const c = src[j];
  if (c === '!') {
    if (src.startsWith('<!--', i)) {
      if (src[i + 4] === '>') return { end: i + 5, raw: src.slice(i, i + 5) };
      if (src[i + 4] === '-' && src[i + 5] === '>') return { end: i + 6, raw: src.slice(i, i + 6) };
      const close = src.indexOf('-->', i + 4);
      if (close === -1) return null;
      return { end: close + 3, raw: src.slice(i, close + 3) };
    }
    if (src.startsWith('<![CDATA[', i)) {
      const close = src.indexOf(']]>', i + 9);
      if (close === -1) return null;
      return { end: close + 3, raw: src.slice(i, close + 3) };
    }
    if (isAsciiLetter(src[j + 1])) {
      const close = src.indexOf('>', j + 1);
      if (close === -1) return null;
      return { end: close + 1, raw: src.slice(i, close + 1) };
    }
    return null;
  }
  if (c === '?') {
    const close = src.indexOf('?>', j + 1);
    if (close === -1) return null;
    return { end: close + 2, raw: src.slice(i, close + 2) };
  }
  if (c === '/') {
    const m = TAG_NAME_RE.exec(src.slice(j + 1));
    if (!m) return null;
    let k = j + 1 + m[0].length;
    while (k < n && isSpaceCh(src[k])) k++;
    if (src[k] === '>') return { end: k + 1, raw: src.slice(i, k + 1) };
    return null;
  }
  if (isAsciiLetter(c)) {
    const m = TAG_NAME_RE.exec(src.slice(j));
    let k = j + m[0].length;
    // attributes, each preceded by whitespace
    for (;;) {
      let w = k;
      while (w < n && isSpaceCh(src[w])) w++;
      if (w === k) break; // no whitespace: no attribute here
      if (src[w] === '>' || (src[w] === '/' && src[w + 1] === '>')) { k = w; break; }
      const am = ATTR_NAME_RE.exec(src.slice(w));
      if (!am) return null;
      let p = w + am[0].length;
      // optional = value
      let q = p;
      while (q < n && isSpaceCh(src[q])) q++;
      if (src[q] === '=') {
        q++;
        while (q < n && isSpaceCh(src[q])) q++;
        const v = src[q];
        if (v === '"' || v === "'") {
          const closeQuote = src.indexOf(v, q + 1);
          if (closeQuote === -1) return null;
          p = closeQuote + 1;
        } else {
          let e = q;
          while (e < n && !isSpaceCh(src[e]) && src[e] !== '"' && src[e] !== "'" &&
                 src[e] !== '=' && src[e] !== '<' && src[e] !== '>' && src[e] !== '`') e++;
          if (e === q) return null;
          p = e;
        }
      }
      k = p;
    }
    while (k < n && isSpaceCh(src[k])) k++;
    if (src[k] === '/' && src[k + 1] === '>') return { end: k + 2, raw: src.slice(i, k + 2) };
    if (src[k] === '>') return { end: k + 1, raw: src.slice(i, k + 1) };
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Autolinks in angle brackets: <scheme:path> and <email>
// ---------------------------------------------------------------------------

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/;
const EMAIL_LOCAL_CHARS = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-");

// The narrower set an email local part is actually made of.
function isLocalPartCh(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
    c === '.' || c === '_' || c === '+' || c === '-';
}

// The email shape shared by angle autolinks, bare extended autolinks and
// the mailto:/xmpp: forms: a local part of [A-Za-z0-9._+-], an '@', a
// first domain label of [A-Za-z0-9-_], then one or more dot-separated
// labels that must end in an alphanumeric, and the address must not be
// followed by a word character or a hyphen.
const EMAIL_SRC = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const EMAIL_RE = new RegExp('^' + EMAIL_SRC);

// A full bare email starting at src[i]: returns its end index or -1.
function scanEmail(src, i) {
  const m = EMAIL_RE.exec(src.slice(i));
  return m ? i + m[0].length : -1;
}

// At src[i] === '<': an autolink. Returns { end, href, text } where text is
// the visible address (the part between the brackets), or null.
function scanAutolink(src, i) {
  const rest = src.slice(i + 1);
  const sm = SCHEME_RE.exec(rest);
  if (sm) {
    let j = i + 1 + sm[0].length;
    let k = j;
    while (k < src.length && src[k] !== '<' && src[k] !== '>' && !isSpaceCh(src[k])) k++;
    if (k > j && src[k] === '>') {
      const text = src.slice(i + 1, k);
      return { end: k + 1, href: text, text };
    }
    return null;
  }
  const emailEnd = scanEmail(src, i + 1);
  if (emailEnd !== -1 && src[emailEnd] === '>') {
    const text = src.slice(i + 1, emailEnd);
    return { end: emailEnd + 1, href: 'mailto:' + text, text };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extended autolinks (www., scheme://, ftp://, bare emails, mailto:/xmpp:)
// ---------------------------------------------------------------------------

// One backpedal step over a candidate URL: the longest prefix made of
// runs of ordinary characters, balanced "(...)" groups, ampersands that
// do not end an entity, and punctuation runs that are not at the very
// end. Applied until stable, this trims trailing punctuation, trailing
// entities and unbalanced closing parens from the candidate.
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

function backpedal(s) {
  for (;;) {
    const m = BACKPEDAL_RE.exec(s);
    const next = m ? m[0] : '';
    if (next === s) return s;
    s = next;
  }
}

// The extended-autolink shape: a mailto:/xmpp: address (xmpp may carry a
// "/resource" part), a scheme:// or www. address (a dotted host of
// [a-zA-Z0-9-] labels followed by any run of non-space, non-'<' chars),
// or a bare email. Group 1 is the scheme/www. prefix, group 2 is the
// bare email's '@'.
const EXT_URL_RE = new RegExp(
  '^(?:mailto:' + EMAIL_SRC +
  '|xmpp:' + EMAIL_SRC + '(?:/[A-Za-z0-9@.]+)?' +
  '|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP])://|www\\.)(?:[a-zA-Z0-9-]+\\.?)+[^\\s<]*' +
  '|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-]))'
);

// At src[i]: an extended autolink (www., scheme://, mailto:/xmpp:
// address) or a bare email. Returns { end, href, text } or null. `end`
// is the index just past the visible text.
function scanExtendedAutolink(src, i) {
  const m = EXT_URL_RE.exec(src.slice(i));
  if (!m) return null;
  if (m[2] === '@') {
    const text = m[0];
    return { end: i + text.length, href: 'mailto:' + text, text };
  }
  const text = backpedal(m[0]);
  if (text === '') return null;
  const href = m[1] === 'www.' ? 'http://' + text : text;
  return { end: i + text.length, href, text };
}

// ---------------------------------------------------------------------------
// Link labels and link tails
// ---------------------------------------------------------------------------

// Find the ']' closing the label that starts just before src[start] (the
// caller consumed the '['). The scan follows the reference label
// pattern: nested bracket pairs (one level, escapes allowed), backslash
// escapes, code-span fragments (a backtick run, non-backtick content, a
// closing run of any length), a backtick run directly before the ']', or
// plain characters other than '[', ']', '\' and '`'. A backtick run that
// forms none of these blocks the label. Returns the index of the
// closing ']' or -1.
const LABEL_SCAN_RE = /^(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?\]/;

function scanLabelEnd(src, start) {
  const m = LABEL_SCAN_RE.exec(src.slice(start));
  if (m === null) return -1;
  return start + m[0].length - 1;
}

// Scan a link-reference second label starting at src[i] === '[': any run of
// characters up to the next ']'. Returns the index just past ']' or -1.
function scanSecondLabelEnd(src, i) {
  const close = src.indexOf(']', i + 1);
  if (close === -1) return -1;
  return close + 1;
}

function isTailSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
}

// Parse a link tail starting at src[i] === '(': optional whitespace, a
// destination (angle-bracketed, or a run with balanced parentheses), an
// optional title, optional whitespace and the closing ')'. Returns
// { end, href, title } with href/title still raw (escapes intact), or null.
function scanLinkTail(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n && isTailSpace(src[j])) j++;
  let href = '';
  if (src[j] === '<') {
    let k = j + 1;
    let closed = false;
    while (k < n) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '>') { closed = true; break; }
      if (c === '<' || c === '\n') return null;
      k++;
    }
    if (!closed) return null;
    href = src.slice(j + 1, k);
    j = k + 1;
  } else {
    let depth = 0;
    let k = j;
    while (k < n) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (isTailSpace(c) || c <= '\u001f') break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    if (depth !== 0) return null;
    href = src.slice(j, k);
    j = k;
  }
  // optional title, which must be separated from the destination
  let title = null;
  let p = j;
  let separated = false;
  while (p < n && isTailSpace(src[p])) { p++; separated = true; }
  if (src[p] === ')') return { end: p + 1, href, title };
  if (!separated) return null;
  const opener = src[p];
  if (opener === '"' || opener === "'") {
    let k = p + 1;
    let closed = false;
    while (k < n) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === opener) { closed = true; break; }
      k++;
    }
    if (!closed) return null;
    title = src.slice(p + 1, k);
    p = k + 1;
  } else if (opener === '(') {
    let k = p + 1;
    let closed = false;
    while (k < n) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === ')') { closed = true; break; }
      if (src[k] === '(') return null;
      k++;
    }
    if (!closed) return null;
    title = src.slice(p + 1, k);
    p = k + 1;
  } else {
    return null;
  }
  while (p < n && isTailSpace(src[p])) p++;
  if (src[p] === ')') return { end: p + 1, href, title };
  return null;
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

// The rendering of one plain-text run: numeric character references are
// decoded (when the run holds at least one), then the run is HTML-escaped.
function renderTextRun(raw) {
  return escapeHtml(decodeNumericRefsInText(raw), false);
}

const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_RAW_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_RAW_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;

// Render a link or image once its destination, title and label are known.
// `altMode` renders an image's label (plain text) instead of markup.
// Returns the rendered string. Bracket links record themselves on
// st.sawBracketLink (used by the nested-link rule in tryBracket).
function renderLinkOrImage(st, rawHref, rawTitle, labelSrc, isImage, altMode) {
  const href = unescapePunct(rawHref);
  const title = rawTitle === null ? null : unescapePunct(rawTitle);
  const clean = cleanUrl(href);
  if (isImage) {
    const savedFlag = st.sawBracketLink;
    const alt = renderInline(st, labelSrc, true);
    st.sawBracketLink = savedFlag; // links inside an alt never count
    if (altMode) return alt;
    if (clean === null) return alt;
    let out = '<img src="' + escapeHtml(clean, false) + '" alt="' + alt + '"';
    if (title !== null) out += ' title="' + escapeHtml(title, false) + '"';
    return out + '>';
  }
  // A link label is rendered with extended autolinks disabled, in isolation:
  // state changes made while rendering it do not leak into the outer text.
  const savedInLink = st.inLink;
  const savedFlag = st.sawBracketLink;
  st.inLink = true;
  st.sawBracketLink = false;
  const inner = renderInline(st, labelSrc, altMode);
  const innerHasLink = st.sawBracketLink;
  st.inLink = savedInLink;
  st.sawBracketLink = savedFlag;
  st.lastLabelHadLink = innerHasLink;
  if (altMode) return inner;
  if (clean === null) return inner;
  let out = '<a href="' + escapeHtml(clean, false) + '"';
  if (title !== null) out += ' title="' + escapeHtml(title, false) + '"';
  return out + '>' + inner + '</a>';
}

// Render an angle autolink (<scheme:...> or <email>).
function renderAutolink(st, match, altMode) {
  const clean = cleanUrl(match.href);
  if (altMode) return escapeHtml(match.text, false);
  if (clean === null) return escapeHtml(match.text, false);
  return '<a href="' + escapeHtml(clean, true) + '">' + escapeHtml(match.text, true) + '</a>';
}

// Render an extended autolink (www. / scheme:// / email).
function renderExtendedAutolink(st, match, altMode) {
  const clean = cleanUrl(match.href);
  if (altMode) return escapeHtml(match.text, false);
  if (clean === null) return escapeHtml(match.text, false);
  return '<a href="' + escapeHtml(clean, true) + '">' + escapeHtml(match.text, true) + '</a>';
}

// Try to parse a bracket construct (link or image) at src[i] ('[' or '!').
// On success returns { end, html } with html rendered for the current mode.
// On failure returns null; the caller emits one character of text.
// An inline link is rejected when its label contains an HTML tag or an
// autolink that starts inside the label but ends beyond it.
function labelHtmlOverflow(src, labelStart, labelSrc) {
  if (!labelSrc.includes('<')) return false;
  for (let s = 0; s < labelSrc.length; s++) {
    const c = labelSrc[s];
    if (c === '\\') { s++; continue; }
    if (c === '`') {
      const span = scanCodeSpan(labelSrc, s);
      if (span !== null) { s = span.end - 1; continue; }
    }
    if (c !== '<') continue;
    const pos = labelStart + s;
    const tag = scanTag(src, pos);
    const auto = tag === null ? scanAutolink(src, pos) : null;
    const m = tag !== null ? tag : auto;
    if (m !== null) {
      const len = m.end - pos;
      if (len > labelSrc.length - s) return true;
      s += len - 1;
    }
  }
  return false;
}

function tryBracket(st, src, i, altMode) {
  const isImage = src[i] === '!';
  const labelStart = i + (isImage ? 2 : 1);
  const labelEnd = scanLabelEnd(src, labelStart);
  if (labelEnd === -1) return null;
  const labelSrc = src.slice(labelStart, labelEnd);
  const after = labelEnd + 1;
  const c = src[after];
  if (c === '(') {
    const tail = scanLinkTail(src, after);
    if (tail !== null && !labelHtmlOverflow(src, labelStart, labelSrc)) {
      st.lastLabelHadLink = false;
      const html = renderLinkOrImage(st, tail.href, tail.title, labelSrc, isImage, altMode);
      if (!isImage && st.lastLabelHadLink) return null; // nested-link rule
      if (!isImage) st.sawBracketLink = true;
      return { end: tail.end, html };
    }
    // a failed tail falls through to the reference/shortcut forms
  }
  if (c === '[') {
    const secondEnd = scanSecondLabelEnd(src, after);
    if (secondEnd !== -1) {
      const label2 = src.slice(after + 1, secondEnd - 1);
      const def = st.defs.get(normalizeLabel(label2 !== '' ? label2 : labelSrc));
      if (def !== undefined && !labelHtmlOverflow(src, labelStart, labelSrc)) {
        st.lastLabelHadLink = false;
        const html = renderLinkOrImage(st, def.href, def.title, labelSrc, isImage, altMode);
        if (!isImage && st.lastLabelHadLink) return null;
        if (!isImage) st.sawBracketLink = true;
        return { end: secondEnd, html };
      }
      return null;
    }
  }
  // shortcut reference
  const def = st.defs.get(normalizeLabel(labelSrc));
  if (def !== undefined && !labelHtmlOverflow(src, labelStart, labelSrc)) {
    st.lastLabelHadLink = false;
    const html = renderLinkOrImage(st, def.href, def.title, labelSrc, isImage, altMode);
    if (!isImage && st.lastLabelHadLink) return null;
    if (!isImage) st.sawBracketLink = true;
    return { end: after, html };
  }
  return null;
}

// Flanking predicates over the source characters surrounding a delimiter
// run that spans [start, end). A missing character (frame edge) counts as
// whitespace and never as punctuation.
function flankBefore(src, i) { return i <= 0 ? '' : charBefore(src, i); }
function flankAfter(src, i) { return i >= src.length ? '' : charAt(src, i); }
function isFlankSpace(c) { return c === '' || isSpaceCh(c); }
function isFlankPunct(c, noTilde) {
  if (c === '') return false;
  return noTilde ? isPunctNoTildeCh(c) : isPunctCh(c);
}

function makeDelim(src, start, end, char) {
  const before = flankBefore(src, start);
  const after = flankAfter(src, end);
  const noTilde = char === '*';
  const left = !isFlankSpace(after) &&
    (!isFlankPunct(after, noTilde) || isFlankSpace(before) || isFlankPunct(before, noTilde));
  const right = !isFlankSpace(before) &&
    (!isFlankPunct(before, noTilde) || isFlankSpace(after) || isFlankPunct(after, noTilde));
  let canOpen;
  let canClose;
  if (char === '_') {
    canOpen = left && (!right || isFlankPunct(before, false));
    canClose = right && (!left || isFlankPunct(after, false));
  } else {
    canOpen = left;
    canClose = right;
  }
  return { k: 'delim', char, len: end - start, canOpen, canClose };
}

// Pair delimiter runs in one element list, following the CommonMark
// emphasis algorithm (including the multiple-of-three rule); '~' runs pair
// only with a run of the same length and produce <del>.
function processDelimiters(elems) {
  let idx = 0;
  while (idx < elems.length) {
    const d = elems[idx];
    if (d.k !== 'delim' || !d.canClose || d.len === 0) { idx++; continue; }
    let paired = false;
    for (let j = idx - 1; j >= 0; j--) {
      const o = elems[j];
      if (o.k !== 'delim' || o.char !== d.char || !o.canOpen || o.len === 0) continue;
      let use = 0;
      if (d.char === '~') {
        if (o.len === d.len) use = d.len;
      } else {
        const sum = o.len + d.len;
        const blocked = (o.canClose || d.canOpen) && sum % 3 === 0 &&
          !(o.len % 3 === 0 && d.len % 3 === 0);
        if (!blocked) use = o.len >= 2 && d.len >= 2 ? 2 : 1;
      }
      if (use === 0) continue;
      const oi = elems.indexOf(o);
      const di = elems.indexOf(d);
      const inner = elems.splice(oi + 1, di - oi - 1);
      for (const el of inner) {
        if (el.k === 'delim') { el.canOpen = false; el.canClose = false; }
      }
      const tag = d.char === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      elems.splice(oi + 1, 0, { k: 'wrap', tag, children: inner });
      o.len -= use;
      d.len -= use;
      paired = true;
      break;
    }
    if (paired) {
      const di = elems.indexOf(d);
      idx = d.len > 0 ? di : di + 1;
    } else {
      idx++;
    }
  }
}

function renderElements(elems, altMode) {
  let out = '';
  for (const el of elems) {
    if (el.k === 'text') out += renderTextRun(el.raw);
    else if (el.k === 'html') out += el.html;
    else if (el.k === 'delim') out += el.char.repeat(el.len);
    else if (el.k === 'wrap') {
      const inner = renderElements(el.children, altMode);
      out += altMode ? inner : '<' + el.tag + '>' + inner + '</' + el.tag + '>';
    }
  }
  return out;
}

// Could an extended autolink start at src[j]? (Only consulted when the
// url machinery is enabled, i.e. outside links and <a> elements.)
function autolinkStartsAt(src, j) {
  const c = src[j];
  if (c === 'w') return src.startsWith('www.', j);
  if (c === 'm') return src.startsWith('mailto:', j);
  if (c === 'x') return src.startsWith('xmpp:', j);
  if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
    const head = src.slice(j, j + 8).toLowerCase();
    return head.startsWith('http://') || head.startsWith('https://') || head.startsWith('ftp://');
  }
  return false;
}

// The same check, for a position reached inside a text run: a "www."
// start only counts when the preceding character is whitespace, one of
// '*', '_', '~', '(', or nothing; a mailto:/xmpp: start does not count
// right after a '~' or an alphanumeric character.
function autolinkStartsAtInText(src, j) {
  const c = src[j];
  if (c === 'w') {
    if (!src.startsWith('www.', j)) return false;
    if (j === 0) return true;
    const prev = src[j - 1];
    return prev === '*' || prev === '_' || prev === '~' || prev === '(' || /\s/.test(prev);
  }
  if (c === 'm' || c === 'x') {
    if (!src.startsWith(c === 'm' ? 'mailto:' : 'xmpp:', j)) return false;
    if (j === 0) return true;
    const prev = src[j - 1];
    return prev !== '~' && !/[A-Za-z0-9]/.test(prev);
  }
  return autolinkStartsAt(src, j);
}

// Render one inline frame (a paragraph, heading, link label, table cell…).
// `altMode` renders plain text for an image's alt attribute instead of HTML.
// ---------------------------------------------------------------------------
// Emphasis, strong and strikethrough: scan-time span matching
//
// At a '*'/'_'/'~' run, a complete span is matched immediately against a
// masked copy of the inline source (code spans, links, tags and reference
// links blanked out, escapes neutralized), and the span content is lexed
// recursively. Delimiter runs are classified by the characters around
// them (punctuation / space / word), nested opener runs add to the
// required closer length, and a rule-of-three skip applies to some
// closer candidates.
// ---------------------------------------------------------------------------

const PUNCT_CLASS = '[\\p{P}\\p{S}]';
const PUNCT_NOT_TILDE = '(?!~)' + PUNCT_CLASS;
const PUNCT_SPACE = '[\\s\\p{P}\\p{S}]';
const PUNCT_SPACE_NOT_TILDE = '(?!~)' + PUNCT_SPACE;
const NOT_PUNCT_SPACE = '[^\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_OR_TILDE = '(?:[^\\s\\p{P}\\p{S}]|~)';

const PUNCTUATION_RE = new RegExp('^(?![*_])' + PUNCT_SPACE, 'u');
const UNICODE_ALNUM_RE = /[\p{L}\p{N}]/u;

const EM_LDELIM_RE = new RegExp(
  '^(?:\\*+(?:((?!\\*)' + PUNCT_NOT_TILDE + ')|([^\\s*]))?)' +
  '|^_+(?:((?!_)' + PUNCT_NOT_TILDE + ')|([^\\s_]))?', 'u');

const EM_RDELIM_AST_RE = new RegExp(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' +
  '|[^*]+(?=[^*])' +
  '|(?!\\*)' + PUNCT_NOT_TILDE + '(\\*+)(?=[\\s]|$)' +
  '|' + NOT_PUNCT_SPACE_OR_TILDE + '(\\*+)(?!\\*)(?=' + PUNCT_SPACE_NOT_TILDE + '|$)' +
  '|(?!\\*)' + PUNCT_SPACE_NOT_TILDE + '(\\*+)(?=' + NOT_PUNCT_SPACE_OR_TILDE + ')' +
  '|[\\s](\\*+)(?!\\*)(?=' + PUNCT_NOT_TILDE + ')' +
  '|(?!\\*)' + PUNCT_NOT_TILDE + '(\\*+)(?!\\*)(?=' + PUNCT_NOT_TILDE + ')' +
  '|' + NOT_PUNCT_SPACE_OR_TILDE + '(\\*+)(?=' + NOT_PUNCT_SPACE_OR_TILDE + ')',
  'gu');

const EM_RDELIM_UND_RE = new RegExp(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' +
  '|[^_]+(?=[^_])' +
  '|(?!_)' + PUNCT_CLASS + '(_+)(?=[\\s]|$)' +
  '|' + NOT_PUNCT_SPACE + '(_+)(?!_)(?=' + PUNCT_SPACE + '|$)' +
  '|(?!_)' + PUNCT_SPACE + '(_+)(?=' + NOT_PUNCT_SPACE + ')' +
  '|[\\s](_+)(?!_)(?=' + PUNCT_CLASS + ')' +
  '|(?!_)' + PUNCT_CLASS + '(_+)(?!_)(?=' + PUNCT_CLASS + ')',
  'gu');

const DEL_LDELIM_RE = new RegExp('^~~?(?:((?!~)' + PUNCT_CLASS + ')|[^\\s~])', 'u');

const DEL_RDELIM_RE = new RegExp(
  '^[^~]+(?=[^~])' +
  '|(?!~)' + PUNCT_CLASS + '(~~?)(?=[\\s]|$)' +
  '|' + NOT_PUNCT_SPACE + '(~~?)(?!~)(?=' + PUNCT_SPACE + '|$)' +
  '|(?!~)' + PUNCT_SPACE + '(~~?)(?=' + NOT_PUNCT_SPACE + ')' +
  '|[\\s](~~?)(?!~)(?=' + PUNCT_CLASS + ')' +
  '|(?!~)' + PUNCT_CLASS + '(~~?)(?!~)(?=' + PUNCT_CLASS + ')' +
  '|' + NOT_PUNCT_SPACE + '(~~?)(?=' + NOT_PUNCT_SPACE + ')',
  'gu');

const ANY_PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

const BLOCK_SKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

const LABEL_FRAG = '(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const REF_FRAG = '(?:(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})';
const REFLINK_FRAG = '!?' + '\\[' + '(?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?' + '\\]\\[' + REF_FRAG + '\\]';
const NOLINK_FRAG = '!?' + '\\[' + REF_FRAG + '\\](?:\\[\\])?';
const REFLINK_SEARCH_RE = new RegExp(REFLINK_FRAG + '|' + NOLINK_FRAG + '(?!\\()', 'g');

const LINK_TEST_RE = new RegExp(
  '^!?\\[(' + LABEL_FRAG + ')\\]\\([ \\t\\n]*' +
  '(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))' +
  '(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)' +
  '("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?' +
  '[ \\t\\n]*\\)');

// Does this text contain a link (inline or reference) anywhere? Used by
// the mask to decide how much of a reference link to blank out.
function linkInText(st, e) {
  if (!e.includes('[')) return false;
  for (const n of e.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_TEST_RE.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(REFLINK_SEARCH_RE)) {
    const s = n[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !st.defs.has(normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(st, s.slice(1, r - 1)))) return true;
  }
  return false;
}

// Build the masked copy of an inline source: reference-link spans are
// blanked to 'a's inside their brackets (keeping a label that itself
// contains a link), escaped punctuation becomes '+', backtick runs
// inside code spans become '+', and link/code/html spans found by the
// block-skip pattern are blanked the same way. Length is preserved.
function buildMask(st, src) {
  let t = src;
  if (t.includes('[') && st.defs.size > 0) {
    const maskOne = (r) => {
      const o = r.lastIndexOf('[');
      if (!st.defs.has(normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(st, inner)) {
          return '[' + inner.replace(REFLINK_SEARCH_RE, maskOne) + '][' +
            'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH_RE, maskOne);
  }
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (n, s, r) =>
      r ? '+'.repeat(n.length)
        : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s
          : n);
  }
  if (t.includes('](') || t.includes('`') || t.includes('<')) {
    t = t.replace(BLOCK_SKIP_RE, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
  }
  return t;
}

// For each delimiter character, the last index in the masked source
// where a run of it starts and could act as a closer (the character
// before the run is not whitespace).
function lastCloserIndices(masked) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  return { em, del };
}

// Try to match an em/strong span starting at src[i] (a '*' or '_' run).
// `masked` is the masked full inline source, `closers` its closer index
// table, `prevChar` the character before the current position as tracked
// by the caller ('' at the start or after a non-text token). Returns
// { end, tag, inner } or null.
function tryEmStrong(st, src, i, masked, closers, prevChar) {
  const e = src.slice(i);
  let s = EM_LDELIM_RE.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const sameCharBefore = prevChar === r;
  const pos = i;
  let l = pos;
  while (l > 0 && masked[l - 1] === r) l--;
  let beforeRun = '';
  if (l > 0) {
    const c1 = masked[l - 1];
    beforeRun = c1 >= '\uDC00' && c1 <= '\uDFFF' && l >= 2 ? masked.slice(l - 2, l) : c1;
  }
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || PUNCTUATION_RE.test(beforeRun);
  let n = prevChar;
  if (l < pos) n = beforeRun;
  const u = l < pos ? beforeIsPunct : PUNCTUATION_RE.test(n);
  if (s[4] && UNICODE_ALNUM_RE.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let m = k;
    let f = 0;
    const y = pos - l + k;
    const R = !!beforeRun.trim() && (!!d || (r === '*' && !beforeIsPunct));
    const A = r === '*' ? EM_RDELIM_AST_RE : EM_RDELIM_UND_RE;
    const v = closers.em[r];
    const Q = pos + k;
    if (v < Q) return null;
    const t = masked.slice(Q);
    const ee = v - Q;
    A.lastIndex = 0;
    let ms;
    while ((ms = A.exec(t)) !== null && !(ms.index > ee)) {
      const g = ms[1] || ms[2] || ms[3] || ms[4] || ms[5] || ms[6];
      if (!g) continue;
      let b = [...g].length;
      if (ms[3] || ms[4]) { m += b; continue; }
      if (ms[5] || ms[6] || R) {
        if (sameCharBefore && (ms[5] || ms[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...ms[0]][0].length;
      const M = e.slice(0, k + ms.index + te + b);
      if (Math.min(k, b) % 2) {
        return { end: i + M.length, tag: 'em', inner: M.slice(1, -1) };
      }
      return { end: i + M.length, tag: 'strong', inner: M.slice(2, -2) };
    }
  }
  return null;
}

// Try to match a strikethrough span starting at src[i] (a '~' run).
// Returns { end, inner } or null.
function tryDel(st, src, i, masked, closers, prevChar) {
  const e = src.slice(i);
  let s = DEL_LDELIM_RE.exec(e);
  if (!s) return null;
  if (!(s[1] || '') || !prevChar || PUNCTUATION_RE.test(prevChar)) {
    const o = [...s[0]].length - 1;
    let p = o;
    const u = closers.del;
    const dpos = i + o;
    if (u < dpos) return null;
    const t = masked.slice(dpos);
    const k = u - dpos;
    DEL_RDELIM_RE.lastIndex = 0;
    while ((s = DEL_RDELIM_RE.exec(t)) !== null && !(s.index > k)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      let len = [...g].length;
      if (len !== o) continue;
      if (s[3] || s[4]) { p += len; continue; }
      p -= len;
      if (p > 0) continue;
      len = Math.min(len, len + p);
      const g0 = [...s[0]][0].length;
      const raw = e.slice(0, o + s.index + g0 + len);
      return { end: i + raw.length, inner: raw.slice(o, raw.length - o) };
    }
  }
  return null;
}

const NO_CLOSERS = { em: { '*': -1, '_': -1 }, del: -1 };

function renderInline(st, src, altMode) {
  const elems = [];
  const n = src.length;
  // the delimiter mask and closer table only matter when the text
  // actually contains a delimiter character
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasDelim ? buildMask(st, src) : src;
  const closers = hasDelim ? lastCloserIndices(masked) : NO_CLOSERS;
  let i = 0;
  let textStart = 0;
  let noEmailUntil = -1;
  // the character before the current position, as the emphasis matcher
  // sees it: the last character of the preceding text token (kept across
  // a trailing '_'), or '' after any non-text token
  let prevChar = '';
  let prevWasText = false;
  const flushText = (end) => {
    if (end > textStart) {
      elems.push({ k: 'text', raw: src.slice(textStart, end) });
      prevWasText = true;
      const lc = src[end - 1];
      if (lc !== '_') prevChar = lc;
    }
  };
  const pushHtml = (html) => {
    elems.push({ k: 'html', html });
    prevWasText = false;
  };
  const prevCharAt = (pos) => {
    if (pos > textStart) {
      const lc = src[pos - 1];
      return lc !== '_' ? lc : prevChar;
    }
    return prevWasText ? prevChar : '';
  };
  while (i < n) {
    const c = src[i];
    // --- backslash escapes and backslash hard breaks ---
    if (c === '\\') {
      const next = src[i + 1];
      if (next !== undefined && ESCAPABLE.includes(next)) {
        flushText(i);
        pushHtml(escapeHtml(next, false));
        i += 2;
        textStart = i;
        continue;
      }
      if (next === '\n') {
        // a backslash hard break; the break also consumes the leading
        // spaces/tabs of the next line, and does not count when only
        // whitespace follows
        let k = i + 2;
        while (k < n && isSpaceCh(src[k])) k++;
        if (k < n) {
          flushText(i);
          pushHtml(altMode ? '' : '<br>');
          i += 2;
          while (src[i] === ' ' || src[i] === '\t') i++;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    // --- angle autolinks and raw HTML tags ---
    if (c === '<') {
      const auto = scanAutolink(src, i);
      if (auto !== null) {
        flushText(i);
        pushHtml(renderAutolink(st, auto, altMode));
        i = auto.end;
        textStart = i;
        continue;
      }
      const tag = scanTag(src, i);
      if (tag !== null) {
        flushText(i);
        pushHtml(altMode ? escapeHtml(tag.raw, false) : tag.raw);
        if (!st.inLink && START_A_TAG.test(tag.raw)) st.inLink = true;
        else if (st.inLink && END_A_TAG.test(tag.raw)) st.inLink = false;
        i = tag.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // --- code spans ---
    if (c === '`') {
      const span = scanCodeSpan(src, i);
      if (span !== null) {
        flushText(i);
        const text = escapeHtml(codeSpanText(span.content), true);
        pushHtml(altMode ? text : '<code>' + text + '</code>');
        i = span.end;
        textStart = i;
        continue;
      }
      // no closing run: the whole backtick run stays plain text
      let j = i + 1;
      while (src[j] === '`') j++;
      i = j;
      continue;
    }
    // --- links and images ---
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const bracket = tryBracket(st, src, i, altMode);
      if (bracket !== null) {
        flushText(i);
        pushHtml(bracket.html);
        i = bracket.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // --- emphasis, strong and strikethrough spans ---
    if (c === '*' || c === '_') {
      const m = tryEmStrong(st, src, i, masked, closers, prevCharAt(i));
      if (m !== null) {
        flushText(i);
        const inner = renderInline(st, m.inner, altMode);
        pushHtml(altMode ? inner : '<' + m.tag + '>' + inner + '</' + m.tag + '>');
        i = m.end;
        textStart = i;
        continue;
      }
      // an underscore run that is not a delimiter can still begin an
      // email autolink (the local part may start with '_')
      if (c === '_' && !st.inLink && i >= noEmailUntil && scanEmail(src, i) !== -1) {
        const match = scanExtendedAutolink(src, i);
        if (match !== null) {
          flushText(i);
          pushHtml(renderExtendedAutolink(st, match, altMode));
          i = match.end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === '~') {
      const m = tryDel(st, src, i, masked, closers, prevCharAt(i));
      if (m !== null) {
        flushText(i);
        const inner = renderInline(st, m.inner, altMode);
        pushHtml(altMode ? inner : '<del>' + inner + '</del>');
        i = m.end;
        textStart = i;
        continue;
      }
      // no strikethrough starts here: the whole tilde run is plain text
      let j = i + 1;
      while (src[j] === '~') j++;
      i = j;
      continue;
    }
    // --- extended autolinks ---
    if (!st.inLink && ((i > textStart ? autolinkStartsAtInText(src, i) : autolinkStartsAt(src, i)) ||
        (i >= noEmailUntil && EMAIL_LOCAL_CHARS.has(c) && scanEmail(src, i) !== -1))) {
      const match = scanExtendedAutolink(src, i);
      if (match !== null) {
        flushText(i);
        pushHtml(renderExtendedAutolink(st, match, altMode));
        i = match.end;
        textStart = i;
        continue;
      }
    }
    // --- hard breaks from trailing spaces ---
    if (c === ' ') {
      let j = i;
      while (src[j] === ' ') j++;
      if (j - i >= 2 && src[j] === '\n') {
        let k = j + 1;
        while (k < n && isSpaceCh(src[k])) k++;
        if (k < n) {
          flushText(i);
          pushHtml(altMode ? '' : '<br>');
          i = j + 1;
          while (src[i] === ' ' || src[i] === '\t') i++;
          textStart = i;
          continue;
        }
      }
      i = j;
      continue;
    }
    // --- plain text run ---
    let j = i + 1;
    while (j < n) {
      const t = src[j];
      if (t === '\\' || t === '<' || t === '`' || t === '[' || t === '*' || t === '~') break;
      if (t === '!' && src[j + 1] === '[') break;
      if (t === '_') {
        // a run of underscores is plain text only when the whole run is
        // intraword (word characters on both sides); otherwise the run
        // may act as a delimiter and the text run stops before it
        let runEnd = j + 1;
        while (src[runEnd] === '_') runEnd++;
        const before = src[j - 1];
        const after = runEnd < n ? src[runEnd] : '';
        if (isWordChar(before) && isWordChar(after)) { j = runEnd; continue; }
        break;
      }
      if (t === ' ') {
        let k = j;
        while (src[k] === ' ') k++;
        if (k - j >= 2 && src[k] === '\n') {
          let m = k + 1;
          while (m < n && isSpaceCh(src[m])) m++;
          if (m < n) break;
        }
        j = k;
        continue;
      }
      if (!st.inLink) {
        if ((t === 'w' || t === 'm' || t === 'x' || t === 'h' || t === 'f' || t === 'H' || t === 'F') &&
            autolinkStartsAtInText(src, j)) break;
        if (j >= noEmailUntil && isLocalPartCh(t)) {
          // walk the local-part run without allocating: an email can only
          // start inside it when an '@' follows the run
          let k = j + 1;
          while (k < n && isLocalPartCh(src[k])) k++;
          if (src[k] === '@' && scanEmail(src, j) !== -1) break;
          noEmailUntil = k;
        }
      }
      j++;
    }
    i = j;
  }
  flushText(n);
  return renderElements(elems, altMode);
}

// ---------------------------------------------------------------------------
// Block structure
//
// The block layer works on arrays of lines. Two lexing modes exist:
//   - top level (documents, blockquote contents): multi-line paragraphs;
//   - item level (list item contents): single-line text runs that absorb
//     following indented-code and definition lines, mirroring how a
//     line-oriented block tokenizer behaves when it is not at the top.
// ---------------------------------------------------------------------------

function splitLines(src) {
  const parts = src.split('\n');
  const lines = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === parts.length - 1 && parts[i] === '' && parts.length > 1) break;
    lines.push({ text: parts[i], eol: i < parts.length - 1 ? '\n' : '' });
  }
  return lines;
}

function isBlankLine(text) { return /^[ \t]*$/.test(text); }

// Expand the tabs of a whitespace run into spaces, with tab stops every 4
// columns counted from `startCol`.
function expandWsRun(ws, startCol) {
  let col = startCol;
  let out = '';
  for (let i = 0; i < ws.length; i++) {
    const c = ws[i];
    if (c === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += c;
      col++;
    }
  }
  return out;
}

// A line's leading whitespace run, expanded to spaces (anchored at column 0
// unless `anchor` says where the run starts).
function expandLeading(line, anchor) {
  const m = /^[ \t]+/.exec(line);
  if (m === null) return line;
  return expandWsRun(m[0], anchor || 0) + line.slice(m[0].length);
}

// Remove one level of code indentation from a line: up to 3 spaces plus a
// tab, or 1-4 spaces.
function stripCodeIndent(line) {
  return line.replace(/^(?: {0,3}\t| {1,4})/, '');
}

// Leading columns of a line (tab advances to the next multiple of 4) and
// the index of the first non-whitespace character.
function indentColsOf(text) {
  let col = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { col, idx: i };
}

// Count of leading space characters (tabs do not count).
function leadingSpaces(text) {
  let n = 0;
  while (text[n] === ' ') n++;
  return n;
}

const HR_RE = /^((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
function isHrLine(text) {
  const ind = indentColsOf(text);
  if (ind.col > 3) return false;
  return HR_RE.test(text.slice(ind.idx));
}

function isSetextLine(text) { return /^ {0,3}(=+|-+)[ \t]*$/.test(text); }

// --- headings ---------------------------------------------------------------

// Trailing '#' characters are dropped when they form a closing sequence:
// either nothing remains, or the character before them is a space or tab.
function scanHeading(text) {
  const ind = indentColsOf(text);
  if (ind.col > 3) return null;
  let p = ind.idx;
  let depth = 0;
  while (text[p] === '#') { depth++; p++; }
  if (depth === 0 || depth > 6) return null;
  if (p < text.length && !isSpaceCh(text[p])) return null;
  let content = text.slice(p).trim();
  if (content.endsWith('#')) {
    let end = content.length;
    while (end > 0 && content[end - 1] === '#') end--;
    const stripped = content.slice(0, end);
    if (stripped === '' || stripped.endsWith(' ') || stripped.endsWith('\t')) {
      content = stripped.trim();
    }
  }
  return { depth, text: content };
}

// --- fences -----------------------------------------------------------------

function scanFenceStart(text) {
  const ind = indentColsOf(text);
  if (ind.col > 3) return null;
  const c = text[ind.idx];
  if (c !== '`' && c !== '~') return null;
  let p = ind.idx;
  while (text[p] === c) p++;
  if (p - ind.idx < 3) return null;
  const info = text.slice(p);
  if (c === '`' && info.includes('`')) return null;
  return { ch: c, len: p - ind.idx, indentChars: ind.idx, info };
}

function lexFence(lines, i, start) {
  const content = [];
  let j = i + 1;
  while (j < lines.length) {
    const lt = lines[j].text;
    const ind = indentColsOf(lt);
    if (ind.col <= 3 && lt[ind.idx] === start.ch) {
      let p = ind.idx;
      while (lt[p] === start.ch) p++;
      if (p - ind.idx >= start.len && /^ *$/.test(lt.slice(p))) { j++; break; }
    }
    // content lines of a backtick fence lose up to the opening line's
    // indent, in characters; tilde fences keep their content verbatim
    let w = 0;
    while (lt[w] === ' ' || lt[w] === '\t') w++;
    content.push(start.ch === '`' ? lt.slice(Math.min(w, start.indentChars)) : lt);
    j++;
  }
  const info = start.info.trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
  const lang = info === '' ? '' : /^\S*/.exec(info)[0];
  return { token: { t: 'code', text: content.join('\n'), lang }, next: j };
}

// --- indented code ------------------------------------------------------------

function lexIndentedCode(lines, i) {
  const rawLines = [];
  let j = i;
  while (j < lines.length) {
    const lt = lines[j].text;
    if (isBlankLine(lt)) { rawLines.push(lt); j++; continue; }
    if (indentColsOf(lt).col >= 4) { rawLines.push(lt); j++; continue; }
    break;
  }
  let last = rawLines.length - 1;
  while (last >= 0 && isBlankLine(rawLines[last])) last--;
  const kept = rawLines.slice(0, last + 1);
  const content = kept.map((lt) => stripCodeIndent(lt));
  return { token: { t: 'code', text: content.join('\n'), lang: '' }, next: j };
}

// --- HTML blocks --------------------------------------------------------------

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col ' +
  'colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
  'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ' +
  'ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// The "an HTML block may begin here" test used for paragraph interruption:
// block-level tag names and the raw-text/comment/PI/declaration starts.
function htmlBeginAt(text, pos) {
  const s = text.slice(pos);
  if (s[0] !== '<') return false;
  if (s.startsWith('<!--') || s.startsWith('<?') || s.startsWith('<![CDATA[')) return true;
  if (/^<![a-zA-Z]/.test(s)) return true;
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(s);
  if (!m) return false;
  const name = m[2].toLowerCase();
  const after = s[m[0].length];
  if (m[1] === '' && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    return after === undefined || after === '>' || isSpaceCh(after);
  }
  if (!BLOCK_TAGS.has(name)) return false;
  return after === undefined || after === ' ' || after === '>' ||
    (after === '/' && s[m[0].length + 1] === '>');
}

// Which HTML block type (1-7) starts on this line, if any. Type 7 is only
// returned when `allowType7` is set (it cannot interrupt a paragraph).
function htmlBlockStart(text, allowType7) {
  const ind = indentColsOf(text);
  if (ind.col > 3) return null;
  const s = text.slice(ind.idx);
  if (s[0] !== '<') return null;
  if (s.startsWith('<!--')) return { type: 2 };
  if (s.startsWith('<?')) return { type: 3 };
  if (s.startsWith('<![CDATA[')) return { type: 5 };
  if (/^<![a-zA-Z]/.test(s)) return { type: 4 };
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(s);
  if (m) {
    const name = m[2].toLowerCase();
    const after = s[m[0].length];
    const boundary = after === undefined || after === '>' || isSpaceCh(after);
    if (m[1] === '' && (name === 'pre' || name === 'script' || name === 'style' || name === 'textarea') && boundary) {
      return { type: 1, name };
    }
    if (BLOCK_TAGS.has(name) &&
        (boundary || after === ' ' || (after === '/' && s[m[0].length + 1] === '>'))) {
      return { type: 6 };
    }
  }
  if (allowType7) {
    const tag = scanTag(text, ind.idx);
    if (tag !== null && /^[ \t]*$/.test(text.slice(tag.end))) return { type: 7 };
  }
  return null;
}

function lexHtmlBlock(lines, i, start) {
  let j = i;
  let closed = true;
  if (start.type >= 1 && start.type <= 5) {
    const needle = start.type === 1 ? '</' + start.name
      : start.type === 2 ? '-->'
      : start.type === 3 ? '?>'
      : start.type === 4 ? '>'
      : ']]>';
    closed = false;
    while (j < lines.length) {
      const found = start.type === 1
        ? lines[j].text.toLowerCase().includes(needle)
        : lines[j].text.includes(needle);
      j++;
      if (found) { closed = true; break; }
    }
  } else {
    while (j < lines.length && !isBlankLine(lines[j].text)) j++;
  }
  let text = '';
  for (let k = i; k < j; k++) text += lines[k].text + lines[k].eol;
  // The reference match also swallows the blank-line separator after the
  // block and then trims trailing blank lines from the raw text: a block
  // loses its final newline when the separator is a truly empty line;
  // for the marker-terminated types a whitespace-only next line still
  // leaves the newline in place.
  if (j < lines.length && text.endsWith('\n')) {
    const nextText = lines[j].text;
    const loses = start.type >= 6 ? isBlankLine(nextText) : nextText === '';
    if (loses) text = text.slice(0, -1);
  }
  if (!closed) {
    // an unterminated block runs to the end of the input; apply the same
    // trailing-blank trim to what it swallowed
    const parts = text.split('\n');
    let t = parts.length - 1;
    while (t >= 0 && /^[ \t]*$/.test(parts[t])) t--;
    if (parts.length - t > 2) text = parts.slice(0, t + 1).join('\n');
  }
  return { token: { t: 'html', text }, next: j };
}

// --- link reference definitions -----------------------------------------------

// Find where a balanced-paren scan fails: returns true when the string has
// an unescaped ')' with nothing to close, or unclosed '(' at the end.
function hasUnbalancedParens(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}

// Parse a definition at the start of `rest` (the source from a line start).
// Returns { length, href, title } or null.
function tryDef(st, rest) {
  let p = 0;
  let spaces = 0;
  while (rest[p] === ' ' && spaces < 4) { p++; spaces++; }
  if (spaces > 3 || rest[p] !== '[') return null;
  // label: escapes and any chars except unescaped brackets; a newline is
  // allowed when the next line is not blank
  let q = p + 1;
  let labelEnd = -1;
  while (q < rest.length) {
    const c = rest[q];
    if (c === '\\') { q += 2; continue; }
    if (c === '[') return null;
    if (c === ']') { labelEnd = q; break; }
    if (c === '\n') {
      let r = q + 1;
      while (rest[r] === ' ' || rest[r] === '\t') r++;
      if (r >= rest.length || rest[r] === '\n') return null;
      q++;
      continue;
    }
    q++;
  }
  if (labelEnd === -1 || rest[labelEnd + 1] !== ':') return null;
  const label = rest.slice(p + 1, labelEnd);
  if (label.trim() === '') return null;
  p = labelEnd + 2;
  while (rest[p] === ' ') p++;
  if (rest[p] === '\n') {
    p++;
    while (rest[p] === ' ' || rest[p] === '\t') p++;
  }
  // destination
  let href;
  let angle = false;
  if (rest[p] === '<') {
    let e = p + 1;
    while (e < rest.length && rest[e] !== '>' && rest[e] !== '\n') {
      if (rest[e] === '\\') e++;
      e++;
    }
    if (rest[e] !== '>') return null;
    href = rest.slice(p + 1, e);
    angle = true;
    p = e + 1;
  } else {
    let e = p;
    while (e < rest.length && !isSpaceCh(rest[e])) e++;
    if (e === p) return null;
    href = rest.slice(p, e);
    p = e;
  }
  if (!angle && hasUnbalancedParens(href)) return null;
  // Optional title. The separator is same-line whitespace, or whitespace
  // with a single newline; if no valid title follows, the definition
  // simply ends after the destination.
  let title = null;
  let endP = -1;
  const parseTitleAt = (r) => {
    const opener = rest[r];
    if (opener !== '"' && opener !== "'" && opener !== '(') return null;
    const closer = opener === '(' ? ')' : opener;
    let e = r + 1;
    let closed = false;
    while (e < rest.length) {
      const c = rest[e];
      if (c === '\\') { e += 2; continue; }
      if (c === closer) { closed = true; break; }
      if (opener === '(' && c === '(') return null;
      if (opener === "'" && c === '\n') {
        let nx = e + 1;
        while (rest[nx] === ' ' || rest[nx] === '\t') nx++;
        if (rest[nx] === '\n' || nx >= rest.length) return null;
      }
      e++;
    }
    if (!closed) return null;
    let a = e + 1;
    while (rest[a] === ' ') a++;
    if (a < rest.length && rest[a] !== '\n') return null;
    return { title: rest.slice(r + 1, e), end: a };
  };
  // path 1: whitespace on the same line, then a title
  {
    let r = p;
    while (rest[r] === ' ' || rest[r] === '\t') r++;
    if (r > p && r < rest.length && rest[r] !== '\n') {
      const t = parseTitleAt(r);
      if (t !== null) { title = t.title; endP = t.end; }
    }
  }
  // path 2: optional spaces, one newline, indent, then a title
  if (endP === -1) {
    let r = p;
    while (rest[r] === ' ') r++;
    if (rest[r] === '\n') {
      r++;
      while (rest[r] === ' ' || rest[r] === '\t') r++;
      const t = parseTitleAt(r);
      if (t !== null) { title = t.title; endP = t.end; }
    }
  }
  if (endP !== -1) {
    p = endP;
  } else {
    let a = p;
    while (rest[a] === ' ') a++;
    if (a < rest.length && rest[a] !== '\n') return null;
    p = a;
  }
  while (rest[p] === '\n') p++;
  const key = normalizeLabel(label);
  if (!st.defs.has(key)) st.defs.set(key, { href, title });
  return { length: p };
}

// --- tables -------------------------------------------------------------------

function tryTable(lines, i) {
  const headerLine = lines[i].text;
  if (!headerLine.includes('|')) return null;
  if (i + 1 >= lines.length) return null;
  const delimLine = lines[i + 1].text;
  if (!/[:|]/.test(delimLine)) return null;
  if (indentColsOf(delimLine).col > 3) return null;
  const dl = delimLine.replace(/^ {0,3}/, '');
  const delimTrim = dl.replace(/^\|/, '').replace(/\|[ \t]*$/, '');
  const delimCells = delimTrim.split('|');
  const align = [];
  for (const cell of delimCells) {
    if (/^ *-+: *$/.test(cell)) align.push('right');
    else if (/^ *:-+: *$/.test(cell)) align.push('center');
    else if (/^ *:-+ *$/.test(cell)) align.push('left');
    else if (/^ *-+:? *$/.test(cell) || /^ *:?-+: *$/.test(cell)) align.push(null);
    else return null;
  }
  const header = splitRow(headerLine.replace(/^ +/, ''));
  if (header.length !== align.length || header.length === 0) return null;
  const rows = [];
  let j = i + 2;
  while (j < lines.length) {
    const rowLine = lines[j].text;
    // body rows end at a line that is only spaces, or that starts a
    // thematic break, a heading, a blockquote, an indented code block
    // (indent plus at least one more character), a fence, a list item
    // (bullet or "1."/"1)" followed by space/tab) or an HTML block
    if (/^ *$/.test(rowLine)) break;
    if (isHrLine(rowLine) || /^ {0,3}#{1,6}(?:\s|$)/.test(rowLine)) break;
    const codePrefix = /^(?: {4}| {0,3}\t)/.exec(rowLine);
    if (codePrefix !== null && rowLine.length > codePrefix[0].length) break;
    if (scanFenceStart(rowLine) !== null) break;
    if (/^ {0,3}>/.test(rowLine)) break;
    const sp = leadingSpaces(rowLine);
    if (sp <= 3 && htmlBeginAt(rowLine, sp)) break;
    if (/^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(rowLine)) break;
    rows.push(splitRow(rowLine, header.length));
    j++;
  }
  return { token: { t: 'table', header, align, rows }, next: j };
}

// --- list markers ---------------------------------------------------------------

// Parse any list marker at a line start (at most 3 leading spaces).
// Returns { ordered, ch, start, markerEnd, rest } or null.
function scanListMarker(text) {
  const sp = leadingSpaces(text);
  if (sp > 3) return null;
  let p = sp;
  const c = text[p];
  let ordered = false;
  let ch;
  let start = 1;
  let markerEnd;
  if (c === '-' || c === '+' || c === '*') {
    ch = c;
    markerEnd = p + 1;
  } else if (isDigit(c)) {
    let q = p;
    while (q < text.length && isDigit(text[q]) && q - p < 9) q++;
    if (q === p) return null;
    const d = text[q];
    if (d !== '.' && d !== ')') return null;
    ordered = true;
    ch = d;
    start = parseInt(text.slice(p, q), 10);
    markerEnd = q + 1;
  } else {
    return null;
  }
  const rest = text.slice(markerEnd);
  const hasContent = rest !== '' && (rest[0] === ' ' || rest[0] === '\t') && /\S/.test(rest);
  return { ordered, ch, start, markerEnd, rest, hasContent };
}

// Does this line look like a list item line with at most `maxSpaces`
// leading spaces? (Used for list collection boundaries.)
function isBulletLine(text, maxSpaces) {
  const sp = leadingSpaces(text);
  if (sp > maxSpaces) return false;
  let p = sp;
  const c = text[p];
  if (c === '-' || c === '+' || c === '*') {
    p++;
  } else if (isDigit(c)) {
    let q = p;
    while (q < text.length && isDigit(text[q]) && q - p < 9) q++;
    if (q === p || (text[q] !== '.' && text[q] !== ')')) return false;
    p = q + 1;
  } else {
    return false;
  }
  const rest = text.slice(p);
  return rest === '' || rest[0] === ' ' || rest[0] === '\t';
}

// Match an item's first line against a specific bullet pattern.
function matchItemStart(text, pat) {
  const sp = leadingSpaces(text);
  if (sp > 3) return null;
  let p = sp;
  if (!pat.ordered) {
    if (text[p] !== pat.ch) return null;
    p++;
  } else {
    let q = p;
    while (q < text.length && isDigit(text[q]) && q - p < 9) q++;
    if (q === p || text[q] !== pat.delim) return null;
    p = q + 1;
  }
  const rest = text.slice(p);
  if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
  return { groupLen: p, rest };
}

function matchAnyItemStart(text) {
  const sp = leadingSpaces(text);
  if (sp > 3) return null;
  let p = sp;
  const c = text[p];
  let pat;
  let start = 1;
  if (c === '-' || c === '+' || c === '*') {
    pat = { ordered: false, ch: c };
    p++;
  } else if (isDigit(c)) {
    let q = p;
    while (q < text.length && isDigit(text[q]) && q - p < 9) q++;
    if (q === p) return null;
    const d = text[q];
    if (d !== '.' && d !== ')') return null;
    pat = { ordered: true, delim: d };
    start = parseInt(text.slice(p, q), 10);
    p = q + 1;
  } else {
    return null;
  }
  const rest = text.slice(p);
  if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
  return { pat, start, groupLen: p, rest };
}

// Construct-begin tests used while collecting list item lines: the line,
// allowing at most R leading spaces, begins the given construct.
function beginMatches(line, R, kind) {
  const sp = leadingSpaces(line);
  if (sp > R) return false;
  const rest = line.slice(sp);
  switch (kind) {
    case 'fence': return rest.startsWith('```') || rest.startsWith('~~~');
    case 'heading': return /^#{1,6}(\s|$)/.test(rest);
    case 'html': return htmlBeginAt(line, sp);
    case 'quote': return rest.startsWith('>');
    case 'hr': return HR_RE.test(rest);
    default: return false;
  }
}

// For the lazy-continuation break test: does this (already dedented) line
// begin a fence, heading, HTML block or thematic break?
function startsConstructLoose(text) {
  if (scanFenceStart(text) !== null) return true;
  if (scanHeading(text) !== null) return true;
  if (isHrLine(text)) return true;
  const sp = leadingSpaces(text);
  if (sp <= 3 && htmlBeginAt(text, sp)) return true;
  return false;
}

const LIST_IS_TASK_RE = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK_RE = /^\[[ xX]\][ \t]+/;

function tryList(st, lines, i) {
  const first = matchAnyItemStart(lines[i].text);
  if (first === null) return null;
  const items = [];
  let j = i;
  let loose = false;
  let prevEndsBlank = false;
  while (j < lines.length) {
    if (isHrLine(lines[j].text)) break;
    const m = matchItemStart(lines[j].text, first.pat);
    if (m === null) break;
    const b = m.groupLen;
    const gm = expandLeading(m.rest, b);
    const firstBlank = gm.trim() === '';
    let R;
    let dLines = [];
    let mPrev = gm;
    if (firstBlank) {
      R = b + 1;
    } else {
      let r0 = gm.search(/\S/);
      if (r0 > 4) r0 = 1;
      dLines = [gm.slice(r0)];
      R = r0 + b;
    }
    j++;
    let trailingBlanks = 0;
    let itemDone = false;
    if (firstBlank && j < lines.length && isBlankLine(lines[j].text)) {
      j++;
      trailingBlanks = 1;
      itemDone = true;
    }
    if (!itemDone) {
      let prevBlank = firstBlank;
      const R2 = Math.max(0, Math.min(3, R - 1));
      while (j < lines.length) {
        const f = lines[j].text;
        const Z = expandLeading(f, 0);
        if (beginMatches(f, R2, 'fence') || beginMatches(f, R2, 'heading') ||
            beginMatches(f, R2, 'html') || beginMatches(f, R2, 'quote') ||
            isBulletLine(f, R2) || beginMatches(f, R2, 'hr')) {
          break;
        }
        const zFirst = Z.search(/\S/);
        if ((zFirst !== -1 && zFirst >= R) || isBlankLine(f)) {
          dLines.push(Z.slice(R));
          trailingBlanks = isBlankLine(f) ? trailingBlanks + 1 : 0;
        } else {
          // lazy continuation candidate
          const mExpanded = mPrev.replace(/\t/g, '    ');
          if (prevBlank || mExpanded.search(/\S/) >= 4 || startsConstructLoose(mPrev)) {
            break;
          }
          if (isSetextLine(f) && mPrev.length > 0 &&
              scanListMarker(mPrev) === null && scanFenceStart(mPrev) === null &&
              !isHrLine(mPrev) && scanHeading(mPrev) === null) {
            dLines.push('    ' + Z.replace(/^ {0,3}/, ''));
          } else {
            dLines.push(f);
          }
          trailingBlanks = 0;
        }
        prevBlank = isBlankLine(f);
        mPrev = Z.slice(R);
        j++;
      }
    }
    const endsBlank = trailingBlanks > 0;
    if (!loose) {
      if (prevEndsBlank) loose = true;
      else if (endsBlank) prevEndsBlank = true;
    }
    items.push({ dLines, trailingBlanks });
  }
  if (items.length === 0) return null;
  // the list's raw text is end-trimmed: blank lines absorbed at the end
  // of the last item are handed back to the enclosing lexer
  const lastTrailing = items[items.length - 1].trailingBlanks;
  const listNext = j - lastTrailing;
  const outItems = items.map((item, n) => {
    const isLastItem = n === items.length - 1;
    // the last item's text is end-trimmed before it is lexed
    const d = isLastItem ? item.dLines.join('\n').trimEnd() : item.dLines.join('\n');
    const spans = [];
    const tokens = lexBlocks(st, d, false, null, spans);
    // looseness from blank-line gaps between the item's own blocks (a
    // blank line inside a nested construct is part of that construct's
    // span and does not count)
    if (!loose && spans.length > 0) {
      for (let k = 1; k < spans.length; k++) {
        if (spans[k][0] > spans[k - 1][1]) { loose = true; break; }
      }
      if (!loose && spans[0][0] >= 2) loose = true;
      if (!loose && !isLastItem && item.dLines.length - spans[spans.length - 1][1] >= 1) {
        loose = true;
      }
    }
    let task = false;
    let checked = false;
    if (LIST_IS_TASK_RE.test(d)) {
      task = true;
      checked = d[1] !== ' ';
      const firstTok = tokens[0];
      if (firstTok && firstTok.t === 'text') {
        firstTok.text = firstTok.text.replace(LIST_REPLACE_TASK_RE, '');
      }
    }
    return { tokens, task, checked };
  });
  return {
    token: { t: 'list', ordered: first.pat.ordered, start: first.start, loose, items: outItems },
    next: listNext,
  };
}

// --- blockquotes ----------------------------------------------------------------

const QUOTE_MARKER_RE = /^ {0,3}>/;
const QUOTE_STRIP_RE = /^ {0,3}>[ \t]?/;

// Transform collected quote lines into inner content lines: expand the
// whitespace after each marker, indent lazy setext underlines (so they
// stay paragraph text), then strip the markers.
function buildQuoteContent(rawLines) {
  return rawLines.map((line, idx) => {
    if (idx > 0 && !QUOTE_MARKER_RE.test(line) && isSetextLine(line)) {
      return '    ' + line.trim();
    }
    let out = line;
    const m = /^( {0,3}>)([ \t]+)/.exec(out);
    if (m) out = m[1] + expandWsRun(m[2], m[1].length) + out.slice(m[0].length);
    return out.replace(QUOTE_STRIP_RE, '');
  });
}

// A line that cannot lazily continue a blockquote paragraph: it begins a
// fence, heading, thematic break, list item or HTML block.
function quoteLazyExcluded(text) {
  if (scanFenceStart(text) !== null) return true;
  if (scanHeading(text) !== null) return true;
  if (isHrLine(text)) return true;
  if (isBulletLine(text, 3)) return true;
  const sp = leadingSpaces(text);
  if (sp <= 3 && htmlBeginAt(text, sp)) return true;
  return false;
}

// Line indices where a new blockquote chunk begins: a lazy line that
// directly follows a marked line starts a new chunk.
function quoteSegments(rawLines) {
  const segs = new Set();
  for (let k = 1; k < rawLines.length; k++) {
    if (!QUOTE_MARKER_RE.test(rawLines[k]) && QUOTE_MARKER_RE.test(rawLines[k - 1])) {
      segs.add(k);
    }
  }
  return segs;
}

function tryBlockquote(st, lines, i) {
  const rawLines = [];
  let j = i;
  while (j < lines.length) {
    const text = lines[j].text;
    if (QUOTE_MARKER_RE.test(text)) {
      rawLines.push(text);
      j++;
      continue;
    }
    if (rawLines.length === 0 || isBlankLine(text)) break;
    // lazy continuation: judge against the inner content collected so far
    const inner = buildQuoteContent(rawLines);
    if (isBlankLine(inner[inner.length - 1])) break;
    const tokensSoFar = lexBlocks(st, inner.join('\n'), true, quoteSegments(rawLines));
    const last = tokensSoFar[tokensSoFar.length - 1];
    if (last && last.t === 'paragraph' && !quoteLazyExcluded(text)) {
      rawLines.push(text);
      j++;
      continue;
    }
    if (last && (last.t === 'list' || last.t === 'blockquote') && !quoteLazyExcluded(text)) {
      const trialInner = buildQuoteContent([...rawLines, text]);
      const trialTokens = lexBlocks(st, trialInner.join('\n'), true, quoteSegments([...rawLines, text]));
      const tLast = trialTokens[trialTokens.length - 1];
      if (trialTokens.length === tokensSoFar.length && tLast && tLast.t === last.t &&
          JSON.stringify(tLast) !== JSON.stringify(last)) {
        rawLines.push(text);
        j++;
        continue;
      }
    }
    break;
  }
  if (rawLines.length === 0) return null;
  const inner = buildQuoteContent(rawLines);
  const tokens = lexBlocks(st, inner.join('\n'), true, quoteSegments(rawLines));
  return { token: { t: 'blockquote', tokens }, next: j };
}

// --- setext headings and paragraphs ----------------------------------------------

function lheadingExcluded(text) {
  if (scanFenceStart(text) !== null) return true;
  if (scanHeading(text) !== null) return true;
  if (isHrLine(text)) return true;
  if (QUOTE_MARKER_RE.test(text)) return true;
  const lm = scanListMarker(text);
  if (lm !== null && text[lm.markerEnd] === ' ') return true;
  const sp = leadingSpaces(text);
  if (sp <= 3 && text[sp] === '<' && text.includes('>')) return true;
  if (/^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/.test(text)) return true;
  return false;
}

function tryLheading(lines, i) {
  let j = i;
  while (j < lines.length) {
    const text = lines[j].text;
    if (isBlankLine(text)) return null;
    if (j > i && isSetextLine(text)) {
      const level = text.trimStart().startsWith('=') ? 1 : 2;
      const body = lines.slice(i, j).map((l) => l.text).join('\n').trim();
      return { token: { t: 'heading', depth: level, text: body }, next: j + 1 };
    }
    if (j > i && lheadingExcluded(text)) return null;
    j++;
  }
  return null;
}

function interruptsParagraph(text) {
  if (scanFenceStart(text) !== null) return true;
  if (scanHeading(text) !== null) return true;
  if (isHrLine(text)) return true;
  if (QUOTE_MARKER_RE.test(text)) return true;
  const lm = scanListMarker(text);
  if (lm !== null && lm.hasContent && (!lm.ordered || lm.start === 1)) return true;
  if (htmlBlockStart(text, false) !== null) return true;
  return false;
}

function lexParagraph(lines, i, segStarts) {
  let j = i + 1;
  while (j < lines.length) {
    if (segStarts && segStarts.has(j)) break;
    const text = lines[j].text;
    // a whitespace-only line ends the paragraph, unless it is the final
    // line of the input with no line ending of its own
    if (isBlankLine(text) && lines[j].eol !== '') break;
    if (isSetextLine(text)) break;
    if (tryTable(lines, j) !== null) break;
    if (interruptsParagraph(text)) break;
    j++;
  }
  const body = lines.slice(i, j).map((l) => l.text).join('\n');
  return { token: { t: 'paragraph', text: body }, next: j };
}

// --- text runs (item-level lexing) --------------------------------------------

// In item-level lexing, plain text is gathered line by line. A following
// indented code block or link definition, when it directly abuts the text,
// is absorbed into the text instead of becoming its own block.
function lexTextRun(st, lines, i) {
  const parts = [lines[i].text];
  let j = i + 1;
  while (j < lines.length) {
    const text = lines[j].text;
    if (isBlankLine(text)) break;
    if (indentColsOf(text).col >= 4) {
      const r = lexIndentedCode(lines, j);
      parts.push(r.token.text);
      j = r.next;
      continue;
    }
    if (scanFenceStart(text) !== null) break;
    if (scanHeading(text) !== null) break;
    if (isHrLine(text)) break;
    if (QUOTE_MARKER_RE.test(text)) break;
    if (tryList(st, lines, j) !== null) break;
    if (htmlBlockStart(text, true) !== null) break;
    if (/^ {0,3}\[/.test(text)) {
      const rest = lines.slice(j).map((l) => l.text + l.eol).join('');
      const probe = { defs: new Map() };
      const defRes = tryDef(probe, rest);
      if (defRes !== null) {
        const seg = rest.slice(0, defRes.length);
        const nlCount = (seg.match(/\n/g) || []).length;
        parts.push(seg.replace(/\n$/, ''));
        j += nlCount + (seg.endsWith('\n') || seg === '' ? 0 : 1);
        continue;
      }
    }
    if (tryTable(lines, j) !== null) break;
    if (tryLheading(lines, j) !== null) break;
    parts.push(text);
    j++;
  }
  return { token: { t: 'text', text: parts.join('\n') }, next: j };
}

// --- the block lexer ---------------------------------------------------------------

// Lex a block-level source into tokens. `top` selects document-level
// (multi-line paragraphs) versus item-level (text runs) paragraph
// handling. `segStarts`, when given, holds line indices where a new
// blockquote chunk begins: a code block or definition starting there is
// absorbed into a preceding paragraph token, and a paragraph starting
// there merges with it. `spansOut`, when given, collects [from, to) line
// spans per token.
function lexBlocks(st, src, top, segStarts, spansOut) {
  const lines = splitLines(src);
  const tokens = [];
  const push = (tok, from, to) => {
    tokens.push(tok);
    if (spansOut) spansOut.push([from, to]);
  };
  let i = 0;
  while (i < lines.length) {
    const text = lines[i].text;
    if (isBlankLine(text)) { i++; continue; }
    const atSeg = segStarts !== undefined && segStarts !== null && segStarts.has(i) && tokens.length > 0;
    if (atSeg) {
      const last = tokens[tokens.length - 1];
      if (last.t === 'paragraph' && indentColsOf(text).col >= 4) {
        const r = lexIndentedCode(lines, i);
        last.text += '\n' + r.token.text;
        if (spansOut) spansOut[spansOut.length - 1][1] = r.next;
        i = r.next;
        continue;
      }
      if (last.t === 'paragraph' && /^ {0,3}\[/.test(text)) {
        const rest = lines.slice(i).map((l) => l.text + l.eol).join('');
        const probe = { defs: new Map() };
        const defRes = tryDef(probe, rest);
        if (defRes !== null) {
          const core = rest.slice(0, defRes.length).replace(/\n+$/, '');
          last.text += '\n' + core;
          const consumedLines = core === '' ? 0 : core.split('\n').length;
          if (spansOut) spansOut[spansOut.length - 1][1] = i + consumedLines;
          i += consumedLines;
          continue;
        }
      }
    }
    if (indentColsOf(text).col >= 4) {
      const r = lexIndentedCode(lines, i);
      push(r.token, i, r.next);
      i = r.next;
      continue;
    }
    const fence = scanFenceStart(text);
    if (fence !== null) {
      const r = lexFence(lines, i, fence);
      push(r.token, i, r.next);
      i = r.next;
      continue;
    }
    const heading = scanHeading(text);
    if (heading !== null) {
      push({ t: 'heading', depth: heading.depth, text: heading.text }, i, i + 1);
      i++;
      continue;
    }
    if (isHrLine(text)) {
      push({ t: 'hr' }, i, i + 1);
      i++;
      continue;
    }
    if (QUOTE_MARKER_RE.test(text)) {
      const r = tryBlockquote(st, lines, i);
      if (r !== null) {
        push(r.token, i, r.next);
        i = r.next;
        continue;
      }
    }
    const list = tryList(st, lines, i);
    if (list !== null) {
      push(list.token, i, list.next);
      i = list.next;
      continue;
    }
    const htmlStart = htmlBlockStart(text, true);
    if (htmlStart !== null) {
      const r = lexHtmlBlock(lines, i, htmlStart);
      push(r.token, i, r.next);
      i = r.next;
      continue;
    }
    if (/^ {0,3}\[/.test(text)) {
      const rest = lines.slice(i).map((l) => l.text + l.eol).join('');
      const defRes = tryDef(st, rest);
      if (defRes !== null) {
        let consumed = defRes.length;
        while (consumed > 0 && i < lines.length) {
          const len = lines[i].text.length + lines[i].eol.length;
          if (len > consumed) break;
          consumed -= len;
          i++;
        }
        continue;
      }
    }
    const table = tryTable(lines, i);
    if (table !== null) {
      push(table.token, i, table.next);
      i = table.next;
      continue;
    }
    const lheading = tryLheading(lines, i);
    if (lheading !== null) {
      push(lheading.token, i, lheading.next);
      i = lheading.next;
      continue;
    }
    if (top) {
      const para = lexParagraph(lines, i, segStarts);
      if (atSeg && tokens.length > 0 && tokens[tokens.length - 1].t === 'paragraph') {
        tokens[tokens.length - 1].text += '\n' + para.token.text;
        if (spansOut) spansOut[spansOut.length - 1][1] = para.next;
      } else {
        push(para.token, i, para.next);
      }
      i = para.next;
    } else {
      const run = lexTextRun(st, lines, i);
      push(run.token, i, run.next);
      i = run.next;
    }
  }
  return tokens;
}

// --- block rendering -----------------------------------------------------------------

function renderCodeBlock(token) {
  const text = token.text;
  const tail = text === '' || text.endsWith('\n') ? '' : '\n';
  const langAttr = token.lang ? ' class="language-' + escapeHtml(token.lang, false) + '"' : '';
  return '<pre><code' + langAttr + '>' + escapeHtml(text, true) + tail + '</code></pre>\n';
}

function renderTable(st, token) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < token.header.length; c++) {
    const align = token.align[c];
    out += '<th' + (align ? ' align="' + align + '"' : '') + '>' +
      renderInline(st, token.header[c], false) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (token.rows.length > 0) {
    out += '<tbody>';
    for (const row of token.rows) {
      out += '<tr>\n';
      for (let c = 0; c < token.header.length; c++) {
        const align = token.align[c];
        const cell = c < row.length ? row[c] : '';
        out += '<td' + (align ? ' align="' + align + '"' : '') + '>' +
          renderInline(st, cell, false) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  return out + '</table>\n';
}

function renderList(st, token) {
  const tag = token.ordered ? 'ol' : 'ul';
  let out = '<' + tag;
  if (token.ordered && token.start !== 1) out += ' start="' + token.start + '"';
  out += '>\n';
  for (const item of token.items) {
    let body;
    if (item.task) {
      const checkbox = '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox">';
      const firstTok = item.tokens[0];
      if (token.loose && firstTok && (firstTok.t === 'text' || firstTok.t === 'paragraph')) {
        body = '<p>' + checkbox + ' ' + renderInline(st, firstTok.text, false) + '</p>\n' +
          renderTokens(st, item.tokens.slice(1), false);
      } else {
        body = checkbox + ' ' + renderTokens(st, item.tokens, !token.loose);
      }
    } else {
      body = renderTokens(st, item.tokens, !token.loose);
    }
    out += '<li>' + body + '</li>\n';
  }
  return out + '</' + tag + '>\n';
}

function renderTokens(st, tokens, tight) {
  let out = '';
  for (const token of tokens) {
    switch (token.t) {
      case 'code':
        out += renderCodeBlock(token);
        break;
      case 'heading':
        out += '<h' + token.depth + '>' + renderInline(st, token.text, false) + '</h' + token.depth + '>\n';
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(st, token.tokens, false) + '</blockquote>\n';
        break;
      case 'list':
        out += renderList(st, token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'table':
        out += renderTable(st, token);
        break;
      case 'paragraph':
        if (tight) out += renderInline(st, token.text, false);
        else out += '<p>' + renderInline(st, token.text, false) + '</p>\n';
        break;
      case 'text':
        if (tight) out += renderInline(st, token.text, false);
        else out += '<p>' + renderInline(st, token.text, false) + '</p>\n';
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const st = { defs: new Map(), inLink: false, sawBracketLink: false, lastLabelHadLink: false };
  const tokens = lexBlocks(st, src, true);
  return renderTokens(st, tokens, false);
}
