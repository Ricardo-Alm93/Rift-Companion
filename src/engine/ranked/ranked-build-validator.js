const MODE_EXCLUSIVE = new Set(['arena', 'arenaitem', 'arenaonly', 'aram', 'aramonly', 'modeexclusivearena', 'modeexclusivearam', 'wildrift']);
const rankedTransformationApi = typeof module !== 'undefined' && module.exports ? require('./item-transformation') : globalThis.RiftItemTransformation;

function validateRankedSet({ itemIds = [], catalog = {}, patch = '', mapId = '11', exclusiveGroups = null, championId = '', role = '', roleQuestCompleted = false, questBootsItemId = '', requireSix = true } = {}) {
  const ids = (Array.isArray(itemIds) ? itemIds : []).map(value => String(value));
  const errors = [];
  const add = (code, conflictIds = []) => errors.push({ code, itemIds: [...new Set(conflictIds.map(String))] });
  const matrixReady = exclusiveGroups?.status === 'verified'
    && String(exclusiveGroups?.patch || '') === String(patch || '')
    && String(exclusiveGroups?.mapId || '') === String(mapId)
    && String(mapId) === '11';
  if (!matrixReady) add('exclusive-matrix-unverified');
  if (exclusiveGroups?.patch && patch && exclusiveGroups.patch !== patch) add('exclusive-matrix-patch-mismatch');
  if (String(mapId) !== '11') add('ranked-map-required');
  if (catalog?.patch && patch && catalog.patch !== patch) add('data-dragon-patch-mismatch');
  if (requireSix && ids.length !== 6) add('six-slots-required', ids);
  if (!requireSix && !ids.length) add('empty-core');
  if (!requireSix && ids.length > 6) add('core-exceeds-six-slots', ids);

  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  for (const [id, count] of counts) if (count > 1) add('duplicate-item', [id]);

  for (const id of ids) {
    const item = catalog[id];
    if (!item) { add('item-not-available-in-mode', [id]); continue; }
    const acquisition = rankedTransformationApi.resolveItemAcquisition(id, catalog, exclusiveGroups, { patch, mapId });
    const transformedFinalAllowed = acquisition.valid && acquisition.purchaseItemId !== id;
    if ((item.purchasable !== true || item.inStore === false) && !transformedFinalAllowed || item.maps?.[String(mapId)] !== true || MODE_EXCLUSIVE.has(String(id).toLowerCase())) add('item-not-available-in-mode', [id]);
    if ((item.tags || []).some(tag => MODE_EXCLUSIVE.has(String(tag).toLowerCase()))) add('mode-exclusive-item', [id]);
    // Data Dragon's GoldPer tag can appear on ordinary final items (notably Stormsurge 4646).
    // Data Dragon's GoldPer and Vision tags can appear on ordinary final items (e.g. Stormsurge
    // 4646 and Umbral Glaive 3179). Keep structural tags and the verified Starter group for
    // non-slot filtering; Vision alone is not an item-slot classification.
    const supportUpgrade = exclusiveGroups?.roleQuestRules?.status === 'verified' && (exclusiveGroups.roleQuestRules.supportFinalItemIds || []).map(String).includes(id) && String(role).toLowerCase() === 'support' && !(item.buildInto || []).length;
    if (!supportUpgrade && ((item.tags || []).some(tag => ['consumable', 'trinket', 'jungle', 'lane'].includes(String(tag).toLowerCase())) || (exclusiveGroups?.groups?.Starter || []).map(String).includes(id))) add('non-build-slot-item', [id]);
    if (item.requiredChampion && String(item.requiredChampion) !== String(championId)) add('required-champion-mismatch', [id]);
    // Items with upgrade recipes are components; finished boots are the exception.
    const isBoots = (exclusiveGroups?.groups?.Boots || []).map(String).includes(id) || (item.tags || []).includes('boots');
    if (!isBoots && (item.buildInto || []).length > 0) add('component-not-final-slot', [id]);
  }

  for (const [groupId, members] of Object.entries(exclusiveGroups?.groups || {})) {
    const conflicts = ids.filter(id => (members || []).map(String).includes(id));
    if (conflicts.length > 1) add('unique-group-conflict', conflicts);
  }

  const bootsGroup = exclusiveGroups?.groups?.Boots || [];
  const bootIds = ids.filter(id => bootsGroup.map(String).includes(id) || (catalog[id]?.tags || []).includes('boots'));
  const questBoot = String(questBootsItemId || '');
  if (questBoot) {
    const questRules = exclusiveGroups?.roleQuestRules;
    if (!roleQuestCompleted || !questRules || questRules.status !== 'verified') add('role-quest-state-unverified', [questBoot]);
    else if (!['bot', 'adc'].includes(String(role).toLowerCase())) add('role-quest-slot-role-mismatch', [questBoot]);
    if (!catalog[questBoot]) add('quest-item-not-available', [questBoot]);
    else if (!bootsGroup.map(String).includes(questBoot) && !(catalog[questBoot].tags || []).includes('boots')) add('quest-slot-requires-boots', [questBoot]);
  }
  if (bootIds.length + (questBoot ? 1 : 0) > 1) add('boots-limit-exceeded', [...bootIds, ...(questBoot ? [questBoot] : [])]);

  // Recipes and transformation stages replace their inputs in place. Check the full
  // acquisition chain so an intermediate (for example Winter's Approach) cannot occupy
  // a second permanent slot beside its evolved final item.
  const selected = new Set(ids);
  for (const upgradeId of ids) {
    const consumed = rankedTransformationApi.getConsumedItemIds(upgradeId, catalog, exclusiveGroups, { patch, mapId });
    if (!consumed.valid) continue;
    for (const componentId of consumed.consumedItemIds || []) if (selected.has(String(componentId))) add('component-and-upgrade-conflict', [componentId, upgradeId]);
  }

  const uniqueErrors = [];
  const seen = new Set();
  for (const error of errors) {
    const key = `${error.code}:${error.itemIds.slice().sort().join(',')}`;
    if (!seen.has(key)) { seen.add(key); uniqueErrors.push(error); }
  }
  const codes = [...new Set(uniqueErrors.map(error => error.code))];
  return {
    valid: uniqueErrors.length === 0,
    buildStatus: uniqueErrors.length ? (matrixReady ? 'rejected' : 'unverified') : 'validated',
    patch: String(patch || ''), mapId: String(mapId), matrixReady,
    errors: codes,
    errorDetails: uniqueErrors,
    conflictingItemIds: [...new Set(uniqueErrors.flatMap(error => error.itemIds))]
  };
}

function validateRankedBuild(options = {}) { return validateRankedSet({ ...options, requireSix: true }); }
function validateRankedCore(options = {}) { return validateRankedSet({ ...options, requireSix: false }); }

const rankedValidatorApi = { validateRankedBuild, validateRankedCore };
if (typeof module !== 'undefined' && module.exports) module.exports = rankedValidatorApi;
if (typeof globalThis !== 'undefined') globalThis.RiftRankedBuildValidator = rankedValidatorApi;
