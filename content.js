// Script de l'extension dans chaque page.
// 1. Reçoit le fichier de sous-titres complet (intercepté par inject.js, ou piste <track> du lecteur)
// 2. Le découpe en phrases et les traduit TOUTES à l'avance (en commençant par celles qui arrivent)
// 3. Affiche la bonne phrase traduite en suivant l'horloge de la vidéo : aucun délai pendant la lecture.
// Repli : si aucun fichier n'est trouvé, lecture des sous-titres affichés à l'écran (avec un léger délai).
(() => {
  if (window.__stfrLoaded) return;
  window.__stfrLoaded = true;

  const DEFAULTS = { enabled: true, target: 'fr', mode: 'translation', size: 1, autoCC: true, engine: 'google', bg: true };
  let settings = { ...DEFAULTS };
  const IS_YT = /(^|\.)(youtube|youtube-nocookie)\.com$/.test(location.hostname);

  let cues = []; // [{start, end, text, tr}] triés par début
  let cueSource = null; // 'net' | 'track'
  let cueVideoId = null;
  let gen = 0;
  const netCache = new Map(); // YouTube : id de vidéo -> sous-titres déjà reçus
  const netFiles = []; // autres sites : fichiers de sous-titres reçus (une entrée par langue)
  let curFile = null;
  const trCache = new Map(); // "langue|texte" -> traduction
  let video = null;
  let lastKey = null;
  let looping = false;

  // ---------------------------------------------------------------- réglages
  try {
    chrome.storage.sync.get(DEFAULTS, (s) => {
      settings = { ...DEFAULTS, ...s };
      refresh();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local') {
        // le modèle local vient d'être installé, ou ses réglages ont changé : on retraduit avec lui
        if (('ollamaReadyAt' in ch || 'ollamaModel' in ch) && wantEngine() === 'ollama') {
          for (const k of [...trCache.keys()]) if (k.includes('|ollama|')) trCache.delete(k);
          cues.forEach((c) => (c.tr = null));
          translateAll();
        }
        return;
      }
      for (const k in ch) settings[k] = ch[k].newValue;
      if ('target' in ch || 'engine' in ch) {
        cues.forEach((c) => (c.tr = null));
        live.tr = '';
        translateAll();
      }
      if ('enabled' in ch && !settings.enabled) restoreTracks();
      refresh();
    });
  } catch (_) {}

  function refresh() {
    lastKey = null;
    applyRootClass();
    startLoop();
    render();
  }

  // ---------------------------------------------------------------- outils
  const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
  const clean = (t) =>
    (t || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENT[m])
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/\s+/g, ' ')
      .trim();
  const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;

  function ytId() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get('v') || (u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/) || [])[1] || null;
    } catch (_) {
      return null;
    }
  }

  function sendMsg(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        cb(res);
      });
    } catch (_) {
      cb(null); // extension rechargée pendant que la page était ouverte
    }
  }

  // ---------------------------------------------------------------- lecture des fichiers de sous-titres
  function toSec(s) {
    s = String(s || '').trim();
    if (/^[\d.]+s$/.test(s)) return parseFloat(s);
    if (/^[\d.]+ms$/.test(s)) return parseFloat(s) / 1000;
    const m = s.replace(',', '.').match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?/);
    if (!m) return NaN;
    return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +('0.' + m[4].padEnd(3, '0')) : 0);
  }

  function parseAny(url, text) {
    const t = text.replace(/^﻿/, '').trimStart();
    if (t[0] === '{') {
      const j = JSON.parse(t);
      return j && Array.isArray(j.events) ? parseJson3(j, /[?&]kind=asr/.test(url)) : null;
    }
    if (t[0] === '<') return parseXml(t);
    if (/-->/.test(t.slice(0, 5000))) return parseVtt(t);
    return null;
  }

  // Format JSON de YouTube
  function parseJson3(j, asr) {
    const evs = j.events.filter((e) => e.segs && e.tStartMs != null);
    const wordLevel = asr || evs.some((e) => e.segs.some((s) => s.tOffsetMs));
    if (!wordLevel) {
      const out = [];
      for (const e of evs) {
        const text = clean(e.segs.map((s) => s.utf8 || '').join(''));
        if (text) out.push({ start: e.tStartMs / 1000, end: (e.tStartMs + (e.dDurationMs || 2000)) / 1000, text });
      }
      return out;
    }
    // Sous-titres automatiques : mot par mot -> on reconstruit des phrases
    const words = [];
    for (const e of evs) {
      e.segs.forEach((s, k) => {
        const w = (s.utf8 || '').replace(/\n/g, ' ');
        if (w.trim()) words.push({ t: (e.tStartMs + (s.tOffsetMs || 0)) / 1000, w, first: k === 0 });
      });
    }
    return groupWords(words);
  }

  function groupWords(words) {
    words.sort((a, b) => a.t - b.t);
    const out = [];
    let cur = null;
    const flush = (end) => {
      if (!cur) return;
      const text = clean(cur.text);
      if (text) out.push({ start: cur.start, end: Math.max(end, cur.start + 1.2), text });
      cur = null;
    };
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (cur && w.t - cur.last > 1.3) flush(cur.last + 1.2); // longue pause = fin de phrase
      if (!cur) cur = { start: w.t, text: '', last: w.t, n: 0 };
      const needSpace = cur.text && !/^\s/.test(w.w) && !CJK.test(cur.text.slice(-1)) && !CJK.test(w.w[0]);
      cur.text += (needSpace ? ' ' : '') + w.w;
      cur.last = w.t;
      cur.n++;
      const txt = cur.text.trim();
      const next = words[i + 1];
      const end = next ? Math.min(next.t, w.t + 2.5) : w.t + 1.5;
      if (/[.!?。！？…]["'»”)\]]?$/.test(txt)) flush(end);
      else if (cur.n >= 9 && /[,;:，、；]$/.test(txt)) flush(end);
      else if (cur.n >= 16 || txt.length > 100) flush(end);
    }
    flush(cur ? cur.last + 1.5 : 0);
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i + 1].start - out[i].end < 1) out[i].end = out[i + 1].start;
    }
    return out;
  }

  // WebVTT et SRT
  function parseVtt(t) {
    const out = [];
    for (const b of t.replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = b.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const [a, z] = lines[i].split('-->');
      const start = toSec(a);
      const end = toSec(z.trim().split(/\s+/)[0]);
      const text = clean(lines.slice(i + 1).join(' '));
      if (!isNaN(start) && !isNaN(end) && text) out.push({ start, end, text });
    }
    if (/X-TIMESTAMP-MAP/.test(t.slice(0, 500))) out.hasTimestampMap = true;
    return out;
  }

  // TTML / DFXP / srv3 (XML)
  function parseXml(t) {
    const doc = new DOMParser().parseFromString(t, 'text/xml');
    const ser = new XMLSerializer();
    const out = [];
    for (const p of doc.getElementsByTagName('p')) {
      let start, end;
      if (p.hasAttribute('t')) {
        start = +p.getAttribute('t') / 1000;
        end = start + (+p.getAttribute('d') || 2000) / 1000;
      } else if (p.hasAttribute('begin')) {
        start = toSec(p.getAttribute('begin'));
        end = p.hasAttribute('end') ? toSec(p.getAttribute('end')) : start + (toSec(p.getAttribute('dur')) || 2);
      } else continue;
      const text = clean(ser.serializeToString(p).replace(/^<p[^>]*>|<\/p>$/g, ''));
      if (text && !isNaN(start)) out.push({ start, end, text });
    }
    return out;
  }

  // ---------------------------------------------------------------- réception des sous-titres
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__stfr !== 'subs') return;
    let parsed = null;
    try {
      parsed = parseAny(e.data.url, e.data.text);
    } catch (_) {}
    if (parsed && parsed.length) onNetSubs(e.data.url, parsed);
  });

  function onNetSubs(url, parsed) {
    const tsMap = parsed.hasTimestampMap;
    parsed.sort((a, b) => a.start - b.start);
    parsed.hasTimestampMap = tsMap;
    if (IS_YT) {
      let vid = null;
      try {
        vid = new URL(url, location.href).searchParams.get('v');
      } catch (_) {}
      const cur = ytId();
      if (!cur) return; // aperçus au survol sur la page d'accueil : on ignore
      // On garde les sous-titres de chaque vidéo : en revenant sur une vidéo déjà vue,
      // YouTube ne retélécharge pas toujours le fichier.
      const id = vid || cur;
      netCache.delete(id);
      netCache.set(id, parsed);
      if (netCache.size > 30) netCache.delete(netCache.keys().next().value);
      if (id === cur) setCues(parsed, 'net', cur);
      return;
    }
    // HLS segmenté avec décalage horaire (X-TIMESTAMP-MAP) : le lecteur recale lui-même ces sous-titres
    // dans une piste <track>, plus fiable -> on laisse la source "piste" s'en charger.
    if (parsed.hasTimestampMap) return;
    // Autres sites : fichier complet -> on le garde ; petit segment (streaming HLS/DASH) -> on ajoute
    const v = pickVideo();
    const dur = v && isFinite(v.duration) ? v.duration : 0;
    const span = parsed[parsed.length - 1].end - parsed[0].start;
    if (cueSource === 'net' && cues.length && dur && span < dur * 0.5) {
      const seen = new Set(cues.map((c) => c.start.toFixed(2) + c.text));
      const add = parsed.filter((c) => !seen.has(c.start.toFixed(2) + c.text));
      if (!add.length) return;
      setCues(cues.concat(add).sort((a, b) => a.start - b.start), 'net', null, true);
      return;
    }
    // Plusieurs langues peuvent arriver d'un coup (Tubi charge anglais + espagnol) : on les garde toutes
    // et on suit celle que le site affiche vraiment (voir followSiteTrack).
    const key = String(url).split('?')[0];
    const known = netFiles.find((f) => f.key === key);
    if (known) known.parsed = parsed;
    else netFiles.push({ key, parsed, at: Date.now() });
    if (netFiles.length > 8) netFiles.shift();
    const lastAt = netFiles.length > 1 ? netFiles[netFiles.length - 2].at : 0;
    // premier fichier, ou fichier téléchargé bien après les autres (= l'utilisateur vient de changer de langue)
    if (cueSource !== 'net' || !cues.length || key === curFile || Date.now() - lastAt > 3000) {
      curFile = key;
      setCues(parsed, 'net', null);
    }
  }

  function setCues(list, source, vid, keepTr) {
    if (!keepTr) {
      gen++;
      if (native.box) native.box.classList.remove('stfr-native');
      Object.assign(native, { box: null, known: false, okAt: 0, searchAt: 0, misses: 0, cueText: '', cueAt: 0, lift: null });
    }
    cues = list.map((c) => ({ start: c.start, end: c.end, text: c.text, tr: c.tr || null }));
    cueSource = source;
    cueVideoId = vid;
    live.orig = '';
    translateAll();
    refresh();
  }

  function resetCues() {
    gen++;
    cues = [];
    cueSource = null;
    cueVideoId = null;
    curTrack = null;
    refresh();
  }

  // ---------------------------------------------------------------- traduction anticipée
  // Moteur "google" : instantané. Moteur "claude" : tient compte du contexte (titre, phrases d'avant).
  // Avec Claude, Google traduit quand même tout de suite les toutes premières phrases pour ne rien faire attendre,
  // puis la version Claude remplace chaque phrase dès qu'elle arrive.
  let failures = 0;
  // identifiant de cette page : si elle est rechargée ou quittée, ses demandes en attente sont abandonnées
  const PAGE_ID = Math.random().toString(36).slice(2);
  const ck = (target, eng, text) => target + '|' + eng + '|' + text;
  const CONTEXT_ENGINES = ['claude', 'ollama']; // moteurs qui traduisent par scène, avec le contexte
  const wantEngine = () => (['claude', 'ollama', 'microsoft'].includes(settings.engine) ? settings.engine : 'google');

  function bestTr(text) {
    const target = settings.target;
    const eng = wantEngine();
    if (eng !== 'google') {
      const c = trCache.get(ck(target, eng, text));
      if (c) return [c, eng];
    }
    const g = trCache.get(ck(target, 'google', text));
    return g ? [g, 'google'] : [null, null];
  }

  function applyCache() {
    for (const c of cues) {
      const [tr, by] = bestTr(c.text);
      if (tr) {
        c.tr = tr;
        c.trBy = by;
      }
    }
    lastKey = null;
  }

  function pageTitle() {
    const h = document.querySelector('h1.ytd-watch-metadata, h1.title, meta[property="og:title"]');
    const t = (h && (h.content || h.textContent)) || document.title || '';
    return clean(t.replace(/\s*-\s*YouTube\s*$/, '')).slice(0, 200);
  }

  function ctxFor(texts) {
    const idx = cues.findIndex((c) => c.text === texts[0]);
    return { title: pageTitle(), before: idx > 0 ? cues.slice(Math.max(0, idx - 5), idx).map((c) => c.text) : [] };
  }

  function translateAll() {
    const myGen = gen;
    const target = settings.target;
    const eng = wantEngine();
    applyCache();
    const t = video ? video.currentTime : 0;
    const need = cues.filter((c) => !trCache.has(ck(target, eng, c.text)));
    if (!need.length) return;
    // Priorité : la phrase en cours et les suivantes, puis ce qui est déjà passé.
    // Chaque paquet reste dans l'ordre chronologique, pour que Claude lise un texte qui se suit.
    const uniq = (list) => [...new Set(list.map((c) => c.text))];
    const ahead = uniq(need.filter((c) => c.end >= t));
    const behind = uniq(need.filter((c) => c.end < t)).filter((s) => !ahead.includes(s));
    const groups = [];
    if (ahead.length) groups.push(ahead.slice(0, 6));
    const size = eng === 'ollama' ? 30 : eng === 'claude' ? 40 : 150;
    for (let i = 6; i < ahead.length; i += size) groups.push(ahead.slice(i, i + size));
    for (let i = 0; i < behind.length; i += size) groups.push(behind.slice(i, i + size));
    if (CONTEXT_ENGINES.includes(eng)) {
      // le moteur avec contexte prend quelques secondes : le gratuit affiche tout de suite les premières répliques
      const fast = ahead.concat(behind).slice(0, 10).filter((s) => !trCache.has(ck(target, 'google', s)));
      request(fast, target, myGen, 'google');
    }
    for (const g of groups) request(g, target, myGen, eng);
  }

  // Après un saut dans la vidéo : les répliques de la nouvelle scène passent devant tout le reste.
  let urgentTimer = null;
  function urgentNear() {
    clearTimeout(urgentTimer);
    urgentTimer = setTimeout(() => {
      const eng = wantEngine();
      if (!CONTEXT_ENGINES.includes(eng) || !video || !cues.length) return;
      const t = video.currentTime;
      const near = [...new Set(cues.filter((c) => c.end >= t).slice(0, 8).map((c) => c.text))].filter((s) => !trCache.has(ck(settings.target, eng, s)));
      if (near.length) request(near, settings.target, gen, eng, true);
    }, 400);
  }

  function request(texts, target, myGen, engine, urgent) {
    if (!texts.length) return;
    const msg = { type: 'translate', texts, target, engine, page: PAGE_ID + ':' + myGen, urgent: !!urgent };
    if (CONTEXT_ENGINES.includes(engine)) msg.context = ctxFor(texts);
    sendMsg(msg, (res) => {
      // petit diagnostic lisible depuis la page (aucune donnée personnelle)
      const d = document.documentElement.dataset;
      d.stfrDiag = JSON.stringify({ v: chrome.runtime.getManifest().version, ok: !!(res && res.ok), engine: res && res.engine, err: res ? res.error || null : 'pas de réponse', warn: (res && res.warn) || null, n: texts.length, cues: cues.length });
      if (!res || !res.ok) {
        if (failures++ < 5) setTimeout(() => myGen === gen && translateAll(), 2000 * failures);
        return;
      }
      failures = 0;
      const used = res.engine || engine; // sans clé API, le service bascule sur Google
      texts.forEach((s, i) => res.result[i] && trCache.set(ck(target, used, s), res.result[i]));
      if (used !== engine && engine !== 'ollama') texts.forEach((s, i) => res.result[i] && trCache.set(ck(target, engine, s), res.result[i]));
      if (myGen !== gen || target !== settings.target) return;
      applyCache();
      // des répliques sont restées sans traduction (Google a demandé de ralentir) : on redemande plus tard
      if (res.result.some((r) => !r) && failures++ < 8) setTimeout(() => myGen === gen && translateAll(), 4000 * failures);
    });
  }

  // ---------------------------------------------------------------- affichage
  let overlay = null;

  function pickVideo() {
    let best = null;
    let bestA = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height * (v.paused ? 1 : 4);
      if (a > bestA) {
        bestA = a;
        best = v;
      }
    }
    return best;
  }

  function hostFor(v) {
    if (IS_YT) {
      const p = v.closest('.html5-video-player');
      if (p) return p;
    }
    const fs = document.fullscreenElement;
    for (let p = v.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p === fs || getComputedStyle(p).position !== 'static') return p;
    }
    return document.body || document.documentElement;
  }

  function getOverlay(v) {
    const host = hostFor(v);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'stfr-overlay notranslate';
      // empêche Chrome Traduction / Immersive Translate de retraduire notre affichage
      overlay.setAttribute('translate', 'no');
      overlay.dataset.version = chrome.runtime.getManifest().version;
    }
    if (overlay.parentElement !== host) host.appendChild(overlay);
    return overlay;
  }

  function place(v, ov) {
    const host = ov.parentElement;
    if (!host) return;
    const r = v.getBoundingClientRect();
    const h = host === document.body ? { left: -scrollX, top: -scrollY } : host.getBoundingClientRect();
    ov.style.left = r.left - h.left + 'px';
    ov.style.top = r.top - h.top + 'px';
    ov.style.width = r.width + 'px';
    ov.style.height = r.height + 'px';
    ov.style.setProperty('--stfr-size', Math.max(13, Math.round(r.height * 0.042 * (settings.size || 1))) + 'px');
    // On se place exactement là où le site affichait ses propres sous-titres : s'il les remonte quand
    // ses commandes apparaissent (Tubi…), les nôtres remontent avec.
    if (!IS_YT && native.box && native.box.isConnected) {
      const nb = native.box.getBoundingClientRect();
      if (nb.height > 4 && nb.bottom <= r.bottom + 2 && nb.top >= r.top) native.lift = Math.max(0, Math.round(r.bottom - nb.bottom));
    }
    ov.style.paddingBottom = !IS_YT && native.lift != null ? native.lift + 'px' : '';
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
    lastKey = '';
  }

  function ccOn() {
    if (!IS_YT) return true;
    const player = video && video.closest('.html5-video-player');
    // Pendant une pub, la même balise <video> lit la pub : on n'affiche rien.
    if (player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))) return false;
    const b = (player || document).querySelector('.ytp-subtitles-button');
    return !b || b.getAttribute('aria-pressed') !== 'false';
  }

  function findCue(t) {
    let lo = 0;
    let hi = cues.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // si deux phrases se chevauchent, on garde la plus récente encore active
    return ans >= 0 && t < cues[ans].end ? cues[ans] : null;
  }

  // ---------------------------------------------------------------- sous-titres d'origine du site (méthode générique)
  // On repère la boîte où le site écrit ses propres sous-titres en cherchant, sur la vidéo, le texte
  // de la phrase en cours (marche même quand les classes CSS sont illisibles, comme sur Tubi).
  // On la masque, et on s'en sert pour savoir si l'utilisateur a coupé les sous-titres dans le lecteur.
  const native = { box: null, known: false, okAt: 0, searchAt: 0, misses: 0, cueText: '', cueAt: 0 };
  const norm = (s) => clean(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  function findNativeBox(text) {
    const target = norm(text);
    if (target.length < 4 || !video || !document.body) return null;
    const vr = video.getBoundingClientRect();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts = [];
    let n;
    while ((n = walker.nextNode())) {
      const t = norm(n.textContent);
      if (t.length < 3 || !target.includes(t)) continue;
      const p = n.parentElement;
      if (!p || p.closest('.stfr-overlay')) continue;
      const r = p.getBoundingClientRect();
      if (!r.width || r.top < vr.top - 4 || r.bottom > vr.bottom + 4 || r.left < vr.left - 4 || r.right > vr.right + 4) continue;
      parts.push(p);
    }
    if (!parts.length) return null;
    let box = parts[0];
    while (box && !parts.every((x) => box.contains(x))) box = box.parentElement;
    // on remonte tant que le texte reste identique, pour masquer aussi le fond noir éventuel
    while (box && box.parentElement && !box.parentElement.contains(video) && norm(box.parentElement.textContent) === norm(box.textContent)) {
      box = box.parentElement;
    }
    if (!box || box === document.body || box.contains(video) || norm(box.textContent).length > target.length * 2 + 20) return null;
    return box;
  }

  // false = le site n'affiche plus ses sous-titres alors qu'une phrase est en cours -> ils ont été coupés
  function nativeOn(c) {
    if (IS_YT || cueSource === 'track') return true;
    const now = performance.now();
    if (c.text !== native.cueText) {
      native.cueText = c.text;
      native.cueAt = now;
    }
    if (native.box && native.box.isConnected && norm(native.box.textContent)) {
      native.okAt = now;
    } else if (now - native.searchAt > (native.misses > 20 && !native.known ? 3000 : 300)) {
      native.searchAt = now;
      const b = findNativeBox(c.text);
      if (b) {
        if (native.box && native.box !== b) native.box.classList.remove('stfr-native');
        native.box = b;
        b.classList.add('stfr-native');
        native.known = true;
        native.okAt = now;
        native.misses = 0;
      } else native.misses++;
    }
    return !(native.known && now - native.cueAt > 900 && now - native.okAt > 900);
  }

  function cueAt(list, t) {
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 && t < list[ans].end ? list[ans] : null;
  }

  // Le site affiche-t-il une autre langue que celle qu'on traduit ? Si le texte à l'écran correspond
  // à l'un des autres fichiers reçus, on bascule dessus.
  function followSiteTrack() {
    if (IS_YT || cueSource !== 'net' || netFiles.length < 2 || !video) return;
    const t = video.currentTime + 0.05;
    const cur = cueAt(cues, t);
    if (cur && native.box && native.box.isConnected) {
      const shown = norm(native.box.textContent);
      if (shown && norm(cur.text).includes(shown.slice(0, 15))) return; // c'est bien la bonne langue
    }
    for (const f of netFiles) {
      if (f.key === curFile) continue;
      const c = cueAt(f.parsed, t);
      if (c && findNativeBox(c.text)) {
        curFile = f.key;
        setCues(f.parsed, 'net', null);
        return;
      }
    }
  }

  // Pub jouée dans le lecteur : la vidéo devient beaucoup plus courte que les sous-titres
  function looksLikeAd() {
    const d = video.duration;
    const last = cues.length ? cues[cues.length - 1].end : 0;
    return isFinite(d) && d > 0 && last > 120 && d < last * 0.5;
  }

  function render() {
    if (!settings.enabled || !video || !ccOn()) return hideOverlay();
    let orig = '';
    let tr = '';
    if (cues.length) {
      if (looksLikeAd()) return hideOverlay();
      const c = findCue(video.currentTime + 0.05);
      if (c) {
        if (!nativeOn(c)) return hideOverlay();
        orig = c.text;
        tr = c.tr || '';
      }
    } else if (live.orig) {
      orig = live.orig;
      tr = live.tr;
    } else return hideOverlay();

    const key = orig + '\u0001' + tr + '\u0001' + settings.mode;
    if (key === lastKey) {
      if (overlay && !IS_YT && native.box && (performance.now() - (native.placedAt || 0) > 200)) {
        native.placedAt = performance.now();
        place(video, overlay);
      }
      return;
    }
    lastKey = key;

    const ov = getOverlay(video);
    ov.classList.toggle('stfr-nobg', settings.bg === false); // option « sans fond »
    place(video, ov);
    ov.textContent = '';
    if (!orig) {
      ov.style.display = 'none';
      return;
    }
    ov.style.display = '';
    const box = document.createElement('div');
    box.className = 'stfr-box';
    const line = (cls, text) => {
      const s = document.createElement('span');
      s.className = 'stfr-line ' + cls;
      s.textContent = text;
      box.appendChild(s);
    };
    if (settings.mode === 'bilingual') {
      line('stfr-orig', orig);
      if (tr && tr !== orig) line('stfr-tr', tr);
    } else {
      if (!tr) {
        ov.style.display = 'none'; // traduction seule : jamais d'anglais, même une fraction de seconde
        return;
      }
      line('stfr-tr', tr);
    }
    ov.appendChild(box);
  }

  function loop() {
    render();
    if (cues.length || live.orig) requestAnimationFrame(loop);
    else looping = false;
  }

  function startLoop() {
    if (looping || !(cues.length || live.orig)) return;
    looping = true;
    requestAnimationFrame(loop);
  }

  function applyRootClass() {
    const on = settings.enabled && (cues.length > 0 || !!live.orig);
    document.documentElement.classList.toggle('stfr-on', on);
  }

  const replace = () => {
    lastKey = null;
    render();
  };
  window.addEventListener('resize', replace);
  document.addEventListener('fullscreenchange', () => setTimeout(replace, 150));
  document.addEventListener('webkitfullscreenchange', () => setTimeout(replace, 150));

  // ---------------------------------------------------------------- pistes <track> natives
  let curTrack = null;
  const hiddenTracks = new Set();

  function scanTracks() {
    if (!video || !settings.enabled || (cueSource === 'net' && cues.length)) return;
    const tracks = [...video.textTracks].filter(
      (t) => (t.kind === 'subtitles' || t.kind === 'captions') && t.mode !== 'disabled' && t.cues && t.cues.length
    );
    if (!tracks.length) {
      if (cueSource === 'track') resetCues();
      return;
    }
    // la piste que l'utilisateur vient de choisir (affichée par le navigateur) est prioritaire
    const t = tracks.find((x) => x.mode === 'showing' && !hiddenTracks.has(x)) || (tracks.includes(curTrack) ? curTrack : tracks[0]);
    if (t.mode === 'showing') {
      t.mode = 'hidden'; // le navigateur ne la dessine plus, c'est nous qui affichons
      hiddenTracks.add(t);
    }
    if (t === curTrack && cues.length === t.cues.length) return;
    curTrack = t;
    const list = [...t.cues].map((c) => ({ start: c.startTime, end: c.endTime, text: clean(c.text) })).filter((c) => c.text);
    setCues(list, 'track', null);
  }

  function restoreTracks() {
    hiddenTracks.forEach((t) => t.mode === 'hidden' && (t.mode = 'showing'));
    hiddenTracks.clear();
  }

  // ---------------------------------------------------------------- YouTube : activer les sous-titres automatiquement
  // jusqu'à 3 essais par vidéo (le lecteur ignore parfois un clic trop précoce),
  // puis on arrête : si tu coupes les sous-titres toi-même, on ne les rallume pas.
  let autoCCVideo = null;
  let autoCCTries = 0;
  let autoCCNext = 0;
  function autoCC() {
    if (!IS_YT || !settings.enabled || !settings.autoCC || !video || video.readyState < 1) return;
    const id = ytId();
    if (!id) return;
    if (id !== autoCCVideo) {
      autoCCVideo = id;
      autoCCTries = 0;
      autoCCNext = 0;
    }
    if (autoCCTries >= 3 || Date.now() < autoCCNext) return;
    const player = video.closest('.html5-video-player');
    if (player && player.classList.contains('ad-showing')) return;
    const b = (player || document).querySelector('.ytp-subtitles-button');
    if (!b || !b.offsetWidth) return;
    if (b.getAttribute('aria-pressed') !== 'false') {
      autoCCTries = 3; // déjà allumés
      return;
    }
    autoCCTries++;
    autoCCNext = Date.now() + 1500;
    b.click();
  }

  // ---------------------------------------------------------------- repli : lire les sous-titres affichés
  const CAPTION_SELECTORS = [
    '.ytp-caption-window-container',
    '.vjs-text-track-display',
    '.jw-captions',
    '.plyr__captions',
    '.shaka-text-container',
    '.bmpui-ui-subtitle-overlay',
    '.player-timedtext',
    '[class*="subtitle" i]:not(.stfr-overlay)',
  ].join(',');
  const live = { orig: '', tr: '', timer: null };

  function scanDom() {
    if (!settings.enabled || cues.length || !video) return;
    if (IS_YT && !ytId()) return; // aperçus au survol de la page d'accueil
    let text = '';
    for (const box of document.querySelectorAll(IS_YT ? '.ytp-caption-window-container' : CAPTION_SELECTORS)) {
      if (box.closest('.stfr-overlay') || !sameArea(box, video)) continue;
      const t = clean(box.innerText);
      if (t && t.length < 300) {
        text = t;
        break;
      }
    }
    if (text === live.pendingText) return;
    live.pendingText = text;
    clearTimeout(live.timer);
    if (!text) {
      live.timer = setTimeout(() => {
        live.orig = '';
        live.tr = '';
        refresh();
      }, 300);
      return;
    }
    live.timer = setTimeout(() => {
      const target = settings.target;
      live.orig = text;
      live.tr = bestTr(text)[0] || '';
      refresh();
      if (!live.tr) {
        // en direct, on privilégie la vitesse : Google
        sendMsg({ type: 'translate', texts: [text], target, engine: 'google' }, (res) => {
          if (!res || !res.ok) return;
          trCache.set(ck(target, 'google', text), res.result[0]);
          if (live.orig === text) {
            live.tr = res.result[0];
            lastKey = null;
          }
        });
      }
    }, 150);
  }

  function sameArea(box, v) {
    const a = box.getBoundingClientRect();
    const b = v.getBoundingClientRect();
    return a.width > 0 && a.left >= b.left - 5 && a.right <= b.right + 5 && a.top >= b.top - 5 && a.bottom <= b.bottom + 5;
  }

  let scanQueued = false;
  new MutationObserver((muts) => {
    if (scanQueued || cues.length || !settings.enabled) return;
    if (muts.every((m) => (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest?.('.stfr-overlay'))) return;
    if (!document.querySelector('video')) return;
    scanQueued = true;
    // au plus une lecture tous les 120 ms : YouTube modifie sa page en permanence
    setTimeout(() => {
      scanQueued = false;
      scanDom();
    }, 120);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // ---------------------------------------------------------------- entretien (toutes les 0,5 s)
  let tickCount = 0;
  const tick = setInterval(() => {
    // l'extension a été rechargée (mise à jour) : cette ancienne copie s'efface, la nouvelle prend le relais
    if (!chrome.runtime || !chrome.runtime.id) {
      clearInterval(tick);
      settings.enabled = false;
      cues = [];
      if (overlay) overlay.remove();
      document.documentElement.classList.remove('stfr-on');
      document.querySelectorAll('.stfr-native').forEach((e) => e.classList.remove('stfr-native'));
      return;
    }
    const v = pickVideo();
    if (v !== video) {
      video = v;
      lastKey = null;
      // filet de sécurité si requestAnimationFrame est suspendu (onglet en arrière-plan, image dans l'image…)
      if (v && !v.__stfrEv) {
        v.__stfrEv = true;
        for (const ev of ['seeked', 'timeupdate', 'play', 'ratechange']) v.addEventListener(ev, () => v === video && render());
        v.addEventListener('seeked', () => v === video && urgentNear());
      }
    }
    render();
    if (IS_YT) {
      const id = ytId();
      if (cueVideoId && id !== cueVideoId) resetCues();
      if (!cues.length && id && netCache.has(id)) setCues(netCache.get(id), 'net', id);
    }
    scanTracks();
    autoCC();
    if ((tickCount = (tickCount + 1) % 2) === 0) followSiteTrack(); // une fois par seconde
    if (overlay && video && overlay.style.display !== 'none') place(video, overlay);
    startLoop();
  }, 500);

  if (IS_YT) document.addEventListener('yt-navigate-start', () => resetCues());
})();
