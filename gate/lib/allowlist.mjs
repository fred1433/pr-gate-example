// What a pull request may change on its own (invariant I3, docs/invariants.md).
// This is a list of what is allowed, not a list of what is forbidden: a change passes
// only if every changed file is markup, style or content under site/. Everything else
// goes to a person, with the reason. No form of code is tried against a pattern: code
// is recognized by where it lives (extension, frontmatter, <script>, template expression),
// so a new way to write it changes nothing.
import { posix } from 'node:path';
import { parse as astroParse } from '@astrojs/compiler-rs';

// What each extension is. Only markup, style and content can pass; an extension that is
// not in this table goes to a person.
export const KIND = {
  '.js': 'code', '.mjs': 'code', '.cjs': 'code', '.ts': 'code', '.mts': 'code', '.cts': 'code', '.jsx': 'code', '.tsx': 'code',
  '.mdx': 'code', '.vue': 'code', '.svelte': 'code', '.wasm': 'code', '.sh': 'code',
  '.json': 'config', '.jsonc': 'config', '.json5': 'config', '.yaml': 'config', '.yml': 'config', '.toml': 'config', '.lock': 'config', '.env': 'config', '.ini': 'config',
  '.astro': 'markup', '.html': 'markup', '.htm': 'markup', '.svg': 'markup', '.md': 'markup',
  '.css': 'style', '.scss': 'style', '.sass': 'style', '.less': 'style',
  '.txt': 'content', '.xml': 'content', '.png': 'content', '.jpg': 'content', '.jpeg': 'content', '.gif': 'content', '.webp': 'content',
  '.avif': 'content', '.ico': 'content', '.woff': 'content', '.woff2': 'content', '.ttf': 'content', '.otf': 'content', '.pdf': 'content',
};
const PLAIN_MODE = '100644';
const LINK_MODE = '120000';
// Names a template expression may never start from, even if a frontmatter declares them.
const NEVER = new Set(['Astro', 'process', 'globalThis', 'window', 'self', 'global', 'eval', 'Function', 'Reflect', 'import', 'arguments', 'require']);

const lineAt = (text, offset) => (typeof offset === 'number' ? text.slice(0, offset).split('\n').length : null);
const canon = (node) => JSON.stringify(node, (k, v) => (k === 'start' || k === 'end' || k === 'position' || k === 'loc' || k === 'range' ? undefined : v));

// A template expression that is only literals and names declared in an unchanged frontmatter.
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

const CODE_ATTR = /^(on[a-z]|set:html$|srcdoc$)/i;
const JS_URL = /^\s*javascript:/i;

// The parts of an .astro file the allowlist looks at.
export function astroShape(text) {
  if (text === null || text === undefined) return { frontmatter: null, fmKey: '', expressions: [], scripts: [], codeAttrs: [] };
  let r;
  try { r = astroParse(text); } catch (e) { return { error: String(e.message || e).split('\n')[0].slice(0, 160) }; }
  const errs = (r.diagnostics || []).filter((d) => (d.severity ?? 'error') === 'error' || d.severity === 1);
  if (errs.length) return { error: String(errs[0].text || errs[0].message || 'parse error').slice(0, 160) };
  const fm = r.ast.frontmatter?.program || null;
  const shape = { frontmatter: fm, fmKey: fm && fm.body.length ? canon(fm.body) : '', expressions: [], scripts: [], codeAttrs: [] };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'AstroScript' || (n.type === 'JSXElement' && n.openingElement?.name?.name === 'script')) {
      shape.scripts.push({ key: canon(n), at: n.start });
      return;
    }
    if (n.type === 'JSXAttribute') {
      const name = typeof n.name?.name === 'string' ? n.name.name : n.name?.name?.name ?? '';
      const lit = n.value?.type === 'Literal' && typeof n.value.value === 'string' ? n.value.value : null;
      if (CODE_ATTR.test(name) || (lit !== null && JS_URL.test(lit))) shape.codeAttrs.push({ key: canon(n), at: n.start });
    }
    if (n.type === 'JSXExpressionContainer' || n.type === 'JSXSpreadAttribute' || n.type === 'JSXSpreadChild') {
      const e = n.type === 'JSXExpressionContainer' ? n.expression : n;
      shape.expressions.push({ key: canon(e), node: e, at: n.start });
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
  // Names a new expression may use: those of a frontmatter this PR leaves unchanged.
  const declared = fmSame && base.frontmatter ? declaredNames(base.frontmatter) : new Set();
  for (const e of added(base.expressions, pr.expressions)) {
    if (!safeExpression(e.node, declared)) {
      const line = lineAt(text, e.at);
      reason(`${f.path} adds a template expression that is code (only literals and names declared in an unchanged frontmatter pass on their own).`, line, line ? text.split('\n')[line - 1]?.trim() : null);
    }
  }
  if (!sameMultiset(base.scripts, pr.scripts)) {
    const s = added(base.scripts, pr.scripts)[0];
    reason(`${f.path} adds, changes or removes a <script>.`, s ? lineAt(text, s.at) : null);
  }
  for (const a of added(base.codeAttrs, pr.codeAttrs)) {
    const line = lineAt(text, a.at);
    reason(`${f.path} adds an event handler, set:html, srcdoc or a javascript: URL.`, line, line ? text.split('\n')[line - 1]?.trim() : null);
  }
  return out;
}

const SCRIPTISH = /<script\b|\son[a-z]+\s*=|javascript:|\bsrcdoc\s*=|<iframe\b|<object\b|<embed\b/i;

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
  const name = posix.basename(f.path);
  const ext = (/\.[^./]+$/.exec(name) || [''])[0].toLowerCase();
  const kind = /^(astro|vite)\.config\./.test(name) || name.startsWith('.') ? 'config' : KIND[ext];
  if (kind === 'code') return [{ why: `${f.path} is executable code (${ext}). Only markup, style and content pass on their own.` }];
  if (kind === 'config') return [{ why: `${f.path} is configuration or data the build reads.` }];
  if (kind === 'markup' && ext === '.astro') return f.status === 'D' ? [] : astroReasons(f);
  if (kind === 'markup') {
    const text = f.status === 'D' ? '' : f.content ?? f.added.map((a) => a.text).join('\n');
    return SCRIPTISH.test(text) ? [{ why: `${f.path} holds a script, an event handler, an embedded document or a javascript: URL.` }] : [];
  }
  if (kind === 'style' || kind === 'content') return [];
  return [{ why: `${f.path} has an extension the gate does not know (${ext || 'none'}).` }];
}
