'use strict';

function line(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), micro: match[3] == null ? null : Number(match[3]), raw: String(value).trim() } : null;
}

function gameLineForDataDragon(value) {
  const parsed = line(value);
  if (!parsed) return null;
  // Riot shifted the public League patch major to 26 while Data Dragon's
  // content versions kept the 16.x line. Use this only as a candidate mapping;
  // exact relations, when available, are authoritative.
  if (parsed.major === 16) return `26.${parsed.minor}`;
  return `${parsed.major}.${parsed.minor}`;
}

function gameLineForStatistics(value, relations = []) {
  const source = line(value);
  if (!source) return null;
  const exact = relations.find(row => line(row.statisticsPatch)?.raw === source.raw);
  if (exact) return line(exact.publishedGamePatch) ? `${line(exact.publishedGamePatch).major}.${line(exact.publishedGamePatch).minor}` : null;
  if (source.major === 16) return `26.${source.minor}`;
  return `${source.major}.${source.minor}`;
}

function comparePatchVersions({ publishedGamePatch = '', dataDragonVersion = '', statisticsPatch = '', regionalServerVersion = '', relations = [] } = {}) {
  const relation = relations.find(row => String(row.dataDragonVersion) === String(dataDragonVersion));
  const publishedLine = line(publishedGamePatch) ? `${line(publishedGamePatch).major}.${line(publishedGamePatch).minor}` : '';
  const dataDragonGameLine = relation?.publishedGamePatch || gameLineForDataDragon(dataDragonVersion) || '';
  const statsGameLine = gameLineForStatistics(statisticsPatch, relations) || '';
  const regionalLine = gameLineForStatistics(regionalServerVersion, relations) || '';
  const compatible = (left, right) => left && right ? left === right : null;
  const dataDragonMatchesPublished = compatible(publishedLine, dataDragonGameLine);
  const statsMatchesPublished = compatible(publishedLine, statsGameLine);
  const regionalMatchesPublished = compatible(regionalLine, publishedLine);
  const statuses = [dataDragonMatchesPublished, statsMatchesPublished, regionalMatchesPublished].filter(value => value !== null);
  const status = statuses.some(value => value === false) ? 'mismatch' : statuses.length ? 'compatible' : 'unverified';
  return {
    status,
    publishedGamePatch: publishedLine || null,
    dataDragonVersion: String(dataDragonVersion || '') || null,
    dataDragonGameLine,
    statisticsPatch: String(statisticsPatch || '') || null,
    statisticsGameLine: statsGameLine || null,
    regionalServerVersion: String(regionalServerVersion || '') || null,
    regionalGameLine: regionalLine || null,
    comparisons: {
      dataDragonMatchesPublished,
      statisticsMatchesPublished: statsMatchesPublished,
      regionalMatchesPublished: regionalMatchesPublished
    },
    relationStatus: relation?.status || 'derived-line-mapping',
    source: relation?.sources || []
  };
}

module.exports = { line, gameLineForDataDragon, gameLineForStatistics, comparePatchVersions };
