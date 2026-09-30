/**
 * HTTP-Client auf Basis von UrlFetchApp mit Retry (exponentielles Backoff + Jitter),
 * Beachtung von Retry-After und Zeitbudget. Wirft nur bei Netzwerkfehlern –
 * HTTP-Fehlerstatus werden als Antwort zurückgegeben und vom Aufrufer bewertet.
 */
const Http = (() => {
  const RETRYABLE_STATUS = [429, 500, 502, 503, 504];
  const BASE_DELAY_MS = 1000;
  const MAX_DELAY_MS = 16000;
  const MAX_RETRY_AFTER_MS = 30000;
  const TIME_RESERVE_MS = 10000;

  function wrap(res) {
    const text = res.getContentText();
    const headers = {};
    const raw = res.getAllHeaders ? res.getAllHeaders() : {};
    Object.keys(raw || {}).forEach(k => { headers[k.toLowerCase()] = raw[k]; });
    let parsed = false;
    let json = null;
    return {
      status: res.getResponseCode(),
      text: text,
      headers: headers,
      get json() {
        if (!parsed) {
          parsed = true;
          try { json = JSON.parse(text); } catch (e) { json = null; }
        }
        return json;
      }
    };
  }

  function retryAfterMs(response) {
    const value = response.headers['retry-after'];
    if (!value) return 0;
    const seconds = Number(value);
    if (isFinite(seconds)) return Math.min(Math.max(0, seconds * 1000), MAX_RETRY_AFTER_MS);
    const date = Date.parse(value);
    return isFinite(date) ? Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS) : 0;
  }

  function backoffMs(attempt) {
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt)) + Math.floor(Math.random() * 500);
  }

  /**
   * @param {{url: string, method?: string, headers?: Object, json?: *, retries?: number,
   *          retryOn?: number[], deadline?: Object, label?: string}} options
   * @return {{status: number, text: string, headers: Object, json: *}}
   * @throws {HttpError} bei Netzwerkfehlern nach Ausschöpfen der Versuche
   */
  function request(options) {
    const o = options || {};
    const retries = o.retries == null ? 2 : o.retries;
    const retryOn = o.retryOn || RETRYABLE_STATUS;
    const label = o.label || 'HTTP';
    const params = {
      method: o.method || 'get',
      headers: o.headers || {},
      muteHttpExceptions: true,
      followRedirects: true
    };
    if (o.json !== undefined) {
      params.contentType = 'application/json';
      params.payload = JSON.stringify(o.json);
    }

    for (let attempt = 0; ; attempt++) {
      let response = null;
      let failure = null;
      try {
        response = wrap(UrlFetchApp.fetch(o.url, params));
      } catch (err) {
        failure = err;
      }

      const retryable = failure ? true : retryOn.indexOf(response.status) !== -1;
      const wait = retryable ? (response && retryAfterMs(response)) || backoffMs(attempt) : 0;
      const timeLeft = !o.deadline || o.deadline.hasAtLeast(wait + TIME_RESERVE_MS);

      if (!retryable || attempt >= retries || !timeLeft) {
        if (failure) {
          throw new HttpError(label + ': Netzwerkfehler – ' + Log.redact(Log.errorMessage(failure)), { cause: failure });
        }
        return response;
      }
      Log.warn(label + ': ' + (failure ? 'Netzwerkfehler' : 'HTTP ' + response.status) +
        ' – neuer Versuch in ' + Math.round(wait / 1000) + ' s');
      Utilities.sleep(wait);
    }
  }

  return { request };
})();
