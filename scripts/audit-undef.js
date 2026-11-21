/**
 * Static scan for free identifiers that are used but never declared/imported.
 * Catches refactor misses like `authUser is not defined`.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..');
const GLOBALS = new Set([
  'AbortController',
  'Buffer',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'console',
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Symbol',
  'Proxy',
  'Reflect',
  'JSON',
  'Math',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'ReferenceError',
  'RangeError',
  'SyntaxError',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Function',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'NaN',
  'Infinity',
  'undefined',
  'BigInt',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
  'Intl',
  'ArrayBuffer',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'DataView',
  'atob',
  'btoa',
  'fetch',
  'Response',
  'Request',
  'Headers',
  'FormData',
  'Blob',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'queueMicrotask',
  'structuredClone',
  'crypto',
  'performance',
  'global',
  'globalThis',
  'arguments',
]);

function collectJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      ent.name === 'node_modules' ||
      ent.name === 'admin-web' ||
      ent.name === 'backup'
    ) {
      continue;
    }
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) collectJs(p, out);
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function Scope(parent) {
  return { parent, decls: new Set() };
}

function declare(scope, name) {
  if (name) scope.decls.add(name);
}

function has(scope, name) {
  for (let s = scope; s; s = s.parent) {
    if (s.decls.has(name)) return true;
  }
  return GLOBALS.has(name);
}

function collectPattern(node, into) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      into.add(node.name);
      break;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') collectPattern(p.argument, into);
        else collectPattern(p.value, into);
      }
      break;
    case 'ArrayPattern':
      for (const el of node.elements) {
        if (!el) continue;
        if (el.type === 'RestElement') collectPattern(el.argument, into);
        else collectPattern(el, into);
      }
      break;
    case 'AssignmentPattern':
      collectPattern(node.left, into);
      break;
    case 'RestElement':
      collectPattern(node.argument, into);
      break;
    default:
      break;
  }
}

function isPatternContext(parent, parentKey) {
  if (!parent) return false;
  if (parent.type === 'VariableDeclarator' && parentKey === 'id') return true;
  if (parent.type === 'FunctionDeclaration' && parentKey === 'id') return true;
  if (parent.type === 'FunctionExpression' && parentKey === 'id') return true;
  if (parent.type === 'ClassDeclaration' && parentKey === 'id') return true;
  if (parent.type === 'ClassExpression' && parentKey === 'id') return true;
  if (parent.type === 'CatchClause' && parentKey === 'param') return true;
  if (parentKey === 'params') return true;
  if (parent.type === 'AssignmentPattern' && parentKey === 'left') return true;
  if (parent.type === 'RestElement' && parentKey === 'argument') return true;
  if (parent.type === 'ArrayPattern') return true;
  if (parent.type === 'ObjectPattern') return true;
  if (
    parent.type === 'Property' &&
    parentKey === 'value' &&
    parent.value &&
    parent.value.type === 'Identifier' &&
    !parent.shorthand
  ) {
    // binding in destructuring: { a: renamed }
    return true;
  }
  return false;
}

function findUndef(file) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = acorn.parse(src, {
      ecmaVersion: 2022,
      sourceType: 'script',
      locations: true,
    });
  } catch (e) {
    return [{ file, line: 0, name: `PARSE_ERROR:${e.message}` }];
  }

  const issues = [];
  const scopeStack = [Scope(null)];
  const current = () => scopeStack[scopeStack.length - 1];
  const pushScope = () => scopeStack.push(Scope(current()));
  const popScope = () => scopeStack.pop();

  // Hoist program-level bindings first
  for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration' && st.id) declare(current(), st.id.name);
    if (st.type === 'ClassDeclaration' && st.id) declare(current(), st.id.name);
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) collectPattern(d.id, current().decls);
    }
  }

  function walkNode(node, parent, parentKey) {
    if (!node || typeof node.type !== 'string') return;

    const isFn =
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression';

    if (isFn) {
      if (node.type === 'FunctionDeclaration' && node.id) {
        declare(current(), node.id.name);
      }
      pushScope();
      if (node.id && node.type !== 'FunctionDeclaration') {
        declare(current(), node.id.name);
      }
      for (const p of node.params) {
        collectPattern(p, current().decls);
        if (p && p.type === 'AssignmentPattern') walkNode(p.right, p, 'right');
      }
      if (node.body.type === 'BlockStatement') {
        for (const st of node.body.body) {
          if (st.type === 'FunctionDeclaration' && st.id) {
            declare(current(), st.id.name);
          }
          if (st.type === 'VariableDeclaration' && st.kind === 'var') {
            for (const d of st.declarations) collectPattern(d.id, current().decls);
          }
        }
        for (const st of node.body.body) walkNode(st, node.body, 'body');
      } else {
        walkNode(node.body, node, 'body');
      }
      popScope();
      return;
    }

    if (node.type === 'BlockStatement') {
      pushScope();
      for (const st of node.body) {
        if (st.type === 'FunctionDeclaration' && st.id) {
          declare(current(), st.id.name);
        }
      }
      for (const st of node.body) walkNode(st, node, 'body');
      popScope();
      return;
    }

    if (node.type === 'CatchClause') {
      pushScope();
      if (node.param) collectPattern(node.param, current().decls);
      walkNode(node.body, node, 'body');
      popScope();
      return;
    }

    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.init) walkNode(d.init, d, 'init');
        collectPattern(d.id, current().decls);
      }
      return;
    }

    if (node.type === 'Identifier') {
      if (
        parent &&
        parent.type === 'MemberExpression' &&
        parentKey === 'property' &&
        !parent.computed
      ) {
        return;
      }
      if (
        parent &&
        parent.type === 'Property' &&
        parentKey === 'key' &&
        !parent.computed &&
        !parent.shorthand
      ) {
        return;
      }
      if (
        parent &&
        (parent.type === 'LabeledStatement' ||
          parent.type === 'BreakStatement' ||
          parent.type === 'ContinueStatement') &&
        parentKey === 'label'
      ) {
        return;
      }
      if (isPatternContext(parent, parentKey)) return;

      // shorthand property is a reference
      if (parent && parent.type === 'Property' && parent.shorthand) {
        if (!has(current(), node.name)) {
          issues.push({ file, line: node.loc.start.line, name: node.name });
        }
        return;
      }

      if (!has(current(), node.name)) {
        issues.push({ file, line: node.loc.start.line, name: node.name });
      }
      return;
    }

    for (const k of Object.keys(node)) {
      if (
        [
          'type',
          'start',
          'end',
          'loc',
          'raw',
          'value',
          'cooked',
          'regex',
          'name',
        ].includes(k)
      ) {
        continue;
      }
      const v = node[k];
      if (Array.isArray(v)) {
        for (const c of v) walkNode(c, node, k);
      } else if (v && typeof v.type === 'string') {
        walkNode(v, node, k);
      }
    }
  }

  for (const st of ast.body) walkNode(st, ast, 'body');

  const seen = new Set();
  return issues.filter((i) => {
    const key = `${i.line}:${i.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const files = collectJs(path.join(ROOT, 'src')).concat(
  ['index.js', 'db.js', 'models.js']
    .map((f) => path.join(ROOT, f))
    .filter((f) => fs.existsSync(f)),
);

let all = [];
for (const f of files) all = all.concat(findUndef(f));

console.log('=== Undefined identifier scan ===');
if (!all.length) console.log('NONE');
else {
  for (const i of all) {
    console.log(`${path.relative(ROOT, i.file)}:${i.line}  ${i.name}`);
  }
}
console.log(`Total: ${all.length}`);
process.exit(all.length ? 1 : 0);
