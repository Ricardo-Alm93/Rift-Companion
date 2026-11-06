const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const purposes = require('../data/ranked/item-purposes-16.22.1.json');
const audit = require('../data/ranked/item-purpose-audit-16.22.1.json');
const itemData = require('../data/dragon/cdn/16.22.1/data/es_ES/item.json').data;
const { rankPublishedCoreCompletions } = require('../src/engine/published-core-completion');

test('R2 audit covers each purchasable Summoners Rift item and flags unreviewed purposes instead of guessing', () => {
  assert.equal(purposes.patch, '16.22.1');
  const eligible = Object.values(itemData).filter(item => item?.maps?.['11'] === true && item?.gold?.purchasable !== false && item?.inStore !== false && !item?.hideFromAll && !(item?.tags || []).some(tag => /Arena|ARAM|Trinket/.test(tag)));
  assert.equal(Object.keys(purposes.items).length, eligible.length);
  assert.equal(audit.eligibleItems, eligible.length);
  assert.ok(audit.counts['needs-editorial-review'] > 0, 'do not claim every item purpose was manually verified');
  for (const row of Object.values(purposes.items)) assert.ok(row.id && row.patch === purposes.patch && row.names.es && row.primaryFunction && Array.isArray(row.conditions) && Array.isArray(row.badSituations) && Array.isArray(row.archetypes) && Array.isArray(row.restrictions) && row.source.name === 'Data Dragon' && row.evidence);
});

test('R2 and R3 purpose overrides separate the requested item functions from secondary stats', () => {
  const p = id => purposes.items[id];
  assert.equal(p('1082').primaryFunction, 'snowball');
  assert.deepEqual(p('1082').situationalCategories, ['snowball']);
  assert.ok(!p('1082').situationalCategories.includes('survive-burst'));
  assert.equal(p('3041').primaryFunction, 'snowball-upgrade');
  assert.ok(p('3041').badSituations.includes('frequent-deaths'));
  assert.equal(p('3157').primaryFunction, 'active-stasis-defense');
  assert.ok(p('3157').evidence.includes('2.5 seconds'));
  assert.equal(p('3102').primaryFunction, 'spell-shield');
  assert.equal(p('3100').situationalCategories[0], 'basic-attacks-onhit');
  assert.equal(p('3165').situationalCategories[0], 'reduce-healing');
  assert.equal(p('6695').situationalCategories[0], 'reduce-shields');
  assert.equal(p('3115').situationalCategories[0], 'basic-attacks-onhit');
  assert.equal(p('3135').primaryFunction, 'percent-magic-penetration');
  assert.equal(p('3036').primaryFunction, 'percent-armor-penetration-and-health-damage');
});

test('R1 generates only jointly valid fourth-to-sixth slot plans and recomputes alternatives from valid combinations', () => {
  const catalog = Object.fromEntries(['core-a','core-b','core-c','d','e','f','g','h','i'].map(id => [id, { name: id }]));
  const data = {
    fourth_items: [{ ids: ['d'], play: 300, pick_rate: 0.4 }, { ids: ['e'], play: 200, pick_rate: 0.3 }],
    fifth_items: [{ ids: ['f'], play: 260, pick_rate: 0.35 }, { ids: ['g'], play: 190, pick_rate: 0.25 }],
    sixth_items: [{ ids: ['h'], play: 240, pick_rate: 0.32 }, { ids: ['i'], play: 180, pick_rate: 0.2 }]
  };
  const result = rankPublishedCoreCompletions({ coreIds: ['core-a','core-b','core-c'], published: data, itemCatalog: catalog, validate: ids => ({ valid: new Set(ids).size === 6 && !(ids.includes('d') && ids.includes('g')) }) });
  assert.ok(result.combinations.length > 0);
  assert.ok(result.combinations.every(combo => combo.itemIds.length === 6 && combo.validation.valid));
  assert.ok(!result.slots[0].items.some(item => item.itemId === 'd' && !result.combinations.some(combo => combo.slots[0].itemId === 'd')));
  assert.ok(result.slots.every((slot, index) => slot.position === index + 4 && slot.items.length <= 3));
  assert.deepEqual(rankPublishedCoreCompletions({ coreIds: ['core-a','core-b'], published: data, itemCatalog: catalog, validate: () => ({ valid: true }) }).combinations, []);
  assert.deepEqual(rankPublishedCoreCompletions({ coreIds: ['core-a','core-b','core-c'], published: { ...data, sixth_items: [] }, itemCatalog: catalog, validate: () => ({ valid: true }) }).combinations, []);
});

test('R4 shows stats and effects before education and keeps recipe/source in a safe collapsed detail', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '../src/item-tooltip.js'), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window });
  const html = window.renderItemTooltip({ name: 'Item', icon: 'icon.png', cost: 3200, locale: 'es-ES', stats: [{ type: 'magic', icon: '✦', value: '+100', label: 'Poder de habilidad' }], effects: [{ name: 'Pasiva · Hoja encantada', body: 'Inflige 20% de daño adicional.' }, { name: 'Activa · Estasis (2.5 s; 120 s de enfriamiento)', body: 'Te vuelves invulnerable e inalcanzable durante 2.5 segundos.' }], education: { fit: 'Compra la estasis antes contra burst físico confirmado.' }, metadata: { components: [{ id: '1', name: 'Componente', cost: 400, icon: 'component.png' }], combineCost: 2800, patch: '16.22.1', source: 'Data Dragon', purposeEvidence: 'Evidencia oficial' } });
  assert.ok(html.indexOf('Estadísticas base') < html.indexOf('POR QUÉ ENCAJA'));
  assert.ok(html.indexOf('Efectos') < html.indexOf('POR QUÉ ENCAJA'));
  assert.match(html,/Compra la estasis antes contra burst físico confirmado/);
  assert.doesNotMatch(html,/Qué aporta|Qué sacrificas|Por qué comprarlo/);
  assert.match(html, /<details class="item-recipe-details">/);
  assert.match(html, /Coste de combinación: 2800/);
  assert.match(html, /Precio: 3[.]?200/);
  assert.match(html, /Pasiva · Hoja encantada/);
  assert.match(html, /Activa · Estasis \(2\.5 s; 120 s de enfriamiento\)/);
  assert.match(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '), /Te vuelves invulnerable e inalcanzable durante 2\.5 segundos/);
  assert.doesNotMatch(html, /<mainText>|<attention>/);
});
