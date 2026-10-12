const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');

function functionSource(name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start < 0) {
    start = source.indexOf(`function ${name}(`);
  }
  assert.ok(start >= 0, `Function ${name} not found in app.js`);
  let depth = 0;
  let inBraces = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
      inBraces = true;
    } else if (source[i] === '}') {
      depth--;
      if (inBraces && depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return source.slice(start);
}

test('Velora composer state reflects chat:write permissions', () => {
  const elements = {
    '#messageInput': { disabled: true, placeholder: '', value: '', maxLength: 200 },
    '#sendButton': { disabled: true },
    '#charCount': { textContent: '' },
    '#targetLabel': { textContent: '' },
    '#targetButton .platform-dot': { className: '' }
  };

  const state = {
    sendTarget: 'velora',
    twitch: { connected: false, authenticated: false, canSendChat: false, canUseTwitchEmotes: false },
    youtube: { connected: false, canSend: false },
    velora: { connected: true, canSend: true, channel: 'kluma', emotes: new Map() }
  };

  const ctx = vm.createContext({
    state,
    YOUTUBE_CHAT_ENABLED: true,
    scopedStorageKey: (k) => k,
    localStorage: { getItem: () => null, setItem: () => {} },
    updateComposerTools: () => {},
    $: (sel) => elements[sel] || { textContent: '', className: '' }
  });

  const isBroadcasterForPlatformCode = functionSource('isBroadcasterForPlatform');
  const getComposerCapabilitiesCode = functionSource('getComposerCapabilities');
  const updateComposerStateCode = functionSource('updateComposerState');
  const setSendTargetCode = functionSource('setSendTarget');
  vm.runInContext(`${isBroadcasterForPlatformCode}\n${getComposerCapabilitiesCode}\n${updateComposerStateCode}\n${setSendTargetCode}`, ctx);

  // Test setSendTarget to velora sets maxLength 500
  ctx.setSendTarget('velora');
  assert.equal(elements['#messageInput'].maxLength, 500);
  assert.equal(elements['#messageInput'].disabled, false);
  assert.equal(elements['#sendButton'].disabled, false);
  assert.match(elements['#messageInput'].placeholder, /Send to Velora as your linked account/);

  // Test when canSend is false and not broadcaster (read-only)
  state.velora.canSend = false;
  state.velora.isOwner = false;
  ctx.updateComposerState();
  assert.equal(elements['#messageInput'].disabled, true);
  assert.equal(elements['#sendButton'].disabled, true);
  assert.match(elements['#messageInput'].placeholder, /Velora chat:write permission required/);

  // Test broadcaster on dropdown selector can chat in own channel
  state.velora.isOwner = true;
  ctx.updateComposerState();
  assert.equal(elements['#messageInput'].disabled, false);
  assert.equal(elements['#sendButton'].disabled, false);
  assert.match(elements['#messageInput'].placeholder, /Send to Velora as broadcaster/);

  // Test when target is 'all' - broadcaster override does NOT apply across all channels
  state.sendTarget = 'all';
  state.velora.canSend = false;
  state.velora.isOwner = true;
  ctx.updateComposerState();
  assert.equal(elements['#messageInput'].disabled, true);
  assert.equal(elements['#sendButton'].disabled, true);

  // Test when target is 'all' and velora has verified send permission
  state.velora.canSend = true;
  ctx.updateComposerState();
  assert.equal(elements['#messageInput'].disabled, false);
  assert.equal(elements['#sendButton'].disabled, false);
  assert.match(elements['#messageInput'].placeholder, /Send to connected chats as your linked account/);
});
test('Velora sendComposerMessage dispatches payload to neonDesktop', async () => {
  const sentPayloads = [];
  const addedMessages = [];

  const elements = {
    '#messageInput': { value: 'Hello from Velora!', disabled: false, maxLength: 500, focus() {} },
    '#sendButton': { disabled: false },
    '#charCount': { textContent: '18/500' }
  };

  const state = {
    sendTarget: 'velora',
    twitch: { connected: false, authenticated: false, canSendChat: false, canUseTwitchEmotes: false },
    youtube: { connected: false, canSend: false },
    velora: { connected: true, canSend: true, channel: 'kluma', channelOwnerId: 'user_456' }
  };

  const ctx = vm.createContext({
    state,
    YOUTUBE_CHAT_ENABLED: true,
    $: (sel) => elements[sel],
    addMessage: (msg) => addedMessages.push(msg),
    updateComposerState: () => {},
    window: {
      neonDesktop: {
        sendVeloraMessage: async (options) => {
          sentPayloads.push(options);
          return { success: true };
        }
      }
    }
  });

  const sendComposerMessageCode = functionSource('sendComposerMessage');
  vm.runInContext(sendComposerMessageCode, ctx);

  await ctx.sendComposerMessage();

  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].channel, 'kluma');
  assert.equal(sentPayloads[0].channelId, 'user_456');
  assert.equal(sentPayloads[0].message, 'Hello from Velora!');
  assert.equal(elements['#messageInput'].value, '');
});
test('Velora moderation context menu checks permissions and note', () => {
  const state = {
    twitch: { channel: 'test_twitch', canModerate: false },
    velora: { channel: 'kluma', canModerate: true },
    messages: [
      { id: 'm1', providerId: 'msg_999', platform: 'velora', author: 'badactor', channel: 'kluma', text: 'spam' }
    ]
  };

  const buttons = [
    { dataset: { modAction: 'delete' }, disabled: false },
    { dataset: { modAction: 'timeout-60' }, disabled: false },
    { dataset: { modAction: 'timeout-600' }, disabled: false },
    { dataset: { modAction: 'ban' }, disabled: false }
  ];

  const elements = {
    '#contextUserName': { textContent: '' },
    '#contextPlatformBadge': { innerHTML: '', className: '' },
    '#contextMenuNote': { textContent: '' }
  };

  const userContextMenu = {
    querySelectorAll: (sel) => sel === '[data-mod-action]' ? buttons : [],
    classList: { remove: () => {}, add: () => {} },
    offsetWidth: 200,
    offsetHeight: 150,
    style: {}
  };

  let contextMessage = null;

  const ctx = vm.createContext({
    state,
    contextMessage,
    userContextMenu,
    platformGlyph: (p) => `<span class="${p}"></span>`,
    $: (sel) => elements[sel],
    window: { innerWidth: 1200, innerHeight: 800 }
  });

  const openUserContextMenuCode = functionSource('openUserContextMenu');
  vm.runInContext(openUserContextMenuCode, ctx);

  // Case 1: Streamer has canModerate = true
  ctx.openUserContextMenu({ preventDefault() {}, clientX: 100, clientY: 100 }, { dataset: { author: 'badactor', messageId: 'msg_999', platform: 'velora' } });
  assert.equal(elements['#contextUserName'].textContent, 'badactor');
  assert.match(elements['#contextMenuNote'].textContent, /Actions apply in #kluma/);
  assert.equal(buttons.every((b) => b.disabled === false), true);

  // Case 2: Streamer has canModerate = false
  state.velora.canModerate = false;
  ctx.openUserContextMenu({ preventDefault() {}, clientX: 100, clientY: 100 }, { dataset: { author: 'badactor', messageId: 'msg_999', platform: 'velora' } });
  assert.match(elements['#contextMenuNote'].textContent, /Velora chat:moderate permission required/);
  assert.equal(buttons.every((b) => b.disabled === true), true);
});

test('Velora handleVeloraEvent processes chat_cleared and connected events', () => {
  const addedMessages = [];
  let clearedTarget = null;
  let clearedChannel = null;

  const state = {
    sendTarget: 'all',
    youtube: { connected: false },
    vpzone: { connected: false },
    velora: {
      channel: 'kluma',
      connected: false,
      connecting: true,
      canSend: false,
      canModerate: false
    }
  };

  const ctx = vm.createContext({
    state,
    $: () => ({ textContent: '', disabled: false }),
    addMessage: (msg) => addedMessages.push(msg),
    updateComposerState: () => {},
    setSendTarget: (target) => { state.sendTarget = target; },
    mergeVeloraEmotes: () => {},
    renderMessages: () => {},
    clearChatHistory: (target, channel) => {
      clearedTarget = target;
      clearedChannel = channel;
    }
  });

  const handleVeloraEventCode = functionSource('handleVeloraEvent');
  vm.runInContext(handleVeloraEventCode, ctx);

  // Trigger connected event with permissions
  ctx.handleVeloraEvent({
    type: 'connected',
    channel: 'kluma',
    channelOwnerId: 'owner_1',
    can_write: true,
    can_moderate: true
  });

  assert.equal(state.velora.connected, true);
  assert.equal(state.velora.canSend, true);
  assert.equal(state.velora.canModerate, true);
  assert.equal(state.sendTarget, 'velora');
  assert.equal(addedMessages.length, 1);
  assert.match(addedMessages[0].text, /Connected to Velora channel #kluma \(moderation and chat enabled\)/);

  // Trigger chat_cleared event
  ctx.handleVeloraEvent({
    type: 'chat_cleared',
    channel: 'kluma'
  });

  assert.equal(clearedTarget, 'velora');
  assert.equal(clearedChannel, 'kluma');
  assert.equal(addedMessages.length, 2);
  assert.match(addedMessages[1].text, /Chat was cleared in #kluma/);
});

test('Velora clears permission required warning when user has chat:write already', () => {
  const elements = {
    '#messageInput': { disabled: true, placeholder: 'Velora chat:write permission required…', value: '', maxLength: 200 },
    '#sendButton': { disabled: true },
    '#charCount': { textContent: '' },
    '#targetLabel': { textContent: '' },
    '#targetButton .platform-dot': { className: '' }
  };

  const state = {
    sendTarget: 'velora',
    twitch: { connected: false, authenticated: false, canSendChat: false, canUseTwitchEmotes: false },
    youtube: { connected: false, canSend: false },
    velora: { connected: true, canSend: false, channel: 'kluma', emotes: new Map() }
  };

  const ctx = vm.createContext({
    state,
    YOUTUBE_CHAT_ENABLED: true,
    scopedStorageKey: (k) => k,
    localStorage: { getItem: () => null, setItem: () => {} },
    updateComposerTools: () => {},
    $: (sel) => elements[sel] || { textContent: '', className: '' }
  });

  const isBroadcasterForPlatformCode = functionSource('isBroadcasterForPlatform');
  const getComposerCapabilitiesCode = functionSource('getComposerCapabilities');
  const updateComposerStateCode = functionSource('updateComposerState');
  vm.runInContext(`${isBroadcasterForPlatformCode}\n${getComposerCapabilitiesCode}\n${updateComposerStateCode}`, ctx);

  // Initially read-only
  ctx.updateComposerState();
  assert.equal(elements['#messageInput'].disabled, true);
  assert.match(elements['#messageInput'].placeholder, /Velora chat:write permission required/);

  // User has permissions / permissions granted
  state.velora.canSend = true;
  ctx.updateComposerState();
  assert.equal(elements['#messageInput'].disabled, false);
  assert.equal(elements['#sendButton'].disabled, false);
  assert.doesNotMatch(elements['#messageInput'].placeholder, /permission required/);
  assert.match(elements['#messageInput'].placeholder, /Send to Velora as your linked account/);
});
