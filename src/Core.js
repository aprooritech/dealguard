/**
 * Core: gemeinsame Fehlerklassen und das Zeitbudget einer Ausführung.
 *
 * Apps Script teilt einen globalen Namensraum über alle Dateien. Jede Datei definiert
 * daher genau ein Modul (IIFE bzw. Objekt) und greift erst zur Laufzeit – nie beim
 * Laden – auf andere Module zu. Dadurch spielt die Ladereihenfolge keine Rolle.
 */

class AppError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, fatal?: boolean, cause?: *}=} options
   *   status: HTTP-Status (falls vorhanden)
   *   fatal:  ein erneuter Versuch ist zwecklos (z. B. ungültiger Schlüssel, Tageslimit)
   */
  constructor(message, options) {
    super(message);
    const o = options || {};
    this.name = this.constructor.name;
    this.status = o.status || 0;
    this.fatal = Boolean(o.fatal);
    this.cause = o.cause;
  }
}

class ConfigError extends AppError {}
class HttpError extends AppError {}
class LlmError extends AppError {}
class ParseError extends AppError {}
class TelegramError extends AppError {}

/**
 * Zeitbudget: Apps Script bricht Ausführungen nach 6 Minuten hart ab.
 * Module prüfen vor teuren Schritten (LLM-Aufruf, Retry-Wartezeit), ob noch genug Zeit bleibt.
 */
const Deadline = {
  create(budgetMs) {
    const end = Date.now() + budgetMs;
    return {
      remainingMs: () => end - Date.now(),
      hasAtLeast: ms => end - Date.now() >= ms
    };
  }
};
