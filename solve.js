// solve.js — a fast, dependency-free drop-in for makefun-site 1.0.0.
//
// Written from scratch in this session from the makefun-site README spec:
// a static site generator that answers exactly as makefun-site 1.0.0 does on
// every input, byte for byte, but faster. run(input) takes one parsed
// makefun-site input tree and returns the output tree {path: text}.
//
// Speed strategy: hand-rolled parsers driven by first-character dispatch,
// a fused Markdown lexer+renderer (no token objects), batched plain-text
// spans through a single-pass escape, per-case caches for slugs and dates,
// and a flat-instruction template interpreter with a scope stack.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Per-case caches, recreated at the start of every run().
let SLUG_CACHE;
let DATE_CACHE;

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const p of rel.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(p);
  }
  return parts.join('/');
}

// ---- escaping -----------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_RE = /[&<>"']/g;

function escapeHtml(s) {
  if (!ESCAPE_TEST.test(s)) return s;
  return s.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]);
}

// ---- slugs and dates ----------------------------------------------------

function slugify(text) {
  const hit = SLUG_CACHE.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  SLUG_CACHE.set(text, out);
  return out;
}

function longDate(date) {
  const hit = DATE_CACHE.get(date);
  if (hit !== undefined) return hit;
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const out = `${d} ${MONTHS[m - 1]} ${y}`;
  DATE_CACHE.set(date, out);
  return out;
}

function uniqueSlug(base, used) {
  let slug = base;
  let n = 2;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

// ---- whitespace helpers ---------------------------------------------------

function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function countWordsLine(line) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    if (isWSCode(line.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---- front matter ---------------------------------------------------------

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function fmString(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function daysIn(y, m) {
  if (m === 2) return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmDate(raw) {
  let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
  if (ok) {
    for (let i = 0; i < 10; i++) {
      if (i === 4 || i === 7) continue;
      const c = raw.charCodeAt(i);
      if (c < 48 || c > 57) { ok = false; break; }
    }
  }
  if (ok) {
    const y = Number(raw.slice(0, 4));
    const mo = Number(raw.slice(5, 7));
    const d = Number(raw.slice(8, 10));
    if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
  }
  if (!ok) {
    return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  return { value: raw };
}

function fmTags(raw) {
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
    return { error: 'key "tags": not a list [a, b]' };
  }
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const tags = inner.split(',');
  for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
  for (const t of tags) {
    if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
  }
  return { value: tags };
}

function isTemplateName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugRaw(s) {
  if (s.length === 0 || s.length > 64) return false;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return false;
    i++;
    while (i < n) {
      const d = s.charCodeAt(i);
      if ((d >= 97 && d <= 122) || (d >= 48 && d <= 57)) i++;
      else break;
    }
    if (i === n) return true;
    if (s.charCodeAt(i) !== 45) return false; // '-'
    i++;
    if (i === n) return false; // trailing '-'
  }
  return true;
}

function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const r = fmString(raw);
    if ('error' in r) return { error: `key "${key}": ${r.error}` };
    return { value: r.value };
  }
  if (key === 'date') return fmDate(raw);
  if (key === 'tags') return fmTags(raw);
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (!isTemplateName(raw)) return { error: 'key "layout": not a template name' };
    return { value: raw };
  }
  // slug
  if (!isSlugRaw(raw)) return { error: 'key "slug": not a slug' };
  return { value: raw };
}

function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue; // blank or '#'
    let j = 0;
    const L = line.length;
    while (j < L) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || j >= L || line.charCodeAt(j) !== 58) {
      return { error: `line ${i + 1} is not "key: value"` };
    }
    const key = line.slice(0, j);
    let raw;
    if (j + 1 === L) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---- Markdown -------------------------------------------------------------

function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  const L = line.length;
  while (j < L) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < L) {
    const c = line.charCodeAt(j);
    if (c === 32 || c === 9) j++;
    else return null;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  let h = 0;
  while (h < 6 && line.charCodeAt(h) === 35) h++;
  if (h === 0) return null;
  let j = h;
  if (line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9) return null;
  while (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9) j++;
  let e = line.length;
  while (e > j) {
    const d = line.charCodeAt(e - 1);
    if (d === 32 || d === 9) e--;
    else break;
  }
  if (e <= j) return null;
  return { depth: h, text: line.slice(j, e) };
}

function isHeadingLine(line) {
  let h = 0;
  while (h < 6 && line.charCodeAt(h) === 35) h++;
  if (h === 0) return false;
  let j = h;
  if (line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9) return false;
  while (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9) j++;
  return j < line.length;
}

function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 45) {
    if (line.charCodeAt(1) !== 45 || line.charCodeAt(2) !== 45) return false;
  } else if (c0 === 42) {
    if (line.charCodeAt(1) !== 42 || line.charCodeAt(2) !== 42) return false;
  } else return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedOf(line) {
  let j = 0;
  while (j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: line.slice(0, j), text: line.slice(j + 2) };
}

function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (line.charCodeAt(j) === 32) j++;
  if (j >= line.length) return false;
  return !isWSCode(line.charCodeAt(j));
}

function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return isHeadingLine(line);
  if (c0 === 45 || c0 === 42) return isHR(line);
  return line.length === 0;
}

// ---- inline ---------------------------------------------------------------

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s[j] !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// Inline markup. Plain-text spans between markup are batched through one
// escapeHtml call each, and escapeHtml returns its input unchanged when the
// span holds no special character, so most text costs no copying at all.
function inline(s, linkFn) {
  const parts = [];
  let plain = 0;
  let i = 0;
  const L = s.length;
  while (i < L) {
    const c = s[i];
    if (c === '\\' && i + 1 < L && ESCAPABLE.has(s[i + 1])) {
      if (i > plain) parts.push(escapeHtml(s.slice(plain, i)));
      parts.push(escapeHtml(s[i + 1]));
      i += 2;
      plain = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) parts.push(escapeHtml(s.slice(plain, i)));
        parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plain) parts.push(escapeHtml(s.slice(plain, i)));
          parts.push('<strong>', inline(s.slice(i + 2, j), linkFn), '</strong>');
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > plain) parts.push(escapeHtml(s.slice(plain, i)));
        parts.push('<em>', inline(s.slice(i + 1, j), linkFn), '</em>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        if (i > plain) parts.push(escapeHtml(s.slice(plain, i)));
        parts.push('<a href="', escapeHtml(linkFn(target)), '">',
          inline(s.slice(i + 1, k), linkFn), '</a>');
        i = m + 1;
        plain = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (L > plain) parts.push(escapeHtml(s.slice(plain, L)));
  return parts.join('');
}

// Render one Markdown source body. Returns {html, toc, excerpt, words}.
// The lexer and renderer are fused: each source line is visited once and
// rendered straight into the output array, with no token objects.
function renderMarkdown(src, linkFn) {
  const lines = src.split('\n');
  const n = lines.length;
  let words = 0;
  for (let k = 0; k < n; k++) words += countWordsLine(lines[k]);
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  // First-character dispatch: a line can only be a fence, heading, break,
  // quote or list when it opens on that block's first character, so most
  // lines take one cheap branch instead of six full checks. A blank line
  // opens on a space, a tab, or nothing, and reaches the blank check below.
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    let bt = null;
    let od = null;
    if (c0 === 96) { // '`'
      const lang = fenceLang(line);
      if (lang !== null) {
        let code = '';
        i++;
        while (i < n && !isFenceClose(lines[i])) {
          code += escapeHtml(lines[i]) + '\n';
          i++;
        }
        i++; // skip the close line (or step past the end)
        const cls = lang === '' ? '' : ` class="language-${lang}"`;
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) { // '#'
      const h = headingOf(line);
      if (h !== null) {
        let id = slugify(h.text);
        if (ids.has(id)) {
          let k = 2;
          while (ids.has(`${id}-${k}`)) k++;
          id = `${id}-${k}`;
        }
        ids.add(id);
        const headingHtml = inline(h.text, linkFn);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: headingHtml });
        blocks.push(`<h${h.depth} id="${id}">${headingHtml}</h${h.depth}>`);
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' or '*'
      if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
      bt = bulletText(line);
    } else if (c0 === 62) { // '>'
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0
        ? '<blockquote>\n</blockquote>'
        : `<blockquote>\n<p>${inline(kept.join('\n'), linkFn)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // digit
      od = orderedOf(line);
    }
    if (bt === null && od === null) {
      if (isBlankLine(line)) { i++; continue; }
      // paragraph: consume lines until a blank line or a block starter
      const body = [trimLine(line)];
      i++;
      while (i < n && !endsParagraph(lines[i])) {
        body.push(trimLine(lines[i]));
        i++;
      }
      const html = inline(body.join('\n'), linkFn);
      if (excerpt === null) excerpt = html;
      blocks.push(`<p>${html}</p>`);
      continue;
    }
    // list (bullet or ordered)
    {
      const isOrdered = od !== null;
      const items = [];
      const startNum = isOrdered ? Number(od.num) : 1;
      if (isOrdered) items.push([trimLine(od.text)]);
      else items.push([trimLine(bt)]);
      i++;
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
        } else {
          const t = bulletText(l);
          if (t !== null) { items.push([trimLine(t)]); i++; continue; }
        }
        if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      let lis = '';
      for (const parts of items) lis += `<li>${inline(parts.join('\n'), linkFn)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
  }
  return {
    html: blocks.length === 0 ? '' : blocks.join('\n') + '\n',
    toc, excerpt: excerpt === null ? '' : excerpt, words,
  };
}
// ---- templates ------------------------------------------------------------

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function lookup(stack, path) {
  for (let s = stack.length - 1; s >= 0; s--) {
    const vars = stack[s];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

// Tokenize one template source. A {% %} tag alone on its line (only spaces
// or tabs beside it) takes its whole line with it, its newline included.
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({
        t: raw ? 'raw' : 'var',
        path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) {
      throw new TemplateError(`template "${name}": a {% is not closed`);
    }
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Parse tokens into a node tree (root/for/if/text/var/raw/include).
function parseTokens(name, tokens) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokens) {
    if (tok.t === 'text') { body.push({ kind: 'text', text: tok.text }); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push({ kind: tok.t, path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = {
        kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null,
      };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) {
        throw new TemplateError(`template "${name}": an else outside an if`);
      }
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TemplateError(
          `template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body
        : parent.kind === 'for' ? parent.body
        : parent.else ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(
      `template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root.body;
}

// Flatten a node tree into instructions:
// [0, text] text | [1, path] escaped var | [2, path] raw var
// [3, path, not, elsePc, endPc] if | [4, name, path, endPc] for
// [5] endfor | [6, targetPc] jump | [7, name] include
function flatten(nodes, out) {
  for (const n of nodes) {
    if (n.kind === 'text') out.push([0, n.text]);
    else if (n.kind === 'var') out.push([1, n.path]);
    else if (n.kind === 'raw') out.push([2, n.path]);
    else if (n.kind === 'if') {
      const idx = out.length;
      out.push([3, n.path, n.not, -1, -1]);
      flatten(n.then, out);
      if (n.else !== null) {
        const jumpIdx = out.length;
        out.push([6, -1]);
        const elseStart = out.length;
        flatten(n.else, out);
        out[idx][3] = elseStart;
        out[idx][4] = out.length;
        out[jumpIdx][1] = out.length;
      } else {
        out[idx][3] = -1;
        out[idx][4] = out.length;
      }
    } else if (n.kind === 'for') {
      const idx = out.length;
      out.push([4, n.name, n.path, -1]);
      flatten(n.body, out);
      out.push([5]);
      out[idx][3] = out.length - 1;
    } else if (n.kind === 'include') out.push([7, n.name]);
  }
}

function compileTemplate(name, src) {
  const insts = [];
  flatten(parseTokens(name, tokenize(name, src)), insts);
  return insts;
}

// Render compiled instructions. `stack` is the scope stack (root first).
// One vars object per for is reused across its iterations: rendering is
// synchronous, so nothing can observe the object between iterations.
function renderTemplate(insts, stack, templates, out, depth) {
  const loops = [];
  let pc = 0;
  while (pc < insts.length) {
    const ins = insts[pc];
    switch (ins[0]) {
      case 0: out.push(ins[1]); pc++; break;
      case 1: out.push(escapeHtml(textOf(lookup(stack, ins[1])))); pc++; break;
      case 2: out.push(textOf(lookup(stack, ins[1]))); pc++; break;
      case 3: {
        const v = truthy(lookup(stack, ins[1]));
        if (v !== ins[2]) pc++;
        else pc = ins[3] !== -1 ? ins[3] : ins[4];
        break;
      }
      case 4: {
        const xs = lookup(stack, ins[2]);
        if (!Array.isArray(xs) || xs.length === 0) { pc = ins[3] + 1; break; }
        const vars = {};
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        vars[ins[1]] = xs[0];
        vars.loop = loop;
        stack.push(vars);
        loops.push({ forPc: pc, xs, k: 0, vars, loop, name: ins[1] });
        pc++;
        break;
      }
      case 5: {
        const fr = loops[loops.length - 1];
        fr.k++;
        if (fr.k < fr.xs.length) {
          fr.vars[fr.name] = fr.xs[fr.k];
          fr.loop.index = fr.k + 1;
          fr.loop.first = fr.k === 0;
          fr.loop.last = fr.k === fr.xs.length - 1;
          pc = fr.forPc + 1;
        } else {
          loops.pop();
          stack.pop();
          pc++;
        }
        break;
      }
      case 6: pc = ins[1]; break;
      case 7: {
        const t = templates.get(ins[1]);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          renderTemplate(t, stack, templates, out, depth + 1);
        }
        pc++;
        break;
      }
    }
  }
}

// ---- build ---------------------------------------------------------------

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      b.sources.push({
        path: f.path,
        text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content,
      });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

function frontMatterPhase(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

function markdownPhase(b) {
  const staticPaths = new Set();
  for (const f of b.statics) staticPaths.add(f.path);
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const linkFn = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) {
        return target;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = b.bySource.get(path);
        if (pg !== undefined) return pg.url + frag;
        if (staticPaths.has(path)) return `${b.base}/${path}${frag}`;
      }
      b.broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, linkFn);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }
}

function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

function ownTags(s) {
  const seen = new Set();
  const out = [];
  const tags = s.data.tags ?? [];
  for (const name of tags) {
    const sl = slugify(name);
    if (!seen.has(sl)) { seen.add(sl); out.push(name); }
  }
  return out;
}

function tagsPhase(b) {
  const bySlug = new Map();
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) {
        bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      }
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? {
        name, slug: slugify(name), url: '', posts: [],
      });
    }
  }
  b.tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

const linkOf = (s) => (s === null ? null : {
  title: s.data.title,
  url: s.url,
  date: s.data.date ?? '',
  date_long: s.data.date === undefined ? '' : longDate(s.data.date),
});

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({
    name: t.name, slug: t.slug, url: t.url, count: t.posts.length,
  }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  // One root scope object reused across renders: the per-render fields are
  // set (or cleared to undefined) before each render, and a field that
  // reads undefined behaves exactly like an absent field.
  const rootVars = {
    site, tags: allTags, recent, page: undefined, posts: undefined,
    pager: undefined, tag: undefined,
  };
  const render = (name, vars) => {
    const insts = b.templates.get(name);
    if (insts === undefined) return null;
    rootVars.page = vars.page;
    rootVars.posts = vars.posts;
    rootVars.pager = vars.pager;
    rootVars.tag = vars.tag;
    const out = [];
    renderTemplate(insts, [rootVars], b.templates, out, 0);
    return out.join('');
  };
  for (const s of b.sources) {
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const tag = {
      name: t.name,
      slug: t.slug,
      url: t.url,
      count: t.posts.length,
      posts: t.posts.map((p) => b.cards.get(p)),
    };
    const html = render('tag', { tag });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) {
      b.report.push(`shadowed ${f.path}: a built page has its path`);
    } else b.output[f.path] = f.content;
  }
}

function reportPhase(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(
    `built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

export function run(input) {
  SLUG_CACHE = new Map();
  DATE_CACHE = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  readSources(b);
  frontMatterPhase(b);
  permalinks(b);
  markdownPhase(b);
  collections(b);
  tagsPhase(b);
  layouts(b);
  reportPhase(b);
  return b.output;
}
