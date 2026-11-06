const test = require('node:test');
const assert = require('node:assert/strict');
const { knowledgeFor, editorialStatFit } = require('../src/engine/champion-knowledge-v3.cjs');

test('V3 starter knowledge keeps all pilot roles editorial and never statistical', () => {
  for (const [id, role] of [['Poppy','top'],['Ahri','mid'],['Zed','mid'],['Soraka','support'],['Jinx','adc']]) {
    const profile = knowledgeFor(id, role);
    assert.ok(profile, id);
    assert.equal(profile.provenance.status, 'editorial-unverified');
    assert.equal(profile.provenance.statisticalEvidence, false);
  }
  assert.equal(knowledgeFor('UnknownChampion','mid'), null);
});

test('V3 stat preference favors useful damage but does not manufacture missing stats', () => {
  const zed = knowledgeFor('Zed', 'mid');
  assert.ok(editorialStatFit({stats:{FlatPhysicalDamageMod:60}},zed).score > editorialStatFit({stats:{FlatMagicDamageMod:60}},zed).score);
  assert.equal(editorialStatFit({},zed).score,0);
  assert.equal(editorialStatFit({stats:{FlatPhysicalDamageMod:60}},null).status,'unknown');
});
