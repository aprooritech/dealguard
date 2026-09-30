/**
 * Einstiegspunkte – im Apps-Script-Editor oben unter „Ausführen“ auswählbar.
 * Hilfsfunktionen mit „_“ am Ende sind dort ausgeblendet.
 *
 *   setup()                   Konfiguration prüfen, Verbindungen testen, Trigger installieren
 *   processInbox()            Trigger-Handler (läuft automatisch alle TRIGGER_MINUTES Minuten)
 *   showTelegramChatId()      zeigt die Chat-ID, nachdem du dem Bot geschrieben hast
 *   sendSampleNotifications() schickt drei Beispiel-Analysen an Telegram (ohne Gmail)
 *   debugLatestMail()         zeigt Rohtext, extrahierten Text und Regel-Treffer der neuesten Mail
 *   testLatestMail()          komplette Analyse der neuesten Mail als TEST-Push (Gmail bleibt unverändert)
 *   listFreeModels()          aktuell kostenlose OpenRouter-Modelle
 *   resetState()              vergisst verarbeitete IDs und hebt eine KI-Pause auf
 *   uninstall()               entfernt den Trigger
 */

function processInbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    Log.info('Vorheriger Lauf ist noch aktiv – übersprungen.');
    return null;
  }
  try {
    Config.load();
    const stats = Pipeline.run();
    if (stats.candidates) Log.info('Lauf beendet: ' + JSON.stringify(stats));
    return stats;
  } catch (err) {
    if (err && err.fatal) {
      // Telegram/Konfiguration kaputt → Alarm per Telegram unmöglich. Weiterwerfen, damit
      // Google die fehlgeschlagene Trigger-Ausführung per E-Mail meldet.
      Log.error('Abbruch wegen Konfigurationsfehler: ' + Log.errorMessage(err));
      throw err;
    }
    Alerts.error('run', 'Verarbeitung abgebrochen', err);
    return null;
  } finally {
    lock.releaseLock();
  }
}

function setup() {
  Config.reset();
  const cfg = Config.load();
  const problems = Config.validate();
  if (problems.length) throw new Error('Konfiguration unvollständig:\n• ' + problems.join('\n• '));

  const bot = Telegram.getMe();
  Log.info('✔ Telegram-Bot erreichbar: @' + bot.username);

  if (cfg.LLM_ENABLED) {
    const key = OpenRouter.keyInfo();
    const free = key.free_model_daily_requests;
    Log.info('✔ OpenRouter-Key gültig' + (free ? ' – Gratis-Anfragen heute: ' + free.used + '/' + free.limit : '') +
      (key.is_free_tier ? ' (Free Tier: 50 Anfragen/Tag)' : ''));
    try {
      const available = OpenRouter.listFreeModels().map(m => m.id);
      cfg.LLM_MODELS.filter(id => available.indexOf(id) === -1).forEach(id =>
        Log.warn('Modell nicht (mehr) kostenlos verfügbar: ' + id + ' – siehe listFreeModels()'));
    } catch (e) {
      Log.warn('Modellliste nicht prüfbar: ' + Log.errorMessage(e));
    }
  }

  const threads = GmailApp.search(cfg.GMAIL_QUERY, 0, 50);
  Log.info('✔ Gmail-Suche „' + cfg.GMAIL_QUERY + '“ findet aktuell ' + threads.length + ' Konversation(en).');

  removeTriggers_();
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(cfg.TRIGGER_MINUTES).create();
  Log.info('✔ Trigger installiert: processInbox alle ' + cfg.TRIGGER_MINUTES + ' Minuten.');

  Telegram.sendMessage({
    text: '✅ <b>Marktplatz-Assistent ist aktiv.</b>\nDein Postfach wird alle ' + cfg.TRIGGER_MINUTES + ' Minuten geprüft.'
  });
}

function uninstall() {
  const removed = removeTriggers_();
  Log.info(removed + ' Trigger entfernt. Die Pipeline läuft nicht mehr automatisch.');
}

function showTelegramChatId() {
  Config.reset();
  const updates = Telegram.getUpdates();
  const chats = {};
  updates.forEach(u => {
    const msg = u.message || u.channel_post || u.edited_message || u.my_chat_member;
    if (msg && msg.chat) chats[msg.chat.id] = msg.chat;
  });
  const ids = Object.keys(chats);
  if (!ids.length) {
    Log.info('Keine Chats gefunden. Schreibe deinem Bot in Telegram eine Nachricht (z. B. /start) und führe die Funktion erneut aus.');
    return;
  }
  ids.forEach(id => {
    const c = chats[id];
    const name = c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || c.type;
    Log.info('Chat-ID ' + id + ' (' + name + ') → als Script Property TELEGRAM_CHAT_ID eintragen');
  });
}

function sendSampleNotifications() {
  Config.reset();
  const cfg = Config.load();
  const deadline = Deadline.create(cfg.MAX_RUNTIME_SECONDS * 1000);
  Samples.LIST.forEach((sample, i) => {
    const outcome = Pipeline.handleInput(Samples.toInput(sample, i), cfg, deadline, { dryRun: true });
    Log.info('Beispiel „' + sample.key + '“: Risiko ' + outcome.result.risk.level +
      ' · Absicht ' + outcome.result.fields.intent + ' · Antwort ' + outcome.result.reply.source);
  });
}

function debugLatestMail() {
  Config.reset();
  const cfg = Config.load();
  const item = MailSource.findLatest(cfg);
  if (!item) {
    Log.info('Keine passende Mail gefunden. GMAIL_QUERY prüfen: ' + cfg.GMAIL_QUERY);
    return;
  }
  const mail = MessageParser.parse(MailSource.toInput(item), cfg);
  const rules = RiskEngine.evaluate(mail.text, { allowedDomains: mail.allowedDomains });
  const heuristics = HeuristicAnalyzer.analyze(mail.text);
  console.log('Betreff:        ' + mail.subject);
  console.log('Plattform:      ' + mail.platform.name + ' | Absender: ' + mail.senderName + ' | Anzeige: ' + mail.listingTitle);
  console.log('Anzeigen-Link:  ' + mail.listingUrl);
  console.log('Übersprungen?   ' + (mail.skipReason || 'nein'));
  console.log('Extraktion:     ' + mail.extraction + ' (MARKER = sicher erkannt)');
  console.log('--- ROHTEXT (gekürzt) ---\n' + TextUtils.truncate(mail.rawBody, 3000));
  console.log('--- EXTRAHIERTE NACHRICHT ---\n' + mail.text);
  console.log('--- AN DIE KI (geschwärzt) ---\n' + Prompt.sanitizeMessage(mail.text, cfg.LLM_MAX_INPUT_CHARS));
  console.log('--- REGELPRÜFUNG ---\nStufe ' + rules.level + ', Score ' + rules.score + '\n' +
    (rules.findings.map(f => '• ' + f.id + ' (' + f.weight + '): ' + f.label + (f.evidence ? ' [' + f.evidence + ']' : '')).join('\n') || '• keine Treffer'));
  console.log('--- HEURISTIK ---\n' + JSON.stringify(heuristics, null, 2));
}

function testLatestMail() {
  Config.reset();
  const cfg = Config.load();
  const item = MailSource.findLatest(cfg);
  if (!item) {
    Log.info('Keine passende Mail gefunden. GMAIL_QUERY prüfen: ' + cfg.GMAIL_QUERY);
    return;
  }
  const outcome = Pipeline.handle(item, cfg, Deadline.create(cfg.MAX_RUNTIME_SECONDS * 1000), { dryRun: true });
  Log.info('TEST-Push gesendet: Risiko ' + outcome.result.risk.level + ', Antwortquelle ' + outcome.result.reply.source);
}

function listFreeModels() {
  Config.reset();
  const cfg = Config.load();
  const models = OpenRouter.listFreeModels();
  models.forEach(m => Log.info(m.id + ' · Kontext ' + m.context + (m.jsonMode ? ' · JSON-Modus' : '')));
  Log.info(models.length + ' kostenlose Modelle. Aktuell konfiguriert (LLM_MODELS): ' + cfg.LLM_MODELS.join(', '));
}

function resetState() {
  StateStore.reset();
  OpenRouter.clearCooldown();
  Log.info('Zustand zurückgesetzt: verarbeitete IDs gelöscht, KI-Pause aufgehoben.');
}

function removeTriggers_() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'processInbox') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}
