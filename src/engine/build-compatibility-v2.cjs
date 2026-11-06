'use strict';

const normalized = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const list = value => Array.isArray(value) ? value : [];
function closesConversionCycle(from, to, edges) {
  const graph = new Map();
  for (const edge of edges) graph.set(edge.from, [...(graph.get(edge.from) || []), edge.to]);
  const pending = [to], seen = new Set();
  while (pending.length) {
    const node = pending.pop();
    if (node === from) return true;
    if (seen.has(node)) continue;
    seen.add(node); pending.push(...(graph.get(node) || []));
  }
  return false;
}

/** Resolve only patch-scoped, source-backed conversions. Activation predicates remain unchanged. */
function resolveAugmentStatConversions({ stats = {}, selectedAugments = [], conversionRules = [], patch = '' } = {}) {
  const values = { ...stats }, selected = new Set(selectedAugments.map(String)), applied = [], consumed = new Set();
  const pending = conversionRules.filter(rule => selected.has(String(rule.augmentId)) && rule.verified === true && rule.source && String(rule.patch) === String(patch));
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const rule = pending[index], from = normalized(rule.from), to = normalized(rule.to);
      if (!from || !to || from === to || consumed.has(from) || closesConversionCycle(from, to, applied) || !Number.isFinite(Number(rule.ratio)) || Number(rule.ratio) <= 0) { pending.splice(index, 1); continue; }
      if (!Object.hasOwn(values, from)) continue;
      const amount = Number(values[from]);
      values[to] = (Number(values[to]) || 0) + amount * Number(rule.ratio);
      delete values[from]; consumed.add(from);
      applied.push({ augmentId: String(rule.augmentId), from, to, ratio: Number(rule.ratio), source: rule.source, patch: rule.patch });
      pending.splice(index, 1); progressed = true;
    }
  }
  return { stats: values, applied, unresolved: pending.map(row => String(row.augmentId)), status: applied.length ? 'documented-conversion-applied' : 'no-verified-conversion' };
}

function resourceOf(champion, mechanics) {
  const raw = String(mechanics?.resource || champion?.partype || '').toLowerCase();
  if (/energy|energ[ií]a/.test(raw)) return 'energy';
  if (/mana|man[aá]/.test(raw)) return 'mana';
  if (!raw || /none|no resource|sin recurso/.test(raw)) return 'none';
  return 'other';
}

function evaluateBuildCompatibility({ itemIds = [], itemCatalog = {}, champion = {}, mechanics = null, activationRules = { rules: [] }, mode = 'ranked', selectedAugments = [], conversionRules = [], patch = '', language = 'es' } = {}) {
  const en = language === 'en', resource = resourceOf(champion, mechanics);
  const supportedEffects = new Set(list(mechanics?.abilityFacts).flatMap(fact => list(fact.effects)));
  const canHealOrShieldAlly = supportedEffects.has('healing') || supportedEffects.has('shielding') || list(mechanics?.reviewedMechanics).some(row => row.verified === true && ['ally-heal', 'ally-shield'].includes(row.mechanic));
  const conversion = mode === 'aram-mayhem' ? resolveAugmentStatConversions({ stats: mechanics?.baseStats || {}, selectedAugments, conversionRules, patch }) : { stats: {}, applied: [], status: 'not-applicable' };
  const rows = itemIds.map(String).map(itemId => {
    const item = itemCatalog[itemId], tags = new Set(list(item?.tags).map(normalized));
    const issues = [], supported = [], lostStats = [];
    if (!item) issues.push({ code: 'item-missing-from-catalog', itemId });
    if (tags.has('mana') || tags.has('manaregen')) {
      if (resource === 'energy' || resource === 'none') lostStats.push({ stat: 'mana', reason: en ? 'Champion does not use mana.' : 'El campeón no utiliza maná.' });
      else supported.push('mana-resource');
    }
    const rules = list(activationRules.rules).filter(rule => String(rule.itemId) === itemId);
    for (const rule of rules) {
      for (const requirement of list(rule.requires)) {
        if (requirement === 'mana-resource' && resource !== 'mana') issues.push({ code: 'activation-requires-mana', itemId, ruleId: rule.id, reason: rule.reason?.[en ? 'en' : 'es'] || '' });
        if (requirement === 'ally-heal-or-shield' && !canHealOrShieldAlly) issues.push({ code: 'activation-requires-ally-heal-or-shield', itemId, ruleId: rule.id, reason: rule.reason?.[en ? 'en' : 'es'] || '' });
        if (requirement === 'verified-augment-conversion' && !conversion.applied.length) issues.push({ code: 'missing-verified-augment-conversion', itemId, ruleId: rule.id });
        else if (requirement === 'ally-heal-or-shield' && canHealOrShieldAlly || requirement === 'mana-resource' && resource === 'mana') supported.push(`${rule.id}:activation`);
      }
    }
    const severity = issues.length ? 'ineligible' : lostStats.length ? 'reduced-stat-fit' : 'eligible';
    return { itemId, severity, eligible: !issues.length, issues, supported, lostStats, evidence: { resource, source: mechanics?.provenance?.[0]?.source || 'Data Dragon champion resource/abilities', patch: mechanics?.patch || patch, mode, conversions: conversion.applied } };
  });
  return { status: rows.some(row => !row.eligible) ? 'contains-mechanically-ineligible-items' : rows.some(row => row.lostStats.length) ? 'some-item-stats-not-used' : 'mechanical-check-passed', mode, resource, rows, rejectedItemIds: rows.filter(row => !row.eligible).map(row => row.itemId), conversion };
}

module.exports = { evaluateBuildCompatibility, resolveAugmentStatConversions, resourceOf };
