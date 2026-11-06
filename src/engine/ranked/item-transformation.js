function resolveItemAcquisition(itemId, catalog = {}, matrix = null, { patch = '', mapId = '11' } = {}) {
  const finalId = String(itemId || ''), path = [], visited = new Set();
  let currentId = finalId;
  while (currentId) {
    if (visited.has(currentId)) return { valid: false, reason: 'transformation-cycle', finalItemId: finalId, path };
    visited.add(currentId);
    const item = catalog[currentId];
    if (!item) return { valid: false, reason: 'transformation-item-missing', finalItemId: finalId, path };
    if (item.maps?.[String(mapId)] !== true) return { valid: false, reason: 'transformation-map-mismatch', finalItemId: finalId, path: [...path, currentId] };
    path.push(currentId);
    if (item.purchasable === true && item.inStore !== false) {
      return { valid: true, finalItemId: finalId, purchaseItemId: currentId, path, transformationPath: path.length > 1 ? [...path] : [] };
    }
    const transform = matrix?.transformations?.[currentId];
    if (!transform || transform.status !== 'verified') return { valid: false, reason: 'unverified-transformation', finalItemId: finalId, path };
    if (String(transform.patch || '') !== String(patch || '') || String(matrix?.patch || '') !== String(patch || '')) return { valid: false, reason: 'transformation-patch-mismatch', finalItemId: finalId, path };
    const fromId = String(transform.fromItemId || '');
    if (!fromId || fromId === currentId) return { valid: false, reason: 'transformation-source-missing', finalItemId: finalId, path };
    currentId = fromId;
  }
  return { valid: false, reason: 'transformation-source-missing', finalItemId: finalId, path };
}

function getConsumedItemIds(itemId, catalog = {}, matrix = null, options = {}) {
  const acquired = resolveItemAcquisition(itemId, catalog, matrix, options);
  if (!acquired.valid) return acquired;
  const consumed = new Set(acquired.path.slice(1));
  const visitRecipe = (id, seen = new Set()) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const component of catalog[id]?.from || []) {
      const componentId = String(component);
      consumed.add(componentId);
      visitRecipe(componentId, seen);
    }
  };
  // Final item's purchase root may itself be assembled from components; these are not
  // additional inventory slots once the final item is complete.
  visitRecipe(acquired.purchaseItemId);
  return { ...acquired, consumedItemIds: [...consumed] };
}

const itemTransformationApi = { resolveItemAcquisition, getConsumedItemIds };
if (typeof module !== 'undefined' && module.exports) module.exports = itemTransformationApi;
if (typeof globalThis !== 'undefined') globalThis.RiftItemTransformation = itemTransformationApi;
