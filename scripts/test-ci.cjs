const { spawnSync } = require('node:child_process');

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('Run this check with `npm run test:ci` so the locked npm installation is used.');
  process.exit(2);
}

const steps = [
  'check',
  'test',
  'validate:data',
  'validate:aram-mayhem',
  'test:electron',
  'capture:readme-screenshots'
];
const env = {
  ...process.env,
  RIOT_API_KEY: '',
  RIFT_OPGG_INTEGRATION: '0',
  RIFT_DISABLE_LOCAL_ENV_FILE: '1'
};

for (const step of steps) {
  console.log(`\n[CI] npm run ${step}`);
  const result = spawnSync(process.execPath, [npmCli, 'run', step], { stdio: 'inherit', env });
  if (result.error) {
    console.error(`[CI] Could not start ${step}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[CI] Failed at ${step} (exit ${result.status ?? 'unknown'}).`);
    process.exit(result.status || 1);
  }
}

console.log('\n[CI] All offline-safe project checks passed.');
