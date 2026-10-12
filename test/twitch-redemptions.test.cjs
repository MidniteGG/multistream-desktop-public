const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TwitchRedemptions } = require('../electron/twitch-redemptions.cjs');
const flush = () => new Promise(setImmediate);
function setup(broker) {
  const sockets = [], events = [], calls = [], timers = new Map();
  let timerId = 0;
  class Socket extends EventEmitter {
    constructor(url) { super(); this.url = url; sockets.push(this); }
    close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
    terminate() { this.close(); }
    packet(type, payload = {}, metadata = {}) {
      this.emit('message', JSON.stringify({ metadata: { message_type: type, ...metadata }, payload }));
    }
    welcome(id = 'session') { this.packet('session_welcome', { session: { id, keepalive_timeout_seconds: 30 } }); }
  }
  const client = new TwitchRedemptions({
    WebSocket: Socket, emit: e => events.push(e),
    broker: async (...args) => { calls.push(args); return broker ? broker(...args) : {}; },
    setTimer: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimer: id => timers.delete(id)
  });
  const fire = ms => {
    const entry = [...timers].find(([, t]) => t.ms === ms);
    assert.ok(entry, `timer ${ms} exists`);
    timers.delete(entry[0]); entry[1].fn();
  };
  return { client, sockets, events, calls, timers, fire };
}

test('connect remains pending until subscription succeeds; concurrent calls share one socket', async () => {
  let resolve;
  const s = setup(action => action === 'subscribe' ? new Promise(r => resolve = r) : {});
  await Promise.all([s.client.connect(), s.client.connect()]);
  s.sockets[0].welcome();
  await s.client.connect();
  assert.equal(s.sockets.length, 1);
  assert.equal(s.events.length, 0);
  resolve({ subscribed: true }); await flush();
  assert.equal(s.events[0].type, 'connected');
  s.client.stop();
});

test('production can_read_chat capability subscribes to chat and forwards Shared Chat source metadata', async () => {
  const s = setup(action => action === 'status' ? { can_read_chat: true, can_redeem: false } : { subscribed: true });
  await s.client.connect();
  s.sockets[0].welcome(); await flush();
  assert.equal(s.calls.filter(c => c[0] === 'subscribe').length, 1);
  assert.equal(s.calls.find(c => c[0] === 'subscribe')[1].event_type, 'channel.chat.message');
  const event = {
    broadcaster_user_login: 'tehkluma', source_broadcaster_user_id: '110747916',
    source_broadcaster_user_login: 'xthyqueen', source_broadcaster_user_name: 'xThyQueen',
    source_message_id: 'source-id', message_id: 'destination-id',
    source_badges: [{ set_id: 'subscriber', id: '12', info: '12' }]
  };
  s.sockets[0].packet('notification', { event }, { subscription_type: 'channel.chat.message' });
  assert.deepEqual(s.events.find(e => e.type === 'chat_message').event, event);
  s.client.stop();
});

test('requested handover keeps old socket until welcome and does not resubscribe', async () => {
  const s = setup(); await s.client.connect();
  const old = s.sockets[0]; old.welcome(); await flush();
  old.packet('session_reconnect', { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=1' } });
  assert.equal(old.closed, undefined);
  s.sockets[1].welcome(); await flush();
  assert.equal(old.closed, true);
  assert.equal(s.calls.filter(c => c[0] === 'subscribe').length, 1);
  s.sockets[1].emit('error', new Error('network')); s.fire(1000); await flush();
  s.sockets[2].welcome(); await flush();
  assert.equal(s.calls.filter(c => c[0] === 'subscribe').length, 2);
  s.client.stop();
});

test('missed keepalive reconnects and duplicate delivery emits one reward', async () => {
  const s = setup(); await s.client.connect(); s.sockets[0].welcome(); await flush();
  for (let i = 0; i < 2; i++) s.sockets[0].packet('notification', { event: { id: 'reward' } }, {
    message_id: 'notification', subscription_type: 'channel.channel_points_custom_reward_redemption.add'
  });
  assert.equal(s.events.filter(e => e.type === 'redemption').length, 1);
  s.fire(31000); s.fire(1000); await flush();
  assert.equal(s.sockets.length, 2);
  s.client.stop(); assert.equal(s.timers.size, 0);
});

test('transient broker failures retry; authorization failures wait for reconnect', async () => {
  let fail = true;
  const s = setup(() => { if (fail) throw new Error('temporary'); });
  await s.client.connect(); fail = false; s.fire(1000); await flush();
  assert.equal(s.sockets.length, 1); s.client.stop();
  const auth = setup(() => { throw Object.assign(new Error('reconnect'), { reconnectUrl: 'https://teammidnite.tv/NeonLogin/auth/twitch.php?link=1' }); });
  await auth.client.connect(); assert.equal(auth.timers.size, 0); assert.ok(auth.events[0].reconnectUrl);
});

test('missing EventSub authorization stops instead of retrying or flooding notices', async () => {
  const s = setup(() => ({ can_redeem: false, can_chat: false }));
  await s.client.connect();
  s.sockets[0].welcome();
  await flush();
  assert.equal(s.sockets[0].closed, true);
  assert.equal(s.timers.size, 0);
  assert.equal(s.events.filter((event) => event.type === 'error').length, 1);
  assert.match(s.events[0].message, /not authorized/i);
  assert.ok(s.events[0].reconnectUrl);
});

test('logout cancels in-flight authorization and prevents subscriptions or reconnection', async () => {
  let resolve; const s = setup(() => new Promise(r => resolve = r));
  const pending = s.client.connect(); s.client.stop(); resolve({}); await pending;
  assert.equal(s.sockets.length, 0); assert.equal(s.timers.size, 0);
});

test('revocation closes sockets and reports reauthorization', async () => {
  const s = setup(); await s.client.connect(); s.sockets[0].welcome(); await flush();
  s.sockets[0].packet('revocation', { subscription: { status: 'authorization_revoked' } });
  assert.equal(s.sockets[0].closed, true); assert.equal(s.timers.size, 0);
  assert.ok(s.events.at(-1).reconnectUrl);
});
