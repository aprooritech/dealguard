/**
 * Risiko-Bewertung.
 *
 * evaluate(): wendet den Regelkatalog (ScamRules) deterministisch auf den Nachrichtentext an.
 * combine():  verbindet Regel- und KI-Ergebnis nach dem Prinzip „die KI darf eskalieren,
 *             aber nie entwarnen“. Ein Betrüger kann das LLM per Prompt-Injection beeinflussen –
 *             die Regeln nicht. Deshalb gilt immer die höhere der beiden Stufen.
 */
const RiskEngine = (() => {
  const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 };

  function maxLevel(a, b) {
    return RANK[b] > RANK[a] ? b : a;
  }

  /**
   * Echte Marken-Domains (paypal.com, dhl.de) sind kein Lookalike; alles andere,
   * das einen Markennamen enthält, schon – auch mit Homoglyphen oder 0/1 statt o/l.
   */
  function isLookalike(host, allowedDomains) {
    if (!host || TextUtils.hostMatches(host, allowedDomains)) return false;
    const folded = TextUtils.normalize(host).replace(/0/g, 'o').replace(/1/g, 'l');
    const tokens = folded.split(/[.\-_]/);
    const labels = host.split('.');
    const registrableBase = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    return ScamRules.LOOKALIKE_BRANDS.some(brand => {
      const hit = brand.length >= 5 ? folded.indexOf(brand) !== -1 : tokens.indexOf(brand) !== -1;
      return hit && registrableBase !== brand;
    });
  }

  function buildContext(text, allowedDomains) {
    const allowed = allowedDomains || [];
    const urls = TextUtils.extractUrls(text).map(u => ({
      url: u.url,
      host: u.host,
      allowed: TextUtils.hostMatches(u.host, allowed),
      shortener: ScamRules.URL_SHORTENERS.indexOf(u.host) !== -1,
      lookalike: isLookalike(u.host, allowed)
    }));
    return {
      norm: TextUtils.normalize(text),
      squashed: TextUtils.squash(text),
      urls: urls,
      phones: TextUtils.extractPhones(text),
      emails: TextUtils.extractEmails(text).filter(e => !TextUtils.hostMatches(e.split('@')[1], allowed))
    };
  }

  function matchRule(rule, ctx) {
    if (rule.detect) {
      const evidence = rule.detect(ctx);
      return { matched: Boolean(evidence), evidence: typeof evidence === 'string' ? evidence : null };
    }
    let sawAny = false;
    const patterns = rule.patterns || [];
    for (let i = 0; i < patterns.length; i++) {
      const re = new RegExp(patterns[i].source, 'g');
      let m;
      while ((m = re.exec(ctx.norm)) !== null) {
        sawAny = true;
        if (!rule.negatable || !TextUtils.isNegatedAt(ctx.norm, m.index)) return { matched: true, evidence: null };
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    if (!sawAny && rule.squashed && rule.squashed.some(k => ctx.squashed.indexOf(k) !== -1)) {
      return { matched: true, evidence: null };
    }
    return { matched: false, evidence: null };
  }

  /**
   * @param {string} text  extrahierter Nachrichtentext
   * @param {{allowedDomains?: string[]}=} options
   * @return {{level: string, score: number, critical: boolean,
   *           findings: {id: string, label: string, weight: number, critical: boolean, evidence: ?string}[]}}
   */
  function evaluate(text, options) {
    const ctx = buildContext(text, (options || {}).allowedDomains);
    const findings = [];
    ScamRules.RULES.forEach(rule => {
      const r = matchRule(rule, ctx);
      if (r.matched) {
        findings.push({ id: rule.id, label: rule.label, weight: rule.weight, critical: Boolean(rule.critical), evidence: r.evidence });
      }
    });
    const hitIds = findings.map(f => f.id);
    ScamRules.COMBOS.forEach(combo => {
      const all = combo.requires.every(group => group.some(id => hitIds.indexOf(id) !== -1));
      if (all) findings.push({ id: combo.id, label: combo.label, weight: combo.bonus, critical: Boolean(combo.critical), evidence: null });
    });

    const score = Math.min(100, findings.reduce((sum, f) => sum + f.weight, 0));
    const critical = findings.some(f => f.critical);
    let level = 'LOW';
    if (critical || score >= ScamRules.HIGH_THRESHOLD) level = 'HIGH';
    else if (score >= ScamRules.MEDIUM_THRESHOLD) level = 'MEDIUM';
    // Anzeige-Reihenfolge: kritische Funde, dann erkannte Maschen (Kombinationen), dann nach Gewicht
    const isCombo = f => (f.id.indexOf('COMBO_') === 0 ? 1 : 0);
    findings.sort((a, b) => (Number(b.critical) - Number(a.critical)) || (isCombo(b) - isCombo(a)) || (b.weight - a.weight));
    return { level: level, score: score, critical: critical, findings: findings };
  }

  /**
   * @param {{level: string, score: number, critical: boolean, findings: Array}} rules  Ergebnis von evaluate()
   * @param {?{scamRisk: ?string, scamIndicators: string[]}} llm  normalisierte KI-Analyse oder null
   */
  function combine(rules, llm) {
    const llmLevel = llm && Object.prototype.hasOwnProperty.call(RANK, llm.scamRisk) ? llm.scamRisk : null;
    return {
      level: llmLevel ? maxLevel(rules.level, llmLevel) : rules.level,
      score: rules.score,
      critical: rules.critical,
      ruleLevel: rules.level,
      llmLevel: llmLevel,
      escalatedByLlm: Boolean(llmLevel) && RANK[llmLevel] > RANK[rules.level],
      findings: rules.findings,
      llmIndicators: llm && llm.scamIndicators ? llm.scamIndicators.slice(0, 5) : []
    };
  }

  return { RANK, evaluate, combine, maxLevel, isLookalike };
})();
