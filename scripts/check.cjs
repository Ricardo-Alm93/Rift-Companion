const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const roots = ['src', 'scripts', 'tests'];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|cjs)$/.test(entry.name)) files.push(file);
  }
}
for (const root of roots) if (fs.existsSync(root)) walk(root);
for (const file of files) {
  const result = cp.spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}
console.log(`Syntax OK: ${files.length} JavaScript files across src/scripts/tests`);
