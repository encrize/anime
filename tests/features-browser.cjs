// Local-only feature regression suite. External providers and account APIs use deterministic fixtures.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const base=process.env.AW_TEST_BASE || 'http://127.0.0.1:8787';
const out=process.env.AW_TEST_OUTPUT || '/data/features-qa';fs.mkdirSync(out,{recursive:true});
const fixture={id:42,idMal:42,title:{romaji:'Future Show'},episodes:12,format:'TV',seasonYear:2026,genres:['Action'],coverImage:{}};
const hist=id=>({id,name:'Watched '+id,idx:1,time:54,duration:1440,source:'kodik',seen:[0],ts:1,epTotal:12});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
 const ctx=await browser.newContext({reducedMotion:'reduce'});const page=await ctx.newPage();const errors=[],checks=[],calls=[];
 const remote={},deletes=[];let listOffline=false;
 page.on('pageerror',e=>errors.push(e.message));
 await ctx.route('**/*',async r=>{
  const req=r.request(),url=new URL(req.url()),path=url.pathname,method=req.method();
  if(url.origin===base){
   if(path.startsWith('/api/')){
    const body=req.postData()?JSON.parse(req.postData()):{};
    calls.push({path,method,body});
    const user={id:'alice',username:'alice',displayName:'Alice'};
    if(path==='/api/auth/login')return r.fulfill({json:{token:'fixture-token',user,settings:{historyPublic:false,profilePublic:false}}});
    if(path==='/api/auth/me')return r.fulfill({json:{user,settings:{historyPublic:false,profilePublic:false}}});
    if(path==='/api/watchlist' || path.startsWith('/api/watchlist/')){
     if(listOffline)return r.fulfill({status:503,json:{error:'Offline fixture'}});
     if(method==='PUT'){remote[body.id]={...body,dirty:undefined};return r.fulfill({json:{ok:true}})}
     return r.fulfill({json:{items:Object.values(remote)}});
    }
    if(path.startsWith('/api/progress')&&method==='DELETE'){deletes.push(path);return r.fulfill({json:{ok:true}})}
    if(path==='/api/comments/al-42')return r.fulfill({json:{items:[{id:'c',body:'THE SECRET ENDING',spoiler:true,user:{username:'alice'}}]}});
    if(path==='/api/users/bob')return r.fulfill({json:{user,settings:{historyPublic:true,profilePublic:true},stats:{},items:[],comments:[{id:'c',animeId:'al-42',body:'PROFILE SECRET',spoiler:true}],friends:[]}});
    if(path==='/api/kodik/token')return r.fulfill({json:{token:'test'}});
    return r.fulfill({json:{ok:true,items:[],comments:[],friends:[],followers:[],following:[]}});
   }
   if(/^\/(title\/|profile|u\/|genre\/)/.test(path))return r.fulfill({contentType:'text/html',body:fs.readFileSync('public/index.html','utf8')});
   return r.continue();
  }
  if(url.hostname==='graphql.anilist.co'){
   const body=req.postDataJSON(); calls.push({graphql:body});
   return r.fulfill({json:{data:{Media:fixture,Page:{media:[fixture],pageInfo:{hasNextPage:body.variables?.page===1}}}}});
  }
  if(url.hostname==='anilibria.top')return r.fulfill({json:[]});
  if(url.hostname==='kodikplayer.com')return r.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture player</title>'});
  return r.abort();
 });
 try{
  await page.goto(base);await page.waitForFunction(()=>!!window.AniWired);
  await page.evaluate(()=>renderResults([{id:'al-42',_kodik:true,name:{main:'Future Show'},poster:{src:''}}]));
  await page.locator('.card-save').click();
  assert.equal(await page.evaluate(()=>Object.keys(AniWired.readHistory()).length),0);
  assert.equal(await page.evaluate(()=>AniWired.readWatchlist()['al-42'].status),'planned');
  await page.evaluate(()=>AniWired.goProfile());await page.locator('.saved-status').selectOption('on_hold');
  await page.locator('#pfStatusFilter').selectOption('watching');assert.equal(await page.locator('.saved-card').count(),0);
  await page.locator('#pfStatusFilter').selectOption('on_hold');assert.equal(await page.locator('.saved-card').count(),1);
  checks.push('guest can plan from catalog without playback; statuses and status filter work');
  await page.reload();await page.waitForFunction(()=>!!window.AniWired);assert.equal(await page.evaluate(()=>AniWired.readWatchlist()['al-42'].status),'on_hold');
  await page.locator('#navAuth').click();await page.locator('#authName').fill('alice');await page.locator('#authPassword').fill('test-password');await page.locator('#authSubmit').click();
  await page.waitForFunction(()=>AniWired.user?.id==='alice');await page.waitForFunction(()=>!document.querySelector('#authBack').classList.contains('show'));assert.equal(await page.evaluate(()=>Object.keys(AniWired.readWatchlist()).length),0);
  checks.push('guest list persists and is never silently assigned to an account');
  await page.evaluate(async()=>{showHome(false);await openKodikTitle({id:'al-42',_kodik:true,_mal:42,_eps:12,name:{main:'Future Show'},poster:{src:''}})});
  await page.locator('#watchStatus').selectOption('watching');await page.waitForFunction(()=>document.querySelector('#listSyncNote').textContent==='Synced');
  assert.equal(remote['al-42'].status,'watching');assert.equal(await page.evaluate(()=>Object.keys(AniWired.readHistory()).length),0);
  listOffline=true;await page.locator('#watchStatus').selectOption('completed');await page.waitForFunction(()=>document.querySelector('#listSyncNote').textContent.includes('pending'));
  assert.equal(await page.evaluate(()=>AniWired.readWatchlist()['al-42'].dirty),true);
  listOffline=false;await page.evaluate(()=>dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.querySelector('#listSyncNote').textContent==='Synced');assert.equal(remote['al-42'].status,'completed');
  await page.evaluate(async()=>{localStorage.removeItem('aw:watchlist:user:alice');await AniWired.syncWatchlist()});assert.equal(await page.evaluate(()=>AniWired.readWatchlist()['al-42'].status),'completed');
  checks.push('signed-in list syncs, restores from server and durable offline edits retry on reconnect');
  await page.waitForSelector('#cmList details');assert.equal(await page.locator('#cmList .cm-body').isVisible(),false);
  await page.locator('#cmList summary').scrollIntoViewIfNeeded();await page.waitForTimeout(600);
  await page.locator('#cmList summary').click();assert.equal(await page.locator('#cmList .cm-body').isVisible(),true);
  await page.locator('#cmInput').fill('Spoiler submission');await page.locator('#cmSpoiler').check();await page.locator('#cmSend').click();
  await page.waitForFunction(()=>!document.querySelector('#cmSpoiler').checked);assert.equal(calls.find(c=>c.path==='/api/comments'&&c.method==='POST').body.spoiler,true);
  await page.evaluate(()=>AniWired.goUser('bob'));await page.waitForSelector('#upComments details');assert.equal(await page.locator('#upComments .cm-body').isVisible(),false);
  checks.push('spoilers start hidden on title and public profile; composer sends flag');
  await page.evaluate(items=>{showHome(false);localStorage.setItem(AniWired.historyKey,JSON.stringify(Object.fromEntries(items.map(it=>[it.id,it]))));dispatchEvent(new StorageEvent('storage',{key:AniWired.historyKey}))},[hist('al-1'),hist('al-2')]);
  await page.locator('.cw-x[data-del="al-1"]').click();assert.equal(deletes.length,0);assert.equal(await page.locator('.cw-x[data-del="al-1"]').count(),0);
  await page.locator('#historyUndo button').click();assert.equal(await page.locator('.cw-x[data-del="al-1"]').count(),1);assert.equal(deletes.length,0);
  await page.locator('.cw-x[data-del="al-1"]').click();await page.reload();await page.waitForFunction(()=>!!window.AniWired&&AniWired.user?.id==='alice');
  await page.waitForSelector('#historyUndo button');await page.locator('#historyUndo button').click();assert.equal(await page.locator('.cw-x[data-del="al-1"]').count(),1);
  checks.push('history undo hides immediately, sends no DELETE, survives reload');
  await page.locator('.cw-x[data-del="al-1"]').click();await page.locator('.cw-x[data-del="al-2"]').click();
  await page.waitForFunction(()=>!AniWired.readHistory()['al-1']&&!AniWired.readHistory()['al-2'],{},{timeout:10000});assert.equal(deletes.length,2);
  checks.push('multiple history deletions commit only after the six-second grace period');
  await page.locator('#cfYear').fill('2026');await page.locator('#cfFormat').selectOption('OVA');await page.locator('#cfStatus').selectOption('FINISHED');
  await page.locator('#cfSort').selectOption('SCORE_DESC');await page.waitForFunction(()=>document.querySelector('#resultsSub').textContent.includes('1 titles'));
  const request=calls.filter(c=>c.graphql?.variables?.status==='FINISHED').at(-1).graphql;
  assert.equal(request.variables.year,2026);assert.deepEqual(request.variables.formats,['OVA']);assert.deepEqual(request.variables.sort,['SCORE_DESC']);
  await page.locator('#cfMore').focus();await page.locator('#cfMore').scrollIntoViewIfNeeded();await page.waitForTimeout(600);await page.locator('#cfMore').click();await page.waitForFunction(()=>document.querySelector('#cfMore').classList.contains('hidden'));
  assert.ok(calls.some(c=>c.graphql?.variables?.page===2));
  await page.evaluate(()=>AniWired.goGenre('Action'));await page.waitForFunction(()=>document.querySelector('#resultsSub').textContent.includes('1 titles'));
  assert.ok(calls.some(c=>c.graphql?.variables?.genre==='Action'&&c.graphql.variables.year===2026));
  await page.locator('#searchInput').fill('Future');await page.waitForTimeout(550);
  assert.ok(calls.some(c=>c.graphql?.variables?.search==='Future'&&c.graphql.variables.status==='FINISHED'));
  checks.push('year, format, release, sort, genre, search and pagination reach the remote catalog');
  await page.locator('#cfReset').click();assert.equal(await page.locator('#cfYear').inputValue(),'');assert.equal(await page.locator('#cfStatus').inputValue(),'');assert.equal(await page.locator('#cfSort').inputValue(),'POPULARITY_DESC');
  await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForFunction(()=>!!window.AniWired);
  assert.equal(await page.locator('#catalogFilters').getAttribute('open'),null);
  await page.locator('#catalogFilters summary').click();assert.equal(await page.locator('#cfYear').isVisible(),true);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:out+'/mobile-filters.png',fullPage:true});
  await page.evaluate(()=>AniWired.goProfile());
  assert.ok((await page.locator('.saved-status').boundingBox()).width > 200);
  assert.ok((await page.locator('.saved-card').boundingBox()).height < 300);
  await page.screenshot({path:out+'/mobile-list.png',fullPage:true});
  checks.push('reset clears filters; mobile filters collapse; no horizontal overflow');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(out+'/features-results.json',JSON.stringify({checks,pageErrors:errors},null,2));
  console.log(JSON.stringify({checks,pageErrors:errors},null,2));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
