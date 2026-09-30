/**
 * Telegram-Bot-API-Client.
 * - 429 (Flood Control): wartet die von Telegram genannte Zeit und versucht es erneut.
 * - 400 bei Formatierung/Buttons: sendet ersatzweise als Klartext ohne Buttons.
 * - 401/403/404, „chat not found“: fataler Konfigurationsfehler (Wiederholen zwecklos).
 */
const Telegram = (() => {
  const API_BASE = 'https://api.telegram.org/bot';
  const MAX_FLOOD_WAIT_S = 30;

  function isFatal(status, description) {
    return status === 401 || status === 403 || status === 404 ||
      /chat not found|bot was blocked|user is deactivated|bot was kicked/i.test(description);
  }

  function call(method, payload) {
    const url = API_BASE + Config.secret('TELEGRAM_BOT_TOKEN') + '/' + method;
    for (let attempt = 0; ; attempt++) {
      const res = Http.request({
        url: url,
        method: 'post',
        json: payload || {},
        retries: 2,
        retryOn: [500, 502, 503, 504],
        label: 'Telegram ' + method
      });
      const body = res.json || {};
      if (body.ok) return body.result;
      const retryAfter = body.parameters && body.parameters.retry_after;
      if (res.status === 429 && retryAfter && retryAfter <= MAX_FLOOD_WAIT_S && attempt < 2) {
        Log.warn('Telegram Flood-Limit – warte ' + retryAfter + ' s');
        Utilities.sleep(retryAfter * 1000);
        continue;
      }
      const description = body.description || 'HTTP ' + res.status;
      throw new TelegramError('Telegram ' + method + ': ' + description, {
        status: res.status,
        fatal: isFatal(res.status, description)
      });
    }
  }

  /**
   * @param {{text: string, replyMarkup?: Object, silent?: boolean, plain?: boolean}} notification
   */
  function sendMessage(notification) {
    const payload = {
      chat_id: Config.secret('TELEGRAM_CHAT_ID'),
      text: notification.text,
      link_preview_options: { is_disabled: true },
      disable_notification: Boolean(notification.silent)
    };
    if (!notification.plain) payload.parse_mode = 'HTML';
    if (notification.replyMarkup) payload.reply_markup = notification.replyMarkup;
    try {
      return call('sendMessage', payload);
    } catch (err) {
      if (!(err instanceof TelegramError) || err.status !== 400 || err.fatal || notification.plain) throw err;
      Log.warn('Telegram lehnte Formatierung/Buttons ab (' + err.message + ') – sende als Klartext.');
      return call('sendMessage', {
        chat_id: payload.chat_id,
        text: TextUtils.truncate(TextUtils.stripTags(notification.text), 4000),
        link_preview_options: { is_disabled: true },
        disable_notification: payload.disable_notification
      });
    }
  }

  function getMe() {
    return call('getMe', {});
  }

  function getUpdates() {
    return call('getUpdates', { limit: 50, timeout: 0 }) || [];
  }

  return { sendMessage, getMe, getUpdates };
})();
