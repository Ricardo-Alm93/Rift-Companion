const { normalizeItem, isUsableForMode } = require('../domain/items');
const { validateRankedBuild, validateRankedCore } = require('./ranked/ranked-build-validator.js');
const { resolveItemAcquisition } = require('./ranked/item-transformation');

function buildItemCatalog({ itemData = {}, taxonomy = {}, mapId = '11', patch = '', exclusiveGroups = null } = {}) {
  const catalog = {};
  const source = itemData.data || itemData;
  const itemGroups = new Map();
  for (const [groupId, ids] of Object.entries(exclusiveGroups?.groups || {})) {
    for (const id of ids || []) {
      const groups = itemGroups.get(String(id)) || [];
      groups.push(groupId);
      itemGroups.set(String(id), groups);
    }
  }
  const normalized = Object.fromEntries(Object.entries(source).map(([id, raw]) => [id, normalizeItem(id, raw, taxonomy)]).filter(([, item]) => !!item));
  for (const [id, raw] of Object.entries(source)) {
    const item = normalized[id];
    if (!item) continue;
    const acquisition = resolveItemAcquisition(id, normalized, exclusiveGroups, { patch, mapId });
    const transformedFinal = acquisition.valid && acquisition.transformationPath.length > 0;
    const modeTags = new Set(item.tags.map(tag => String(tag).toLowerCase()));
    const modeExclusive = ['arena', 'arenaitem', 'arenaonly', 'aram', 'aramonly', 'modeexclusivearena', 'modeexclusivearam', 'wildrift'].some(tag => modeTags.has(tag));
    if (item.maps?.[String(mapId)] !== true || modeExclusive || (!isUsableForMode(item, mapId) && !transformedFinal)) continue;
    item.patch = String(patch || item.patch || '');
    item.uniqueGroups = [...new Set([...item.uniqueGroups, ...(itemGroups.get(String(id)) || [])])];
    item.uniqueGroup = item.uniqueGroups[0] || '';
    item.tier = Number(raw?.tier || raw?.depth || 0);
    catalog[id] = item;
  }
  Object.defineProperties(catalog, {
    patch: { value: String(patch || ''), enumerable: false },
    mapId: { value: String(mapId), enumerable: false },
    exclusiveGroups: { value: exclusiveGroups || null, enumerable: false }
  });
  return catalog;
}

function validateBuildItems(itemIds, catalog, options = {}) {
  const matrix = options.exclusiveGroups || catalog?.exclusiveGroups;
  return validateRankedBuild({
    itemIds,
    catalog,
    patch: options.patch || catalog?.patch || '',
    mapId: options.mapId || catalog?.mapId || '11',
    exclusiveGroups: matrix,
    championId: options.championId || '',
    role: options.role || '',
    roleQuestCompleted: options.roleQuestCompleted === true,
    questBootsItemId: options.questBootsItemId || ''
  });
}

function validateCoreItems(itemIds, catalog, options = {}) {
  const matrix = options.exclusiveGroups || catalog?.exclusiveGroups;
  return validateRankedCore({
    itemIds,
    catalog,
    patch: options.patch || catalog?.patch || '',
    mapId: options.mapId || catalog?.mapId || '11',
    exclusiveGroups: matrix,
    championId: options.championId || '',
    role: options.role || '',
    roleQuestCompleted: options.roleQuestCompleted === true,
    questBootsItemId: options.questBootsItemId || ''
  });
}

module.exports = { buildItemCatalog, validateBuildItems, validateCoreItems };
