const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const source=fs.readFileSync('worker/worker.js','utf8');
const secret='SYNTHETIC_LOCAL_TEST_SECRET_0123456789';
const sandbox={TextEncoder,TextDecoder,URL,URLSearchParams,Request,Response,Headers,crypto:globalThis.crypto,btoa,atob,console:{error(){},log(){}}};
vm.createContext(sandbox);
vm.runInContext(source.replace('export default {','globalThis.worker = {')+';globalThis.h={signJWT,hashPassword,checkPassword,requireUser};',sandbox);
const {worker,h}=sandbox;
async function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync('schema.sql','utf8'));t.after(()=>db.close());
 const hash=await h.hashPassword('local-test-password');
 db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at,profile_public,history_public) VALUES(?,?,?,?,?,?,?)').run('u','tester','Tester',hash,1,0,0);
 let epochFailure=false;
 const env={JWT_SECRET:secret,DB:{prepare(sql){let args=[];const q={bind(...v){args=v;return q},async first(){if(epochFailure&&sql.startsWith('SELECT token_epoch'))throw Error('Synthetic database failure');return db.prepare(sql).get(...args)||null},async all(){return {results:db.prepare(sql).all(...args)}},async run(){return db.prepare(sql).run(...args)}};return q}}};
 const token=await h.signJWT({sub:'u',username:'tester',epoch:0},secret);
 async function request(path,method='GET',body,auth=token){
  const res=await worker.fetch(new Request('https://local.test/api'+path,{method,headers:{...(auth?{Authorization:'Bearer '+auth}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env,{});
  return {status:res.status,data:await res.json()};
 }
 return {db,env,token,request,failEpoch:()=>{epochFailure=true}};
}
test('login returns actual private settings, not invented public defaults',async t=>{
 const f=await fixture(t);const r=await f.request('/auth/login','POST',{username:'tester',password:'local-test-password'},'');
 assert.equal(r.status,200);assert.deepEqual(r.data.settings,{historyPublic:false,profilePublic:false});assert.ok(r.data.token);
});
test('registration returns actual persisted settings',async t=>{
 const f=await fixture(t);const r=await f.request('/auth/register','POST',{username:'another',password:'local-test-password'},'');
 assert.equal(r.status,201);assert.deepEqual(r.data.settings,{historyPublic:true,profilePublic:true});
});
test('revoked tokens and deleted users are rejected',async t=>{
 const f=await fixture(t);f.db.prepare('UPDATE users SET token_epoch=1').run();assert.equal((await f.request('/progress')).status,401);
 f.db.prepare('DELETE FROM users').run();assert.equal((await f.request('/progress')).status,401);
});
test('database failure closes authorization with 503, never returns history',async t=>{
 const f=await fixture(t);f.failEpoch();const r=await f.request('/progress');assert.equal(r.status,503);assert.equal(r.data.code,'auth.state_unavailable');assert.equal(r.data.items,undefined);
});
test('malformed JWTs are 401, not internal 500',async t=>{
 const f=await fixture(t);for(const bad of ['a.b.!','!!!.e30.signature','e30.bm90LWpzb24.x'])assert.equal((await f.request('/progress','GET',undefined,bad)).status,401);
});
test('future token epoch is rejected even with a valid signature',async t=>{
 const f=await fixture(t);const forgedEpoch=await h.signJWT({sub:'u',epoch:99},secret);assert.equal((await f.request('/progress','GET',undefined,forgedEpoch)).status,401);
});
test('null and array JSON bodies produce 400, not a leaked TypeError',async t=>{
 const f=await fixture(t);for(const body of [null,[],42,'value']){const r=await f.request('/auth/login','POST',body,'');assert.equal(r.status,400);assert.equal(r.data.code,'request.invalid_body');}
});
test('privacy settings require actual booleans and preserve existing values on error',async t=>{
 const f=await fixture(t);const bad=await f.request('/settings','PUT',{historyPublic:'false',profilePublic:'false'});assert.equal(bad.status,422);
 assert.equal(f.db.prepare('SELECT profile_public FROM users').get().profile_public,0);
 const good=await f.request('/settings','PUT',{historyPublic:true,profilePublic:false});assert.equal(good.status,200);assert.deepEqual(good.data.settings,{historyPublic:true,profilePublic:false});
});
test('password change atomically revokes old sessions and issues a valid replacement',async t=>{
 const f=await fixture(t);const r=await f.request('/auth/password','PUT',{currentPassword:'local-test-password',newPassword:'different-local-password'});assert.equal(r.status,200);
 assert.equal(f.db.prepare('SELECT token_epoch FROM users').get().token_epoch,1);assert.equal((await f.request('/progress')).status,401);
 assert.equal((await f.request('/progress','GET',undefined,r.data.token)).status,200);
 assert.equal(await h.checkPassword('different-local-password',f.db.prepare('SELECT password_hash FROM users').get().password_hash),true);
});
test('logout-all increments epoch and invalidates its own token',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/auth/logout-all','POST',{})).status,200);assert.equal((await f.request('/progress')).status,401);
 assert.equal(f.db.prepare('SELECT token_epoch FROM users').get().token_epoch,1);
});
test('privacy columns missing from old DB do not fall back to public defaults',async t=>{
 const f=await fixture(t);f.db.exec('ALTER TABLE users DROP COLUMN profile_public');const r=await f.request('/auth/login','POST',{username:'tester',password:'local-test-password'},'');
 assert.equal(r.status,500);assert.equal(r.data.token,undefined);assert.equal(r.data.error,'An internal error occurred');
});
test('v6 and v7 upgrade the documented nickname schema without losing rows',()=>{
 const old=fs.readFileSync('schema.sql','utf8').replace(/^.*token_epoch\s+INTEGER.*\n/m,'  legacy_padding INTEGER DEFAULT 0\n').replace(/^.*kodik_json.*\n/m,'');
 const db=new DatabaseSync(':memory:');try{
  db.exec(old);db.prepare('INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)').run('u','tester','unchanged-hash',1);
  db.prepare('INSERT INTO progress(user_id,anime_id,updated_at,time_sec) VALUES(?,?,?,?)').run('u','al-1',100,42);
  db.exec(fs.readFileSync('migrate-v6.sql','utf8'));db.exec(fs.readFileSync('migrate-v7.sql','utf8'));
  assert.equal(db.prepare('SELECT token_epoch FROM users').get().token_epoch,0);const row=db.prepare('SELECT * FROM progress').get();assert.equal(row.time_sec,42);assert.equal(row.kodik_json,null);
 }finally{db.close()}
});

test('watchlist is independent of progress, private and validates statuses',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/watchlist','GET',undefined,'')).status,401);
 const item={name:'Future show',poster:'javascript:bad',status:'planned',ts:100};
 assert.equal((await f.request('/watchlist/al-42','PUT',item)).status,200);
 assert.equal((await f.request('/progress')).data.items.length,0);
 const list=(await f.request('/watchlist')).data.items;
 assert.equal(list.length,1);assert.equal(list[0].status,'planned');assert.equal(list[0].poster,'');
 assert.equal((await f.request('/watchlist/al-42','PUT',{...item,status:'invalid'})).status,422);
 assert.equal((await f.request('/watchlist/not-an-id','PUT',item)).status,422);
 f.db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES('v','other','unused',1)").run();
 const other=await h.signJWT({sub:'v',epoch:0},secret);
 assert.equal((await f.request('/watchlist','GET',undefined,other)).data.items.length,0);
});
test('watchlist tombstones survive stale offline writes; account deletion cascades',async t=>{
 const f=await fixture(t);const item={name:'Show',status:'planned',ts:100};
 await f.request('/watchlist/42','PUT',item);
 await f.request('/watchlist/42','PUT',{...item,status:'removed',ts:300});
 await f.request('/watchlist/42','PUT',{...item,status:'watching',ts:200});
 assert.equal((await f.request('/watchlist')).data.items[0].status,'removed');
 f.db.prepare("DELETE FROM users WHERE id='u'").run();
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM watchlist').get().n,0);
});
test('spoiler flag roundtrips on title, profile and account export',async t=>{
 const f=await fixture(t);
 const bad=await f.request('/comments','POST',{animeId:'42',body:'bad',spoiler:'false'});assert.equal(bad.status,422);
 const r=await f.request('/comments','POST',{animeId:'42',animeName:'Show',body:'The ending',spoiler:true});
 assert.equal(r.status,201);assert.equal(r.data.item.spoiler,true);
 assert.equal((await f.request('/comments/42')).data.items[0].spoiler,true);
 assert.equal((await f.request('/users/tester')).data.comments[0].spoiler,true);
 assert.equal((await f.request('/account/export')).data.comments[0].spoiler,1);
});
test('v8 migration preserves old comments and progress; defaults to no spoiler',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const schema=fs.readFileSync('schema.sql','utf8').replace(/^.*spoiler.*\n/m,'').split('CREATE TABLE IF NOT EXISTS watchlist')[0];
 db.exec(schema);db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES('u','tester','unused',1)").run();
 db.prepare("INSERT INTO comments(id,anime_id,user_id,body,created_at) VALUES('c','42','u','Original',1)").run();
 db.prepare("INSERT INTO progress(user_id,anime_id,updated_at) VALUES('u','42',1)").run();
 db.exec(fs.readFileSync('migrate-v8.sql','utf8'));
 assert.equal(db.prepare('SELECT body,spoiler FROM comments').get().body,'Original');
 assert.equal(db.prepare('SELECT spoiler FROM comments').get().spoiler,0);
 assert.equal(db.prepare('SELECT count(*) AS n FROM progress').get().n,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM watchlist').get().n,0);
});
