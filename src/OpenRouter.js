/**
 * OpenRouter-Client (OpenAI-kompatible Chat-API) mit
 * - Modell-Fallback-Kette (LLM_MODELS),
 * - Kompatibilitätsmodus (ohne System-Rolle/JSON-Modus) bei HTTP 400,
 * - Circuit Breaker: nach Tageslimit (429 „per day“) oder 402 pausiert die KI,
 *   statt bei jeder weiteren Mail erneut zu scheitern,
 * - LLM_ZDR_ONLY: nur Anbieter mit Zero Data Retention (keine Speicherung, kein Training).
 *
 * Free-Tier (Stand 2026): 20 Anfragen/Minute; 50 Anfragen/Tag, bzw. 1000/Tag
 * nach einmaligem Kauf von mind. 10 Credits.
 */
const OpenRouter = (() => {
  const BASE_URL = 'https://openrouter.ai/api/v1';
  const COOLDOWN_KEY = 'openrouter.cooldown';
  const MIN_TIME_FOR_CALL_MS = 45 * 1000;
  const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000; // CacheService-Maximum

  function headers() {
    return {
      Authorization: 'Bearer ' + Config.secret('OPENROUTER_API_KEY'),
      'HTTP-Referer': 'https://script.google.com',
      'X-Title': 'DealGuard (Apps Script)'
    };
  }

  function shortModel(model) {
    return String(model || '').split('/').pop().replace(/:free$/, '');
  }

  // ------------------------------------------------------------ Circuit Breaker

  function startCooldown(ms, reason) {
    const duration = Math.max(60 * 1000, Math.min(ms, MAX_COOLDOWN_MS));
    const until = Date.now() + duration;
    CacheService.getScriptCache().put(COOLDOWN_KEY, JSON.stringify({ until: until, reason: reason }), Math.ceil(duration / 1000));
    Log.warn('KI pausiert bis ' + new Date(until).toISOString() + ' (' + reason + ')');
  }

  /** @return {?{until: number, reason: string}} aktive Pause oder null */
  function cooldown() {
    const raw = CacheService.getScriptCache().get(COOLDOWN_KEY);
    if (!raw) return null;
    try {
      const c = JSON.parse(raw);
      return c && c.until > Date.now() ? c : null;
    } catch (e) {
      return null;
    }
  }

  function clearCooldown() {
    CacheService.getScriptCache().remove(COOLDOWN_KEY);
  }

  function resetDelayMs(res, cfg) {
    let reset = Number(res.headers['x-ratelimit-reset']);
    if (isFinite(reset) && reset > 0) {
      if (reset < 1e12) reset *= 1000; // Sekunden statt Millisekunden
      if (reset > Date.now()) return reset - Date.now();
    }
    return cfg.LLM_COOLDOWN_MINUTES * 60 * 1000;
  }

  // ------------------------------------------------------------ Fehlerklassifikation

  function errorText(error) {
    if (!error) return '';
    const meta = error.metadata && error.metadata.raw ? ' (' + TextUtils.truncate(String(error.metadata.raw), 150) + ')' : '';
    return TextUtils.truncate(String(error.message || JSON.stringify(error)), 250) + meta;
  }

  function httpError(res, cfg) {
    const data = res.json;
    const status = res.status;
    const msg = data && data.error ? errorText(data.error) : TextUtils.truncate(res.text || '', 200);
    if (status === 401) {
      return new LlmError('API-Key ungültig (401): ' + msg, { status: status, fatal: true });
    }
    if (status === 402) {
      startCooldown(cfg.LLM_COOLDOWN_MINUTES * 60 * 1000, 'kein Guthaben/Key-Limit (402)');
      return new LlmError('Guthaben/Limit erschöpft (402): ' + msg, { status: status, fatal: true });
    }
    if (status === 429 && /per[- ]?day|daily|tages/i.test(msg)) {
      startCooldown(resetDelayMs(res, cfg), 'Tageslimit der Gratis-Modelle');
      return new LlmError('Tageslimit erreicht (429): ' + msg, { status: status, fatal: true });
    }
    if (status === 404) {
      const hint = cfg.LLM_ZDR_ONLY ? 'entfernt oder derzeit kein Anbieter ohne Datenspeicherung (ZDR)' : 'entfernt oder durch Datenschutz-Einstellungen blockiert';
      return new LlmError('Modell nicht verfügbar (404) – ' + hint + ': ' + msg, { status: status });
    }
    return new LlmError('HTTP ' + status + ': ' + msg, { status: status });
  }

  // ------------------------------------------------------------ Anfrage

  function buildBody(model, messages, cfg, compat) {
    const body = { model: model, temperature: cfg.LLM_TEMPERATURE, max_tokens: cfg.LLM_MAX_TOKENS };
    if (cfg.LLM_ZDR_ONLY) body.provider = { zdr: true, data_collection: 'deny' };
    if (compat) {
      // Manche Anbieter kennen keine System-Rolle bzw. keinen JSON-Modus
      body.messages = [{ role: 'user', content: messages.map(m => m.content).join('\n\n') }];
    } else {
      body.messages = messages;
      body.response_format = { type: 'json_object' };
      if (cfg.LLM_REASONING_EFFORT) body.reasoning = { effort: cfg.LLM_REASONING_EFFORT, exclude: true };
    }
    return body;
  }

  function send(body, cfg, deadline) {
    const res = Http.request({
      url: BASE_URL + '/chat/completions',
      method: 'post',
      headers: headers(),
      json: body,
      retries: 1,
      retryOn: [500, 502, 503, 504],
      deadline: deadline,
      label: 'OpenRouter ' + shortModel(body.model)
    });
    if (res.status !== 200) throw httpError(res, cfg);
    const data = res.json;
    if (!data) throw new LlmError('Antwort ist kein JSON');
    if (data.error) throw new LlmError(errorText(data.error), { status: Number(data.error.code) || 0 });
    const choice = data.choices && data.choices[0];
    if (!choice) throw new LlmError('Antwort ohne choices');
    if (choice.error) throw new LlmError(errorText(choice.error), { status: Number(choice.error.code) || 0 });
    const content = choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
    if (!content.trim()) throw new LlmError('Leere Antwort (finish_reason: ' + (choice.finish_reason || '?') + ')');
    if (data.usage) Log.debug('Tokens ' + shortModel(data.model || body.model) + ': ' + JSON.stringify(data.usage));
    return { content: content, model: data.model || body.model };
  }

  function complete(model, messages, cfg, deadline) {
    try {
      return send(buildBody(model, messages, cfg, false), cfg, deadline);
    } catch (err) {
      if (err instanceof LlmError && err.status === 400 && deadline.hasAtLeast(MIN_TIME_FOR_CALL_MS)) {
        Log.info(shortModel(model) + ': HTTP 400 – neuer Versuch im Kompatibilitätsmodus');
        return send(buildBody(model, messages, cfg, true), cfg, deadline);
      }
      throw err;
    }
  }

  /**
   * Probiert die konfigurierten Modelle der Reihe nach.
   * @return {{model: string, analysis: Object}}
   * @throws {LlmError} wenn kein Modell ein verwertbares Ergebnis liefert
   */
  function analyze(messages, deadline) {
    const cfg = Config.load();
    const errors = [];
    for (let i = 0; i < cfg.LLM_MODELS.length; i++) {
      const model = cfg.LLM_MODELS[i];
      if (!deadline.hasAtLeast(MIN_TIME_FOR_CALL_MS)) {
        errors.push('Zeitbudget erschöpft');
        break;
      }
      try {
        const completion = complete(model, messages, cfg, deadline);
        return { model: completion.model, analysis: AnalysisParser.parse(completion.content) };
      } catch (err) {
        errors.push(shortModel(model) + ': ' + Log.errorMessage(err));
        Log.warn('KI-Modell ' + model + ' fehlgeschlagen: ' + Log.errorMessage(err));
        if (err.fatal) {
          throw new LlmError(errors.join(' | '), { status: err.status, fatal: true });
        }
      }
    }
    throw new LlmError(errors.join(' | ') || 'LLM_MODELS ist leer');
  }

  // ------------------------------------------------------------ Diagnose

  /** Infos zum API-Key (Limits, Gratis-Kontingent). */
  function keyInfo() {
    const res = Http.request({ url: BASE_URL + '/key', headers: headers(), label: 'OpenRouter key' });
    if (res.status !== 200) throw httpError(res, Config.load());
    const data = res.json || {};
    return data.data || data;
  }

  /** Aktuell kostenlose Modelle (öffentlicher Endpunkt, kein Key nötig). */
  function listFreeModels() {
    const res = Http.request({ url: BASE_URL + '/models', label: 'OpenRouter models' });
    if (res.status !== 200 || !res.json) throw new LlmError('Modellliste nicht abrufbar (HTTP ' + res.status + ')');
    const producesText = m => {
      const out = m.architecture && m.architecture.output_modalities;
      return !Array.isArray(out) || out.indexOf('text') !== -1;
    };
    let zdr = null;
    try {
      zdr = listZdrModelIds();
    } catch (e) {
      Log.warn('ZDR-Liste nicht abrufbar: ' + Log.errorMessage(e));
    }
    return (res.json.data || [])
      .filter(m => /:free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0))
      .filter(producesText)
      .map(m => ({
        id: m.id,
        context: m.context_length,
        jsonMode: (m.supported_parameters || []).some(p => p === 'response_format' || p === 'structured_outputs'),
        zdr: zdr ? zdr.indexOf(m.id) !== -1 : null
      }));
  }

  /** Modelle mit mindestens einem Zero-Data-Retention-Anbieter (öffentlicher Endpunkt, kein Key nötig). */
  function listZdrModelIds() {
    const res = Http.request({ url: BASE_URL + '/endpoints/zdr', label: 'OpenRouter ZDR' });
    if (res.status !== 200 || !res.json) throw new LlmError('ZDR-Liste nicht abrufbar (HTTP ' + res.status + ')');
    const ids = [];
    (res.json.data || []).forEach(e => {
      if (e.model_id && ids.indexOf(e.model_id) === -1) ids.push(e.model_id);
    });
    return ids;
  }

  return { analyze, cooldown, startCooldown, clearCooldown, keyInfo, listFreeModels, listZdrModelIds, shortModel };
})();
