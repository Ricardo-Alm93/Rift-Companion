'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadMayhemCatalog, availableAugments } = require('../src/engine/aram-mayhem-catalog.cjs');
const root = path.resolve(__dirname, '..');
const catalog = loadMayhemCatalog(root), errors = [], warnings = [];
const unique = (values, label) => { if (new Set(values).size !== values.length) errors.push(`duplicate-${label}`); };
unique(catalog.rows.map(row => row.slug), 'augment-slug');
unique(catalog.headliners.rows.map(row => row.id), 'headliner-id');
for (const row of catalog.rows) {
  if (!row.slug || !row.augmentId || !row.name?.en || !row.name?.['es-MX']) errors.push(`missing-augment-identity-or-name:${row.slug || 'unknown'}`);
  if (row.pickRate != null && (!row.snapshotStats?.patch || row.snapshotStats.patch !== catalog.basePatch)) errors.push(`unattributed-augment-frequency:${row.slug}`);
  if (row.introducedPatch === catalog.patch && !row.provenance?.url) errors.push(`missing-new-augment-source:${row.slug}`);
}
for (const row of catalog.patchNotes.changes) if (!row.slug || !row.verification || !row.change?.en || !row.change?.['es-MX']) errors.push(`invalid-patch-change:${row.slug || 'unknown'}`);
for (const row of catalog.headliners.rows) if (!row.provenance || !row.sourcePatch) errors.push(`headliner-provenance-missing:${row.id}`);
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'data/aram-mayhem/interaction-evidence.json'), 'utf8'));
unique(evidence.interactions.map(row => row.id), 'interaction-id');
for (const row of evidence.interactions) {
  if (!row.augmentId || !row.evidenceLevel || !row.confidence || !row.patch || !row.source || !row.evidence || !row.en?.what || !row.es?.what) errors.push(`incomplete-interaction-evidence:${row.id}`);
  if (!['documented', 'editorial-reviewed'].includes(row.evidenceLevel)) errors.push(`invalid-positive-evidence-level:${row.id}`);
  if (row.championIds && row.championIds.some(id => !['Ahri','Ryze','Cassiopeia','Azir','Jinx','KaiSa','Ornn','Soraka'].includes(id))) warnings.push(`interaction-outside-pilot:${row.id}`);
}
const headliners = catalog.headliners.rows.map(row => row.id);
if (headliners.length !== 8 || !catalog.headliners.catalogCompleteness.includes('minimum')) errors.push('headliner-list-must-be-verified-minimum');
const available = new Set(availableAugments(catalog).map(row => row.slug));
for (const slug of catalog.patchNotes.retirements.confirmedRetired) if (available.has(slug)) errors.push(`retired-augment-still-offered:${slug}`);
const report = { mechanicsPatch: catalog.patch, statsPatch: catalog.basePatch, statsDate: catalog.statsDate, availableAugments: available.size, patch22OfficialAugments: catalog.patchNotes.augments.length, patch22Changes: catalog.patchNotes.changes.length, retiredConfirmed: catalog.patchNotes.retirements.confirmedRetired.length, headliners: catalog.headliners.rows.length, interactionEvidence: evidence.interactions.length, errors, warnings };
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
