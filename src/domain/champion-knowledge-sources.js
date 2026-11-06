'use strict';

function exactPatch(value) { const match = String(value || '').match(/^(\d+\.\d+\.\d+)/); return match?.[1] || ''; }

const MERAKI_SOURCE = Object.freeze({
  id: 'meraki-lolstaticdata',
  name: 'Meraki Analytics · lolstaticdata',
  url: 'https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json',
  repository: 'https://github.com/meraki-analytics/lolstaticdata',
  attribution: ['League of Legends Wiki', 'Meraki Analytics'],
  policy: 'cache-responsibly; attribute-upstream-and-meraki'
});

const COMMUNITY_DRAGON_SOURCE = Object.freeze({
  id: 'communitydragon',
  name: 'CommunityDragon',
  url: 'https://raw.communitydragon.org/latest/',
  docs: 'https://communitydragon.org/docs/assets',
  licenseStatus: 'game-data-license-unverified',
  usableForBundledKnowledge: false,
  reason: 'No license covering the extracted game-data dataset was identified; detailed champion records are BIN-derived and have no unified format.'
});

function extractVersion(value) {
  const match = String(value || '').match(/(?:^|\/)(\d+\.\d+\.\d+)(?:\/|$)/);
  return match?.[1] || '';
}

function merakiEffectsForChampion(champion = {}) {
  const abilities = champion.abilities || {};
  return ['P', 'Q', 'W', 'E', 'R'].flatMap(key => (Array.isArray(abilities[key]) ? abilities[key] : []).flatMap((entry, entryIndex) =>
    (entry.effects || []).map((effect, effectIndex) => ({ key, entryIndex, effectIndex, ...effect }))));
}

function normalizeMerakiChampion(payload, championId, { expectedPatch = '', fetchedAt = new Date().toISOString(), lastModified = '' } = {}) {
  const rows = Object.values(payload || {});
  const champion = rows.find(row => String(row?.key || '').toLowerCase() === String(championId).toLowerCase() || String(row?.id || '') === String(championId));
  if (!champion) return { source: MERAKI_SOURCE, championId: String(championId), status: 'champion-not-found', records: [], fetchedAt, lastModified };
  const sourceVersion = extractVersion(champion.icon) || extractVersion(champion.abilities?.Q?.[0]?.icon);
  const compatible = !!exactPatch(expectedPatch) && !!sourceVersion && exactPatch(expectedPatch) === exactPatch(sourceVersion);
  const records = merakiEffectsForChampion(champion).map(effect => ({
    championId: String(champion.key || championId), championNumericId: Number(champion.id) || null,
    abilityKey: effect.key, mechanicType: 'ability-effect', name: String(effect.name || ''),
    description: String(effect.description || ''), damageType: effect.damageType || null,
    spellEffects: effect.spellEffects ?? null, onHitEffects: effect.onHitEffects ?? null,
    leveling: Array.isArray(effect.leveling) ? effect.leveling.map(level => ({ ...level })) : [],
    sourcePatch: sourceVersion, source: MERAKI_SOURCE.id, sourceUrl: MERAKI_SOURCE.url,
    fetchedAt, lastModified, verificationStatus: compatible ? 'source-patch-compatible-community-data' : 'stale-or-unmatched-patch',
    verified: false,
    value: { damageType: effect.damageType || null, spellEffects: effect.spellEffects ?? null, onHitEffects: effect.onHitEffects ?? null }
  }));
  return { source: MERAKI_SOURCE, championId: String(champion.key || championId), championNumericId: Number(champion.id) || null,
    sourcePatch: sourceVersion, expectedPatch, fetchedAt, lastModified,
    status: compatible ? 'compatible-community-evidence-unverified' : 'stale-source', records };
}

function createCommunityDragonAdapter() {
  return Object.freeze({
    source: COMMUNITY_DRAGON_SOURCE,
    inspect() { return { status: 'blocked-license-unverified', usableForBundledKnowledge: false, source: COMMUNITY_DRAGON_SOURCE }; },
    normalize() { return { status: 'blocked-license-unverified', records: [], source: COMMUNITY_DRAGON_SOURCE }; }
  });
}

function mergeAbilityEvidence(officialProfile, communityProfiles = []) {
  const currentPatch = officialProfile?.version || '';
  const merged = [];
  for (const profile of communityProfiles) {
    for (const record of profile?.records || []) {
      if (profile.status !== 'compatible-community-evidence-unverified' || !record.sourcePatch || exactPatch(record.sourcePatch) !== exactPatch(currentPatch)) continue;
      merged.push({ ...record, verificationStatus: 'compatible-but-not-independently-verified', verified: false });
    }
  }
  return { officialSource: officialProfile?.provenance || null, supplementalRecords: merged,
    ignoredSources: communityProfiles.filter(profile => profile?.status !== 'compatible-community-evidence-unverified').map(profile => ({ source: profile.source?.id || 'unknown', status: profile.status, sourcePatch: profile.sourcePatch || '' })) };
}

module.exports = { MERAKI_SOURCE, COMMUNITY_DRAGON_SOURCE, extractVersion, exactPatch, normalizeMerakiChampion, createCommunityDragonAdapter, mergeAbilityEvidence };
