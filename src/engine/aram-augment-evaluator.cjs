'use strict';

const title = value => String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const localize = (value, en) => value && typeof value === 'object' ? value[en ? 'en' : 'es-MX'] || value.en || '' : String(value || '');

/** Qualitative evaluator: only exact, provenance-bearing rules can assert synergy. */
function evaluateAugments({ championId = '', headlinerId = '', selectedAugments = [], candidateAugments = [], evidence = {}, language = 'es' }) {
  const en = language === 'en';
  const rules = Array.isArray(evidence.interactions) ? evidence.interactions : [];
  const prior = new Set(selectedAugments.map(String));
  const candidates = [...new Set(candidateAugments.map(value => String(typeof value === 'object' ? value.slug || value.augmentId || value.id : value)))];
  return candidates.map(id => {
    const candidate = candidateAugments.find(value => String(typeof value === 'object' ? value.slug || value.augmentId || value.id : value) === id);
    const applicable = rules.filter(rule => rule.augmentId === id && (!rule.championIds || rule.championIds.includes(championId)));
    const paired = applicable.filter(rule => rule.withAugmentIds?.some(selectedId => prior.has(selectedId)));
    const single = applicable.filter(rule => !rule.withAugmentIds?.length);
    const selectedRule = paired[0] || single[0];
    const augmentName = localize(candidate?.name, en) || title(id);
    if (!selectedRule) return {
      id, name: augmentName, level: 'unknown', evidenceLevel: 'unknown', status: 'insufficient-evidence', headlinerInteraction: headlinerId ? (en ? 'No documented interaction between this Headliner and the augment is recorded.' : 'No hay una interacción documentada entre este Headliner y el aumento.') : '',
      what: localize(candidate?.effect, en) || localize(candidate?.description, en) || (en ? 'Effect details are not verified in the current local catalog.' : 'El efecto no está verificado en el catálogo local actual.'),
      patchChange: localize(candidate?.patchChange, en),
      championFit: en ? 'No reviewed champion-specific interaction is recorded.' : 'No hay una interacción revisada para este campeón.',
      combination: prior.size ? (en ? 'No verified interaction with your selected augments is recorded.' : 'No se conoce una interacción verificada con tus aumentos elegidos.') : (en ? 'No prior augment interaction to compare.' : 'No hay aumentos previos para comparar.'),
      buildStyle: en ? 'No build direction is inferred.' : 'No se infiere una orientación de build.',
      tradeoff: en ? 'Keep the current build until stronger evidence is available.' : 'Conserva la build actual mientras no haya evidencia suficiente.',
      reasons: [], tradeoffs: [en ? 'No verified or reviewed evidence is available for this champion and option.' : 'No hay evidencia verificada o revisada para este campeón y opción.'],
      provenance: { status: 'unknown', patch: evidence.patch || '', source: evidence.source || '' }
    };
    const confidence = selectedRule.confidence || 'medium';
    const level = selectedRule.evidenceLevel === 'documented' ? 'documented' : 'editorial-reviewed';
    const descriptions = en ? selectedRule.en : selectedRule.es;
    return {
      id, name: augmentName, level, evidenceLevel: level, status: 'evaluated', confidence, headlinerInteraction: headlinerId ? (en ? 'Headliner rules are recorded separately; no interaction is inferred here.' : 'Las reglas del Headliner se registran por separado; aquí no se infiere una interacción.') : '',
      what: descriptions?.what || candidate?.effect || candidate?.description || '',
      championFit: descriptions?.fit || '', combination: descriptions?.combination || '',
      buildStyle: descriptions?.style || '', tradeoff: descriptions?.tradeoff || '',
      reasons: [descriptions?.fit, descriptions?.combination].filter(Boolean),
      tradeoffs: descriptions?.tradeoff ? [descriptions.tradeoff] : [],
      buildDirective: selectedRule.buildDirective || { action: 'keep-current-build' },
      provenance: { status: level, confidence, patch: selectedRule.patch || evidence.patch || '', source: selectedRule.source || evidence.source || '', evidence: selectedRule.evidence || '' }
    };
  });
}

module.exports = { evaluateAugments };
