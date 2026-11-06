// Hand-authored synthetic inputs for exercising the build engine.
// These are not OP.GG records and contain no copied third-party statistics.
const patch = '16.22.1';

const profile = (id, itemIds, publishedCoreIds, style, extra = {}) => ({
  id,
  label: extra.label || id.replace(/-/g, ' '),
  label_es: extra.labelEs || id.replace(/-/g, ' '),
  style,
  itemIds,
  publishedCoreIds,
  source: 'Rift Companion synthetic test fixture',
  patch,
  reviewStatus: 'test-fixture',
  reasons: { es: 'Perfil sintético para probar rutas y alternativas.', en: 'Synthetic profile for testing routes and alternatives.' },
  tradeoffs: extra.tradeoffs || ['El perfil sintético no representa estadísticas reales.'],
  confidence: 'curated',
  ...extra
});

const champions = {
  Ahri: { patch, roles: { mid: [
    profile('standard', ['6655','3020','3157','3089','4645','3135'], ['6655','3020','3157'], 'ap_burst'),
    profile('anti-tank-frontline', ['6655','3020','3157','6653','4645','3135'], ['6655','3020','3157'], 'ap_burst', { when: ['durable-frontline'], reasons: { es: 'Liandry aporta daño sostenido y vida porcentual contra una primera línea resistente.', en: 'Liandry adds sustained percent-health damage into a durable frontline.' }, tradeoffs: ['Retrasa Rabadon para priorizar daño sostenido contra la primera línea.'] })
  ] } },
  Ryze: { patch, roles: { mid: [
    profile('standard', ['6657','3040','3020','3116','3089','3157'], ['6657','3040','3020'], 'mana_battlemage'),
    profile('mana-survival', ['6657','3040','3020','3110','3116','3157'], ['6657','3040','3020'], 'mana_battlemage', { when: ['physical-burst'], tradeoffs: ['La defensa física ocupa el espacio de una opción de poder ofensivo.'] })
  ] } },
  Cassiopeia: { patch, roles: { mid: [
    profile('standard', ['6657','3116','3040','3089','4645','3157'], ['6657','3116','3040'], 'ap_dps'),
    profile('anti-burst-magic', ['6657','3116','3040','3102','3157','4645'], ['6657','3116','3040'], 'ap_dps', { when: ['magic-burst'], tradeoffs: ['Banshee retrasa una compra ofensiva.'] })
  ] } },
  Azir: { patch, roles: { mid: [
    profile('standard', ['6655','3115','3020','3089','3157','4645'], ['6655','3115','3020'], 'ap_on_hit')
  ] } },
  Jinx: { patch, roles: { adc: [
    profile('standard', ['3031','3006','3085','3094','3072','3036'], ['3031','3006','3085'], 'crit_adc'),
    profile('anti-heal-crit', ['3031','3006','3085','3033','3094','3072'], ['3031','3006','3085'], 'crit_adc', { when: ['healing'], reasons: { es: 'Heridas Graves reduce las curaciones de Soraka mientras Jinx mantiene su daño de ataques.', en: 'Grievous Wounds reduces Soraka healing while Jinx keeps dealing attack damage.' }, tradeoffs: ['Heridas Graves retrasa Lord Dominik y parte de la penetración contra armadura.'], itemReasons: { '3033': { es: 'Contra curaciones: permite aplicar Heridas Graves con ataques.', en: 'Against healing: applies Grievous Wounds with attacks.' } }, itemTradeoffs: { '3033': { es: 'Retrasa Lord Dominik y su respuesta a armadura.', en: 'Delays Lord Dominik and its armor response.' } } })
  ] } },
  Kaisa: { patch, roles: { adc: [
    profile('standard', ['6672','3124','3006','3153','3115','3031'], ['6672','3124','3006'], 'hybrid_on_hit')
  ] } },
  Ornn: { patch, roles: { top: [
    profile('standard', ['3068','3075','3047','3065','2504','3110'], ['3068','3075','3047'], 'tank'),
    profile('tank-magic-resistance', ['3068','3075','3047','2504','3065','3110'], ['3068','3075','3047'], 'tank', { when: ['magic-burst'], tradeoffs: ['La resistencia mágica reemplaza una opción contra daño físico.'] })
  ] } },
  Soraka: { patch, roles: { support: [
    profile('standard', ['6617','3107','3158','3190','3504','3222'], ['6617','3107','3158'], 'enchanter'),
    profile('enchanter-protection', ['6617','3107','3158','3190','3504','3222'], ['6617','3107','3158'], 'enchanter', { when: ['physical-burst'], tradeoffs: ['El espacio defensivo de equipo retrasa una mejora de curación propia.'] })
  ] } }
};

const publishedCore = (championId, role) => {
  const row = champions[championId]?.roles?.[role]?.[0];
  if (!row) throw new Error(`No synthetic pilot fixture for ${championId}/${role}`);
  return {
    source: 'Synthetic published-source fixture',
    sourceQueried: true,
    queryContext: { championId, position: role },
    data: {
      champion: championId.toUpperCase(),
      position: role.toUpperCase(),
      patch: '16.22',
      summary: { average_stats: { play: 500, pick_rate: 12 } },
      core_items: [{ ids: row.publishedCoreIds, play: 500, pick_rate: 12 }]
    }
  };
};

module.exports = { patch, champions, publishedCore };
