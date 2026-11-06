const path = require('node:path');
const fs = require('node:fs');

function normalizePatch(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
}

function createRankedPatchContext({ patch, itemData, exclusiveGroups, mapId = '11' } = {}) {
  const currentPatch = normalizePatch(patch || itemData?.version);
  const staticPatch = normalizePatch(itemData?.version);
  const matrixPatch = normalizePatch(exclusiveGroups?.patch);
  const errors = [];
  if (!currentPatch) errors.push('patch-missing');
  if (!staticPatch || staticPatch !== currentPatch) errors.push('data-dragon-patch-mismatch');
  if (!matrixPatch || matrixPatch !== currentPatch) errors.push('exclusive-matrix-patch-mismatch');
  if (exclusiveGroups?.status !== 'verified') errors.push('exclusive-matrix-unverified');
  if (String(exclusiveGroups?.mapId || '') !== String(mapId)) errors.push('exclusive-matrix-map-mismatch');
  return Object.freeze({
    mode: 'ranked', mapId: String(mapId), patch: currentPatch, staticPatch, matrixPatch,
    ready: errors.length === 0, errors
  });
}

function readRankedPatchContext(rootDir, patch) {
  const normalized = normalizePatch(patch);
  if (!normalized) throw new Error('Patch inválido para Ranked');
  const itemPath = path.join(rootDir, 'data', 'dragon', 'cdn', normalized, 'data', 'en_US', 'item.json');
  const groupsPath = path.join(rootDir, 'data', 'ranked', `item-groups-${normalized}.json`);
  const itemData = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
  const exclusiveGroups = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
  return { itemData, exclusiveGroups, context: createRankedPatchContext({ patch: normalized, itemData, exclusiveGroups }) };
}

module.exports = { normalizePatch, createRankedPatchContext, readRankedPatchContext };
