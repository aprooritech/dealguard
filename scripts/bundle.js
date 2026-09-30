'use strict';
/**
 * Bündelt src/*.js zu dist/Code.gs – für die Einrichtung per Copy & Paste im
 * Apps-Script-Editor (eine Datei statt 22). Mit clasp ist das nicht nötig.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

// Lesereihenfolge (fachlich); Module greifen erst zur Laufzeit aufeinander zu,
// daher ist die Reihenfolge für die Funktion egal – neue Dateien landen alphabetisch am Ende.
const ORDER = [
  'Main.js', 'Pipeline.js', 'MailSource.js', 'MessageParser.js', 'Platforms.js', 'ScamRules.js',
  'RiskEngine.js', 'HeuristicAnalyzer.js', 'Prompt.js', 'AnalysisParser.js', 'OpenRouter.js',
  'ReplyPolicy.js', 'NotificationFormatter.js', 'Telegram.js', 'Alerts.js', 'StateStore.js',
  'Http.js', 'TextUtils.js', 'Config.js', 'Log.js', 'Core.js', 'Samples.js'
];

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.js'));
const ordered = ORDER.filter(f => files.includes(f)).concat(files.filter(f => !ORDER.includes(f)).sort());

const header = [
  '/**',
  ' * Marktplatz-Assistent – gebündelte Fassung für den Apps-Script-Editor.',
  ' * Automatisch erzeugt mit `npm run bundle` aus src/*.js – Änderungen bitte dort vornehmen.',
  ' */',
  ''
].join('\n');

const body = ordered
  .map(f => '// ' + '='.repeat(70) + '\n// ' + f + '\n// ' + '='.repeat(70) + '\n' + fs.readFileSync(path.join(SRC, f), 'utf8').trim() + '\n')
  .join('\n');

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'Code.gs'), header + body);
fs.copyFileSync(path.join(SRC, 'appsscript.json'), path.join(DIST, 'appsscript.json'));
console.log('dist/Code.gs geschrieben (' + ordered.length + ' Module, ' + Math.round((header + body).length / 1024) + ' KB)');
