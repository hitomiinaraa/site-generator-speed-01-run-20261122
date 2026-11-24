// solve.js — a fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns:
// a JSON object of every path it writes and that file's text, byte for byte.
// Written from the reference's stated rules (its README) and its behaviour; every
// rule is implemented to match the reference exactly, with the work reorganised
// for speed: single-pass rendering, bulk text escaping, an ASCII fast path for
// slugs, and a template interpreter that writes into chunk arrays instead of
// concatenating strings. No dependencies, no I/O, no clock, no randomness.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' . */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. One regex scan; unchanged text is returned as-is. */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  if (last === 0) return text;
  return out + text.slice(last);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text`, for text holding no character above ASCII: NFKD is the identity there. */
function slugifyAscii(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) return null; // not pure ASCII: the caller falls back to the full rule
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/**
 * The slug of `text`: the text in Unicode NFKD, its combining marks dropped; A-Z lowered; each run of
 * characters other than a-z and 0-9 one "-", none at either end; cut to 64 characters, a "-" left at the
 * cut dropped; `untitled` when nothing is left.
 */
function slugify(text) {
  const fast = slugifyAscii(text);
  if (fast !== null) return fast;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace (no allocation). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
    else if (c < 128) {
      if (!inWord) {
        inWord = true;
        count++;
      }
    } else if (
      c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
      c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
    ) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is a run of a-z, 0-9 and `-` only. */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug (a-z and 0-9, single `-` between), at most 64 characters. */
function isSlugValue(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true; // a leading dash is not allowed, so pretend the previous char was one
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. The body is a slice of the source, never re-joined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // The close line: a line that is exactly '---'.
  let closeStart = -1;
  let i = text.indexOf('\n---', 3);
  while (i !== -1) {
    const after = i + 4;
    if (after === text.length || text[after] === '\n') {
      closeStart = i + 1;
      break;
    }
    i = text.indexOf('\n---', i + 1);
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let pos = 4;
  let lineNo = 2;
  while (pos < closeStart) {
    const eol = text.indexOf('\n', pos);
    const end = eol === -1 || eol > closeStart - 1 ? closeStart - 1 : eol;
    const line = text.slice(pos, end);
    if (!/^[ \t]*$/.test(line) && line.charCodeAt(0) !== 35) {
      const colon = line.indexOf(':');
      let bad = colon <= 0;
      if (!bad) {
        for (let k = 0; k < colon; k++) {
          const c = line.charCodeAt(k);
          if (!((c >= 97 && c <= 122) || c === 95)) {
            bad = true;
            break;
          }
        }
      }
      if (bad) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, colon);
      let raw;
      if (colon === line.length - 1) raw = '';
      else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      let t = raw.length;
      while (t > 0 && (raw.charCodeAt(t - 1) === 32 || raw.charCodeAt(t - 1) === 9)) t--;
      raw = t === raw.length ? raw : raw.slice(0, t);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = end + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = text[closeStart + 3] === '\n' ? text.slice(closeStart + 4) : '';
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const WS_RE = /\s/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is blank: empty, or spaces and tabs only. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline into `out` (an array of chunks); `env.link(target)` is a link's href.
 * Plain runs between the special characters are escaped in bulk instead of one character at a time.
 */
function inlineInto(s, env, out) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    let j = n;
    let k = s.indexOf('\\', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('`', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i);
    if (k !== -1 && k < j) j = k;
    if (j > i) {
      out.push(escapeHtml(s.slice(i, j)));
      i = j;
    }
    if (i >= n) break;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out.push(escapeHtml(s[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const e = s.indexOf('`', i + 1);
      if (e > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, e)), '</code>');
        i = e + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const e = findUnescaped(s, '**', i + 2);
        if (e > i + 2) {
          out.push('<strong>');
          inlineInto(s.slice(i + 2, e), env, out);
          out.push('</strong>');
          i = e + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const e = findSingleStar(s, i + 1);
        if (e > i + 1) {
          out.push('<em>');
          inlineInto(s.slice(i + 1, e), env, out);
          out.push('</em>');
          i = e + 1;
        } else {
          out.push('*');
          i++;
        }
      }
      continue;
    }
    // '['
    const k2 = findUnescaped(s, ']', i + 1);
    const m = k2 !== -1 && s[k2 + 1] === '(' ? s.indexOf(')', k2 + 2) : -1;
    const target = m === -1 ? '' : s.slice(k2 + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineInto(s.slice(i + 1, k2), env, out);
      out.push('</a>');
      i = m + 1;
    } else {
      out.push('[');
      i++;
    }
  }
}

/** `s` rendered inline, as one string. */
function inlineStr(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

/**
 * `src` rendered in one pass over its lines (no token objects): its HTML (each block on its own lines,
 * a "\n" after the last), its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML) and its excerpt (the first paragraph's inline HTML, or ""). Inline HTML is written straight
 * into the block output wherever no string of it is needed, so a paragraph costs no throwaway array.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = '';
  let hasExcerpt = false;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    let m;
    if (c0 === 96 && (m = FENCE_OPEN.exec(line)) !== null) {
      const lang = m[1];
      const body = [];
      i++;
      while (i < L && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      out.push(`<pre><code${cls}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>\n`);
      continue;
    }
    if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        if (heading.depth === 2 || heading.depth === 3) {
          const html = inlineStr(heading.text, env);
          out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
          toc.push({ level: heading.depth, id, html });
        } else {
          out.push(`<h${heading.depth} id="${id}">`);
          inlineInto(heading.text, env, out);
          out.push(`</h${heading.depth}>\n`);
        }
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const ls = body.map(trimLine).filter((l) => l !== '');
      if (ls.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(ls.join('\n'), env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const bullet = BULLET.exec(line);
      const ordered = bullet === null ? ORDERED.exec(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const marker = isOrdered ? ORDERED : BULLET;
        const start = isOrdered ? Number(ordered[1]) : 1;
        const items = [];
        while (i < L) {
          const mm = marker.exec(lines[i]);
          if (mm !== null) {
            items.push([trimLine(isOrdered ? mm[2] : mm[1])]);
            i++;
          } else if (
            lines[i].charCodeAt(0) === 32 &&
            lines[i].charCodeAt(1) === 32 &&
            CONTINUED.test(lines[i])
          ) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
        out.push(`${open}\n`);
        for (const it of items) {
          out.push('<li>');
          inlineInto(it.join('\n'), env, out);
          out.push('</li>\n');
        }
        out.push(`</${tag}>\n`);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (!hasExcerpt) {
      excerpt = inlineStr(text, env);
      hasExcerpt = true;
      out.push(`<p>${excerpt}</p>\n`);
    } else {
      out.push('<p>');
      inlineInto(text, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Node kinds: 1 text, 2 var, 3 raw, 4 for, 5 if, 6 include.

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
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
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { k: 0, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 1, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: tok.t === 'var' ? 2 : 3, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { k: 4, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { k: 5, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 5 || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 4 : 5)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 0 ? parent.body : parent.k === 4 ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ k: 6, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 4 ? 'for' : 'if'} is not closed`);
  return root.body;
}

/**
 * The templates whose rendering never varies inside one case, so their output can be rendered once
 * and reused: every value they read is one of the case's fixed roots (site, tags, recent), or a loop
 * variable bound by a for loop over such a value (and `loop`, bound by the same loop). A template is
 * cacheable only when it is constant this way and its longest include chain is short (at most 4), so
 * the include-depth limit can never change what it renders at the depths it is used. The check is
 * conservative: a cycle, a missing template, or any doubt makes a template not cacheable.
 */
const ROOT_CONST = new Set(['site', 'tags', 'recent']);

function findCacheableTemplates(templates) {
  const memo = new Map();
  const constPath = (path, bound) => ROOT_CONST.has(path[0]) || bound.has(path[0]);
  function walkNodes(nodes, bound, visiting) {
    let maxChain = 0;
    for (const n of nodes) {
      if (n.k === 1) continue;
      if (n.k === 2 || n.k === 3 || n.k === 5) {
        if (!constPath(n.path, bound)) return { constant: false, maxChain: 0 };
        if (n.k === 5) {
          const t = walkNodes(n.then, bound, visiting);
          if (!t.constant) return { constant: false, maxChain: 0 };
          maxChain = Math.max(maxChain, t.maxChain);
          if (n.else !== null) {
            const e = walkNodes(n.else, bound, visiting);
            if (!e.constant) return { constant: false, maxChain: 0 };
            maxChain = Math.max(maxChain, e.maxChain);
          }
        }
      } else if (n.k === 4) {
        if (!constPath(n.path, bound)) return { constant: false, maxChain: 0 };
        const nb = new Set(bound);
        nb.add(n.name);
        nb.add('loop');
        const b = walkNodes(n.body, nb, visiting);
        if (!b.constant) return { constant: false, maxChain: 0 };
        maxChain = Math.max(maxChain, b.maxChain);
      } else if (n.k === 6) {
        const sub = analyzeTemplate(n.name, visiting);
        if (!sub.constant) return { constant: false, maxChain: 0 };
        maxChain = Math.max(maxChain, 1 + sub.maxChain);
      }
    }
    return { constant: true, maxChain };
  }
  function analyzeTemplate(name, visiting) {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return { constant: false, maxChain: 0 };
    const nodes = templates.get(name);
    if (nodes === undefined) return { constant: false, maxChain: 0 };
    const next = new Set(visiting);
    next.add(name);
    const res = walkNodes(nodes, new Set(), next);
    memo.set(name, res);
    return res;
  }
  const result = new Map();
  for (const name of templates.keys()) {
    const r = analyzeTemplate(name, new Set());
    if (r.constant && r.maxChain <= 4) result.set(name, r.maxChain);
  }
  return result;
}

/**
 * The value at `path` in the frame stack: its first name from the nearest frame holding it, then own
 * properties of the value so far, or undefined.
 */
function lookup(frames, path) {
  const first = path[0];
  let v;
  let found = false;
  for (let f = frames.length - 1; f >= 0; f--) {
    const vars = frames[f];
    if (Object.hasOwn(vars, first)) {
      v = vars[first];
      found = true;
      break;
    }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of chunks) in the frame stack `frames`. `ctx` holds the parsed
 * templates (`templates`, a Map of name to nodes) and the once-rendered constant templates
 * (`constStrings`, name to text). `depth` is the include depth. A constant template included at a
 * shallow depth renders the same string it was rendered as once, so it is pushed as-is.
 */
function renderNodes(nodes, frames, out, ctx, depth) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.k) {
      case 1:
        out.push(n.text);
        break;
      case 2: {
        const v = lookup(frames, n.path);
        out.push(escapeHtml(typeof v === 'string' ? v : textOf(v)));
        break;
      }
      case 3: {
        const v = lookup(frames, n.path);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 5: {
        const v = truthy(lookup(frames, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, frames, out, ctx, depth);
        break;
      }
      case 4: {
        const xs = lookup(frames, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {
            [n.name]: xs[k],
            loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
          };
          frames.push(vars);
          renderNodes(n.body, frames, out, ctx, depth);
          frames.pop();
        }
        break;
      }
      case 6: {
        if (depth <= 2 && ctx.constStrings.has(n.name)) {
          out.push(ctx.constStrings.get(n.name));
          break;
        }
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, frames, out, ctx, depth + 1);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const sorted = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of sorted) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    // The body's words, counted while it is still in cache from rendering.
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // The values every render shares, as one frame; the render's own vars ride above it, so a name the
  // vars bind wins exactly as a merged object would, without building one per render.
  const baseVars = { site, tags: allTags, recent };
  // The constant templates, rendered once here. A constant template included by another one before it
  // is rendered itself is rendered fresh inside that render; the string is the same either way.
  const constStrings = new Map();
  const ctx = { templates, constStrings };
  for (const name of findCacheableTemplates(templates).keys()) {
    const nodes = templates.get(name);
    const out = [];
    renderNodes(nodes, [baseVars, {}], out, ctx, 0);
    constStrings.set(name, out.join(''));
  }
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, [baseVars, vars], out, ctx, 0);
    return out.join('');
  };
  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
