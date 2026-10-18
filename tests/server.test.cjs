const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const source=fs.readFileSync('worker/worker.js','utf8').split('export default {')[0];
const sandbox={TextEncoder,TextDecoder,URL,console};vm.createContext(sandbox);
vm.runInContext(source+';globalThis.helpers={normalizeItem,normalizeKodik,rowToItem,upsertProgress};',sandbox);
const h=sandbox.helpers;
function setup(schema=fs.readFileSync('schema.sql','utf8')){
 const db=new DatabaseSync(':memory:');db.exec(schema);
 db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES (?,?,?,?)").run('u','test','unused',1);
 const env={DB:{prepare:sql=>({bind:(...args)=>({run:()=>db.prepare(sql).run(...args)})})}};
 return {db,env};
}
const item=(ts=100)=>h.normalizeItem({id:'al-178789',idx:13,time:1338,duration:1440,source:'kodik',epTotal:24,seen:[0,13],ts,kodik:{mal:123,translation:609,season:2,link:'https://kodikplayer.com/serial/123?token=secret&episode=14'}});
test('Kodik state survives normalization and real SQLite roundtrip',async()=>{
 const {db,env}=setup(); await h.upsertProgress(env,'u',item());
 const saved=h.rowToItem(db.prepare('SELECT * FROM progress').get());
 assert.equal(saved.idx,13);assert.equal(saved.kodik.translation,609);assert.equal(saved.kodik.season,2);assert.equal(saved.kodik.link.includes('token='),false);
 db.close();
});
test('late stale write does not roll back episode or dub',async()=>{
 const {db,env}=setup();await h.upsertProgress(env,'u',item(200));const old=item(100);old.idx=0;old.kodik.translation=1;await h.upsertProgress(env,'u',old);
 const saved=h.rowToItem(db.prepare('SELECT * FROM progress').get());assert.equal(saved.idx,13);assert.equal(saved.kodik.translation,609);db.close();
});
test('newer update unions seen episodes and keeps Kodik metadata from legacy clients',async()=>{
 const {db,env}=setup();await h.upsertProgress(env,'u',item(100));const next=item(200);next.seen=[14];next.kodik=null;next.idx=14;await h.upsertProgress(env,'u',next);
 const saved=h.rowToItem(db.prepare('SELECT * FROM progress').get());assert.deepEqual(Array.from(saved.seen),[0,13,14]);assert.equal(saved.kodik.translation,609);db.close();
});
test('v7 migration preserves existing rows',async()=>{
 const oldSchema=fs.readFileSync('schema.sql','utf8').replace(/^.*kodik_json.*\n/m,'');
 const {db}=setup(oldSchema);db.prepare("INSERT INTO progress(user_id,anime_id,episode_idx,updated_at) VALUES('u','al-1',13,100)").run();
 db.exec(fs.readFileSync('migrate-v7.sql','utf8'));const row=db.prepare('SELECT * FROM progress').get();assert.equal(row.episode_idx,13);assert.equal(row.kodik_json,null);db.close();
});
test('malicious or malformed player metadata is sanitized',()=>{
 assert.equal(h.normalizeKodik({link:'https://kodikplayer.com.evil.test/p',translation:'609junk'}).link,'');assert.equal(h.normalizeKodik({translation:-5}).translation,null);
});
