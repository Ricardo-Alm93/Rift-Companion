const fs = require('node:fs');
const path = require('node:path');

function parseEnv(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value.replace(/\\n/g, '\n');
  }
  return values;
}

function loadLocalEnv({ appDir, env = process.env, packaged = false } = {}) {
  if (packaged || !appDir || env.RIFT_DISABLE_LOCAL_ENV_FILE === '1') return { loaded: false, path: null };
  const file = path.join(appDir, '.env.local');
  try {
    const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) if (env[key] == null || env[key] === '') env[key] = value;
    return { loaded: true, path: file };
  } catch (error) {
    if (error.code === 'ENOENT') return { loaded: false, path: file };
    throw new Error('Could not read local environment configuration');
  }
}

module.exports = { parseEnv, loadLocalEnv };
