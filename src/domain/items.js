function normalizeItem(id, item, taxonomy = {}) {
  if (!item || typeof item !== 'object') return null;
  const override = taxonomy.overrides?.[String(id)] || {};
  return {
    id: String(id), name: String(item.name || ''), description: String(item.description || ''), plaintext: String(item.plaintext || ''),
    gold: Number(item.gold?.total || 0), stats: { ...(item.stats || {}) }, maps: { ...(item.maps || {}) }, purchasable: item.gold?.purchasable !== false,
    inStore: item.inStore !== false, depth: Number(item.depth || 0), requiredChampion: String(item.requiredAlly || item.requiredChampion || ''),
    tags: [...new Set([...(item.tags || []).map(x => String(x).toLowerCase()), ...(override.tags || []).map(x => String(x).toLowerCase()), ...(override.conditions || []).map(x => String(x).toLowerCase())])],
    uniqueGroup: String(override.uniqueGroup || ''), uniqueGroups: [...new Set([...(override.uniqueGroups || []), ...(override.uniqueGroup ? [override.uniqueGroup] : [])].map(String))], source: override.source || 'Riot Data Dragon', patch: String(override.patch || ''),
    buildInto: (item.into || []).map(String), from: (item.from || []).map(String)
  };
}

function isUsableForMode(item, mapId = '11') {
  if (!item || !item.purchasable || item.maps?.[String(mapId)] !== true) return false;
  const tags = new Set((item.tags || []).map(tag => String(tag).toLowerCase()));
  if (tags.has('consumable') || tags.has('trinket')) return false;
  if (String(mapId) === '11' && ['arena', 'arenaitem', 'arenaonly', 'aram', 'aramonly', 'modeexclusivearena', 'modeexclusivearam'].some(tag => tags.has(tag))) return false;
  return true;
}

module.exports = { normalizeItem, isUsableForMode };
