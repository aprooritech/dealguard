/**
 * Persistenter Zustand (Script Properties, Schlüssel STATE_V1):
 * - done:     zuletzt verarbeitete Gmail-Nachrichten-IDs (Idempotenz: keine doppelten Pushes,
 *             selbst wenn das Als-gelesen-Markieren nach dem Versand scheitert)
 * - attempts: fehlgeschlagene Zustellversuche je Nachricht
 * Größenbegrenzt, damit das 9-KB-Limit pro Property nie erreicht wird.
 */
const StateStore = (() => {
  const KEY = 'STATE_V1';
  const MAX_DONE = 400;
  const MAX_ATTEMPT_ENTRIES = 100;

  function load() {
    const props = PropertiesService.getScriptProperties();
    let data = { done: [], attempts: {} };
    const raw = props.getProperty(KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.done)) data = { done: parsed.done, attempts: parsed.attempts || {} };
      } catch (e) {
        Log.warn('Gespeicherter Zustand ist beschädigt und wird zurückgesetzt.');
      }
    }
    const doneSet = {};
    data.done.forEach(id => { doneSet[id] = true; });
    let dirty = false;

    return {
      isDone: id => doneSet[id] === true,
      markDone(id) {
        if (doneSet[id]) return;
        doneSet[id] = true;
        data.done.push(id);
        while (data.done.length > MAX_DONE) delete doneSet[data.done.shift()];
        dirty = true;
      },
      attempts: id => data.attempts[id] || 0,
      incrementAttempts(id) {
        data.attempts[id] = (data.attempts[id] || 0) + 1;
        const ids = Object.keys(data.attempts);
        if (ids.length > MAX_ATTEMPT_ENTRIES) delete data.attempts[ids[0]];
        dirty = true;
        return data.attempts[id];
      },
      clearAttempts(id) {
        if (data.attempts[id] === undefined) return;
        delete data.attempts[id];
        dirty = true;
      },
      save() {
        if (!dirty) return;
        props.setProperty(KEY, JSON.stringify(data));
        dirty = false;
      }
    };
  }

  function reset() {
    PropertiesService.getScriptProperties().deleteProperty(KEY);
  }

  return { KEY, load, reset };
})();
