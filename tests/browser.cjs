const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const output = process.env.AW_TEST_OUTPUT || '/data/site-qa';
fs.mkdirSync(output,{recursive:true});
const title = (id='al-178789') => ({id,_kodik:true,_mal:123,_eps:24,_epsTotal:24,name:{main:'MUSHOKU TENSEI III: ISEKAI ITTARA HONKI DASU VERY LONG TITLE'},poster:{src:''},description:'Test description '.repeat(20),genres:['Adventure','Drama']});
(async()=>{
 const browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),args:['--no-sandbox']});
 const page = await browser.newPage(); const errors=[], checks=[];
 page.on('pageerror', e=>errors.push(e.message));
 await page.route('**/*',async r=>{
  const url=r.request().url();
  if(url.startsWith('http://127.0.0.1:8787/api/kodik/token')) {await new Promise(res=>setTimeout(res,160));return r.fulfill({json:{token:'test-token'}});}
  if(url.includes('/api/')) return r.fulfill({json:{items:[],comments:[],users:[]}});
  if(url.includes('graphql.anilist.co')) return r.fulfill({json:{data:{Media:{idMal:123,episodes:24},Page:{media:[]}}}});
  if(url.includes('anilibria.top')) return r.fulfill({json:[]});
  if(/^https:\/\/(kodikplayer.com|aniqit.com)/.test(url)) return r.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;background:#16141e;color:white;display:grid;place-items:center;height:100vh;font:20px monospace">Kodik protocol test iframe</body></html>'});
  if(url.startsWith('http://127.0.0.1:8787')) return r.continue();
  return r.abort();
 });
 await page.goto('http://127.0.0.1:8787/'); await page.waitForFunction(()=>!!window.AniWired);
 await page.evaluate(t=>{
  localStorage.setItem(AniWired.historyKey,JSON.stringify({[t.id]:{id:t.id,name:t.name.main,idx:13,time:1338,duration:1440,source:'kodik',epTotal:24,ts:1,kodik:{mal:123,translation:609,season:2},seen:[13]}}));
  return openKodikTitle(t);
 },title());
 let src=await page.locator('#embedFrame').getAttribute('src');
 assert.equal(new URL(src).searchParams.get('episode'),'14');
 assert.equal(new URL(src).searchParams.get('translation'),'609');
 assert.equal(new URL(src).searchParams.get('start_from'),'1338'); checks.push('delayed initialization restores ep14/dub/season/time');
 const send=async event=>{
  await page.waitForTimeout(40);
  const frame=page.frames().find(f=>/^https:\/\/(kodikplayer.com|aniqit.com)/.test(f.url()));
  assert.ok(frame,'mock player iframe loaded');
  await frame.evaluate(e=>parent.postMessage(e,'http://127.0.0.1:8787'),event); await page.waitForTimeout(40);
 };
 await send({key:'kodik_player_video_link',value:{episode:15,season:2,translation:{id:777}}});
 await send({key:'kodik_player_time_update',value:42});
 await page.evaluate(()=>saveProgress());
 assert.equal(await page.locator('#kodikEp').inputValue(),'15');
 assert.equal(await page.locator('.ep.active').textContent(),'Episode 15');
 let saved=await page.evaluate(()=>AniWired.readHistory()['al-178789']);
 assert.equal(saved.idx,14); assert.equal(saved.time,42); assert.equal(saved.kodik.translation,777); checks.push('internal player next/dub event synchronizes UI and history');
 await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:'https://kodikplayer.com',source:window,data:{key:'kodik_player_change_episode',value:1}})));
 assert.equal(await page.locator('#kodikEp').inputValue(),'15'); checks.push('unrelated window cannot overwrite iframe state');
 await page.addStyleTag({content:'html{scroll-behavior:auto!important}'});
 await page.locator('.ep[data-idx="15"]').scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
 await page.locator('.ep[data-idx="15"]').click();
 src=await page.locator('#embedFrame').getAttribute('src'); assert.equal(new URL(src).searchParams.get('episode'),'16'); assert.equal(new URL(src).searchParams.has('start_from'),false);assert.equal(new URL(src).searchParams.get('translation'),'777');
 checks.push('site episode selection keeps dub and clears old time');
 // Opening from catalog without explicit resume restores the newest checkpoint.
 await page.evaluate(t=>openKodikTitle(t),title());
 src=await page.locator('#embedFrame').getAttribute('src');assert.equal(new URL(src).searchParams.get('episode'),'16'); checks.push('reopen preserves selection even before playback');
 await page.evaluate(async()=>{ current.ep = 0; current.mode = 'libria'; await window.setMode('kodik'); });
 assert.equal(await page.evaluate(()=>current.ep),15);
 assert.equal(await page.locator('#kodikEp').inputValue(),'16');
 checks.push('returning from another source keeps Kodik selection and UI consistent');
 // Start a slow lookup, then leave for another title. The old lookup must not win.
 await page.evaluate(t=>{localStorage.removeItem('kodik:token');openKodikTitle({...t,id:'al-111',_mal:111});openKodikTitle({...t,id:'al-222',_mal:222});},title());
 await page.waitForTimeout(500);
 src=await page.locator('#embedFrame').getAttribute('src');assert.equal(new URL(src).searchParams.get('shikimoriID'),'222');assert.equal(await page.evaluate(()=>current.title.id),'al-222'); checks.push('out-of-order player lookup cannot replace a new title');
 // A real reload must resolve assets from root and apply persisted selections.
 await page.evaluate(t=>{sessionStorage.setItem('aw:kodik:'+t.id,JSON.stringify(t));history.replaceState({},'', '/title/'+t.id)},title());
 // Python static server lacks SPA fallback, so fulfill only the document route.
 await page.route('http://127.0.0.1:8787/title/**',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync('public/index.html','utf8')}));
 await page.reload(); await page.waitForFunction(()=>document.querySelector('#embedFrame').src.includes('episode=16'));
 checks.push('deep-link reload loads assets and selection');
 const layout=[];
 for(const width of [320,360,390,430,560,768,900,1024,1280,1440,1920]){
  await page.setViewportSize({width,height:900});await page.waitForTimeout(50);
  const metrics=await page.evaluate(()=>{
   const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
   return {doc:document.documentElement.scrollWidth,view:innerWidth,header:rect('header'),bar:rect('.bar'),detail:rect('.detail'),player:rect('#embedWrap'),title:rect('#dTitle'),nav:rect('.nav'),search:rect('.search')};
  });
  assert.ok(metrics.doc<=width+1,`document overflow at ${width}: ${metrics.doc}`);
  for(const name of ['bar','detail','player','title','nav','search']) assert.ok(metrics[name].x>=-1 && metrics[name].right<=width+1,`${name} outside viewport ${width}: ${JSON.stringify(metrics[name])}`);
  assert.ok(metrics.player.y>=metrics.header.bottom,`header overlaps player ${width}`);
  layout.push({width,status:'pass'});
  if(width===390 || width===1440) await page.screenshot({path:`${output}/detail-${width}.png`,fullPage:true});
 }
 checks.push('detail layout fits 11 mobile/tablet/desktop widths');
 // Force hero content for layout coverage without depending on public APIs.
 await page.evaluate(()=>{showHome(false);el.hero.classList.remove('hidden');el.heroTitle.textContent='TONGARI BOUSHI NO ATELIER';el.heroDesc.textContent='A long featured description '.repeat(20);el.heroMeta.textContent='ONA • 2026 • Adventure, Drama, Fantasy';});
 for(const width of [320,390,768,1024,1440,1920]){
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`home overflow ${width}`);
  if(width===390 || width===1440) await page.screenshot({path:`${output}/home-${width}.png`,fullPage:true});
 }
 checks.push('home layout fits 6 viewport widths');
 assert.deepEqual(errors,[]);
 const result={checks,layout,pageErrors:errors};fs.writeFileSync(`${output}/browser-results.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
