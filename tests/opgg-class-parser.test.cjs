const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOpggClassRepr } = require('../src/provider-core.cjs');

test('OP.GG subset class schema maps requested fields instead of the full Data shape', () => {
  const response = [
    'class LolGetChampionAnalysis: champion,position,data',
    'class Data: core_items,boots,starter_items,trends',
    'class CoreItems: ids,ids_names,play,win,pick_rate',
    'class Trends: win',
    'class Win: version,rate,rank,created_at',
    'LolGetChampionAnalysis("AHRI","MID",Data(CoreItems([3118,4645,3157],["Malignance","Shadowflame","Zhonya\'s Hourglass"],445,249,0.15),CoreItems([3020],["Sorcerer\'s Shoes"],2886,1480,0.58),CoreItems([1056,2003,2003],["Doran\'s Ring","Health Potion","Health Potion"],5080,2588,0.99),Trends(Win("16.22",0.51,17,"2026-11-04T00:12:32+09:00"))))'
  ].join('\n');
  const parsed = parseOpggClassRepr(response);
  assert.equal(parsed.champion, 'AHRI');
  assert.deepEqual(parsed.data.core_items.ids, [3118, 4645, 3157]);
  assert.deepEqual(parsed.data.boots.ids, [3020]);
  assert.deepEqual(parsed.data.starter_items.ids, [1056, 2003, 2003]);
  assert.equal(parsed.data.trends.win.version, '16.22');
});
