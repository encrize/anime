// Read-only preflight: consumes saved Wrangler --json output, not a database.
const fs=require('node:fs');
if(process.argv.length!==4){console.error('Usage: node scripts/check-schema.cjs users-columns.json progress-columns.json');process.exit(2)}
function columns(path){
 const data=JSON.parse(fs.readFileSync(path,'utf8'));
 const rows=Array.isArray(data)&&data[0]?.results ? data[0].results : (Array.isArray(data)?data:data.results);
 if(!Array.isArray(rows)||!rows.every(row=>typeof row.name==='string'))throw Error('Expected PRAGMA table_info rows in '+path);
 return new Set(rows.map(row=>row.name));
}
try{
 const users=columns(process.argv[2]),progress=columns(process.argv[3]);
 const missingUsers=['id','username','display_name','password_hash','created_at','history_public','profile_public'].filter(c=>!users.has(c));
 const missingProgress=['user_id','anime_id','name','poster','episode_idx','quality','time_sec','duration_sec','ep_label','ep_total','source','seen_json','updated_at'].filter(c=>!progress.has(c));
 if(missingUsers.length||missingProgress.length){
  console.error('STOP: unsupported older/incomplete schema. No SQL has been run.');console.error(JSON.stringify({missingUsers,missingProgress},null,2));process.exit(1);
 }
 console.log(users.has('token_epoch')?'users.token_epoch present: do not rerun migrate-v6.sql.':'Plan: after backup, run migrate-v6.sql once.');
 console.log(progress.has('kodik_json')?'progress.kodik_json present: do not rerun migrate-v7.sql.':'Plan: after backup, run migrate-v7.sql once.');
 console.log('Also verify comments/follows/auth_attempts tables and indexes against schema.sql. This script checks columns only; it does not prove FK/index equivalence.');
 console.log('No SQL executed; no network requests.');
}catch(e){console.error(e.message);process.exit(2)}
