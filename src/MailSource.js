/**
 * Gmail-Adapter: kapselt alle GmailApp-Zugriffe. Der Rest der Pipeline arbeitet
 * mit einfachen Objekten (toInput) und ist dadurch ohne Gmail testbar.
 */
const MailSource = (() => {
  const MAX_SEARCH_PAGES = 3;
  const labelCache = {};

  function label(name) {
    if (!labelCache[name]) labelCache[name] = GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
    return labelCache[name];
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  }

  /**
   * Ungelesene, noch nicht verarbeitete Nachrichten aus den Treffern von GMAIL_QUERY, älteste zuerst.
   *
   * Übersprungene System-Mails bleiben bewusst ungelesen und damit Suchtreffer. Damit sie eine
   * ältere Käufernachricht nicht aus dem Suchfenster verdrängen, wird begrenzt weitergeblättert,
   * solange eine volle Seite nichts Neues enthielt.
   * @return {{thread: GmailThread, message: GmailMessage}[]}
   */
  function findCandidates(cfg, state) {
    const pageSize = cfg.MAX_THREADS_PER_RUN;
    const items = [];
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const threads = GmailApp.search(cfg.GMAIL_QUERY, page * pageSize, pageSize);
      const messagesPerThread = threads.length ? GmailApp.getMessagesForThreads(threads) : [];
      threads.forEach((thread, i) => {
        messagesPerThread[i].forEach(message => {
          if (message.isUnread() && !state.isDone(message.getId())) items.push({ thread: thread, message: message });
        });
      });
      if (threads.length < pageSize || items.length) break;
    }
    items.sort((a, b) => a.message.getDate().getTime() - b.message.getDate().getTime());
    return items;
  }

  /** Neueste passende Nachricht – auch bereits gelesene (für Diagnose/Tests). */
  function findLatest(cfg) {
    const query = cfg.GMAIL_QUERY.replace(/\bis:unread\b/gi, '').replace(/\s+/g, ' ').trim();
    const threads = GmailApp.search(query, 0, 1);
    if (!threads.length) return null;
    const messages = threads[0].getMessages();
    return { thread: threads[0], message: messages[messages.length - 1] };
  }

  function toInput(item) {
    const m = item.message;
    const plain = m.getPlainBody() || '';
    return {
      id: m.getId(),
      threadId: item.thread.getId(),
      subject: m.getSubject() || '',
      from: m.getFrom() || '',
      replyTo: safe(() => m.getReplyTo(), '') || '',
      date: m.getDate(),
      plainBody: plain,
      htmlBody: plain.trim().length < 20 ? m.getBody() || '' : '',
      permalink: safe(() => item.thread.getPermalink(), '') || ''
    };
  }

  function markProcessed(item, cfg) {
    item.message.markRead();
    if (cfg.PROCESSED_LABEL) item.thread.addLabel(label(cfg.PROCESSED_LABEL));
  }

  /** Aufgegebene Nachricht: bleibt ungelesen (du wurdest ja nicht benachrichtigt), bekommt aber ein Label. */
  function markFailed(item, cfg) {
    if (cfg.FAILED_LABEL) item.thread.addLabel(label(cfg.FAILED_LABEL));
  }

  function createDraftReply(item, text) {
    item.message.createDraftReply(text);
  }

  return { findCandidates, findLatest, toInput, markProcessed, markFailed, createDraftReply };
})();
