/**
 * Text-Hilfsfunktionen:
 * - Normalisierung für robuste Mustererkennung (Homoglyphen, unsichtbare Zeichen, Leetspeak)
 * - HTML ⇄ Text
 * - Erkennung von Links, Telefonnummern, E-Mail-Adressen und IBANs
 * - Schwärzung personenbezogener Daten (vor dem LLM), von Finanz-/Zugangsdaten (auch für Telegram)
 *   und Entschärfen von Links
 */
const TextUtils = (() => {
  const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;

  // Kyrillische/griechische Zeichen, die wie lateinische aussehen („kleinаnzeigen“ mit kyrill. а)
  const HOMOGLYPHS = {
    'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c',
    'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w',
    'ɑ': 'a', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't',
    'υ': 'u', 'χ': 'x'
  };
  const HOMOGLYPH_RE = new RegExp('[' + Object.keys(HOMOGLYPHS).join('') + ']', 'g');
  const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

  // Bekannte TLDs für Links ohne http:// (z. B. „bit.ly/abc“, „sicher-zahlen.shop“)
  const TLDS = [
    'de', 'at', 'ch', 'li', 'lu', 'com', 'net', 'org', 'info', 'biz', 'eu', 'io', 'co', 'me', 'ly',
    'gl', 'gd', 'cc', 'to', 'tv', 'app', 'xyz', 'top', 'online', 'site', 'shop', 'store', 'link',
    'live', 'click', 'icu', 'vip', 'pro', 'ru', 'cn', 'su', 'tk', 'ml', 'ga', 'cf', 'gq', 'pw', 'ws',
    'uk', 'fr', 'it', 'es', 'nl', 'be', 'pl', 'cz', 'sk', 'hu', 'ro', 'bg', 'tr', 'ua', 'us', 'ca',
    'in', 'cloud', 'club', 'website', 'space', 'fun', 'buzz', 'page', 'support', 'help', 'pay',
    'bank', 'money', 'delivery', 'express', 'services'
  ];
  const LABEL_CHARS = 'a-z0-9\\u00C0-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF';
  const LABEL = '[' + LABEL_CHARS + '](?:[' + LABEL_CHARS + '-]{0,61}[' + LABEL_CHARS + '])?';
  const URL_SOURCE =
    '(?:https?:\\/\\/|www\\.)[^\\s<>"\'()\\[\\]{}]+' +
    '|(?:' + LABEL + '\\.)+(?:' + TLDS.join('|') + ')(?![' + LABEL_CHARS + '-]|\\.[' + LABEL_CHARS + '])' +
    '(?:[\\/?#][^\\s<>"\'()\\[\\]{}]*)?';

  const PHONE_SOURCE = '(?:\\+|\\b00|\\b0)[1-9](?:[ \\t\\/().-]{0,2}\\d){6,14}(?!\\d)';
  const EMAIL_SOURCE = '[a-z0-9._%+-]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,24}';
  const IBAN_SOURCE = '\\b[a-z]{2}\\d{2}(?: ?[a-z0-9]{4}){3,7}(?: ?[a-z0-9]{1,3})?\\b';

  const NEGATION_BEFORE = /\b(kein|keine|keinen|keinem|keiner|nicht|ohne|nie|niemals)\s+(?:[a-z]+\s+)?$/;

  // ---------------------------------------------------------------- Normalisierung

  function foldDiacritics(s) {
    try {
      return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    } catch (e) {
      return s;
    }
  }

  /** Klein, ohne Akzente/Umlaut-Punkte (ü→u), Homoglyphen und unsichtbare Zeichen. */
  function normalize(text) {
    let s = String(text || '').replace(INVISIBLE, '').toLowerCase().replace(/ß/g, 'ss');
    s = foldDiacritics(s).replace(HOMOGLYPH_RE, ch => HOMOGLYPHS[ch]);
    s = s.replace(/[’'`´]/g, '').replace(/[“”„«»]/g, '"');
    return s.replace(/[ \t ]+/g, ' ');
  }

  /** Nur Buchstaben, Leetspeak aufgelöst – erkennt „W h a t s A p p“ oder „wh@tsapp“. */
  function squash(text) {
    return normalize(text)
      .replace(/[0-9@$]/g, ch => LEET[ch] || ch)
      .replace(/[^a-z]/g, '');
  }

  /** true, wenn direkt vor der Fundstelle eine Verneinung steht („kein WhatsApp“, „ohne Kurier“). */
  function isNegatedAt(normalizedText, index) {
    return NEGATION_BEFORE.test(normalizedText.slice(Math.max(0, index - 40), index));
  }

  // ---------------------------------------------------------------- HTML

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü',
    Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€', ndash: '–', mdash: '—', hellip: '…',
    bdquo: '„', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', shy: ''
  };

  function decodeEntities(text) {
    return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
      if (code.charAt(0) === '#') {
        const n = code.charAt(1).toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        try { return String.fromCodePoint(n); } catch (e) { return m; }
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, code) ? NAMED_ENTITIES[code] : m;
    });
  }

  /**
   * Wandelt HTML in lesbaren Text. Link-Ziele bleiben erhalten („hier <https://…>“) – wichtig,
   * weil Phishing-Links oft hinter harmlosem Linktext stecken. Die spitzen Klammern werden erst
   * nach dem Entfernen der Tags eingesetzt (Platzhalter \u0001/\u0002), sonst gingen sie mit verloren.
   */
  function htmlToText(html) {
    const text = String(html || '')
      .replace(/[\u0001\u0002]/g, '')
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
      .replace(/<a\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) =>
        label + (/^https?:/i.test(href) && label.indexOf(href) === -1 ? ' \u0001' + href + '\u0002' : ''))
      .replace(/<[^>]+>/g, '')
      .replace(/\u0001/g, '<')
      .replace(/\u0002/g, '>');
    return decodeEntities(text)
      .replace(/\r/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function stripTags(html) {
    return decodeEntities(String(html || '').replace(/<[^>]+>/g, ''));
  }

  // ---------------------------------------------------------------- Erkennung

  function urlRegex() { return new RegExp(URL_SOURCE, 'gi'); }

  /** Ein Treffer direkt nach „@“ o. Ä. ist Teil einer E-Mail-Adresse oder eines Wortes – kein Link. */
  function isUrlStart(str, offset) {
    return offset === 0 || !/[@\w.\-]/.test(str.charAt(offset - 1));
  }

  function extractUrls(text) {
    const s = String(text || '');
    const re = urlRegex();
    const out = [];
    const seen = {};
    let m;
    while ((m = re.exec(s)) !== null) {
      if (!isUrlStart(s, m.index)) continue;
      const url = m[0].replace(/[.,;:!?'"]+$/, '');
      const host = hostOf(url);
      const key = url.toLowerCase();
      if (!host || seen[key]) continue;
      seen[key] = true;
      out.push({ url: url, host: host });
    }
    return out;
  }

  /** Host eines Links – berücksichtigt Tricks wie „https://kleinanzeigen.de@evil.com/“. */
  function hostOf(url) {
    const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^\/?#\s]+)/i.exec(String(url || ''));
    if (!m) return '';
    const authority = m[1].slice(m[1].lastIndexOf('@') + 1);
    return authority.replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase().replace(/^www\./, '');
  }

  /** true, wenn host gleich einer der Domains oder eine Subdomain davon ist. */
  function hostMatches(host, domains) {
    const h = String(host || '').toLowerCase();
    return (domains || []).some(d => {
      const dd = String(d || '').toLowerCase().replace(/^\.+/, '');
      return Boolean(dd) && (h === dd || h.slice(-(dd.length + 1)) === '.' + dd);
    });
  }

  function countDigits(s) {
    return String(s).replace(/\D/g, '').length;
  }

  function isPhoneCandidate(match) {
    const digits = countDigits(match);
    if (digits < 9 || digits > 15) return false;
    return !/^\d{1,2}\.\d{1,2}\.\d{2,4}/.test(match); // Datum, keine Nummer
  }

  function isIbanCandidate(match) {
    return countDigits(match) >= 10;
  }

  function stripIbans(text) {
    return String(text || '').replace(new RegExp(IBAN_SOURCE, 'gi'), m => (isIbanCandidate(m) ? ' ' : m));
  }

  function extractPhones(text) {
    const s = stripIbans(text);
    const re = new RegExp(PHONE_SOURCE, 'g');
    const out = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      if (isPhoneCandidate(m[0])) out.push(m[0].trim());
    }
    return out;
  }

  /** Macht „max (at) gmail (punkt) com“ o. Ä. wieder zu einer erkennbaren Adresse. */
  function deobfuscateEmails(text) {
    return String(text || '')
      .replace(/\s*[(\[{]\s*(?:at|ät|@)\s*[)\]}]\s*/gi, '@')
      .replace(/\s*[(\[{]\s*(?:dot|punkt)\s*[)\]}]\s*/gi, '.')
      .replace(/\b([a-z0-9._-]+)\s+(?:at|ät)\s+([a-z0-9-]+)\s+(?:dot|punkt)\s+([a-z]{2,6})\b/gi, '$1@$2.$3');
  }

  function extractEmails(text) {
    const found = deobfuscateEmails(text).match(new RegExp(EMAIL_SOURCE, 'gi')) || [];
    const out = [];
    found.forEach(e => {
      const lower = e.toLowerCase();
      if (out.indexOf(lower) === -1) out.push(lower);
    });
    return out;
  }

  function extractIbans(text) {
    return (String(text || '').match(new RegExp(IBAN_SOURCE, 'gi')) || []).filter(isIbanCandidate);
  }

  // ---------------------------------------------------------------- Schwärzen & Entschärfen

  // Schlüsselwort + optionales „ist/lautet/:“ + Wert; der Wert wird ersetzt, das Schlüsselwort bleibt als Signal
  const SEP = '(\\s*(?:ist|lautet|:|=)?\\s*)';
  const WITH_DIGIT = '[a-z0-9-]*\\d[a-z0-9-]*';
  const CODE_VALUE = '[a-z0-9-]*\\d{3}[a-z0-9-]*';
  const SECRET_PATTERNS = [
    [new RegExp('\\b(passwort|kennwort|password|zugangsdaten)' + SEP + '(\\S{3,}?)(?=[.,;:!?]*(?:\\s|$))', 'gi'), '[GEHEIM]'],
    [new RegExp('\\b(cvv2?|cvc2?|kartenpr(?:ü|ue)fnummer|pr(?:ü|ue)fziffer|sicherheitscode|pin|tan|sms-?code|' +
      'best(?:ä|ae)tigungs-?code|verifizierungs-?code|einmal-?code|code)' + SEP + '(' + CODE_VALUE + ')', 'gi'), '[CODE]'],
    [new RegExp('\\b(g(?:ü|ue)ltig bis|ablaufdatum|valid thru|exp\\.?)' + SEP + '(\\d{1,2}\\s*\\/\\s*\\d{2,4})\\b', 'gi'), '[DATUM]'],
    [new RegExp('\\b(bic|swift)' + SEP + '([a-z]{6}[a-z0-9]{2}(?:[a-z0-9]{3})?)\\b', 'gi'), '[BIC]'],
    [new RegExp('\\b(kontonummer|konto-?nr\\.?|kto\\.?-?nr\\.?|blz|bankleitzahl)' + SEP + '(\\d[\\d ]{3,}\\d)', 'gi'), '[KONTO]'],
    [new RegExp('\\b((?:personal)?ausweis(?:-?nummer|-?nr\\.?)?|reisepass(?:-?nummer|-?nr\\.?)?|pass(?:-?nummer|-?nr\\.?)|' +
      'f(?:ü|ue)hrerschein(?:-?nummer|-?nr\\.?)?)' + SEP + '(' + WITH_DIGIT + '(?: ?' + WITH_DIGIT + '){0,3})', 'gi'), '[AUSWEIS]'],
    [new RegExp('\\b(sv-?nummer|sv-?nr\\.?|svnr|(?:sozial)?versicherungs-?(?:nummer|nr\\.?))' + SEP + '(\\d[\\d ]{8,12}\\d)', 'gi'), '[SVNR]'],
    [new RegExp('\\b(steuer-?id|steuer-?identifikationsnummer|steuernummer|ust-?id(?:-?nr\\.?)?|uid(?:-?nr\\.?)?)' + SEP +
      '([a-z]{0,3}[\\d\\/ ]{6,}\\d)', 'gi'), '[STEUERNR]']
  ];

  const CARD_SOURCE = '\\d(?:[ -]?\\d){12,18}(?!\\d)';

  function isLuhnValid(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits.charAt(digits.length - 1 - i));
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0;
  }

  /** Kreditkartennummern (Prüfsumme gültig); Telefonnummern beginnen mit 0 oder + und bleiben unberührt. */
  function redactCards(text) {
    return String(text || '').replace(new RegExp(CARD_SOURCE, 'g'), (m, offset, str) => {
      const digits = m.replace(/\D/g, '');
      const before = str.charAt(offset - 1);
      if (/[\d+]/.test(before) || digits.charAt(0) === '0' || !isLuhnValid(digits)) return m;
      return '[KARTENNUMMER]';
    });
  }

  /**
   * Finanz- und Zugangsdaten, die außer dem Inhaber niemand braucht (IBAN, Karte, Codes, Ausweis …).
   * Wird auch für die Telegram-Vorschau verwendet – der Originaltext bleibt in Gmail.
   */
  function redactSecrets(text) {
    let s = String(text || '').replace(new RegExp(IBAN_SOURCE, 'gi'), m => (isIbanCandidate(m) ? '[IBAN]' : m));
    s = redactCards(s);
    SECRET_PATTERNS.forEach(p => {
      s = s.replace(p[0], (m, keyword, sep) => keyword + (sep || ' ') + p[1]);
    });
    return s;
  }

  const NOT_LETTER_BEFORE = '(?<![A-Za-zÄÖÜäöüß])';
  const STREET_SUFFIX = 'stra(?:ß|ss)e|str\\.|gasse|weg|platz|allee|ring|damm|ufer|steig|zeile|promenade|kai|pfad|chaussee';
  const ADDRESS_RE = new RegExp(NOT_LETTER_BEFORE +
    '(?:[A-ZÄÖÜ][a-zäöüß]{2,}(?:-[A-ZÄÖÜ]?[a-zäöüß]+)*(?:' + STREET_SUFFIX + ')' +
    '|[A-ZÄÖÜ][a-zäöüß]+ (?:Stra(?:ß|ss)e|Str\\.|Gasse|Allee|Platz|Weg|Ring))' +
    '\\s*\\d{1,4}\\s?[a-z]?(?![\\wäöüß])(?:\\s*\\/\\s*\\d{1,4})*' +
    '(?!\\s*(?:[Mm]in(?:uten)?|[Ss]ek(?:unden)?|[Ss]td|[Ss]tunden|km|m|[Mm]eter|[Mm]al|[Ss]tück|[Ee]uro|€)(?![a-zäöüß]))', 'g');
  const BIRTHDATE_RE = new RegExp('\\b(geb\\.|geboren(?: am)?|geburtsdatum|geb\\.?-?datum|geburtstag)' +
    '(\\s*(?:ist|am|:)?\\s*)\\d{1,2}\\.\\s?\\d{1,2}\\.\\s?\\d{2,4}\\b', 'gi');
  const HANDLE_RE = /(^|[\s(„"'])@[a-z0-9_.]{3,30}\b/gim;

  const NAME_WORD = '[A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?';
  const NAMES = NAME_WORD + '(?: ' + NAME_WORD + '){0,2}';
  const INTRO_RE = new RegExp('((?:[Mm]ein [Nn]ame ist|[Ii]ch hei(?:ß|ss)e)\\s+)' + NAMES, 'g');
  const SIGNOFF_RE = new RegExp('((?:^|\\n)[ \\t]*(?:(?:[Vv]iele|[Ll]iebe|[Bb]este|[Ff]reundliche|[Hh]erzliche|[Mm]it freundlichen) )?' +
    '(?:[Gg]r(?:ü|ue|u)(?:ß|ss)e?|LG|VG|MfG|GLG|BG|lg|vg|mfg)[,.!]?(?:[ \\t]*\\n[ \\t]*|[ \\t]+))' + NAMES + '(?=[ \\t]*(?:\\n|$))', 'g');

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function redactNames(text, names) {
    let s = String(text || '');
    const known = [];
    const hasLetter = p => /[A-Za-zÄÖÜäöüß]/.test(p);
    (names || []).filter(Boolean).forEach(n => {
      const full = String(n).trim();
      if (full.length >= 2 && hasLetter(full)) known.push(full);
      full.split(/[\s_.-]+/).filter(p => p.length >= 3 && hasLetter(p)).forEach(p => known.push(p));
    });
    s = s.replace(INTRO_RE, '$1[NAME]').replace(SIGNOFF_RE, '$1[NAME]');
    known.sort((a, b) => b.length - a.length).forEach(n => {
      s = s.replace(new RegExp(NOT_LETTER_BEFORE + escapeRegex(n) + '(?![A-Za-zÄÖÜäöüß0-9_])', 'g'), '[NAME]');
    });
    return s;
  }

  /**
   * Ersetzt personenbezogene Daten durch Platzhalter, bevor Text an das LLM geht.
   * Das Signal bleibt erhalten („[TELEFONNUMMER]“ zeigt weiterhin einen Kontaktwechsel an).
   * @param {string[]=} names  bekannte Namen (z. B. Absender), die ebenfalls ersetzt werden
   */
  function redactPii(text, names) {
    let s = redactSecrets(text);
    s = deobfuscateEmails(s).replace(new RegExp(EMAIL_SOURCE, 'gi'), '[E-MAIL]');
    s = s.replace(urlRegex(), (m, offset, str) => (isUrlStart(str, offset) ? '[LINK: ' + hostOf(m) + ']' : m));
    s = s.replace(new RegExp(PHONE_SOURCE, 'g'), m => (isPhoneCandidate(m) ? '[TELEFONNUMMER]' : m));
    s = s.replace(HANDLE_RE, '$1[BENUTZERNAME]');
    s = s.replace(ADDRESS_RE, '[ADRESSE]')
      .replace(/(\[ADRESSE\],?\s*)(?:[A-Z]{1,2}-)?\d{4,5}\b/g, '$1[PLZ]')
      .replace(new RegExp('\\b(plz|postleitzahl)' + SEP + '\\d{4,5}\\b', 'gi'), '$1$2[PLZ]');
    s = s.replace(BIRTHDATE_RE, '$1$2[GEBURTSDATUM]');
    return redactNames(s, names);
  }

  /** Macht fremde Links unklickbar („hxxps://evil[.]com“). Erlaubte Domains bleiben unverändert. */
  function defangUrls(text, allowedDomains) {
    return String(text || '').replace(urlRegex(), (m, offset, str) => {
      if (!isUrlStart(str, offset)) return m;
      if (hostMatches(hostOf(m), allowedDomains)) return m;
      return m.replace(/^http/i, 'hxxp').replace(/\./g, '[.]');
    });
  }

  // ---------------------------------------------------------------- Formatierung

  function truncate(text, max) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    if (max <= 1) return s.slice(0, Math.max(0, max));
    let cut = s.slice(0, max - 1);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > max * 0.8) cut = cut.slice(0, lastSpace);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // kein halbes Emoji
    return cut.replace(/\s+$/, '') + '…';
  }

  function oneLine(text, max) {
    return truncate(String(text || '').replace(/\s+/g, ' ').trim(), max);
  }

  /** „1.200,50 €“, „150“, „150,-“, „1,200.50“ → Zahl (oder null). */
  function parseNumber(value) {
    if (typeof value === 'number') return isFinite(value) ? value : null;
    const m = /\d[\d.,\s]*/.exec(String(value == null ? '' : value));
    if (!m) return null;
    let s = m[0].replace(/\s/g, '').replace(/[.,]+$/, '');
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function formatEuro(amount) {
    const parts = (Math.round(amount * 100) / 100).toFixed(2).split('.');
    const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (parts[1] === '00' ? whole : whole + ',' + parts[1]) + ' €';
  }

  return {
    normalize, squash, isNegatedAt,
    escapeHtml, decodeEntities, htmlToText, stripTags,
    extractUrls, hostOf, hostMatches, extractPhones, extractEmails, extractIbans,
    redactPii, redactSecrets, defangUrls,
    truncate, oneLine, parseNumber, formatEuro
  };
})();
