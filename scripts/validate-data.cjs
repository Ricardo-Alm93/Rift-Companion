const fs = require('node:fs');
const root = 'data/dragon/cdn';
const versionList = JSON.parse(fs.readFileSync('data/dragon/api/versions.json', 'utf8'));
const version = versionList[0] || fs.readdirSync(root).filter(x => /^\d/.test(x)).sort().at(-1);
const directory = `${root}/${version}/data/en_US`;
const items = JSON.parse(fs.readFileSync(`${directory}/item.json`, 'utf8')).data;
const champions = JSON.parse(fs.readFileSync(`${directory}/champion.json`, 'utf8')).data;
const profiles = JSON.parse(fs.readFileSync('data/champion-build-profiles.json', 'utf8'));
const threats = JSON.parse(fs.readFileSync('data/champion-threat-profiles.json', 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync('data/item-taxonomy.json', 'utf8')).overrides;
const itemGroups = JSON.parse(fs.readFileSync(`data/ranked/item-groups-${version}.json`, 'utf8'));
const roleSeed = JSON.parse(fs.readFileSync('data/ranked/champion-role-seed-16.21.1.json', 'utf8'));
const pilotProfilesPath = 'data/ranked/pilot-build-profiles-16.22.1.json';
const pilotProfiles = fs.existsSync(pilotProfilesPath) ? JSON.parse(fs.readFileSync(pilotProfilesPath, 'utf8')) : null;
const { buildItemCatalog, validateBuildItems } = require('../src/engine/item-eligibility');
const { catalog: championItemInteractions, validateInteractionCatalog } = require('../src/engine/champion-item-interaction-catalog');
const itemCatalog = buildItemCatalog({ itemData: items, taxonomy: { overrides: taxonomy }, patch: version, exclusiveGroups: itemGroups });
const errors = [], warnings = [];
let profileCount = 0, optionCount = 0, staleProfileCount = 0, seedRoleCount = 0;
errors.push(...validateInteractionCatalog(championItemInteractions).map(error => `Champion-item evidence catalog: ${error}`));
if (championItemInteractions.patch !== version) errors.push(`Champion-item evidence patch ${championItemInteractions.patch} does not match Data Dragon ${version}`);
for (const row of championItemInteractions.interactions || []) {
  if (!champions[row.championId]) errors.push(`Unknown interaction champion ${row.id}/${row.championId}`);
  for (const id of row.itemIds || []) if (!items[String(id)] || items[String(id)].maps?.['11'] !== true) errors.push(`Interaction references unavailable Ranked item ${row.id}/${id}`);
}
for (const row of championItemInteractions.buildReviews || []) {
  if (!pilotProfiles) { warnings.push('OP.GG-derived pilot profiles are not bundled; exact profile/build-review parity was not checked.'); break; }
  const profile = pilotProfiles.champions?.[row.championId]?.roles?.[row.role]?.find(option => option.id === row.buildId);
  if (!profile || JSON.stringify(profile.itemIds.map(String)) !== JSON.stringify(row.itemIds.map(String))) errors.push(`Strategic review does not exactly match build profile ${row.championId}/${row.buildId}`);
}
if (itemGroups.patch !== version || itemGroups.mapId !== '11' || itemGroups.status !== 'verified') errors.push(`Ranked exclusive groups are not verified for Data Dragon ${version}`);
for (const [groupId, ids] of Object.entries(itemGroups.groups || {})) for (const id of ids) {
  if (!items[id] || items[id].maps?.['11'] !== true) errors.push(`Invalid Ranked group member ${groupId}/${id}`);
}
for (const [championId, seedChampion] of Object.entries(roleSeed.champions || {})) {
  if (!champions[championId]) errors.push(`Unknown editorial seed champion ${championId}`);
  for (const profile of seedChampion.candidateProfiles || []) {
    seedRoleCount++;
    if (profile.reviewStatus !== 'EDITORIAL_SEED_REQUIRES_VERIFICATION') errors.push(`Seed role not marked editorial ${championId}/${profile.role}`);
  }
  if (Array.isArray(seedChampion.statisticalBuilds) && seedChampion.statisticalBuilds.length) errors.push(`Seed contains unverified statistical builds ${championId}`);
}
for (const [championId, profile] of Object.entries(profiles.champions || {})) {
  if (!champions[championId]) errors.push(`Unknown build-profile champion ${championId}`);
  profileCount++;
  if (!profile.source || !profile.patch || !Array.isArray(profile.archetypes)) errors.push(`Missing profile metadata ${championId}`);
  if (profile.patch !== version) staleProfileCount++;
  for (const [role, options] of Object.entries(profile.roles || {})) {
    if (!['top', 'jungle', 'mid', 'adc', 'support'].includes(role)) errors.push(`Unknown role ${championId}/${role}`);
    const signatures = new Set();
    for (const option of options || []) {
      optionCount++;
      const ids = (option.itemIds || option.items || []).map(String);
      if (ids.length !== 6 || new Set(ids).size !== 6) errors.push(`Invalid six item slots ${championId}/${option.id}`);
      for (const id of ids) if (!items[id] || items[id].maps?.['11'] !== true || items[id].gold?.purchasable === false) errors.push(`Unavailable ranked item ${championId}/${option.id}/${id}`);
      const strict = validateBuildItems(ids, itemCatalog, { patch: version, exclusiveGroups: itemGroups, championId, role });
      if (!strict.valid) errors.push(`Hard-rule rejection ${championId}/${role}/${option.id}: ${strict.errors.join(',')}`);
      if (option.mode && option.mode !== 'ranked') errors.push(`Non-Ranked profile mixed into build profiles ${championId}/${option.id}/${option.mode}`);
      const signature = [...ids].sort().join('|');
      if (signatures.has(signature)) errors.push(`Duplicate item set ${championId}/${option.id}`);
      signatures.add(signature);
      if (!option.id || !option.label || !option.label_es || !option.source || !option.confidence) errors.push(`Missing option provenance ${championId}/${option.id}`);
    }
  }
}
for (const [championId, row] of Object.entries(threats.champions || {})) {
  if (!champions[championId]) errors.push(`Unknown threat-profile champion ${championId}`);
  if (!Array.isArray(row.tags) || !row.tags.length || !row.source) errors.push(`Invalid threat profile ${championId}`);
}
for (const id of Object.keys(taxonomy)) if (!items[id]) warnings.push(`Taxonomy ID not present in bundled version: ${id}`);
console.log(JSON.stringify({ dataDragonVersion: version, exclusiveGroupsStatus: itemGroups.status, exclusiveGroupCount: Object.keys(itemGroups.groups || {}).length, buildProfiles: profileCount, buildOptions: optionCount, hardValidatedOptions: optionCount - errors.filter(x => x.startsWith('Hard-rule rejection')).length, staleEditorialProfiles: staleProfileCount, championItemInteractions: championItemInteractions.interactions?.length || 0, strategicBuildReviews: championItemInteractions.buildReviews?.length || 0, threatProfiles: Object.keys(threats.champions || {}).length, editorialSeedChampions: Object.keys(roleSeed.champions || {}).length, editorialSeedRoles: seedRoleCount, taxonomyRecords: Object.keys(taxonomy).length, errors, warnings }, null, 2));
if (errors.length) process.exitCode = 1;
