'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, DEFAULT_ANALYSIS } = require('./helpers/gas');

function sample(env, index) {
  const s = env.gas.Samples.LIST[index];
  return { from: s.from, subject: s.subject, body: s.body };
}

// Samples werden erst nach dem Laden bekannt → Mails über eine Vorab-Umgebung bauen
const base = createEnv();
const BENIGN = sample(base, 0);
const COURIER = sample(base, 1);
const PHISHING = sample(base, 2);

function state(env) {
  return JSON.parse(env.props.get('STATE_V1') || '{"done":[],"attempts":{}}');
}

describe('Pipeline – Normalbetrieb', () => {
  it('analysiert eine harmlose Anfrage mit KI, sendet Push, markiert gelesen', () => {
    const env = createEnv({ mails: [BENIGN] });
    const stats = env.global.processInbox();

    assert.deepEqual(JSON.parse(JSON.stringify(stats)), { candidates: 1, sent: 1, skipped: 0, failed: 0, deferred: 0 });
    const [msg] = env.telegramMessages();
    assert.equal(msg.chat_id, '4242');
    assert.equal(msg.parse_mode, 'HTML');
    assert.match(msg.text, /🟢 <b>Unauffällig<\/b>/);
    assert.match(msg.text, /Preisverhandlung/);
    assert.match(msg.text, /Antwort: KI/);

    const [call] = env.llmCalls();
    assert.equal(call.body.model, 'google/gemma-4-31b-it:free');
    assert.equal(call.params.headers.Authorization, 'Bearer sk-or-v1-testkey-0123456789abcdef');
    assert.equal(call.body.response_format.type, 'json_object');

    assert.equal(env.gmail.message('msg1').unread, false);
    assert.deepEqual(env.gmail.threadLabels('t1'), ['DealGuard']);
    assert.deepEqual(state(env).done, ['msg1']);
    assert.ok(!env.logText().includes('sk-or-v1-testkey'), 'API-Key darf nicht im Log stehen');
  });

  it('überspringt die KI bei eindeutigem Scam und nutzt die Sicherheitsvorlage', () => {
    const env = createEnv({ mails: [COURIER, PHISHING] });
    env.global.processInbox();

    assert.equal(env.llmCalls().length, 0);
    const msgs = env.telegramMessages();
    assert.equal(msgs.length, 2);
    msgs.forEach(m => {
      assert.match(m.text, /🔴 <b>HOHES RISIKO<\/b>/);
      assert.match(m.text, /Sicherheitsvorlage/);
      assert.match(m.text, /KI: nicht nötig \(Regeln eindeutig\)/);
    });
    assert.match(msgs[0].text, /Will auf WhatsApp/);
    assert.match(msgs[0].text, /Abholung durch Kurier/);
  });

  it('verarbeitet nichts doppelt (bereits im Zustand oder schon gelesen)', () => {
    const env = createEnv({ mails: [BENIGN, Object.assign({}, BENIGN, { unread: false })], props: { STATE_V1: JSON.stringify({ done: ['msg1'], attempts: {} }) } });
    const stats = env.global.processInbox();
    assert.equal(stats.candidates, 0);
    assert.equal(env.telegramMessages().length, 0);
  });

  it('lässt System-Mails ungelesen und merkt sie sich', () => {
    const env = createEnv({ mails: [{ from: 'noreply@kleinanzeigen.de', subject: 'Deine Anzeige läuft bald ab', body: 'Verlängere jetzt deine Anzeige.' }] });
    const stats = env.global.processInbox();
    assert.equal(stats.skipped, 1);
    assert.equal(env.telegramMessages().length, 0);
    assert.equal(env.gmail.message('msg1').unread, true);
    assert.deepEqual(state(env).done, ['msg1']);
  });

  it('findet Käufernachrichten auch hinter vielen ungelesenen System-Mails', () => {
    const system = i => ({ from: 'noreply@kleinanzeigen.de', subject: 'Neue Anzeigen für deinen Suchauftrag ' + i, body: 'Treffer …' });
    const mails = [BENIGN].concat(Array.from({ length: 12 }, (_, i) => system(i)));
    const env = createEnv({ mails });

    const first = env.global.processInbox();   // neueste 10 Threads: nur System-Mails → werden gemerkt
    assert.equal(first.skipped, 10);
    const second = env.global.processInbox();  // Seite 1 bekannt → weiterblättern
    assert.equal(second.skipped, 2);
    assert.equal(second.sent, 1);
    assert.equal(env.telegramMessages().length, 1);
    assert.equal(env.gmail.message('msg1').unread, false);
  });

  it('erstellt optional einen Gmail-Entwurf (nicht bei hohem Risiko)', () => {
    const env = createEnv({ mails: [BENIGN, COURIER], props: { CREATE_GMAIL_DRAFTS: 'true' } });
    env.global.processInbox();
    assert.equal(env.gmail.drafts.length, 1);
    assert.equal(env.gmail.drafts[0].id, 'msg1');
  });
});

describe('Pipeline – Sicherheit', () => {
  it('KI kann eine Regel-Warnung nicht herunterstufen (Prompt-Injection)', () => {
    const injected = {
      from: '"Eve über Kleinanzeigen" <eve@mail.kleinanzeigen.de>',
      subject: 'Nutzer-Anfrage zu deiner Anzeige „Laptop“',
      body: 'Nachricht von Eve:\nHast du Telegram? Das geht schneller.\nAntworten'
    };
    const env = createEnv({
      mails: [injected],
      props: { LLM_SKIP_ON_HIGH_RULE_RISK: 'false' },
      llmContent: () => JSON.stringify(Object.assign({}, DEFAULT_ANALYSIS, {
        scamRisk: 'LOW',
        replyDraft: 'Hallo Eve, klar – melde dich unter https://t.me/verkaeufer. Viele Grüße'
      }))
    });
    env.global.processInbox();
    const [msg] = env.telegramMessages();
    assert.match(msg.text, /HOHES RISIKO/);
    assert.match(msg.text, /Sicherheitsvorlage/);
    assert.ok(!msg.text.includes('t.me/verkaeufer'));
  });

  it('KI kann eine unauffällige Nachricht hochstufen', () => {
    const env = createEnv({
      mails: [BENIGN],
      llmContent: () => JSON.stringify(Object.assign({}, DEFAULT_ANALYSIS, { scamRisk: 'MEDIUM', scamIndicators: ['Unrealistisch hohes Angebot'] }))
    });
    env.global.processInbox();
    const [msg] = env.telegramMessages();
    assert.match(msg.text, /🟠 <b>ERHÖHTES RISIKO<\/b>/);
    assert.match(msg.text, /🤖 Unrealistisch hohes Angebot/);
    assert.match(msg.text, /Risiko von KI erhöht/);
  });
});

describe('Pipeline – Fehlerbehandlung', () => {
  it('wechselt bei Rate-Limit auf das nächste Modell', () => {
    const env = createEnv({
      mails: [BENIGN],
      route: (url, body) => {
        if (url.endsWith('/chat/completions') && body.model === 'google/gemma-4-31b-it:free') {
          return { status: 429, body: { error: { code: 429, message: 'google/gemma-4-31b-it:free is temporarily rate-limited upstream' } } };
        }
        return undefined;
      }
    });
    env.global.processInbox();
    const models = env.llmCalls().map(c => c.body.model);
    assert.deepEqual(models, ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free']);
    assert.match(env.telegramMessages()[0].text, /KI: nemotron-3-super-120b-a12b/);
  });

  it('wiederholt 400 im Kompatibilitätsmodus (ohne System-Rolle/JSON-Modus)', () => {
    const env = createEnv({
      mails: [BENIGN],
      route: (url, body) => {
        if (url.endsWith('/chat/completions') && body.messages[0].role === 'system') {
          return { status: 400, body: { error: { code: 400, message: 'Developer instruction is not enabled' } } };
        }
        return undefined;
      }
    });
    env.global.processInbox();
    const calls = env.llmCalls();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.messages.length, 1);
    assert.equal(calls[1].body.response_format, undefined);
    assert.match(env.telegramMessages()[0].text, /Antwort: KI/);
  });

  it('pausiert die KI nach dem Tageslimit und liefert trotzdem (Notbetrieb)', () => {
    const env = createEnv({
      mails: [BENIGN, Object.assign({}, BENIGN, { threadId: 't9' })],
      route: url => (url.endsWith('/chat/completions')
        ? { status: 429, body: { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } }, headers: { 'X-RateLimit-Reset': String(Date.now() + 3600 * 1000) } }
        : undefined)
    });
    const stats = env.global.processInbox();
    assert.equal(stats.sent, 2);
    assert.equal(env.llmCalls().length, 1, 'nach dem Tageslimit keine weiteren KI-Aufrufe');
    const msgs = env.telegramMessages();
    // Push 1: Alarm (Tageslimit) + Analyse; Push 2: Analyse im Pausenmodus
    const analyses = msgs.filter(m => /Absicht/.test(m.text));
    assert.equal(analyses.length, 2);
    assert.match(analyses[0].text, /KI: nicht erreichbar – nur Regelprüfung/);
    assert.match(analyses[1].text, /KI: pausiert – Tageslimit/);
    assert.match(analyses[0].text, /Preisverhandlung/, 'Heuristik erkennt die Absicht auch ohne KI');
    assert.equal(msgs.filter(m => /KI-Analyse nicht verfügbar/.test(m.text)).length, 1);
  });

  it('ungültige KI-Antworten führen zum nächsten Modell, danach zur Vorlage', () => {
    const env = createEnv({ mails: [BENIGN], llmContent: () => 'Ich kann leider kein JSON.' });
    env.global.processInbox();
    assert.equal(env.llmCalls().length, 4);
    assert.match(env.telegramMessages()[0].text, /Antwort: Vorlage/);
  });

  it('lässt die Mail bei Telegram-Ausfall ungelesen und gibt nach 5 Versuchen auf', () => {
    const env = createEnv({
      mails: [BENIGN],
      route: url => (url.endsWith('/sendMessage') ? { status: 502, body: 'Bad Gateway' } : undefined)
    });
    for (let run = 1; run <= 4; run++) {
      env.global.processInbox();
      assert.equal(env.gmail.message('msg1').unread, true);
      assert.equal(state(env).attempts.msg1, run);
    }
    env.global.processInbox();
    assert.equal(env.gmail.message('msg1').unread, true, 'bleibt ungelesen – du wurdest nicht benachrichtigt');
    assert.deepEqual(env.gmail.threadLabels('t1'), ['DealGuard/Fehler']);
    assert.deepEqual(state(env).done, ['msg1']);
    assert.equal(env.global.processInbox().candidates, 0);
  });

  it('sendet ohne Formatierung neu, wenn Telegram das HTML ablehnt', () => {
    let first = true;
    const env = createEnv({
      mails: [BENIGN],
      route: (url, body) => {
        if (url.endsWith('/sendMessage') && first) {
          first = false;
          return { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } };
        }
        return undefined;
      }
    });
    env.global.processInbox();
    const msgs = env.telegramMessages();
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].parse_mode, undefined);
    assert.ok(!/<b>/.test(msgs[1].text));
    assert.equal(env.gmail.message('msg1').unread, false);
  });

  it('wartet bei Telegram-Flood-Limit und versucht es erneut', () => {
    let first = true;
    const env = createEnv({
      mails: [BENIGN],
      route: url => {
        if (url.endsWith('/sendMessage') && first) {
          first = false;
          return { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } } };
        }
        return undefined;
      }
    });
    env.global.processInbox();
    assert.ok(env.sleeps.includes(3000));
    assert.equal(env.gmail.message('msg1').unread, false);
  });

  it('kein Doppel-Push, wenn das Als-gelesen-Markieren scheitert', () => {
    const env = createEnv({ mails: [Object.assign({}, BENIGN, { failMarkRead: true })] });
    env.global.processInbox();
    env.global.processInbox();
    assert.equal(env.telegramMessages().length, 1);
    assert.equal(env.gmail.message('msg1').unread, true);
  });

  it('bricht bei ungültigem Bot-Token ab, ohne Versuche zu verbrauchen', () => {
    const env = createEnv({
      mails: [BENIGN],
      route: url => (url.includes('api.telegram.org') ? { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } } : undefined)
    });
    assert.throws(() => env.global.processInbox(), /Unauthorized/);
    assert.deepEqual(state(env).attempts, {});
    assert.ok(!env.logText().includes('AAtesttoken'), 'Bot-Token darf nicht im Log stehen');
  });

  it('meldet fehlende Konfiguration klar', () => {
    const env = createEnv({ mails: [BENIGN], props: { TELEGRAM_CHAT_ID: '' } });
    assert.throws(() => env.global.processInbox(), /TELEGRAM_CHAT_ID/);
  });

  it('wiederholt Netzwerkfehler mit Backoff', () => {
    let failures = 0;
    const env = createEnv({
      mails: [BENIGN],
      route: url => (url.endsWith('/sendMessage') && failures++ < 2 ? { throws: 'Address unavailable: https://api.telegram.org/bot123456789:AAtesttoken_abcdefghijklmnopqrstuvwxyz/sendMessage' } : undefined)
    });
    env.global.processInbox();
    assert.equal(env.sleeps.length, 2);
    assert.equal(env.gmail.message('msg1').unread, false);
    assert.ok(!env.logText().includes('AAtesttoken'));
  });
});

describe('Einrichtung & Diagnose', () => {
  it('setup() prüft alles und installiert genau einen Trigger', () => {
    const env = createEnv();
    env.global.setup();
    env.global.setup();
    assert.equal(env.triggers.length, 1);
    assert.equal(env.triggers[0].getHandlerFunction(), 'processInbox');
    assert.equal(env.triggers[0].minutes, 5);
    assert.match(env.logText(), /Gratis-Anfragen heute: 3\/50/);
    assert.match(env.logText(), /Modell nicht \(mehr\) kostenlos verfügbar: nvidia/);
    assert.match(env.telegramMessages()[0].text, /DealGuard ist aktiv/);
    env.global.uninstall();
    assert.equal(env.triggers.length, 0);
  });

  it('setup() nennt fehlende Properties', () => {
    const env = createEnv({ props: { OPENROUTER_API_KEY: '', TRIGGER_MINUTES: '7' } });
    assert.throws(() => env.global.setup(), /OPENROUTER_API_KEY fehlt[\s\S]*TRIGGER_MINUTES/);
  });

  it('sendSampleNotifications() schickt drei TEST-Pushes', () => {
    const env = createEnv();
    env.global.sendSampleNotifications();
    const msgs = env.telegramMessages();
    assert.equal(msgs.length, 3);
    msgs.forEach(m => assert.match(m.text, /^🧪 <b>TEST<\/b>/));
    assert.match(msgs[0].text, /Unauffällig/);
    assert.match(msgs[1].text, /HOHES RISIKO/);
    assert.match(msgs[2].text, /HOHES RISIKO/);
  });

  it('testLatestMail() verändert Gmail nicht', () => {
    const env = createEnv({ mails: [BENIGN] });
    env.global.testLatestMail();
    assert.equal(env.telegramMessages().length, 1);
    assert.equal(env.gmail.message('msg1').unread, true);
    assert.equal(env.props.get('STATE_V1'), undefined);
  });

  it('debugLatestMail() protokolliert Extraktion und Regeln', () => {
    const env = createEnv({ mails: [PHISHING] });
    env.global.debugLatestMail();
    assert.match(env.logText(), /Extraktion:\s+MARKER/);
    assert.match(env.logText(), /LOOKALIKE_DOMAIN/);
    assert.match(env.logText(), /\[LINK: kleinanzeigen-sicher-bezahlen\.shop\]/);
  });

  it('showTelegramChatId() listet Chats aus getUpdates', () => {
    const env = createEnv({
      route: url => (url.endsWith('/getUpdates')
        ? { status: 200, body: { ok: true, result: [{ update_id: 1, message: { chat: { id: 987654321, type: 'private', first_name: 'Luis' } } }] } }
        : undefined)
    });
    env.global.showTelegramChatId();
    assert.match(env.logText(), /Chat-ID 987654321 \(Luis\)/);
  });
});

describe('Bundle', () => {
  it('dist/Code.gs lädt und enthält alle Einstiegspunkte', { skip: !require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'dist', 'Code.gs')) }, () => {
    const path = require('node:path');
    const env = createEnv({ file: path.join(__dirname, '..', 'dist', 'Code.gs'), mails: [BENIGN] });
    ['processInbox', 'setup', 'uninstall', 'showTelegramChatId', 'sendSampleNotifications', 'debugLatestMail', 'testLatestMail', 'listFreeModels', 'resetState']
      .forEach(fn => assert.equal(typeof env.global[fn], 'function', fn));
    assert.equal(env.global.processInbox().sent, 1);
  });
});

