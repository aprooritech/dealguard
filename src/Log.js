/**
 * Logging mit Levels und automatischer Schwärzung von Geheimnissen
 * (Bot-Token, API-Keys), damit diese nie im Ausführungsprotokoll landen.
 */
const Log = (() => {
  const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
  const secrets = [];
  let threshold = LEVELS.INFO;

  function setLevel(name) {
    threshold = LEVELS[String(name || '').toUpperCase()] || LEVELS.INFO;
  }

  function registerSecret(value) {
    const s = String(value || '');
    if (s.length >= 8 && secrets.indexOf(s) === -1) secrets.push(s);
  }

  function redact(text) {
    let out = String(text);
    secrets.forEach(s => { out = out.split(s).join('***'); });
    return out
      .replace(/bot\d{5,}:[\w-]{20,}/g, 'bot***')
      .replace(/sk-or-[\w-]{10,}/g, 'sk-or-***');
  }

  function errorMessage(err) {
    if (!err) return 'unbekannter Fehler';
    return err.message ? err.message : String(err);
  }

  function write(level, method, message) {
    if (LEVELS[level] < threshold) return;
    console[method]('[' + level + '] ' + redact(message));
  }

  return {
    setLevel,
    registerSecret,
    redact,
    errorMessage,
    debug: m => write('DEBUG', 'log', m),
    info: m => write('INFO', 'info', m),
    warn: m => write('WARN', 'warn', m),
    error: m => write('ERROR', 'error', m)
  };
})();
