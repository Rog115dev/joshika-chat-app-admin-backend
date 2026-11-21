/**
 * Ensure every top-level helper used inside old monolith route handlers
 * still has a declaration somewhere under src/.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const old = execSync('git show cde050e:index.js', {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});

const defs = new Set();
for (const m of old.matchAll(
  /(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
)) {
  defs.add(m[1]);
}
for (const m of old.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
  defs.add(m[1]);
}

const idxs = [];
const re = /app\.(get|post|put|patch|delete)\(/g;
let m;
while ((m = re.exec(old))) idxs.push(m.index);

const routeChunks = [];
for (let i = 0; i < idxs.length; i++) {
  routeChunks.push(
    old.slice(idxs[i], i + 1 < idxs.length ? idxs[i + 1] : old.length),
  );
}

const usedInRoutes = new Set();
for (const chunk of routeChunks) {
  for (const name of defs) {
    if (new RegExp(String.raw`\b${name}\b`).test(chunk)) {
      usedInRoutes.add(name);
    }
  }
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8'));
  }
  return out;
}

const srcText =
  walk(path.join(ROOT, 'src')).join('\n') +
  '\n' +
  fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

const skip = new Set([
  'PORT',
  'HOST',
  'MONGODB_URI',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'BACKUP_SECRET',
  'BACKUP_DIR',
  'PUBLIC_API_BASE',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'ADMIN_WEB_DIR',
  'HEALTH_LOG_INTERVAL_SEC',
  'SELF_URL',
  // last route chunk also includes boot code; these are entrypoint-only
  'start',
  'selfieBackfill',
]);

const missing = [];
for (const name of [...usedInRoutes].sort()) {
  if (skip.has(name)) continue;
  const hasDecl = new RegExp(
    String.raw`(?:async\s+)?function\s+${name}\b|const\s+${name}\s*=`,
  ).test(srcText);
  if (!hasDecl) missing.push(name);
}

console.log('=== Old route helpers missing declaration in src/ ===');
console.log(`Helpers used in old routes: ${usedInRoutes.size}`);
if (missing.length) {
  missing.forEach((n) => console.log('  -', n));
  process.exit(1);
}
console.log('none');
