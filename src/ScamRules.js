/**
 * Regelkatalog der typischen Marktplatz-Maschen (deterministische Sicherheitsebene).
 *
 * Alle Muster laufen gegen normalisierten Text (siehe TextUtils.normalize):
 * klein geschrieben, Umlaute ohne Punkte (ü→u, ß→ss). Für die Schreibweise „ue“
 * daher „u(e)?“ verwenden.
 *
 * Bewertung: Summe der Gewichte (max. 100). Ab HIGH_THRESHOLD → HOCH, ab
 * MEDIUM_THRESHOLD → MITTEL. Regeln mit critical: true erzwingen HOCH.
 * Gewicht ≥ 60 bedeutet: dieses Signal allein reicht für HOCH.
 *
 * Felder einer Regel:
 *   patterns  – Regex-Liste; negatable: Treffer direkt nach „kein/nicht/ohne“ zählen nicht
 *   squashed  – Schlüsselwörter für den Nur-Buchstaben-Text (gegen „W h a t s A p p“, „wh@tsapp“);
 *               greifen nur, wenn kein Regex-Treffer (auch kein verneinter) vorlag
 *   detect    – Funktion(ctx) für strukturierte Funde (Links, Nummern); Rückgabe = Beleg oder false
 */
const ScamRules = (() => {
  const HIGH_THRESHOLD = 60;
  const MEDIUM_THRESHOLD = 20;

  const URL_SHORTENERS = [
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'cutt.ly', 'rebrand.ly', 'shorturl.at',
    'rb.gy', 't.ly', 'tiny.cc', 's.id', 'v.gd', 'bit.do', 'qrco.de', 'tiny.one', 'short.io', 'urlz.fr'
  ];

  // Marken, deren Namen in Phishing-Domains missbraucht werden („kleinanzeigen-sicher-bezahlen.shop“)
  const LOOKALIKE_BRANDS = ['kleinanzeigen', 'willhaben', 'ebay', 'paypal', 'klarna', 'vinted', 'dhl', 'dpd', 'gls', 'ups'];

  function first(list) {
    return list.length ? list[0] : false;
  }

  const RULES = [
    // ------------------------------------------------------------ Kontakt außerhalb der Plattform
    {
      id: 'MESSENGER',
      label: 'Will auf WhatsApp/Telegram & Co. wechseln',
      weight: 60,
      negatable: true,
      patterns: [
        /\bwh?at+s?\s*-?\s*ap+/,
        /\btelegram/,
        /\b(per|uber|ueber|via|auf|in|bei)\s+(wa|tg)\b/,
        /\b(per|uber|ueber|via|auf|bei)\s+signal\b/,
        /\bsignal\s*-?\s*(nummer|messenger|app|chat)\b/,
        /\b(viber|threema|wechat|imessage|snapchat)\b/,
        /\bwa\.me\b|\bt\.me\//
      ],
      squashed: ['whatsapp', 'whatsap', 'watsapp', 'telegram']
    },
    {
      id: 'PHONE_NUMBER',
      label: 'Telefonnummer in der Nachricht',
      weight: 35,
      detect: ctx => ctx.phones.length > 0
    },
    {
      id: 'EMAIL_ADDRESS',
      label: 'E-Mail-Adresse in der Nachricht',
      weight: 30,
      detect: ctx => ctx.emails.length > 0
    },
    {
      id: 'CONTACT_REQUEST',
      label: 'Bittet um Kontakt außerhalb der Plattform',
      weight: 30,
      negatable: true,
      patterns: [
        /\b(deine|dein|ihre|ihr)\s+(handy|telefon|mobil|whatsapp|private?)?\s*-?\s*(nummer|nr\b)/,
        /\b(deine|ihre)\s+(private\s+)?(e-?mail|mail)(\s*-?\s*adresse)?\b/,
        /\bmeine\s+(handy|telefon|mobil|whatsapp)?\s*-?\s*(nummer|nr\b)/,
        /\b(per|via|uber|ueber)\s+(sms|e-?mail|mail|telefon|handy|anruf)\b/,
        /\bruf\s+(mich|mal)\s+(bitte\s+)?an\b|\brufen\s+sie\s+(mich\s+)?(bitte\s+)?an\b/,
        /\bschreib\w*\s+(mir|mich)\s+(direkt|privat)\b/,
        /\bmelde?\s+(dich|sich)\s+(bitte\s+)?(unter|per)\b/
      ]
    },

    // ------------------------------------------------------------ Abholung / Versand
    {
      id: 'COURIER',
      label: 'Abholung durch Kurier/Spedition',
      weight: 60,
      negatable: true,
      patterns: [
        /\bkurier/,
        /\bspedi(tion|teur)/,
        /\btransport\s*-?\s*(firma|unternehmen|dienst|service|agentur)/,
        /\bumzugs\s*-?\s*(firma|unternehmen|service|dienst)/,
        /\babhol\s*-?\s*(dienst|service|firma)/,
        /\b(mein|meine|meinen|unser|unseren|ein|einen)\s+(fahrer|transporteur|logistiker)\b/,
        /\b(dhl|ups|fedex|dpd|gls|hermes|tnt)(\s+express)?\s+(wird|kommt|holt|abholung|abholen|fahrer|mitarbeiter|bote)\b/,
        /\b(paket|versand|liefer)dienst\s+(holt|wird|kommt|abholen)/
      ]
    },
    {
      id: 'THIRD_PARTY_PICKUP',
      label: 'Abholung durch Dritte',
      weight: 15,
      patterns: [
        /\b(sohn|tochter|bruder|schwester|kollege|kollegin|cousin|cousine|nachbar|nachbarin|mitarbeiter|bekannter|vater|mutter)\s+([a-z]+\s+){0,3}(holt|abholen|abholt)/,
        /\babholen\s+lassen\b/
      ]
    },
    {
      id: 'SHIPPING_LABEL',
      label: 'Will Versandlabel per Link/Mail schicken',
      weight: 25,
      patterns: [
        /\b(versand|paket|dhl|hermes|dpd|ups|gls)\s*-?\s*(label|etikett|marke|schein)\b[^.!?\n]{0,60}\b(link|e-?mail|mail|whatsapp|schick|send)/,
        /\b(schicke|sende|erstelle|mache)\s+(dir|ihnen)\s+([a-z]+\s+){0,2}(versand|paket)\s*-?\s*(label|etikett|marke|schein)/
      ]
    },

    // ------------------------------------------------------------ Zahlung
    {
      id: 'GIFT_CARD',
      label: 'Zahlung per Gutschein-/Guthabenkarte',
      weight: 100,
      critical: true,
      patterns: [
        /paysafe/,
        /\bpsc\s*-?\s*(code|karte|pin)/,
        /gutschein\s*-?\s*(karte|code)/,
        /guthaben\s*-?\s*(karte|code|bon)/,
        /geschenk\s*-?\s*karte/,
        /\b(google\s*-?\s*play|itunes|app\s*-?\s*store|apple|amazon|steam|xbox|playstation|psn|netflix|spotify|nintendo)\s*-?\s*(gutschein|karte|guthaben|gift|code|card)/,
        /gift\s*-?\s*cards?/,
        /\b(neosurf|transcash|flexepin|cashlib|ukash)\b/,
        /aufladecode|aufladekarte/
      ],
      squashed: ['paysafecard', 'paysafe']
    },
    {
      id: 'MONEY_TRANSFER',
      label: 'Bargeldtransfer (Western Union, MoneyGram, Geld per Post)',
      weight: 60,
      patterns: [
        /western\s*-?\s*union/,
        /money\s*-?\s*gram/,
        /\b(bargeld|geld)\s+(per|im|in\s+einem)\s+(post|brief|umschlag)/
      ],
      squashed: ['westernunion', 'moneygram']
    },
    {
      id: 'CRYPTO',
      label: 'Zahlung in Kryptowährung',
      weight: 45,
      patterns: [/\b(bitcoin|btc|krypto\w*|crypto\w*|usdt|tether|ethereum|litecoin)\b/]
    },
    {
      id: 'PAYMENT_CLAIM',
      label: 'Behauptet Zahlung / Geld soll „freigegeben“ werden',
      weight: 40,
      patterns: [
        /\b(zahlung|geld|betrag|u(e)?berweisung|kaufpreis)\s+(ist\s+|wurde\s+|wird\s+)?(bereits\s+|schon\s+|gerade\s+)?(gesendet|u(e)?berwiesen|reserviert|freigegeben|eingegangen|hinterlegt|blockiert|autorisiert|angewiesen|unterwegs|zur(u|ue)ckgehalten)/,
        /\b(zahlung|geld|betrag|kaufpreis)\s+(habe|hab)\s+ich\s+(bereits\s+|schon\s+)?([a-z]+\s+){0,3}(gesendet|u(e)?berwiesen|angewiesen|bezahlt|veranlasst|freigegeben)/,
        /\bich\s+habe\s+(bereits|schon|gerade|soeben|jetzt)\s+(bezahlt|u(e)?berwiesen|gezahlt|gesendet|die\s+zahlung)/,
        /\b(geld|zahlung|betrag)\s+(zu\s+)?(empfangen|erhalten|annehmen|freischalten|best(a|ae)tigen|freigeben)/,
        /\bum\s+(das\s+|dein\s+|ihr\s+)?geld\s+zu\s+(empfangen|erhalten|bekommen)/,
        /\b(screenshot|beleg|nachweis|best(a|ae)tigung|quittung)\s+(der|von\s+der|u(e)?ber\s+die|f(u|ue)r\s+die)\s+(zahlung|u(e)?berweisung)/
      ]
    },
    {
      id: 'OVERPAYMENT',
      label: 'Überzahlung mit Rückforderung',
      weight: 70,
      patterns: [
        /\b(zu\s*viel|mehr)\s+(geld\s+)?(u(e)?berwiesen|gezahlt|bezahlt|gesendet|geschickt)/,
        /\b(differenz|restbetrag|u(e)?berschuss|mehrbetrag)\s+([a-z]+\s+){0,4}(zur(u|ue)ck|erstatten|u(e)?berweisen|weiterleiten)/,
        /\bu(e)?berzahlung/,
        /\bscheck\b/
      ]
    },
    {
      id: 'ADVANCE_FEE',
      label: 'Soll Gebühren/Kosten vorab zahlen',
      weight: 60,
      patterns: [
        /\b(kurier|transport|speditions|zoll|versicherungs|bearbeitungs|freischalt)\s*-?\s*(kosten|gebu(e)?hr|gebu(e)?hren)\b[^.!?\n]{0,60}\b(vorstrecken|vorab|im\s+voraus|zuerst|erstatten|u(e)?berweise)/,
        /\bgebu(e)?hren?\s+f(u|ue)r\s+(die\s+)?(freischaltung|freigabe|versicherung|zahlung)/
      ]
    },
    {
      id: 'CARD_DATA',
      label: 'Fragt Karten- oder Bankzugangsdaten ab',
      weight: 100,
      critical: true,
      patterns: [
        /kredit\s*-?\s*karten?\s*-?\s*(daten|nummer|informationen|angaben)/,
        /\bkarten\s*-?\s*(daten|nummer|informationen|angaben)/,
        /\b(cvv|cvc)2?\b/,
        /\bpr(u|ue)f\s*-?\s*(ziffer|nummer)/,
        /\b(online\s*-?\s*)?banking\s*-?\s*(zugang|zugangsdaten|login|passwort|pin|daten)/,
        /\b(tan|pin|passwort)\b[^.!?\n]{0,30}\b(schick|send|mitteil|eingeben|nenn|best(a|ae)tig|gib)/,
        /\b(daten|karte)\s+(eingeben|hinterlegen|verifizieren)\b/
      ]
    },
    {
      id: 'VERIFICATION_CODE',
      label: 'Fordert SMS-/Bestätigungscode (Kontoübernahme)',
      weight: 100,
      critical: true,
      patterns: [
        /\b(sms|best(a|ae)tigungs|verifizierungs|verifikations|sicherheits|freischalt|aktivierungs|login|anmelde)\s*-?\s*code/,
        /\b\d\s*-?\s*stellige?n?\s+code/,
        /\bcode\b[^.!?\n]{0,50}\b(schick|send|weiterleit|mitteil|geben|gib|nenn|zuschick|sag)/,
        /\b(schick|send|nenn|gib|sag)\w*\s+(mir|uns)\s+([a-z]+\s+){0,3}code\b/
      ]
    },
    {
      id: 'FRIENDS_FAMILY',
      label: 'PayPal „Freunde & Familie“ (ohne Käuferschutz)',
      weight: 10,
      patterns: [
        /\bfreunde?\s*(und|&|\+)\s*familie/,
        /\bfamilie\s*(und|&|\+)\s*freunde/,
        /\bfriends\s*(and|&|\+)\s*family/,
        /\bf\s*(&|und|\+)\s*f\b/
      ]
    },

    // ------------------------------------------------------------ Täuschung & Kontext
    {
      id: 'PLATFORM_IMPERSONATION',
      label: 'Gibt sich als Plattform/Zahlungsdienst aus',
      weight: 60,
      patterns: [
        /\b(kleinanzeigen|willhaben|ebay|paypal|dhl|klarna)\s*-?\s*(team|support|kundenservice|kundendienst|sicherheitsteam|sicherheitsabteilung|zahlungsabteilung|abteilung)\b/
      ]
    },
    {
      id: 'PROMPT_INJECTION',
      label: 'Versucht, die KI-Prüfung zu manipulieren',
      weight: 60,
      patterns: [
        /\b(ignorier\w*|vergiss)\s+([a-z]+\s+){0,3}(anweisungen|instruktionen|regeln|vorgaben)/,
        /\bignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions/,
        /\b(system\s*-?\s*prompt|jailbreak)\b/,
        /\b(stufe|bewerte|klassifiziere)\w*\s+([a-z]+\s+){0,4}als\s+(low|niedrig|unbedenklich|harmlos|sicher)\b/
      ]
    },
    {
      id: 'PERSONAL_DATA',
      label: 'Fragt Ausweis/persönliche Daten ab',
      weight: 40,
      negatable: true,
      patterns: [
        /\b(personal)?ausweis(kopie|foto|nummer|daten)?\b/,
        /\breisepass/,
        /\bf(u|ue)hrerschein(kopie|foto)?\b/,
        /\bgeburtsdatum\b/,
        /\b(dein|deine|deinen|ihr|ihre|ihren)\s+(vollst(a|ae)ndigen?|kompletten?)\s+(namen?|adresse|anschrift|daten)/
      ]
    },
    {
      id: 'ABROAD',
      label: 'Angeblich im Ausland/auf Montage',
      weight: 20,
      patterns: [
        /\b(im|aus\s+dem)\s+ausland\b/,
        /\bauf\s+montage\b/,
        /\b(gesch(a|ae)fts|dienst)reise\b/,
        /\b(auf\s+see|offshore|bohrinsel|auslandseinsatz)\b/,
        /\b(bin|arbeite|lebe|wohne)\s+(gerade\s+|derzeit\s+|zurzeit\s+|momentan\s+|aktuell\s+)?in\s+(england|grossbritannien|frankreich|spanien|italien|polen|rum(a|ae)nien|nigeria|ghana|usa|amerika|kanada|dubai|schweden|norwegen)\b/
      ]
    },
    {
      id: 'UNSEEN_PURCHASE',
      label: 'Kauf ungesehen/ohne Verhandlung',
      weight: 15,
      patterns: [
        /\bungesehen\b/,
        /\bohne\s+(zu\s+)?(besichtig|anschau|anzuschau|ansehen|anzusehen|verhandl|preisverhandl|probefahrt)/,
        /\b(nehme|kaufe)\s+(es|ihn|sie|das|den\s+artikel|die\s+ware)?\s*(auch\s+)?zum\s+(vollen|angegebenen|genannten)\s+preis/
      ]
    },
    {
      id: 'URGENCY',
      label: 'Zeitdruck',
      weight: 10,
      patterns: [
        /\b(dringend|umgehend|asap|schnellstm(o|oe)glich)\b/,
        /\bso\s+schnell\s+wie\s+m(o|oe)glich\b/
      ]
    },

    // ------------------------------------------------------------ Links
    {
      id: 'LOOKALIKE_DOMAIN',
      label: 'Link auf gefälschte Plattform-/Zahlungsseite',
      weight: 100,
      critical: true,
      detect: ctx => first(ctx.urls.filter(u => u.lookalike).map(u => u.host))
    },
    {
      id: 'URL_SHORTENER',
      label: 'Verkürzter Link (Ziel verschleiert)',
      weight: 60,
      detect: ctx => first(ctx.urls.filter(u => u.shortener && !u.lookalike).map(u => u.host))
    },
    {
      id: 'EXTERNAL_LINK',
      label: 'Link auf externe Webseite',
      weight: 40,
      detect: ctx => first(ctx.urls.filter(u => !u.allowed && !u.lookalike && !u.shortener).map(u => u.host))
    }
  ];

  // Kombinationen: jede Gruppe muss mit mindestens einer Regel vertreten sein.
  const COMBOS = [
    {
      id: 'COMBO_FAKE_PAYMENT_LINK',
      label: 'Masche: angebliche Zahlung + Link („Geld empfangen“-Phishing)',
      bonus: 40,
      critical: true,
      requires: [['PAYMENT_CLAIM'], ['EXTERNAL_LINK', 'URL_SHORTENER', 'LOOKALIKE_DOMAIN']]
    },
    {
      id: 'COMBO_COURIER_SCAM',
      label: 'Masche: Kurierabholung + Vorabzahlung/Ausland',
      bonus: 30,
      requires: [['COURIER'], ['PAYMENT_CLAIM', 'ABROAD', 'UNSEEN_PURCHASE', 'OVERPAYMENT', 'ADVANCE_FEE']]
    },
    {
      id: 'COMBO_OFFPLATFORM_PAYMENT',
      label: 'Masche: Kontaktwechsel + Zahlungs-/Versandtrick',
      bonus: 30,
      requires: [
        ['MESSENGER', 'PHONE_NUMBER', 'EMAIL_ADDRESS', 'CONTACT_REQUEST'],
        ['PAYMENT_CLAIM', 'SHIPPING_LABEL', 'EXTERNAL_LINK', 'URL_SHORTENER', 'FRIENDS_FAMILY']
      ]
    }
  ];

  return { HIGH_THRESHOLD, MEDIUM_THRESHOLD, URL_SHORTENERS, LOOKALIKE_BRANDS, RULES, COMBOS };
})();
