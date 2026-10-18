(function(){
    'use strict';

    /* config */
    const API_BASE  = (localStorage.getItem('aw:api') || '').replace(/\/$/, '');
    const TOKEN_KEY = 'aw:token';
    const HISTORY_BASE = 'aniwired:history';
    const CHECKPOINT_BASE = 'aw:kodik:checkpoints';
    // Never assign the old unscoped keys to whoever signs in next. They are
    // retained, untouched, for a deliberate export/import by their owner.
    let scope = localStorage.getItem(TOKEN_KEY) ? null : 'guest';
    let sessionGeneration = 0, historyRevision = 0;
    const storageKey = base => scope ? base + ':' + scope : null;
    const progressRequests = new Set();
    const suppressedTitles = new Set(), deletingTitles = new Set();
    let clearingHistory = false, deletionFlight = null;
    const DELETE_BASE = 'aw:history:deletions';
    function deletionJournal(){
      if(!scope) return {clear:false, ids:[]};
      try{
        const saved = JSON.parse(localStorage.getItem(storageKey(DELETE_BASE)) || '{}');
        return {clear:saved?.clear === true, ids:Array.isArray(saved?.ids) ? saved.ids.map(String) : []};
      }catch(_){ return {clear:false, ids:[]}; }
    }
    function writeDeletionJournal(state){
      const key = storageKey(DELETE_BASE);
      if(!key) return;
      if(!state.clear && !state.ids.length) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(state));
    }
    function deletionPending(id){
      const state = deletionJournal();
      return state.clear || state.ids.includes(String(id));
    }

    let user  = null;
    let token = localStorage.getItem(TOKEN_KEY) || '';

    /* tiny HTTP helper */
    async function apiCall(path, opts){
      opts = opts || {};
      const headers = { 'Accept':'application/json' };
      if(opts.body !== undefined) headers['Content-Type'] = 'application/json';
      const useAuth = opts.auth !== false;
      const requestToken = token, generation = sessionGeneration;
      if(useAuth && requestToken) headers['Authorization'] = 'Bearer ' + requestToken;
      const res = await fetch(API_BASE + path, {
        method: opts.method || 'GET',
        headers,
        keepalive: !!opts.keepalive,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
      });
      let data = null;
      try{ data = await res.json(); }catch(_){}
      if(generation !== sessionGeneration || (useAuth && requestToken !== token)){
        throw new Error('Session changed; stale response ignored');
      }
      if(res.status === 401 && useAuth && requestToken){ setToken(''); renderAuthUI(); }
      if(!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      return data || {};
    }

    // Track dispatched writes so a DELETE can be ordered after them. Aborting
    // fetch alone cannot guarantee that a server has not already committed it.
    function progressCall(path, opts){
      const request = apiCall(path, opts);
      progressRequests.add(request);
      request.then(() => progressRequests.delete(request), () => progressRequests.delete(request));
      return request;
    }

    /* local history store */
    function readHistory(){
      if(!scope) return {};
      try{ return JSON.parse(localStorage.getItem(storageKey(HISTORY_BASE)) || '{}') || {}; }catch(_){ return {}; }
    }
    function writeHistory(map){
      if(!scope) return;
      localStorage.setItem(storageKey(HISTORY_BASE), JSON.stringify(map));
    }
    function historyList(){
      return Object.values(readHistory()).filter(it => it && !suppressedTitles.has(String(it.id))).sort((a,b) => (b.ts||0) - (a.ts||0));
    }
    function latestItem(map){
      const arr = Object.values(map || {}).filter(Boolean).sort((a,b) => (b.ts||0) - (a.ts||0));
      return arr[0] || null;
    }
    function putLocal(item){
      const map = readHistory();
      const prev = map[String(item.id)];
      if(prev && Array.isArray(prev.seen)){
        const set = {};
        prev.seen.concat(item.seen || []).forEach(i => { set[i] = true; });
        item.seen = Object.keys(set).map(Number).sort((a,b) => a-b);
      }
      map[String(item.id)] = item;
      writeHistory(map);
      return item;
    }
    function removeLocal(id){
      const map = readHistory();
      delete map[String(id)];
      writeHistory(map);
    }
    function storedObject(key){
      try{
        const value = JSON.parse(localStorage.getItem(key) || 'null');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      }catch(_){ return {}; }
    }
    function importableHistory(legacy){
      const source = storedObject(legacy ? HISTORY_BASE : HISTORY_BASE + ':guest');
      if(legacy){
        const last = storedObject(STORE);
        if(last.id != null && !Object.prototype.hasOwnProperty.call(source, String(last.id))) source[String(last.id)] = last;
      }
      const number = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
      return Object.values(source).filter(it => it && typeof it === 'object' &&
        (typeof it.id === 'string' || typeof it.id === 'number') &&
        String(it.id).trim().length > 0 && String(it.id).length <= 64 &&
        !['__proto__','constructor','prototype'].includes(String(it.id))).map(it => ({
          id:String(it.id), name:String(it.name || 'Untitled').slice(0,300),
          poster:safePoster(String(it.poster || '')).slice(0,600), idx:number(it.idx),
          time:number(it.time), duration:number(it.duration), quality:String(it.quality || '').slice(0,32),
          epLabel:String(it.epLabel ?? (number(it.idx) + 1)).slice(0,32), epTotal:number(it.epTotal),
          source:it.source === 'kodik' || isKodikId(it.id) ? 'kodik' : 'libria',
          seen:[...new Set((Array.isArray(it.seen) ? it.seen : []).map(number))].sort((a,b)=>a-b).slice(0,2000),
          ts:Math.min(number(it.ts), Date.now()),
          kodik:it.kodik && typeof it.kodik === 'object' ? {
            mal:AWPlayer.positive(it.kodik.mal), season:AWPlayer.positive(it.kodik.season),
            translation:AWPlayer.positive(it.kodik.translation), link:AWPlayer.safeLink(it.kodik.link || '')
          } : undefined
        }));
    }
    function renderLocalImport(){
      const box = $('#pfLocalImport');
      if(!box) return;
      const legacy = importableHistory(true).length > 0;
      const guest = !!user && importableHistory(false).length > 0;
      const backup = [HISTORY_BASE, STORE, CHECKPOINT_BASE].some(key => localStorage.getItem(key) !== null);
      box.classList.toggle('hidden', !legacy && !guest && !backup);
      $('#importLegacy').classList.toggle('hidden', !legacy);
      $('#importGuest').classList.toggle('hidden', !guest);
      $('#exportLegacy').classList.toggle('hidden', !backup);
      $('#importLegacy').disabled = $('#importGuest').disabled = !scope || (!!user && !settings) || clearingHistory || deletionJournal().clear;
    }
    async function importDeviceHistory(legacy){
      if(!scope || clearingHistory || deletionJournal().clear || (user && !settings)) return;
      const items = importableHistory(legacy);
      if(!items.length) return;
      const target = user ? '@' + user.username : 'guest history on this device';
      if(!confirm('Import ' + items.length + ' records into ' + target + '? Only continue if these records belong to you.' +
        (user ? ' They will be synced using this account’s current privacy settings.' : ''))) return;
      historyRevision++;
      const map = readHistory();
      for(const original of items){
        const id = String(original.id);
        if(deletingTitles.has(id) || deletionPending(id)) continue;
        const old = map[id];
        const seen = [...new Set([...(Array.isArray(old?.seen) ? old.seen : []), ...(Array.isArray(original.seen) ? original.seen : [])])];
        map[id] = { ...((old?.ts || 0) > (original.ts || 0) ? old : original), id, seen };
        suppressedTitles.delete(id);
      }
      writeHistory(map); renderResume(); renderProfile(); refreshStats();
      // Keep the originals as a recoverable backup. Never delete or silently
      // claim ownership of unscoped data during an account transition.
      toast(user ? 'Imported locally; account sync will retry when available' : 'Imported into guest history on this device');
      if(user) await syncProgress(true);
    }
    $('#importGuest').onclick = () => importDeviceHistory(false);
    $('#importLegacy').onclick = () => importDeviceHistory(true);
    $('#exportLegacy').onclick = () => {
      const data = { history:storedObject(HISTORY_BASE), last:storedObject(STORE), checkpoints:storedObject(CHECKPOINT_BASE) };
      const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
      const a = document.createElement('a'); a.href = href; a.download = 'aniwired-pre-update-backup.json';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(href), 30000);
    };

    /* formatting helpers */
    function fmtLong(sec){
      sec = Math.max(0, Math.floor(sec || 0));
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return h ? (h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0'))
               : (m + ':' + String(s).padStart(2,'0'));
    }
    function fmtWatchTime(sec){
      sec = Math.max(0, Math.floor(sec || 0));
      const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
      return h ? (h + 'h' + (m ? ' ' + m + 'm' : '')) : (m + 'm');
    }
    function fmtAgo(ts){
      const diff = Date.now() - (ts || 0);
      if(diff < 0 || !ts) return 'just now';
      const min = Math.floor(diff / 60000);
      if(min < 1) return 'just now';
      if(min < 60) return min + ' min ago';
      const h = Math.floor(min / 60);
      if(h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
      const d = Math.floor(h / 24);
      if(d < 30) return d + (d === 1 ? ' day ago' : ' days ago');
      return new Date(ts).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
    }
    const pctOf = it => (it && it.duration > 30) ? Math.min(100, Math.round((it.time / it.duration) * 100)) : 0;
    const isFinished = it => pctOf(it) >= 90;

    /* progress sync */
    /* D1's free tier allows 100k written rows per day, and that - not the
       Workers request limit - is the real ceiling. At the old 2.5 s debounce a
       single viewer generated ~2880 writes per day, so ~15-20 concurrent
       viewers exhausted the daily quota. 25 s plus the unchanged-snapshot check
       below cuts that by roughly 90% and leaves headroom for ~200 viewers.
       Accuracy does not suffer: pause / seek / ended / beforeunload / pagehide
       all still flush immediately via pushProgress(item, true). */
    const SYNC_DEBOUNCE_MS = 25000;
    let pushTimer = 0, pendingItem = null, failedQueue = [];
    const pendingWrites = new Map(), pushedSigs = new Map(), inFlight = new Map();

    // Identity of a snapshot for deduplication purposes.
    const progressSig = it => JSON.stringify([
      it.id, it.idx, it.time, it.duration, it.quality, it.source,
      it.kodik?.season, it.kodik?.translation, it.kodik?.link, it.kodik?.mal, it.epTotal, it.seen || [],
    ]);

    function pushProgress(item, immediate){
      if(!token || !user || !scope || !item || clearingHistory || suppressedTitles.has(String(item.id)) || deletionPending(item.id)) return;
      pendingItem = item;
      const id = String(item.id), previous = pendingWrites.get(id);
      if(!previous || item.ts >= previous.ts) pendingWrites.set(id, item);
      const flush = () => {
        pushTimer = 0;
        const authToken = token, generation = sessionGeneration;
        for(const [id, snapshot] of pendingWrites){
          if(clearingHistory || suppressedTitles.has(id) || deletionPending(id)){ pendingWrites.delete(id); continue; }
          if(inFlight.has(id)) continue;
          const sig = progressSig(snapshot);
          if(pushedSigs.get(id) === sig){ pendingWrites.delete(id); continue; }
          pendingWrites.delete(id); inFlight.set(id, sig);
          progressCall('/api/progress', { method:'PUT', body:{ item:snapshot }, keepalive:!!immediate })
            .then(() => { if(generation === sessionGeneration && token === authToken && !suppressedTitles.has(id)) pushedSigs.set(id, sig); })
            .catch(() => {
              if(generation !== sessionGeneration || token !== authToken || clearingHistory || suppressedTitles.has(id)) return;
              const newer = pendingWrites.get(id);
              if(!newer || newer.ts < snapshot.ts) pendingWrites.set(id, snapshot);
            })
            .finally(() => {
              if(generation !== sessionGeneration) return;
              inFlight.delete(id);
              if(token && pendingWrites.size && !pushTimer) pushTimer = setTimeout(flush, SYNC_DEBOUNCE_MS);
            });
        }
      };
      if(immediate){ clearTimeout(pushTimer); pushTimer = 0; flush(); return; }
      if(!pushTimer) pushTimer = setTimeout(flush, SYNC_DEBOUNCE_MS);
    }

    async function syncProgress(silent){
      if(!token || !user || !scope || clearingHistory) return;
      const started = sessionGeneration;
      try{ await drainDeletions(); }
      catch(_){ if(!silent) toast('History removal is pending; reconnect to retry'); return; }
      if(started !== sessionGeneration) return;
      const generation = sessionGeneration, revision = historyRevision;
      let serverItems = [];
      try{ serverItems = (await apiCall('/api/progress')).items || []; }
      catch(_){ if(generation === sessionGeneration && !silent) toast('Could not reach the sync server'); return; }
      if(generation !== sessionGeneration || revision !== historyRevision || clearingHistory) return;

      const map = readHistory();
      const toPush = [];
      const seenIds = {};
      for(const s of serverItems){
        if(suppressedTitles.has(String(s.id))) continue;
        s.id = String(s.id); seenIds[s.id] = true;
        const l = map[s.id];
        if(l){ s.seen = [...new Set([...(l.seen || []), ...(s.seen || [])])].sort((a,b) => a-b); l.seen = s.seen;
          if(!s.kodik && l.kodik) s.kodik = l.kodik; }
        if(!l || (l.ts||0) <= (s.ts||0)) map[s.id] = s;
        else toPush.push(l);
      }
      for(const id in map) if(!seenIds[id] && !suppressedTitles.has(id)) toPush.push(map[id]);

      writeHistory(map);
      renderResume();
      renderProfile();
      if(toPush.length || failedQueue.length){
        const items = toPush.concat(failedQueue).filter(item => !suppressedTitles.has(String(item.id)));
        failedQueue = [];
        try{
          // The API accepts at most 200 items per request. Never silently drop
          // the tail of a large local history.
          for(let i = 0; i < items.length; i += 200){
            if(generation !== sessionGeneration || revision !== historyRevision || clearingHistory) return;
            const batch = items.slice(i, i + 200).filter(item => !suppressedTitles.has(String(item.id)));
            if(batch.length) await progressCall('/api/progress/bulk', { method:'POST', body:{ items:batch } });
          }
        }catch(_){
          if(generation === sessionGeneration && revision === historyRevision) failedQueue = items.filter(item => !suppressedTitles.has(String(item.id)));
        }
      }
    }

    let lastPicked = null;                         // episode index chosen in the UI

    function playerIdx(){
      if(current.ep != null) return current.ep;
      if(lastPicked != null) return lastPicked;
      return 0;
    }
    function playerLive(){
      if(!current.title) return false;
      if(current.mode === 'kodik') return !!current.kodikLink && !el.embedWrap.classList.contains('hidden') && kodikState.key === String(current.title.id);
      return current.ep != null;
    }

    /* A title must be actually watched before it lands in the history.
       Simply opening a page (or letting the player load) is not enough:
       WATCH_MIN seconds have to go by. This works for both players --
       the built-in <video> element and the Kodik iframe, whose position is
       reported over postMessage into kodikState. */
    const WATCH_MIN = 30;
    const watch = { key:'', base:null, last:null, acc:0 };
    function watchPos(){
      if(current.mode === 'kodik') return kodikState.time || 0;
      const v = el.video;
      return (v && isFinite(v.currentTime)) ? v.currentTime : 0;
    }
    function watchedSeconds(){
      const key = current.title
        ? String(current.title.id) + ':' + playerIdx() + ':' + (current.mode || '')
        : '';
      const pos = watchPos();
      if(key !== watch.key){                       // new title/episode/player
        watch.key = key; watch.base = pos; watch.last = pos; watch.acc = 0;
        return 0;
      }
      const d = pos - (watch.last == null ? pos : watch.last);
      watch.last = pos;
      if(d > 0 && d <= 5) watch.acc += d;          // real playback, ignore seeks
      const fromStart = pos - (watch.base == null ? pos : watch.base);
      return Math.max(watch.acc, fromStart);       // fromStart covers sparse updates
    }

    saveProgress = function(){
      if(!scope || clearingHistory || (current.title && (suppressedTitles.has(String(current.title.id)) || deletionPending(current.title.id))) || !playerLive() || (current.mode !== 'kodik' && (current.libriaRestoring || el.playerWrap.classList.contains('hidden')))) return;
      const t     = current.title;
      const idx   = playerIdx();
      const ep    = (current.episodes || [])[idx];
      const kodik = current.mode === 'kodik';
      const v     = el.video;
      const prev  = readHistory()[String(t.id)];
      const same  = !!(prev && prev.idx === idx && prev.source === current.mode && (!kodik || (prev.kodik?.season || null) === kodikState.season));
      if(kodik && !kodikState.confirmed) return;

      // Only gate brand-new entries: a title already in the history keeps
      // updating normally, so resuming never loses your position.
      if(!prev && watchedSeconds() < WATCH_MIN) return;

      let time = (!kodik && v && isFinite(v.currentTime)) ? Math.floor(v.currentTime) : 0;
      let dur  = (!kodik && v && isFinite(v.duration))    ? Math.floor(v.duration)    : 0;
      if(kodik){
        time = kodikState.time;
        dur  = kodikState.duration || (same ? (prev.duration || 0) : 0);
      }
      if(!kodik && same && el.video.readyState === 0) return;
      if(!dur && same) dur = prev.duration || 0;

      const item = {
        id: String(t.id),
        name: titleName(t),
        poster: posterUrl(t),
        idx: idx,
        quality: current.quality || '',
        time: time,
        duration: dur,
        epLabel: String((ep && ep.ordinal != null) ? ep.ordinal : (idx + 1)),
        epTotal: Math.max(
          (typeof totalEpisodesOf === 'function' ? totalEpisodesOf(t) : 0) || 0,
          (current.episodes || []).length,
          t._eps || 0,
          same ? (prev.epTotal || 0) : 0),
        source: current.mode || 'libria',
        kodik: kodik
          ? { mal:(current.malId ?? t._mal ?? null), link:AWPlayer.safeLink(current.kodikLink || ''), season:kodikState.season, translation:kodikState.translation }
          : (same ? prev.kodik : undefined),
        seen: [idx],
        ts: Date.now()
      };
      // Compare the same merged snapshot that will actually be stored.
      item.seen = [...new Set([...(prev?.seen || []), ...item.seen])].sort((a,b) => a-b);
      if(prev && progressSig(prev) === progressSig(item)) return;
      putLocal(item);
      renderResume();
      markSeenEpisodes();
      if(pf.section && !pf.section.classList.contains('hidden')) renderProfile(); else refreshStats();
      pushProgress(readHistory()[item.id]);
    };

    (function watchPlayer(){
      const v = el.video;
      let last = 0;
      const tick = () => { const now = Date.now(); if(now - last > 3000){ last = now; saveProgress(); } };
      if(v){
        v.addEventListener('timeupdate', tick);
        v.addEventListener('loadedmetadata', () => { if(current.mode === 'libria') saveProgress(); });
        v.addEventListener('play',   () => { if(current.mode === 'libria') saveProgress(); });
        v.addEventListener('pause',  () => { if(current.mode === 'libria'){ saveProgress(); pushProgress(pendingItem, true); } });
        v.addEventListener('seeked', () => { saveProgress(); pushProgress(pendingItem, true); });
        v.addEventListener('ended',  () => { saveProgress(); pushProgress(pendingItem, true); });
      }
      setInterval(() => {
        if(document.visibilityState === 'visible' && playerLive()) saveProgress();
      }, 15000);
      window.addEventListener('beforeunload', () => {
        saveProgress();
        pushProgress(pendingItem || latestItem(readHistory()), true);
      });
    })();

    renderResume = function(){
      const list = historyList().slice(0, 12);
      if(!list.length){ el.resumeSlot.innerHTML = ''; return; }
      const cards = list.map(d => {
        const pct = pctOf(d);
        return '<div class="cw-item" data-id="' + escapeHtml(String(d.id)) + '">' +
          '<button class="cw-x" data-del="' + escapeHtml(String(d.id)) + '" title="Remove from history">\u2715</button>' +
          '<img src="' + escapeHtml(safePoster(d.poster)) + '" alt="" width="220" height="320" decoding="async" loading="lazy"/>' +
          '<div class="cw-info"><h4>' + escapeHtml(d.name) + '</h4>' +
          '<p>Episode ' + escapeHtml(String(d.epLabel)) + ' \u2022 ' + fmtLong(d.time) +
            (d.duration ? ' / ' + fmtLong(d.duration) : '') + '</p>' +
          '<div class="cw-bar"><i style="width:' + (pct || 2) + '%"></i></div>' +
          '</div></div>';
      }).join('');

      el.resumeSlot.innerHTML =
        '<div class="cw-head"><h2 class="section-title">Continue watching</h2>' +
        '<span class="sync-badge' + (token ? '' : ' off') + '">' + (token ? 'synced' : 'this device') + '</span>' +
        '<button class="cw-all" id="cwAll" type="button"><span>View all</span>' +
        '<svg class="cw-all-i" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
        'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M9.5 5.5 16 12l-6.5 6.5"/></svg></button></div>' +
        '<div class="cw-rail">' + cards + '</div>';

      const all = $('#cwAll', el.resumeSlot);
      if(all) all.onclick = () => goProfile();
      $$('.cw-item', el.resumeSlot).forEach(node => {
        node.onclick = e => {
          if(e.target.classList.contains('cw-x')) return;
          const d = readHistory()[node.dataset.id];
          if(d) resumeItem(d);
        };
      });
      $$('.cw-x', el.resumeSlot).forEach(btn => {
        btn.onclick = e => { e.stopPropagation(); deleteItem(btn.dataset.del); };
      });
    };

    const kodikState = { key:'', idx:0, time:0, duration:0, season:null, translation:null, confirmed:false };
    function checkpoints(){
      if(!scope) return {};
      try { return JSON.parse(localStorage.getItem(storageKey(CHECKPOINT_BASE)) || '{}') || {}; } catch(_) { return {}; }
    }
    function checkpoint(){
      if(!scope || !current.title || current.mode !== 'kodik' || clearingHistory || suppressedTitles.has(String(current.title.id)) || deletionPending(current.title.id)) return;
      const map = checkpoints();
      map[kodikState.key] = { idx:current.ep || 0, time:kodikState.time, duration:kodikState.duration,
        kodik:{ mal:current.malId, season:kodikState.season, translation:kodikState.translation,
          link:current.kodikLink ? AWPlayer.safeLink(withKodikEpisode(current.kodikLink)) : '' }, ts:Date.now() };
      // Keep a bounded local selection cache even before the 30-second history threshold.
      const entries = Object.entries(map).sort((a,b) => b[1].ts - a[1].ts).slice(0,200);
      try { localStorage.setItem(storageKey(CHECKPOINT_BASE), JSON.stringify(Object.fromEntries(entries))); } catch(_) {}
    }
    function paintKodikSelection(){
      $$('.ep', el.episodes).forEach(b => b.classList.toggle('active', +b.dataset.idx === current.ep));
      const input = $('#kodikEp', el.episodes);
      if(input) input.value = String((current.ep || 0) + 1);
    }
    function prepareKodik(t, resume){
      const id = String(t.id), local = checkpoints()[id], hist = readHistory()[id];
      const state = AWPlayer.restoreState(hist, local, resume);
      const prefs = state.kodik;
      Object.assign(kodikState, { key:id, idx:Math.max(0, Math.floor(state.idx || 0)),
        time:Math.max(0, Math.floor(state.time || 0)), duration:state.duration || 0,
        season:AWPlayer.positive(prefs.season), translation:AWPlayer.positive(prefs.translation), confirmed:false });
      current.ep = kodikState.idx; lastPicked = current.ep; current.kodikState = kodikState;
      // Reuse only validated player permalinks; find-player tokens are reacquired.
      const link = prefs.link && AWPlayer.safeLink(prefs.link);
      current.kodikLink = link && !new URL(link).pathname.includes('find-player') ? link : undefined;
      if(prefs.mal != null) current.malId = prefs.mal;
      renderKodikEpisodes(t);
    }
    window.__awPrepareKodik = prepareKodik;
    window.__awEnsureKodik = t => {
      if(t && (kodikState.key !== String(t.id) || current.kodikState !== kodikState)) prepareKodik(t);
      else if(t){ current.ep = kodikState.idx; paintKodikSelection(); }
    };
    window.__awSetKodikEpisode = (i, time) => setKodikEpisode(i, time);
    let kodikSaveAt = 0;

    function isKodikId(id){ return /^al-/.test(String(id)); }

    function kodikTitleFrom(d){
      return {
        _kodik:true,
        _mal:(d.kodik?.mal ?? null),
        _eps:(d.epTotal || 0),
        id:String(d.id),
        name:{ main:(d.name || 'Untitled') },
        poster:{ src:(d.poster || '') },
        description:'',
        genres:[]
      };
    }

    async function fetchAniListById(id){
      const m = String(id).match(/^al-(\d+)$/);
      if(!m) return null;
      try{
        const r = await fetch('https://graphql.anilist.co', {
          method:'POST',
          headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
          body: JSON.stringify({
            query:'query($id:Int){Media(id:$id,type:ANIME){id idMal title{romaji english native} description(asHtml:false) episodes nextAiringEpisode{episode} format seasonYear coverImage{extraLarge large} genres}}',
            variables:{ id:+m[1] }
          })
        });
        const j = await r.json();
        const a = j.data && j.data.Media;
        if(!a) return null;
        return {
          _kodik:true,
          _mal:(a.idMal ?? null),
          _eps:alEpisodeCount(a),
          id:'al-' + a.id,
          name:{ main:(a.title.romaji || a.title.english || a.title.native), english:a.title.english, romaji:a.title.romaji },
          poster:{ src:(a.coverImage && (a.coverImage.extraLarge || a.coverImage.large)) || '' },
          type:{ description:(a.format || '').replace(/_/g,' ') },
          year:(a.seasonYear || null),
          description:(a.description || '').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,''),
          genres:(a.genres || [])
        };
      }catch(_){ return null; }
    }

    function setKodikEpisode(i, startFrom){
      if(!Number.isInteger(i) || i < 0 || i >= 9999 || current.mode !== 'kodik') return;
      saveProgress();
      current.ep = i; lastPicked = i;
      Object.assign(kodikState, { idx:i, time:Math.max(0, Math.floor(startFrom || 0)), duration:0, confirmed:false });
      if(current.kodikLink){
        current.kodikLink = withKodikEpisode(current.kodikLink);
        if(el.embedFrame.getAttribute('src') !== current.kodikLink) el.embedFrame.src = current.kodikLink;
      }
      paintKodikSelection(); checkpoint(); markSeenEpisodes();
    }

    // Draws the episode grid only - it never touches the player, so it is safe
    // to call again once the real episode count arrives.
    function paintKodikEpisodes(total, startIdx){
      let html = '<p class="hint">Episodes, dubs and subtitles sync with the Kodik player automatically.</p>';
      if(total > 0){
        html += '<div class="kodik-eps">';
        for(let i = 0; i < total; i++) html += '<button class="ep" data-idx="' + i + '" type="button">Episode ' + (i + 1) + '</button>';
        html += '</div>';
      }
      html += '<div class="kodik-manual"><span class="hint">Episode number</span>' +
        '<input id="kodikEp" type="number" min="1" max="9999" step="1" value="' + (startIdx + 1) + '">' +
        '<button id="kodikEpSet" type="button">I\'m watching this one</button></div>';
      el.episodes.innerHTML = html;
      $$('.ep', el.episodes).forEach(b => {
        b.onclick = () => setKodikEpisode(+b.dataset.idx, 0);
        b.classList.toggle('active', +b.dataset.idx === startIdx);
      });
      const setBtn = $('#kodikEpSet', el.episodes), inp = $('#kodikEp', el.episodes);
      if(setBtn && inp) setBtn.onclick = () => { const n = parseInt(inp.value, 10); if(n > 0) setKodikEpisode(n - 1, 0); };
      markSeenEpisodes();
    }

    function renderKodikEpisodes(t, resume){
      if(current.mode !== 'kodik') return;
      t = t || current.title;
      const id = String((t && t.id) || '');
      const hist = readHistory()[id] || {};
      const total = (t && t._eps) || hist.epTotal || 0;
      const startIdx = current.ep != null ? current.ep : 0;
      paintKodikEpisodes(total, startIdx);
      paintKodikSelection();

      // Kodik never says how many episodes it has and AniLibria only lists the
      // ones it dubbed, so ask AniList and repaint if the real number is bigger.
      if(typeof window.__awEpsTotal === 'function' && t){
        window.__awEpsTotal(t).then(n => {
          if(current.mode !== 'kodik' || current.title !== t) return;
          if(n > total) paintKodikEpisodes(n, current.ep != null ? current.ep : startIdx);
        }).catch(()=>{});
      }
    }

    // Switching to the Kodik tab on an AniLibria release used to leave that
    // release's short dubbed list on screen (One Piece showed 4 episodes and
    // the buttons did nothing, because selectEpisode just reloads the iframe
    // while in Kodik mode). Repaint the list for whichever source is active.
    //
    // Do NOT wrap setMode here: this IIFE declares its own local setMode for
    // the sign-in tabs, which shadows the player's global one. Listening on
    // the tab strip avoids the whole problem.
    if(el.sourceTabs){
      el.sourceTabs.addEventListener('click', e => {
        const btn = (e.target && e.target.closest) ? e.target.closest('.src-tab') : null;
        if(!btn) return;
        const src = btn.dataset.src;
        setTimeout(() => {
          if(src === 'kodik' && current.mode === 'kodik'){ renderKodikEpisodes(current.title); return; }
          if(typeof window.renderEpisodes === 'function' && (current.episodes || []).length){
            window.renderEpisodes();
            $$('.ep', el.episodes).forEach(b => b.classList.toggle('active', +b.dataset.idx === current.ep));
            markSeenEpisodes();
          }
        }, 0);
      });
    }

    // Only the active iframe may mutate playback state. Unknown events are inert.
    window.addEventListener('message', e => {
      if(current.mode !== 'kodik' || !current.title || !current.kodikLink ||
         e.source !== el.embedFrame.contentWindow || !AWPlayer.trustedOrigin(e.origin)) return;
      const event = AWPlayer.parseEvent(e.data);
      if(!event) return;
      if(/(?:pause|ended|seeked)$/.test(event.key)){ saveProgress(); pushProgress(pendingItem, true); return; }
      const changedEpisode = event.episode != null && event.episode - 1 !== current.ep;
      const changedSeason = event.season != null && event.season !== kodikState.season;
      if(changedEpisode || changedSeason){
        if(kodikState.confirmed) saveProgress();
        current.ep = event.episode != null ? event.episode - 1 : 0;
        Object.assign(kodikState, { idx:current.ep, time:0, duration:0 });
      }
      if(event.season != null) kodikState.season = event.season;
      if(event.translation != null) kodikState.translation = event.translation;
      if(event.link) current.kodikLink = event.link;
      if(event.time != null) kodikState.time = Math.floor(event.time);
      if(event.duration != null) kodikState.duration = Math.floor(event.duration);
      const meaningful = event.episode != null || event.season != null || event.translation != null ||
        event.time != null || event.duration != null || event.link;
      if(!meaningful) return;
      // Update the stored URL without reloading a playing iframe.
      current.kodikLink = withKodikEpisode(current.kodikLink);
      kodikState.confirmed = true;
      paintKodikSelection(); checkpoint();
      const now = Date.now();
      if(changedEpisode || changedSeason || event.translation != null || now - kodikSaveAt > 3000){
        kodikSaveAt = now; saveProgress();
        if(changedEpisode || changedSeason || event.translation != null) pushProgress(pendingItem, true);
      }
    });

    async function resumeItem(d){
      const generation = sessionGeneration;
      const viaKodik = d.source === 'kodik' || isKodikId(d.id);
      if(!viaKodik) return openTitle(d.id, { idx:d.idx, quality:d.quality, time:d.time });
      let t = readKodikCache(String(d.id));
      if(!t && !(d.kodik && d.kodik.mal != null)) t = await fetchAniListById(d.id);
      if(generation !== sessionGeneration) return;
      if(!t) t = kodikTitleFrom(d);
      if(!t._eps && d.epTotal) t._eps = d.epTotal;
      return openKodikTitle(t, { idx:(d.idx || 0), time:(d.time || 0), duration:d.duration || 0, kodik:d.kodik, ts:d.ts || 0 });
    }
    function cancelQueuedProgress(id){
      pendingWrites.delete(id); pushedSigs.delete(id);
      if(pendingItem && String(pendingItem.id) === id) pendingItem = null;
      failedQueue = failedQueue.filter(item => String(item.id) !== id);
    }
    function drainDeletions(){
      if(deletionFlight) return deletionFlight;
      const generation = sessionGeneration;
      const run = async () => {
        // Wait for already-dispatched writes; AbortController alone cannot
        // undo a server commit. The durable journal survives closing this tab.
        await Promise.allSettled([...progressRequests]);
        while(generation === sessionGeneration && scope){
          const state = deletionJournal();
          if(!state.clear && !state.ids.length) return;
          const id = state.clear ? null : state.ids[0];
          if(token){
            await apiCall('/api/progress' + (id === null ? '' : '/' + encodeURIComponent(id)), {method:'DELETE'});
          }
          if(generation !== sessionGeneration) return;
          if(id === null){
            Object.keys(readHistory()).forEach(key => suppressedTitles.add(key));
            writeHistory({}); localStorage.removeItem(storageKey(CHECKPOINT_BASE));
            writeDeletionJournal({clear:false, ids:[]});
          }else{
            removeLocal(id);
            const saved = checkpoints(); delete saved[id];
            localStorage.setItem(storageKey(CHECKPOINT_BASE), JSON.stringify(saved));
            const next = deletionJournal(); next.ids = next.ids.filter(key => key !== id);
            writeDeletionJournal(next);
          }
        }
      };
      deletionFlight = run().finally(() => { if(generation === sessionGeneration) deletionFlight = null; });
      return deletionFlight;
    }
    const UNDO_BASE = 'aw:history:undo';
    const undoTimers = new Map();
    function undoRecords(){ return scope ? storedObject(storageKey(UNDO_BASE)) : {}; }
    function writeUndoRecords(map){ if(scope) localStorage.setItem(storageKey(UNDO_BASE), JSON.stringify(map)); }
    function clearUndoTimers(){ undoTimers.forEach(clearTimeout); undoTimers.clear(); $('#historyUndo')?.remove(); }
    function paintUndo(){
      $('#historyUndo')?.remove();
      const ids = Object.keys(undoRecords());
      if(!ids.length) return;
      const box = document.createElement('div'); box.id = 'historyUndo'; box.className = 'history-undo'; box.setAttribute('role', 'status');
      const text = document.createElement('span'); text.textContent = ids.length > 1 ? 'Removed (' + ids.length + ')' : 'Removed from history';
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Undo';
      btn.onclick = () => {
        const records = undoRecords();
        for(const id of Object.keys(records)){
          if(records[id].until <= Date.now()) continue;
          clearTimeout(undoTimers.get(id)); undoTimers.delete(id); delete records[id];
          deletingTitles.delete(id); suppressedTitles.delete(id);
        }
        writeUndoRecords(records); historyRevision++;
        paintUndo(); renderResume(); renderProfile(); refreshStats();
      };
      box.append(text, btn); document.body.append(box);
    }
    function restoreUndo(){
      for(const id of undoTimers.keys()){ if(!deletionPending(id)){ suppressedTitles.delete(id); deletingTitles.delete(id); } }
      clearUndoTimers();
      for(const [id,record] of Object.entries(undoRecords())){
        suppressedTitles.add(id); deletingTitles.add(id);
        const generation = sessionGeneration;
        undoTimers.set(id, setTimeout(() => {
          if(generation !== sessionGeneration) return;
          const records = undoRecords(); delete records[id]; writeUndoRecords(records);
          undoTimers.delete(id); deletingTitles.delete(id); paintUndo(); commitDeleteItem(id);
        }, Math.max(0, record.until - Date.now())));
      }
      paintUndo();
    }
    function deleteItem(id){
      id = String(id);
      if(!scope || clearingHistory || deletingTitles.has(id)) return;
      const records = undoRecords(); records[id] = {until:Date.now() + 6000}; writeUndoRecords(records);
      suppressedTitles.add(id); deletingTitles.add(id); historyRevision++; cancelQueuedProgress(id);
      restoreUndo(); renderResume(); renderProfile(); refreshStats();
    }
    async function commitDeleteItem(id){
      id = String(id);
      if(!scope || clearingHistory || deletingTitles.has(id)) return;
      const generation = sessionGeneration;
      const journal = deletionJournal(); journal.ids = [...new Set([...journal.ids, id])];
      writeDeletionJournal(journal);
      suppressedTitles.add(id); deletingTitles.add(id); historyRevision++;
      cancelQueuedProgress(id);
      try{
        await drainDeletions();
        if(generation !== sessionGeneration) return;
        renderResume(); renderProfile(); refreshStats();
        // The grace-period notice already reported the removal.
      }catch(_){
        if(generation === sessionGeneration) toast('Removal pending. Reconnect or try again; progress will not be re-uploaded.');
      }finally{
        if(generation === sessionGeneration) deletingTitles.delete(id);
      }
    }

    window.addEventListener('pagehide', () => { saveProgress(); pushProgress(pendingItem || latestItem(readHistory()), true); });
    document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden'){ saveProgress(); pushProgress(pendingItem, true); } });
    window.addEventListener('online', () => { if(token) syncProgress(true); });
    window.addEventListener('storage', e => {
      if(e.key === storageKey(UNDO_BASE)){ restoreUndo(); renderResume(); renderProfile(); }
      if(e.key === storageKey(HISTORY_BASE)){ renderResume(); renderProfile(); refreshStats(); }
      if(e.key === TOKEN_KEY){
        setToken(localStorage.getItem(TOKEN_KEY) || '');
        setIdentity(null); renderAuthUI(); bootSession();
      }
    });

    function markSeenEpisodes(){
      if(!current.title) return;
      const d = readHistory()[String(current.title.id)];
      if(!d) return;
      const seen = Array.isArray(d.seen) ? d.seen : (d.idx != null ? [d.idx] : []);
      $$('.ep', el.episodes).forEach(b => {
        const i = +b.dataset.idx;
        b.classList.toggle('seen', seen.indexOf(i) !== -1);
        if(i === d.idx) b.title = 'Stopped at ' + fmtLong(d.time);
      });
    }
    const _renderEpisodes = renderEpisodes;
    renderEpisodes = function(resume){
      const out = _renderEpisodes(resume);
      markSeenEpisodes();
      return out;
    };

    const pf = {
      section:$('#profile'), back:$('#pfBack'), avatar:$('#pfAvatar'), name:$('#pfName'), note:$('#pfNote'),
      titles:$('#pfTitles'), episodes:$('#pfEpisodes'), time:$('#pfTime'), finished:$('#pfFinished'),
      filter:$('#pfFilter'), sort:$('#pfSort'), clear:$('#pfClear'), grid:$('#pfGrid'), empty:$('#pfEmpty')
    };

    /* =================================================================
     * 1) Genre / tag navigation
     * ================================================================= */

    // nextAiringEpisode is what saves long-running shows: AniList reports
    // episodes:null while a series is still airing (One Piece, for example),
    // so without it the episode list collapsed to a handful of entries.
    const AL_FIELDS = 'id idMal title{romaji english native} description(asHtml:false) episodes ' +
      'nextAiringEpisode{episode} format seasonYear coverImage{extraLarge large} genres';

    // AniList genre vocabulary - also used for the quick bar on the home page.
    const GENRE_LIST = ['Action','Adventure','Comedy','Drama','Ecchi','Fantasy','Horror','Mahou Shoujo',
      'Mecha','Music','Mystery','Psychological','Romance','Sci-Fi','Slice of Life','Sports','Supernatural','Thriller'];

    // AniLibria returns Russian genre names, AniList expects English ones.
    const RU_TO_EN_GENRES = {
      'экшен':'Action', 'экшн':'Action', 'боевик':'Action', 'приключения':'Adventure',
      'комедия':'Comedy', 'драма':'Drama', 'этти':'Ecchi', 'фэнтези':'Fantasy', 'фантези':'Fantasy',
      'ужасы':'Horror', 'магические девочки':'Mahou Shoujo', 'меха':'Mecha', 'музыка':'Music',
      'детектив':'Mystery', 'мистика':'Mystery', 'психологическое':'Psychological', 'психология':'Psychological',
      'романтика':'Romance', 'романтика и школа':'Romance', 'научная фантастика':'Sci-Fi', 'фантастика':'Sci-Fi',
      'повседневность':'Slice of Life', 'спорт':'Sports', 'сверхъестественное':'Supernatural',
      'триллер':'Thriller', 'школа':'School', 'историческое':'Historical'
    };

    let activeGenre = '';

    function toAniListGenre(g){
      const raw = String(g || '').trim();
      const low = raw.toLowerCase();
      if(RU_TO_EN_GENRES[low]) return RU_TO_EN_GENRES[low];
      const hit = GENRE_LIST.find(x => x.toLowerCase() === low);
      return hit || raw;
    }

    // Airing shows have no final episode count yet, so fall back to the number
    // of episodes that have already aired.
    function alEpisodeCount(m){
      if(m && m.episodes) return m.episodes;
      const next = m && m.nextAiringEpisode && m.nextAiringEpisode.episode;
      return (next && next > 1) ? next - 1 : 0;
    }

    function mapAniListMedia(m){
      return {
        _kodik:true,
        _mal:(m.idMal ?? null),
        _eps:alEpisodeCount(m),
        id:'al-' + m.id,
        name:{ main:(m.title.romaji || m.title.english || m.title.native), english:m.title.english, romaji:m.title.romaji },
        poster:{ src:(m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || '' },
        type:{ description:(m.format || '').replace(/_/g,' ') },
        year:(m.seasonYear || null),
        description:(m.description || '').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,''),
        genres:(m.genres || [])
      };
    }

    if(matchMedia('(min-width: 761px)').matches) $('#catalogFilters').open = true;
    const cf = {year:$('#cfYear'), format:$('#cfFormat'), status:$('#cfStatus'), sort:$('#cfSort'), more:$('#cfMore')};
    let filterPage = 1, filterItems = [], filterQuery = '', filterBusy = false, filterRequest = 0, filterSnapshot = '';
    const catalogFilterSnapshot = () => JSON.stringify([cf.year.value,cf.format.value,cf.status.value,cf.sort.value,el.searchInput.value.trim(),activeGenre]);
    function hasCatalogFilters(){ return !!(cf.year.value || cf.format.value || cf.status.value || cf.sort.value !== 'POPULARITY_DESC'); }
    async function showFilteredCatalog(q = '', more = false){
      if(cf.year.value && (!cf.year.checkValidity() || !Number.isInteger(Number(cf.year.value)))){ cf.year.reportValidity(); return; }
      const generation = more ? filterRequest : ++catalogGeneration;
      if(more && (filterBusy || generation !== catalogGeneration)) return;
      if(!more){
        filterRequest = generation; filterPage = 1; filterItems = []; filterQuery = q; filterSnapshot = catalogFilterSnapshot();
        hidePub(); pf.section.classList.add('hidden');
        const keepPlaying = isPlayerLive() && (!el.video.paused || current.mode === 'kodik' || document.pictureInPictureElement);
        if(el.home.classList.contains('hidden')) _showHome(keepPlaying);
        clearTop(); hideHero(); updateNav('home');
        pushRoute(activeGenre ? '/genre/' + encodeURIComponent(activeGenre) : '/', {view:activeGenre ? 'genre' : 'home', genre:activeGenre});
        document.title = 'Catalog - AniWired';
        el.results.className = 'grid'; el.rowHead.classList.add('is-grid');
        el.resultsTitle.textContent = activeGenre ? 'Genre: ' + activeGenre : 'Catalog';
        el.results.innerHTML = '<div class="spinner"></div>';
      }
      filterBusy = true; cf.more.disabled = true; cf.more.classList.add('hidden');
      el.resultsSub.textContent = 'Extended catalog (AniList) · loading…';
      const variables = {page:filterPage, sort:[cf.sort.value], search:filterQuery || undefined,
        genre:activeGenre ? toAniListGenre(activeGenre) : undefined,
        year:cf.year.value ? Number(cf.year.value) : undefined,
        formats:cf.format.value ? cf.format.value.split(',') : undefined, status:cf.status.value || undefined};
      const query = 'query($page:Int,$search:String,$genre:String,$year:Int,$formats:[MediaFormat],$status:MediaStatus,$sort:[MediaSort]){' +
        'Page(page:$page,perPage:40){pageInfo{hasNextPage} media(type:ANIME,isAdult:false,search:$search,genre:$genre,seasonYear:$year,format_in:$formats,status:$status,sort:$sort){' + AL_FIELDS + '}}}';
      try{
        const response = await fetch('https://graphql.anilist.co', {method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body:JSON.stringify({query,variables})});
        const result = await response.json();
        if(!response.ok || result.errors || !result.data?.Page) throw new Error('Catalog unavailable');
        if(generation !== catalogGeneration) return;
        const data = result.data.Page;
        filterItems = [...new Map([...filterItems, ...(data.media || []).map(mapAniListMedia)].map(it => [it.id,it])).values()];
        renderResults(filterItems); filterPage++;
        el.resultsSub.textContent = 'Extended catalog (AniList) · ' + filterItems.length + ' titles';
        cf.more.textContent = 'Load more'; cf.more.classList.toggle('hidden', !data.pageInfo?.hasNextPage);
      }catch(_){
        if(generation !== catalogGeneration) return;
        if(!more) el.results.innerHTML = '<p class="hint">Could not load the catalog. Change a filter or retry.</p>';
        el.resultsSub.textContent = 'Catalog unavailable · try again';
        cf.more.textContent = 'Retry'; cf.more.classList.remove('hidden');
      }finally{ if(generation === catalogGeneration){ filterBusy = false; cf.more.disabled = false; } }
    }
    window.__awFilteredCatalog = q => { if(!hasCatalogFilters()) return false; showFilteredCatalog(q); return true; };
    for(const input of [cf.year,cf.format,cf.status,cf.sort]) input.addEventListener('change', () => {
      if(catalogFilterSnapshot() !== filterSnapshot) showFilteredCatalog(el.searchInput.value.trim());
    });
    window.__awCatalogRendered = () => cf.more.classList.add('hidden');
    cf.more.onclick = () => showFilteredCatalog(filterQuery, filterItems.length > 0);
    $('#cfReset').onclick = () => {
      cf.year.value = cf.format.value = cf.status.value = ''; cf.sort.value = 'POPULARITY_DESC';
      activeGenre = ''; el.searchInput.value = ''; cf.more.classList.add('hidden');
      renderGenreBar(); showHome(true); loadHome();
    };
    // Genre navigation and search share one remote filter request, never a loaded-page-only filter.
    async function fetchGenreTitles(genre){
      const g = toAniListGenre(genre);
      // A known AniList genre is filtered properly; anything else falls back to a search.
      const known = GENRE_LIST.some(x => x.toLowerCase() === g.toLowerCase()) ||
        ['School','Historical','Horror','Thriller'].indexOf(g) !== -1;
      const query = known
        ? 'query($g:String){Page(perPage:40){media(type:ANIME,genre:$g,sort:[POPULARITY_DESC],isAdult:false){' + AL_FIELDS + '}}}'
        : 'query($g:String){Page(perPage:40){media(type:ANIME,search:$g,sort:[POPULARITY_DESC],isAdult:false){' + AL_FIELDS + '}}}';
      try{
        const r = await fetch('https://graphql.anilist.co', {
          method:'POST',
          headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
          body: JSON.stringify({ query, variables:{ g } })
        });
        const j = await r.json();
        return ((j.data && j.data.Page && j.data.Page.media) || []).map(mapAniListMedia);
      }catch(_){ return []; }
    }

    function renderGenreBar(){
      const bar = $('#genreBar');
      if(!bar) return;
      bar.innerHTML = '<span class="genre-lbl">Genres</span>' +
        GENRE_LIST.map(g => '<button class="genre-chip' + (activeGenre === g ? ' active' : '') +
          '" type="button" data-genre="' + escapeHtml(g) + '">' + escapeHtml(g) + '</button>').join('') +
        (activeGenre ? '<button class="genre-chip" type="button" data-genre="">\u2715 Clear</button>' : '');
      $$('.genre-chip', bar).forEach(b => {
        b.onclick = () => {
          const g = b.dataset.genre;
          if(g) goGenre(g);
          else { activeGenre = ''; renderGenreBar(); showHome(true); loadHome(); }
        };
      });
    }

    async function showGenre(genre){
      const catalogRequest = ++catalogGeneration;
      hidePub();
      pf.section.classList.add('hidden');
      const keepPlaying = (typeof isPlayerLive === 'function') && isPlayerLive() &&
        (!el.video.paused || current.mode === 'kodik' || document.pictureInPictureElement);
      _showHome(keepPlaying);
      if(typeof hideHero === 'function') hideHero();
      el.searchInput.value = '';
      activeGenre = genre;
      renderGenreBar();
      updateNav('home');

      el.results.className = 'grid';
      el.rowHead.classList.add('is-grid');
      el.resultsTitle.textContent = 'Genre: ' + genre;
      el.resultsSub.textContent = '';
      el.results.innerHTML = '<div class="spinner"></div>';

      if(hasCatalogFilters()){ showFilteredCatalog(''); return; }
      const list = await fetchGenreTitles(genre);
      if(activeGenre !== genre || catalogRequest !== catalogGeneration) return;                 // user navigated away meanwhile
      if(!list.length){ el.results.innerHTML = '<p class="hint">Nothing found for this genre.</p>'; return; }
      el.resultsSub.textContent = 'Extended catalog (AniList)';
      renderResults(list);
    }

    function goGenre(genre){
      if(!genre) return;
      pushRoute('/genre/' + encodeURIComponent(genre), { view:'genre', genre:String(genre) });
      document.title = genre + ' - AniWired';
      showGenre(String(genre));
    }
    window.__awGenre = goGenre;                         // used by the genre chips on a title page

    /* =================================================================
     * 1b) Top 100 charts + Random title
     * ================================================================= */

    const TOP_KINDS = {
      best:    { label:'Top 100 - best',    sort:'[SCORE_DESC]',      sub:'Highest rated on AniList', tab:'Best rated' },
      popular: { label:'Top 100 - popular', sort:'[POPULARITY_DESC]', sub:'Most watched on AniList',   tab:'Most popular' }
    };

    const topCache = {};
    let activeTop = '';

    async function fetchTop(kind){
      if(topCache[kind]) return topCache[kind];
      const query = 'query($p:Int){Page(page:$p,perPage:50){media(type:ANIME,sort:' + TOP_KINDS[kind].sort +
        ',isAdult:false,format_not_in:[MUSIC]){' + AL_FIELDS + ' averageScore}}}';
      try{
        const pages = await Promise.all([1, 2].map(p =>
          fetch('https://graphql.anilist.co', {
            method:'POST',
            headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
            body: JSON.stringify({ query, variables:{ p } })
          }).then(r => r.json())
        ));
        const list = [];
        for(const j of pages){
          for(const m of (j.data && j.data.Page && j.data.Page.media) || []){
            const t = mapAniListMedia(m);
            t._score = m.averageScore || 0;
            list.push(t);
          }
        }
        const out = list.slice(0, 100);
        if(out.length) topCache[kind] = out;
        return out;
      }catch(_){ return []; }
    }

    function renderTopBar(){
      const bar = $('#topBar');
      if(!bar) return;
      bar.classList.toggle('hidden', !activeTop);
      if(!activeTop){ bar.innerHTML = ''; return; }
      bar.innerHTML = '<span class="genre-lbl">Top 100</span>' +
        Object.keys(TOP_KINDS).map(k => '<button class="genre-chip' + (activeTop === k ? ' active' : '') +
          '" type="button" data-top="' + k + '">' + escapeHtml(TOP_KINDS[k].tab) + '</button>').join('') +
        '<button class="genre-chip" type="button" data-top="">\u2715 Clear</button>';
      $$('.genre-chip', bar).forEach(b => {
        b.onclick = () => {
          const k = b.dataset.top;
          if(k) goTop(k);
          else { clearTop(); showHome(true); loadHome(); }
        };
      });
    }

    // Leave the chart view and bring the genre bar back.
    function clearTop(){
      activeTop = '';
      renderTopBar();
      const gb = $('#genreBar');
      if(gb) gb.classList.remove('hidden');
    }

    // Numbered badges on the chart cards.
    function decorateRanks(list){
      $$('.card', el.results).forEach((c, i) => {
        const rank = document.createElement('span');
        rank.className = 'rank-badge' + (i < 3 ? ' top3' : '');
        rank.textContent = '#' + (i + 1);
        c.appendChild(rank);
        const score = list[i] && list[i]._score;
        if(score){
          const s = document.createElement('span');
          s.className = 'score-badge';
          s.textContent = '\u2605 ' + (score / 10).toFixed(1);
          c.appendChild(s);
        }
      });
    }

    async function showTop(kind){
      const catalogRequest = ++catalogGeneration;
      const k = TOP_KINDS[kind] ? kind : 'best';
      hidePub();
      pf.section.classList.add('hidden');
      const keepPlaying = (typeof isPlayerLive === 'function') && isPlayerLive() &&
        (!el.video.paused || current.mode === 'kodik' || document.pictureInPictureElement);
      _showHome(keepPlaying);
      if(typeof hideHero === 'function') hideHero();
      el.searchInput.value = '';

      if(activeGenre){ activeGenre = ''; renderGenreBar(); }
      const gb = $('#genreBar');
      if(gb) gb.classList.add('hidden');
      activeTop = k;
      renderTopBar();
      updateNav('top');

      el.results.className = 'grid';
      el.rowHead.classList.add('is-grid');
      el.resultsTitle.textContent = TOP_KINDS[k].label;
      el.resultsSub.textContent = '';
      el.results.innerHTML = '<div class="spinner"></div>';

      const list = await fetchTop(k);
      if(activeTop !== k || catalogRequest !== catalogGeneration) return;                        // user navigated away meanwhile
      if(!list.length){ el.results.innerHTML = '<p class="hint">Could not load the chart. Try again in a moment.</p>'; return; }
      el.resultsSub.textContent = TOP_KINDS[k].sub;
      renderResults(list);
      decorateRanks(list);
    }

    function goTop(kind){
      const k = TOP_KINDS[kind] ? kind : 'best';
      pushRoute('/top/' + k, { view:'top', kind:k });
      document.title = TOP_KINDS[k].label + ' - AniWired';
      showTop(k);
    }

    // ---- random title ----

    let rollBusy = false;

    async function goRandom(){
      if(rollBusy) return;
      rollBusy = true;
      const nav = $('#navRandom');
      if(nav) nav.classList.add('active');
      toast('Rolling a random title\u2026');
      try{
        // Pick one title out of the ~1000 most popular ones.
        const page = 1 + Math.floor(Math.random() * 1000);
        const query = 'query($p:Int){Page(page:$p,perPage:1){media(type:ANIME,sort:[POPULARITY_DESC],' +
          'isAdult:false,format_not_in:[MUSIC]){' + AL_FIELDS + '}}}';
        const r = await fetch('https://graphql.anilist.co', {
          method:'POST',
          headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
          body: JSON.stringify({ query, variables:{ p:page } })
        });
        const j = await r.json();
        const m = ((j.data && j.data.Page && j.data.Page.media) || [])[0];
        if(!m){ toast('Could not pick a title, try again'); return; }
        clearTop();
        openKodikTitle(mapAniListMedia(m));
      }catch(_){
        toast('Could not pick a title, try again');
      }finally{
        rollBusy = false;
        if(nav) nav.classList.remove('active');
      }
    }

    // Typing a search leaves the chart view.
    el.searchInput.addEventListener('input', () => { if(activeTop) clearTop(); });

    const navTopEl = $('#navTop');
    const navRandomEl = $('#navRandom');
    if(navTopEl){
      navTopEl.onclick = () => goTop(activeTop || 'best');
      navTopEl.addEventListener('keydown', e => {
        if(e.code === 'Enter' || e.code === 'Space'){ e.preventDefault(); goTop(activeTop || 'best'); }
      });
    }
    if(navRandomEl){
      navRandomEl.onclick = () => goRandom();
      navRandomEl.addEventListener('keydown', e => {
        if(e.code === 'Enter' || e.code === 'Space'){ e.preventDefault(); goRandom(); }
      });
    }

    /* =================================================================
     * 2) Comments under a title
     * ================================================================= */

    const cmEl = {
      box:$('#commentsBox'), list:$('#cmList'), input:$('#cmInput'),
      send:$('#cmSend'), hint:$('#cmHint'), count:$('#cmCount')
    };
    let cmAnimeId = '', cmAnimeName = '', cmBusy = false;

    function commentBody(c){
      const body = '<p class="cm-body">' + escapeHtml(c.body) + '</p>';
      return c.spoiler ? '<details class="cm-spoiler"><summary>Spoiler · click to reveal</summary>' + body + '</details>' : body;
    }
    function commentHtml(c){
      const who   = (c.user && (c.user.displayName || c.user.username)) || 'user';
      const uname = (c.user && c.user.username) || '';
      return '<div class="cm-item">' +
        '<div class="cm-av">' + escapeHtml(who.slice(0,1).toUpperCase()) + '</div>' +
        '<div class="cm-main">' +
          '<div class="cm-head">' +
            (uname
              ? '<button class="cm-user" type="button" data-user="' + escapeHtml(uname) + '" title="Open @' + escapeHtml(uname) + '">' + escapeHtml(who) + '</button>'
              : '<button class="cm-user" type="button" disabled>' + escapeHtml(who) + '</button>') +
            '<span class="cm-ago">' + fmtAgo(c.createdAt) + '</span>' +
            (c.mine ? '<button class="cm-del" type="button" data-del="' + escapeHtml(String(c.id)) + '">Delete</button>' : '') +
          '</div>' +
          commentBody(c) +
        '</div></div>';
    }

    function renderCommentsList(items){
      cmEl.count.textContent = items.length ? '(' + items.length + ')' : '';
      cmEl.list.innerHTML = items.length
        ? items.map(commentHtml).join('')
        : '<p class="cm-empty">No comments yet - be the first to write one.</p>';
      // 3) clicking the author opens their profile
      $$('.cm-user[data-user]', cmEl.list).forEach(b => { b.onclick = () => goUser(b.dataset.user); });
      $$('.cm-del', cmEl.list).forEach(b => { b.onclick = () => deleteComment(b.dataset.del); });
    }

    function updateCommentForm(){
      if(!cmEl.input) return;
      const signed = !!(token && user);
      cmEl.input.disabled = !signed;
      $('#cmSpoiler').disabled = !signed;
      cmEl.input.placeholder = signed ? 'Share your thoughts about this title\u2026' : 'Sign in to leave a comment';
      cmEl.send.textContent = signed ? 'Post' : 'Sign in';
      cmEl.hint.textContent = signed ? '' : 'Only signed-in users can comment.';
    }

    async function loadComments(id, name){
      if(!cmEl.box) return;
      const wanted = String(id || '');
      cmAnimeId = wanted;
      cmAnimeName = name || '';
      updateCommentForm();
      if(!wanted){ cmEl.box.classList.add('hidden'); return; }
      cmEl.box.classList.remove('hidden');
      cmEl.count.textContent = '';
      cmEl.list.innerHTML = '<p class="cm-empty">Loading comments\u2026</p>';
      try{
        const d = await apiCall('/api/comments/' + encodeURIComponent(wanted));
        if(cmAnimeId !== wanted) return;                // another title was opened meanwhile
        renderCommentsList(d.items || []);
      }catch(_){
        if(cmAnimeId === wanted) cmEl.list.innerHTML = '<p class="cm-empty">Comments are unavailable right now.</p>';
      }
    }

    async function postComment(){
      if(!(token && user)){ openAuth(); return; }
      const text = (cmEl.input.value || '').trim();
      if(!text){ cmEl.input.focus(); return; }
      if(cmBusy || !cmAnimeId) return;
      cmBusy = true; cmEl.send.disabled = true; cmEl.hint.textContent = 'Posting\u2026';
      try{
        await apiCall('/api/comments', { method:'POST', body:{ animeId:cmAnimeId, animeName:cmAnimeName, body:text, spoiler:$('#cmSpoiler').checked } });
        cmEl.input.value = '';
        $('#cmSpoiler').checked = false;
        cmEl.hint.textContent = '';
        await loadComments(cmAnimeId, cmAnimeName);
        toast('Comment posted');
      }catch(err){ cmEl.hint.textContent = err.message || 'Could not post the comment'; }
      finally{ cmBusy = false; cmEl.send.disabled = false; }
    }

    async function deleteComment(id){
      if(!id || !confirm('Delete this comment?')) return;
      try{
        await apiCall('/api/comments/' + encodeURIComponent(id), { method:'DELETE' });
        await loadComments(cmAnimeId, cmAnimeName);
        toast('Comment deleted');
      }catch(err){ toast(err.message || 'Could not delete the comment'); }
    }

    if(cmEl.send) cmEl.send.onclick = postComment;
    if(cmEl.input) cmEl.input.addEventListener('keydown', e => {
      if(e.code === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); postComment(); }
    });

    /* =================================================================
     * 3) Public profile of another user  (/u/<nickname>)
     * ================================================================= */

    const up = {
      section:$('#pubProfile'), back:$('#upBack'), avatar:$('#upAvatar'), name:$('#upName'), note:$('#upNote'),
      stats:$('#upStats'), titles:$('#upTitles'), episodes:$('#upEpisodes'), time:$('#upTime'), finished:$('#upFinished'),
      hidden:$('#upHidden'), grid:$('#upGrid'), comments:$('#upComments'), commentsBox:$('#upCommentsBox')
    };

    function hidePub(){ if(up.section) up.section.classList.add('hidden'); }

    function pubCardHtml(d){
      const pct  = pctOf(d);
      const seen = Array.isArray(d.seen) && d.seen.length ? d.seen.length : 1;
      const tag  = isFinished(d)
        ? '<span class="pf-tag done">Episode finished</span>'
        : '<span class="pf-tag' + (d.source === 'kodik' ? ' kodik' : '') + '">' + escapeHtml(String(d.source || 'libria').toUpperCase()) + '</span>';
      return '<div class="pf-card" data-id="' + escapeHtml(String(d.id)) + '" data-source="' + escapeHtml(String(d.source || '')) + '">' +
        '<div class="pf-art" style="background-image:url(&quot;' + escapeHtml(safePoster(d.poster)) + '&quot;)">' +
          '<img src="' + escapeHtml(safePoster(d.poster)) + '" alt="" width="220" height="320" loading="lazy" decoding="async"/></div>' +
        '<div class="pf-body">' +
          '<h4>' + escapeHtml(d.name) + '</h4>' +
          '<div class="pf-meta">' + tag +
            '<span>Episode ' + escapeHtml(String(d.epLabel)) + (d.epTotal ? ' of ' + d.epTotal : '') + '</span>' +
            '<span>\u2022 ' + seen + (seen === 1 ? ' episode watched' : ' episodes watched') + '</span>' +
          '</div>' +
          '<div class="pf-progress"><div class="pf-bar"><i style="width:' + (pct || 2) + '%"></i></div>' +
            '<div class="pf-times"><span>' + fmtAgo(d.ts) + '</span><span>' + (pct ? pct + '%' : '') + '</span></div>' +
          '</div>' +
        '</div></div>';
    }

    async function openById(id, source){
      if(!id) return;
      const viaKodik = source === 'kodik' || isKodikId(id);
      if(!viaKodik) return openTitle(id);
      const t = readKodikCache(String(id)) || await fetchAniListById(id);
      if(t) return openKodikTitle(t);
      toast('Could not open this title');
    }

    function renderPublicProfile(d){
      const u   = d.user || {};
      const who = u.displayName || u.username || 'user';
      up.name.textContent   = who;
      up.avatar.textContent = who.slice(0,1).toUpperCase();
      const since = u.createdAt
        ? ' \u2022 joined ' + new Date(u.createdAt).toLocaleDateString('en-GB', { month:'short', year:'numeric' })
        : '';
      up.note.textContent = '@' + (u.username || '') + (d.isSelf ? ' \u2022 this is you' : '') + since;

      renderFollowBar(d);
      renderPubFriends(d);

      const items = d.items || [];

      if(d.hidden === 'profile'){
        up.stats.classList.add('hidden');
        up.hidden.classList.remove('hidden');
        up.hidden.innerHTML = '<b>This profile is private</b>' +
          escapeHtml(who) + ' chose not to share their page with other people.';
      } else if(d.hidden === 'history'){
        up.stats.classList.add('hidden');
        up.hidden.classList.remove('hidden');
        up.hidden.innerHTML = '<b>Watch history is hidden</b>' +
          escapeHtml(who) + ' keeps their watched titles private.';
      } else {
        const s = d.stats || { titles:0, episodes:0, seconds:0, finished:0 };
        up.titles.textContent   = s.titles;
        up.episodes.textContent = s.episodes;
        up.time.textContent     = fmtWatchTime(s.seconds);
        up.finished.textContent = s.finished;
        up.stats.classList.remove('hidden');
        if(!items.length){
          up.hidden.classList.remove('hidden');
          up.hidden.innerHTML = '<b>Nothing here yet</b>No watched titles on this profile.';
        } else {
          up.hidden.classList.add('hidden');
        }
      }

      up.grid.innerHTML = items.map(pubCardHtml).join('');
      $$('.pf-card', up.grid).forEach(node => {
        node.onclick = () => openById(node.dataset.id, node.dataset.source);
      });

      const cms = d.comments || [];
      up.commentsBox.classList.toggle('hidden', d.hidden === 'profile');
      up.comments.innerHTML = cms.length ? cms.map(c =>
        '<div class="cm-item">' +
          '<div class="cm-av">' + escapeHtml(who.slice(0,1).toUpperCase()) + '</div>' +
          '<div class="cm-main"><div class="cm-head">' +
            '<button class="cm-user" type="button" data-title="' + escapeHtml(String(c.animeId)) + '">' +
              escapeHtml(c.animeName || 'Open title') + '</button>' +
            '<span class="cm-ago">' + fmtAgo(c.createdAt) + '</span>' +
          '</div>' + commentBody(c) + '</div>' +
        '</div>').join('') : '<p class="cm-empty">No comments yet.</p>';
      $$('.cm-user[data-title]', up.comments).forEach(b => {
        b.onclick = () => openById(b.dataset.title, '');
      });
    }

    async function showUser(username){
      if(!up.section) return;
      const uname = String(username || '').trim();
      if(!uname) return;

      el.home.classList.add('hidden');
      el.detail.classList.add('hidden');
      pf.section.classList.add('hidden');
      up.section.classList.remove('hidden');
      updateNav('user');
      window.scrollTo({ top:0, behavior:'smooth' });

      up.name.textContent   = '@' + uname;
      up.avatar.textContent = uname.slice(0,1).toUpperCase();
      up.note.textContent   = 'Loading\u2026';
      if(ufl.bar) ufl.bar.classList.add('hidden');
      if(ufl.friendsBox) ufl.friendsBox.classList.add('hidden');
      up.stats.classList.add('hidden');
      up.hidden.classList.add('hidden');
      up.grid.innerHTML = '';
      up.comments.innerHTML = '';

      try{
        const data = await apiCall('/api/users/' + encodeURIComponent(uname.toLowerCase()));
        if(ufl.bar) ufl.bar.classList.remove('hidden');
        renderPublicProfile(data);
      }catch(err){
        up.note.textContent = '';
        up.hidden.classList.remove('hidden');
        up.hidden.innerHTML = '<b>' + escapeHtml(err.message || 'User not found') + '</b>' +
          'Nothing to show for @' + escapeHtml(uname) + '.';
      }
    }

    function goUser(username){
      if(!username) return;
      // Opening your own nickname goes to the editable page instead.
      if(user && String(username).toLowerCase() === String(user.username || '').toLowerCase()){ goProfile(); return; }
      pushRoute('/u/' + encodeURIComponent(username), { view:'user', username:String(username) });
      document.title = '@' + username + ' - AniWired';
      showUser(username);
    }
    if(up.back) up.back.onclick = () => showHome(true);

    /* =================================================================
     * 4) Privacy settings
     * ================================================================= */

    let settings = null;
    const pv = { box:$('#pfPrivacy'), history:$('#pvHistory'), profile:$('#pvProfile'), note:$('#pvNote') };

    function renderPrivacy(){
      if(!pv.box) return;
      const signed = !!(token && user);
      pv.box.classList.toggle('hidden', !signed);
      if(!signed) return;
      pv.history.disabled = pv.profile.disabled = !settings;
      if(!settings){
        pv.history.checked = pv.profile.checked = false;
        pv.note.textContent = 'Privacy settings unavailable. Reconnect and sign in again before changing them.';
        return;
      }
      pv.history.checked = !!settings.historyPublic;
      pv.profile.checked = !!settings.profilePublic;
      pv.note.innerHTML = settings.profilePublic
        ? 'Your public page: <code>' + escapeHtml(location.origin + '/u/' + (user.username || '')) + '</code>'
        : 'Your profile is hidden - visitors only see your nickname.';
    }

    async function savePrivacy(){
      if(!(token && user && settings)) return;
      const generation = sessionGeneration;
      const next = { historyPublic: !!pv.history.checked, profilePublic: !!pv.profile.checked };
      pv.history.disabled = pv.profile.disabled = true;
      try{
        const d = await apiCall('/api/settings', { method:'PUT', body: next });
        if(generation !== sessionGeneration) return;
        settings = d.settings || next;
        toast('Privacy settings saved');
      }catch(err){
        toast(err.message || 'Could not save the privacy settings');
      }finally{
        if(generation === sessionGeneration) renderPrivacy();
      }
    }
    if(pv.history) pv.history.onchange = savePrivacy;
    if(pv.profile) pv.profile.onchange = savePrivacy;

    /* =================================================================
     * 4b) Account panel
     *     Thin UI over the four account endpoints: password change,
     *     global sign-out, data export and account deletion.
     * ================================================================= */

    const acc = {
      box:$('#pfAccount'),
      pwdForm:$('#accPwdForm'), current:$('#accCurrent'), next:$('#accNew'),
      pwdBtn:$('#accPwdBtn'), pwdMsg:$('#accPwdMsg'),
      logoutAll:$('#accLogoutAll'), exportBtn:$('#accExport'), msg:$('#accMsg'),
      delForm:$('#accDelForm'), delPwd:$('#accDelPwd'), delBtn:$('#accDelBtn'), delMsg:$('#accDelMsg')
    };

    function accSay(node, text, kind){
      if(!node) return;
      node.textContent = text || '';
      node.classList.toggle('ok', kind === 'ok');
      node.classList.toggle('err', kind === 'err');
    }

    function renderAccount(){
      if(!acc.box) return;
      acc.box.classList.toggle('hidden', !(token && user));
    }

    if(acc.pwdForm) acc.pwdForm.addEventListener('submit', async e => {
      e.preventDefault();
      if(!(token && user)) return;
      const currentPassword = acc.current.value;
      const newPassword     = acc.next.value;
      if(!currentPassword || !newPassword){ accSay(acc.pwdMsg, 'Fill in both fields', 'err'); return; }
      // Mirrors the server rule so the user is told before a round trip.
      if(newPassword.length < 10){ accSay(acc.pwdMsg, 'New password must be at least 10 characters', 'err'); return; }
      if(newPassword === currentPassword){ accSay(acc.pwdMsg, 'The new password must be different', 'err'); return; }
      acc.pwdBtn.disabled = true; accSay(acc.pwdMsg, 'Please wait\u2026');
      try{
        const d = await apiCall('/api/auth/password', { method:'PUT', body:{ currentPassword, newPassword } });
        // The server bumps token_epoch, so the returned token is the only one
        // still valid - every other device is signed out.
        if(d.token) setToken(d.token);
        acc.current.value = acc.next.value = '';
        accSay(acc.pwdMsg, 'Password changed - other devices were signed out', 'ok');
        toast('Password changed');
      }catch(err){ accSay(acc.pwdMsg, err.message || 'Could not change the password', 'err'); }
      finally{ acc.pwdBtn.disabled = false; }
    });

    if(acc.logoutAll) acc.logoutAll.onclick = async () => {
      if(!(token && user)) return;
      if(!confirm('Sign out on all devices, including this one?')) return;
      acc.logoutAll.disabled = true; accSay(acc.msg, 'Please wait\u2026');
      try{
        await apiCall('/api/auth/logout-all', { method:'POST', body:{} });
        accSay(acc.msg, 'All sessions were revoked', 'ok');
        // This token is dead too, so drop it locally instead of waiting for 401.
        setToken('');
        settings = null;
        renderAuthUI();
        toast('Signed out everywhere - account history stays separate');
      }catch(err){ accSay(acc.msg, err.message || 'Could not revoke the sessions', 'err'); }
      finally{ acc.logoutAll.disabled = false; }
    };

    if(acc.exportBtn) acc.exportBtn.onclick = async () => {
      if(!(token && user)) return;
      acc.exportBtn.disabled = true; accSay(acc.msg, 'Preparing your file\u2026');
      try{
        const data = await apiCall('/api/account/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = 'aniwired-' + (user.username || 'account') + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 30000);
        accSay(acc.msg, 'Your data was downloaded as JSON', 'ok');
      }catch(err){ accSay(acc.msg, err.message || 'Could not export your data', 'err'); }
      finally{ acc.exportBtn.disabled = false; }
    };

    if(acc.delForm) acc.delForm.addEventListener('submit', async e => {
      e.preventDefault();
      if(!(token && user)) return;
      const password = acc.delPwd.value;
      if(!password){ accSay(acc.delMsg, 'Enter your password to confirm', 'err'); return; }
      if(!confirm('Delete the account @' + (user.username || '') + ' with all history and comments? This cannot be undone.')) return;
      acc.delBtn.disabled = true; accSay(acc.delMsg, 'Please wait\u2026');
      try{
        await apiCall('/api/account', { method:'DELETE', body:{ password } });
        acc.delPwd.value = '';
        localStorage.removeItem(storageKey(HISTORY_BASE));
        localStorage.removeItem(storageKey(CHECKPOINT_BASE));
        localStorage.removeItem(storageKey(DELETE_BASE));
        setToken('');
        settings = null;
        renderAuthUI();
        accSay(acc.delMsg, 'Account deleted', 'ok');
        toast('Account deleted');
        showHome();
      }catch(err){ accSay(acc.delMsg, err.message || 'Could not delete the account', 'err'); }
      finally{ acc.delBtn.disabled = false; }
    });

    /* =================================================================
     * 5) Friends / subscriptions
     *    One follow row = a subscription. Two mirrored rows = friends.
     * ================================================================= */

    const fl = { section:$('#pfSocial'), people:$('#flPeople'), empty:$('#flEmpty') };
    const ufl = {
      bar:$('#upFollowBar'), btn:$('#upFollow'), badge:$('#upBadge'), counts:$('#upCounts'),
      friendsBox:$('#upFriendsBox'), friends:$('#upFriends')
    };

    let social = { friends:[], following:[], followers:[] };
    let flTab = 'friends';
    let socialLoaded = false;
    let pubData = null, followBusy = false;

    function personHtml(u){
      const who = u.displayName || u.username || 'user';
      return '<button class="fl-person" type="button" data-user="' + escapeHtml(u.username || '') + '">' +
        '<span class="fl-av">' + escapeHtml(who.slice(0,1).toUpperCase()) + '</span>' +
        '<span class="fl-info">' +
          '<b>' + escapeHtml(who) + '</b>' +
          '<span>' + (u.friend ? '<i class="fl-mini">Friend</i> \u2022 ' : '') + '@' + escapeHtml(u.username || '') + '</span>' +
        '</span></button>';
    }

    function bindPeople(root){
      if(!root) return;
      $$('.fl-person', root).forEach(b => { b.onclick = () => goUser(b.dataset.user); });
    }

    function renderSocial(){
      if(!fl.section) return;
      const signed = !!(token && user);
      fl.section.classList.toggle('hidden', !signed);
      if(!signed) return;

      $$('.fl-tab', fl.section).forEach(b => b.classList.toggle('active', b.dataset.tab === flTab));
      $$('.fl-tab', fl.section).forEach(b => {
        const n = (social[b.dataset.tab] || []).length;
        const base = b.dataset.tab === 'friends' ? 'Friends' : (b.dataset.tab === 'following' ? 'Following' : 'Followers');
        b.textContent = n ? base + ' ' + n : base;
      });

      const list = social[flTab] || [];
      fl.people.innerHTML = list.map(personHtml).join('');
      bindPeople(fl.people);

      fl.empty.classList.toggle('hidden', list.length > 0);
      if(!list.length){
        fl.empty.textContent =
          flTab === 'friends'   ? 'No friends yet - a friend appears when you and another person follow each other.' :
          flTab === 'following' ? 'No one-way subscriptions. People who follow you back move to Friends.' :
                                  'Nobody is following you one-way. Mutual follows are listed under Friends.';
      }
    }

    async function loadSocial(force){
      if(!(token && user)){ social = { friends:[], following:[], followers:[] }; socialLoaded = false; renderSocial(); return; }
      if(socialLoaded && !force){ renderSocial(); return; }
      try{
        const d = await apiCall('/api/follows');
        social = { friends:d.friends || [], following:d.following || [], followers:d.followers || [] };
        socialLoaded = true;
      }catch(_){ social = { friends:[], following:[], followers:[] }; }
      renderSocial();
    }

    if(fl.section){
      $$('.fl-tab', fl.section).forEach(b => {
        b.onclick = () => { flTab = b.dataset.tab; renderSocial(); };
      });
    }

    // ---- follow button on someone else's profile ----

    function renderFollowBar(d){
      if(!ufl.bar) return;
      pubData = d;
      const rel = d.relation || {};
      const c   = d.counts || { followers:0, following:0, friends:0 };
      const me  = !!(token && user);

      ufl.counts.innerHTML =
        '<span><b>' + c.followers + '</b> followers</span>' +
        '<span><b>' + c.following + '</b> following</span>' +
        '<span><b>' + c.friends + '</b> friends</span>';

      ufl.badge.classList.toggle('hidden', !rel.isFriend);

      if(d.isSelf || rel.isSelf){
        ufl.btn.classList.add('hidden');
        return;
      }
      ufl.btn.classList.remove('hidden');
      ufl.btn.disabled = false;
      ufl.btn.classList.toggle('on', !!rel.isFollowing);
      ufl.btn.textContent = rel.isFriend    ? 'Friends \u2713'
                          : rel.isFollowing ? 'Following \u2713'
                          : rel.followsMe   ? 'Follow back'
                          : me              ? 'Follow'
                                            : 'Sign in to follow';
      ufl.btn.title = rel.isFollowing ? 'Click to unfollow' : 'Subscribe to this person';
    }

    function renderPubFriends(d){
      if(!ufl.friendsBox) return;
      const list = (d.friends || []).filter(u => u && u.username);
      ufl.friendsBox.classList.toggle('hidden', d.hidden === 'profile' || !list.length);
      ufl.friends.innerHTML = list.map(personHtml).join('');
      bindPeople(ufl.friends);
    }

    async function toggleFollow(){
      if(!(token && user)){ openAuth(); return; }
      if(followBusy || !pubData || !pubData.user || !pubData.user.username) return;
      const uname = pubData.user.username;
      const rel   = pubData.relation || {};
      followBusy = true;
      ufl.btn.disabled = true;
      ufl.btn.textContent = rel.isFollowing ? 'Unfollowing\u2026' : 'Following\u2026';
      try{
        const d = await apiCall('/api/follow/' + encodeURIComponent(uname), {
          method: rel.isFollowing ? 'DELETE' : 'POST'
        });
        pubData.relation = d.relation || {};
        pubData.counts   = d.counts || pubData.counts;
        renderFollowBar(pubData);
        toast(d.relation && d.relation.isFriend ? 'You are friends now'
            : d.relation && d.relation.isFollowing ? 'Following @' + uname
            : 'Unfollowed @' + uname);
        loadSocial(true);                              // keep the profile lists fresh
      }catch(err){
        toast(err.message || 'Could not update the subscription');
        renderFollowBar(pubData);
      }finally{
        followBusy = false;
      }
    }
    if(ufl.btn) ufl.btn.onclick = toggleFollow;

    function statsOf(list){
      let episodes = 0, seconds = 0, finished = 0;
      for(const it of list){
        const seen = Array.isArray(it.seen) ? it.seen.length : 1;
        episodes += seen;
        seconds  += (it.duration ? Math.max(0, (seen - 1)) * it.duration : 0) + (it.time || 0);
        if(isFinished(it)) finished++;
      }
      return { titles:list.length, episodes, seconds, finished };
    }

    function refreshStats(){
      const s = statsOf(historyList());
      pf.titles.textContent   = s.titles;
      pf.episodes.textContent = s.episodes;
      pf.time.textContent     = fmtWatchTime(s.seconds);
      pf.finished.textContent = s.finished;
      const at = $('#authStatTitles'), ae = $('#authStatEpisodes'), aw = $('#authStatTime');
      if(at) at.textContent = s.titles;
      if(ae) ae.textContent = s.episodes;
      if(aw) aw.textContent = fmtWatchTime(s.seconds);
    }

    const LIST_BASE = 'aw:watchlist';
    const LIST_STATUS = {planned:'Planned', watching:'Watching', completed:'Completed', on_hold:'On hold', dropped:'Dropped'};
    let profileView = 'saved', listFlight = null;
    function readWatchlist(){ return scope ? storedObject(storageKey(LIST_BASE)) : {}; }
    function writeWatchlist(map){ if(scope) localStorage.setItem(storageKey(LIST_BASE), JSON.stringify(map)); }
    function statusOptions(value, filter){
      return '<option value="">' + (filter ? 'All statuses' : 'Not in My list') + '</option>' +
        Object.entries(LIST_STATUS).map(([key,label]) => '<option value="' + key + '"' + (key === value ? ' selected' : '') + '>' + label + '</option>').join('');
    }
    function paintWatchStatus(){
      const select = $('#watchStatus');
      select.disabled = !scope || !current.title;
      const item = current.title && readWatchlist()[String(current.title.id)];
      select.innerHTML = statusOptions(item?.status, false);
    }
    function setWatchStatus(t, status){
      if(!scope || !t || (!LIST_STATUS[status] && status !== 'removed')) return;
      const map = readWatchlist(), id = String(t.id), old = map[id];
      map[id] = {id, name:typeof t.name === 'string' ? t.name : titleName(t),
        poster:typeof t.poster === 'string' ? t.poster : posterUrl(t), status,
        ts:Math.max(Date.now(), (old?.ts || 0) + 1), dirty:true};
      writeWatchlist(map); paintWatchStatus(); renderProfile(); syncWatchlist();
    }
    async function syncWatchlist(){
      if(!token || !user || !scope){ $('#listSyncNote').textContent = 'Saved on this device'; return; }
      if(listFlight) return listFlight;
      const generation = sessionGeneration;
      const run = async () => {
        $('#listSyncNote').textContent = 'Syncing…';
        try{
          // A second edit during an in-flight request must remain dirty.
          for(;;){
            const pending = Object.values(readWatchlist()).find(it => it.dirty);
            if(!pending) break;
            await apiCall('/api/watchlist/' + encodeURIComponent(pending.id), {method:'PUT', body:pending});
            if(generation !== sessionGeneration) return;
            const map = readWatchlist();
            if(map[pending.id]?.ts === pending.ts){ map[pending.id].dirty = false; writeWatchlist(map); }
          }
          const result = await apiCall('/api/watchlist');
          if(generation !== sessionGeneration) return;
          const map = readWatchlist();
          for(const it of result.items || []){
            if(!it || !it.id || (!LIST_STATUS[it.status] && it.status !== 'removed')) continue;
            if(!map[it.id]?.dirty && (!map[it.id] || it.ts >= map[it.id].ts)) map[it.id] = it;
          }
          writeWatchlist(map); paintWatchStatus(); renderProfile();
          $('#listSyncNote').textContent = 'Synced';
        }catch(_){ if(generation === sessionGeneration) $('#listSyncNote').textContent = 'Saved locally · sync pending'; }
      };
      listFlight = run().finally(() => { if(generation === sessionGeneration) listFlight = null; });
      return listFlight;
    }
    function renderSavedList(q){
      const status = $('#pfStatusFilter').value;
      const list = Object.values(readWatchlist()).filter(it => LIST_STATUS[it.status] && (!status || it.status === status) && (!q || it.name.toLowerCase().includes(q)));
      list.sort(pf.sort.value === 'title' ? (a,b) => a.name.localeCompare(b.name) : (a,b) => b.ts-a.ts);
      pf.empty.classList.toggle('hidden', list.length > 0);
      pf.empty.querySelector('b').textContent = q || status ? 'No matches' : 'Your list is empty';
      pf.empty.querySelector('p').textContent = 'Save a title from its card or detail page — no playback needed.';
      pf.grid.innerHTML = list.map(it => '<article class="pf-card saved-card" data-id="' + escapeHtml(it.id) + '">' +
        '<button class="pf-x" type="button" aria-label="Remove from My list">✕</button>' +
        '<button class="saved-open" type="button">' + (safePoster(it.poster) ? '<img src="' + escapeHtml(safePoster(it.poster)) + '" alt="" width="80" height="114" loading="lazy" />' : '<span class="saved-no-poster" aria-hidden="true">No poster</span>') + '<h4>' + escapeHtml(it.name) + '</h4></button>' +
        '<label>Status <select class="ui saved-status" aria-label="Status for ' + escapeHtml(it.name) + '">' + statusOptions(it.status, false) + '</select></label></article>').join('');
      $$('.saved-card', pf.grid).forEach(card => {
        const it = readWatchlist()[card.dataset.id];
        card.querySelector('.saved-open').onclick = () => openById(it.id, '');
        card.querySelector('.pf-x').onclick = () => setWatchStatus(it, 'removed');
        card.querySelector('select').onchange = e => setWatchStatus(it, e.target.value || 'removed');
      });
    }
    $('#pfStatusFilter').innerHTML = statusOptions('', true);
    $('#pfStatusFilter').onchange = () => renderProfile();
    $('#pfSavedTab').onclick = () => { profileView = 'saved'; renderProfile(); syncWatchlist(); };
    $('#pfHistoryTab').onclick = () => { profileView = 'history'; renderProfile(); };
    window.__awAddToList = t => {
      if(!scope){ openAuth(); return; }
      const existing = readWatchlist()[String(t.id)];
      if(!LIST_STATUS[existing?.status]) setWatchStatus(t, 'planned');
      toast('Saved in My list');
    };
    $('#watchStatus').onchange = e => setWatchStatus(current.title, e.target.value || 'removed');
    window.addEventListener('online', () => syncWatchlist());
    window.addEventListener('focus', () => syncWatchlist());
    window.addEventListener('storage', e => { if(e.key === storageKey(LIST_BASE)){ paintWatchStatus(); renderProfile(); } });

    function renderProfile(){
      if(!pf.grid) return;
      refreshStats();
      renderPrivacy();
      renderAccount();
      renderLocalImport();

      const signed = !!(token && user);
      const who    = signed ? (user.displayName || user.username || 'user') : 'Guest';
      pf.name.textContent   = who;
      pf.avatar.textContent = who.slice(0,1).toUpperCase();
      pf.note.textContent   = signed
        ? '@' + (user.username || who)
        : 'Signed out - history is stored on this device only';

      const savedView = profileView === 'saved';
      $('#pfSavedTab').setAttribute('aria-pressed', String(savedView));
      $('#pfHistoryTab').setAttribute('aria-pressed', String(!savedView));
      $('#pfStatusFilter').classList.toggle('hidden', !savedView);
      pf.clear.classList.toggle('hidden', savedView);
      pf.sort.querySelector('[value="progress"]').disabled = savedView;
      pf.sort.querySelector('[value="recent"]').textContent = savedView ? 'Recently updated' : 'Recently watched';
      pf.filter.placeholder = savedView ? 'Filter My list…' : 'Filter your history…';
      pf.filter.setAttribute('aria-label', savedView ? 'Filter My list' : 'Filter watch history');
      const q = (pf.filter.value || '').trim().toLowerCase();
      if(savedView){ renderSavedList(q); return; }
      let list = historyList().filter(it => !q || String(it.name).toLowerCase().indexOf(q) !== -1);
      const sort = pf.sort.value;
      if(sort === 'title')    list.sort((a,b) => String(a.name).localeCompare(String(b.name)));
      if(sort === 'progress') list.sort((a,b) => pctOf(a) - pctOf(b));

      pf.empty.classList.toggle('hidden', list.length > 0);
      if(!list.length){
        pf.grid.innerHTML = '';
        pf.empty.querySelector('b').textContent = q ? 'No matches' : 'Nothing here yet';
        pf.empty.querySelector('p').textContent = 'Your watched titles will appear here after playback.';
        return;
      }

      pf.grid.innerHTML = list.map(d => {
        const pct = pctOf(d);
        const seen = Array.isArray(d.seen) ? d.seen.length : 1;
        const tag = isFinished(d)
          ? '<span class="pf-tag done">Episode finished</span>'
          : '<span class="pf-tag' + (d.source === 'kodik' ? ' kodik' : '') + '">' + escapeHtml((d.source || 'libria').toUpperCase()) + '</span>';
        return '<div class="pf-card" data-id="' + escapeHtml(String(d.id)) + '">' +
          '<button class="pf-x" data-del="' + escapeHtml(String(d.id)) + '" title="Remove from history">\u2715</button>' +
          '<div class="pf-art" style="background-image:url(&quot;' + escapeHtml(safePoster(d.poster)) + '&quot;)">' +
            '<img src="' + escapeHtml(safePoster(d.poster)) + '" alt="" width="220" height="320" loading="lazy" decoding="async"/></div>' +
          '<div class="pf-body">' +
            '<h4>' + escapeHtml(d.name) + '</h4>' +
            '<div class="pf-meta">' + tag +
              '<span>Episode ' + escapeHtml(String(d.epLabel)) + (d.epTotal ? ' of ' + d.epTotal : '') + '</span>' +
              '<span>\u2022 ' + seen + (seen === 1 ? ' episode watched' : ' episodes watched') + '</span>' +
            '</div>' +
            '<div class="pf-progress">' +
              '<div class="pf-bar"><i style="width:' + (pct || 2) + '%"></i></div>' +
              '<div class="pf-times"><span>Stopped at ' + fmtLong(d.time) +
                (d.duration ? ' / ' + fmtLong(d.duration) + ' (' + pct + '%)' : '') + '</span>' +
              '<span class="pf-resume">\u25b6 Resume</span></div>' +
              '<div class="pf-times"><span>' + fmtAgo(d.ts) + '</span>' +
                (d.quality ? '<span>' + escapeHtml(String(d.quality).replace('hls_', '') + 'p') + '</span>' : '<span></span>') +
              '</div>' +
            '</div>' +
          '</div></div>';
      }).join('');

      $$('.pf-card', pf.grid).forEach(node => {
        node.onclick = e => {
          if(e.target.classList.contains('pf-x')) return;
          const d = readHistory()[node.dataset.id];
          if(d) resumeItem(d);
        };
      });
      $$('.pf-x', pf.grid).forEach(btn => {
        btn.onclick = e => { e.stopPropagation(); deleteItem(btn.dataset.del); };
      });
    }

    pf.filter.addEventListener('input', debounce(renderProfile, 150));
    pf.sort.addEventListener('change', renderProfile);
    pf.clear.onclick = async () => {
      if(!scope || clearingHistory || !historyList().length) return;
      if(!confirm('Clear the whole watch history?')) return;
      const generation = sessionGeneration;
      clearUndoTimers(); writeUndoRecords({});
      const ids = Object.values(readHistory()).map(item => String(item.id));
      if(current.title) ids.push(String(current.title.id));
      ids.forEach(id => { suppressedTitles.add(id); cancelQueuedProgress(id); });
      writeDeletionJournal({clear:true, ids:[]});
      clearingHistory = true; historyRevision++;
      clearTimeout(pushTimer); pushTimer = 0; pendingWrites.clear(); pendingItem = null; failedQueue = [];
      try{
        await drainDeletions();
        if(generation !== sessionGeneration) return;
        renderResume(); renderProfile(); refreshStats();
        toast('Watch history cleared');
      }catch(_){
        if(generation === sessionGeneration) toast('History removal pending. Reconnect to retry; progress will not be re-uploaded.');
      }finally{ if(generation === sessionGeneration){ clearingHistory = false; renderLocalImport(); } }
    };
    pf.back.onclick = () => showHome();

    el.searchInput.addEventListener('input', () => {
      if(pf.section.classList.contains('hidden')) return;
      const keepPlaying = (typeof isPlayerLive === 'function') && isPlayerLive() &&
        (!el.video.paused || current.mode === 'kodik' || document.pictureInPictureElement);
      showHome(keepPlaying);
    });
    el.searchInput.addEventListener('focus', () => {
      if(!pf.section.classList.contains('hidden') && el.searchInput.value.trim()) showHome(true);
    });

    function showProfile(){
      ++catalogGeneration;
      hidePub();
      el.home.classList.add('hidden');
      el.detail.classList.add('hidden');
      pf.section.classList.remove('hidden');
      renderProfile();
      loadSocial();
      updateNav('profile');
      window.scrollTo({ top:0, behavior:'smooth' });
    }
    function goProfile(){
      pushRoute('/profile', { view:'profile' });
      document.title = 'AniWired - My list';
      showProfile();
    }

    function updateNav(view){
      el.navHome.classList.toggle('active', view === 'home');
      if(el.navNew) el.navNew.classList.toggle('active', false);
      const nav = $('#navProfile');
      if(nav) nav.classList.toggle('active', view === 'profile');
      const top = $('#navTop');
      if(top) top.classList.toggle('active', view === 'top');
    }

    const kodikCache = {};                       // id -> AniList/Kodik title object
    let routing = false;                         // true while applying a popstate

    const pathForTitle = id => '/title/' + encodeURIComponent(String(id));
    function pushRoute(path, state){
      if(routing) return;
      if(location.pathname === path) history.replaceState(state, '', path);
      else history.pushState(state, '', path);
    }

    const _openTitle = openTitle;
    openTitle = function(id, resume){
      if(!deletingTitles.has(String(id)) && !clearingHistory && !deletionPending(id)) suppressedTitles.delete(String(id));
      const saved = readHistory()[String(id)];
      if(!resume && saved?.source === 'kodik') return resumeItem(saved);
      if(!resume && saved) resume = { idx:saved.idx, time:saved.time, quality:saved.quality };
      pf.section.classList.add('hidden');
      hidePub();
      pushRoute(pathForTitle(id), { view:'title', id:String(id) });
      document.title = 'AniWired - loading\u2026';
      const p = _openTitle(id, resume);
      Promise.resolve(p).then(() => {
        if(current.title) document.title = titleName(current.title) + ' - AniWired';
        markSeenEpisodes();
        paintWatchStatus();
        loadComments(String(id), current.title ? titleName(current.title) : '');
      }).catch(()=>{});
      return p;
    };

    if(typeof openKodikTitle === 'function'){
      const _openKodik = openKodikTitle;
      openKodikTitle = function(t, resume){
        if(!deletingTitles.has(String(t.id)) && !clearingHistory && !deletionPending(t.id)) suppressedTitles.delete(String(t.id));
        pf.section.classList.add('hidden');
        hidePub();
        if(t && t.id != null){
          kodikCache[String(t.id)] = t;
          try{ sessionStorage.setItem('aw:kodik:' + t.id, JSON.stringify(t)); }catch(_){}
          pushRoute(pathForTitle(t.id), { view:'title', id:String(t.id), kodik:true });
          document.title = titleName(t) + ' - AniWired';
        }
        const p = _openKodik(t, resume);
        Promise.resolve(p)
          .then(() => {
            if(current.title !== t) return;
            paintWatchStatus();
            renderKodikEpisodes(t);
            loadComments(String((t && t.id) || ''), t ? titleName(t) : '');
          })
          .catch(() => {});
        return p;
      };
    }

    const _showHome = showHome;
    showHome = function(keepPlayer){
      if(!keepPlayer) saveProgress();
      pf.section.classList.add('hidden');
      hidePub();
      clearTop();
      if(activeGenre){ activeGenre = ''; renderGenreBar(); }
      pushRoute('/', { view:'home' });
      document.title = 'AniWired';
      updateNav('home');
      return _showHome(keepPlayer);
    };

    // Returning to a live player changes navigation only: never reload the iframe.
    el.miniReturn.addEventListener('click', e => {
      if(e.target.closest('#mrClose') || !current.title) return;
      pf.section.classList.add('hidden'); hidePub();
      pushRoute(pathForTitle(current.title.id), {view:'title', id:String(current.title.id), kodik:current.mode === 'kodik'});
      document.title = titleName(current.title) + ' - AniWired';
      el.backBtn.focus({preventScroll:true});
    });

    function readKodikCache(id){
      if(kodikCache[id]) return kodikCache[id];
      try{ return JSON.parse(sessionStorage.getItem('aw:kodik:' + id) || 'null'); }catch(_){ return null; }
    }

    function applyRoute(){
      routing = true;
      try{
        const path = location.pathname;
        const m  = path.match(/^\/title\/([^/?#]+)\/?$/);
        const gm = path.match(/^\/genre\/([^/?#]+)\/?$/);
        const um = path.match(/^\/u\/([^/?#]+)\/?$/);
        const tm = path.match(/^\/top(?:\/(best|popular))?\/?$/);
        if(m){
          pf.section.classList.add('hidden');
          hidePub();
          const id = decodeURIComponent(m[1]);
          const cached = readKodikCache(id);
          if(cached && typeof openKodikTitle === 'function') openKodikTitle(cached);
          else if(isKodikId(id)){
            const saved = readHistory()[String(id)];
            if(saved) resumeItem(saved);
            else fetchAniListById(id).then(t => {
              if(t) openKodikTitle(t);
              else {
                toast('Open this title from the catalog');
                _showHome(false);
                history.replaceState({ view:'home' }, '', '/');
              }
            });
          }
          else openTitle(id);
        } else if(/^\/profile\/?$/.test(path)){
          showProfile();
        } else if(gm){
          clearTop();
          showGenre(decodeURIComponent(gm[1]));
        } else if(tm){
          showTop(tm[1] || 'best');
        } else if(/^\/random\/?$/.test(path)){
          history.replaceState({ view:'home' }, '', '/');
          goRandom();
        } else if(um){
          clearTop();
          showUser(decodeURIComponent(um[1]));
        } else {
          pf.section.classList.add('hidden');
          hidePub();
          clearTop();
          if(activeGenre){ activeGenre = ''; renderGenreBar(); }
          _showHome(false);
          el.miniReturn.classList.remove('show');
          updateNav('home');
        }
      } finally { routing = false; }
    }

    window.addEventListener('popstate', () => { saveProgress(); applyRoute(); });

    const initialPath = location.pathname;
    if(!/^\/(title|profile|genre|u|top|random)\b/.test(initialPath)) history.replaceState({ view:'home' }, '', location.pathname + location.search);

    const ael = {
      back:$('#authBack'), close:$('#authClose'), guest:$('#authGuest'), userBox:$('#authUser'),
      tabLogin:$('#tabLogin'), tabRegister:$('#tabRegister'), form:$('#authForm'), warn:$('#authWarn'),
      name:$('#authName'), password:$('#authPassword'), submit:$('#authSubmit'),
      msg:$('#authMsg'), title:$('#authTitle'), sub:$('#authSub'),
      nameLabel:$('#authNameLabel'), avatar:$('#authAvatar'), logout:$('#authLogout'),
      profileBtn:$('#authProfile'), nav:$('#navAuth'), navProfile:$('#navProfile')
    };
    let mode = 'login';

    function resetSessionWork(){
      sessionGeneration++;
      listFlight = null;
      clearUndoTimers();
      clearTimeout(pushTimer); pushTimer = 0;
      pendingWrites.clear(); pushedSigs.clear(); inFlight.clear(); progressRequests.clear();
      pendingItem = null; failedQueue = []; deletionFlight = null;
    }
    function setIdentity(nextUser){
      if(nextUser && (typeof nextUser.id !== 'string' || !nextUser.id)) throw new Error('Invalid account identity');
      const nextScope = nextUser ? 'user:' + encodeURIComponent(nextUser.id) : (token ? null : 'guest');
      if(scope !== nextScope){
        resetSessionWork();
        // Stop the old account's player before exposing a new storage scope.
        scope = null;
        el.mrClose.click(); current.title = null;
        watch.key = ''; watch.acc = 0; lastPicked = null;
        suppressedTitles.clear(); deletingTitles.clear(); clearingHistory = false;
        scope = nextScope;
        restoreUndo();
        deletionJournal().ids.forEach(id => suppressedTitles.add(id));
      }
      user = nextUser;
      restoreUndo();
    }
    function setToken(t){
      t = t || '';
      if(token !== t) resetSessionWork();
      token = t;
      if(token) localStorage.setItem(TOKEN_KEY, token);
      else {
        localStorage.removeItem(TOKEN_KEY);
        setIdentity(null); settings = null;
      }
    }
    function setMsg(text, ok){
      ael.msg.textContent = text || '';
      ael.msg.classList.toggle('ok', !!ok);
    }
    function setMode(next){
      mode = next;
      ael.tabLogin.classList.toggle('active', mode === 'login');
      ael.tabLogin.setAttribute('aria-pressed', String(mode === 'login'));
      ael.tabRegister.setAttribute('aria-pressed', String(mode === 'register'));
      ael.tabRegister.classList.toggle('active', mode === 'register');
      ael.title.textContent  = mode === 'login' ? 'Sign in' : 'Create account';
      ael.submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      ael.password.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
      // The "no password recovery" warning matters only while creating an account.
      if(ael.warn) ael.warn.classList.toggle('hidden', mode !== 'register');
      // Only new passwords must satisfy the current minimum; existing shorter
      // ones must still be accepted at sign-in.
      ael.password.setAttribute('minlength', mode === 'login' ? '1' : '10');
      ael.password.setAttribute('placeholder', mode === 'login' ? 'Your password' : 'At least 10 characters');
      setMsg('');
    }
    function renderAuthUI(){
      const signed = !!(token && user);
      const who = signed ? (user.displayName || user.username || 'user') : '';
      ael.nav.innerHTML = '<span class="dot"></span>' + escapeHtml(signed ? who : 'Sign in');
      ael.nav.classList.toggle('signed', signed);
      ael.nav.title = signed ? 'Account' : 'Sign in to sync your history';
      ael.guest.classList.toggle('hidden', signed);
      ael.userBox.classList.toggle('hidden', !signed);
      if(signed){
        ael.title.textContent = 'Your account';
        ael.sub.textContent = '';
        ael.nameLabel.textContent = '@' + (user.username || who);
        ael.avatar.textContent = who.slice(0,1).toUpperCase();
      } else {
        ael.sub.textContent = 'Sync your watch history across every device.';
        setMode(mode);
      }
      renderResume();
      renderProfile();
    }
    let authFocus = null, authBackground = [], authOverflow = '';
    const authControls = () => [...ael.back.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
      .filter(n => !n.disabled && n.getClientRects().length && !n.closest('[inert]'));
    function openAuth(){
      if(ael.back.classList.contains('show')) return;
      authFocus = document.activeElement; authOverflow = document.body.style.overflow;
      authBackground = [...document.querySelectorAll('body > header, body > main, #miniReturn')].map(n => ({n, inert:n.inert}));
      authBackground.forEach(({n}) => { n.inert = true; });
      document.body.style.overflow = 'hidden'; ael.back.classList.add('show');
      (user ? ael.close : ael.name).focus();
    }
    function closeAuth(){
      if(!ael.back.classList.contains('show')) return;
      ael.back.classList.remove('show'); setMsg('');
      authBackground.forEach(({n,inert}) => { n.inert = inert; }); authBackground = [];
      document.body.style.overflow = authOverflow;
      const focus = authFocus && authFocus.isConnected && authFocus.getClientRects().length ? authFocus : ael.nav;
      focus.focus(); authFocus = null;
    }
    ael.back.addEventListener('keydown', e => {
      if(e.key !== 'Tab') return;
      const controls = authControls(), first = controls[0], last = controls[controls.length-1];
      if(!first){ e.preventDefault(); $('#authModal').focus(); return; }
      if(e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))){ e.preventDefault(); first.focus(); }
    });

    ael.nav.onclick = openAuth;
    ael.nav.addEventListener('keydown', e => { if(e.code === 'Enter' || e.code === 'Space'){ e.preventDefault(); openAuth(); } });
    ael.close.onclick = closeAuth;
    ael.back.addEventListener('click', e => { if(e.target === ael.back) closeAuth(); });
    document.addEventListener('keydown', e => { if(e.code === 'Escape' && ael.back.classList.contains('show')) closeAuth(); });
    ael.tabLogin.onclick    = () => setMode('login');
    ael.tabRegister.onclick = () => setMode('register');
    ael.profileBtn.onclick  = () => { closeAuth(); goProfile(); };
    if(ael.navProfile){
      ael.navProfile.onclick = () => goProfile();
      ael.navProfile.addEventListener('keydown', e => { if(e.code === 'Enter' || e.code === 'Space'){ e.preventDefault(); goProfile(); } });
    }

    ael.form.addEventListener('submit', async e => {
      e.preventDefault();
      const username = ael.name.value.trim();
      const password = ael.password.value;
      if(!username || !password){ setMsg('Fill in both fields'); return; }
      // Mirrors the server rules so the user is told before a round trip (audit C-4).
      if(mode === 'register' && password.length < 10){
        setMsg('Password must be at least 10 characters'); return;
      }
      if(mode === 'register' && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,19}$/.test(username)){
        setMsg('Username: 3-20 characters, letters, digits, _ . - only'); return;
      }
      ael.submit.disabled = true; setMsg('Please wait\u2026');
      try{
        const data = await apiCall('/api/auth/' + mode, { method:'POST', auth:false, body:{ username, password } });
        // Old API versions did not return settings. Fetch real values rather
        // than inventing public defaults; keep controls disabled on failure.
        let me = data;
        setToken(data.token);
        if(!data.settings) me = await apiCall('/api/auth/me');
        setIdentity(me.user || data.user);
        settings = me.settings || null;
        setMsg(mode === 'login' ? 'Signed in' : 'Account created', true);
        renderAuthUI();
        const generation = sessionGeneration;
        await syncProgress();
        if(generation !== sessionGeneration) return;
        toast('Signed in as ' + (user.displayName || user.username));
        setTimeout(closeAuth, 450);
        ael.password.value = '';
      }catch(err){ setMsg(err.message || 'Something went wrong'); }
      finally{ ael.submit.disabled = false; }
    });

    ael.logout.onclick = () => {
      setToken('');
      settings = null;
      renderAuthUI();
      closeAuth();
      toast('Signed out - account history stays separate from guest history');
    };

    /* session restore */
    async function bootSession(){
      if(token){
        try{
          const me = await apiCall('/api/auth/me');
          // Sliding session: the server hands back a fresh token when the
          // current one is close to expiry, so an active user is never
          // signed out on a fixed schedule.
          if(me.token) setToken(me.token);
          setIdentity(me.user);
          settings = me.settings || null;
          renderAuthUI();
          await syncProgress(true);
        }catch(_){ renderAuthUI(); /* A temporary network outage must not sign the user out. */ }
      } else {
        try{ await drainDeletions(); }catch(_){}
        renderAuthUI();
      }
    }
    restoreUndo();
    bootSession().finally(() => {
      // Resolve account history before restoring a deep link on a new device.
      if(location.pathname === initialPath && !current.title && /^\/(title|profile|genre|u|top|random)\b/.test(initialPath)) applyRoute();
    });

    /* QOL: keyboard shortcuts */
    document.addEventListener('keydown', e => {
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      if(tag === 'input' || tag === 'textarea' || tag === 'select') return;
      // contenteditable was missing, so a single "h" typed in such a field
      // navigated away from the page (audit U-4).
      if(e.target && e.target.isContentEditable) return;
      if(document.activeElement && document.activeElement.isContentEditable) return;
      // Do not hijack keys while a modal is open.
      if(ael.back.classList.contains('show')) return;
      if(e.altKey || e.ctrlKey || e.metaKey) return;
      if(e.code === 'KeyH'){ showHome(); }
      if(e.code === 'KeyU'){ goProfile(); }             // U = your history
      if(e.code === 'KeyT'){ goTop(activeTop || 'best'); }   // T = top 100
      if(e.code === 'KeyR' && !e.shiftKey){ goRandom(); }    // R = random title
      if(e.code === 'KeyS' && e.shiftKey && token){ syncProgress(); toast('Syncing\u2026'); }
    });

    // Keep the comment form / privacy panel in sync with the session.
    const _renderAuthUI = renderAuthUI;
    renderAuthUI = function(){
      const out = _renderAuthUI.apply(this, arguments);
      updateCommentForm();
      renderPrivacy();
      renderLocalImport();
      paintWatchStatus(); syncWatchlist();
      socialLoaded = false;
      loadSocial();
      if(cmAnimeId) loadComments(cmAnimeId, cmAnimeName);
      return out;
    };

    renderGenreBar();
    updateCommentForm();

    window.AniWired = {
      get user(){ return user; },
      get settings(){ return settings; },
      get social(){ return social; },
      syncProgress, apiCall, readHistory, historyList, goProfile, syncWatchlist, readWatchlist,
      get historyKey(){ return storageKey(HISTORY_BASE); },
      goUser, goGenre, showGenre, loadSocial, goTop, goRandom,
      hdSetup(){ if(typeof window.__awHdSetup === 'function') window.__awHdSetup(); }
    };
  })();
