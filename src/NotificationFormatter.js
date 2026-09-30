/**
 * Formatiert das Analyseergebnis als Telegram-Nachricht (HTML-Modus).
 *
 * - Alle dynamischen Inhalte werden HTML-escaped (Käufertext ist nicht vertrauenswürdig).
 * - Fremde Links im Nachrichtentext werden entschärft („hxxps://evil[.]com“), IBANs, Kartendaten,
 *   Codes und Ausweisnummern geschwärzt (der Originaltext bleibt in Gmail).
 * - Antwortvorschlag steht in <pre> → in Telegram per Antippen kopierbar.
 * - Das Telegram-Limit von 4096 Zeichen wird durch stufenweises Kürzen der Vorschau eingehalten.
 */
const NotificationFormatter = (() => {
  const TELEGRAM_LIMIT = 4096;
  const PREVIEW_LIMITS = [1500, 700, 300, 0];
  const COPY_BUTTON_LIMIT = 256; // Telegram-Limit für copy_text

  const RISK_HEAD = {
    HIGH: '🔴 <b>HOHES RISIKO</b>',
    MEDIUM: '🟠 <b>ERHÖHTES RISIKO</b>',
    LOW: '🟢 <b>Unauffällig</b>'
  };
  const RISK_ADVICE = {
    HIGH: '🛑 <b>Empfehlung:</b> Nicht darauf eingehen. Keine Links öffnen, keine Codes oder Daten herausgeben, Nutzer auf der Plattform melden.',
    MEDIUM: '⚠️ <b>Hinweis:</b> Kommunikation und Zahlung nur über die Plattform oder bar bei Abholung.',
    LOW: ''
  };
  const INTENT_LABEL = {
    KAUFINTERESSE: 'Kaufinteresse',
    PREISVERHANDLUNG: 'Preisverhandlung',
    VERFUEGBARKEIT: 'Verfügbarkeit',
    FRAGE_ZUM_ARTIKEL: 'Frage zum Artikel',
    TERMINABSPRACHE: 'Terminabsprache',
    SONSTIGES: 'Sonstiges'
  };
  const LOGISTICS_LABEL = { ABHOLUNG: 'Abholung', VERSAND: 'Versand', BEIDES: 'Abholung oder Versand' };
  const REPLY_SOURCE_LABEL = { LLM: 'KI', TEMPLATE: 'Vorlage', SAFETY_TEMPLATE: 'Sicherheitsvorlage' };

  function esc(text) {
    return TextUtils.escapeHtml(text);
  }

  function formatDate(date) {
    if (!date) return '';
    try {
      return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd.MM. HH:mm');
    } catch (e) {
      return '';
    }
  }

  function defangHost(host) {
    return String(host).replace(/\./g, '[.]');
  }

  function footer(result) {
    const parts = [];
    if (result.llm.used) parts.push('KI: ' + OpenRouter.shortModel(result.llm.model));
    else parts.push('KI: ' + (result.llm.note || 'nicht genutzt'));
    parts.push('Antwort: ' + REPLY_SOURCE_LABEL[result.reply.source]);
    if (result.reply.rejected && result.reply.rejected.length) parts.push('KI-Entwurf verworfen: ' + result.reply.rejected.join(', '));
    if (result.risk.escalatedByLlm) parts.push('Risiko von KI erhöht');
    return parts.join(' · ');
  }

  function render(mail, result, options, previewLimit) {
    const f = result.fields;
    const risk = result.risk;
    const lines = [];

    lines.push((options.test ? '🧪 <b>TEST</b> · ' : '') + RISK_HEAD[risk.level] + ' · ' + esc(mail.platform.name));
    if (mail.listingTitle) lines.push('📌 <b>' + esc(TextUtils.truncate(mail.listingTitle, 120)) + '</b>');
    const meta = [];
    if (mail.senderName) meta.push('👤 ' + esc(mail.senderName));
    const when = formatDate(mail.receivedAt);
    if (when) meta.push('🕒 ' + esc(when));
    if (meta.length) lines.push(meta.join(' · '));

    lines.push('');
    lines.push('🎯 <b>Absicht:</b> ' + esc(INTENT_LABEL[f.intent] || f.intent));
    if (f.offeredPrice !== null && f.offeredPrice !== undefined) lines.push('💶 <b>Angebot:</b> ' + esc(TextUtils.formatEuro(f.offeredPrice)));
    if (LOGISTICS_LABEL[f.logistics]) {
      lines.push('🚚 <b>Logistik:</b> ' + LOGISTICS_LABEL[f.logistics] +
        (f.logisticsDetails ? ' – ' + esc(TextUtils.truncate(f.logisticsDetails, 120)) : ''));
    }
    if (f.paymentMethod) lines.push('💳 <b>Zahlung:</b> ' + esc(TextUtils.truncate(f.paymentMethod, 80)));
    if (f.summary) lines.push('📝 <i>' + esc(TextUtils.truncate(f.summary, 300)) + '</i>');

    const warnings = risk.findings.map(x => '• ' + esc(x.label) + (x.evidence ? ' <code>' + esc(defangHost(x.evidence)) + '</code>' : ''))
      .concat(risk.llmIndicators.map(x => '• 🤖 ' + esc(TextUtils.truncate(x, 120))));
    if (warnings.length) {
      lines.push('');
      lines.push('⚠️ <b>Warnsignale</b>' + (risk.score ? ' (Regel-Score ' + risk.score + '/100)' : '') + ':');
      Array.prototype.push.apply(lines, warnings.slice(0, 12));
    }
    if (RISK_ADVICE[risk.level]) {
      lines.push('');
      lines.push(RISK_ADVICE[risk.level]);
    }

    if (previewLimit > 0 && mail.text) {
      const safeText = TextUtils.defangUrls(TextUtils.redactSecrets(mail.text), mail.allowedDomains);
      const preview = TextUtils.truncate(safeText, previewLimit);
      lines.push('');
      lines.push('💬 <b>Nachricht:</b>');
      lines.push('<blockquote expandable>' + esc(preview) + '</blockquote>');
    }
    if (mail.extraction === 'VOLLTEXT') {
      lines.push('ℹ️ <i>Nachrichtentext nicht sicher erkannt – ggf. Marker anpassen (debugLatestMail).</i>');
    }

    lines.push('');
    lines.push('✍️ <b>Antwortvorschlag</b> <i>(' + REPLY_SOURCE_LABEL[result.reply.source] + ', antippen zum Kopieren)</i>:');
    lines.push('<pre>' + esc(result.reply.text) + '</pre>');
    lines.push('');
    lines.push('<i>' + esc(footer(result)) + '</i>');
    return lines.join('\n');
  }

  function buttons(mail, result) {
    const rows = [];
    const reply = result.reply.text;
    if (reply && reply.length <= COPY_BUTTON_LIMIT) {
      rows.push([{ text: '📋 Antwort kopieren', copy_text: { text: reply } }]);
    }
    const links = [];
    if (/^https:\/\//i.test(mail.permalink)) links.push({ text: '📧 In Gmail öffnen', url: mail.permalink });
    if (/^https:\/\//i.test(mail.listingUrl || '')) links.push({ text: '🔗 Anzeige', url: mail.listingUrl });
    if (links.length) rows.push(links);
    return rows.length ? { inline_keyboard: rows } : null;
  }

  /**
   * @param {Object} mail    Ergebnis von MessageParser.parse
   * @param {Object} result  Ergebnis von Pipeline.analyze
   * @param {{test?: boolean, silent?: boolean}=} options
   * @return {{text: string, replyMarkup: ?Object, silent: boolean, plain: boolean}}
   */
  function format(mail, result, options) {
    const opts = options || {};
    let text = '';
    for (let i = 0; i < PREVIEW_LIMITS.length; i++) {
      text = render(mail, result, opts, PREVIEW_LIMITS[i]);
      if (text.length <= TELEGRAM_LIMIT) {
        return { text: text, replyMarkup: buttons(mail, result), silent: Boolean(opts.silent), plain: false };
      }
    }
    // Notfall (sollte praktisch nie eintreten): Klartext hart kürzen
    return {
      text: TextUtils.truncate(TextUtils.stripTags(text), TELEGRAM_LIMIT - 10),
      replyMarkup: buttons(mail, result),
      silent: Boolean(opts.silent),
      plain: true
    };
  }

  return { format };
})();
