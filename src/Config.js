/**
 * Zentrale Konfiguration.
 *
 * - Geheimnisse (OPENROUTER_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) kommen
 *   ausschließlich aus den Script Properties – nie in den Code schreiben.
 * - Alle anderen Werte haben Defaults und lassen sich per Script Property mit
 *   gleichem Namen überschreiben. Listen: JSON-Array oder kommagetrennt.
 */
const Config = (() => {
  const SECRET_KEYS = ['OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

  const DEFAULTS = Object.freeze({
    // --- Gmail ---
    // eBay verschickt auch Bestell-, Verkaufs- und Werbemails vom selben Absender → nur Nachrichten/Fragen
    GMAIL_QUERY: 'is:unread newer_than:7d (from:(kleinanzeigen.de OR willhaben.at) OR ' +
      '(from:(ebay.de OR ebay.at OR ebay.com) subject:(nachricht OR nachrichten OR frage OR message OR question)))',
    MAX_THREADS_PER_RUN: 10,
    MAX_MESSAGES_PER_RUN: 8,
    // Betreff-Muster (Regex, ohne Groß-/Kleinschreibung) für System-Mails ohne Käufernachricht
    SKIP_SUBJECT_PATTERNS: [
      'suchauftrag', 'neue anzeigen für', 'l(ä|ae)uft (bald )?ab', 'ist abgelaufen',
      'wurde (veröffentlicht|gelöscht|deaktiviert|verlängert)', 'newsletter',
      'deine rechnung', 'bewerte (jetzt )?', 'passwort', 'bestätige deine'
    ],
    PROCESSED_LABEL: 'DealGuard',
    FAILED_LABEL: 'DealGuard/Fehler',
    CREATE_GMAIL_DRAFTS: false,
    ALLOWED_LINK_DOMAINS: [],

    // --- KI (OpenRouter) ---
    LLM_ENABLED: true,
    // Reihenfolge = Fallback-Kette. Aktuelle Gratis-Modelle: Funktion listFreeModels()
    LLM_MODELS: [
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'qwen/qwen3.8-27b:free',
      'openrouter/free'
    ],
    LLM_TEMPERATURE: 0.2,
    LLM_MAX_TOKENS: 1500,
    LLM_REASONING_EFFORT: 'low',
    LLM_MAX_INPUT_CHARS: 2500,
    LLM_SKIP_ON_HIGH_RULE_RISK: true,
    LLM_COOLDOWN_MINUTES: 60,

    // --- Antwortentwurf ---
    SELLER_NAME: '',
    SELLER_CONTEXT: '',
    FORM_OF_ADDRESS: 'du',

    // --- Telegram ---
    TELEGRAM_SILENT_LOW_RISK: false,

    // --- Laufzeit ---
    TRIGGER_MINUTES: 5,
    MAX_RUNTIME_SECONDS: 270,
    MAX_DELIVERY_ATTEMPTS: 5,
    ALERT_THROTTLE_MINUTES: 60,
    LOG_LEVEL: 'INFO'
  });

  let cached = null;

  function load() {
    if (cached) return cached;
    const props = PropertiesService.getScriptProperties().getProperties() || {};
    const cfg = {};
    Object.keys(DEFAULTS).forEach(key => {
      cfg[key] = coerce(key, props[key], DEFAULTS[key]);
    });
    SECRET_KEYS.forEach(key => {
      cfg[key] = String(props[key] || '').trim();
    });
    Log.registerSecret(cfg.OPENROUTER_API_KEY);
    Log.registerSecret(cfg.TELEGRAM_BOT_TOKEN);
    Log.setLevel(cfg.LOG_LEVEL);
    cached = Object.freeze(cfg);
    return cached;
  }

  function coerce(key, raw, fallback) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = String(raw).trim();
    if (typeof fallback === 'number') {
      const n = Number(value);
      if (isFinite(n)) return n;
      Log.warn('Script Property ' + key + '="' + value + '" ist keine Zahl – nutze Standard ' + fallback);
      return fallback;
    }
    if (typeof fallback === 'boolean') return /^(true|1|ja|yes|on)$/i.test(value);
    if (Array.isArray(fallback)) {
      if (value.charAt(0) === '[') {
        try {
          const arr = JSON.parse(value);
          if (Array.isArray(arr)) return arr.map(String);
        } catch (e) {
          Log.warn('Script Property ' + key + ' ist kein gültiges JSON-Array – nutze Standard');
          return fallback;
        }
      }
      return value.split(/\s*[,\n]\s*/).filter(Boolean);
    }
    return value;
  }

  /** Liefert ein Geheimnis oder wirft einen (fatalen) ConfigError. */
  function secret(key) {
    const value = load()[key];
    if (!value) {
      throw new ConfigError('Script Property "' + key + '" fehlt (Projekteinstellungen → Script Properties).', { fatal: true });
    }
    return value;
  }

  /** @return {string[]} Liste von Problemen; leer = alles in Ordnung */
  function validate() {
    const cfg = load();
    const problems = [];
    SECRET_KEYS.forEach(key => {
      if (!cfg[key]) problems.push(key + ' fehlt (Projekteinstellungen → Script Properties)');
    });
    if (cfg.TELEGRAM_CHAT_ID && !/^-?\d+$/.test(cfg.TELEGRAM_CHAT_ID)) {
      problems.push('TELEGRAM_CHAT_ID muss eine Zahl sein (Funktion showTelegramChatId hilft)');
    }
    if ([1, 5, 10, 15, 30].indexOf(cfg.TRIGGER_MINUTES) === -1) {
      problems.push('TRIGGER_MINUTES muss 1, 5, 10, 15 oder 30 sein');
    }
    if (cfg.MAX_RUNTIME_SECONDS < 60 || cfg.MAX_RUNTIME_SECONDS > 330) {
      problems.push('MAX_RUNTIME_SECONDS muss zwischen 60 und 330 liegen (Apps-Script-Limit: 360 s)');
    }
    if (cfg.LLM_ENABLED && !cfg.LLM_MODELS.length) problems.push('LLM_MODELS ist leer');
    if (['du', 'sie'].indexOf(String(cfg.FORM_OF_ADDRESS).toLowerCase()) === -1) {
      problems.push('FORM_OF_ADDRESS muss "du" oder "Sie" sein');
    }
    cfg.SKIP_SUBJECT_PATTERNS.forEach(p => {
      try { new RegExp(p, 'i'); } catch (e) { problems.push('Ungültiges Muster in SKIP_SUBJECT_PATTERNS: ' + p); }
    });
    return problems;
  }

  /** Verwirft den Cache (z. B. nach Änderung der Properties oder in Tests). */
  function reset() {
    cached = null;
  }

  return { DEFAULTS, SECRET_KEYS, load, secret, validate, reset };
})();
