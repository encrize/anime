/* Shared, dependency-free Kodik protocol helpers. Also loaded by Node tests. */
(function(root){
  'use strict';
  const hosts = ['kodikplayer.com', 'kodik.info', 'kodik.cc', 'aniqit.com', 'kodik-storage.com'];
  function trustedOrigin(origin){
    try { const u = new URL(origin); return u.protocol === 'https:' && !u.port && hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h)); }
    catch(_) { return false; }
  }
  function positive(value){
    if(!/^[0-9]+$/.test(String(value))) return null;
    const n = Number(value); return Number.isSafeInteger(n) && n > 0 && n <= 99999 ? n : null;
  }
  function safeLink(link){
    if(typeof link !== 'string' || !/^(?:https:\/\/|\/\/)/.test(link)) return '';
    try { const u = new URL(link, 'https://kodikplayer.com'); if(!trustedOrigin(u.origin) || u.username || u.password) return ''; u.searchParams.delete('token'); return u.href; }
    catch(_) { return ''; }
  }
  function playerUrl(link, state){
    const u = new URL(link, 'https://kodikplayer.com');
    if(!trustedOrigin(u.origin)) throw new Error('Unsupported Kodik player host');
    u.searchParams.set('episode', String((state.idx || 0) + 1));
    for(const key of ['season', 'translation']){
      if(positive(state[key])) u.searchParams.set(key, String(state[key]));
      else u.searchParams.delete(key);
    }
    if(state.time > 0) u.searchParams.set('start_from', String(Math.floor(state.time)));
    else u.searchParams.delete('start_from');
    return u.href;
  }
  // Playback recency and preference recency are different clocks. A stale
  // resume card must not override a more recent local translation choice.
  function translationPreference(...snapshots){
    return snapshots.filter(x => positive(x?.kodik?.translation))
      .sort((a,b) => (b.kodik.translationTs || b.ts || 0) - (a.kodik.translationTs || a.ts || 0))[0]?.kodik || {};
  }
  function parseEvent(raw){
    let d = raw;
    if(typeof d === 'string') { try { d = JSON.parse(d); } catch(_) { return null; } }
    if(!d || typeof d !== 'object') return null;
    const key = String(d.key || d.event || d.type || '').toLowerCase();
    if(!/^kodik_player_/.test(key)) return null;
    const value = d.value !== undefined ? d.value : d.data;
    const obj = value && typeof value === 'object' ? value : {};
    const out = { key };
    const numeric = x => x !== null && x !== '' && Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : null;
    if(/(?:time_update|position|progress)$/.test(key)) out.time = numeric(obj.time ?? obj.currentTime ?? value);
    if(/duration/.test(key)) out.duration = numeric(obj.duration ?? value);
    if(/episode|video_link|translation|season/.test(key)){
      out.episode = positive(obj.episode ?? (/change_episode/.test(key) ? obj.value ?? value : null));
      out.season = positive(obj.season ?? (/change_season/.test(key) ? obj.value ?? value : null));
      const tr = obj.translation;
      out.translation = positive((tr && typeof tr === 'object' ? tr.id : tr) ?? obj.translation_id ?? (/change_translation/.test(key) ? obj.id ?? value : null));
      // iframe_url is a player permalink; never persist the video/CDN link.
      out.link = safeLink(obj.iframe_url || obj.iframeUrl || obj.link || (typeof value === 'string' ? value : ''));
      if(out.link){
        const u = new URL(out.link);
        out.episode = out.episode || positive(u.searchParams.get('episode'));
        out.season = out.season || positive(u.searchParams.get('season'));
        out.translation = out.translation || positive(u.searchParams.get('translation'));
      }
    }
    return out;
  }
  const api = { trustedOrigin, positive, safeLink, playerUrl, parseEvent, translationPreference };
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.AWPlayer = api;
})(typeof window === 'object' ? window : globalThis);
