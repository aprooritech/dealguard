'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./helpers/gas');

const { gas } = createEnv();
const { NotificationFormatter, ReplyPolicy, MessageParser, RiskEngine, Config, Samples } = gas;
const cfg = Config.load();

function mailFor(sampleIndex) {
  return MessageParser.parse(Object.assign(Samples.toInput(Samples.LIST[sampleIndex], sampleIndex), {
    permalink: 'https://mail.google.com/mail/u/0/#inbox/t1',
    date: new Date(Date.UTC(2026, 8, 24, 12, 30))
  }), cfg);
}

function resultFor(mail, overrides) {
  const rules = RiskEngine.evaluate(mail.text, { allowedDomains: mail.allowedDomains });
  const risk = RiskEngine.combine(rules, null);
  const fields = { intent: 'PREISVERHANDLUNG', summary: null, offeredPrice: 380, logistics: 'ABHOLUNG', logisticsDetails: 'Samstag', paymentMethod: 'Bar' };
  const reply = ReplyPolicy.decide({ mail, risk, fields, cfg, llmReply: null });
  return Object.assign({ fields, risk, reply, llm: { used: false, model: null, note: 'deaktiviert' } }, overrides);
}

describe('ReplyPolicy', () => {
  const mail = mailFor(0);
  const lowRisk = { level: 'LOW' };
  const fields = { intent: 'PREISVERHANDLUNG', offeredPrice: 380, logistics: 'ABHOLUNG' };

  it('übernimmt einen unbedenklichen KI-Entwurf', () => {
    const r = ReplyPolicy.decide({ mail, risk: lowRisk, fields, cfg, llmReply: 'Hallo Anna,\n\nja, das Rad ist noch da.\n\nViele Grüße' });
    assert.equal(r.source, 'LLM');
  });

  it('verwirft KI-Entwürfe mit Links, Nummern oder Mailadressen (z. B. nach Prompt-Injection)', () => {
    const bad = [
      'Hallo, bezahl einfach hier: https://pay-me.shop/x Viele Grüße',
      'Hallo, schreib mir auf 0176 12345678. Viele Grüße',
      'Hallo, meine Mail ist verkaeufer@gmail.com. Viele Grüße'
    ];
    bad.forEach(text => {
      const r = ReplyPolicy.decide({ mail, risk: lowRisk, fields, cfg, llmReply: text });
      assert.equal(r.source, 'TEMPLATE', text);
      assert.ok(r.rejected.length > 0);
    });
  });

  it('nutzt bei hohem Risiko immer die Sicherheitsvorlage', () => {
    const r = ReplyPolicy.decide({ mail, risk: { level: 'HIGH' }, fields, cfg, llmReply: 'Klar, schick mir den Kurier!' });
    assert.equal(r.source, 'SAFETY_TEMPLATE');
    assert.match(r.text, /^Hallo Anna,/);
    assert.match(r.text, /ausschließlich hier über Kleinanzeigen/);
  });

  it('baut ohne KI eine passende Vorlage (du/Sie)', () => {
    const du = ReplyPolicy.decide({ mail, risk: lowRisk, fields, cfg, llmReply: null });
    assert.match(du.text, /Deinen Preisvorschlag von 380 €/);
    assert.match(du.text, /wann würde es dir passen\?/);
    const sieCfg = Object.assign({}, cfg, { FORM_OF_ADDRESS: 'Sie', SELLER_NAME: 'Luis' });
    const sie = ReplyPolicy.decide({ mail, risk: lowRisk, fields, cfg: sieCfg, llmReply: null });
    assert.match(sie.text, /Ihren Preisvorschlag/);
    assert.match(sie.text, /Viele Grüße\nLuis$/);
  });
});

describe('NotificationFormatter', () => {
  it('zeigt Risiko, Kerndaten, Antwort und Buttons', () => {
    const mail = mailFor(0);
    const n = NotificationFormatter.format(mail, resultFor(mail), {});
    assert.match(n.text, /^🟢 <b>Unauffällig<\/b> · Kleinanzeigen/);
    assert.match(n.text, /📌 <b>Rennrad Cube Attain, 56 cm<\/b>/);
    assert.match(n.text, /💶 <b>Angebot:<\/b> 380 €/);
    assert.match(n.text, /🚚 <b>Logistik:<\/b> Abholung – Samstag/);
    assert.match(n.text, /<pre>Hallo Anna,/);
    const buttons = JSON.parse(JSON.stringify(n.replyMarkup.inline_keyboard));
    assert.equal(buttons[0][0].copy_text.text.startsWith('Hallo Anna,'), true);
    assert.equal(buttons[1][0].url, 'https://mail.google.com/mail/u/0/#inbox/t1');
  });

  it('warnt bei Scam deutlich und entschärft den Phishing-Link', () => {
    const mail = mailFor(2);
    const n = NotificationFormatter.format(mail, resultFor(mail), { test: true });
    assert.match(n.text, /^🧪 <b>TEST<\/b> · 🔴 <b>HOHES RISIKO<\/b>/);
    assert.match(n.text, /Link auf gefälschte Plattform-\/Zahlungsseite <code>kleinanzeigen-sicher-bezahlen\[\.\]shop<\/code>/);
    assert.match(n.text, /🛑 <b>Empfehlung:<\/b>/);
    assert.match(n.text, /hxxps:\/\/kleinanzeigen-sicher-bezahlen\[\.\]shop/);
    assert.ok(!n.text.includes('https://kleinanzeigen-sicher-bezahlen.shop'));
  });

  it('escaped HTML aus dem Käufertext', () => {
    const mail = Object.assign(mailFor(0), { text: '<b>fett</b> & <script>alert(1)</script>', senderName: '<i>Eve</i>' });
    const n = NotificationFormatter.format(mail, resultFor(mail), {});
    assert.ok(n.text.includes('&lt;b&gt;fett&lt;/b&gt; &amp; &lt;script&gt;'));
    assert.ok(n.text.includes('👤 &lt;i&gt;Eve&lt;/i&gt;'));
    assert.ok(!n.text.includes('<script>'));
  });

  it('hält das Telegram-Limit von 4096 Zeichen ein', () => {
    const mail = Object.assign(mailFor(0), { text: 'Sehr lange Nachricht. '.repeat(600) });
    const result = resultFor(mail);
    result.reply = { text: 'Antwort '.repeat(180), source: 'LLM', rejected: [] };
    const n = NotificationFormatter.format(mail, result, {});
    assert.ok(n.text.length <= 4096, 'Länge ' + n.text.length);
    assert.equal(n.plain, false);
    // Antwort > 256 Zeichen → kein Kopier-Button (Telegram-Limit), aber Gmail-Button bleibt
    const rows = JSON.parse(JSON.stringify(n.replyMarkup.inline_keyboard));
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0].text, '📧 In Gmail öffnen');
  });

  it('kennzeichnet unsichere Extraktion und Notbetrieb', () => {
    const mail = Object.assign(mailFor(0), { extraction: 'VOLLTEXT' });
    const n = NotificationFormatter.format(mail, resultFor(mail, { llm: { used: false, model: null, note: 'pausiert – Tageslimit der Gratis-Modelle' } }), {});
    assert.match(n.text, /nicht sicher erkannt/);
    assert.match(n.text, /KI: pausiert – Tageslimit der Gratis-Modelle · Antwort: Vorlage/);
  });
});
