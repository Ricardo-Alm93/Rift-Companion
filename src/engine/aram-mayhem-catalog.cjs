'use strict';

const path = require('node:path');
const fs = require('node:fs');

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function loadMayhemCatalog(root = path.resolve(__dirname, '..', '..')) {
  const dir = path.join(root, 'data', 'aram-mayhem');
  const base = read(path.join(dir, 'augments.json'));
  const patch = read(path.join(dir, 'patch-26.22.json'));
  const overrides = new Map(patch.augments.map(row => [row.slug, row]));
  const changes = new Map(patch.changes.map(row => [row.slug, row]));
  const seen = new Set();
  const rows = base.rows.map(row => {
    seen.add(row.slug);
    const update = overrides.get(row.slug);
    return { ...row, ...(update || {}), snapshotStats: { patch: base.meta?.patch || '', date: base.meta?.statsDate || '', pickRate: row.pickRate ?? null, pickRateRank: row.pickRateRank ?? null, source: base.source || '' }, mechanicsPatch: patch.patch, verification: update?.verification || changes.get(row.slug)?.verification || 'snapshot-26.21', patchChange: changes.get(row.slug)?.change || null, mechanicsSource: changes.has(row.slug) ? patch.source : row.url || base.source || '', description: update?.effect?.['es-MX'] || update?.effect?.en || '' };
  }).filter(row => (!row.retiredPatch || !patch.patch || comparePatch(row.retiredPatch, patch.patch) > 0) && !patch.retirements.confirmedRetired.includes(row.slug));
  for (const row of patch.augments) if (!seen.has(row.slug) && (!row.retiredPatch || comparePatch(row.retiredPatch, patch.patch) > 0) && !patch.retirements.confirmedRetired.includes(row.slug)) rows.push({ ...row, augmentId: row.augmentId, slug: row.slug, pickRate: null, pickRateRank: null, snapshotStats: null, mechanicsPatch: patch.patch, description: row.effect?.['es-MX'] || row.effect?.en || '' });
  return { patch: patch.patch, basePatch: base.meta?.patch || '', statsDate: base.meta?.statsDate || '', source: patch.source, rows, headliners: read(path.join(dir, 'headliners.json')), journey: read(path.join(dir, 'journey-to-stardom.json')), patchNotes: patch };
}
function comparePatch(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i=0;i<Math.max(x.length,y.length);i++) { const d=(x[i]||0)-(y[i]||0); if(d)return d; } return 0; }
function availableAugments(catalog) { return catalog.rows.filter(row => !row.retiredPatch || comparePatch(row.retiredPatch, catalog.patch) > 0); }
module.exports = { loadMayhemCatalog, availableAugments, comparePatch };
