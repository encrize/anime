const API  = 'https://anilibria.top/api/v1';
  const SITE = 'https://anilibria.top';
  const STORE = 'aniwired:last';

  const TMDB_KEY = '7b19d2d4ace89674cb0238eeff2f89b2';

  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];

  const el = {
    searchInput:$('#searchInput'), results:$('#results'), resultsTitle:$('#resultsTitle'),
    homeState:$('#homeState'), home:$('#home'), detail:$('#detail'), backBtn:$('#backBtn'),
    resumeSlot:$('#resumeSlot'), detailState:$('#detailState'),
    poster:$('#dPoster'), title:$('#dTitle'), sub:$('#dSub'), chips:$('#dChips'),
    desc:$('#dDesc'), teamSel:$('#teamSel'), episodes:$('#episodes'),
    playerWrap:$('#playerWrap'), video:$('#video'),
    timeline:$('#timeline'), playBtn:$('#playBtn'), muteBtn:$('#muteBtn'),
    volume:$('#volume'), timeLabel:$('#timeLabel'), subBtn:$('#subBtn'),
    qualitySel:$('#qualitySel'), fsBtn:$('#fsBtn'), ambientBtn:$('#ambientBtn'),
    sourceTabs:$('#sourceTabs'), embedWrap:$('#embedWrap'), embedFrame:$('#embedFrame'),
    logo:$('#logoBtn'), pipBtn:$('#pipBtn'), rewBtn:$('#rewBtn'), fwdBtn:$('#fwdBtn'),
    miniReturn:$('#miniReturn'), mrPoster:$('#mrPoster'), mrTitle:$('#mrTitle'),
    mrClose:$('#mrClose'), toast:$('#toast'),
    resultsSub:$('#resultsSub'), navHome:$('#navHome'), navNew:$('#navNew'),
    rowHead:$('#rowHead'), railPrev:$('#railPrev'), railNext:$('#railNext'),
    hero:$('#hero'), heroBg:$('#heroBg'), heroBgB:$('#heroBgB'), heroTitle:$('#heroTitle'), heroMeta:$('#heroMeta'),
    heroDesc:$('#heroDesc'), heroPlay:$('#heroPlay'), heroDetails:$('#heroDetails'),
    heroPrev:$('#heroPrev'), heroNext:$('#heroNext'), heroDots:$('#heroDots'),
    navHd:$('#navHd'), tmdbBar:$('#tmdbBar'), tmdbInput:$('#tmdbInput'),
    tmdbSave:$('#tmdbSave'), tmdbDismiss:$('#tmdbDismiss'),
  };

  /* state */
  let hls = null;
  let catalogGeneration = 0;
  let titleRequest = 0, kodikRequest = 0, streamRequest = 0, streamReady = null;
  let current = { title:null, host:'', episodes:[], ep:null, quality:'fhd', mode:'libria', kodikLink:undefined, malId:undefined };

  const ICON = {
    play:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    vol:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3z"/><path d="M16 8a5 5 0 010 8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    mute:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2"/></svg>',
    fs:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    ambient:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>',
    pip:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/></svg>',
    rew:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M11 18L3 12l8-6v12z"/><path d="M21 18l-8-6 8-6v12z"/></svg>',
    fwd:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M13 18l8-6-8-6v12z"/><path d="M3 18l8-6-8-6v12z"/></svg>',
  };

  /* API helpers */
  async function api(path){
    const r = await fetch(API + path, { headers:{ Accept:'application/json' } });
    if(!r.ok) throw new Error('API ' + r.status);
    return r.json();
  }
  const pickList      = d => Array.isArray(d) ? d : (d && Array.isArray(d.data)) ? d.data : [];
  const searchTitles  = q  => api('/app/search/releases?query=' + encodeURIComponent(q)).then(pickList);
  const updatesTitles = () => api('/anime/releases/latest?limit=24').then(pickList);
  const getTitle      = id => api('/anime/releases/' + id);
  const posterUrl     = t  => { const p = t.poster && (t.poster.src || (t.poster.optimized && t.poster.optimized.src)); return p ? (/^https?:/.test(p) ? p : SITE + p) : ''; };

  function showHome(keepPlayer){
    el.detail.classList.add('hidden');
    el.home.classList.remove('hidden');
    if(!keepPlayer){
      saveProgress(); el.video.pause();
      ++kodikRequest; ++titleRequest;
      teardownPlayer();
      el.embedWrap.classList.add('hidden');
      el.embedFrame.src = 'about:blank';
    }
    updateMiniReturn();
    window.scrollTo({ top:0, behavior:'instant' });
  }
  function showDetail(){
    document.querySelector('#cfMore')?.classList.add('hidden');
    ++catalogGeneration;
    el.home.classList.add('hidden');
    el.detail.classList.remove('hidden');
    updateMiniReturn();
    window.scrollTo({ top:0, behavior:'instant' });
  }

  function isPlayerLive(){
    const libriaLive = current.mode === 'libria' && current.ep != null && !el.playerWrap.classList.contains('hidden');
    const kodikLive  = current.mode === 'kodik' && !!current.kodikLink && !el.embedWrap.classList.contains('hidden');
    return libriaLive || kodikLive;
  }
  function updateMiniReturn(){
    const onHome = !el.home.classList.contains('hidden');
    if(onHome && isPlayerLive() && current.title){
      el.mrPoster.src = posterUrl(current.title);
      el.mrTitle.textContent = titleName(current.title);
      el.miniReturn.classList.add('show');
    } else {
      el.miniReturn.classList.remove('show');
    }
  }

  /* Featured hero carousel */
  let heroItems = [], heroIdx = 0, heroTimer = 0, heroFrontIsB = false;
  const heroBgCache = {};
  const getTmdbKey = () => localStorage.getItem('tmdb:key') || TMDB_KEY || '';
  function baseName(s){
    let x = String(s || '').trim();
    x = x.replace(/\s*[:-]\s*$/, '');
    // Also strips Russian season suffixes ("2 сезон") used in AniLibria titles.
    x = x.replace(/\s+(season\s*\d+|\d+(?:st|nd|rd|th)\s*season|part\s*\d+|cour\s*\d+|сезон\s*\d+|\d+\s*сезон)\s*$/i, '');
    x = x.replace(/\s+(?:II|III|IV|V|VI|VII|VIII|IX|X)\s*$/, '');
    x = x.replace(/\s+\d+\s*$/, '');
    return x.trim();
  }
  function nameVariants(t){
    const raw = [t.name && t.name.english, t.name && t.name.romaji, t.name && t.name.main, t.alias, titleName(t)].filter(Boolean);
    const out = [];
    for(const n of raw){ out.push(n); const b = baseName(n); if(b && b !== n) out.push(b); }
    return [...new Set(out)].slice(0, 5);
  }
  async function tmdbFindHit(names){
    const tk = getTmdbKey();
    if(!tk) return null;
    for(const name of names){
      try{
        const r = await fetch('https://api.themoviedb.org/3/search/multi?include_adult=false&query=' + encodeURIComponent(name) + '&api_key=' + encodeURIComponent(tk));
        if(!r.ok) continue;
        const j = await r.json();
        const hits = (j.results || []).filter(x => (x.media_type === 'tv' || x.media_type === 'movie') && (x.poster_path || x.backdrop_path))
          .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
        if(hits[0]) return hits[0];
      }catch(e){}
    }
    return null;
  }
  async function tmdbBackdrop(names){
    const hit = await tmdbFindHit(names);
    if(!hit) return null;
    const tk = getTmdbKey();
    try{
      const ir = await fetch('https://api.themoviedb.org/3/' + hit.media_type + '/' + hit.id + '/images?include_image_language=en,null&api_key=' + encodeURIComponent(tk));
      if(ir.ok){
        const ij = await ir.json();
        const bds = ij.backdrops || [];
        if(bds.length){
          const textless = bds.filter(b => b.iso_639_1 === null);
          const pick = (textless.length ? textless : bds).sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))[0];
          if(pick && pick.file_path) return 'https://image.tmdb.org/t/p/original' + pick.file_path;
        }
      }
    }catch(e){}
    return hit.backdrop_path ? 'https://image.tmdb.org/t/p/original' + hit.backdrop_path : null;
  }
  async function bestBackdrop(t){
    const key = (t.id != null ? 'id' + t.id : titleName(t));
    if(heroBgCache[key]) return heroBgCache[key];
    const fallback = posterUrl(t);
    const s = (t.name && (t.name.english || t.name.romaji || t.name.main)) || t.alias || titleName(t);
    const tm = await tmdbBackdrop(nameVariants(t));
    if(tm){ heroBgCache[key] = tm; return tm; }
    if(t._banner){ heroBgCache[key] = t._banner; return t._banner; }
    try{
      const r = await fetch('https://graphql.anilist.co', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
        body: JSON.stringify({ query:'query($s:String){Media(search:$s,type:ANIME){bannerImage coverImage{extraLarge}}}', variables:{ s } })
      });
      const j = await r.json();
      const m = j.data && j.data.Media;
      const url = (m && (m.bannerImage || (m.coverImage && m.coverImage.extraLarge))) || fallback;
      heroBgCache[key] = url;
      return url;
    }catch(e){ heroBgCache[key] = fallback; return fallback; }
  }
  function buildHero(list){
    heroItems = (list || []).filter(t => posterUrl(t)).slice(0, 6);
    if(!heroItems.length){ hideHero(); return; }
    el.hero.classList.remove('hidden');
    el.heroDots.innerHTML = heroItems.map((_, i) => '<span class="hd' + (i===0?' active':'') + '" data-i="' + i + '"></span>').join('');
    $$('.hd', el.heroDots).forEach(d => d.onclick = () => { setHero(+d.dataset.i); restartHeroTimer(); });
    setHero(0);
    restartHeroTimer();
  }
  function setHero(i){
    if(!heroItems.length) return;
    heroIdx = (i + heroItems.length) % heroItems.length;
    const t = heroItems[heroIdx];
    const slide = heroIdx;
    bestBackdrop(t).then(url => {
      if(heroIdx !== slide || !url) return;
      const img = new Image();
      const apply = () => {
        if(heroIdx !== slide) return;
        const back  = heroFrontIsB ? el.heroBg : el.heroBgB;
        const front = heroFrontIsB ? el.heroBgB : el.heroBg;
        back.style.backgroundImage = 'url(' + url + ')';
        back.classList.add('show');
        front.classList.remove('show');
        heroFrontIsB = !heroFrontIsB;
      };
      img.onload = apply; img.onerror = apply;
      img.src = url;
    });
    el.heroTitle.textContent = titleName(t);
    const genres = (t.genres || []).slice(0,3).map(g => typeof g === 'string' ? g : g.name).filter(Boolean).join(', ');
    el.heroMeta.textContent = [ (t.type && (t.type.description || t.type.value)), releaseYear(t), genres ].filter(Boolean).join('   •   ');
    el.heroDesc.textContent = (t.description || '').replace(/\s+/g, ' ').trim();
    $$('.hd', el.heroDots).forEach((d, idx) => d.classList.toggle('active', idx === heroIdx));
    const open = () => t._kodik ? openKodikTitle(t) : openTitle(t.id);
    el.heroPlay.onclick = open;
    el.heroDetails.onclick = open;
  }
  function restartHeroTimer(){ clearInterval(heroTimer); heroTimer = setInterval(() => setHero(heroIdx + 1), 6500); }
  function hideHero(){ el.hero.classList.add('hidden'); clearInterval(heroTimer); }
  el.heroPrev.onclick = () => { setHero(heroIdx - 1); restartHeroTimer(); };
  el.heroNext.onclick = () => { setHero(heroIdx + 1); restartHeroTimer(); };

  const tmdbPosterCache = {};
  async function tmdbPoster(names){
    if(!getTmdbKey()) return null;
    const ck = names.join('|');
    if(tmdbPosterCache[ck] !== undefined) return tmdbPosterCache[ck];
    const hit = await tmdbFindHit(names);
    const u = (hit && hit.poster_path) ? 'https://image.tmdb.org/t/p/w500' + hit.poster_path : null;
    tmdbPosterCache[ck] = u;
    return u;
  }
  const cardObserver = ('IntersectionObserver' in window) ? new IntersectionObserver((entries, obs) => {
    for(const en of entries){
      if(!en.isIntersecting) continue;
      const c = en.target; obs.unobserve(c);
      if(!getTmdbKey() || !c._art) continue;
      tmdbPoster(c._art).then(url => {
        if(!url) return;
        const img = new Image();
        img.onload = () => {
          const th = c.querySelector('.thumb');
          if(!th) return;
          th.classList.add('swapping');               // brief dim while swapping
          setTimeout(() => { th.style.backgroundImage = 'url(' + url + ')'; th.classList.remove('swapping'); }, 120);
        };
        img.src = url;                                  // preload first, no broken flash
      });
    }
  }, { rootMargin: '300px' }) : null;

  /* render results grid */
  function renderResults(list){
    if(window.__awCatalogRendered) window.__awCatalogRendered();
    el.results.innerHTML = '';
    if(!list.length){ el.results.innerHTML = '<p class="hint">Nothing found.</p>'; return; }
    const frag = document.createDocumentFragment();
    for(const t of list){
      const c = document.createElement('article');
      c.className = 'card';
      const link = document.createElement('a'); link.className = 'card-link';
      link.href = '/title/' + encodeURIComponent(t.id);
      const thumb = document.createElement('span'); thumb.className = 'thumb';
      const poster = safePoster(posterUrl(t));
      if(poster) thumb.style.backgroundImage = 'url(' + JSON.stringify(poster) + ')';
      const meta = document.createElement('div'); meta.className = 'meta';
      const heading = document.createElement('h3'); heading.textContent = titleName(t);
      const info = document.createElement('span');
      info.textContent = (t.type ? (t.type.description || t.type.value || '') : '') + (releaseYear(t) ? ' • ' + releaseYear(t) : '');
      meta.append(heading, info); link.append(thumb, meta); c.append(link);
      if(window.__awAddToList){
        const save = document.createElement('button'); save.type = 'button'; save.className = 'card-save';
        save.textContent = '+ My list'; save.setAttribute('aria-label', 'Add ' + titleName(t) + ' to My list');
        save.onclick = () => { window.__awAddToList(t); save.textContent = '✓ In My list'; }; c.append(save);
      }
      link.onclick = e => {
        if(e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); ++catalogGeneration;
        t._kodik ? openKodikTitle(t) : openTitle(t.id);
      };
      frag.appendChild(c);
    }
    el.results.appendChild(frag);
  }

  /* open a title detail */
  async function openTitle(id, resume){
    const request = ++titleRequest; ++kodikRequest;
    saveProgress(); teardownPlayer(); el.video.pause();
    el.embedWrap.classList.add('hidden'); el.embedFrame.src = 'about:blank';
    current.title = null; current.ep = null; current.kodikLink = undefined;
    showDetail();
    el.playerWrap.classList.add('hidden');
    el.detailState.classList.remove('hidden');
    el.detailState.innerHTML = '<div class="spinner"></div>Loading…';
    try{
      const t = await getTitle(id);
      if(request !== titleRequest) return;
      current.title = t;
      current.episodes = Array.isArray(t.episodes) ? t.episodes : [];
      current.kodikLink = undefined; current.malId = undefined; current.ep = null;
      setKodikOnlyTabs(false);
      setMode('libria');
      el.detailState.classList.add('hidden');

      el.poster.src = posterUrl(t);
      el.title.textContent = titleName(t);
      el.sub.textContent = [t.name && t.name.english, t.type && (t.type.description || t.type.value), releaseYear(t)].filter(Boolean).join(' • ');
      el.desc.textContent = (t.description || '').replace(/\n{3,}/g, '\n\n');

      el.chips.innerHTML = '';
      (t.genres || []).slice(0,6).forEach(g => addChip(typeof g === 'string' ? g : g.name, true));
      if(t.publish_day && t.publish_day.description) addChip(t.publish_day.description);

      el.teamSel.innerHTML = '';
      // Voice actors are tagged in Russian ("озвучка" = voice acting) by AniLibria.
      const voices = (t.members || [])
        .filter(m => m.role && /озвуч|voic|dub/i.test(m.role.description || m.role.value || ''))
        .map(m => m.nickname || (m.user && m.user.name) || '')
        .filter(Boolean);
      el.teamSel.innerHTML = '<option>' + escapeHtml(voices.length ? voices.join(', ') : 'AniLibria') + '</option>';

      renderEpisodes(resume);
    }catch(e){
      if(request === titleRequest) el.detailState.textContent = 'Loading error: ' + e.message;
    }
  }

  function addChip(text, isGenre){
    const c = document.createElement('span');
    c.className = 'chip' + (isGenre ? ' chip-genre' : '');
    c.textContent = text;
    if(isGenre && text){
      c.title = 'Browse "' + text + '"';
      c.setAttribute('role', 'button');
      c.tabIndex = 0;
      const go = () => { if(typeof window.__awGenre === 'function') window.__awGenre(text); };
      c.onclick = go;
      c.onkeydown = e => { if(e.code === 'Enter' || e.code === 'Space'){ e.preventDefault(); go(); } };
    }
    el.chips.appendChild(c);
  }

  /* The real episode count of a release. AniLibria only lists the episodes it
     has actually dubbed, so a long-running show (One Piece) looks like it has
     4 episodes. The release object still reports the true total, so read it
     and tell people where the rest of the episodes are. */
  function totalEpisodesOf(t){
    if(!t) return 0;
    const cand = [t._epsTotal, t.episodes_total, t.episodes_count, t.total_episodes,
                  t.count_episodes, t._eps];
    for(const c of cand){ const n = parseInt(c, 10); if(n > 0) return n; }
    return Array.isArray(t.episodes) ? t.episodes.length : 0;
  }

  /* episodes list */
  function renderEpisodes(resume){
    el.episodes.innerHTML = '';
    if(!current.episodes.length){ el.episodes.innerHTML='<p class="hint">Episodes unavailable.</p>'; return; }
    paintEpisodeNote(totalEpisodesOf(current.title));
    current.episodes.forEach((ep, i) => {
      const b = document.createElement('button');
      b.className='ep'; b.dataset.idx = i;
      b.textContent = 'Episode ' + (ep.ordinal != null ? ep.ordinal : (i+1));
      b.onclick = () => selectEpisode(i);
      el.episodes.appendChild(b);
    });
    if(resume && resume.idx != null && current.episodes[resume.idx]){
      playEpisode(resume.idx, resume.quality, resume.time);
    }
    // The real total arrives from AniList a moment later.
    const t0 = current.title;
    resolveEpisodeTotal(t0).then(n => {
      if(current.title === t0 && current.mode !== 'kodik') paintEpisodeNote(Math.max(n, totalEpisodesOf(t0)));
    }).catch(()=>{});
  }

  function paintEpisodeNote(total){
    const old = document.getElementById('epNote');
    if(old) old.remove();
    if(!(total > current.episodes.length)) return;
    const note = document.createElement('p');
    note.id = 'epNote';
    note.className = 'hint';
    note.style.width = '100%';
    note.textContent = 'AniLibria dubbed ' + current.episodes.length + ' of ' + total +
      ' episodes. Switch to the Kodik tab above for the full run.';
    el.episodes.insertBefore(note, el.episodes.firstChild);
  }

  function qualitiesOf(ep){
    const map = [ ['hls_1080','1080p'], ['hls_720','720p'], ['hls_480','480p'] ];
    return map.filter(p => ep[p[0]]).map(p => ({ key:p[0], label:p[1] }));
  }
  const streamUrl = (ep, q) => ep[q];

  /* hls.js is fetched on first use instead of on every page load (audit P-2).
     Point HLS_SRC at '/vendor/hls.min.js' once the file is self-hosted; that
     also removes the last third-party script origin from the CSP (audit S-5). */
  const HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
  let hlsPromise = null;
  function loadHls(){
    if(window.Hls) return Promise.resolve();
    if(hlsPromise) return hlsPromise;
    hlsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HLS_SRC;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = () => { hlsPromise = null; reject(new Error('hls.js failed to load')); };
      document.head.appendChild(s);
    });
    return hlsPromise;
  }

  /* load + play a stream via hls.js */
  async function loadStream(url, seekTo){
    teardownPlayer();
    const request = streamRequest;
    const v = el.video;
    // Safari plays HLS natively, so it never needs the library at all.
    if(!v.canPlayType('application/vnd.apple.mpegurl') && !window.Hls){
      try{ await loadHls(); }
      catch(_){
        el.detailState.classList.remove('hidden');
        el.detailState.textContent = 'Could not load the video player. Check your connection and try again.';
        return;
      }
    }
    if(request !== streamRequest || current.mode !== 'libria') return;
    if(v.canPlayType('application/vnd.apple.mpegurl')){
      v.src = url; // native HLS (Safari)
    } else if(window.Hls && Hls.isSupported()){
      hls = new Hls({ maxBufferLength:30, capLevelToPlayerSize:true });
      hls.loadSource(url);
      hls.attachMedia(v);
    } else {
      el.detailState.classList.remove('hidden');
      el.detailState.textContent = 'HLS is not supported in this browser.';
      return;
    }
    const onReady = () => {
      if(request !== streamRequest) return;
      if(seekTo) v.currentTime = seekTo;
      current.libriaRestoring = false;
      saveProgress();
      v.play().catch(()=>{});
      v.removeEventListener('loadedmetadata', onReady);
    };
    streamReady = onReady;
    v.addEventListener('loadedmetadata', onReady, { once:true });
  }

  function teardownPlayer(){
    ++streamRequest;
    if(streamReady){ el.video.removeEventListener('loadedmetadata', streamReady); streamReady = null; }
    if(hls){ hls.destroy(); hls=null; }
    if(document.pictureInPictureElement){ document.exitPictureInPicture().catch(()=>{}); }
    if(typeof stopAmbient === 'function') stopAmbient(false);
  }

  /* Picture-in-Picture */
  async function enterPip(){
    const v = el.video;
    if(current.mode !== 'libria' || el.playerWrap.classList.contains('hidden')) return false;
    if(!document.pictureInPictureEnabled || v.disablePictureInPicture) return false;
    if(document.pictureInPictureElement) return true;
    try{ if(v.readyState >= 1){ await v.requestPictureInPicture(); return true; } }catch(e){}
    return false;
  }
  async function togglePip(){
    try{
      if(document.pictureInPictureElement){ await document.exitPictureInPicture(); }
      else { const ok = await enterPip(); if(!ok) toast('Picture-in-Picture is not available for this source'); }
    }catch(e){ toast('Couldn\'t enable Picture-in-Picture'); }
  }

  /* tiny toast helper */
  let toastTimer = 0;
  function toast(msg){
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  /* play a specific episode */
  function playEpisode(idx, quality, seekTo){
    saveProgress();
    const ep = current.episodes[idx];
    if(!ep) return;
    el.video.pause();
    current.libriaRestoring = true;
    el.video.removeAttribute('src'); el.video.load();
    current.ep = idx;
    current.mode = 'libria';
    el.embedWrap.classList.add('hidden'); el.embedFrame.src = 'about:blank';
    $$('.src-tab', el.sourceTabs).forEach(b => b.classList.toggle('active', b.dataset.src === 'libria'));
    const qs = qualitiesOf(ep);
    if(!qs.length){ alert('No video stream for this episode.'); return; }
    current.quality = (quality && qs.some(q=>q.key===quality)) ? quality : qs[0].key;

    el.qualitySel.innerHTML = qs.map(q => '<option value="'+q.key+'"'+(q.key===current.quality?' selected':'')+'>'+q.label+'</option>').join('');

    $$('.ep', el.episodes).forEach(b => b.classList.toggle('active', +b.dataset.idx === idx));

    el.playerWrap.classList.remove('hidden');
    loadStream(streamUrl(ep, current.quality), seekTo);
    saveProgress();
  }

  /* switch quality, keep position */
  el.qualitySel.onchange = () => {
    const ep = current.episodes[current.ep];
    const t = el.video.currentTime;
    current.libriaRestoring = true;
    current.quality = el.qualitySel.value;
    loadStream(streamUrl(ep, current.quality), t);
    saveProgress();
  };

  function selectEpisode(i){ current.mode === 'kodik' && window.__awSetKodikEpisode ? window.__awSetKodikEpisode(i, 0) : playEpisode(i); }

  function setMode(mode){
    if(current.mode !== mode) saveProgress();
    current.mode = mode;
    $$('.src-tab', el.sourceTabs).forEach(b => b.classList.toggle('active', b.dataset.src === mode));
    if(mode === 'kodik') return loadKodik();
    ++kodikRequest;
    el.embedWrap.classList.add('hidden'); el.embedFrame.src = 'about:blank';
    if(current.ep != null) playEpisode(current.ep);
  }

  // Same-origin proxy in worker/worker.js. kodikapi.com and kodik-add.com send
  // no CORS headers, so every direct browser call to them fails.
  // Deliberately a plain relative path: the API_BASE override lives in a later
  // script block, and touching it from here would risk a temporal-dead-zone
  // ReferenceError that would take down this whole script.
  const KODIK_PROXY = '/api/kodik';
  const KODIK_PLAYER = 'https://kodikplayer.com';

  async function resolveMalId(t){
    if(current.malId !== undefined) return current.malId;
    const s = (t.name && (t.name.english || t.name.romaji || t.name.main)) || t.alias || titleName(t);
    try{
      const r = await fetch('https://graphql.anilist.co', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
        body: JSON.stringify({ query:'query($s:String){Media(search:$s,type:ANIME){idMal}}', variables:{ s } })
      });
      const j = await r.json();
      const id = (j.data && j.data.Media && j.data.Media.idMal) || null;
      if(current.title === t) current.malId = id;
      return id;
    }catch(e){ if(current.title === t) current.malId = null; return null; }
  }

  /* Neither source knows how many episodes a show really has: AniLibria lists
     only what it dubbed, and Kodik reports nothing at all. AniList does, so ask
     it once per title and cache the answer on the title object. */
  async function resolveEpisodeTotal(t){
    if(!t) return 0;
    if(t._epsTotal != null) return t._epsTotal;
    const mal = (t._mal != null ? t._mal : (current.title === t ? current.malId : null));
    const s = (t.name && (t.name.english || t.name.romaji || t.name.main)) || t.alias || titleName(t);
    const body = (mal != null && mal !== undefined)
      ? { query:'query($m:Int){Media(idMal:$m,type:ANIME){episodes nextAiringEpisode{episode}}}', variables:{ m:mal } }
      : { query:'query($s:String){Media(search:$s,type:ANIME){episodes nextAiringEpisode{episode}}}', variables:{ s } };
    try{
      const r = await fetch('https://graphql.anilist.co', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      const m = j.data && j.data.Media;
      const next = m && m.nextAiringEpisode && m.nextAiringEpisode.episode;
      t._epsTotal = (m && m.episodes) || ((next && next > 1) ? next - 1 : 0) || 0;
    }catch(_){ t._epsTotal = 0; }
    if(t._epsTotal > (t._eps || 0)) t._eps = t._epsTotal;
    return t._epsTotal;
  }
  window.__awEpsTotal = resolveEpisodeTotal;

  async function kodikToken(){
    // A manually pasted token still wins, so nothing changes for existing users.
    let tok = localStorage.getItem('kodik:token');
    if(tok) return tok;
    // kodik-add.com sends no CORS headers, so the browser can never read that
    // script itself. The Worker fetches it server-side, where CORS does not
    // apply, and returns just the token.
    try{
      const r = await fetch(KODIK_PROXY + '/token');
      if(r.ok){
        const j = await r.json();
        if(j && j.token){ localStorage.setItem('kodik:token', j.token); return j.token; }
      }
    }catch(e){ }
    return null;
  }

  function askKodikToken(){
    el.embedWrap.classList.add('hidden');
    el.detailState.classList.remove('hidden');
    el.detailState.innerHTML =
      '<p style="margin-bottom:12px">The Kodik source needs a free API token. ' +
      'Paste it once - it will be saved locally (localStorage).</p>' +
      '<input id="kodikTokenInput" class="ui" style="min-width:280px" placeholder="Kodik API token" /> ' +
      '<button id="kodikTokenSave" class="src-tab active">Save</button>';
    $('#kodikTokenSave').onclick = () => {
      const val = $('#kodikTokenInput').value.trim();
      if(!val) return;
      localStorage.setItem('kodik:token', val);
      loadKodik();
    };
  }

  /* Goes through our own Worker instead of kodikapi.com directly: that host
     sends no CORS headers, so the direct call always failed with a bare
     "NetworkError" and no public CORS proxy is needed any more. */
  async function searchKodik(token, t){
    const name = (t.name && (t.name.english || t.name.main)) || t.alias || titleName(t);
    const params = new URLSearchParams({ title: name });
    const r = await fetch(KODIK_PROXY + '/search?' + params.toString());
    if(!r.ok){
      let msg = 'Kodik ' + r.status;
      try{ const j = await r.json(); if(j && j.error) msg = j.error; }catch(_){ }
      throw new Error(msg);
    }
    const j = await r.json();
    return Array.isArray(j.results) ? j.results : [];
  }

  function pickKodik(results){
    if(!results.length) return null;
    return results.find(x => x.translation && x.translation.type === 'subtitles') || results[0];
  }

  /* Apply the selection at the moment the async player lookup completes. */
  function withKodikEpisode(link){
    return AWPlayer.playerUrl(link, current.kodikState || { idx:current.ep || 0, time:0 });
  }

  async function loadKodik(){
    const request = ++kodikRequest, title = current.title;
    const valid = () => request === kodikRequest && current.title === title && current.mode === 'kodik';
    if(window.__awEnsureKodik) window.__awEnsureKodik(title);
    el.video.pause(); teardownPlayer();
    el.playerWrap.classList.add('hidden');
    const mount = link => {
      if(!valid()) return;
      current.kodikLink = withKodikEpisode(link);
      el.detailState.classList.add('hidden');
      el.embedWrap.classList.remove('hidden');
      if(el.embedFrame.getAttribute('src') !== current.kodikLink) el.embedFrame.src = current.kodikLink;
    };
    if(current.kodikLink){ mount(current.kodikLink); return; }
    el.detailState.classList.remove('hidden');
    el.detailState.innerHTML = '<div class="spinner"></div>Searching Kodik…';
    try{
      const token = await kodikToken();
      if(!valid()) return;
      if(!token){ askKodikToken(); return; }
      const malId = await resolveMalId(title);
      if(!valid()) return;
      if(malId){
        current.malId = malId;
        mount(KODIK_PLAYER + '/find-player?shikimoriID=' + malId + '&token=' + encodeURIComponent(token));
        return;
      }
      const hit = pickKodik(await searchKodik(token, title));
      if(!valid()) return;
      if(!hit || !hit.link){ el.detailState.textContent = 'Nothing found in Kodik for this title.'; return; }
      mount((hit.link.indexOf('//') === 0 ? 'https:' : '') + hit.link);
    }catch(e){
      if(valid()) el.detailState.textContent = 'Could not load Kodik: ' + e.message;
    }
  }

  /* ---- AniList search ----------------------------------------------------
   * A plain search often misses sequels whose title differs from the first
   * season only by punctuation ("K-On!" vs "K-On!!") or that are indexed under
   * their native name ("\u3051\u3044\u304a\u3093!!"). So we query a few spelling
   * variants, then pull in the seasons related to the best hits and rank
   * everything by how closely it matches what was typed.
   * ---------------------------------------------------------------------- */

  const AL_SEARCH_FIELDS = 'id idMal title{romaji english native} synonyms ' +
    'description(asHtml:false) episodes format seasonYear coverImage{extraLarge large} genres';

  const AL_REL_TYPES = ['SEQUEL','PREQUEL','SIDE_STORY','ALTERNATIVE','PARENT','SPIN_OFF'];

  async function alQuery(query, variables){
    const r = await fetch('https://graphql.anilist.co', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
      body: JSON.stringify({ query, variables })
    });
    return r.json();
  }

  function alToTitle(m){
    return {
      _kodik:true,
      _mal:(m.idMal ?? null),
      _eps:(m.episodes || 0),
      _syn:(m.synonyms || []),
      id:'al-' + m.id,
      name:{ main:(m.title.romaji || m.title.english || m.title.native), english:m.title.english, romaji:m.title.romaji, native:m.title.native },
      poster:{ src:(m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || '' },
      type:{ description:(m.format || '').replace(/_/g,' ') },
      year:(m.seasonYear || null),
      description:(m.description || '').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,''),
      genres:(m.genres || [])
    };
  }

  // "k-on" -> ["k-on", "k on", "kon"]; punctuation is what usually hides sequels.
  function alSearchVariants(q){
    const raw = String(q || '').trim();
    const out = [raw];
    const spaced = raw.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const tight  = raw.replace(/[^\p{L}\p{N}]+/gu, '');
    [spaced, tight].forEach(v => {
      if(v && !out.some(x => x.toLowerCase() === v.toLowerCase())) out.push(v);
    });
    return out.slice(0, 3);
  }

  async function alSearchOnce(s){
    try{
      const j = await alQuery(
        'query($s:String){Page(perPage:30){media(search:$s,type:ANIME,sort:SEARCH_MATCH){' + AL_SEARCH_FIELDS + '}}}',
        { s });
      return ((j.data && j.data.Page && j.data.Page.media) || []).map(alToTitle);
    }catch(_){ return []; }
  }

  // Every season / movie / OVA attached to the given AniList ids.
  async function alRelatedTitles(ids){
    if(!ids.length) return [];
    try{
      const j = await alQuery(
        'query($ids:[Int]){Page(perPage:8){media(id_in:$ids,type:ANIME){relations{edges{relationType node{type ' +
        AL_SEARCH_FIELDS + '}}}}}}',
        { ids });
      const out = [];
      for(const m of (j.data && j.data.Page && j.data.Page.media) || []){
        for(const e of (m.relations && m.relations.edges) || []){
          const n = e && e.node;
          if(n && n.type === 'ANIME' && AL_REL_TYPES.indexOf(e.relationType) !== -1) out.push(alToTitle(n));
        }
      }
      return out;
    }catch(_){ return []; }
  }

  // Exact title first, then prefix, then substring, then related seasons.
  function alRankMatches(list, q){
    const norm = s => String(s || '').toLowerCase()
      .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, '');
    const nq = norm(q);
    const rank = t => {
      const names = [t.name && t.name.main, t.name && t.name.english, t.name && t.name.romaji,
                     t.name && t.name.native, ...(t._syn || [])].map(norm).filter(Boolean);
      if(!nq || !names.length) return 3;
      if(names.some(n => n === nq)) return 0;
      if(names.some(n => n.indexOf(nq) === 0)) return 1;
      if(names.some(n => n.indexOf(nq) !== -1)) return 2;
      return 3;
    };
    return list
      .map((t, i) => ({ t, i, r:rank(t) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map(x => x.t);
  }

  async function searchAniListTitles(q){
    try{
      const batches = await Promise.all(alSearchVariants(q).map(alSearchOnce));
      const seen = new Set();
      const list = [];
      for(const batch of batches){
        for(const t of batch){ if(!seen.has(t.id)){ seen.add(t.id); list.push(t); } }
      }
      // Pull the other seasons of the strongest hits into the results.
      const seeds = list.slice(0, 4)
        .map(t => parseInt(String(t.id).replace('al-', ''), 10))
        .filter(n => !isNaN(n));
      for(const t of await alRelatedTitles(seeds)){
        if(!seen.has(t.id)){ seen.add(t.id); list.push(t); }
      }
      return alRankMatches(list, q);
    }catch(e){ return []; }
  }

  function setKodikOnlyTabs(kodikOnly){
    const libria = $$('.src-tab', el.sourceTabs).find(b => b.dataset.src === 'libria');
    if(libria) libria.classList.toggle('hidden', !!kodikOnly);
  }

  async function openKodikTitle(t, resume){
    ++titleRequest; ++kodikRequest;
    saveProgress(); teardownPlayer(); el.video.pause();
    showDetail();
    el.playerWrap.classList.add('hidden');
    el.embedWrap.classList.add('hidden'); el.embedFrame.src = 'about:blank';
    el.detailState.classList.add('hidden');
    current.title = t;
    current.episodes = [];
    current.kodikLink = undefined;
    current.malId = (t._mal ?? null);
    current.ep = null;

    el.poster.src = posterUrl(t);
    el.title.textContent = titleName(t);
    el.sub.textContent = [t.name && t.name.english, t.type && t.type.description, releaseYear(t)].filter(Boolean).join(' • ');
    el.desc.textContent = (t.description || '').replace(/\n{3,}/g,'\n\n');
    el.chips.innerHTML = '';
    (t.genres || []).slice(0,6).forEach(g => addChip(typeof g === 'string' ? g : g.name, true));
    el.teamSel.innerHTML = '<option>Kodik - switch inside the player</option>';
    el.episodes.innerHTML = '<p class="hint">Episodes, dubs and subtitles are switched right inside the Kodik player below.</p>';

    setKodikOnlyTabs(true);
    current.mode = 'kodik';
    if(window.__awPrepareKodik) window.__awPrepareKodik(t, resume);
    return setMode('kodik');
  }

  /* Custom player controls */
  const v = el.video;
  el.playBtn.innerHTML = ICON.play;
  el.muteBtn.innerHTML = ICON.vol;
  el.fsBtn.innerHTML   = ICON.fs;
  el.ambientBtn.innerHTML = ICON.ambient;
  el.pipBtn.innerHTML = ICON.pip;
  el.rewBtn.innerHTML = ICON.rew;
  el.fwdBtn.innerHTML = ICON.fwd;

  /* restore saved volume */
  (function restoreVolume(){
    const sv = parseFloat(localStorage.getItem('aniwired:vol'));
    if(!isNaN(sv)){ v.volume = sv; el.volume.value = sv; }
    if(localStorage.getItem('aniwired:muted') === '1'){ v.muted = true; }
  })();

  /* skip buttons */
  el.rewBtn.onclick = () => { v.currentTime = Math.max(0, v.currentTime - 10); };
  el.fwdBtn.onclick = () => { v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10); };

  el.pipBtn.onclick = togglePip;
  v.addEventListener('enterpictureinpicture', () => { el.pipBtn.classList.add('active'); });
  v.addEventListener('leavepictureinpicture', () => {
    el.pipBtn.classList.remove('active');
    if(!el.detail.classList.contains('hidden')) return;
    v.pause();
    updateMiniReturn();
  });

  const ambient = {
    canvas: $('#ambientCanvas'),
    stage:  $('#playerStage'),
    ctx:    null,
    raf:    0,
    last:   0,
    enabled: localStorage.getItem('aniwired:ambient') !== '0',
  };
  ambient.ctx = ambient.canvas.getContext('2d');
  ambient.canvas.width = 32; ambient.canvas.height = 18;

  function ambientLoop(ts){
    ambient.raf = requestAnimationFrame(ambientLoop);
    if(ts - ambient.last < 110) return;            // ~9 fps - smooth glow, light CPU
    ambient.last = ts;
    if(v.paused || v.readyState < 2) return;
    try{ ambient.ctx.drawImage(v, 0, 0, ambient.canvas.width, ambient.canvas.height); }catch(e){}
  }
  function startAmbient(){
    if(!ambient.enabled || current.mode !== 'libria' || v.paused) return;
    ambient.stage.classList.add('ambient-on');
    if(!ambient.raf){ ambient.last = 0; ambient.raf = requestAnimationFrame(ambientLoop); }
  }
  function stopAmbient(keepGlow){
    if(ambient.raf){ cancelAnimationFrame(ambient.raf); ambient.raf = 0; }
    if(!keepGlow){ ambient.stage.classList.remove('ambient-on'); ambient.ctx.clearRect(0,0,ambient.canvas.width,ambient.canvas.height); }
  }
  function setAmbient(on){
    ambient.enabled = on;
    localStorage.setItem('aniwired:ambient', on ? '1' : '0');
    el.ambientBtn.classList.toggle('active', on);
    el.ambientBtn.title = on ? 'Ambient Light: on' : 'Ambient Light: off';
    on ? startAmbient() : stopAmbient(false);
  }
  el.ambientBtn.onclick = () => setAmbient(!ambient.enabled);
  document.addEventListener('visibilitychange', () => { document.hidden ? stopAmbient(true) : startAmbient(); });
  el.ambientBtn.classList.toggle('active', ambient.enabled);
  el.ambientBtn.title = ambient.enabled ? 'Ambient Light: on' : 'Ambient Light: off';

  function togglePlay(){ v.paused ? v.play() : v.pause(); }
  el.playBtn.onclick = togglePlay;
  v.onclick = togglePlay;
  v.onplay  = () => { el.playBtn.innerHTML = ICON.pause; el.playerWrap.classList.remove('paused'); startAmbient(); };
  v.onpause = () => { el.playBtn.innerHTML = ICON.play;  el.playerWrap.classList.add('paused'); stopAmbient(true); };

  v.ontimeupdate = () => {
    if(v.duration){
      el.timeline.value = (v.currentTime / v.duration) * 100;
      el.timeline.style.background =
        'linear-gradient(90deg,var(--accent) ' + el.timeline.value + '%,rgba(255,255,255,.18) ' + el.timeline.value + '%)';
    }
    el.timeLabel.textContent = fmt(v.currentTime) + ' / ' + fmt(v.duration);
    throttleSave();
  };
  el.timeline.oninput = () => { if(v.duration) v.currentTime = (el.timeline.value/100) * v.duration; };

  el.volume.oninput = () => { v.volume = el.volume.value; v.muted = v.volume === 0; updateMute(); persistVolume(); };
  el.muteBtn.onclick = () => { v.muted = !v.muted; updateMute(); persistVolume(); };
  function updateMute(){
    el.muteBtn.innerHTML = (v.muted || v.volume===0) ? ICON.mute : ICON.vol;
    if(!v.muted && v.volume>0) el.volume.value = v.volume;
  }
  function persistVolume(){
    localStorage.setItem('aniwired:vol', String(v.volume));
    localStorage.setItem('aniwired:muted', v.muted ? '1' : '0');
  }
  updateMute();

  el.subBtn.onclick = () => {
    const tracks = v.textTracks;
    if(!tracks || !tracks.length){ el.subBtn.title='Subtitles unavailable'; el.subBtn.style.opacity=.4; return; }
    const on = tracks[0].mode !== 'showing';
    for(const tr of tracks) tr.mode = on ? 'showing' : 'hidden';
    el.subBtn.classList.toggle('active', on);
  };

  function fsElement(){
    return document.fullscreenElement || document.webkitFullscreenElement ||
           document.webkitCurrentFullScreenElement || null;
  }
  function pseudoFs(on){
    el.playerWrap.classList.toggle('pseudo-fs', on);
    document.body.classList.toggle('pseudo-fs-lock', on);
  }
  function iosVideoFs(){
    const vid = el.video;
    if(vid && typeof vid.webkitEnterFullscreen === 'function'){
      try{ vid.webkitEnterFullscreen(); return true; }catch(e){}
    }
    return false;
  }
  function toggleFullscreen(){
    const box = el.playerWrap;
    if(box.classList.contains('pseudo-fs')){ pseudoFs(false); return; }
    if(fsElement()){
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen;
      if(exit) exit.call(document);
      return;
    }
    const req = box.requestFullscreen || box.webkitRequestFullscreen || box.webkitRequestFullScreen;
    if(!req){ if(!iosVideoFs()) pseudoFs(true); return; }
    try{
      const out = req.call(box);
      if(out && out.catch) out.catch(() => { if(!iosVideoFs()) pseudoFs(true); });
    }catch(e){ if(!iosVideoFs()) pseudoFs(true); }
  }
  el.fsBtn.onclick = toggleFullscreen;
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && el.playerWrap.classList.contains('pseudo-fs')) pseudoFs(false);
  });

  document.addEventListener('keydown', e => {
    if($('#authBack').classList.contains('show') || el.detail.classList.contains('hidden') || el.playerWrap.classList.contains('hidden')) return;
    const ae = document.activeElement;
    if(ae && (['INPUT','SELECT','TEXTAREA'].includes(ae.tagName) || ae.isContentEditable)) return;
    if(e.code==='Space'){ e.preventDefault(); togglePlay(); }
    if(e.code==='ArrowRight') v.currentTime += 5;
    if(e.code==='ArrowLeft')  v.currentTime -= 5;
    if(e.code==='KeyF') el.fsBtn.click();
    if(e.code==='KeyM') el.muteBtn.click();
    if(e.code==='KeyP'){ e.preventDefault(); togglePip(); }
    if(e.code==='KeyJ') v.currentTime = Math.max(0, v.currentTime - 10);
    if(e.code==='KeyL') v.currentTime += 10;
  });

  /* localStorage persistence */
  let lastSave = 0;
  function throttleSave(){ const now=Date.now(); if(now-lastSave>4000){ lastSave=now; saveProgress(); } }
  // Persistence belongs to account.js (verified account / guest scopes).
  // No unscoped fallback: if that module fails to load, do not overwrite old backups.
  function saveProgress(){}
  v.addEventListener('pause', () => saveProgress());
  window.addEventListener('beforeunload', () => saveProgress());

  function renderResume(){} // implemented by account.js

  /* helpers */
  function titleName(t){ return (t.name && (t.name.main || t.name.english)) || t.alias || 'Untitled'; }
  function releaseYear(t){ return (t.year && typeof t.year === 'object') ? t.year.value : t.year; }
  function fmt(s){ s=Math.floor(s||0); const m=Math.floor(s/60), sec=s%60; return m+':' + String(sec).padStart(2,'0'); }
  /* Also escapes ' and / now (audit S-8). Previously a single unquoted
     attribute anywhere in the 4000-line template soup would have turned a
     comment body or an externally supplied title into stored XSS. */
  const HTML_ESCAPES = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;', '/':'&#x2F;' };
  function escapeHtml(s){ return String(s ?? '').replace(/[&<>"'/]/g, c => HTML_ESCAPES[c]); }

  /* Poster URLs come from third-party APIs. Only https: is allowed through,
     which also rules out javascript:/data: URLs and mixed content. */
  function safePoster(u){
    try { const parsed = new URL(String(u || '')); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : ''; }
    catch(_) { return ''; }
  }
  function debounce(fn,ms){ let id; return (...a)=>{ clearTimeout(id); id=setTimeout(()=>fn(...a),ms); }; }

  /* search wiring */
  el.searchInput.addEventListener('input', () => {
    ++catalogGeneration;
    if(!el.detail.classList.contains('hidden') && current.mode === 'libria' && !el.video.paused){
      enterPip();
    }
  });

  const runCatalogSearch = debounce(async (q, request) => {
    if(request !== catalogGeneration || el.searchInput.value.trim() !== q) return;
    if(window.__awFilteredCatalog && window.__awFilteredCatalog(q)) return;
    const isCurrent = () => request === catalogGeneration && el.searchInput.value.trim() === q && !el.home.classList.contains('hidden');
    const keepPlaying = isPlayerLive() && (!el.video.paused || current.mode === 'kodik' || document.pictureInPictureElement);
    if(!q){ if(!el.detail.classList.contains('hidden')) showHome(keepPlaying); loadHome(); return; }
    if(!el.detail.classList.contains('hidden')) showHome(keepPlaying);
    hideHero();
    el.results.className = 'grid';
    el.rowHead.classList.add('is-grid');
    el.resultsTitle.textContent = 'Results: "' + q + '"';
    el.resultsSub.textContent = '';
    el.results.innerHTML = '<div class="spinner"></div>';
    try{
      const [libria, ext] = await Promise.all([
        searchTitles(q).catch(() => []),
        searchAniListTitles(q).catch(() => []),
      ]);
      if(!isCurrent()) return;
      // Keep "!" and pair the name with the year: sequels often differ from
      // season 1 by punctuation alone ("K-On!" vs "K-On!!"). Stripping it made
      // the later season look like a duplicate of the AniLibria entry and it
      // was silently dropped from the results.
      // Cyrillic (а-яё) is kept on purpose so Russian titles dedupe correctly.
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9а-яё!]+/gi, '').trim();
      const yr = t => String(releaseYear(t) || '');
      const libriaKeys = new Set();
      libria.forEach(t => {
        const y = yr(t);
        [titleName(t), t.name && t.name.english, t.name && t.name.romaji, t.alias]
          .forEach(n => { const k = norm(n); if(k) libriaKeys.add(k + '|' + y); });
      });
      const extras = ext.filter(t => {
        const y = yr(t);
        return ![t.name && t.name.main, t.name && t.name.english,
                 t.name && t.name.romaji, t.name && t.name.native]
          .some(n => { const k = norm(n); return k && libriaKeys.has(k + '|' + y); });
      });
      // AniLibria's own search is fuzzy, so rank the whole merged list: exact
      // title matches first, unrelated fuzzy hits last.
      const merged = alRankMatches([...libria, ...extras], q);
      if(!merged.length){ el.results.innerHTML = '<p class="hint">Nothing found.</p>'; return; }
      el.resultsTitle.textContent = 'Results: "' + q + '"';
      el.resultsSub.textContent = (libria.length && extras.length)
        ? 'AniLibria + extended catalog (Kodik)'
        : (extras.length ? 'Extended catalog (Kodik)' : 'AniLibria');
      renderResults(merged);
    }
    catch(err){ if(isCurrent()) el.results.innerHTML = '<p class="hint">Search error: '+escapeHtml(err.message)+'</p>'; }
  }, 350);
  el.searchInput.addEventListener('input', () => runCatalogSearch(el.searchInput.value.trim(), catalogGeneration));

  el.backBtn.onclick = () => showHome();

  function goHome(){
    ++catalogGeneration;
    el.searchInput.value = '';
    const keepPlaying = isPlayerLive() && (!el.video.paused || current.mode === 'kodik' || document.pictureInPictureElement);
    showHome(keepPlaying);
    el.resultsTitle.textContent = 'New episodes';
    loadHome();
  }
  el.logo.onclick = goHome;
  el.logo.addEventListener('keydown', e => { if(e.code === 'Enter' || e.code === 'Space'){ e.preventDefault(); goHome(); } });
  el.navHome.onclick = goHome;
  el.navHome.addEventListener('keydown', e => { if(e.code === 'Enter' || e.code === 'Space'){ e.preventDefault(); goHome(); } });
  if(el.navNew) el.navNew.onclick = goHome;

  /* horizontal rail arrows */
  const scrollRail = dir => el.results.scrollBy({ left: dir * Math.max(320, el.results.clientWidth * 0.85), behavior:'smooth' });
  el.railPrev.onclick = () => scrollRail(-1);
  el.railNext.onclick = () => scrollRail(1);

  /* TMDB HD-artwork key management */
  function openTmdbBar(){
    el.tmdbBar.classList.remove('hidden');
    el.tmdbInput.value = getTmdbKey();
    el.tmdbInput.focus();
    if(el.detail && !el.detail.classList.contains('hidden')) goHome();
  }
  function refreshHeroArt(){
    for(const k in heroBgCache) delete heroBgCache[k];
    if(heroItems.length) setHero(heroIdx);
  }
  if(el.navHd){ el.navHd.classList.toggle('on', !!getTmdbKey()); el.navHd.onclick = openTmdbBar; }
  window.__awHdSetup = openTmdbBar;
  document.addEventListener('keydown', e => {
    if(e.shiftKey && (e.code === 'KeyH') && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')){
      e.preventDefault(); openTmdbBar();
    }
  });
  el.tmdbSave.onclick = () => {
    const v = el.tmdbInput.value.trim();
    if(v) localStorage.setItem('tmdb:key', v); else localStorage.removeItem('tmdb:key');
    localStorage.setItem('tmdb:dismissed', '1');
    if(el.navHd) el.navHd.classList.toggle('on', !!getTmdbKey());
    el.tmdbBar.classList.add('hidden');
    refreshHeroArt();
    toast(v ? 'TMDB connected - HD artwork enabled' : 'TMDB key removed');
  };
  el.tmdbInput.addEventListener('keydown', e => { if(e.code === 'Enter') el.tmdbSave.click(); });
  el.tmdbDismiss.onclick = () => { localStorage.setItem('tmdb:dismissed', '1'); el.tmdbBar.classList.add('hidden'); };
  if(!getTmdbKey() && localStorage.getItem('tmdb:dismissed') !== '1') openTmdbBar();

  el.miniReturn.onclick = () => { showDetail(); el.miniReturn.classList.remove('show'); };
  el.mrClose.onclick = e => {
    e.stopPropagation();
    saveProgress(); ++kodikRequest; ++titleRequest;
    if(document.pictureInPictureElement){ document.exitPictureInPicture().catch(()=>{}); }
    teardownPlayer();
    el.video.pause(); el.video.removeAttribute('src'); el.video.load();
    el.embedFrame.src = 'about:blank'; current.kodikLink = undefined;
    el.playerWrap.classList.add('hidden'); el.embedWrap.classList.add('hidden');
    current.ep = null;
    el.miniReturn.classList.remove('show');
  };

  $$('.src-tab', el.sourceTabs).forEach(b => b.onclick = () => setMode(b.dataset.src));

  async function topTitles(){
    const d = new Date(); d.setMonth(d.getMonth() - 12);
    const since = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    try{
      const r = await fetch('https://graphql.anilist.co', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
        body: JSON.stringify({
          query:'query($since:FuzzyDateInt){Page(perPage:10){media(type:ANIME,sort:[POPULARITY_DESC],startDate_greater:$since,isAdult:false){id idMal title{romaji english native} description(asHtml:false) format seasonYear averageScore coverImage{extraLarge large} bannerImage genres}}}',
          variables:{ since }
        })
      });
      const j = await r.json();
      const media = (j.data && j.data.Page && j.data.Page.media) || [];
      return media.map(m => ({
        _kodik:true,
        _mal:(m.idMal ?? null),
        _banner:(m.bannerImage || null),
        id:'al-' + m.id,
        name:{ main:(m.title.romaji || m.title.english || m.title.native), english:m.title.english, romaji:m.title.romaji },
        poster:{ src:(m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || '' },
        type:{ description:(m.format || '').replace(/_/g,' ') },
        year:(m.seasonYear || null),
        description:(m.description || '').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,''),
        genres:(m.genres || [])
      }));
    }catch(e){ return []; }
  }

  /* init */
  async function loadHome(){
    if(window.__awFilteredCatalog && window.__awFilteredCatalog(el.searchInput.value.trim())) return;
    const request = ++catalogGeneration;
    const isCurrent = () => request === catalogGeneration && !el.searchInput.value.trim();
    el.resultsTitle.textContent = 'New episodes';
    el.resultsSub.textContent = '';
    el.results.className = 'rail';
    el.rowHead.classList.remove('is-grid');
    el.results.innerHTML = '<div class="spinner"></div>';
    try{
      const [list, top] = await Promise.all([ updatesTitles(), topTitles().catch(() => []) ]);
      if(!isCurrent()) return;
      buildHero(top.length ? top : list);
      renderResults(list);
    }
    catch(err){ if(!isCurrent()) return; hideHero(); el.results.className = 'grid'; el.results.innerHTML = '<p class="hint">Couldn\'t load: '+escapeHtml(err.message)+'</p>'; }
  }
  // account.js renders only the verified account/guest history.
  loadHome();
