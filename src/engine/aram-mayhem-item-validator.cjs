'use strict';

function validateMayhemBuild({ itemIds = [], itemData = {}, mayhemItems = [], mayhemItemIds = [], transformations = {} }) {
  const ids = itemIds.map(String), rows = Array.isArray(mayhemItems) && mayhemItems.some(row => typeof row === 'object') ? mayhemItems : mayhemItemIds.map(gameItemId => ({ gameItemId })), byId = new Map(rows.map(row => [String(row.gameItemId), row])), allowed = new Set(rows.map(row => String(row.gameItemId))), errors = [], warnings = [];
  if (ids.length !== 6) errors.push('expected-six-final-items');
  if (new Set(ids).size !== ids.length) errors.push('duplicate-final-item');
  const canAcquire = (id, seen = new Set(), asTransformationComponent = false) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const item = itemData[id];
    if (!item) return false;
    const modeRow = byId.get(id);
    const canBuyDirectly = allowed.has(id) && item.maps?.['12'] === true && item.gold?.purchasable === true && item.inStore !== false;
    if (canBuyDirectly && asTransformationComponent) return true;
    if (canBuyDirectly) {
      // The Mayhem snapshot sometimes classifies complete Data Dragon items as
      // "epic". Use purchase-tree metadata to distinguish final items from
      // components instead of trusting that category alone.
      const hasUpgrade = Array.isArray(item.into) && item.into.length > 0;
      const isCompletedDdragonItem = Number(item.depth) >= 2 && !hasUpgrade;
      const isExplicitFinal = ['legendary', 'boots_tier2'].includes(modeRow?.category) || (item.tags || []).some(tag => ['Legendary', 'Boots', 'Mythic'].includes(tag));
      return isCompletedDdragonItem || isExplicitFinal;
    }
    const transform = transformations[id];
    if (transform?.status !== 'verified' || transform.mapId !== '12') return false;
    return (transform.fromItemIds || [transform.fromItemId]).filter(Boolean).some(parent => canAcquire(String(parent), seen, true));
  };
  for (const id of ids) {
    if (!itemData[id]) errors.push(`unknown-item:${id}`);
    else if (!canAcquire(id)) errors.push(allowed.has(id) ? `not-final-item:${id}` : `not-listed-in-mayhem-catalog:${id}`);
    else if (transformations[id]) warnings.push(`transformed-item:${id}`);
  }
  for (const finalId of ids) {
    const transformation = transformations[finalId];
    const parents = (transformation?.fromItemIds || [transformation?.fromItemId]).filter(Boolean).map(String);
    for (const parent of parents) if (ids.includes(parent)) errors.push(`consumed-component-also-counted:${parent}:${finalId}`);
  }
  return { valid: errors.length === 0, errors, warnings, itemIds: ids, mode: 'aram-mayhem' };
}

module.exports = { validateMayhemBuild };
