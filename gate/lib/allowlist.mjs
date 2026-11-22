// What a pull request may change on its own (invariant I3, docs/invariants.md).
// This is a list of what is allowed, not a list of what is forbidden: a change passes
// only if every changed file is markup, style or content under site/. Everything else
// goes to a person, with the reason. Code is recognized by where it lives (extension,
// frontmatter, <script>, template expression, event handler, URL scheme). This is built to
// catch an agent's mistakes, not to stand as a sandbox against a hostile author.
import { posix } from 'node:path';
import { parse as astroParse } from '@astrojs/compiler-rs';
import { parse as htmlParse } from 'parse5';
import { decodeHTML } from 'entities';

// What each extension is. Only markup, style and content can pass; an extension that is
// not in this table goes to a person.
export const KIND = {
  '.js': 'code', '.mjs': 'code', '.cjs': 'code', '.ts': 'code', '.mts': 'code', '.cts': 'code', '.jsx': 'code', '.tsx': 'code',
  '.mdx': 'code', '.vue': 'code', '.svelte': 'code', '.wasm': 'code', '.sh': 'code',
  '.json': 'config', '.jsonc': 'config', '.json5': 'config', '.yaml': 'config', '.yml': 'config', '.toml': 'config', '.lock': 'config', '.env': 'config', '.ini': 'config',
  '.astro': 'markup', '.html': 'markup', '.htm': 'markup', '.svg': 'markup', '.xml': 'markup', '.md': 'markup',
  '.css': 'style', '.scss': 'style', '.sass': 'style', '.less': 'style',
  '.txt': 'content', '.png': 'content', '.jpg': 'content', '.jpeg': 'content', '.gif': 'content', '.webp': 'content',
  '.avif': 'content', '.ico': 'content', '.woff': 'content', '.woff2': 'content', '.ttf': 'content', '.otf': 'content', '.pdf': 'content',
};
const PLAIN_MODE = '100644';
const LINK_MODE = '120000';
// Names a template expression may never start from, even if a frontmatter declares them.
const NEVER = new Set(['Astro', 'process', 'globalThis', 'window', 'self', 'global', 'eval', 'Function', 'Reflect', 'import', 'arguments', 'require']);

const lineAt = (text, offset) => (typeof offset === 'number' ? text.slice(0, offset).split('\n').length : null);
const canon = (node) => JSON.stringify(node, (k, v) => (k === 'start' || k === 'end' || k === 'position' || k === 'loc' || k === 'range' ? undefined : v));

// A template expression made only of literals and of names (or member reads of them)
// declared in a frontmatter the pull request leaves unchanged: that frontmatter is code
// already on main. A call, an operator, or any name the pull request brings goes to a
// person. Limit: a name already declared as a function would be called by Astro.
export function safeExpression(n, declared) {
  if (!n) return false;
  switch (n.type) {
    case 'JSXEmptyExpression': return true; // {/* a comment */}
    case 'Literal': return n.value === null || ['string', 'number', 'boolean'].includes(typeof n.value) && !n.regex && n.bigint == null;
    case 'TemplateLiteral': return n.expressions.every((e) => safeExpression(e, declared));
    case 'Identifier': return declared.has(n.name) && !NEVER.has(n.name);
    case 'MemberExpression': return !n.computed && n.property?.type === 'Identifier' && (n.object.type === 'Identifier' || n.object.type === 'MemberExpression') && safeExpression(n.object, declared);
    case 'ChainExpression': return safeExpression(n.expression, declared);
    case 'ParenthesizedExpression': return safeExpression(n.expression, declared);
    default: return false; // calls, operators, objects, functions, markup inside {}: code
  }
}

// What a safe expression renders, as far as the gate can know it (for the URL check of an
// attribute): literals, and names bound to a literal; any other name counts as empty.
function staticValue(n, bound) {
  switch (n?.type) {
    case 'Literal': return n.value === null ? '' : String(n.value);
    case 'TemplateLiteral': return n.quasis.map((q, i) => (q.value?.cooked ?? q.value?.raw ?? '') + (i < n.expressions.length ? staticValue(n.expressions[i], bound) : '')).join('');
    case 'Identifier': return String(bound.get(n.name) ?? '');
    case 'ChainExpression': return staticValue(n.expression, bound);
    case 'ParenthesizedExpression': return staticValue(n.expression, bound);
    default: return '';
  }
}

// The value of an initializer if it is a literal: a string, a number, a template literal
// without substitution. Anything else (a function, a call, an object, a member) is undefined.
function literalValue(init) {
  if (init?.type === 'Literal' && (typeof init.value === 'string' || typeof init.value === 'number') && !init.regex && init.bigint == null) return init.value;
  if (init?.type === 'TemplateLiteral' && init.expressions.length === 0) return init.quasis.map((q) => q.value?.cooked ?? q.value?.raw ?? '').join('');
  return undefined;
}

// Names a frontmatter binds to a literal with const, and their values (for staticValue).
export function literalBindings(program) {
  const out = new Map();
  for (const s of program?.body || []) {
    const d = s.type === 'ExportNamedDeclaration' ? s.declaration : s;
    if (d?.type !== 'VariableDeclaration' || d.kind !== 'const') continue;
    for (const x of d.declarations) {
      const v = literalValue(x.init);
      if (x.id?.type === 'Identifier' && v !== undefined) out.set(x.id.name, v);
    }
  }
  return out;
}

// A frontmatter made only of default imports of a relative .astro file inside site/.
export function importOnly(program, file) {
  for (const s of program?.body || []) {
    if (s.type !== 'ImportDeclaration') return 'a statement other than a default import of an .astro file';
    const src = s.source?.value;
    if (s.importKind === 'type' || s.phase || (s.attributes || []).length) return `an import of a special kind (${src})`;
    if (s.specifiers.length !== 1 || s.specifiers[0].type !== 'ImportDefaultSpecifier') return `an import that is not a single default import (${src})`;
    if (typeof src !== 'string' || !/^\.\.?\//.test(src)) return `an import that is not a relative path (${src})`;
    if (!src.endsWith('.astro')) return `an import of something other than an .astro file (${src})`;
    if (!posix.normalize(posix.join(posix.dirname(file), src)).startsWith('site/')) return `an import from outside site/ (${src})`;
  }
  return null;
}

function declaredNames(program) {
  const out = new Set();
  const pat = (p) => {
    if (!p) return;
    if (p.type === 'Identifier') out.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((x) => pat(x.type === 'RestElement' ? x.argument : x.value));
    else if (p.type === 'ArrayPattern') p.elements.forEach(pat);
    else if (p.type === 'AssignmentPattern') pat(p.left);
    else if (p.type === 'RestElement') pat(p.argument);
  };
  for (const s of program?.body || []) {
    const d = s.type === 'ExportNamedDeclaration' ? s.declaration : s;
    if (!d) continue;
    if (d.type === 'VariableDeclaration') d.declarations.forEach((x) => pat(x.id));
    else if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) out.add(d.id.name);
    else if (d.type === 'ImportDeclaration') d.specifiers.forEach((x) => out.add(x.local.name));
  }
  return out;
}

const importedNames = (program) => new Set((program?.body || []).filter((s) => s.type === 'ImportDeclaration').flatMap((s) => s.specifiers.map((x) => x.local.name)));

// An event handler attribute: on followed by a letter, at the start of the name or after
// anything that is not a letter (/onload, "x"onerror).
const HANDLER = /(?:^|[^a-z])on[a-z]/i;
const CODE_ATTR = /^(set:html|srcdoc)$/i;
// Attributes that hold a URL.
export const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'srcset', 'poster', 'data', 'background', 'ping', 'cite']);
// Elements that load or run something the gate does not test.
const LOADERS = new Set(['base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal']);
// Control characters and spaces a browser ignores or strips inside a URL scheme.
const IGNORED = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

// Whether a value, once its HTML entities are decoded and its controls and spaces removed,
// is or holds a javascript:, vbscript: or (in a URL attribute) data: URL. Case does not count.
export function scriptUrl(value, isUrl = true, decoded = false) {
  const s = (decoded ? String(value) : decodeHTML(String(value))).replace(IGNORED, '').toLowerCase();
  if (s.includes('javascript:') || s.includes('vbscript:')) return true;
  return isUrl && s.split(',').some((p) => p.startsWith('data:'));
}

// URLs in a stylesheet that point to another domain: @import and url(), after CSS escapes.
export function remoteStyleRefs(css) {
  const t = String(css).replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ''; })
    .replace(/\\(.)/g, '$1');
  const out = [];
  const remote = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(u.replace(IGNORED, '')) && !/^data:/i.test(u.replace(IGNORED, ''));
  for (const m of t.matchAll(/@import\s*(?:url\(\s*)?(['"]?)\s*([^'")\s;]+)/gi)) if (remote(m[2])) out.push(`@import ${m[2]}`);
  for (const m of t.matchAll(/url\(\s*(['"]?)\s*([^'")\s]+)/gi)) if (remote(m[2])) out.push(`url(${m[2]})`);
  for (const m of t.matchAll(/image-set\(([^)]*)\)/gi)) for (const q of m[1].matchAll(/(['"])([^'"]+)\1/g)) if (remote(q[2])) out.push(`image-set ${q[2]}`);
  return out;
}

// The parts of an .astro file the allowlist looks at.
const EMPTY = () => ({ frontmatter: null, fmKey: '', expressions: [], scripts: [], codeAttrs: [], loaders: [], styles: [] });
export function astroShape(text) {
  if (text === null || text === undefined) return EMPTY();
  let r;
  try { r = astroParse(text); } catch (e) { return { error: String(e.message || e).split('\n')[0].slice(0, 160) }; }
  const errs = (r.diagnostics || []).filter((d) => (d.severity ?? 'error') === 'error' || d.severity === 1);
  if (errs.length) return { error: String(errs[0].text || errs[0].message || 'parse error').slice(0, 160) };
  const fm = r.ast.frontmatter?.program || null;
  const shape = { ...EMPTY(), frontmatter: fm, fmKey: fm && fm.body.length ? canon(fm.body) : '' };
  const components = importedNames(fm);
  const attrName = (a) => (typeof a.name?.name === 'string' ? a.name.name : `${a.name?.namespace?.name ?? ''}:${a.name?.name?.name ?? ''}`);
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const tag = n.type === 'JSXElement' && typeof n.openingElement?.name?.name === 'string' ? n.openingElement.name.name : null;
    if (n.type === 'AstroScript' || (tag && tag.toLowerCase() === 'script')) {
      shape.scripts.push({ key: canon(n), at: n.start });
      return;
    }
    if (tag && !components.has(tag)) {
      const low = tag.toLowerCase();
      const attrs = n.openingElement.attributes || [];
      const has = (name) => attrs.some((a) => a.type === 'JSXAttribute' && attrName(a).toLowerCase() === name);
      if (LOADERS.has(low) || (low === 'meta' && has('http-equiv'))) shape.loaders.push({ key: `${low}:${canon(n.openingElement)}`, at: n.start, tag: low === 'meta' ? 'meta http-equiv' : low });
      if (low === 'style') {
        const css = (n.children || []).filter((c) => c.type === 'JSXText').map((c) => c.value).join('');
        for (const u of remoteStyleRefs(css)) shape.styles.push({ key: u, at: n.start, url: u });
      }
      if (low === 'link' && /\b(stylesheet|import|modulepreload|preload)\b/i.test(attrs.map((a) => (attrName(a).toLowerCase() === 'rel' && a.value?.type === 'Literal' ? String(a.value.value) : '')).join(' '))) {
        for (const a of attrs) if (a.type === 'JSXAttribute' && attrName(a).toLowerCase() === 'href' && a.value?.type === 'Literal' && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(String(a.value.value).trim())) shape.styles.push({ key: `link ${a.value.value}`, at: n.start, url: String(a.value.value) });
      }
    }
    if (n.type === 'JSXAttribute') {
      const name = attrName(n);
      const lit = n.value?.type === 'Literal' && typeof n.value.value === 'string' ? n.value.value : null;
      if (HANDLER.test(name) || CODE_ATTR.test(name) || (lit !== null && scriptUrl(lit, URL_ATTRS.has(name.toLowerCase())))) shape.codeAttrs.push({ key: canon(n), at: n.start });
      if (lit !== null && name.toLowerCase() === 'style') for (const u of remoteStyleRefs(decodeHTML(lit))) shape.styles.push({ key: u, at: n.start, url: u });
      if (n.value?.type === 'JSXExpressionContainer') {
        shape.expressions.push({ key: `${name}=${canon(n.value.expression)}`, node: n.value.expression, at: n.start, attr: name });
        return;
      }
    }
    if (n.type === 'JSXExpressionContainer' || n.type === 'JSXSpreadAttribute' || n.type === 'JSXSpreadChild') {
      const e = n.type === 'JSXExpressionContainer' ? n.expression : n;
      shape.expressions.push({ key: canon(e), node: e, at: n.start, attr: null });
      return; // what is inside an expression is judged with it
    }
    for (const [k, v] of Object.entries(n)) if (k !== 'frontmatter' && v && typeof v === 'object') walk(v);
  };
  walk(r.ast.body);
  return shape;
}

// Items of `after` whose key is not matched one for one in `before`.
function added(before, after) {
  const left = new Map();
  for (const x of before) left.set(x.key, (left.get(x.key) || 0) + 1);
  const out = [];
  for (const x of after) { const n = left.get(x.key) || 0; if (n) left.set(x.key, n - 1); else out.push(x); }
  return out;
}
const sameMultiset = (a, b) => added(a, b).length === 0 && added(b, a).length === 0;

function astroReasons(f) {
  const out = [];
  const reason = (why, line = null, text = null) => out.push({ why, line, text });
  const pr = astroShape(f.status === 'D' ? null : f.content ?? f.added.map((a) => a.text).join('\n'));
  if (pr.error) return [{ why: `${f.path} could not be parsed (${pr.error}), so the gate cannot tell markup from code in it.` }];
  // A modified file whose main version the gate was not given is judged as if it were new.
  const base = astroShape(f.status === 'M' ? f.baseContent ?? null : null);
  if (base.error) return [{ why: `${f.path} on main could not be parsed (${base.error}).` }];
  const text = f.content ?? '';
  const fmSame = pr.fmKey === base.fmKey;
  if (!fmSame && pr.frontmatter) {
    const bad = importOnly(pr.frontmatter, f.path);
    if (bad) reason(`${f.path} changes its frontmatter, code that runs at build time: ${bad}.`, lineAt(text, pr.frontmatter.start) ?? 1);
  }
  // Names a new expression may use: those declared in a frontmatter this PR leaves
  // unchanged (code on main). Names the PR brings, even in an allowed import, are not.
  const declared = fmSame && base.frontmatter ? declaredNames(base.frontmatter) : new Set();
  const bound = fmSame && base.frontmatter ? literalBindings(base.frontmatter) : new Map();
  const at = (x) => { const line = lineAt(text, x.at); return [line, line ? text.split('\n')[line - 1]?.trim() : null]; };
  for (const e of added(base.expressions, pr.expressions)) {
    if (!safeExpression(e.node, declared)) reason(`${f.path} adds a template expression that is code (only literals and names declared in an unchanged frontmatter pass on their own).`, ...at(e));
    else if (e.attr && scriptUrl(staticValue(e.node, bound), URL_ATTRS.has(e.attr.toLowerCase()))) reason(`${f.path} adds an expression that gives a javascript:, vbscript: or data: URL.`, ...at(e));
  }
  if (!sameMultiset(base.scripts, pr.scripts)) {
    const s = added(base.scripts, pr.scripts)[0];
    reason(`${f.path} adds, changes or removes a <script>.`, s ? lineAt(text, s.at) : null);
  }
  for (const a of added(base.codeAttrs, pr.codeAttrs)) reason(`${f.path} adds an event handler, set:html, srcdoc or a javascript:, vbscript: or data: URL.`, ...at(a));
  for (const l of added(base.loaders, pr.loaders)) reason(`${f.path} adds a <${l.tag}>, which loads or redirects what the gate does not test.`, ...at(l));
  for (const u of added(base.styles, pr.styles)) reason(`${f.path} adds a style that loads from another domain (${u.url.slice(0, 80)}).`, ...at(u));
  return out;
}

// What a page in HTML, SVG, XML or Markdown holds that is not plain markup, read with parse5:
// <script> in any case, an element that loads another document, <meta http-equiv>, an
// event handler, a javascript:, vbscript: or data: URL, a style from another domain. In
// Markdown, link destinations are checked too.
export function markupFindings(text, isMarkdown = false) {
  const out = [];
  const add = (key, why, line) => out.push({ key, why, line });
  const doc = htmlParse(String(text), { sourceCodeLocationInfo: true });
  const walk = (n) => {
    const line = n.sourceCodeLocation?.startLine ?? null;
    if (n.tagName) {
      const tag = n.tagName.toLowerCase();
      // parse5 makes the html, head and body it implies; those have no location
      if (tag === 'script') add(`script ${n.childNodes?.map((c) => c.value || '').join('')}`, 'holds a <script>', line);
      if (LOADERS.has(tag) && n.sourceCodeLocation) add(`${tag} ${JSON.stringify(n.attrs)}`, `holds a <${tag}>, which loads or redirects what the gate does not test`, line);
      if (tag === 'meta' && n.attrs.some((a) => a.name.toLowerCase() === 'http-equiv')) add(`meta ${JSON.stringify(n.attrs)}`, 'holds a <meta http-equiv>', line);
      for (const a of n.attrs || []) {
        const name = a.name.toLowerCase();
        if (HANDLER.test(name)) add(`${tag} ${name}=${a.value}`, `holds an event handler (${a.name})`, line);
        else if (CODE_ATTR.test(name)) add(`${tag} ${name}=${a.value}`, `holds ${name}`, line);
        else if (scriptUrl(a.value, URL_ATTRS.has(name), true)) add(`${tag} ${name}=${a.value}`, 'holds a javascript:, vbscript: or data: URL', line);
        if (name === 'style') for (const u of remoteStyleRefs(a.value)) add(`style ${u}`, `holds a style that loads from another domain (${u.slice(0, 80)})`, line);
      }
      if (tag === 'style') for (const u of remoteStyleRefs(n.childNodes?.map((c) => c.value || '').join(''))) add(`style ${u}`, `holds a style that loads from another domain (${u.slice(0, 80)})`, line);
      if (tag === 'link' && /\b(stylesheet|import|modulepreload|preload)\b/i.test(n.attrs.find((a) => a.name === 'rel')?.value || '')) {
        const href = n.attrs.find((a) => a.name === 'href')?.value || '';
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href.replace(IGNORED, ''))) add(`link ${href}`, `holds a stylesheet or script from another domain (${href.slice(0, 80)})`, line);
      }
    }
    for (const c of n.childNodes || []) walk(c);
    if (n.content) walk(n.content); // <template>
  };
  walk(doc);
  if (isMarkdown) {
    // CommonMark removes a backslash before punctuation and decodes entities in a destination.
    const md = String(text).replace(/\\([!-/:-@[-`{-~])/g, '$1');
    const dests = [
      ...[...md.matchAll(/\]\(\s*<?([^\s)>]*)/g)].map((m) => [m[1], m.index]),
      ...[...md.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?(\S+)/gm)].map((m) => [m[1], m.index]),
      ...[...md.matchAll(/<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/gi)].map((m) => [m[1], m.index]),
    ];
    for (const [d, i] of dests) if (scriptUrl(d, true)) add(`link ${d}`, 'holds a link to a javascript:, vbscript: or data: URL', lineAt(md, i));
    if (/javascript:|vbscript:/.test(decodeHTML(md).replace(IGNORED, '').toLowerCase()) && !out.length) add('text javascript:', 'holds a javascript: or vbscript: URL', null);
  }
  return out;
}

// The reasons a changed file needs a person under I3. An empty list means the file is
// markup, style or content under site/, as listed in docs/invariants.md.
export function allowlistReasons(f) {
  const oldMode = f.oldMode ?? (f.status === 'A' ? '000000' : PLAIN_MODE);
  const newMode = f.newMode ?? (f.status === 'D' ? '000000' : PLAIN_MODE);
  if (oldMode === LINK_MODE || newMode === LINK_MODE) {
    const target = newMode === LINK_MODE && typeof f.content === 'string' ? ` to ${f.content.trim().slice(0, 120)}` : '';
    return [{ why: `${f.path} is a symbolic link${target}. A link goes to a person whatever it points to: the build follows it.` }];
  }
  if (f.status !== 'A' && f.status !== 'D' && oldMode !== newMode) return [{ why: `${f.path} changes mode from ${oldMode} to ${newMode}.` }];
  if ((f.status === 'A' ? newMode : f.status === 'D' ? oldMode : newMode) !== PLAIN_MODE) return [{ why: `${f.path} has mode ${f.status === 'D' ? oldMode : newMode}, not a plain file (${PLAIN_MODE}).` }];
  if (!f.path.startsWith('site/')) {
    if (f.path.startsWith('ops/requests/') && /\.(md|txt)$/i.test(f.path)) return [];
    return [{ why: `${f.path} is outside site/. Only markup, style and content under site/ pass on their own.` }];
  }
  // site/public/ is copied into the site as it is: nothing there is read by the build or
  // checked by the gate, so any file added or modified there goes to a person.
  if (f.path.startsWith('site/public/') && f.status !== 'D') return [{ why: `${f.path} is under site/public/, served as it is: whatever its extension, a person checks it.` }];
  const name = posix.basename(f.path);
  const ext = (/\.[^./]+$/.exec(name) || [''])[0].toLowerCase();
  const kind = /^(astro|vite)\.config\./.test(name) || name.startsWith('.') ? 'config' : KIND[ext];
  if (kind === 'code') return [{ why: `${f.path} is executable code (${ext}). Only markup, style and content pass on their own.` }];
  if (kind === 'config') return [{ why: `${f.path} is configuration or data the build reads.` }];
  if (kind === 'markup' && ext === '.astro') return f.status === 'D' ? [] : astroReasons(f);
  const content = () => (f.status === 'D' ? null : f.content ?? f.added.map((a) => a.text).join('\n'));
  const baseOf = () => (f.status === 'M' ? f.baseContent ?? null : null);
  if (kind === 'markup') {
    if (f.status === 'D') return [];
    const md = ext === '.md';
    const base = baseOf() === null ? [] : markupFindings(baseOf(), md);
    return added(base, markupFindings(content(), md)).map((x) => ({ why: `${f.path} ${x.why}.`, line: x.line }));
  }
  if (kind === 'style') {
    if (f.status === 'D') return [];
    const keys = (t) => (t === null ? [] : remoteStyleRefs(t).map((u) => ({ key: u, url: u })));
    return added(keys(baseOf()), keys(content())).map((u) => ({ why: `${f.path} adds a style that loads from another domain (${u.url.slice(0, 80)}).` }));
  }
  if (kind === 'content') return [];
  return [{ why: `${f.path} has an extension the gate does not know (${ext || 'none'}).` }];
}
