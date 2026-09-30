/**
 * Entscheidet, welcher Antwortentwurf angezeigt wird:
 * - HOHES Risiko → feste Sicherheitsvorlage (keine KI-Formulierung, die sich auf eine Masche einlässt)
 * - KI-Entwurf   → nur, wenn er die Prüfung besteht (keine Links, Nummern, Adressen, Bankdaten)
 * - sonst        → neutrale Vorlage aus den erkannten Feldern
 */
const ReplyPolicy = (() => {
  function isSie(cfg) {
    return String(cfg.FORM_OF_ADDRESS || '').toLowerCase() === 'sie';
  }

  function greeting(mail) {
    const first = mail.senderName ? mail.senderName.split(/\s+/)[0] : '';
    return 'Hallo' + (first ? ' ' + first : '') + ',';
  }

  function closing(cfg) {
    return 'Viele Grüße' + (cfg.SELLER_NAME ? '\n' + cfg.SELLER_NAME : '');
  }

  function safetyTemplate(mail, cfg) {
    const sie = isSie(cfg);
    return [
      greeting(mail),
      '',
      (sie ? 'danke für Ihre Nachricht. ' : 'danke für deine Nachricht. ') +
        'Ich wickle Verkäufe ausschließlich hier über ' + mail.platform.name +
        ' ab – mit Abholung und Barzahlung vor Ort oder über die offizielle Bezahlfunktion der Plattform. ' +
        'Kurierdienste, externe Links, Messenger oder Gutscheinkarten kommen für mich nicht in Frage.',
      '',
      closing(cfg)
    ].join('\n');
  }

  function fallbackTemplate(mail, fields, cfg) {
    const sie = isSie(cfg);
    const t = (du, siePhrase) => (sie ? siePhrase : du);
    const sentences = [];
    const title = mail.listingTitle ? ' zu „' + TextUtils.oneLine(mail.listingTitle, 80) + '“' : '';
    sentences.push(t('danke für deine Nachricht', 'danke für Ihre Nachricht') + title + '!');
    if (['VERFUEGBARKEIT', 'KAUFINTERESSE', 'TERMINABSPRACHE'].indexOf(fields.intent) !== -1) {
      sentences.push('Der Artikel ist noch zu haben.');
    }
    if (fields.offeredPrice !== null && fields.offeredPrice !== undefined) {
      sentences.push(t('Deinen', 'Ihren') + ' Preisvorschlag von ' + TextUtils.formatEuro(fields.offeredPrice) +
        ' habe ich gesehen – ich melde mich gleich dazu.');
    }
    if (fields.logistics === 'ABHOLUNG' || fields.logistics === 'BEIDES') {
      sentences.push(t('Abholung ist gerne möglich – wann würde es dir passen?', 'Abholung ist gerne möglich – wann würde es Ihnen passen?'));
    } else if (fields.logistics === 'VERSAND') {
      sentences.push(t('Versand ist grundsätzlich möglich; die Versandkosten sage ich dir gleich.', 'Versand ist grundsätzlich möglich; die Versandkosten nenne ich Ihnen gleich.'));
    }
    if (sentences.length === 1) {
      sentences.push(t('Ich melde mich in Kürze ausführlicher bei dir.', 'Ich melde mich in Kürze ausführlicher bei Ihnen.'));
    }
    return [greeting(mail), '', sentences.join(' '), '', closing(cfg)].join('\n');
  }

  /** @return {string[]} gefundene Probleme; leer = Entwurf ist unbedenklich */
  function inspect(reply, allowedDomains) {
    const text = String(reply || '');
    const problems = [];
    if (text.trim().length < 10) problems.push('zu kurz');
    if (text.length > 1200) problems.push('zu lang');
    if (TextUtils.extractUrls(text).some(u => !TextUtils.hostMatches(u.host, allowedDomains))) problems.push('enthält Link');
    if (TextUtils.extractPhones(text).length) problems.push('enthält Telefonnummer');
    if (TextUtils.extractEmails(text).length) problems.push('enthält E-Mail-Adresse');
    if (TextUtils.extractIbans(text).length) problems.push('enthält Bankdaten');
    if (/[{}]|"\s*:\s*["\[]/.test(text)) problems.push('Formatfehler');
    return problems;
  }

  /**
   * @return {{text: string, source: string, rejected: string[]}}
   *   source: LLM | TEMPLATE | SAFETY_TEMPLATE
   */
  function decide(input) {
    const mail = input.mail;
    const cfg = input.cfg;
    if (input.risk.level === 'HIGH') {
      return { text: safetyTemplate(mail, cfg), source: 'SAFETY_TEMPLATE', rejected: [] };
    }
    if (input.llmReply) {
      const problems = inspect(input.llmReply, mail.allowedDomains);
      if (!problems.length) return { text: input.llmReply.trim(), source: 'LLM', rejected: [] };
      Log.warn('KI-Antwortentwurf verworfen (' + problems.join(', ') + ') – nutze Vorlage.');
      return { text: fallbackTemplate(mail, input.fields, cfg), source: 'TEMPLATE', rejected: problems };
    }
    return { text: fallbackTemplate(mail, input.fields, cfg), source: 'TEMPLATE', rejected: [] };
  }

  return { decide, inspect };
})();
