'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function preferenceFile(appDataPath, appName = 'rift-companion') {
  if (typeof appDataPath !== 'string' || !appDataPath) throw new TypeError('app data path required');
  const safeName = String(appName || 'rift-companion').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'rift-companion';
  return path.join(appDataPath, safeName, 'database', 'preferences.json');
}

async function readLcuEnabled(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return parsed?.lcuEnabled === true;
  } catch { return false; }
}

async function writeLcuEnabled(filePath, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('LCU preference must be boolean');
  const directory = path.dirname(filePath), temporary = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  let existing = {};
  try { const value = JSON.parse(await fs.readFile(filePath, 'utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) existing = value; } catch {}
  await fs.writeFile(temporary, JSON.stringify({ ...existing, lcuEnabled: enabled }), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filePath);
  return enabled;
}

module.exports = { preferenceFile, readLcuEnabled, writeLcuEnabled };
