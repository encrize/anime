(function(){
    'use strict';

    /* config */
    const API_BASE  = (localStorage.getItem('aw:api') || '').replace(/\/$/, '');
    const TOKEN_KEY = 'aw:token';
    const HIST_KEY  = 'aniwired:history';   // { [animeId]: item }
    const LAST_KEY  = STORE;                // 'aniwired:last' - legacy compatibility

    let user  = null;
    let token = localStorage.getItem(TOKEN_KEY) || '';

    /* tiny HTTP helper */
    async function apiCall(path, opts){
      opts = opts || {};
      const headers = { 'Accept':'application/json' };
      if(opts.body !== undefined) headers['Content-Type'] = 'application/json';
      const useAuth = opts.auth !== false;
      if(useAuth && token) headers['Authorization'] = 'Bearer ' + token;
      const res = await fetch(API_BASE + path, {
        method: opts.method || 'GET',
        headers,
        keepalive: !!opts.keepalive,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
      });
      let data = null;
      try{ data = await res.json(); }catch(_){}
      if(res.status === 401 && useAuth && token){ setToken(''); renderAuthUI(); }
      if(!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      return data || {};
    }

    /* local history store */
    function readHistory(){
      try{ return JSON.parse(localStorage.getItem(HIST_KEY) || '{}') || {}; }catch(_){ return {}; }
    }
    function writeHistory(map){
      localStorage.setItem(HIST_KEY, JSON.stringify(map));
      const last = latestItem(map);
      if(last) localStorage.setItem(LAST_KEY, JSON.stringify(last));
      else localStorage.removeItem(LAST_KEY);
    }
    function historyList(){
      return Object.values(readHistory()).filter(Boolean).sort((a,b) => (b.ts||0) - (a.ts||0));
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
    (function migrate(){
      const map = readHistory();
      if(Object.keys(map).length) return;
      try{
        const legacy = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
        if(legacy && legacy.id != null){ legacy.id = String(legacy.id); map[legacy.id] = legacy; writeHistory(map); }
      }catch(_){}
    })();

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
    let pushTimer = 0, pendingItem = null, failedQueue = [], lastPushedSig = '';

    // Identity of a snapshot for deduplication purposes.
    const progressSig = it => JSON.stringify([
      it.id, it.idx, it.time, it.duration, (it.seen || []).length, it.quality, it.source,
    ]);

    function pushProgress(item, immediate){
      if(!token || !item) return;
      pendingItem = item;
      const flush = () => {
        pushTimer = 0;
        const it = pendingItem; pendingItem = null;
        if(!it) return;
        // Nothing actually moved since the last successful push: skip the write.
        const sig = progressSig(it);
        if(sig === lastPushedSig) return;
        lastPushedSig = sig;
        apiCall('/api/progress', { method:'PUT', body:{ item: it }, keepalive: !!immediate })
          .catch(() => { lastPushedSig = ''; failedQueue.push(it); });
      };
      if(immediate){ clearTimeout(pushTimer); pushTimer = 0; flush(); return; }
      if(pushTimer) return;
      pushTimer = setTimeout(flush, SYNC_DEBOUNCE_MS);
    }

    async function syncProgress(silent){
      if(!token) return;
      let serverItems = [];
      try{ serverItems = (await apiCall('/api/progress')).items || []; }
      catch(_){ if(!silent) toast('Could not reach the sync server'); return; }

      const map = readHistory();
      const toPush = [];
      const seenIds = {};
      for(const s of serverItems){
        s.id = String(s.id); seenIds[s.id] = true;
        const l = map[s.id];
        if(!l || (l.ts||0) <= (s.ts||0)) map[s.id] = s;
        else toPush.push(l);
      }
      for(const id in map) if(!seenIds[id]) toPush.push(map[id]);

      writeHistory(map);
      renderResume();
      renderProfile();
      if(toPush.length || failedQueue.length){
        const items = toPush.concat(failedQueue);
        failedQueue = [];
        try{ await apiCall('/api/progress/bulk', { method:'POST', body:{ items } }); }
        catch(_){ failedQueue = items; }
      }
    }

    let lastPicked = null;                         // episode index chosen in the UI

    function wrap(name, after){
      const fn = window[name];
      if(typeof fn !== 'function') return;
      window[name] = function(){
        if(typeof arguments[0] === 'number') lastPicked = arguments[0];
        const out = fn.apply(this, arguments);
        Promise.resolve(out).then(() => setTimeout(after, 100)).catch(() => setTimeout(after, 100));
        return out;
      };
    }
    wrap('selectEpisode', () => saveProgress());
    wrap('playEpisode',   () => saveProgress());
    wrap('loadKodik',     () => saveProgress());

    function playerIdx(){
      if(current.ep != null) return current.ep;
      if(lastPicked != null) return lastPicked;
      return 0;
    }
    function playerLive(){
      if(!current.title) return false;
      if(current.mode === 'kodik') return !!current.kodikLink;
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
      if(!playerLive()) return;
      const t     = current.title;
      const idx   = playerIdx();
      const ep    = (current.episodes || [])[idx];
      const kodik = current.mode === 'kodik';
      const v     = el.video;
      const prev  = readHistory()[String(t.id)];
      const same  = !!(prev && prev.idx === idx);

      // Only gate brand-new entries: a title already in the history keeps
      // updating normally, so resuming never loses your position.
      if(!prev && watchedSeconds() < WATCH_MIN) return;

      let time = (!kodik && v && isFinite(v.currentTime)) ? Math.floor(v.currentTime) : 0;
      let dur  = (!kodik && v && isFinite(v.duration))    ? Math.floor(v.duration)    : 0;
      if(kodik){
        time = kodikState.time || (same ? (prev.time || 0) : 0);
        dur  = kodikState.duration || (same ? (prev.duration || 0) : 0);
      }
      if(same && time < 3 && (prev.time || 0) > 3) time = prev.time;
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
          ? { mal:(current.malId ?? t._mal ?? null), link:(current.kodikLink || '') }
          : (same ? prev.kodik : undefined),
        seen: [idx],
        ts: Date.now()
      };
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
        v.addEventListener('loadedmetadata', () => saveProgress());
        v.addEventListener('play',   () => saveProgress());
        v.addEventListener('pause',  () => saveProgress());
        v.addEventListener('seeked', () => saveProgress());
        v.addEventListener('ended',  () => saveProgress());
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

    const kodikState = { time:0, duration:0 };
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
      current.ep = i;
      lastPicked = i;
      kodikState.time = Math.floor(startFrom || 0);
      kodikState.duration = 0;
      if(current.kodikLink){
        try{
          const u = new URL(current.kodikLink, location.href);
          u.searchParams.set('episode', String(i + 1));
          if(startFrom && startFrom > 5) u.searchParams.set('start_from', String(Math.floor(startFrom)));
          else u.searchParams.delete('start_from');
          current.kodikLink = u.toString();
          if(el.embedFrame.getAttribute('src') !== current.kodikLink) el.embedFrame.src = current.kodikLink;
        }catch(_){}
      }
      $$('.ep', el.episodes).forEach(b => b.classList.toggle('active', +b.dataset.idx === i));
      const inp = $('#kodikEp', el.episodes);
      if(inp) inp.value = String(i + 1);
      saveProgress();
      markSeenEpisodes();
    }

    // Draws the episode grid only - it never touches the player, so it is safe
    // to call again once the real episode count arrives.
    function paintKodikEpisodes(total, startIdx){
      let html = '<p class="hint">Pick the episode here so your progress is saved - dubs and subtitles are still switched inside the Kodik player.</p>';
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
      const startIdx = (resume && resume.idx != null) ? resume.idx : (hist.idx != null ? hist.idx : 0);
      paintKodikEpisodes(total, startIdx);
      if(resume && (resume.idx != null || resume.time)) setKodikEpisode(resume.idx || 0, resume.time || 0);
      else setKodikEpisode(startIdx, 0);

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
          if(src === 'kodik'){ renderKodikEpisodes(current.title); return; }
          if(typeof window.renderEpisodes === 'function' && (current.episodes || []).length){
            window.renderEpisodes();
            $$('.ep', el.episodes).forEach(b => b.classList.toggle('active', +b.dataset.idx === current.ep));
            markSeenEpisodes();
          }
        }, 0);
      });
    }

    /* Exact origin allowlist (audit S-9). The old substring test on /kodik/i
       also accepted https://kodik.attacker.com and https://evil-kodik.io.
       Keep this list in sync with frame-src in the worker's CSP. */
    const KODIK_ORIGINS = new Set([
      'https://kodikplayer.com',
      'https://kodik.info',
      'https://aniqit.com',
    ]);
    window.addEventListener('message', e => {
      if(!KODIK_ORIGINS.has(String(e.origin || ''))) return;
      let d = e.data;
      if(typeof d === 'string'){ try{ d = JSON.parse(d); }catch(_){ return; } }
      if(!d || typeof d !== 'object') return;
      const key = String(d.key || d.event || d.type || '').toLowerCase();
      const val = (d.value !== undefined ? d.value : d.data);
      const obj = (val && typeof val === 'object') ? val : {};
      const num = x => { const n = parseFloat(x); return isFinite(n) ? n : null; };
      if(/episode/.test(key)){
        const n = num(obj.episode != null ? obj.episode : (obj.value != null ? obj.value : val));
        if(n && n >= 1){ current.ep = Math.round(n) - 1; lastPicked = current.ep; kodikState.time = 0; }
      }
      if(/time|position|progress/.test(key)){
        const tt = num(obj.time != null ? obj.time : (obj.currentTime != null ? obj.currentTime : val));
        if(tt != null && tt >= 0) kodikState.time = Math.floor(tt);
      }
      if(/duration/.test(key)){
        const dd = num(obj.duration != null ? obj.duration : val);
        if(dd) kodikState.duration = Math.floor(dd);
      }
      if(current.mode === 'kodik'){
        const now = Date.now();
        if(now - kodikSaveAt > 3000){ kodikSaveAt = now; saveProgress(); }
      }
    });

    async function resumeItem(d){
      const viaKodik = d.source === 'kodik' || isKodikId(d.id);
      if(!viaKodik) return openTitle(d.id, { idx:d.idx, quality:d.quality, time:d.time });
      let t = readKodikCache(String(d.id));
      if(!t && !(d.kodik && d.kodik.mal != null)) t = await fetchAniListById(d.id);
      if(!t) t = kodikTitleFrom(d);
      if(!t._eps && d.epTotal) t._eps = d.epTotal;
      return openKodikTitle(t, { idx:(d.idx || 0), time:(d.time || 0) });
    }
    function deleteItem(id){
      removeLocal(id);
      renderResume(); renderProfile(); refreshStats();
      if(token) apiCall('/api/progress/' + encodeURIComponent(id), { method:'DELETE' }).catch(()=>{});
      toast('Removed from history');
    }

    window.addEventListener('pagehide', () => { saveProgress(); pushProgress(pendingItem || latestItem(readHistory()), true); });
    document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') saveProgress(); });
    window.addEventListener('online', () => { if(token) syncProgress(true); });
    window.addEventListener('storage', e => {
      if(e.key === HIST_KEY){ renderResume(); renderProfile(); refreshStats(); }
      if(e.key === TOKEN_KEY){ token = localStorage.getItem(TOKEN_KEY) || ''; bootSession(); }
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

      const list = await fetchGenreTitles(genre);
      if(activeGenre !== genre) return;                 // user navigated away meanwhile
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
      if(activeTop !== k) return;                        // user navigated away meanwhile
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
          '<p class="cm-body">' + escapeHtml(c.body) + '</p>' +
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
        await apiCall('/api/comments', { method:'POST', body:{ animeId:cmAnimeId, animeName:cmAnimeName, body:text } });
        cmEl.input.value = '';
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
          '</div><p class="cm-body">' + escapeHtml(c.body) + '</p></div>' +
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

    let settings = { historyPublic:true, profilePublic:true };
    const pv = { box:$('#pfPrivacy'), history:$('#pvHistory'), profile:$('#pvProfile'), note:$('#pvNote') };

    function renderPrivacy(){
      if(!pv.box) return;
      const signed = !!(token && user);
      pv.box.classList.toggle('hidden', !signed);
      if(!signed) return;
      pv.history.checked = !!settings.historyPublic;
      pv.profile.checked = !!settings.profilePublic;
      pv.note.innerHTML = settings.profilePublic
        ? 'Your public page: <code>' + escapeHtml(location.origin + '/u/' + (user.username || '')) + '</code>'
        : 'Your profile is hidden - visitors only see your nickname.';
    }

    async function savePrivacy(){
      if(!(token && user)) return;
      const next = { historyPublic: !!pv.history.checked, profilePublic: !!pv.profile.checked };
      pv.history.disabled = pv.profile.disabled = true;
      try{
        const d = await apiCall('/api/settings', { method:'PUT', body: next });
        settings = d.settings || next;
        toast('Privacy settings saved');
      }catch(err){
        toast(err.message || 'Could not save the privacy settings');
      }finally{
        pv.history.disabled = pv.profile.disabled = false;
        renderPrivacy();
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
        settings = { historyPublic:true, profilePublic:true };
        renderAuthUI();
        toast('Signed out everywhere - progress stays on this device');
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
        setToken('');
        settings = { historyPublic:true, profilePublic:true };
        renderAuthUI();
        accSay(acc.delMsg, 'Account deleted', 'ok');
        toast('Account deleted - local history stays on this device');
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

    function renderProfile(){
      if(!pf.grid) return;
      refreshStats();
      renderPrivacy();
      renderAccount();

      const signed = !!(token && user);
      const who    = signed ? (user.displayName || user.username || 'user') : 'Guest';
      pf.name.textContent   = who;
      pf.avatar.textContent = who.slice(0,1).toUpperCase();
      pf.note.textContent   = signed
        ? '@' + (user.username || who)
        : 'Signed out - history is stored on this device only';

      const q = (pf.filter.value || '').trim().toLowerCase();
      let list = historyList().filter(it => !q || String(it.name).toLowerCase().indexOf(q) !== -1);
      const sort = pf.sort.value;
      if(sort === 'title')    list.sort((a,b) => String(a.name).localeCompare(String(b.name)));
      if(sort === 'progress') list.sort((a,b) => pctOf(a) - pctOf(b));

      pf.empty.classList.toggle('hidden', list.length > 0);
      if(!list.length){
        pf.grid.innerHTML = '';
        pf.empty.querySelector('b').textContent = q ? 'No matches' : 'Nothing here yet';
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
      if(!historyList().length) return;
      if(!confirm('Clear the whole watch history?')) return;
      localStorage.removeItem(HIST_KEY);
      localStorage.removeItem(LAST_KEY);
      renderResume(); renderProfile(); refreshStats();
      if(token){
        try{ await apiCall('/api/progress', { method:'DELETE' }); }catch(_){}
      }
      toast('Watch history cleared');
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
      document.title = 'AniWired - My history';
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
      pf.section.classList.add('hidden');
      hidePub();
      pushRoute(pathForTitle(id), { view:'title', id:String(id) });
      document.title = 'AniWired - loading\u2026';
      const p = _openTitle(id, resume);
      Promise.resolve(p).then(() => {
        if(current.title) document.title = titleName(current.title) + ' - AniWired';
        markSeenEpisodes();
        loadComments(String(id), current.title ? titleName(current.title) : '');
      }).catch(()=>{});
      return p;
    };

    if(typeof openKodikTitle === 'function'){
      const _openKodik = openKodikTitle;
      openKodikTitle = function(t, resume){
        pf.section.classList.add('hidden');
        hidePub();
        if(t && t.id != null){
          kodikCache[String(t.id)] = t;
          try{ sessionStorage.setItem('aw:kodik:' + t.id, JSON.stringify(t)); }catch(_){}
          pushRoute(pathForTitle(t.id), { view:'title', id:String(t.id), kodik:true });
          document.title = titleName(t) + ' - AniWired';
        }
        const p = _openKodik(t);
        Promise.resolve(p)
          .then(() => {
            kodikState.time = 0; kodikState.duration = 0; renderKodikEpisodes(t, resume);
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
          else _openTitle(id);
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

    if(/^\/(title|profile|genre|u|top|random)\b/.test(location.pathname)) applyRoute();
    else history.replaceState({ view:'home' }, '', location.pathname + location.search);

    const ael = {
      back:$('#authBack'), close:$('#authClose'), guest:$('#authGuest'), userBox:$('#authUser'),
      tabLogin:$('#tabLogin'), tabRegister:$('#tabRegister'), form:$('#authForm'), warn:$('#authWarn'),
      name:$('#authName'), password:$('#authPassword'), submit:$('#authSubmit'),
      msg:$('#authMsg'), title:$('#authTitle'), sub:$('#authSub'),
      nameLabel:$('#authNameLabel'), avatar:$('#authAvatar'), logout:$('#authLogout'),
      profileBtn:$('#authProfile'), nav:$('#navAuth'), navProfile:$('#navProfile')
    };
    let mode = 'login';

    function setToken(t){
      token = t || '';
      if(token) localStorage.setItem(TOKEN_KEY, token);
      else { localStorage.removeItem(TOKEN_KEY); user = null; }
    }
    function setMsg(text, ok){
      ael.msg.textContent = text || '';
      ael.msg.classList.toggle('ok', !!ok);
    }
    function setMode(next){
      mode = next;
      ael.tabLogin.classList.toggle('active', mode === 'login');
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
    function openAuth(){ ael.back.classList.add('show'); if(!user) setTimeout(() => ael.name.focus(), 60); }
    function closeAuth(){ ael.back.classList.remove('show'); setMsg(''); }

    ael.nav.onclick = openAuth;
    ael.nav.addEventListener('keydown', e => { if(e.code === 'Enter' || e.code === 'Space'){ e.preventDefault(); openAuth(); } });
    ael.close.onclick = closeAuth;
    ael.back.addEventListener('click', e => { if(e.target === ael.back) closeAuth(); });
    document.addEventListener('keydown', e => { if(e.code === 'Escape' && ael.back.classList.contains('show')) closeAuth(); });
    ael.tabLogin.onclick    = () => setMode('login');
    ael.tabRegister.onclick = () => setMode('register');
    ael.profileBtn.onclick  = () => { closeAuth(); goProfile(); };
    if(ael.navProfile) ael.navProfile.onclick = () => goProfile();

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
        setToken(data.token); user = data.user;
        settings = data.settings || { historyPublic:true, profilePublic:true };
        setMsg(mode === 'login' ? 'Signed in' : 'Account created', true);
        renderAuthUI();
        await syncProgress();
        toast('Signed in as ' + (user.displayName || user.username));
        setTimeout(closeAuth, 450);
        ael.password.value = '';
      }catch(err){ setMsg(err.message || 'Something went wrong'); }
      finally{ ael.submit.disabled = false; }
    });

    ael.logout.onclick = () => {
      setToken('');
      settings = { historyPublic:true, profilePublic:true };
      renderAuthUI();
      closeAuth();
      toast('Signed out - progress stays on this device');
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
          user = me.user;
          if(me.settings) settings = me.settings;
          renderAuthUI();
          await syncProgress(true);
        }catch(_){ setToken(''); renderAuthUI(); }
      } else {
        renderAuthUI();
      }
    }
    bootSession();

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
      syncProgress, apiCall, readHistory, historyList, goProfile,
      goUser, goGenre, showGenre, loadSocial, goTop, goRandom,
      hdSetup(){ if(typeof window.__awHdSetup === 'function') window.__awHdSetup(); }
    };
  })();
