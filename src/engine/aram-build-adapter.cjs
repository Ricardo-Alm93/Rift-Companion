'use strict';

const { resolveAugmentStatConversions } = require('./build-compatibility-v2.cjs');

function adaptMayhemBuild({ itemIds = [], selectedAugments = [], boughtItemIds = [], interactions = [], conversionRules = [], baseStats = {}, patch = '', language = 'es' }) {
  const en = language === 'en', current = itemIds.map(String), bought = new Set(boughtItemIds.map(String));
  const conversions = resolveAugmentStatConversions({ stats: baseStats, selectedAugments, conversionRules, patch });
  const applicable = interactions.filter(row => selectedAugments.includes(row.augmentId) && row.buildDirective);
  const directives = applicable.map(row => ({ augmentId: row.augmentId, ...row.buildDirective }));
  const preserve = directives.every(row => row.action === 'keep-current-build' || row.action === 'purchase-order-guidance');
  const orderGuidance = directives.find(row => row.action === 'purchase-order-guidance');
  const preferredItemIds = orderGuidance ? (orderGuidance.preferredItemIds?.length ? orderGuidance.preferredItemIds : current).map(String) : [];
  const nextPurchase = preferredItemIds.find(id => current.includes(id) && !bought.has(id)) || null;
  const allKnown = directives.length > 0;
  return {
    itemIds: current,
    changed: false,
    status: !allKnown ? 'insufficient-evidence' : preserve ? 'build-preserved' : 'review-required',
    nextPurchaseItemId: nextPurchase,
    acquiredItemIds: [...bought].filter(id => current.includes(id)),
    convertedStats: conversions.stats,
    appliedConversions: conversions.applied,
    conversionStatus: conversions.status,
    passiveActivationRechecked: false,
    explanation: allKnown
      ? (nextPurchase ? (en ? 'Keep the same six-item set. Prioritize the selected core item that is still unbought; the augment does not retroactively enhance an item already acquired.' : 'Conserva los mismos seis objetos. Prioriza el objeto núcleo seleccionado que aún no compraste; el aumento no mejora retroactivamente un objeto adquirido.') : (en ? 'The evidence supports keeping the current item set; no replacement is justified.' : 'La evidencia favorece conservar los objetos actuales; no hay un reemplazo justificado.'))
      : (en ? 'There is not enough champion-specific evidence to modify the item set; keep it unchanged.' : 'No hay evidencia suficiente para este campeón como para cambiar los objetos; se conserva la build.'),
    conversionNote: conversions.applied.length
      ? (en ? 'Only documented stat conversions were calculated. Item passive activation is evaluated separately and is not inferred from converted stats.' : 'Solo se calcularon conversiones de estadísticas documentadas. La activación de pasivas se evalúa por separado y no se deduce de las estadísticas convertidas.')
      : (en ? 'No verified augment stat conversion is available for the selected augments.' : 'No hay una conversión de estadísticas verificada para los aumentos seleccionados.'),
    directives
  };
}

module.exports = { adaptMayhemBuild };
