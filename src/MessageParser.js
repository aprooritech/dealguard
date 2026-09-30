/**
 * Macht aus einer Benachrichtigungs-Mail ein strukturiertes Objekt und extrahiert
 * den reinen Nachrichtentext des Interessenten.
 *
 * Wichtig für die Sicherheit: Marktplatz-Mails enthalten eigene Sicherheitstipps
 * („Bezahle nie mit Gutscheinkarten …“). Diese Textbausteine müssen vor der Scam-Prüfung
 * entfernt werden, sonst würde jede Mail als Betrug gelten. Deshalb wird der Text
 * zwischen Start- und End-Markern ausgeschnitten.
 */
const MessageParser = (() => {
  // Zeile, nach der die eigentliche Nachricht beginnt (Rest der Zeile nach dem Marker zählt mit)
  const GENERIC_START = [
    /^\s*(neue\s+)?nachricht\s+von\b\s*:?\s*[^:\n]{1,60}:?\s*$/i,
    /^\s*[^:\n]{1,60}\s+(schreibt|schrieb|hat\s+geschrieben)\s*:\s*$/i,
    /hat\s+(dir|ihnen)\s+.{0,60}nachricht.{0,60}(geschickt|gesendet|geschrieben)\s*:?\s*$/i,
    /^\s*(deine\s+|ihre\s+)?(nachricht|nachrichtentext|message)\s*:\s*/i
  ];

  // Erste Zeile, die nicht mehr zur Nachricht gehört
  const GENERIC_END = [
    /^\s*(--\s?|—+|_{3,}|-{3,}|={3,})\s*$/,
    /^\s*(am|on)\s.{3,80}(schrieb|wrote)\b.{0,80}:\s*$/i,
    /^\s*(antworten|jetzt antworten|nachricht beantworten|zur nachricht|zum chat|antwort senden|reply)\s*(<[^>]*>)?\s*$/i,
    /^\s*(von meinem|sent from my|gesendet von)\s/i,
    /sicherheitshinweis|sicherheitstipp|tipps?\s+f(ü|ue)r\s+(deine|ihre|mehr)\s+sicherheit|so\s+sch(ü|ue)tzt\s+du\s+dich|achtung\s*:?\s*betrug/i,
    /(beantworte|antworte)\s.{0,40}(auf\s+diese|über\s+die|ueber\s+die|in\s+der)\s+(e-?mail|nachricht|app)/i,
    /diese\s+(e-?mail|nachricht)\s+wurde\s+(automatisch|an)/i,
    /(du\s+erh(ä|ae)ltst|sie\s+erhalten)\s+diese/i,
    /^\s*(impressum|datenschutz|hilfe|kontakt|abmelden|newsletter|einstellungen|agb)\b/i,
    /(kleinanzeigen|willhaben)[^\n]{0,20}(gmbh|internet\s+service|&\s*co)/i
  ];

  // Einzelzeilen, die nie zur Nachricht gehören
  const BOILERPLATE_LINES = [
    /^\s*(anzeige|artikel|anzeigennummer|anzeigen-?nr\.?)\s*[:#]/i,
    /^\s*\[(image|bild)[^\]]*\]\s*$/i
  ];

  function normalizeBody(body) {
    return String(body || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[​-‍﻿]/g, '')
      .replace(/ /g, ' ')
      .replace(/[ \t]+$/gm, '');
  }

  function isBoilerplate(line, allowedDomains) {
    const l = line.trim();
    if (!l) return false;
    if (BOILERPLATE_LINES.some(re => re.test(l))) return true;
    // Reine Link-Zeilen (Buttons) auf die Plattform selbst; fremde Links bleiben für die Prüfung erhalten
    const urlOnly = /^<?(https?:\/\/\S+?)>?$/i.exec(l);
    return Boolean(urlOnly) && TextUtils.hostMatches(TextUtils.hostOf(urlOnly[1]), allowedDomains);
  }

  function stripWrappingQuotes(text) {
    const m = /^[„"»“]([\s\S]*)[“"«”]$/.exec(text);
    return m ? m[1].trim() : text;
  }

  function cleanup(lines, allowedDomains) {
    const text = lines
      .filter(l => !/^\s*>/.test(l))
      .filter(l => !isBoilerplate(l, allowedDomains))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return stripWrappingQuotes(text);
  }

  /**
   * @return {{text: string, confidence: string}}
   *   confidence: MARKER (Startmarker gefunden), HEURISTIK (nur Endmarker), VOLLTEXT (nichts erkannt)
   */
  function extractMessage(body, platform) {
    const p = platform || Platforms.GENERIC;
    const lines = normalizeBody(body).split('\n');
    const starts = GENERIC_START.concat(p.startMarkers || []);
    const ends = GENERIC_END.concat(p.endMarkers || []);
    const allowed = p.linkDomains || [];

    let start = 0;
    let startFound = false;
    for (let i = 0; i < lines.length && !startFound; i++) {
      for (let j = 0; j < starts.length; j++) {
        const m = starts[j].exec(lines[i]);
        if (!m) continue;
        const rest = lines[i].slice(m.index + m[0].length).replace(/^\s*[:\-–]\s*/, '').trim();
        if (rest) {
          lines[i] = rest;
          start = i;
        } else {
          start = i + 1;
        }
        startFound = true;
        break;
      }
    }

    let end = lines.length;
    for (let i = start; i < lines.length; i++) {
      if (ends.some(re => re.test(lines[i]))) {
        end = i;
        break;
      }
    }

    const text = cleanup(lines.slice(start, end), allowed);
    if (text.length >= 2) {
      return { text: text, confidence: startFound ? 'MARKER' : (end < lines.length ? 'HEURISTIK' : 'VOLLTEXT') };
    }
    // Nichts Brauchbares zwischen den Markern → ganzer Text (Prüfung dann ggf. strenger als nötig)
    return { text: cleanup(normalizeBody(body).split('\n'), allowed), confidence: 'VOLLTEXT' };
  }

  function parseListingTitle(subject) {
    const s = String(subject || '').replace(/^\s*((re|aw|fwd?|wg)\s*:\s*)+/i, '').trim();
    const quoted = /[„"»“]([^„"»“”«]{2,120})[“"«”]/.exec(s);
    if (quoted) return quoted[1].trim();
    const after = /(?:anzeige|artikel|inserat)\s*[:\-–]?\s*(.{2,120})$/i.exec(s);
    return after ? after[1].trim() : null;
  }

  function parseSenderName(from, body) {
    const display = /^\s*"?([^"<]*?)"?\s*</.exec(String(from || ''));
    let name = display ? display[1].trim() : '';
    name = name.replace(/\s+(über|ueber|via)\s+\S.*$/i, '').trim();
    if (/kleinanzeigen|willhaben|ebay|no-?reply|nachricht|service|team|^info$/i.test(name)) name = '';
    if (!name) {
      const text = String(body || '');
      const patterns = [
        /nachricht\s+von\s*:?\s*([^\n:]{2,40}?)(?:\s+erhalten)?\s*:?\s*$/im,
        /^\s*([^\n:]{2,40}?)\s+hat\s+(?:dir|ihnen)\s+.{0,60}nachricht/im,
        /^\s*([^\n:]{2,40}?)\s+hat\s+(?:dir\s+|ihnen\s+)?eine\s+frage/im,
        /^\s*([^\n:]{2,40}?)\s+schreibt\s*:\s*$/im,
        /new\s+message\s+from\s*:?\s*([^\n:]{2,40}?)\s*$/im
      ];
      for (let i = 0; i < patterns.length && !name; i++) {
        const m = patterns[i].exec(text);
        if (m) name = m[1].trim();
      }
    }
    // eBay hängt die Bewertungspunkte an: „käufer123 (15)“
    name = name.replace(/\s*\(\s*\d[\d.,]*\s*[★⭐]?\s*\)\s*$/, '');
    name = name.replace(/[<>\r\n"]/g, '').trim();
    if (/^(du|sie|jemand|ein nutzer|ein interessent)$/i.test(name)) name = '';
    return name ? TextUtils.oneLine(name, 40) : null;
  }

  function findListingUrl(body, platform) {
    if (!platform.listingPath) return null;
    const hit = TextUtils.extractUrls(body).filter(u =>
      TextUtils.hostMatches(u.host, platform.linkDomains) && platform.listingPath.test(u.url))[0];
    if (!hit) return null;
    return /^https?:\/\//i.test(hit.url) ? hit.url.replace(/^http:/i, 'https:') : 'https://' + hit.url;
  }

  /**
   * @param {{id: string, threadId: string, subject: string, from: string, replyTo: string,
   *          date: Date, plainBody: string, htmlBody: string, permalink: string}} input
   * @param {Object} cfg  Config.load()
   */
  function parse(input, cfg) {
    const platform = Platforms.detect(input.from, input.replyTo);
    const plain = String(input.plainBody || '');
    const body = plain.trim().length >= 20 ? plain : TextUtils.htmlToText(input.htmlBody || plain);
    const extraction = extractMessage(body, platform);
    const subject = String(input.subject || '');
    const skipPattern = (cfg.SKIP_SUBJECT_PATTERNS || []).filter(p => new RegExp(p, 'i').test(subject))[0];

    let skipReason = null;
    if (skipPattern) skipReason = 'Betreff passt zu SKIP_SUBJECT_PATTERNS („' + skipPattern + '“)';
    else if (!extraction.text) skipReason = 'kein Nachrichtentext gefunden';

    return {
      id: input.id,
      threadId: input.threadId,
      subject: subject,
      receivedAt: input.date,
      permalink: input.permalink || '',
      platform: platform,
      allowedDomains: (platform.linkDomains || []).concat(cfg.ALLOWED_LINK_DOMAINS || []),
      senderName: parseSenderName(input.from, body),
      listingTitle: parseListingTitle(subject),
      listingUrl: findListingUrl(body, platform),
      text: extraction.text,
      extraction: extraction.confidence,
      rawBody: body,
      skipReason: skipReason
    };
  }

  return { parse, extractMessage, parseListingTitle, parseSenderName };
})();
