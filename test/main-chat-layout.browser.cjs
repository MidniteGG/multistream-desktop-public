// Run with an installed Playwright package, or PLAYWRIGHT_MODULE_PATH pointing to it.
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright'));
} catch {
  console.log('SKIP main chat layout browser test: Playwright is not installed.');
  process.exit(0);
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const styles = fs.readFileSync(path.join(__dirname, '../app/styles.css'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
const username = 'CrazyLilThingCalledMEQ';

function row(id, extra = '', rich = true) {
  const identity = rich
    ? '<span class="user-badge">B</span><span class="user-badge">M</span><span class="user-badge">V</span><span class="author-identity-line"><b class="message-author">' + username + '</b><span class="secondary-handle">@' + username + 'Alt</span><span class="pronoun-badge">They/Them</span></span>'
    : '<span class="author-identity-line"><b class="message-author">' + username + '</b></span>';
  return `<article class="message-row" data-id="${id}">
    <time>03:31</time>
    <span class="message-platform twitch">T</span>
    <span class="message-author-block">
      <span class="author-line">
        ${identity}
      </span>
      <small class="chat-channel"><span class="chat-channel-icon">#</span><span class="chat-channel-name">cyborgangel</span></small>
    </span>
    <div class="message-content"><div class="message-text">${extra || 'That is a readable message body.'}</div></div>
  </article>`;
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    await page.setContent(`<style>${styles}</style><main id="fixture">${row('wide')}</main>`);

    const measure = () => page.evaluate(() => {
      const item = document.querySelector('.message-row');
      const authorBlock = item.querySelector('.message-author-block').getBoundingClientRect();
      const author = item.querySelector('.message-author');
      const authorRect = author.getBoundingClientRect();
      const identity = item.querySelector('.author-identity-line').getBoundingClientRect();
      const content = item.querySelector('.message-content').getBoundingClientRect();
      const channel = item.querySelector('.chat-channel').getBoundingClientRect();
      return { authorBlock, authorRect, identity, content, channel,
        authorScroll: author.scrollWidth, authorClient: author.clientWidth,
        contentScroll: item.querySelector('.message-content').scrollWidth };
    });

    let layout = await measure();
    assert.ok(layout.authorRect.right <= layout.content.left + 0.5, 'wide author overlaps message');
    assert.ok(layout.authorClient >= layout.authorScroll - 1, 'wide username should remain complete');
    assert.ok(layout.channel.right <= layout.authorBlock.right + 0.5, 'channel label escapes author column');

    await page.setViewportSize({ width: 420, height: 500 });
    layout = await measure();
    assert.ok(layout.authorRect.right <= layout.content.left + 0.5, 'narrow author overlaps message');
    assert.ok(layout.identity.right <= layout.authorBlock.right + 0.5, 'badge-heavy identity escapes author column');
    assert.ok(layout.content.width > 0, 'narrow message has no available width');
    assert.ok(layout.authorClient >= layout.authorScroll - 1, 'narrow badge-heavy username is clipped');
    assert.ok(layout.channel.right <= layout.authorBlock.right + 0.5, 'narrow channel label escapes author column');

    await page.evaluate(() => document.body.classList.add('hide-timestamps', 'hide-badges'));
    layout = await measure();
    assert.ok(layout.authorRect.right <= layout.content.left + 0.5, 'hidden-column layout overlaps message');

    await page.setViewportSize({ width: 900, height: 500 });
    await page.setContent(`<style>${styles}</style><main class="chat-workspace" style="width:900px;height:300px;--pane-count:2"><section class="chat-pane"><div></div><div class="chat-log">${row('left')}</div></section><section class="chat-pane"><div></div><div class="chat-log">${row('right')}</div></section></main>`);
    const panes = await page.evaluate(() => [...document.querySelectorAll('.message-row')].map((item) => {
      const author = item.querySelector('.message-author').getBoundingClientRect();
      const content = item.querySelector('.message-content').getBoundingClientRect();
      return { authorRight: author.right, contentLeft: content.left, contentWidth: content.width };
    }));
    for (const pane of panes) {
      assert.ok(pane.authorRight <= pane.contentLeft + 0.5, 'multi-pane author overlaps message');
      assert.ok(pane.contentWidth > 0, 'multi-pane message has no available width');
    }
    await page.setContent(`<style>${styles}</style><main id="fixture" class="chat-log"></main>`);
    const rowFunction = appSource.slice(appSource.indexOf('function createMessageRow('), appSource.indexOf('\nfunction messageLinks('));
    const visibleBadgesFunction = appSource.slice(appSource.indexOf('function visibleMessageBadges('), appSource.indexOf('\nfunction addMessage('));
    await page.addScriptTag({ content: `
      const state = { velora: { canModerate: false } };
      const loadTwitchChatBadges = () => {}, messageLinks = () => [];
      const traceTwitchSource = () => {};
      ${visibleBadgesFunction}
      const escapeHtml = value => { const el = document.createElement('span'); el.textContent = value || ''; return el.innerHTML; };
      const timestamp = () => '22:24', platformDisplayName = value => value, platformGlyph = () => 'T';
      const readableNameColor = () => '#fff', renderMessageBody = message => escapeHtml(message.text), renderLinkPreview = () => '';
      const renderUserBadges = badges => badges.map(() => '<span class="user-badge">B</span>').join('');
      ${rowFunction}
    ` });
    await page.evaluate(() => {
      for (const channel of ['tehkluma', 'xthyqueen']) {
        document.querySelector('#fixture').append(createMessageRow({
          platform: 'twitch', author: 'VeryLongTwitchUsername1234', authorLogin: 'verylongtwitchusername1234',
          sourceChannelLogin: channel, sourceAttribution: 'explicit', sourceChannelAuthoritative: true,
          destinationChannel: 'tehkluma', pronouns: 'They/Them',
          badges: Array.from({ length: 10 }, () => ({ type: 'moderator' })), text: 'Readable chat message'
        }));
      }
    });
    for (const width of [900, 420, 320]) {
      await page.setViewportSize({ width, height: 500 });
      const rows = await page.evaluate(() => [...document.querySelectorAll('.message-row')].map(row => {
        const author = row.querySelector('.message-author');
        return { text: author.textContent, scroll: author.scrollWidth, width: author.clientWidth,
          channel: row.querySelector('.chat-channel-name').textContent,
          bodyWidth: row.querySelector('.message-content').clientWidth };
      }));
      assert.deepEqual(rows.map(row => row.channel), ['tehkluma', 'xthyqueen']);
      for (const row of rows) {
        assert.equal(row.text, 'VeryLongTwitchUsername1234');
        assert.ok(row.width >= row.scroll - 1, `actual renderer clips username at ${width}px`);
        assert.ok(row.bodyWidth > 100, `actual renderer leaves too little message body at ${width}px`);
      }
    }
    await page.screenshot({ path: '/tmp/neon-chat-author-source.png', fullPage: true });
    console.log('PASS main chat long-user layout: wide, narrow, hidden-column, and multi-pane rendering');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
