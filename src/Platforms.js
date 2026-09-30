/**
 * Plattform-Registry. Neue Marktplätze hier ergänzen.
 *
 * senderDomains: Absender-Domains der Benachrichtigungs-Mails (inkl. Subdomains)
 * linkDomains:   Domains, deren Links als vertrauenswürdig gelten (alles andere prüft die Scam-Logik)
 * listingPath:   erkennt Links auf Anzeigen (für den Button „Anzeige“)
 * startMarkers / endMarkers: zusätzliche Zeilen-Muster für die Textextraktion
 *   (ergänzen die generischen Marker in MessageParser – mit debugLatestMail() prüfen)
 */
const Platforms = (() => {
  const LIST = [
    {
      id: 'kleinanzeigen',
      name: 'Kleinanzeigen',
      senderDomains: ['kleinanzeigen.de', 'ebay-kleinanzeigen.de'],
      linkDomains: ['kleinanzeigen.de', 'ebay-kleinanzeigen.de'],
      listingPath: /\/s-anzeige\//i,
      startMarkers: [],
      endMarkers: []
    },
    {
      id: 'willhaben',
      name: 'willhaben',
      senderDomains: ['willhaben.at'],
      linkDomains: ['willhaben.at'],
      listingPath: /\/iad\//i,
      startMarkers: [],
      endMarkers: []
    },
    {
      id: 'ebay',
      name: 'eBay',
      senderDomains: ['ebay.de', 'ebay.at', 'ebay.com', 'ebay.ch'],
      linkDomains: ['ebay.de', 'ebay.at', 'ebay.com', 'ebay.ch', 'ebayimg.com', 'ebaystatic.com'],
      listingPath: /\/itm\//i,
      startMarkers: [
        /^\s*[^:\n]{2,60}\s+hat\s+(ihnen\s+|dir\s+)?eine\s+frage\b.{0,100}\bgestellt\s*:?\s*$/i,
        /^\s*new\s+message\s+from\b\s*:?\s*[^:\n]{1,60}$/i
      ],
      endMarkers: [
        /\bebay\s+(gmbh|inc\b|marketplaces)|copyright\s*©?\s*\d{4}/i
      ]
    }
  ];

  const GENERIC = {
    id: 'generic',
    name: 'Marktplatz',
    senderDomains: [],
    linkDomains: [],
    listingPath: null,
    startMarkers: [],
    endMarkers: []
  };

  /** Ermittelt die Plattform anhand der Absender-/Reply-To-Adresse. */
  function detect(from, replyTo) {
    const addresses = (String(from || '') + ' ' + String(replyTo || '')).toLowerCase();
    const domains = (addresses.match(/@[a-z0-9.-]+/g) || []).map(d => d.slice(1));
    for (let i = 0; i < LIST.length; i++) {
      if (domains.some(d => TextUtils.hostMatches(d, LIST[i].senderDomains))) return LIST[i];
    }
    return GENERIC;
  }

  return { LIST, GENERIC, detect };
})();
