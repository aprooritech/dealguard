/**
 * Betriebs-Alarme per Telegram (z. B. KI-Key ungültig, Zustellung aufgegeben).
 * Gedrosselt über CacheService, damit ein Dauerfehler nicht alle 5 Minuten eine Nachricht erzeugt.
 */
const Alerts = (() => {
  /**
   * @param {string} key  Drossel-Schlüssel (gleicher Schlüssel = höchstens ein Alarm pro Intervall)
   * @return {boolean} true, wenn ein Alarm gesendet wurde
   */
  function error(key, title, err) {
    const detail = err ? Log.errorMessage(err) : '';
    Log.error(title + (detail ? ': ' + detail : ''));
    try {
      const cfg = Config.load();
      const cache = CacheService.getScriptCache();
      const cacheKey = 'alert.' + key;
      if (cache.get(cacheKey)) return false;
      cache.put(cacheKey, '1', Math.min(21600, Math.max(60, cfg.ALERT_THROTTLE_MINUTES * 60)));
      Telegram.sendMessage({
        text: '⚠️ <b>DealGuard</b>\n' + TextUtils.escapeHtml(title) +
          (detail ? '\n<code>' + TextUtils.escapeHtml(TextUtils.truncate(Log.redact(detail), 500)) + '</code>' : '')
      });
      return true;
    } catch (e) {
      Log.error('Alarm konnte nicht zugestellt werden: ' + Log.errorMessage(e));
      return false;
    }
  }

  return { error };
})();
