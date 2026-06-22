import WebSocket from 'ws';
import { writeFile, mkdir } from 'node:fs/promises';

const OUT = '/tmp/agent-stress';
const CTRL = 'ws://127.0.0.1:9223/ws';
const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);

let nextId = 1;
let ws = null;
let pending = new Map();
let helloAck = null;

function call(action, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('not connected'));
    const id = String(nextId++);
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout: ' + action));
    }, timeoutMs);
    pending.set(id, { resolve, reject, t, action });
    ws.send(JSON.stringify({ id, action, params }));
  });
}

async function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(CTRL);
    ws.on('open', () => {
      log('connected to controller, registering as client');
      ws.send(JSON.stringify({ role: 'client' }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'hello-ack') {
        log('hello-ack: extensionConnected=' + m.extensionConnected);
        helloAck = m;
        resolve(m);
      } else if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        clearTimeout(p.t);
        p.resolve(m);
      } else if (m.type === 'event') {
        if (m.event === 'extension_connected') {
          log('event: extension_connected');
          helloAck = { extensionConnected: true };
        } else if (m.event === 'extension_disconnected') {
          log('event: extension_disconnected');
          helloAck = { extensionConnected: false };
        }
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}

await mkdir(OUT, { recursive: true });

log('connecting to controller...');
await connect();

if (!helloAck.extensionConnected) {
  log('extension not yet connected — polling for up to 5 minutes');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline && !helloAck.extensionConnected) {
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!helloAck.extensionConnected) {
    log('timed out waiting for extension');
    process.exit(1);
  }
}

log('✓ extension connected — driving CNN test');

// 1. Find current active tab
var activeTabId = null;
var tabsResp = await call('tabs', {});
log('tabs: ' + JSON.stringify(tabsResp).slice(0, 500));
if (tabsResp && tabsResp.tabs) {
  for (const t of tabsResp.tabs) {
    if (t.active) { activeTabId = t.id; break; }
  }
}
log('active tab: ' + activeTabId);

if (!activeTabId) {
  log('no active tab — opening a new one');
  var openResp = await call('open', { url: 'about:blank' });
  if (openResp && openResp.tabId) {
    activeTabId = openResp.tabId;
    log('opened new tab: ' + activeTabId);
  }
}

if (!activeTabId) { log('no tab available'); process.exit(1); }

// 2. Open cnn.com in a new tab (so the user keeps their current tab)
log('opening cnn.com in a new tab');
var cnnTab = await call('open', { url: 'https://www.cnn.com/', newTab: true });
if (cnnTab && cnnTab.tabId) {
  activeTabId = cnnTab.tabId;
  log('cnn tab: ' + activeTabId);
}
await call('set_active_tab', { tabId: activeTabId });
await new Promise(r => setTimeout(r, 4000));

// 3. Take screenshot
log('screenshot 1: cnn home (with consent)');
var ss1 = await call('screenshot', { readOnly: true });
if (ss1 && ss1.ok && ss1.dataUrl) {
  var b64 = ss1.dataUrl.split(',')[1];
  await writeFile(OUT + '/relay-cnn-01-with-consent.png', Buffer.from(b64, 'base64'));
  log('saved relay-cnn-01-with-consent.png');
}

// 4. Dismiss consent by clicking Agree
log('finding + clicking Agree');
var tags = await call('tag_elements', { max: 50 });
if (tags && tags.ok) {
  log('  ' + tags.count + ' elements tagged');
  var agreeTag = null;
  for (const t of tags.elements || []) {
    if ((t.text || '').toString().toLowerCase().match(/^agree$|^i agree$|^accept all$/i)) {
      agreeTag = t; break;
    }
  }
  if (agreeTag) {
    log('  found [agree tag] num=' + agreeTag.num + ' text="' + agreeTag.text + '"');
    await call('click_by_tag', { num: agreeTag.num });
    await new Promise(r => setTimeout(r, 3500));
  } else {
    log('  no Agree button found by text, trying evaluate');
    // Use evaluate to find and click any element with text "Agree"
    await call('evaluate', { script: "(function(){var els=document.querySelectorAll('button,a,[role=button]');for(var i=0;i<els.length;i++){if((els[i].textContent||'').trim().toLowerCase()==='agree'){els[i].click();return 'clicked';}}return 'not found';})()" });
    await new Promise(r => setTimeout(r, 3500));
  }
}

// 5. Screenshot after consent
log('screenshot 2: cnn home (no consent)');
var ss2 = await call('screenshot', { readOnly: true });
if (ss2 && ss2.ok && ss2.dataUrl) {
  var b64 = ss2.dataUrl.split(',')[1];
  await writeFile(OUT + '/relay-cnn-02-home.png', Buffer.from(b64, 'base64'));
  log('saved relay-cnn-02-home.png');
}

// 6. Extract headlines
log('extracting headlines');
var headlineResp = await call('evaluate', { script: "Array.from(document.querySelectorAll('h1, h2, h3')).map(function(h){return h.textContent.trim().replace(/\\\\s+/g,' ');}).filter(function(t){return t.length>20&&t.length<250;})" });
var headlines = headlineResp && headlineResp.result || [];
var unique = Array.from(new Set(headlines));
log('top headlines (' + unique.length + '):');
for (const h of unique.slice(0, 12)) log('  • ' + h.slice(0, 100));

// 7. Scroll down
log('scrolling down 1000px');
await call('scroll', { direction: 'down', amount: 1000 });
await new Promise(r => setTimeout(r, 2000));

var ss3 = await call('screenshot', { readOnly: true });
if (ss3 && ss3.ok && ss3.dataUrl) {
  var b64 = ss3.dataUrl.split(',')[1];
  await writeFile(OUT + '/relay-cnn-03-scroll1.png', Buffer.from(b64, 'base64'));
  log('saved relay-cnn-03-scroll1.png');
}

// 8. Scroll more via scrollIntoView
log('scrolling to mid-page via scrollIntoView');
await call('evaluate', { script: "(function(){var h=document.querySelectorAll('h2')[10];if(h){h.scrollIntoView({block:'center'});return h.textContent.slice(0,50);}return null;})()" });
await new Promise(r => setTimeout(r, 2000));

var ss4 = await call('screenshot', { readOnly: true });
if (ss4 && ss4.ok && ss4.dataUrl) {
  var b64 = ss4.dataUrl.split(',')[1];
  await writeFile(OUT + '/relay-cnn-04-mid.png', Buffer.from(b64, 'base64'));
  log('saved relay-cnn-04-mid.png');
}

// 9. Get page stats
var stats = await call('evaluate', { script: "({y:window.scrollY,h:document.documentElement.scrollHeight,hl:document.querySelectorAll('h1,h2,h3').length,a:document.querySelectorAll('a').length,img:document.querySelectorAll('img').length})" });
log('stats: ' + JSON.stringify(stats && stats.result));

// 10. Find the main hero article
log('finding main hero article');
var heroResp = await call('evaluate', { script: "(function(){var all=document.querySelectorAll('a h1,a h2,a h3,h1 a,h2 a,h3 a');var c=[];for(var i=0;i<all.length;i++){var h=all[i];var r=h.getBoundingClientRect();if(r.width<300||r.height<20)continue;if(r.top>800)continue;var t=h.textContent.trim().replace(/\\\\s+/g,' ');if(t.length<25||t.length>250)continue;var a=h.closest('a')||(h.tagName==='A'?h:null);if(!a||!a.href||a.href.indexOf('cnn.com')===-1||a.href===location.href)continue;c.push({text:t,href:a.href,w:Math.round(r.width),h:Math.round(r.height)});}c.sort(function(a,b){return(b.w*b.h)-(a.w*a.h)});return c.slice(0,3);})()" });
var heroes = heroResp && heroResp.result || [];
if (heroes.length) {
  log('hero articles:');
  for (const h of heroes) log('  "' + h.text.slice(0, 60) + '" → ' + h.href);
  log('navigating to: ' + heroes[0].href);
  await call('navigate', { url: heroes[0].href });
  await new Promise(r => setTimeout(r, 4000));
  
  var info = await call('inspect', {});
  log('article page url: ' + (info && info.result && info.result.url));
  log('article page title: ' + (info && info.result && info.result.title));
  
  var ss5 = await call('screenshot', { readOnly: true });
  if (ss5 && ss5.ok && ss5.dataUrl) {
    var b64 = ss5.dataUrl.split(',')[1];
    await writeFile(OUT + '/relay-cnn-05-article.png', Buffer.from(b64, 'base64'));
    log('saved relay-cnn-05-article.png');
  }
  
  // Extract article content
  var articleResp = await call('evaluate', { script: "(function(){var ps=[];var sels=['article p','[data-component-name=\"ArticleBody\"] p','.article__content p','main p'];for(var s=0;s<sels.length;s++){var f=document.querySelectorAll(sels[s]);if(f.length>=3){ps=Array.from(f);break;}}if(!ps.length)ps=Array.from(document.querySelectorAll('p')).slice(0,20);var text=ps.map(function(p){return p.innerText.trim();}).filter(function(t){return t.length>30;});return{paragraphs:text.length,words:text.join(' ').split(/\\\\s+/).filter(function(w){return w.length>2;}).length,first:text[0]||null,second:text[1]||null};})()" });
  var article = articleResp && articleResp.result || {};
  log('article: ' + article.paragraphs + ' paragraphs, ' + article.words + ' words');
  if (article.first) log('  p1: ' + article.first.slice(0, 300));
  if (article.second) log('  p2: ' + article.second.slice(0, 300));
}

log('DONE — all 5 screenshots should be in ' + OUT);
process.exit(0);
