/**
 * Liest die LLM-Antwort robust ein und normalisiert sie auf ein festes Schema.
 * Kostenlose Modelle halten sich nicht immer exakt an das Format (Markdown-Zäune,
 * <think>-Blöcke, deutsche Enum-Werte, Preise als Text) – das wird hier abgefangen.
 */
const AnalysisParser = (() => {
  const INTENTS = ['KAUFINTERESSE', 'PREISVERHANDLUNG', 'VERFUEGBARKEIT', 'FRAGE_ZUM_ARTIKEL', 'TERMINABSPRACHE', 'SONSTIGES'];
  const LOGISTICS = ['ABHOLUNG', 'VERSAND', 'BEIDES', 'UNKLAR'];
  const EMPTY_WORDS = /^(null|none|n\/a|keine?|-|unbekannt|unklar)$/i;

  function extractJson(content) {
    let s = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end <= start) throw new ParseError('Kein JSON-Objekt in der KI-Antwort');
    const json = s.slice(start, end + 1);
    try {
      return JSON.parse(json);
    } catch (e) {
      try {
        return JSON.parse(json.replace(/,\s*([}\]])/g, '$1')); // häufig: abschließendes Komma
      } catch (e2) {
        throw new ParseError('Ungültiges JSON in der KI-Antwort: ' + e.message);
      }
    }
  }

  function key(value) {
    return String(value == null ? '' : value).trim().toUpperCase()
      .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE')
      .replace(/[\s-]+/g, '_');
  }

  function intentOf(value) {
    const k = key(value);
    if (INTENTS.indexOf(k) !== -1) return k;
    if (k.indexOf('PREIS') !== -1 || k.indexOf('VERHANDL') !== -1) return 'PREISVERHANDLUNG';
    if (k.indexOf('VERFUEG') !== -1) return 'VERFUEGBARKEIT';
    if (k.indexOf('TERMIN') !== -1) return 'TERMINABSPRACHE';
    if (k.indexOf('FRAGE') !== -1) return 'FRAGE_ZUM_ARTIKEL';
    if (k.indexOf('KAUF') !== -1) return 'KAUFINTERESSE';
    return 'SONSTIGES';
  }

  function logisticsOf(value) {
    const k = key(value);
    if (LOGISTICS.indexOf(k) !== -1) return k;
    const pickup = k.indexOf('ABHOL') !== -1 || k.indexOf('PICKUP') !== -1;
    const shipping = k.indexOf('VERSAND') !== -1 || k.indexOf('SHIP') !== -1;
    if (k.indexOf('BEID') !== -1 || (pickup && shipping)) return 'BEIDES';
    if (pickup) return 'ABHOLUNG';
    if (shipping) return 'VERSAND';
    return 'UNKLAR';
  }

  function riskOf(value) {
    const k = key(value);
    if (k === 'HIGH' || k === 'HOCH' || k === 'HOHES') return 'HIGH';
    if (k === 'MEDIUM' || k === 'MITTEL' || k === 'MED') return 'MEDIUM';
    if (k === 'LOW' || k === 'NIEDRIG' || k === 'GERING') return 'LOW';
    return null;
  }

  function textOf(value, max) {
    if (value == null || typeof value === 'object') return null;
    const s = String(value).replace(/\\n/g, '\n').trim();
    if (!s || EMPTY_WORDS.test(s)) return null;
    return TextUtils.truncate(s, max);
  }

  function priceOf(value) {
    if (value == null || value === false) return null;
    const n = TextUtils.parseNumber(value);
    return n !== null && n > 0 && n < 1000000 ? Math.round(n * 100) / 100 : null;
  }

  function listOf(value) {
    const arr = Array.isArray(value) ? value : (value ? [value] : []);
    return arr.map(v => textOf(v, 120)).filter(Boolean).slice(0, 5);
  }

  function normalize(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ParseError('KI-Antwort ist kein JSON-Objekt');
    return {
      intent: intentOf(obj.intent),
      summary: textOf(obj.summary, 300),
      offeredPrice: priceOf(obj.offeredPrice),
      logistics: logisticsOf(obj.logistics),
      logisticsDetails: textOf(obj.logisticsDetails, 200),
      paymentMethod: textOf(obj.paymentMethod, 80),
      scamRisk: riskOf(obj.scamRisk),
      scamIndicators: listOf(obj.scamIndicators),
      replyDraft: textOf(obj.replyDraft, 1500)
    };
  }

  /** @throws {ParseError} wenn kein verwertbares Ergebnis enthalten ist (→ nächstes Modell) */
  function parse(content) {
    const obj = extractJson(content);
    const result = normalize(obj);
    if (!result.replyDraft && !obj.intent) throw new ParseError('KI-Antwort enthält keine verwertbaren Felder');
    return result;
  }

  return { parse, normalize };
})();
