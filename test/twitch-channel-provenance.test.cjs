const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Function ${name} not found`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
      opened = true;
    } else if (source[index] === '}') {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, index + 1) +
        (name === 'traceTwitchSource' ? '' : `\n${extractFunction('traceTwitchSource')}`) +
        (name === 'parseTwitchMessage' ? `\n${extractFunction('normalizeTwitchEventBadges')}` : '') +
        (['addMessage', 'handleTwitchChatMessage'].includes(name) ? `\n${extractFunction('mergeTwitchSource')}` : '');
    }
  }
  throw new Error(`Unable to extract ${name}`);
}

test('Twitch Shared Chat provenance uses the originating broadcaster metadata', () => {
  const context = vm.createContext({
    state: { twitch: { channel: 'tehkluma', canModerate: false } },
    normalizeTwitchChannel: (value) => String(value || '').trim().toLowerCase().replace(/^#/, ''),
    parseNativeEmotes: () => []
  });
  vm.runInContext(`${extractFunction('mergeTwitchBadges')};${extractFunction('parseTwitchMessage')}`, context);

  const message = vm.runInContext(`parseTwitchMessage('@id=abc;source-broadcaster-user-login=xthyqueen :sery_bot!sery_bot@sery_bot.tmi.twitch.tv PRIVMSG #tehkluma :hello')`, context);
  assert.equal(message.channel, 'xthyqueen');
  assert.equal(message.sourceChannel, 'xthyqueen');
  assert.equal(message.sourceChannelLogin, 'xthyqueen');
  assert.equal(message.destinationChannel, 'tehkluma');
  assert.equal(message.messageId, 'abc');
  assert.notEqual(message.channel, context.state.twitch.channel);
});

test('Twitch messages without Shared Chat metadata use the IRC target channel', () => {
  const context = vm.createContext({
    state: { twitch: { channel: 'tehkluma', canModerate: false } },
    normalizeTwitchChannel: (value) => String(value || '').trim().toLowerCase().replace(/^#/, ''),
    parseNativeEmotes: () => []
  });
  vm.runInContext(`${extractFunction('mergeTwitchBadges')};${extractFunction('parseTwitchMessage')}`, context);

  const message = vm.runInContext(`parseTwitchMessage('@id=abc :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #tehkluma :hello')`, context);
  assert.equal(message.channel, 'tehkluma');
  assert.equal(message.sourceChannel, 'tehkluma');
  assert.equal(message.sourceChannelLogin, 'tehkluma');
  assert.equal(message.destinationChannel, 'tehkluma');
});

test('Local IRC targets remain local evidence and source-only=0 cannot establish origin', () => {
  const context = vm.createContext({ state: { twitch: { roomChannels: new Map(), canModerate: false } },
    normalizeTwitchChannel: (value) => String(value || '').toLowerCase(), parseNativeEmotes: () => [] });
  vm.runInContext(`${extractFunction('mergeTwitchBadges')};${extractFunction('parseTwitchMessage')}`, context);
  const local = vm.runInContext(`parseTwitchMessage('@id=local;room-id=74808402 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #tehkluma :hello')`, context);
  assert.equal(local.sourceChannel, 'tehkluma');
  assert.equal(local.sourceAttribution, 'local');
  assert.equal(local.sourceChannelAuthoritative, false);
  const unresolved = vm.runInContext(`parseTwitchMessage('@id=relay;room-id=74808402;source-only=0 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #tehkluma :hello')`, context);
  assert.equal(unresolved.sourceChannel, '');
  assert.equal(unresolved.sourceAttribution, 'unknown');
});

test('Neither non-authoritative fallback nor local IRC can overwrite an explicit EventSub origin', () => {
  const context = vm.createContext({});
  vm.runInContext(extractFunction('mergeTwitchSource'), context);
  context.existing = { sourceChannelLogin: 'xthyqueen', sourceChannelAuthoritative: true, sourceAttribution: 'explicit' };
  vm.runInContext(`mergeTwitchSource(existing, {sourceChannelLogin:'tehkluma',sourceChannelAuthoritative:false})`, context);
  assert.equal(context.existing.sourceChannelLogin, 'xthyqueen');
  vm.runInContext(`mergeTwitchSource(existing, {sourceChannelLogin:'tehkluma',sourceAttribution:'local',sourceChannelAuthoritative:false})`, context);
  assert.equal(context.existing.sourceChannelLogin, 'xthyqueen');
  assert.equal(context.existing.sourceChannelAuthoritative, true);
});

test('JOIN notices are rate limited across different users in the same channel', () => {
  let now = 100000;
  const messages = [];
  const context = vm.createContext({ Date: { now: () => now }, twitchJoinNotices: new Map(),
    TWITCH_JOIN_NOTICE_DEDUP_MS: 60000, TWITCH_JOIN_NOTICE_EXPIRY_MS: 20000, addMessage: (message) => messages.push(message) });
  vm.runInContext(extractFunction('announceTwitchJoin'), context);
  vm.runInContext(`announceTwitchJoin(':first!first@host JOIN #tehkluma','tehkluma','self');announceTwitchJoin(':second!second@host JOIN #tehkluma','tehkluma','self')`, context);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].isJoinNotice, true);
  now += 10000;
  vm.runInContext(`announceTwitchJoin(':third!third@host JOIN #tehkluma','tehkluma','self')`, context);
  assert.equal(messages.length, 2);
});

test('History does not trust an old authoritative flag without origin evidence', () => {
  const context = vm.createContext({ storageScope: 'test', scopedStorageKey: () => 'history',
    localStorage: { getItem: () => JSON.stringify([{ platform: 'twitch', sourceChannelLogin: 'tehkluma',
      destinationChannel: 'tehkluma', sourceChannelAuthoritative: true, at: '2026-10-10T00:00:00Z' }]) } });
  vm.runInContext(extractFunction('loadChatHistory'), context);
  const restored = vm.runInContext('loadChatHistory()[0]', context);
  assert.equal(restored.sourceChannelLogin, '');
  assert.equal(restored.sourceAttribution, 'unknown');
  assert.equal(restored.sourceChannelAuthoritative, false);
});

test('Shared Chat frames with relay metadata but no source login never invent the destination as source', () => {
  const context = vm.createContext({
    state: { twitch: { channel: 'tehkluma', canModerate: false } },
    normalizeTwitchChannel: (value) => String(value || '').trim().toLowerCase().replace(/^#/, ''),
    parseNativeEmotes: () => []
  });
  vm.runInContext(`${extractFunction('mergeTwitchBadges')};${extractFunction('parseTwitchMessage')}`, context);

  const message = vm.runInContext(`parseTwitchMessage('@id=abc;source-broadcaster-user-id=12345 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #tehkluma :hello')`, context);
  assert.equal(message.sourceChannel, '');
  assert.equal(message.sourceChannelLogin, '');
  assert.equal(message.destinationChannel, 'tehkluma');
  assert.equal(message.sourceChannelAuthoritative, false);
});

test('Shared Chat source broadcaster name remains usable when Twitch omits the login field', () => {
  const context = vm.createContext({
    state: { twitch: { channel: 'tehkluma', canModerate: false } },
    normalizeTwitchChannel: (value) => String(value || '').trim().toLowerCase().replace(/^#/, ''),
    parseNativeEmotes: () => []
  });
  vm.runInContext(`${extractFunction('mergeTwitchBadges')};${extractFunction('parseTwitchMessage')}`, context);

  const message = vm.runInContext(`parseTwitchMessage('@id=abc;source-broadcaster-user-id=12345;source-broadcaster-user-name=the_impkin :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #tehkluma :hello')`, context);
  assert.equal(message.sourceChannel, 'the_impkin');
  assert.equal(message.destinationChannel, 'tehkluma');
});

test('Twitch IRC Shared Chat resolves source-room-id to the connected origin channel', () => {
  const context = vm.createContext({
    state: { twitch: { channel: 'tehkluma', canModerate: false, roomChannels: new Map() } },
    normalizeTwitchChannel: (value) => String(value || '').trim().toLowerCase().replace(/^#/, ''),
    parseNativeEmotes: () => []
  });
  vm.runInContext(`${extractFunction('mergeTwitchBadges')};${extractFunction('parseTwitchMessage')}`, context);

  const origin = vm.runInContext(`parseTwitchMessage('@id=origin;room-id=111;badges=subscriber/1 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #xthyqueen :origin')`, context);
  assert.equal(origin.sourceChannel, 'xthyqueen');

  const mirrored = vm.runInContext(`parseTwitchMessage('@id=mirror;room-id=222;source-room-id=111;source-id=origin;badges=;source-badges=subscriber/1 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #tehkluma :origin')`, context);
  assert.equal(mirrored.sourceChannel, 'xthyqueen');
  assert.equal(mirrored.destinationChannel, 'tehkluma');
  assert.equal(mirrored.sourceChannelAuthoritative, true);
  assert.equal(JSON.stringify(mirrored.badges), JSON.stringify([{ type: 'subscriber', version: '1', badgeChannel: 'xthyqueen' }]));
  assert.equal(mirrored.sourceRoomId, '111');
});

test('Twitch IRC learns room IDs from ROOMSTATE before the first mirrored message', () => {
  const context = vm.createContext({
    state: { twitch: { channel: 'tehkluma', canModerate: false, roomChannels: new Map() } },
    normalizeTwitchChannel: (value) => String(value || '').trim().toLowerCase().replace(/^#/, ''),
    parseNativeEmotes: () => []
  });
  vm.runInContext(`${extractFunction('mergeTwitchBadges')};${extractFunction('parseTwitchMessage')}`, context);
  vm.runInContext(`parseTwitchMessage('@room-id=111 :tmi.twitch.tv ROOMSTATE #xthyqueen', 'xthyqueen')`, context);
  const mirrored = vm.runInContext(`parseTwitchMessage('@id=mirror;room-id=222;source-room-id=111 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #tehkluma :hello')`, context);
  assert.equal(mirrored.sourceChannel, 'xthyqueen');
  assert.equal(mirrored.destinationChannel, 'tehkluma');
});

test('Twitch badge catalog lookup follows the verified source channel', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  const context = vm.createContext({
    state: {
      twitch: {
        badgeCatalogs: new Map([
          ['the_impkin', new Map([
            ['subscriber/12', { imageUrl: 'https://cdn.test/the-impkin-sub.png', title: 'Subscriber' }]
          ])]
        ])
      },
      velora: { badgeCatalog: new Map() }
    },
    normalizeVeloraBadgeKey: (value) => String(value || '').toLowerCase().replace(/[\s-]+/g, '_'),
    resolveVeloraBadgeKey: (badge) => String(typeof badge === 'string' ? badge : badge?.type || ''),
    veloraOfficialAssets: {},
    escapeHtml: (value) => String(value || '')
  });
  vm.runInContext(`${extractFunction('renderUserBadges')}`, context);
  const rendered = vm.runInContext(`renderUserBadges([{type:'subscriber',version:'12'}], 'the_impkin', 'twitch')`, context);
  assert.match(rendered, /the-impkin-sub\.png/);
  assert.doesNotMatch(rendered, /♥/);
});

test('Twitch IRC and EventSub badge metadata is merged without loss', () => {
  const context = vm.createContext({});
  vm.runInContext(`${extractFunction('mergeTwitchBadges')};${extractFunction('normalizeTwitchEventBadges')}`, context);
  const merged = vm.runInContext(`mergeTwitchBadges([{type:'moderator',version:'1'}], normalizeTwitchEventBadges([{set_id:'subscriber',id:'12',image_url:'https://cdn.test/sub.png'},{set_id:'moderator',id:'1'}]))`, context);
  assert.equal(JSON.stringify(merged), JSON.stringify([
    { type: 'moderator', version: '1', set_id: 'moderator', id: '1' },
    { set_id: 'subscriber', id: '12', image_url: 'https://cdn.test/sub.png', type: 'subscriber', version: '12' }
  ]));
});

test('Unknown Shared Chat source never overwrites an existing verified source during a provider-ID merge', () => {
  const existing = { platform: 'twitch', providerId: 'copy', sourceRoomId: '110747916',
    sourceChannel: 'xthyqueen', sourceChannelLogin: 'xthyqueen', sourceChannelAuthoritative: true, badges: [] };
  const context = vm.createContext({ state: { messages: [existing] },
    scheduleChatHistorySave: () => {}, scheduleMessageRender: () => {} });
  vm.runInContext(`${extractFunction('mergeTwitchBadges')};${extractFunction('addMessage')}`, context);
  vm.runInContext(`addMessage({platform:'twitch',providerId:'copy',destinationChannel:'tehkluma',sourceChannelLogin:'tehkluma',sourceChannelAuthoritative:true,badges:[]})`, context);
  assert.equal(existing.sourceChannelLogin, 'xthyqueen');
  assert.equal(existing.destinationChannel, 'tehkluma');
});

test('An unjoined Shared Chat source resolves by ID and survives history serialization', async () => {
  const message = { platform: 'twitch', sourceRoomId: '110747916', sourceChannel: '', destinationChannel: 'tehkluma' };
  let calls = 0;
  const context = vm.createContext({
    state: { messages: [message], twitch: { badgeCatalogs: new Map(), roomChannels: new Map() } },
    window: { neonDesktop: { getTwitchChatAssets: async (id) => {
      calls++;
      assert.equal(id, '110747916');
      return { channel: 'xthyqueen', broadcaster_id: id, badges: [{ set_id: 'subscriber', id: '1', image_url: 'https://cdn.test/sub.png' }] };
    } } },
    normalizeTwitchChannel: (value) => String(value || '').toLowerCase(),
    renderMessages: () => {}, scheduleChatHistorySave: () => {}
  });
  vm.runInContext(`async ${extractFunction('loadTwitchChatBadges')}`, context);
  await vm.runInContext(`Promise.all([loadTwitchChatBadges('110747916'), loadTwitchChatBadges('110747916')])`, context);
  assert.equal(calls, 1);
  const restored = JSON.parse(JSON.stringify(message));
  assert.equal(restored.sourceChannelLogin, 'xthyqueen');
  assert.equal(restored.destinationChannel, 'tehkluma');
  assert.equal(restored.sourceChannelAuthoritative, true);
  assert.ok(context.state.twitch.badgeCatalogs.get('xthyqueen').get('subscriber/1'));
});

test('Shared Chat displays origin subscriptions and keeps receiving-room subscriptions as metadata', () => {
  const context = vm.createContext({ state: { twitch: { roomChannels: new Map(), canModerate: false } },
    normalizeTwitchChannel: (value) => String(value || '').toLowerCase(), parseNativeEmotes: () => [] });
  vm.runInContext(`${extractFunction('mergeTwitchBadges')};${extractFunction('parseTwitchMessage')};${extractFunction('visibleMessageBadges')}`, context);
  const message = vm.runInContext(`parseTwitchMessage('@id=copy;room-id=74808402;source-room-id=110747916;badges=subscriber/12;source-badges=subscriber/3 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #tehkluma :hello')`, context);
  context.message = message;
  const visible = vm.runInContext('visibleMessageBadges(message)', context);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].version, '3');
  assert.equal(visible[0].badgeChannel, '110747916');
  assert.equal(message.destinationBadges[0].version, '12');
  message.sourceBadges = [];
  assert.equal(vm.runInContext('visibleMessageBadges(message).length', context), 0, 'explicitly empty origin badges must not fall back to destination subscription');
});

test('EventSub uses source_message_id to enrich IRC copies without discarding badges or repeated messages', () => {
  const original = { platform: 'twitch', providerId: 'irc-copy', sourceMessageId: 'origin', text: 'hello', badges: [{ type: 'moderator', version: '1' }], nativeEmotes: [{ id: '25', start: 0, end: 4 }] };
  const context = vm.createContext({
    state: { messages: [original], twitch: { canModerate: false } },
    normalizeTwitchChannel: (value) => String(value || '').toLowerCase(),
    scheduleMessageRender: () => {}, scheduleChatHistorySave: () => {},
    addMessage: (message) => context.state.messages.push(message)
  });
  vm.runInContext(`${extractFunction('mergeTwitchBadges')};${extractFunction('normalizeTwitchEventBadges')};${extractFunction('handleTwitchChatMessage')}`, context);
  const event = { message_id: 'event-copy', source_message_id: 'origin', source_broadcaster_user_id: '110747916', source_broadcaster_user_login: 'xthyqueen', broadcaster_user_login: 'tehkluma', chatter_user_login: 'viewer', message: { text: 'hello' }, source_badges: [{ set_id: 'subscriber', id: '1' }] };
  context.event = event;
  vm.runInContext('handleTwitchChatMessage(event)', context);
  assert.equal(context.state.messages.length, 1);
  assert.equal(original.sourceChannelLogin, 'xthyqueen');
  assert.equal(original.destinationChannel, 'tehkluma');
  assert.equal(original.badges.length, 2);
  assert.equal(original.nativeEmotes[0].id, '25');
  context.event = { ...event, message_id: 'second-copy', source_message_id: 'second-origin' };
  vm.runInContext('handleTwitchChatMessage(event)', context);
  assert.equal(context.state.messages.length, 2, 'separate messages with identical text remain separate');
});
