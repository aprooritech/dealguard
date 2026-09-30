/**
 * Beispiel-Mails für sendSampleNotifications() – testet die komplette Kette
 * (Extraktion, Regeln, KI, Telegram) ohne echte Gmail-Nachrichten.
 * Alle Namen, Nummern und Domains sind fiktiv.
 */
const Samples = (() => {
  const FOOTER = [
    '',
    'Antworten',
    '',
    'Sicherheitshinweis: Bezahle nie mit Gutscheinkarten, gib keine Codes weiter und nutze keine Links von Fremden.',
    'Kleinanzeigen GmbH · Impressum · Datenschutz'
  ].join('\n');

  const LIST = [
    {
      key: 'preisverhandlung',
      from: '"Anna über Kleinanzeigen" <anna-7f3k2@mail.kleinanzeigen.de>',
      subject: 'Nutzer-Anfrage zu deiner Anzeige „Rennrad Cube Attain, 56 cm“',
      body: [
        'Hallo,',
        '',
        'Anna hat dir eine Nachricht zu deiner Anzeige geschickt:',
        '',
        'Hallo! Ist das Rennrad noch zu haben? Würdest du es für 380 € abgeben?',
        'Ich könnte am Samstagvormittag vorbeikommen und bar bezahlen.',
        '',
        'Viele Grüße',
        'Anna'
      ].join('\n') + FOOTER
    },
    {
      key: 'kurier-masche',
      from: '"Mark über Kleinanzeigen" <mark-2k9d1@mail.kleinanzeigen.de>',
      subject: 'Nutzer-Anfrage zu deiner Anzeige „Sony PlayStation 5“',
      body: [
        'Hallo,',
        '',
        'Mark hat dir eine Nachricht zu deiner Anzeige geschickt:',
        '',
        'Hallo, ich nehme den Artikel zum vollen Preis ohne Besichtigung. Ich bin gerade auf Montage im Ausland,',
        'deshalb holt mein Kurier die Ware ab. Die Zahlung habe ich bereits per PayPal angewiesen.',
        'Schreib mir bitte auf WhatsApp: +44 7700 900123'
      ].join('\n') + FOOTER
    },
    {
      key: 'zahlungslink-phishing',
      from: '"Lisa über Kleinanzeigen" <lisa-9x1m4@mail.kleinanzeigen.de>',
      subject: 'Nutzer-Anfrage zu deiner Anzeige „Kinderwagen Bugaboo Fox“',
      body: [
        'Hallo,',
        '',
        'Lisa hat dir eine Nachricht zu deiner Anzeige geschickt:',
        '',
        'Hallo, ich habe den Betrag über „Sicher bezahlen“ bereits überwiesen.',
        'Um das Geld zu empfangen, bestätige bitte hier: https://kleinanzeigen-sicher-bezahlen.shop/empfang/82734'
      ].join('\n') + FOOTER
    }
  ];

  function toInput(sample, index) {
    return {
      id: 'sample-' + index,
      threadId: 'sample',
      subject: sample.subject,
      from: sample.from,
      replyTo: '',
      date: new Date(),
      plainBody: sample.body,
      htmlBody: '',
      permalink: ''
    };
  }

  return { LIST, toInput };
})();
