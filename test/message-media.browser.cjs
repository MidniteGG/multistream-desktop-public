// PLAYWRIGHT_MODULE_PATH may point to an existing Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const app = path.join(__dirname, '../app');
const source = fs.readFileSync(path.join(app, 'app.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}
const names = ['escapeHtml', 'timestamp', 'messageLinks', 'linkifyText', 'isGifUrl',
  'isInlineImageUrl', 'renderInlineMediaText', 'veloraUsernameFromUrl', 'renderLinkPreview',
  'renderMessageBody', 'platformGlyph', 'platformDisplayName', 'createMessageRow',
  'scrollLogToLatest', 'buildWorkspace', 'renderMessages'];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="purple"/><text x="60" y="210" fill="white" font-size="40">FULL FRAME</text></svg>';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    let releaseImage;
    const imageReady = new Promise(resolve => { releaseImage = resolve; });
    await page.route('https://media.test/**', async route => {
      if (route.request().url().includes('delayed')) await imageReady;
      await route.fulfill({ contentType: 'image/svg+xml', body: svg });
    });
    for (const width of [560, 380]) {
      await page.goto('about:blank');
      await page.setViewportSize({ width, height: 700 });
      await page.setContent('<input id="searchInput"><main id="chatWorkspace" style="height:500px"></main>');
      await page.addStyleTag({ path: path.join(app, 'styles.css') });
      await page.addScriptTag({ content: `
        window.state = {paused:false,activeView:'all',messages:[],noticeHistory:[],settings:{paneCount:1,paneViews:['all'],systemMessages:true},twitch:{emotes:new Map()},velora:{}};
        const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
        const saveSettings = () => {}, readableNameColor = () => '#fff', renderUserBadges = badges => badges ? '<span class="user-badge moderator">M</span>' : '',
          renderVeloraProfilePreview = () => '<a class="chat-media-preview"><img class="chat-inline-image" src="https://media.test/profile.png"></a>';
        ${names.map(functionSource).join('\n')}
        window.draw = renderMessages;
        const base = {platform:'twitch',author:'Viewer',channel:'tehkluma',sourceChannelLogin:'xthyqueen',text:'',at:new Date()};
        state.messages = [
          {...base,author:'tehKluma',sourceChannelLogin:'tehkluma',text:'text only'},
          {...base,author:'Sery_Bot',badges:['moderator'],twitchFragments:[{type:'gif',url:'https://media.test/native.gif'}]},
          {...base,author:'DontBlameLexi',pronouns:'He/Him',sourceChannelLogin:'Lil_Lexi',text:'text https://media.test/pasted.gif'},
          {...base,author:'a',text:'https://velora.tv/creator'},
          {...base,author:'VeryLongUsernameHere',twitchFragments:[{type:'text',text:'Kappa '},{type:'gif',url:'https://media.test/mixed.gif'}]},
          {...base,sourceChannelLogin:'long_channel_name_12345678',twitchFragments:[{type:'gif',url:'https://media.test/last.gif'}]}
        ];
        state.twitch.emotes.set('Kappa',{url:'https://media.test/emote.png',provider:'Twitch'});
        buildWorkspace();
      ` });
      await page.waitForFunction(() => [...document.images].every(img => img.complete));
      await page.waitForTimeout(150);
      const result = await page.evaluate(() => {
        const log = document.querySelector('.chat-log');
        const rows = [...log.querySelectorAll('.message-row')];
        return { rows: rows.length, gap: log.scrollHeight - log.scrollTop - log.clientHeight,
          cases: rows.map(row => {
            const content = row.querySelector('.message-content');
            const author = row.querySelector('.message-author-block').getBoundingClientRect();
            const media = [...row.querySelectorAll('img')];
            const chip = row.querySelector('.chat-channel');
            const chipName = chip.querySelector('.chat-channel-name');
            return { authorTop:author.top, contentTop:content.getBoundingClientRect().top, contentLeft:content.getBoundingClientRect().left,
              source:chipName.textContent, title:chip.title, font:parseFloat(getComputedStyle(chip).fontSize),
              below:chip.getBoundingClientRect().top>=row.querySelector('.author-line').getBoundingClientRect().bottom,
              interactive:chip.matches('a,button,[role="button"]'),
              truncated:chipName.scrollWidth>chipName.clientWidth,
              ownership: media.every(img => content.contains(img)),
              contained: media.every(img => {const r=img.getBoundingClientRect(),c=content.getBoundingClientRect();return r.left>=c.left-1&&r.right<=c.right+1&&r.bottom<=c.bottom+1;}),
              metadata:row.querySelectorAll('.message-author-block').length };
          }) };
      });
      assert.equal(result.rows, 6);
      assert.equal(new Set(result.cases.map(item=>item.contentLeft)).size, 1, 'All authors/media must share the same content X');
      assert.ok(result.gap <= 1, JSON.stringify(result));
      for (const item of result.cases) {
        assert.ok(item.ownership && item.contained, JSON.stringify(item));
        assert.equal(item.metadata, 1);
        assert.ok(Math.abs(item.authorTop-item.contentTop)<4, JSON.stringify(item));
        assert.ok(item.font>=10 && item.font<=11 && item.below && !item.interactive, JSON.stringify(item));
        assert.equal(item.title, '#'+item.source);
      }
      assert.deepEqual(result.cases.map(item=>item.source), ['tehkluma','xthyqueen','Lil_Lexi','xthyqueen','xthyqueen','long_channel_name_12345678']);
      assert.ok(result.cases[5].truncated, 'Long source channel must truncate');
      for (const classes of ['hide-timestamps', 'hide-badges', 'hide-timestamps hide-badges']) {
        await page.evaluate(classes => { document.body.className = classes; }, classes);
        assert.equal(await page.evaluate(() => new Set([...document.querySelectorAll('.message-content')].map(el=>el.getBoundingClientRect().left)).size), 1, classes);
      }
      await page.evaluate(() => { document.body.className = ''; });
      console.log(`PASS ${width}px: six message cases, media ownership, author alignment, full newest frame`);
    }
    await page.evaluate(() => {
      state.messages.push({platform:'twitch',author:'Delayed',channel:'xthyqueen',text:'',at:new Date(),twitchFragments:[{type:'gif',url:'https://media.test/delayed.gif'}]});
      draw();
    });
    releaseImage();
    await page.waitForFunction(() => [...document.images].every(img => img.complete));
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => {const l=document.querySelector('.chat-log');return l.scrollHeight-l.scrollTop-l.clientHeight<=1;}));
    await page.evaluate(() => {state.paused=true;document.querySelector('.chat-log').scrollTop=0;draw();});
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.chat-log').evaluate(log=>log.scrollTop),0);
    await page.screenshot({path:'/tmp/neon-message-media-verified.png'});
    console.log('PASS delayed media loading and paused scroll position');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
