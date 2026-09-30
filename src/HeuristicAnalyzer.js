/**
 * Regelbasierte Grundauswertung (Absicht, Preis, Logistik, Zahlungsart) ohne KI.
 * Wird genutzt, wenn das LLM deaktiviert, pausiert (Tageslimit) oder nicht erreichbar ist,
 * damit auch im Notbetrieb eine brauchbare Benachrichtigung entsteht.
 */
const HeuristicAnalyzer = (() => {
  const PRICE_RE = /(?:(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:€|eur(?:o)?\b|,-|\.-)|(?:€|eur(?:o)?)\s*(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d{1,2}))?)/g;
  const OFFER_CONTEXT = /\b(biete|angebot|zahle|zahlen|gebe|geben|w(u|ue)rde|nehme|nehmen|f(u|ue)r|vb|letzter?|machst|kannst|w(a|ae)re|preis|vorschlag|gehen?)\b/;

  const PICKUP_RE = /\b(abhol\w*|abzuhol\w*|hole?\s+(es|ihn|sie|das|den|die)\s+([a-z]+\s+)?ab|vorbei\s*(kommen|komme|schauen)|selbst\s*abhol\w*|besichtig\w*)/g;
  const SHIPPING_RE = /\b(versand\w*|versend\w*|verschick\w*|zuschick\w*|zusend\w*|dhl|hermes|dpd|gls|ups|paket|paketversand|porto|liefern|lieferung)\b/g;

  const PAYMENTS = [
    { re: /sicher\s+bezahlen|paylivery/, label: 'Plattform-Bezahlfunktion' },
    { re: /pay\s*pal[^.!?\n]{0,40}(freunde|familie|friends)|(freunde|friends)[^.!?\n]{0,20}pay\s*pal/, label: 'PayPal (Freunde & Familie)' },
    { re: /pay\s*pal/, label: 'PayPal' },
    { re: /\b(barzahlung|bargeld|in\s+bar|bar\s+(bezahlen|zahlen|zahle|auf\s+die\s+hand)|cash)\b/, label: 'Bar' },
    { re: /\bu(e)?berweis\w*|\bvorkasse\b/, label: 'Überweisung' },
    { re: /\bwero\b/, label: 'Wero' }
  ];

  function firstUnnegated(re, norm) {
    const g = new RegExp(re.source, 'g');
    let m;
    while ((m = g.exec(norm)) !== null) {
      if (!TextUtils.isNegatedAt(norm, m.index)) return true;
    }
    return false;
  }

  function findPrice(norm) {
    const candidates = [];
    const re = new RegExp(PRICE_RE.source, 'g');
    let m;
    while ((m = re.exec(norm)) !== null) {
      const whole = (m[1] || m[3] || '').replace(/\s/g, '.');
      const cents = m[2] || m[4];
      const value = TextUtils.parseNumber(whole + (cents ? ',' + cents : ''));
      if (value === null || value <= 0 || value > 100000) continue;
      const before = norm.slice(Math.max(0, m.index - 40), m.index);
      candidates.push({ value: value, offer: OFFER_CONTEXT.test(before) });
    }
    const offers = candidates.filter(c => c.offer);
    if (offers.length) return offers[0];
    return candidates.length ? candidates[0] : null;
  }

  function guessLogistics(norm) {
    const pickup = firstUnnegated(PICKUP_RE, norm);
    const shipping = firstUnnegated(SHIPPING_RE, norm);
    if (pickup && shipping) return 'BEIDES';
    if (pickup) return 'ABHOLUNG';
    if (shipping) return 'VERSAND';
    return 'UNKLAR';
  }

  function guessPayment(norm) {
    for (let i = 0; i < PAYMENTS.length; i++) {
      if (PAYMENTS[i].re.test(norm)) return PAYMENTS[i].label;
    }
    return null;
  }

  function guessIntent(norm, price, logistics) {
    if (price && price.offer) return 'PREISVERHANDLUNG';
    if (/\b(noch\s+(da|verf(u|ue)gbar|zu\s+haben|vorhanden|aktuell|zu\s+verkaufen)|ist\s+(es|er|sie|das)\s+noch|gibt\s+es\s+(es|ihn|sie|das)\s+noch)\b/.test(norm)) {
      return 'VERFUEGBARKEIT';
    }
    if (logistics !== 'UNKLAR' && /\b(wann|uhrzeit|termin|heute|morgen|wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|abends?|nachmittags?|vormittags?)\b/.test(norm)) {
      return 'TERMINABSPRACHE';
    }
    if (/\b(kaufe|nehme|nehmen|interesse|interessiert|reservier\w*)\b|\b(kaufen|haben)\s+m(o|oe)chte\b/.test(norm)) return 'KAUFINTERESSE';
    if (norm.indexOf('?') !== -1) return 'FRAGE_ZUM_ARTIKEL';
    return 'SONSTIGES';
  }

  /** Liefert dieselbe Struktur wie die KI-Analyse (AnalysisParser.normalize). */
  function analyze(text) {
    const norm = TextUtils.normalize(text);
    const price = findPrice(norm);
    const logistics = guessLogistics(norm);
    return {
      intent: guessIntent(norm, price, logistics),
      summary: null,
      offeredPrice: price ? price.value : null,
      logistics: logistics,
      logisticsDetails: null,
      paymentMethod: guessPayment(norm),
      scamRisk: null,
      scamIndicators: [],
      replyDraft: null
    };
  }

  return { analyze };
})();
