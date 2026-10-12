// Twitch EventSub lifecycle, isolated from Electron for deterministic transport tests.
const REWARD_TYPE = 'channel.channel_points_custom_reward_redemption.add';
const CHAT_MESSAGE_TYPE = 'channel.chat.message';
const RECONNECT_URL = 'https://teammidnite.tv/NeonLogin/auth/twitch.php?link=1';

class TwitchRedemptions {
  constructor({ WebSocket, broker, emit, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { WebSocket, broker, emit, setTimer, clearTimer });
    this.sockets = new Set();
    this.seen = new Set();
    this.generation = 0;
    this.attempt = 0;
    this.failureNoticeKey = '';
    this.disconnectedNoticeShown = false;
  }

  connect({ retry = false } = {}) {
    this.enabled = true;
    if (!retry) {
      this.failureNoticeKey = '';
      this.disconnectedNoticeShown = false;
    }
    if (this.connected) return Promise.resolve({ connected: true });
    if (this.pending) return this.pending;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    const generation = this.generation;
    const pending = this.start(generation);
    this.pending = pending;
    pending.finally(() => { if (this.pending === pending) this.pending = null; });
    return pending;
  }

  async start(generation) {
    try {
      this.capabilities = await this.broker('status') || {};
      // The production broker exposes can_read_chat; retain the older name
      // for compatibility with existing brokers.
      this.capabilities.can_chat = this.capabilities.can_read_chat ?? this.capabilities.can_chat;
      if (!this.enabled || generation !== this.generation) return { connected: false };
      this.open('wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30');
      return { connected: false, connecting: true };
    } catch (error) {
      if (this.enabled && generation === this.generation) this.fail(error);
      return { connected: false, message: error.message, reconnectUrl: error.reconnectUrl || '' };
    }
  }

  retry() {
    if (!this.enabled || this.retryTimer) return;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.connect({ retry: true });
    }, Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)));
  }

  isAuthorizationFailure(error) {
    return Boolean(error?.reconnectUrl) || /not authorized|not_authenticated|missing_scope|authorization required|reconnect twitch/i.test(String(error?.message || ''));
  }

  emitFailure(error) {
    const message = String(error?.message || 'Twitch point redeems could not connect.');
    const key = `${message}|${error?.reconnectUrl || ''}`;
    if (this.failureNoticeKey === key) return;
    this.failureNoticeKey = key;
    this.emit({ type: 'error', message, reconnectUrl: error?.reconnectUrl || '' });
  }

  fail(error) {
    this.connected = false;
    if (this.isAuthorizationFailure(error)) {
      const authorizationError = error;
      authorizationError.reconnectUrl ||= RECONNECT_URL;
      this.emitFailure(authorizationError);
      this.stop();
      return;
    }
    this.emitFailure(error);
    this.retry();
  }

  open(url, previous = null) {
    // A connect IPC arriving before subscription confirmation must not open another socket.
    if (!previous && this.sockets.size) return;
    const socket = new this.WebSocket(url, { handshakeTimeout: 12000 });
    this.sockets.add(socket);
    const generation = this.generation;
    let timer;
    let timeout = previous?._keepaliveMs || 30000;
    let welcomed = false;
    const active = () => this.enabled && generation === this.generation && this.sockets.has(socket);
    const arm = (ms) => {
      this.clearTimer(timer);
      timer = this.setTimer(() => socket.terminate(), ms);
    };
    arm(15000);
    socket.on('message', async (raw) => {
      if (!active()) return;
      let packet;
      try { packet = JSON.parse(String(raw)); } catch { return; }
      const type = packet.metadata?.message_type;
      if (type === 'session_welcome') {
        if (welcomed) return;
        welcomed = true;
        timeout = Number(packet.payload?.session?.keepalive_timeout_seconds) * 1000 || timeout;
        socket._keepaliveMs = timeout;
        arm(timeout + 1000);
        try {
          // Twitch transfers subscriptions on a requested reconnect. Never subscribe twice.
          if (!previous) {
            const sessionId = packet.payload?.session?.id || '';
            let subscribed = false;
            if (this.capabilities?.can_redeem !== false) {
              await this.broker('subscribe', { session_id: sessionId, event_type: REWARD_TYPE });
              subscribed = true;
            }
            if (this.capabilities?.can_chat) {
              await this.broker('subscribe', { session_id: sessionId, event_type: CHAT_MESSAGE_TYPE });
              subscribed = true;
            }
            if (!subscribed) throw new Error('Twitch chat events are not authorized. Reconnect Twitch in NeonLogin.');
          }
          if (!active()) return;
          this.current = socket;
          this.connected = true;
          this.attempt = 0;
          this.failureNoticeKey = '';
          this.disconnectedNoticeShown = false;
          if (previous) previous.close();
          this.emit({ type: 'connected', chatConnected: Boolean(this.capabilities?.can_chat) });
        } catch (error) {
          if (!active()) return;
          this.fail(error);
          socket.close();
        }
      } else if (type === 'session_keepalive' || type === 'notification') {
        arm(timeout + 1000);
        if (type !== 'notification') return;
        const subscriptionType = packet.metadata?.subscription_type;
        if (subscriptionType === CHAT_MESSAGE_TYPE) {
          this.emit({ type: 'chat_message', event: packet.payload?.event || {} });
          return;
        }
        if (subscriptionType !== REWARD_TYPE) return;
        const id = packet.metadata?.message_id || packet.payload?.event?.id;
        if (id && this.seen.has(id)) return;
        if (id) this.seen.add(id);
        if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
        this.emit({ type: 'redemption', event: packet.payload?.event || {} });
      } else if (type === 'session_reconnect' && !socket._replacement) {
        const reconnectUrl = packet.payload?.session?.reconnect_url;
        try {
          const parsed = new URL(reconnectUrl);
          if (parsed.protocol !== 'wss:' || parsed.hostname !== 'eventsub.wss.twitch.tv') throw new Error('Invalid Twitch reconnect URL.');
          socket._replacement = this.open(reconnectUrl, socket);
        } catch (error) {
          this.fail(error);
          socket.close();
        }
      } else if (type === 'revocation') {
        const status = packet.payload?.subscription?.status || 'unknown';
        const error = new Error(`Twitch point redeems subscription revoked (${status}). Reconnect Twitch in NeonLogin.`);
        error.reconnectUrl = RECONNECT_URL;
        this.fail(error);
      }
    });
    socket.on('error', () => {
      // ws emits close after errors; recovery belongs to that one path.
      if (active()) socket.terminate();
    });
    socket.on('close', () => {
      this.clearTimer(timer);
      this.sockets.delete(socket);
      if (!this.enabled || generation !== this.generation) return;
      if (previous?._replacement === socket) previous._replacement = null;
      if (this.current === socket) { this.current = null; this.connected = false; }
      if (!this.sockets.size) {
        this.connected = false;
        if (!this.disconnectedNoticeShown) {
          this.disconnectedNoticeShown = true;
          this.emit({ type: 'disconnected', message: 'Twitch point redeems disconnected; reconnecting…' });
        }
        this.retry();
      } else if (previous && this.current === previous && !previous._replacement) {
        // A failed handover cannot keep using the old edge indefinitely.
        previous.close();
      }
    });
    return socket;
  }

  stop() {
    this.enabled = false;
    this.generation++;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.pending = null;
    this.connected = false;
    this.current = null;
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    this.seen.clear();
  }
}

module.exports = { TwitchRedemptions };
