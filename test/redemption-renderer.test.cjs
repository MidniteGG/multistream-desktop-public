const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app/app.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function setup() {
  const state = { messages: [], noticeHistory: [], velora: { channel: 'creator', seen: new Set() }, twitch: { channel: 'creator', eventSubEligible: true, emotes: new Map() }, youtube: { emotes: new Map() } };
  const noop = () => {};
  const ctx = vm.createContext({ state, Date, crypto: require('node:crypto'),
    $: () => null, window: { setTimeout: noop }, isModeratedUser: () => false,
    trimMessages: noop, scheduleChatHistorySave: noop, scheduleMessageRender: noop,
    loadTwitchPronouns: noop,
    escapeHtml: s => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    linkifyText: s => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  });
  for (const name of ['isGifUrl', 'isInlineImageUrl', 'renderInlineMediaText', 'normalizeTwitchChannel', 'addMessage', 'handleVeloraEvent', 'handleVeloraRedeem', 'addVeloraMessage', 'handleTwitchRedemption', 'renderMessageBody']) {
    vm.runInContext(functionSource(name), ctx);
  }
  return ctx;
}

test('Velora pointsCelebration renders real provider fields; live and history copies deduplicate', () => {
  const c = setup();
  const event = { id: 'redeem-1', itemId: 'item-1', itemName: 'Hydrate <script>', cost: 250,
    username: 'viewer', displayName: 'Viewer', message: 'Water please', createdAt: '2026-09-12T12:00:00Z' };
  c.handleVeloraEvent({ type: 'provider_event', event: 'pointsCelebration', payload: event });
  c.addVeloraMessage({ id: 'history-row', card: { type: 'points-celebration', payload: event } });
  assert.equal(c.state.messages.length, 1);
  const msg = c.state.messages[0];
  assert.equal(msg.author, 'Viewer'); assert.equal(msg.text, 'Water please');
  assert.equal(msg.at.toISOString(), new Date(event.createdAt).toISOString());
  const html = c.renderMessageBody(msg);
  assert.ok(html.includes('Hydrate &lt;script&gt;')); assert.ok(html.includes('◆ 250'));
});

test('Velora rewards without input display, wrong channels and malformed payloads are ignored', () => {
  const c = setup();
  c.handleVeloraRedeem({ event: { id: '1', itemName: 'First!', cost: 0, username: 'viewer' } });
  assert.equal(c.state.messages.length, 1);
  assert.ok(c.renderMessageBody(c.state.messages[0]).includes('First!'));
  c.handleVeloraRedeem({ event: { id: '2', channel: { username: 'elsewhere' }, itemName: 'Other' } });
  c.handleVeloraRedeem({ event: [] }); c.handleVeloraRedeem(null);
  assert.equal(c.state.messages.length, 1);
});

test('Twitch typed reward appears once regardless of IRC/EventSub ordering', () => {
  for (const ircFirst of [true, false]) {
    const c = setup(); const now = new Date();
    const irc = { platform: 'twitch', channel: 'creator', authorLogin: 'viewer', text: 'hello', twitchRewardId: 'reward', at: now };
    const reward = { type: 'redemption', event: { id: 'redeem', broadcaster_user_login: 'creator', user_login: 'viewer', user_input: 'hello', redeemed_at: now.toISOString(), reward: { id: 'reward', title: 'Say hi', cost: 100 } } };
    if (ircFirst) c.addMessage(irc);
    c.handleTwitchRedemption(reward);
    if (!ircFirst) c.addMessage(irc);
    assert.equal(c.state.messages.length, 1);
    assert.ok(c.renderMessageBody(c.state.messages[0]).includes('Say hi'));
    c.addMessage({ ...irc, channel: 'another' });
    assert.equal(c.state.messages.length, 2);
  }
});
