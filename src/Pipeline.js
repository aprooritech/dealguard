/**
 * Orchestrierung: Gmail → Extraktion → Regeln (+ KI) → Telegram → als gelesen markieren.
 *
 * Zustellgarantie „mindestens einmal, aber nicht doppelt“:
 * 1. Telegram-Versand muss gelingen, sonst bleibt die Mail ungelesen und wird im nächsten
 *    Lauf erneut versucht (max. MAX_DELIVERY_ATTEMPTS, danach Label + Alarm).
 * 2. Direkt nach erfolgreichem Versand wird die ID im StateStore gespeichert – erst dann
 *    wird die Mail als gelesen markiert. Scheitert Letzteres, gibt es trotzdem keinen Doppel-Push.
 * 3. KI-Fehler blockieren nie die Zustellung: dann gilt nur die Regelprüfung (Notbetrieb).
 */
const Pipeline = (() => {
  const MIN_TIME_PER_MESSAGE_MS = 75 * 1000;

  function runLlm(mail, rules, cfg, deadline) {
    if (!cfg.LLM_ENABLED) return { analysis: null, model: null, note: 'deaktiviert' };
    if (rules.level === 'HIGH' && cfg.LLM_SKIP_ON_HIGH_RULE_RISK) {
      return { analysis: null, model: null, note: 'nicht nötig (Regeln eindeutig)' };
    }
    const pause = OpenRouter.cooldown();
    if (pause) return { analysis: null, model: null, note: 'pausiert – ' + pause.reason };
    try {
      const res = OpenRouter.analyze(Prompt.build(mail, rules, cfg), deadline);
      return { analysis: res.analysis, model: res.model, note: '' };
    } catch (err) {
      Log.warn('KI-Analyse nicht verfügbar – nutze Regeln/Heuristik: ' + Log.errorMessage(err));
      if (err.fatal) Alerts.error('llm-' + (err.status || 'fatal'), 'KI-Analyse nicht verfügbar – bis auf Weiteres nur Regelprüfung', err);
      return { analysis: null, model: null, note: 'nicht erreichbar – nur Regelprüfung' };
    }
  }

  /**
   * Analysiert eine geparste Mail. Wirft nur bei Programmfehlern – KI-Probleme werden abgefangen.
   * @return {{fields: Object, risk: Object, reply: Object, llm: {used: boolean, model: ?string, note: string}}}
   */
  function analyze(mail, cfg, deadline) {
    const rules = RiskEngine.evaluate(mail.text, { allowedDomains: mail.allowedDomains });
    const llm = runLlm(mail, rules, cfg, deadline);
    const a = llm.analysis;
    const fields = a
      ? { intent: a.intent, summary: a.summary, offeredPrice: a.offeredPrice, logistics: a.logistics, logisticsDetails: a.logisticsDetails, paymentMethod: a.paymentMethod }
      : HeuristicAnalyzer.analyze(mail.text);
    const risk = RiskEngine.combine(rules, a);
    const reply = ReplyPolicy.decide({ mail: mail, risk: risk, fields: fields, cfg: cfg, llmReply: a ? a.replyDraft : null });
    return { fields: fields, risk: risk, reply: reply, llm: { used: Boolean(a), model: llm.model, note: llm.note } };
  }

  /**
   * Verarbeitet eine Mail als einfaches Objekt (siehe MailSource.toInput) und sendet die Benachrichtigung.
   * @param {{dryRun?: boolean}} opts  dryRun: als TEST markieren (Gmail bleibt unverändert)
   * @return {{status: string, mail: Object, result?: Object}}
   * @throws wenn die Telegram-Zustellung scheitert
   */
  function handleInput(input, cfg, deadline, opts) {
    const mail = MessageParser.parse(input, cfg);
    if (mail.skipReason && !(opts && opts.dryRun)) {
      Log.info('Übersprungen (' + mail.id + '): ' + mail.skipReason);
      return { status: 'skipped', mail: mail };
    }
    const result = analyze(mail, cfg, deadline);
    const notification = NotificationFormatter.format(mail, result, {
      test: Boolean(opts && opts.dryRun),
      silent: cfg.TELEGRAM_SILENT_LOW_RISK && result.risk.level === 'LOW'
    });
    Telegram.sendMessage(notification);
    Log.info('Benachrichtigt (' + mail.id + '): Risiko ' + result.risk.level + ', Absicht ' + result.fields.intent +
      ', KI ' + (result.llm.used ? OpenRouter.shortModel(result.llm.model) : result.llm.note));
    return { status: 'sent', mail: mail, result: result };
  }

  function handle(item, cfg, deadline, opts) {
    return handleInput(MailSource.toInput(item), cfg, deadline, opts);
  }

  /** Nacharbeiten nach erfolgreichem Versand – Fehler hier sind nicht kritisch. */
  function finalize(item, outcome, cfg) {
    try {
      MailSource.markProcessed(item, cfg);
    } catch (err) {
      Log.warn('Konnte Mail nicht als gelesen markieren: ' + Log.errorMessage(err));
    }
    if (cfg.CREATE_GMAIL_DRAFTS && outcome.result.risk.level !== 'HIGH') {
      try {
        MailSource.createDraftReply(item, outcome.result.reply.text);
      } catch (err) {
        Log.warn('Gmail-Entwurf konnte nicht erstellt werden: ' + Log.errorMessage(err));
      }
    }
  }

  function recordFailure(item, id, err, state, cfg) {
    const attempts = state.incrementAttempts(id);
    Log.error('Zustellung fehlgeschlagen (' + id + ', Versuch ' + attempts + '/' + cfg.MAX_DELIVERY_ATTEMPTS + '): ' + Log.errorMessage(err));
    if (attempts < cfg.MAX_DELIVERY_ATTEMPTS) return;
    state.markDone(id);
    state.clearAttempts(id);
    try {
      MailSource.markFailed(item, cfg);
    } catch (e) {
      Log.warn('Fehler-Label konnte nicht gesetzt werden: ' + Log.errorMessage(e));
    }
    Alerts.error('giveup-' + id, 'Mail nach ' + attempts + ' Versuchen aufgegeben (Gmail-Label „' + cfg.FAILED_LABEL + '“)', err);
  }

  /**
   * Ein kompletter Lauf (vom Trigger aufgerufen).
   * @return {{candidates: number, sent: number, skipped: number, failed: number, deferred: number}}
   * @throws bei fatalen Fehlern (Konfiguration, Telegram-Zugang) – der Lauf wird dann abgebrochen
   */
  function run() {
    const cfg = Config.load();
    const deadline = Deadline.create(cfg.MAX_RUNTIME_SECONDS * 1000);
    const state = StateStore.load();
    const items = MailSource.findCandidates(cfg, state);
    const stats = { candidates: items.length, sent: 0, skipped: 0, failed: 0, deferred: 0 };

    for (let i = 0; i < items.length; i++) {
      if (stats.sent + stats.failed >= cfg.MAX_MESSAGES_PER_RUN || !deadline.hasAtLeast(MIN_TIME_PER_MESSAGE_MS)) {
        stats.deferred = items.length - i;
        Log.info(stats.deferred + ' Mail(s) auf den nächsten Lauf verschoben.');
        break;
      }
      const item = items[i];
      const id = item.message.getId();

      let outcome;
      try {
        outcome = handle(item, cfg, deadline, { dryRun: false });
      } catch (err) {
        if (err && err.fatal) {
          state.save();
          throw err;
        }
        stats.failed++;
        recordFailure(item, id, err, state, cfg);
        state.save();
        continue;
      }

      state.markDone(id);
      state.clearAttempts(id);
      state.save();
      if (outcome.status === 'skipped') {
        stats.skipped++;
        continue;
      }
      stats.sent++;
      finalize(item, outcome, cfg);
    }
    return stats;
  }

  return { run, analyze, handle, handleInput };
})();
