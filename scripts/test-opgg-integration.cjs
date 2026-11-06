const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const required = [
  'data/ranked/opgg-live-audit-2026-11-04.json',
  'data/ranked/opgg-live-audit-batch-2026-11-04.json',
  'data/ranked/opgg-live-audit-batch-2026-11-04-expansion.json'
];
const missing = required.filter(relative => !fs.existsSync(path.join(root, relative)));
if (missing.length) {
  console.error('Optional OP.GG integration suite not run. These local, ignored audit files are required:');
  for (const file of missing) console.error(`- ${file}`);
  console.error('Do not add them to Git; the default fixture-backed suite does not require these files.');
  process.exit(2);
}

const result = spawnSync(process.execPath, ['--test', 'tests/optional/opgg.integration.cjs'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, RIFT_OPGG_INTEGRATION: '1', RIOT_API_KEY: '', RIFT_DISABLE_LOCAL_ENV_FILE: '1' }
});
if (result.error) {
  console.error(`Could not start the optional suite: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
