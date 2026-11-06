function normalizePatchCatalog({ version = '', champions = {}, items = {}, runes = [] } = {}) {
  return {
    dataDragonVersion: String(version),
    championIds: Object.keys(champions.data || champions).sort(),
    items: Object.fromEntries(Object.entries(items.data || items).map(([id, row]) => [String(id), row])),
    runeTrees: (Array.isArray(runes) ? runes : []).map(tree => ({ id: Number(tree.id), name: String(tree.name || ''), slots: (tree.slots || []).map(slot => (slot.runes || []).map(rune => Number(rune.id))) }))
  };
}

module.exports = { normalizePatchCatalog };
