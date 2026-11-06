'use strict';

const BLOCK_TYPES = ['Inicio', 'Núcleo', 'Componentes', 'Opciones situacionales'];
const { resolveItemAcquisition } = require('../engine/ranked/item-transformation');

function createItemSet({ champion, title, mode = 'ranked', blocks, itemCatalog, championId, exclusiveGroups = null, patch = '' }) {
  if (!championId || !/^[A-Za-z0-9_-]{1,32}$/.test(String(championId))) throw new Error('Campeón inválido para Item Set');
  if (!Array.isArray(blocks) || blocks.length !== 4) throw new Error('Se requieren los bloques Inicio, Núcleo, Componentes y Opciones situacionales');
  const normalized = blocks.map((block, index) => {
    const ids = Array.isArray(block?.items) ? block.items : [];
    if (ids.length > 24) throw new Error('Cada bloque admite hasta 24 objetos');
    const items = ids.map(value => {
      const id = String(value?.id ?? value);
      const item = itemCatalog[id];
      const mapId = mode === 'aram' ? '12' : '11';
      const transformationCatalog = Object.fromEntries(Object.entries(itemCatalog || {}).map(([itemId, row]) => [itemId, { id: itemId, purchasable: row?.gold?.purchasable !== false, inStore: row?.inStore !== false, maps: row?.maps || {}, from: (row?.from || []).map(String) }]));
      const acquisition = resolveItemAcquisition(id, transformationCatalog, exclusiveGroups, { patch, mapId });
      const transformedFinal = acquisition.valid && acquisition.transformationPath.length > 0;
      if (!item || (item.gold?.purchasable === false && !transformedFinal) || item.maps?.[mapId] !== true) throw new Error(`Objeto no válido para este modo: ${id}`);
      const count = Number(value?.count ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error(`Cantidad inválida para el objeto ${id}`);
      return { id, count };
    });
    return { type: BLOCK_TYPES[index], recMath: true, minSummonerLevel: -1, maxSummonerLevel: -1, showIfSummonerSpell: '', hideIfSummonerSpell: '', items };
  });
  const championName = String(champion || 'Campeón').slice(0, 48);
  return {
    title: String(title || `Rift Companion · ${championName}`).slice(0, 100),
    type: 'custom', map: mode === 'aram' ? 'HA' : 'SR', mode: mode === 'aram' ? 'ARAM' : 'CLASSIC',
    associatedMaps: [mode === 'aram' ? 12 : 11], associatedChampions: [String(championId)],
    priority: false, sortrank: 0, blocks: normalized
  };
}

function importItemSet(value, itemCatalog, mapId = '11') {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.blocks)) throw new Error('El archivo no tiene un Item Set compatible');
  const blocks = parsed.blocks.map(block => {
    if (!block || typeof block.type !== 'string' || !Array.isArray(block.items)) throw new Error('Bloque de Item Set inválido');
    return { type: block.type.slice(0, 60), items: block.items.slice(0, 24).map(entry => {
      const id = String(entry?.id || ''), item = itemCatalog[id];
      if (!item || item.maps?.[String(mapId)] !== true) throw new Error(`El objeto ${id || '(vacío)'} no existe en el catálogo actual`);
      return { id, count: Math.max(1, Math.min(6, Number(entry.count) || 1)) };
    }) };
  });
  return { title: String(parsed.title || 'Item Set importado').slice(0, 100), championId: String(parsed.associatedChampions?.[0] || ''), blocks };
}

module.exports = { BLOCK_TYPES, createItemSet, importItemSet };
