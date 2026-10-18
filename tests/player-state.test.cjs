const {test} = require('node:test');
const assert = require('node:assert/strict');
const p = require('../public/player-state.js');
test('late URL creation restores episode 14, dub, season and position', () => {
 const u = new URL(p.playerUrl('https://kodikplayer.com/find-player?token=test&episode=1', {idx:13,translation:609,season:2,time:1338}));
 for(const [key,val] of Object.entries({episode:'14',translation:'609',season:'2',start_from:'1338'})) assert.equal(u.searchParams.get(key),val);
});
test('new episode removes the previous timecode', () => {
 assert.equal(new URL(p.playerUrl('https://kodikplayer.com/serial/1?start_from=123', {idx:14,time:0})).searchParams.has('start_from'),false);
});
test('allowed origins are host-bound, not substring based', () => {
 for(const host of ['https://kodikplayer.com','https://www.kodik.info','https://aniqit.com']) assert.equal(p.trustedOrigin(host),true);
 for(const host of ['https://evil-kodik.info','https://kodikplayer.com.evil.test','http://kodikplayer.com','https://kodikplayer.com:444']) assert.equal(p.trustedOrigin(host),false);
});
test('strip tokens and reject non-player links', () => {
 assert.equal(p.safeLink('https://kodikplayer.com/serial/1?token=secret&episode=14'),'https://kodikplayer.com/serial/1?episode=14');
 for(const link of ['', 'javascript:alert(1)', '/relative', 'https://cdn.example/video.m3u8']) assert.equal(p.safeLink(link),'');
});
test('parse numeric time, duration and episode envelopes', () => {
 assert.equal(p.parseEvent({key:'kodik_player_time_update',value:135}).time,135);
 assert.equal(p.parseEvent(JSON.stringify({key:'kodik_player_duration_update',value:1440})).duration,1440);
 assert.equal(p.parseEvent({key:'kodik_player_change_episode',value:{episode:14}}).episode,14);
 assert.equal(p.parseEvent({key:'kodik_player_change_translation',value:{id:609,title:'Dub'}}).translation,609);
});
test('video-link event restores all fields and rejects CDN URLs', () => {
 const e = p.parseEvent({key:'kodik_player_video_link',value:{episode:14,season:2,translation:{id:609},link:'https://cdn.example/file.m3u8'}});
 assert.equal(e.episode,14); assert.equal(e.season,2); assert.equal(e.translation,609); assert.equal(e.link,'');
 const e2 = p.parseEvent({key:'kodik_player_video_link',value:{iframe_url:'https://aniqit.com/serial/1?episode=14&translation=609'}});
 assert.equal(e2.episode,14); assert.equal(e2.translation,609);
});
test('malformed, unrelated and invalid events never change playback', () => {
 assert.equal(p.parseEvent('{bad'),null); assert.equal(p.parseEvent({key:'episode',value:1}),null);
 assert.equal(p.parseEvent({key:'kodik_player_change_episode',value:'14garbage'}).episode,null);
 assert.equal(p.parseEvent({key:'kodik_player_time_update',value:-5}).time,null);
});
test('real current_episode event contains translation and season metadata', () => {
 const e=p.parseEvent({key:'kodik_player_current_episode',value:{episode:14,season:1,translation:{id:609,title:'AniDUB'}}});
 assert.equal(e.translation,609);assert.equal(e.episode,14);assert.equal(e.season,1);
});
test('old resume card cannot replace a fresh local translation preference', () => {
 const local={ts:200,kodik:{translation:777,translationTs:190}};
 const history={ts:100,kodik:{translation:609,translationTs:90}};
 assert.equal(p.translationPreference(local,history,history).translation,777);
});
test('newer playback snapshot without translation does not erase last known dub', () => {
 assert.equal(p.translationPreference({ts:300,kodik:{translation:null}},{ts:100,kodik:{translation:777,translationTs:80}}).translation,777);
});
