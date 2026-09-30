'use strict';
/**
 * Lädt alle Apps-Script-Dateien wie in Apps Script in einen gemeinsamen globalen Kontext
 * und ersetzt die Google-Dienste (Gmail, UrlFetch, Properties, Cache …) durch Test-Doubles.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

const TEST_SECRETS = {
  OPENROUTER_API_KEY: 'sk-or-v1-testkey-0123456789abcdef',
  TELEGRAM_BOT_TOKEN: '123456789:AAtesttoken_abcdefghijklmnopqrstuvwxyz',
  TELEGRAM_CHAT_ID: '4242'
};

const DEFAULT_ANALYSIS = {
  intent: 'PREISVERHANDLUNG',
  summary: 'Fragt nach Verfügbarkeit und bietet 380 €, Abholung am Samstag.',
  offeredPrice: 380,
  logistics: 'ABHOLUNG',
  logisticsDetails: 'Samstagvormittag',
  paymentMethod: 'Bar',
  scamRisk: 'LOW',
  scamIndicators: [],
  replyDraft: 'Hallo Anna,\n\ndas Rennrad ist noch da. Bei 380 € kommen wir sicher zusammen – Samstagvormittag passt gut.\n\nViele Grüße'
};

function loadSources(file) {
  if (file) return fs.readFileSync(file, 'utf8');
  return fs.readdirSync(SRC_DIR)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => '// ---- ' + f + '\n' + fs.readFileSync(path.join(SRC_DIR, f), 'utf8'))
    .join('\n;\n');
}

function exportSnippet(code) {
  const names = new Set();
  const re = /^(?:const|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  return '\n;globalThis.__gas = {' + [...names].join(',') + '};';
}

// ---------------------------------------------------------------- Test-Doubles

function createProperties(initial) {
  const store = new Map(Object.entries(initial));
  const api = {
    getProperty: k => (store.has(k) ? store.get(k) : null),
    setProperty: (k, v) => { store.set(k, String(v)); return api; },
    deleteProperty: k => { store.delete(k); return api; },
    getProperties: () => Object.fromEntries(store)
  };
  return { store, api };
}

function createCache() {
  const store = new Map();
  return {
    store,
    api: {
      get: k => (store.has(k) ? store.get(k) : null),
      put: (k, v) => { store.set(k, String(v)); },
      remove: k => { store.delete(k); }
    }
  };
}

function createGmail(specs) {
  const labels = {};
  const drafts = [];
  const searches = [];
  const threadMap = new Map();

  specs.forEach((spec, i) => {
    const m = Object.assign({
      id: 'msg' + (i + 1),
      threadId: 't' + (i + 1),
      unread: true,
      date: new Date(Date.UTC(2026, 8, 24, 8, i)),
      replyTo: '',
      html: ''
    }, spec);
    if (!threadMap.has(m.threadId)) threadMap.set(m.threadId, { id: m.threadId, messages: [], labels: [] });
    const thread = threadMap.get(m.threadId);
    thread.messages.push({
      spec: m,
      getId: () => m.id,
      getFrom: () => m.from,
      getReplyTo: () => m.replyTo,
      getSubject: () => m.subject,
      getDate: () => m.date,
      getPlainBody: () => m.body,
      getBody: () => m.html || m.body,
      isUnread: () => m.unread,
      markRead: () => {
        if (m.failMarkRead) throw new Error('Gmail vorübergehend nicht erreichbar');
        m.unread = false;
      },
      createDraftReply: text => drafts.push({ id: m.id, text })
    });
  });

  const threads = [...threadMap.values()].map(t => ({
    raw: t,
    getId: () => t.id,
    getMessages: () => t.messages,
    getPermalink: () => 'https://mail.google.com/mail/u/0/#inbox/' + t.id,
    addLabel: label => { t.labels.push(label.getName()); }
  }));

  const latest = t => Math.max(...t.getMessages().map(msg => msg.getDate().getTime()));
  const api = {
    // wie Gmail: neueste Konversation zuerst
    search: (query, start, max) => {
      searches.push(query);
      const unreadOnly = /\bis:unread\b/.test(query);
      return threads
        .filter(t => !unreadOnly || t.getMessages().some(msg => msg.isUnread()))
        .sort((a, b) => latest(b) - latest(a))
        .slice(start || 0, (start || 0) + (max || 500));
    },
    getMessagesForThreads: list => list.map(t => t.getMessages()),
    getUserLabelByName: name => labels[name] || null,
    createLabel: name => (labels[name] = { getName: () => name })
  };

  const message = id => {
    for (const t of threads) for (const msg of t.getMessages()) if (msg.getId() === id) return msg.spec;
    return null;
  };
  const threadLabels = id => {
    const t = threads.find(x => x.getId() === id);
    return t ? t.raw.labels : [];
  };
  return { api, drafts, searches, message, threadLabels };
}

function llmResponse(content, model) {
  return {
    status: 200,
    body: {
      id: 'gen-1',
      model: model || 'google/gemma-4-31b-it:free',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50 }
    }
  };
}

function defaultRoute(options) {
  return (url, body) => {
    if (url.includes('api.telegram.org')) {
      if (url.endsWith('/getMe')) return { status: 200, body: { ok: true, result: { username: 'test_bot' } } };
      if (url.endsWith('/getUpdates')) return { status: 200, body: { ok: true, result: [] } };
      return { status: 200, body: { ok: true, result: { message_id: 1 } } };
    }
    if (url.endsWith('/chat/completions')) {
      const content = options.llmContent ? options.llmContent(body) : JSON.stringify(DEFAULT_ANALYSIS);
      return llmResponse(content, body.model);
    }
    if (url.endsWith('/api/v1/key')) {
      return { status: 200, body: { data: { is_free_tier: true, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } } };
    }
    if (url.endsWith('/api/v1/models')) {
      return { status: 200, body: { data: [{ id: 'google/gemma-4-31b-it:free', context_length: 262144, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['response_format'] }] } };
    }
    return { status: 404, body: { error: 'unbekannte URL ' + url } };
  };
}

function createFetch(route) {
  const calls = [];
  const api = {
    fetch(url, params) {
      const body = params && params.payload ? JSON.parse(params.payload) : null;
      calls.push({ url, params, body });
      const r = route(url, body, calls) || { status: 404, body: {} };
      if (r.throws) throw new Error(r.throws);
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {});
      return {
        getResponseCode: () => r.status || 200,
        getContentText: () => text,
        getAllHeaders: () => r.headers || {}
      };
    }
  };
  return { api, calls };
}

// ---------------------------------------------------------------- Umgebung

/**
 * @param {{props?: Object, mails?: Object[], route?: Function, llmContent?: Function, file?: string}} options
 *   route(url, body, calls) → {status, body, headers} | undefined (dann Standard-Route)
 */
function createEnv(options) {
  const o = options || {};
  const logs = [];
  const sleeps = [];
  const triggers = [];
  const props = createProperties(Object.assign({}, TEST_SECRETS, o.props || {}));
  const cache = createCache();
  const gmail = createGmail(o.mails || []);
  const fallback = defaultRoute(o);
  const http = createFetch((url, body, calls) => (o.route && o.route(url, body, calls)) || fallback(url, body, calls));

  const record = level => (...args) => logs.push({ level, text: args.join(' ') });
  const globals = {
    console: { log: record('log'), info: record('info'), warn: record('warn'), error: record('error') },
    PropertiesService: { getScriptProperties: () => props.api },
    CacheService: { getScriptCache: () => cache.api },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    Utilities: {
      sleep: ms => { sleeps.push(ms); },
      formatDate: d => d.toISOString().slice(8, 10) + '.' + d.toISOString().slice(5, 7) + '. ' + d.toISOString().slice(11, 16)
    },
    Session: { getScriptTimeZone: () => 'Europe/Berlin' },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: handler => {
        const builder = {
          timeBased: () => builder,
          everyMinutes: n => { builder.minutes = n; return builder; },
          create: () => {
            const t = { getHandlerFunction: () => handler, minutes: builder.minutes };
            triggers.push(t);
            return t;
          }
        };
        return builder;
      }
    },
    GmailApp: gmail.api,
    UrlFetchApp: http.api
  };

  const context = vm.createContext(globals);
  const code = loadSources(o.file);
  vm.runInContext(code + exportSnippet(code), context, { filename: o.file || 'gas-bundle.js' });

  return {
    gas: context.__gas,
    global: context,
    logs,
    sleeps,
    triggers,
    props: props.store,
    cache: cache.store,
    gmail,
    http,
    telegramMessages: () => http.calls.filter(c => c.url.includes('api.telegram.org') && c.url.endsWith('/sendMessage')).map(c => c.body),
    llmCalls: () => http.calls.filter(c => c.url.endsWith('/chat/completions')),
    logText: () => logs.map(l => l.level + ': ' + l.text).join('\n')
  };
}

module.exports = { createEnv, DEFAULT_ANALYSIS, TEST_SECRETS };
