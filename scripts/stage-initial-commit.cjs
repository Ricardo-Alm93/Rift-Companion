const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = path.join(root, 'docs/INITIAL_COMMIT_ALLOWLIST.txt');
const stage = process.argv.includes('--stage');
const files = fs.readFileSync(manifest, 'utf8').split(/\r?\n/)
  .map(row => row.trim()).filter(row => row && !row.startsWith('#'));

if (!files.length || new Set(files).size !== files.length) throw new Error('Allowlist is empty or contains duplicate paths.');
const bannedPath = /(^|\/)(?:\.env\.local|node_modules|work|outputs|coverage|dist|release)(\/|$)|(^|\/)data\/ranked\/(?:opgg-live-audit|pilot-build-profiles|coverage-report|champion-intelligence-report|champion-strategic-certification-report|audit-50-cases)/i;
for (const relative of files) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || bannedPath.test(relative)) {
    throw new Error(`Disallowed path in initial-commit manifest: ${relative}`);
  }
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`) || !fs.statSync(absolute).isFile()) throw new Error(`Missing or out-of-workspace allowlist path: ${relative}`);
}

const sensitivePatterns = [
  { name: 'Riot API key pattern', expression: /RGAPI-[A-Za-z0-9-]{20,}/g },
  { name: 'private-key PEM header', expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'AWS access key pattern', expression: /AKIA[0-9A-Z]{16}/g },
  { name: 'local user path', expression: /[A-Za-z]:[\\/]Users[\\/]kawaw(?:[\\/]|\b)/gi }
];
const findings = [];
for (const relative of files) {
  const content = fs.readFileSync(path.resolve(root, relative));
  const text = content.toString('utf8');
  for (const pattern of sensitivePatterns) if (pattern.expression.test(text)) findings.push({ file: relative, kind: pattern.name });
}
if (findings.length) {
  for (const row of findings) console.error(`Sensitive candidate: ${row.file} (${row.kind})`);
  throw new Error('Remove or review candidate files before staging. Secret values are never printed.');
}

console.log(`Reviewed allowlist: ${files.length} files; no configured secret/path patterns found.`);
if (!stage) {
  console.log('Dry run only. Pass --stage to initialize local Git and stage exactly these files.');
  process.exit(0);
}

const git = (args, { quiet = false } = {}) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
  return result.stdout || '';
};
if (!fs.existsSync(path.join(root, '.git'))) git(['init', '--initial-branch=main']);
const stagedBefore = git(['diff', '--cached', '--name-only'], { quiet: true }).trim();
if (stagedBefore) throw new Error('The Git index already contains staged files. Review it before running this stage step.');
git(['add', '--', ...files]);
const staged = git(['diff', '--cached', '--name-only'], { quiet: true }).trim().split(/\r?\n/).filter(Boolean).sort();
const expected = [...files].sort();
if (JSON.stringify(staged) !== JSON.stringify(expected)) {
  console.error('Staged file list differs from the allowlist; clearing the index for safety.');
  git(['reset', '--quiet']);
  throw new Error('Staging verification failed.');
}
console.log(`Prepared local first-commit review: ${staged.length} allowlisted files staged. No commit or remote was created.`);
