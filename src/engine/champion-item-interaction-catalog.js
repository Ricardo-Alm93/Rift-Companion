'use strict';

const catalog = require('../../data/ranked/champion-item-interactions-16.22.1.json');
const VALID_LEVELS = new Set(['documented', 'editorial-reviewed', 'unknown']);

function getChampionItemInteractions({ championId = '', itemId = '', itemTags = [], abilityKey = '', patch = '' } = {}) {
  const tags = new Set(itemTags.map(tag => String(tag).toLowerCase().replace(/[^a-z0-9]/g, '')));
  return (catalog.interactions || []).filter(row =>
    String(row.championId) === String(championId) &&
    (!abilityKey || (row.abilityKeys || []).includes(String(abilityKey))) &&
    (itemId ? (row.itemIds || []).map(String).includes(String(itemId)) || (row.itemTags || []).some(tag => tags.has(String(tag).toLowerCase().replace(/[^a-z0-9]/g, ''))) : (row.itemTags || []).some(tag => tags.has(String(tag).toLowerCase().replace(/[^a-z0-9]/g, '')))) &&
    (!patch || String(row.patch) === String(patch)) && VALID_LEVELS.has(row.evidenceLevel)
  ).map(row => ({ ...row, itemIds: [...(row.itemIds || [])], abilityKeys: [...(row.abilityKeys || [])] }));
}

function evaluateAbilityItemInteraction({ championId = '', abilityKey = '', itemId = '', patch = '' } = {}) {
  const rows = getChampionItemInteractions({ championId, abilityKey, itemId, patch });
  return rows.length ? rows[0] : { championId, abilityKey, itemId: String(itemId), patch, interactionType: 'unknown', evidenceLevel: 'unknown', confidence: 0, verified: false, claim: 'No patch-specific ability-to-item interaction is established.' };
}

function getBuildStrategicReview({ championId = '', role = '', buildId = '', patch = '' } = {}) {
  const normalizedId = String(buildId).replace(/^generated-/, '');
  return (catalog.buildReviews || []).find(row => String(row.championId) === String(championId) && String(row.role) === String(role) && String(row.buildId) === normalizedId && (!patch || String(row.patch) === String(patch))) || null;
}

function validateInteractionCatalog(data = catalog) {
  const issues = [];
  for (const [index, row] of (data.interactions || []).entries()) {
    if (!row.championId || !row.patch || !row.source?.name || !row.source?.url || !VALID_LEVELS.has(row.evidenceLevel)) issues.push(`interaction[${index}]: missing identity, patch, source, or evidence level`);
    if (!Number.isFinite(Number(row.confidence)) || Number(row.confidence) < 0 || Number(row.confidence) > 1) issues.push(`interaction[${index}]: confidence must be between 0 and 1`);
    if (row.evidenceLevel === 'unknown' && row.verified === true) issues.push(`interaction[${index}]: unknown cannot be verified`);
    if (row.interactionType === 'passive-trigger' && row.evidenceLevel === 'unknown') issues.push(`interaction[${index}]: unknown cannot claim a passive trigger`);
    if (row.evidenceLevel === 'editorial-reviewed' && row.verified === true) issues.push(`interaction[${index}]: editorial inference cannot be labeled as a verified fact`);
  }
  for (const [index, row] of (data.buildReviews || []).entries()) {
    if (!row.championId || !row.role || !row.buildId || !row.patch || !row.source?.name || !Array.isArray(row.itemIds) || row.itemIds.length !== 6) issues.push(`buildReview[${index}]: incomplete six-slot review`);
  }
  return issues;
}

module.exports = { catalog, getChampionItemInteractions, evaluateAbilityItemInteraction, getBuildStrategicReview, validateInteractionCatalog };
