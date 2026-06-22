import WebSocket from 'ws';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const OUT = '/tmp/agent-stress';
const CTRL = 'ws://127.0.0.1:9223/ws';
const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
let nextId = 1;
const pending = new Map();
let helloAck = null;
let ws = null;

function call(action, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('ws not open'));
    const id = String(nextId++);
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + action)); }, timeoutMs);
    pending.set(id, { resolve, reject, t });
    try { ws.send(JSON.stringify({ id, action, params })); } catch (e) { reject(e); }
  });
}

await mkdir(OUT, { recursive: true });

ws = new WebSocket(CTRL);
ws.on('open', () => ws.send(JSON.stringify({ role: 'client' })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'hello-ack') { helloAck = m; return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id); p.resolve(m);
  }
});
ws.on('close', () => { log('WS closed'); });

// Wait for hello-ack + extension
while (!helloAck) await new Promise(r => setTimeout(r, 200));
log('connected; ext=' + helloAck.extensionConnected);
const deadline = Date.now() + 180 * 1000;
while (Date.now() < deadline && !helloAck.extensionConnected) {
  await new Promise(r => setTimeout(r, 500));
}
if (!helloAck.extensionConnected) { log('timed out waiting for ext'); process.exit(1); }

log('✓ extension connected');

// 1. Open cnn.com in a new tab
log('--- open cnn.com in a new tab ---');
var openResp;
try { openResp = await call('open', { url: 'https://www.cnn.com/', newTab: true }); }
catch (e) { log('open failed: ' + e.message); process.exit(1); }
log('open: ' + JSON.stringify(openResp));
var cnnTab = openResp && openResp.tabId;
if (!cnnTab) { log('no tabId from open'); process.exit(1); }

await call('set_active_tab', { tabId: cnnTab });
log('switched active tab to ' + cnnTab);
await new Promise(r => setTimeout(r, 4000));

// 2. Screenshot
log('--- screenshot 1: cnn home (with consent) ---');
try {
  var ss1 = await call('screenshot', { readOnly: true });
  if (ss1 && ss1.ok && ss1.dataUrl) {
    var b64 = ss1.dataUrl.split(',')[1];
    await writeFile(OUT + '/relay-cnn-01-consent.png', Buffer.from(b64, 'base64'));
    log('saved relay-cnn-01-consent.png');
  } else {
    log('screenshot result: ' + JSON.stringify(ss1).slice(0, 200));
  }
} catch (e) { log('screenshot 1 failed: ' + e.message); }

// 3. Find and click Agree
log('--- finding + clicking Agree ---');
try {
  var tagsResp = await call('tag_elements', { max: 50 });
  if (tagsResp && tagsResp.ok) {
    log('  ' + tagsResp.count + ' elements tagged');
    var agree = null;
    for (const t of tagsResp.elements || []) {
      if ((t.text || '').toString().toLowerCase().match(/^agree$|^i agree$|^accept all$/i)) {
        agree = t; break;
      }
    }
    if (agree) {
      log('  found [agree] num=' + agree.num + ' text="' + agree.text + '"');
      var clickResp = await call('click_by_tag', { num: agree.num });
      log('  click result: ' + JSON.stringify(clickResp).slice(0, 200));
    } else {
      log('  no Agree button found by text');
      // Try JS evaluate as fallback
      var evalResp = await call('evaluate', {
        script: "(function(){var els=document.querySelectorAll('button,a,[role=button]');for(var i=0;i<els.length;i++){if((els[i].textContent||'').trim().toLowerCase()==='agree'){els[i].click();return 'clicked';}}return 'not found';})()"
      });
      log('  eval click: ' + JSON.stringify(evalResp).slice(0, 200));
    }
  }
} catch (e) { log('tag/click failed: ' + e.message); }
await new Promise(r => setTimeout(r, 3500));

// 4. Screenshot after consent
log('--- screenshot 2: cnn home (no consent) ---');
try {
  var ss2 = await call('screenshot', { readOnly: true });
  if (ss2 && ss2.ok && ss2.dataUrl) {
    var b64 = ss2.dataUrl.split(',')[1];
    await writeFile(OUT + '/relay-cnn-02-home.png', Buffer.from(b64, 'base64'));
    log('saved relay-cnn-02-home.png');
  }
} catch (e) { log('screenshot 2 failed: ' + e.message); }

// 5. Extract headlines
log('--- extracting headlines ---');
try {
  var hlResp = await call('evaluate', {
    script: "Array.from(document.querySelectorAll('h1, h2, h3')).map(function(h){return h.textContent.trim().replace(/\\\\s+/g,' ');}).filter(function(t){return t.length>20&&t.length<250;})"
  });
  if (hlResp && hlResp.result) {
    var unique = Array.from(new Set(hlResp.result));
    log('top headlines (' + unique.length + '):');
    for (const h of unique.slice(0, 15)) log('  • ' + h.slice(0, 100));
  }
} catch (e) { log('headlines failed: ' + e.message); }

// 6. Scroll
log('--- scrolling ---');
try { await call('scroll', { direction: 'down', amount: 1000 }); log('scrolled 1000px'); } catch (e) { log('scroll failed: ' + e.message); }
await new Promise(r => setTimeout(r, 2000));

// 7. Screenshot
log('--- screenshot 3: after scroll ---');
try {
  var ss3 = await call('screenshot', { readOnly: true });
  if (ss3 && ss3.ok && ss3.dataUrl) {
    var b64 = ss3.dataUrl.split(',')[1];
    await writeFile(OUT + '/relay-cnn-03-scroll.png', Buffer.from(b64, 'base64'));
    log('saved relay-cnn-03-scroll.png');
  }
} catch (e) { log('screenshot 3 failed: ' + e.message); }

// 8. More scroll via scrollIntoView
log('--- more scroll via scrollIntoView ---');
try {
  await call('evaluate', {
    script: "(function(){var h=document.querySelectorAll('h2')[10];if(h){h.scrollIntoView({block:'center'});return h.textContent.slice(0,50);}return null;})()"
  });
} catch (e) { log('scrollIntoView failed: ' + e.message); }
await new Promise(r => setTimeout(r, 2000));

// 9. Stats
log('--- stats ---');
try {
  var statsResp = await call('evaluate', {
    script: "({y:window.scrollY,h:document.documentElement.scrollHeight,hl:document.querySelectorAll('h1,h2,h3').length,a:document.querySelectorAll('a').length})"
  });
  log('stats: ' + JSON.stringify(statsResp && statsResp.result));
} catch (e) { log('stats failed: ' + e.message); }

// 10. Find main hero
log('--- finding main hero article ---');
try {
  var heroResp = await call('evaluate', {
    script: "(function(){var all=document.querySelectorAll('a h1,a h2,a h3,h1 a,h2 a,h3 a');var c=[];for(var i=0;i<all.length;i++){var h=all[i];var r=h.getBoundingClientRect();if(r.width<300||r.height<20)continue;if(r.top>800)continue;var t=h.textContent.trim().replace(/\\\\s+/g,' ');if(t.length<25||t.length>250)continue;var a=h.closest('a')||(h.tagName==='A'?h:null);if(!a||!a.href||a.href.indexOf('cnn.com')===-1||a.href===location.href)continue;c.push({text:t,href:a.href});}c.sort(function(a,b){return b.text.length-a.text.length;});return c.slice(0,3);})()"
  });
  var heroes = heroResp && heroResp.result || [];
  if (heroes.length) {
    log('hero: "' + heroes[0].text.slice(0, 60) + '" → ' + heroes[0].href);
    log('navigating to article...');
    await call('navigate', { url: heroes[0].href });
    await new Promise(r => setTimeout(r, 4000));
    
    // Article content
    var articleResp = await call('evaluate', {
      script: "(function(){var ps=[];var sels=['article p','[data-component-name=\"ArticleBody\"] p','main p'];for(var s=0;s<sels.length;s++){var f=document.querySelectorAll(sels[s]);if(f.length>=3){ps=Array.from(f);break;}}if(!ps.length)ps=Array.from(document.querySelectorAll('p')).slice(0,20);var text=ps.map(function(p){return p.innerText.trim();}).filter(function(t){return t.length>30;});return{paragraphs:text.length,words:text.join(' ').split(/\\\\s+/).filter(function(w){return w.length>2;}).length,first:text[0]||null};})()"
    });
    log('article: ' + JSON.stringify(articleResp && articleResp.result));
    
    // Screenshot article
    var ss5 = await call('screenshot', { readOnly: true });
    if (ss5 && ss5.ok && ss5.dataUrl) {
      var b64 = ss5.dataUrl.split(',')[1];
      await writeFile(OUT + '/relay-cnn-04-article.png', Buffer.from(b64, 'base64'));
      log('saved relay-cnn-04-article.png');
    }
  }
} catch (e) { log('article nav failed: ' + e.message); }

log('DONE — all screenshots in ' + OUT);
process.exit(0);
