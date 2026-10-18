const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),args:['--no-sandbox']});
 const context=await browser.newContext();const page=await context.newPage();const errors=[], writes=[];
 page.on('pageerror',e=>errors.push(e.message));
 const remote={id:'al-178789',idx:13,time:1338,duration:1440,source:'kodik',name:'Remote title',epTotal:24,ts:Date.now(),seen:[13],kodik:{mal:123,translation:609,season:2}};
 let authOffline=false, failWrite=true;
 await context.addInitScript(()=>localStorage.setItem('aw:token','mock-auth'));
 await context.route('**/*',async r=>{
  const req=r.request(),url=req.url();
  if(url.includes('/api/auth/me')){
   if(authOffline)return r.abort();
   await new Promise(res=>setTimeout(res,100));return r.fulfill({json:{user:{id:'u',username:'tester',displayName:'Tester'},settings:{historyPublic:true,profilePublic:true}}});
  }
  if(url.endsWith('/api/progress') && req.method()==='GET'){await new Promise(res=>setTimeout(res,150));return r.fulfill({json:{items:[remote]}});}
  if(url.endsWith('/api/progress') && req.method()==='PUT'){
   writes.push(req.postDataJSON().item);
   if(failWrite){failWrite=false;return r.fulfill({status:503,json:{error:'Simulated offline'}});}
   return r.fulfill({json:{ok:true}});
  }
  if(url.endsWith('/api/progress/bulk')){writes.push(...req.postDataJSON().items);return r.fulfill({json:{items:[]}});}
  if(url.includes('/api/kodik/search')){const tr=Number(new URL(url).searchParams.get('translationId'));return r.fulfill({json:{results:[{link:'https://kodikplayer.com/serial/mock-'+tr+'/hash/720p',translation:{id:tr}}]}});}
  if(url.includes('/api/kodik/token')) return r.fulfill({json:{token:'test'}});
  if(url.includes('/api/')) return r.fulfill({json:{items:[],comments:[],users:[],friends:[]}});
  if(url.includes('graphql.anilist.co')) return r.fulfill({json:{data:{Media:{id:178789,idMal:123,title:{romaji:'Remote title'},episodes:24},Page:{media:[]}}}});
  if(url.includes('anilibria.top'))return r.fulfill({json:[]});
  if(/^https:\/\/kodikplayer.com/.test(url) && req.resourceType()==='script') return r.fulfill({contentType:'application/javascript',body:'/* Mock external player script */'});
  if(/^https:\/\/kodikplayer.com/.test(url))return r.fulfill({contentType:'text/html',body:'<!doctype html><html><body>Test player</body></html>'});
  if(url.startsWith('http://127.0.0.1:8787/title/'))return r.fulfill({contentType:'text/html',body:fs.readFileSync('public/index.html','utf8')});
  if(url.startsWith('http://127.0.0.1:8787'))return r.continue();
  return r.abort();
 });
 await page.goto('http://127.0.0.1:8787/title/al-178789');
 await page.waitForFunction(()=>document.querySelector('#embedFrame').src.includes('episode=14'));
 let src=await page.locator('#embedFrame').getAttribute('src');assert.equal(new URL(src).searchParams.get('translation'),'609');
 const send=async e=>{await page.waitForFunction(()=>document.querySelector('#embedFrame').src.startsWith('https://kodikplayer.com')); for(let i=0;i<30 && !page.frames().some(f=>f.url().startsWith('https://kodikplayer.com'));i++)await page.waitForTimeout(100); const f=page.frames().find(f=>f.url().startsWith('https://kodikplayer.com'));if(!f)throw new Error('Missing player frame '+JSON.stringify(await page.evaluate(()=>({src:el.embedFrame.src,state:current,detail:el.detailState.textContent}))));await f.evaluate(e=>parent.postMessage(e,'http://127.0.0.1:8787'),e);await page.waitForTimeout(40)};
 await send({key:'kodik_player_time_update',value:1342});
 await page.evaluate(()=>saveProgress());
 await page.evaluate(()=>openKodikTitle({id:'al-2',_kodik:true,_mal:2,_eps:12,_epsTotal:12,name:{main:'Second remote title'},poster:{src:''}}));
 // A seeded history row avoids the intentionally preserved 30-second history threshold.
 await page.evaluate(()=>{const h=AniWired.readHistory();h['al-2']={id:'al-2',idx:0,source:'kodik',time:10,ts:1,seen:[0]};localStorage.setItem('aniwired:history',JSON.stringify(h))});
 await page.waitForTimeout(70);await send({key:'kodik_player_current_episode',value:{episode:1,translation:{id:888}}});
 await send({key:'kodik_player_time_update',value:45});await page.evaluate(()=>saveProgress());
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForTimeout(180);
 assert.ok(writes.some(x=>x.id==='al-178789'),'first title remains in pending queue');assert.ok(writes.some(x=>x.id==='al-2'),'second title flushed too');
 await page.evaluate(()=>AniWired.syncProgress(true));await page.waitForTimeout(80);
 assert.equal((await page.evaluate(()=>AniWired.readHistory()['al-2'])).kodik.translation,888);
 assert.ok(writes.some(x=>x.id==='al-178789' && x.time===1342),'failed write recoverable from local history');
 // Temporary auth server failure must not erase a valid stored token.
 authOffline=true;await page.reload();await page.waitForTimeout(350);
 assert.equal(await page.evaluate(()=>localStorage.getItem('aw:token')),'mock-auth');
 assert.deepEqual(errors,[]);
 console.log('PASS: fresh-device deep link waits for remote history; queue keeps two titles; failed writes recover; temporary auth outage keeps token; no JS errors');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
