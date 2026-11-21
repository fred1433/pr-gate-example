// Which environment variables a source file reads (invariant I3, docs/invariants.md).
// The file is parsed whole, never line by line: .astro files are compiled by Astro's own
// compiler, then the code and its <script> blocks are parsed by @babel/parser, and the
// syntax tree is walked. A read the gate can name gives its key; a use it cannot name
// (Object.keys(env), { ...env }, env[someVar], the environment handed to a function
// defined elsewhere, eval) is reported as such, never ignored.
import { parse as babelParse } from '@babel/parser';
import { transform as astroTransform } from '@astrojs/compiler-rs';

export const CODE_FILE = /\.(astro|[cm]?[jt]s|[jt]sx)$/;
// Files that hold no code the site runs on the server or at build time.
export const DATA_FILE = /\.(css|scss|md|json|ya?ml|txt|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|html|xml|pdf)$/i;

const SKIP_FIELDS = new Set(['loc', 'start', 'end', 'range', 'extra', 'typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeParameters', 'decorators', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);
const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression']);
const TS_CODE = new Set(['TSEnumDeclaration', 'TSEnumMember', 'TSModuleDeclaration', 'TSModuleBlock', 'TSParameterProperty', 'TSExportAssignment']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const HARMLESS_BINARY = new Set(['===', '!==', '==', '!=']);

function parseCode(code, file) {
  const plugins = ['estree', 'typescript'];
  if (/\.[jt]sx$/.test(file)) plugins.push('jsx');
  return babelParse(code, { sourceType: 'module', plugins, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, errorRecovery: false });
}

function children(node) {
  const out = [];
  for (const [field, v] of Object.entries(node)) {
    if (SKIP_FIELDS.has(field)) continue;
    if (Array.isArray(v)) v.forEach((c, i) => { if (c && typeof c.type === 'string') out.push([c, field, i]); });
    else if (v && typeof v.type === 'string') out.push([v, field, null]);
  }
  return out;
}

// Every node with its parent and the field it sits in. Type-only TypeScript is skipped.
function flatten(ast) {
  const list = [];
  const stack = [[ast.program || ast, null, null, null]];
  while (stack.length) {
    const [node, parent, field, index] = stack.pop();
    if (node.type.startsWith('TS') && !TS_WRAPPERS.has(node.type) && !TS_CODE.has(node.type)) continue;
    list.push({ node, parent, field, index });
    for (const [c, f, i] of children(node)) stack.push([c, node, f, i]);
  }
  return list;
}

function patternIds(p, out) {
  if (!p) return out;
  if (p.type === 'Identifier') out.add(p);
  else if (p.type === 'ObjectPattern') for (const prop of p.properties) { if (prop.type === 'RestElement') patternIds(prop.argument, out); else patternIds(prop.value, out); }
  else if (p.type === 'ArrayPattern') for (const e of p.elements) patternIds(e, out);
  else if (p.type === 'AssignmentPattern') patternIds(p.left, out);
  else if (p.type === 'RestElement') patternIds(p.argument, out);
  else if (p.type === 'TSParameterProperty') patternIds(p.parameter, out);
  return out;
}

// Identifiers that are names, not reads of a value.
function nameIds(list) {
  const ids = new Set();
  for (const { node: n } of list) {
    if (n.type === 'VariableDeclarator') patternIds(n.id, ids);
    else if (FUNCTIONS.has(n.type)) { if (n.id) ids.add(n.id); for (const p of n.params) patternIds(p, ids); }
    else if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') { if (n.id) ids.add(n.id); }
    else if (n.type === 'CatchClause') patternIds(n.param, ids);
    else if (n.type === 'AssignmentExpression' && n.left.type !== 'MemberExpression') patternIds(n.left, ids);
    else if ((n.type === 'ForInStatement' || n.type === 'ForOfStatement') && n.left.type !== 'VariableDeclaration') patternIds(n.left, ids);
    else if (n.type === 'MemberExpression' && !n.computed) ids.add(n.property);
    else if ((n.type === 'Property' || n.type === 'MethodDefinition' || n.type === 'PropertyDefinition') && !n.computed) ids.add(n.key);
    else if (/^(Import|Export)(Default|Namespace)?Specifier$/.test(n.type)) { if (n.local) ids.add(n.local); if (n.imported) ids.add(n.imported); if (n.exported) ids.add(n.exported); }
    else if (n.type === 'LabeledStatement' || n.type === 'BreakStatement' || n.type === 'ContinueStatement') { if (n.label) ids.add(n.label); }
    else if (n.type === 'MetaProperty') { ids.add(n.meta); ids.add(n.property); }
  }
  return ids;
}

const literalKey = (n) => (n?.type === 'Literal' && typeof n.value === 'string' ? n.value
  : n?.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0].value.cooked : null);
const keyName = (prop) => (!prop.computed && prop.key.type === 'Identifier' ? prop.key.name : literalKey(prop.key));

export function analyzeAst(ast, code) {
  const list = flatten(ast);
  const parentOf = new Map(list.map((e) => [e.node, e]));
  const names = nameIds(list);
  const envNames = new Set(['env']);
  const funcs = new Map();
  for (const { node: n } of list) {
    if (n.type === 'FunctionDeclaration' && n.id) funcs.set(n.id.name, n.params);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && FUNCTIONS.has(n.init.type)) funcs.set(n.id.name, n.init.params);
  }
  const src = (n) => code.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 60);

  const isEnv = (n) => {
    if (!n) return false;
    switch (n.type) {
      case 'Identifier': return envNames.has(n.name) && !names.has(n);
      case 'MemberExpression': return (n.computed ? literalKey(n.property) : n.property.name) === 'env';
      case 'ChainExpression': return isEnv(n.expression);
      case 'LogicalExpression': return n.operator === '&&' ? isEnv(n.right) : isEnv(n.left) || isEnv(n.right);
      case 'ConditionalExpression': return isEnv(n.consequent) || isEnv(n.alternate);
      case 'SequenceExpression': return isEnv(n.expressions.at(-1));
      case 'AwaitExpression': return isEnv(n.argument);
      default: return TS_WRAPPERS.has(n.type) && isEnv(n.expression);
    }
  };

  let keys, dynamic, grew;
  const read = (key, at) => keys.push({ key, line: at.loc?.start.line ?? null });
  const opaque = (what, at) => dynamic.push({ what, line: at.loc?.start.line ?? null, needle: src(at).slice(0, 24) });
  const alias = (name) => { if (!envNames.has(name)) { envNames.add(name); grew = true; } };

  // The environment flows into a pattern or a name.
  function bind(target, at) {
    if (!target) return opaque('the environment is received by a parameter that does not exist', at);
    switch (target.type) {
      case 'Identifier': return alias(target.name);
      case 'AssignmentPattern': return bind(target.left, at);
      case 'ObjectPattern':
        for (const prop of target.properties) {
          if (prop.type === 'RestElement') { opaque(`the rest of the environment is collected (...${src(prop.argument)})`, prop); continue; }
          const k = keyName(prop);
          if (k === null) opaque(`a destructured key is computed (${src(prop.key)})`, prop); else read(k, prop);
        }
        return;
      default: return opaque(`the environment is assigned to ${src(target)}`, at);
    }
  }

  for (let pass = 0; pass < 20; pass++) {
    keys = []; dynamic = []; grew = false;
    for (const { node: n, parent: p, field, index } of list) {
      // A property named env in any pattern binds the environment: { env }, { env: e }, { env: { X } }.
      if (n.type === 'ObjectPattern') for (const prop of n.properties) if (prop.type === 'Property' && keyName(prop) === 'env') bind(prop.value, prop);
      if ((n.type === 'CallExpression' || n.type === 'NewExpression') && n.callee.type === 'Identifier' && (n.callee.name === 'eval' || n.callee.name === 'Function')) opaque(`code built at run time (${n.callee.name})`, n);
      if (!p || !isEnv(n)) continue;
      // The parent carries the environment on (env ?? {}, (env as Env), env?.X chains): judged at the parent.
      if (isEnv(p) && p.type !== 'MemberExpression') continue;
      switch (p.type) {
        case 'MemberExpression':
          if (field === 'object') { const k = p.computed ? literalKey(p.property) : p.property.name; if (k === null) opaque(`a key is computed (${src(p)})`, p); else read(k, p); }
          else opaque(`the environment is used as a key (${src(p)})`, p);
          break;
        case 'VariableDeclarator': if (field === 'init') bind(p.id, p); break;
        case 'AssignmentExpression': if (field === 'right') bind(p.left, p); else opaque(`the environment is overwritten (${src(p)})`, p); break;
        case 'AssignmentPattern': if (field === 'right') bind(p.left, p); break;
        case 'CallExpression': case 'NewExpression':
          if (field === 'arguments' && p.callee.type === 'Identifier' && funcs.has(p.callee.name)) {
            const param = funcs.get(p.callee.name)[index];
            if (param?.type === 'RestElement') opaque(`the environment is passed to ${p.callee.name}(...)`, p); else bind(param, p);
          } else opaque(`the environment is passed to ${src(p.callee)}`, p);
          break;
        case 'BinaryExpression':
          if (p.operator === 'in' && field === 'right') { const k = literalKey(p.left); if (k === null) opaque(`a key is tested with a computed name (${src(p)})`, p); else read(k, p); }
          else if (!HARMLESS_BINARY.has(p.operator)) opaque(`the environment is used in ${src(p)}`, p);
          break;
        case 'LogicalExpression': case 'UnaryExpression': case 'ExpressionStatement': case 'IfStatement': case 'WhileStatement': case 'DoWhileStatement': case 'ForStatement':
          break;
        case 'ConditionalExpression': if (field !== 'test') opaque(`the environment is used in ${src(p)}`, p); break;
        default: opaque(`the environment is used whole (${src(p)})`, p);
      }
    }
    if (!grew) break;
  }
  return { keys, dynamic };
}

function lineOf(text, needle) {
  if (!needle) return null;
  const i = text.split('\n').findIndex((l) => l.includes(needle));
  return i === -1 ? null : i + 1;
}

// { keys: [{ key, line }], dynamic: [{ what, line }] } for one file, or { error }.
// Lines are those of the file as written; for .astro, where the compiler moves code
// around, the line is found again by searching the source.
export function envReads(file, text) {
  try {
    if (!file.endsWith('.astro')) return analyzeAst(parseCode(text, file), text);
    const out = astroTransform(text, { filename: `/${file}` });
    const parts = [{ code: out.code }, ...(out.scripts || []).filter((s) => typeof s.code === 'string').map((s) => ({ code: s.code }))];
    const keys = [], dynamic = [];
    for (const { code } of parts) {
      const r = analyzeAst(parseCode(code, 'x.ts'), code);
      for (const k of r.keys) keys.push({ key: k.key, line: lineOf(text, k.key) });
      for (const d of r.dynamic) dynamic.push({ what: d.what, line: lineOf(text, d.needle) ?? lineOf(text, d.needle.split(/[^\w.$]/)[0]) });
    }
    return { keys, dynamic };
  } catch (e) {
    return { error: String(e.message || e).split('\n')[0].slice(0, 160) };
  }
}
