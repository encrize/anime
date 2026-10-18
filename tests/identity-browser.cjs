// Local-only regression harness. All APIs/providers are replaced with fixtures.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const title={id:'al-1',_kodik:true,_mal:1,_eps:24,_epsTotal:24,name:{main:'Local fixture'},poster:{src:''}};
const item=(id='al-1')=>({id,name:'Local fixture',idx:0,time:5,duration:1440,source:'kodik',seen:[0,1],ts:1});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
 const passed=[];
 async function setup({signed=false,oldLogin=false}={}){
  const ctx=await browser.newContext(),calls=[],completed=[],errors=[];
  const control={failBulk:false,failDelete:false,holdPut:null,holdGet:null,hold401:null,holdMedia:null};
  const remote={alice:{},bob:{}};
  if(signed)await ctx.addInitScript(()=>{if(window===top)localStorage.setItem('aw:token','synthetic-alice')});
  await ctx.route('**/*',async r=>{
   const req=r.request(),url=new URL(req.url()),path=url.pathname,method=req.method();
   if(url.origin==='http://127.0.0.1:8787'){
    if(path.startsWith('/api/')){
     const who=(req.headers().authorization||'').replace('Bearer synthetic-','')||'alice';
     const body=req.postData()?JSON.parse(req.postData()):undefined;
     calls.push({path,method,who,body});
     const user={id:who,username:who,displayName:who};
     if(path==='/api/auth/login'){const name=body.username;return r.fulfill({json:{token:'synthetic-'+name,user:{id:name,username:name,displayName:name},...(!oldLogin?{settings:{profilePublic:false,historyPublic:false}}:{})}})}
     if(path==='/api/auth/me')return r.fulfill({json:{user,settings:{profilePublic:false,historyPublic:false}}});
     if(path==='/api/old-401'){if(control.hold401)await control.hold401;return r.fulfill({status:401,json:{error:'Old credentials'}})}
     if(path==='/api/settings'&&method==='PUT')return r.fulfill({json:{settings:body}});
     if(path==='/api/progress'&&method==='GET'){
      const snapshot=Object.values(remote[who]||{}).map(i=>({...i}));const hold=control.holdGet;control.holdGet=null;if(hold)await hold;
      return r.fulfill({json:{items:snapshot}});
     }
     if(path==='/api/progress'&&method==='PUT'){
      if(control.holdPut)await control.holdPut;
      (remote[who]??={})[body.item.id]=body.item;completed.push({method,id:body.item.id,who});return r.fulfill({json:{ok:true,item:body.item}});
     }
     if(path==='/api/progress/bulk'){
      if(control.failBulk)return r.fulfill({status:503,json:{error:'Synthetic outage'}});
      for(const i of body.items)(remote[who]??={})[i.id]=i;completed.push({method,who});return r.fulfill({json:{ok:true}});
     }
     if(path.startsWith('/api/progress')&&method==='DELETE'){
      if(control.failDelete)return r.fulfill({status:503,json:{error:'Synthetic delete failure'}});
      const id=decodeURIComponent(path.slice('/api/progress/'.length));
      if(path==='/api/progress')remote[who]={};else delete (remote[who]||{})[id];
      completed.push({method,id,who});return r.fulfill({json:{ok:true}});
     }
     if(path==='/api/kodik/token')return r.fulfill({json:{token:'synthetic-player-token'}});
     return r.fulfill({json:{items:[],comments:[],friends:[],followers:[],following:[],ok:true}});
    }
    if(/^\/(title\/|u\/|profile)/.test(path))return r.fulfill({contentType:'text/html',body:fs.readFileSync('public/index.html','utf8')});
    return r.continue();
   }
   if(url.hostname==='graphql.anilist.co'){if(control.holdMedia&&!req.postData()?.includes('Page('))await control.holdMedia;return r.fulfill({json:{data:{Page:{media:[]},Media:{id:99,idMal:1,title:{romaji:'Delayed old title'},episodes:24}}}})}
   if(url.hostname==='anilibria.top')return r.fulfill({json:[]});
   if(url.hostname==='kodikplayer.com')return r.fulfill({contentType:'text/html',body:'<!doctype html><html><body>Local player fixture</body></html>'});
   return r.abort();
  });
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto('http://127.0.0.1:8787');await page.waitForFunction(()=>!!window.AniWired);if(signed)await page.waitForFunction(()=>AniWired.user?.id==='alice');
  return {ctx,page,calls,completed,control,remote,errors};
 }
 async function check(name,fn,options){const x=await setup(options);try{await fn(x);assert.deepEqual(x.errors,[]);passed.push(name);console.log('PASS: '+name)}catch(e){console.error('Fixture errors:',x.errors);console.error(await x.page.evaluate(()=>({user:AniWired.user,token:localStorage.getItem('aw:token'),scope:AniWired.historyKey,modal:document.querySelector('#authBack').className})));throw e}finally{await x.ctx.close()}}
 async function login(page,name){
  await page.locator('#navAuth').click();await page.locator('#authName').fill(name);await page.locator('#authPassword').fill('synthetic-password');await page.locator('#authSubmit').click();
  await page.waitForFunction(name=>AniWired.user?.id===name,name);await page.waitForFunction(()=>!document.querySelector('#authBack').classList.contains('show'));
 }
 async function logout(page){await page.locator('#navAuth').click();await page.locator('#authLogout').click();await page.waitForFunction(()=>!AniWired.user,{},{timeout:3000})}
 async function seed(page,items){await page.evaluate(items=>{const map=Object.fromEntries(items.map(i=>[i.id,i]));localStorage.setItem(AniWired.historyKey,JSON.stringify(map));dispatchEvent(new StorageEvent('storage',{key:AniWired.historyKey}))},items)}
 async function start(x){
  await seed(x.page,[item()]);await x.page.evaluate(t=>openKodikTitle(t),title);
  await x.page.waitForFunction(()=>document.querySelector('#embedFrame').src.startsWith('https://kodikplayer.com'));
  let frame;for(let i=0;i<50;i++){frame=x.page.frames().find(f=>f.url().startsWith('https://kodikplayer.com'));if(frame)break;await pause(20)}assert.ok(frame);
  await frame.evaluate(()=>parent.postMessage({key:'kodik_player_time_update',value:45},'http://127.0.0.1:8787'));
  await x.page.waitForFunction(()=>current.kodikState?.time===45);await x.page.evaluate(()=>saveProgress());
 }
 const writes=x=>x.calls.filter(c=>c.path.startsWith('/api/progress')&&['PUT','POST'].includes(c.method));
 try{
  await check('login keeps private settings and changing history does not expose profile',async x=>{
   await login(x.page,'alice');await x.page.evaluate(()=>AniWired.goProfile());assert.equal(await x.page.locator('#pvProfile').isChecked(),false);assert.equal(await x.page.locator('#pvHistory').isChecked(),false);
   await x.page.locator('#pvHistory').check();await x.page.waitForFunction(()=>AniWired.settings.historyPublic===true);const saved=x.calls.find(c=>c.path==='/api/settings'&&c.method==='PUT');assert.deepEqual(saved.body,{historyPublic:true,profilePublic:false});
  });
  await check('old login API fetches real settings through auth/me',async x=>{
   await login(x.page,'alice');assert.deepEqual(await x.page.evaluate(()=>AniWired.settings),{historyPublic:false,profilePublic:false});assert.ok(x.calls.some(c=>c.path==='/api/auth/me'));
  },{oldLogin:true});
  await check('legacy and guest history are never silently uploaded into an account',async x=>{
   await seed(x.page,[item('guest-title')]);await x.page.evaluate(i=>{localStorage.setItem('aniwired:history',JSON.stringify({[i.id]:i}));localStorage.setItem('aniwired:last',JSON.stringify(i))},item('unknown-owner'));
   await login(x.page,'alice');await x.page.evaluate(()=>AniWired.syncProgress());assert.deepEqual(await x.page.evaluate(()=>AniWired.readHistory()),{});assert.equal(writes(x).length,0);
   assert.ok(await x.page.evaluate(()=>localStorage.getItem('aniwired:history')));
  });
  await check('guest history is imported only after explicit confirmation',async x=>{
   await seed(x.page,[item('guest-owned')]);await login(x.page,'alice');await x.page.evaluate(()=>AniWired.goProfile());
   assert.equal(writes(x).length,0);await x.page.locator('#importGuest').click();await x.page.waitForFunction(()=>!!AniWired.readHistory()['guest-owned']);
   for(let i=0;i<50&&!x.remote.alice['guest-owned'];i++)await pause(20);assert.ok(x.remote.alice['guest-owned']);
   assert.ok(await x.page.evaluate(()=>JSON.parse(localStorage.getItem('aniwired:history:guest'))['guest-owned']));
  });
  await check('pre-update import is explicit and keeps the original backup',async x=>{
   await x.page.evaluate(i=>localStorage.setItem('aniwired:history',JSON.stringify({[i.id]:i})),item('legacy-owned'));
   await login(x.page,'alice');await x.page.evaluate(()=>AniWired.goProfile());assert.equal(writes(x).length,0);
   await x.page.locator('#importLegacy').click();await x.page.waitForFunction(()=>!!AniWired.readHistory()['legacy-owned']);
   assert.ok(await x.page.evaluate(()=>JSON.parse(localStorage.getItem('aniwired:history'))['legacy-owned']));
   if(process.env.AW_TEST_OUTPUT){await x.page.setViewportSize({width:390,height:844});await x.page.screenshot({path:process.env.AW_TEST_OUTPUT+'/import-390.png',fullPage:true})}
  });
  await check('damaged legacy records are normalized without crashing the history UI',async x=>{
   await x.page.evaluate(()=>localStorage.setItem('aniwired:history',JSON.stringify({bad:{id:'al-bad',name:123,source:{unexpected:true},seen:'bad-array',time:'NaN',poster:'javascript:alert(1)',ts:4102444800000}})));
   await login(x.page,'alice');await x.page.evaluate(()=>AniWired.goProfile());await x.page.locator('#importLegacy').click();await x.page.waitForFunction(()=>!!AniWired.readHistory()['al-bad']);
   const saved=await x.page.evaluate(()=>AniWired.readHistory()['al-bad']);assert.equal(saved.source,'kodik');assert.equal(saved.name,'123');assert.equal(saved.time,0);assert.deepEqual(saved.seen,[]);assert.equal(saved.poster,'');assert.ok(saved.ts<=Date.now());
  });
  await check('Alice history and failed uploads stay out of Bob account; caches are scoped',async x=>{
   await seed(x.page,[item('private-alice')]);x.control.failBulk=true;await x.page.evaluate(()=>AniWired.syncProgress(true));x.control.failBulk=false;
   await x.page.evaluate(()=>localStorage.setItem('aw:kodik:checkpoints:user:alice',JSON.stringify({'al-1':{idx:10}})));
   await logout(x.page);assert.deepEqual(await x.page.evaluate(()=>AniWired.readHistory()),{});await login(x.page,'bob');await x.page.evaluate(()=>AniWired.syncProgress());
   assert.deepEqual(await x.page.evaluate(()=>AniWired.readHistory()),{});assert.equal(writes(x).some(c=>c.who==='bob'&&JSON.stringify(c.body).includes('private-alice')),false);
   assert.ok(await x.page.evaluate(()=>localStorage.getItem('aniwired:history:user:alice')));
  },{signed:true});
  await check('delayed resume cannot open the previous account title after switching identity',async x=>{
   await seed(x.page,[item('al-99')]);let release;x.control.holdMedia=new Promise(r=>release=r);
   await x.page.locator('.cw-item').click();await pause(100);await logout(x.page);await login(x.page,'bob');release();await pause(180);
   assert.equal(await x.page.evaluate(()=>current.title),null);assert.deepEqual(await x.page.evaluate(()=>AniWired.readHistory()),{});
  },{signed:true});
  await check('late history response cannot mutate the next account',async x=>{
   x.remote.alice['private-alice']=item('private-alice');let release;x.control.holdGet=new Promise(r=>release=r);
   const old=x.page.evaluate(()=>AniWired.syncProgress(true));await pause(80);await logout(x.page);await login(x.page,'bob');release();await old;
   assert.deepEqual(await x.page.evaluate(()=>AniWired.readHistory()),{});
  },{signed:true});
  await check('old 401 cannot sign out the new account',async x=>{
   let release;x.control.hold401=new Promise(r=>release=r);const old=x.page.evaluate(()=>AniWired.apiCall('/api/old-401').catch(e=>e.message));await pause(60);
   await logout(x.page);await login(x.page,'bob');release();assert.match(await old,/stale response/);assert.equal(await x.page.evaluate(()=>localStorage.getItem('aw:token')),'synthetic-bob');
  },{signed:true});
  await check('deleted item is not restored by queued PUT or pagehide',async x=>{
   await start(x);await x.page.evaluate(()=>showHome(false));await x.page.locator('.cw-x').click();await x.page.waitForFunction(()=>!AniWired.readHistory()['al-1']);
   await x.page.evaluate(()=>{dispatchEvent(new Event('pagehide'));document.dispatchEvent(new Event('visibilitychange'))});await pause(120);
   const deletion=x.calls.findIndex(c=>c.method==='DELETE'&&c.path==='/api/progress/al-1');assert.ok(deletion>=0);
   assert.equal(x.calls.slice(deletion+1).some(c=>c.method==='PUT'&&c.body?.item?.id==='al-1'),false);assert.equal(x.remote.alice['al-1'],undefined);
  },{signed:true});
  await check('DELETE waits for dispatched PUT and wins after it completes',async x=>{
   let release;x.control.holdPut=new Promise(r=>release=r);await start(x);
   await x.page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));showHome(false)});
   for(let i=0;i<50&&!x.calls.some(c=>c.method==='PUT');i++)await pause(20);assert.ok(x.calls.some(c=>c.method==='PUT'));
   await x.page.locator('.cw-x').click();await pause(100);assert.equal(x.calls.some(c=>c.method==='DELETE'),false);
   release();await x.page.waitForFunction(()=>!AniWired.readHistory()['al-1']);assert.deepEqual(x.completed.filter(c=>c.id==='al-1').map(c=>c.method),['PUT','DELETE']);
  },{signed:true});
  await check('failed deletion retains local history rather than claiming success',async x=>{
   await seed(x.page,[item()]);x.control.failDelete=true;await x.page.locator('.cw-x').click();await pause(150);assert.ok(await x.page.evaluate(()=>AniWired.readHistory()['al-1']));
  },{signed:true});
  await check('failed removal survives reload and is replayed before any upload',async x=>{
   await seed(x.page,[item()]);x.remote.alice['al-1']=item();x.control.failDelete=true;
   await x.page.locator('.cw-x').click();await pause(6300);
   assert.ok(await x.page.evaluate(()=>localStorage.getItem('aw:history:deletions:user:alice')));
   await x.page.evaluate(()=>AniWired.syncProgress(true));assert.equal(writes(x).length,0);
   x.control.failDelete=false;await x.page.reload();await x.page.waitForFunction(()=>!!window.AniWired&&AniWired.user?.id==='alice'&&!AniWired.readHistory()['al-1']);
   assert.equal(x.remote.alice['al-1'],undefined);assert.equal(await x.page.evaluate(()=>localStorage.getItem('aw:history:deletions:user:alice')),null);
   assert.equal(writes(x).length,0);
  },{signed:true});
  await check('clear history cancels queued snapshots and cannot be undone by pagehide',async x=>{
   await start(x);await x.page.evaluate(()=>{showHome(false);AniWired.goProfile()});await x.page.locator('#pfHistoryTab').click();await x.page.locator('#pfClear').click();await x.page.waitForFunction(()=>!Object.keys(AniWired.readHistory()).length);
   await x.page.evaluate(()=>dispatchEvent(new Event('pagehide')));await pause(100);const deletion=x.calls.findIndex(c=>c.method==='DELETE'&&c.path==='/api/progress');assert.ok(deletion>=0);
   assert.equal(x.calls.slice(deletion+1).some(c=>['PUT','POST'].includes(c.method)&&c.path.startsWith('/api/progress')),false);
  },{signed:true});
  await check('failed clear survives reload and blocks writes until server acknowledgement',async x=>{
   await seed(x.page,[item()]);x.remote.alice['al-1']=item();x.control.failDelete=true;
   await x.page.evaluate(()=>AniWired.goProfile());await x.page.locator('#pfHistoryTab').click();await x.page.locator('#pfClear').click();await pause(150);
   assert.equal(await x.page.evaluate(()=>JSON.parse(localStorage.getItem('aw:history:deletions:user:alice')).clear),true);
   x.control.failDelete=false;await x.page.reload();await x.page.waitForFunction(()=>!!window.AniWired&&AniWired.user?.id==='alice'&&!Object.keys(AniWired.readHistory()).length);
   assert.deepEqual(x.remote.alice,{});assert.equal(writes(x).length,0);
  },{signed:true});
  await check('unchanged snapshots with multiple watched episodes do not keep saving',async x=>{
   await start(x);const stamps=[];for(let i=0;i<3;i++){stamps.push(await x.page.evaluate(()=>{saveProgress();return AniWired.readHistory()['al-1'].ts}));await pause(30)}assert.equal(new Set(stamps).size,1);
  },{signed:true});
  await check('bulk upload sends all 205 items in bounded batches',async x=>{
   await seed(x.page,Array.from({length:205},(_,i)=>item('al-'+i)));await x.page.evaluate(()=>AniWired.syncProgress());const bulk=x.calls.filter(c=>c.path==='/api/progress/bulk');assert.deepEqual(bulk.map(c=>c.body.items.length),[200,5]);assert.equal(Object.keys(x.remote.alice).length,205);
  },{signed:true});
  console.log(JSON.stringify({passed:passed.length,checks:passed},null,2));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
