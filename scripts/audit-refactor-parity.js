/**
 * Compare route surface + shared helper usage between pre-refactor monolith
 * (git show cde050e:index.js) and current src/routes modules.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function loadOldMonolith() {
  return execSync('git show cde050e:index.js', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function extractRoutes(src) {
  const routes = [];
  const re =
    /\b(?:app|router)\.(get|post|put|patch|delete|use)\(\s*(['"`])([^'"`]+)\2/g;
  let m;
  while ((m = re.exec(src))) {
    routes.push({ method: m[1].toUpperCase(), path: m[3] });
  }
  return routes;
}

function routeKey(r) {
  return `${r.method} ${r.path}`;
}

function collectRouteFiles() {
  const dir = path.join(ROOT, 'src', 'routes');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f));
}

/** Helpers that existed as top-level async/function in old monolith and were used by routes. */
const CRITICAL_HELPERS = [
  'authUser',
  'requireAdmin',
  'requireApprovedUser',
  'publicUser',
  'publicProfileAsync',
  'profileFromBody',
  'findUserByEmail',
  'findUserById',
  'verificationWithUser',
  'getNextId',
  'newToken',
  'userSessions',
  'adminSessions',
  'passwordResetCodes',
  'clearUserSessions',
  'applyApprovedSelfieToProfile',
  'normalizeImageUrl',
  'isUsableSelfieUrl',
  'latestVerificationForUser',
  'isPrivateHostname',
  'isEitherBlocked',
  'declinePendingInvitesBetween',
  'makeResetCode',
  'sendPasswordResetEmail',
  'str',
  'stripMongoId',
];

function usedHelpers(src) {
  const used = [];
  for (const name of CRITICAL_HELPERS) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(src)) used.push(name);
  }
  return used;
}

function importedOrLocal(src, name) {
  // require destructure
  if (
    new RegExp(
      `\\{\\s*[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*require\\(`,
    ).test(src)
  ) {
    return true;
  }
  // const/let/var/function declaration
  if (
    new RegExp(
      `(?:const|let|var|function|async function)\\s+${name}\\b`,
    ).test(src)
  ) {
    return true;
  }
  // module.exports assignment of local name used later unlikely
  return false;
}

const oldSrc = loadOldMonolith();
const oldRoutes = extractRoutes(oldSrc).filter(
  (r) => r.path.startsWith('/') && r.method !== 'USE',
);

const newSrcParts = collectRouteFiles().map((f) => ({
  file: path.relative(ROOT, f),
  src: fs.readFileSync(f, 'utf8'),
}));
const newSrc = newSrcParts.map((p) => p.src).join('\n');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
const newRoutes = extractRoutes(newSrc + '\n' + appSrc).filter(
  (r) => r.path.startsWith('/') && r.method !== 'USE',
);

const oldKeys = new Set(oldRoutes.map(routeKey));
const newKeys = new Set(newRoutes.map(routeKey));

const missingInNew = [...oldKeys].filter((k) => !newKeys.has(k)).sort();
const extraInNew = [...newKeys].filter((k) => !oldKeys.has(k)).sort();

console.log('=== Route surface vs cde050e monolith ===');
console.log(`Old routes: ${oldKeys.size}`);
console.log(`New routes: ${newKeys.size}`);
if (missingInNew.length) {
  console.log('MISSING in new:');
  missingInNew.forEach((k) => console.log('  -', k));
} else {
  console.log('MISSING in new: none');
}
if (extraInNew.length) {
  console.log('EXTRA in new (ok if intentional):');
  extraInNew.forEach((k) => console.log('  +', k));
}

console.log('\n=== Helper used-but-not-imported per route file ===');
let helperMisses = 0;
for (const part of newSrcParts) {
  const used = usedHelpers(part.src);
  const missing = used.filter((n) => !importedOrLocal(part.src, n));
  // requireAdmin etc may come from middleware import - already covered by importedOrLocal
  if (missing.length) {
    helperMisses += missing.length;
    console.log(`${part.file}:`);
    missing.forEach((n) => console.log(`  missing import/decl: ${n}`));
  }
}
if (!helperMisses) console.log('none');

// Also scan middleware/services/lib for same
console.log('\n=== Helper used-but-not-imported in services/middleware/lib ===');
const moreDirs = ['src/services', 'src/middleware', 'src/lib'].map((d) =>
  path.join(ROOT, d),
);
let moreMisses = 0;
for (const dir of moreDirs) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const full = path.join(dir, f);
    const src = fs.readFileSync(full, 'utf8');
    const used = usedHelpers(src);
    const missing = used.filter((n) => !importedOrLocal(src, n));
    // definitions of the helper itself don't count as missing
    const real = missing.filter((n) => {
      // file that defines the helper is fine
      return !new RegExp(
        `(?:async\\s+)?function\\s+${n}\\b|const\\s+${n}\\s*=`,
      ).test(src);
    });
    if (real.length) {
      moreMisses += real.length;
      console.log(`${path.relative(ROOT, full)}:`);
      real.forEach((n) => console.log(`  missing import/decl: ${n}`));
    }
  }
}
if (!moreMisses) console.log('none');

const failed = missingInNew.length > 0 || helperMisses > 0 || moreMisses > 0;
process.exit(failed ? 1 : 0);
