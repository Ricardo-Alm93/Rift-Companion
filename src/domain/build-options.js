const { isUsableForMode } = require('./items');

function normalizeBuildOption(input = {}, catalog = {}, { mapId = '11' } = {}) {
  const ids = (input.itemIds || input.items || []).map(String);
  const errors = [];
  if (!ids.length || ids.length > 6) errors.push('item-count');
  if (new Set(ids).size !== ids.length) errors.push('duplicate-items');
  if (ids.some(id => !isUsableForMode(catalog[id], mapId))) errors.push('invalid-item');
  const evidence = ['observed', 'curated', 'rule-based', 'assembled'].includes(input.evidence) ? input.evidence : 'rule-based';
  return {
    valid: errors.length === 0, errors,
    option: { id: String(input.id || 'option'), label: String(input.label || ''), style: String(input.style || 'standard'), itemIds: ids, reasons: Array.isArray(input.reasons) ? input.reasons.map(String) : [], tradeoffs: Array.isArray(input.tradeoffs) ? input.tradeoffs.map(String) : [], evidence, source: String(input.source || ''), patch: String(input.patch || ''), purchaseSteps: Array.isArray(input.purchaseSteps) ? input.purchaseSteps : [] }
  };
}

module.exports = { normalizeBuildOption };
