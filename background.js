// Service worker : traduit des lots de phrases.
// Moteurs :
//  - "google"    : gratuit (Google Traduction, Microsoft Edge en relais), par défaut ;
//  - "microsoft" : gratuit (Microsoft Edge d'abord, Google en relais) ;
//  - "claude"    : API Claude avec ta clé, traduction avec le contexte ;
//  - "ollama"    : modèle local sur ce Mac (Ollama), avec le contexte, gratuit et privé.
// Si le moteur choisi échoue, on bascule automatiquement sur les traducteurs gratuits : jamais d'écran vide.

const PARALLEL = 2; // Google : 2 demandes à la fois au maximum
const HY_MODEL = 'hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL';
const cache = new Map();

// =====================================================================  mise à jour automatique
// Extension chargée « non empaquetée » : quand une nouvelle version est déposée dans le dossier
// (fichier version.txt modifié), l'extension se recharge toute seule. Rien à faire dans chrome://extensions.
let lastCheck = 0;
async function checkUpdate() {
  if (Date.now() - lastCheck < 5000) return;
  lastCheck = Date.now();
  try {
    const self = await chrome.management.getSelf();
    if (self.installType !== 'development') return;
    const r = await fetch(chrome.runtime.getURL('version.txt'), { cache: 'no-store' });
    const onDisk = (await r.text()).trim();
    if (!onDisk || onDisk === chrome.runtime.getManifest().version) return;
    // sécurité anti-boucle : une seule tentative par numéro de version
    const { reloadedFor } = await chrome.storage.local.get('reloadedFor');
    if (reloadedFor === onDisk) return;
    await chrome.storage.local.set({ reloadedFor: onDisk });
    chrome.runtime.reload();
  } catch (_) {}
}
chrome.alarms.create('stfr-update', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'stfr-update' && checkUpdate());
checkUpdate();

// Pour chaque onglet (et cadre), la dernière page qui a demandé des traductions. Les demandes d'une page
// rechargée ou quittée ne servent plus à rien : le moteur local les saute au lieu de faire attendre les autres.
const latestPage = new Map();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'translate' || !Array.isArray(msg.texts)) return;
  checkUpdate();
  const where = sender && sender.tab ? sender.tab.id + '/' + (sender.frameId || 0) : null;
  if (where && msg.page) latestPage.set(where, msg.page);
  msg.alive = () => !where || !msg.page || latestPage.get(where) === msg.page;
  msg.seq = ++msgSeq;
  if (msg.urgent) msg.seq -= 1e9; // scène où l'on vient de sauter : avant tout le reste
  handle(msg)
    .then((res) => sendResponse({ ...res, warn: lastWarn }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

async function handle(msg) {
  const target = msg.target || 'fr';
  await loadCache();
  const cfg = await chrome.storage.local.get({
    apiKey: '', model: 'claude-haiku-5-5',
    ollamaUrl: 'http://localhost:11434', ollamaModel: 'hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL',
    workContext: '', glossary: '',
  });
  const context = { ...(msg.context || {}), work: cfg.workContext, glossary: cfg.glossary };

  if (msg.engine === 'claude') {
    if (cfg.apiKey) {
      try {
        const result = await claudeBatch(msg.texts, target, context, cfg.apiKey, cfg.model);
        await warn(null);
        return { ok: true, engine: 'claude', result };
      } catch (e) {
        await warn(String(e.message || e));
      }
    } else {
      await warn('Pas de clé API Claude : traduction gratuite utilisée.');
    }
  }

  if (msg.engine === 'ollama') {
    try {
      const result = await ollamaBatch(msg.texts, target, context, cfg, msg.alive, msg.seq);
      await warn(null);
      return { ok: true, engine: 'ollama', result };
    } catch (e) {
      await warn(String(e.message || e) + ' Traduction gratuite utilisée en attendant.');
    }
  }

  if (msg.engine === 'microsoft') {
    const result = await msFirstBatch(msg.texts, target);
    return { ok: true, engine: 'microsoft', result };
  }

  return { ok: true, engine: 'google', result: await freeBatch(msg.texts, target) };
}

// Avertissement discret : un « ! » sur l'icône de l'extension, et le message dans son menu.
let lastWarn = null;
async function warn(text) {
  lastWarn = text;
  await setStatus(text);
  try {
    await chrome.action.setBadgeText({ text: text ? '!' : '' });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
    await chrome.action.setTitle({ title: text ? 'Sous-titres FR : ' + text : 'Sous-titres FR' });
  } catch (_) {}
}

function setStatus(text) {
  return chrome.storage.local.set({ status: text ? { text, at: Date.now() } : null });
}

// --- files d'attente séparées : Claude ne bloque jamais Google (qui sert l'affichage immédiat)
function makeLimiter(max) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    while (active >= max) await new Promise((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = waiting.shift();
      if (next) next();
    }
  };
}
const slot = makeLimiter(PARALLEL); // Google
const claudeSlot = makeLimiter(3); // Claude : 3 à la fois, pour rester sous les limites des petits comptes

// Cache durable (stockage local de Chrome) : un épisode déjà traduit ne redemande plus rien,
// même après un redémarrage de Chrome.
let cacheLoaded = null;
function loadCache() {
  if (!cacheLoaded) {
    cacheLoaded = chrome.storage.local
      .get('tcache')
      .then(({ tcache }) => {
        if (tcache) for (const k in tcache) if (!cache.has(k)) cache.set(k, tcache[k]);
      })
      .catch(() => {});
  }
  return cacheLoaded;
}
let saveTimer = null;
function remember(k, v) {
  cache.delete(k);
  cache.set(k, v);
  if (cache.size > 30000) cache.delete(cache.keys().next().value);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ tcache: Object.fromEntries(cache) }).catch(() => {}), 1500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================  Claude
const LANGS = {
  fr: 'français', en: 'anglais', es: 'espagnol', de: 'allemand', it: 'italien',
  pt: 'portugais', ar: 'arabe', 'zh-CN': 'chinois simplifié', ja: 'japonais',
};

async function claudeBatch(texts, target, context, key, model) {
  const out = new Array(texts.length).fill(null);
  const todo = [];
  texts.forEach((t, i) => {
    const hit = cache.get(`claude|${model}|${target}|${t}`);
    if (hit) out[i] = hit;
    else todo.push(i);
  });

  const CHUNK = 40;
  const chunks = [];
  for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));

  let authError = null;
  await Promise.all(
    chunks.map(async (idx, n) => {
      const lines = idx.map((i) => texts[i]);
      // contexte : pour le 1er paquet celui envoyé par la page, pour les suivants la fin du paquet précédent
      const before = n === 0 ? context.before || [] : chunks[n - 1].slice(-4).map((i) => texts[i]);
      try {
        const res = await claudeSlot(() => claudeCall(lines, target, { ...context, before }, key, model));
        res.forEach((v, k) => {
          if (v) {
            out[idx[k]] = v;
            remember(`claude|${model}|${target}|${lines[k]}`, v);
          }
        });
      } catch (e) {
        if (e.auth) authError = e;
      }
    })
  );
  if (authError) throw authError;

  // les lignes que Claude n'a pas rendues -> Google
  const missing = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const g = await freeBatch(missing.map((i) => texts[i]), target);
    missing.forEach((i, k) => (out[i] = g[k]));
  } else {
    setStatus(null);
  }
  return out;
}

async function claudeCall(lines, target, context, key, model) {
  const lang = LANGS[target] || target;
  const system =
    `Tu traduis des sous-titres de vidéo en ${lang}.\n` +
    `Règles :\n` +
    `- Chaque ligne d'entrée porte un numéro ; rends exactement une ligne traduite par numéro, au format "numéro|traduction".\n` +
    `- Une phrase peut être coupée sur deux lignes qui se suivent : traduis la phrase entière, puis répartis-la sur les mêmes numéros pour que chaque ligne reste en phase avec ce qui est dit. Ne fusionne jamais deux numéros et n'en saute aucun.\n` +
    `- Les sous-titres peuvent être automatiques : corrige les erreurs de reconnaissance évidentes et la ponctuation manquante, sans rien inventer.\n` +
    `- Style naturel et parlé, concis et facile à lire comme un sous-titre. Garde les noms propres. Une ligne déjà en ${lang} est recopiée telle quelle.\n` +
    `- Le titre et les lignes précédentes servent seulement de contexte (sujet, ton, tutoiement ou vouvoiement, vocabulaire récurrent) : ne les traduis pas.\n` +
    `- Réponds uniquement avec les lignes "numéro|traduction", sans aucun autre texte.`;
  let user = '';
  if (context.work) user += `Œuvre : ${context.work}\n`;
  if (context.glossary) user += `Glossaire à respecter (terme = traduction imposée) :\n${context.glossary}\n`;
  if (context.title) user += `Titre de la vidéo : ${context.title}\n`;
  if (context.before && context.before.length) user += `Lignes précédentes (contexte) :\n${context.before.join('\n')}\n`;
  user += `\nLignes à traduire :\n` + lines.map((l, i) => `${i + 1}|${l.replace(/[\n|]/g, ' ')}`).join('\n');

  for (let attempt = 0; ; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (r.ok) {
      const j = await r.json();
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const res = new Array(lines.length).fill(null);
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*(\d+)\s*\|\s*(.*?)\s*$/);
        if (m && +m[1] >= 1 && +m[1] <= lines.length && m[2]) res[+m[1] - 1] = m[2];
      }
      return res;
    }
    if (r.status === 401 || r.status === 403) {
      const e = new Error('Clé API Claude refusée : vérifie-la dans les réglages de l\'extension.');
      e.auth = true;
      throw e;
    }
    if (r.status === 404 || r.status === 400) {
      const e = new Error('Requête refusée par Claude (' + r.status + ') : modèle indisponible ?');
      e.auth = true;
      throw e;
    }
    if (attempt >= 4 || ![429, 500, 502, 503, 529].includes(r.status)) throw new Error('Claude HTTP ' + r.status);
    // limite de débit : on attend le temps demandé par l'API (en-tête retry-after), sinon 1 s, 2 s, 4 s…
    const ra = parseFloat(r.headers.get('retry-after'));
    await sleep(Math.min(20000, isFinite(ra) ? ra * 1000 : 1000 * 2 ** attempt));
  }
}

// =====================================================================  Google
// Envoi en POST : jusqu'à ~5000 caractères (≈ 120 répliques) par demande, donc un épisode entier
// en quelques demandes seulement. Demandes espacées pour ne pas déclencher le blocage « 429 » de Google.
const MAX_CHUNK = 5000; // caractères de texte par demande
let nextGoogleAt = 0;
async function pace() {
  const wait = nextGoogleAt - Date.now();
  nextGoogleAt = Math.max(Date.now(), nextGoogleAt) + 300;
  if (wait > 0) await sleep(wait);
}

async function googleBatch(texts, target) {
  await loadCache();
  const out = new Array(texts.length).fill(null);
  const todo = [];
  texts.forEach((t, i) => {
    const hit = cache.get(`google|${target}|${t}`);
    if (hit != null) out[i] = hit;
    else todo.push(i);
  });

  const chunks = [];
  let cur = [];
  let len = 0;
  for (const i of todo) {
    const l = texts[i].length + 1;
    if (cur.length && len + l > MAX_CHUNK) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += l;
  }
  if (cur.length) chunks.push(cur);

  let failed = 0;
  await Promise.all(
    chunks.map(async (idx) => {
      const lines = idx.map((i) => texts[i]);
      try {
        const res = await slot(() => gtx(lines, target));
        res.forEach((v, k) => {
          if (!v) return;
          out[idx[k]] = v;
          remember(`google|${target}|${lines[k]}`, v);
        });
      } catch (e) {
        failed++; // ce paquet reste vide ; la page redemandera plus tard
        lastGoogleError = String(e && e.message || e);
      }
    })
  );
  if (failed && failed === chunks.length && !out.some(Boolean)) throw new Error('Google indisponible (trop de demandes), nouvel essai bientôt');
  return out;
}

let googleBlockedUntil = 0;
async function gcall(q, target) {
  for (let a = 0; ; a++) {
    if (Date.now() < googleBlockedUntil) throw new Error('Google en pause');
    await pace();
    const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=' + encodeURIComponent(target), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'q=' + encodeURIComponent(q),
    });
    if (r.ok) {
      const j = await r.json();
      return (j[0] || []).map((s) => s[0] || '').join('');
    }
    if (r.status === 429 && a >= 1) {
      // Google bloque : on le laisse au repos 5 minutes, Microsoft prend le relais
      googleBlockedUntil = Date.now() + 5 * 60e3;
      throw new Error('HTTP 429');
    }
    if (a >= 4 || (r.status !== 429 && r.status < 500)) throw new Error('HTTP ' + r.status);
    // Google demande de ralentir : on espace beaucoup plus les demandes suivantes
    nextGoogleAt = Date.now() + 1000 * 2 ** a; // 1 s, 2 s, 4 s, 8 s
  }
}

async function gtx(lines, target) {
  const full = await gcall(lines.join('\n'), target);
  const parts = full.split('\n');
  if (parts.length === lines.length) return parts.map((p) => p.trim());
  if (lines.length === 1) return [full.trim()];
  const mid = lines.length >> 1;
  const a = await gtx(lines.slice(0, mid), target);
  const b = await gtx(lines.slice(mid), target);
  return a.concat(b);
}

// =====================================================================  Microsoft (relais gratuit)
// Traducteur gratuit intégré au navigateur Edge (adresse « translatetext », sans jeton).
// Il reçoit une liste de phrases (jusqu'à 1000 / 50 000 caractères) et rend une traduction par phrase,
// sans risque de décalage entre les lignes.
const MS_LANG = { 'zh-CN': 'zh-Hans' };
let lastMsError = '';
let lastGoogleError = '';

async function msBatch(texts, target) {
  const to = MS_LANG[target] || target;
  const out = new Array(texts.length).fill(null);
  const chunks = [];
  let cur = [];
  let len = 0;
  texts.forEach((t, i) => {
    if (cur.length && (cur.length >= 500 || len + t.length > 40000)) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += t.length;
  });
  if (cur.length) chunks.push(cur);
  for (const idx of chunks) {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch('https://edge.microsoft.com/translate/translatetext?from=&to=' + encodeURIComponent(to) + '&isEnterpriseClient=false', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(idx.map((i) => texts[i])),
        });
        if (!r.ok) throw new Error('Microsoft HTTP ' + r.status);
        const j = await r.json();
        j.forEach((x, k) => {
          const v = typeof x === 'string' ? x : x && x.translations && x.translations[0] && x.translations[0].text;
          if (v) out[idx[k]] = v;
        });
        break;
      } catch (e) {
        lastMsError = String((e && e.message) || e);
        await sleep(800 * (a + 1));
      }
    }
  }
  return out;
}

// Moteur gratuit : Google d'abord, Microsoft pour tout ce que Google n'a pas rendu.
async function freeBatch(texts, target) {
  await loadCache();
  let out = new Array(texts.length).fill(null);
  try {
    out = await googleBatch(texts, target);
  } catch (e) {
    lastGoogleError = String(e && e.message || e);
  }
  const missing = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const ms = await msBatch(missing.map((i) => texts[i]), target).catch(() => []);
    missing.forEach((i, k) => {
      if (ms[k]) {
        out[i] = ms[k];
        remember(`google|${target}|${texts[i]}`, ms[k]);
      }
    });
  }
  if (!out.some(Boolean) && texts.length) throw new Error('Traducteurs gratuits indisponibles pour le moment (Google : ' + lastGoogleError + ' / Microsoft : ' + lastMsError + ')');
  return out;
}

// =====================================================================  Microsoft d'abord
async function msFirstBatch(texts, target) {
  await loadCache();
  const out = new Array(texts.length).fill(null);
  const todo = [];
  texts.forEach((t, i) => {
    const hit = cache.get(`microsoft|${target}|${t}`);
    if (hit) out[i] = hit;
    else todo.push(i);
  });
  if (todo.length) {
    const ms = await msBatch(todo.map((i) => texts[i]), target).catch(() => []);
    todo.forEach((i, k) => {
      if (ms[k]) {
        out[i] = ms[k];
        remember(`microsoft|${target}|${texts[i]}`, ms[k]);
      }
    });
  }
  const missing = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const g = await freeBatch(missing.map((i) => texts[i]), target);
    missing.forEach((i, k) => (out[i] = g[k]));
  }
  return out;
}

// =====================================================================  Local : Ollama
// Un vrai modèle de langage qui tourne sur ce Mac (par défaut qwen3:8b). Il traduit par scène :
// 30 répliques numérotées à la fois, avec les 5 précédentes comme contexte, le contexte de l'œuvre
// et le glossaire. Rien ne sort de l'ordinateur. Une seule demande à la fois (le Mac travaille).
// File à priorité : un paquet arrivé plus tôt (la scène en cours) passe entièrement avant les suivants,
// au lieu que tous les paquets avancent d'une réplique chacun à tour de rôle.
function makePrioLimiter(max) {
  let active = 0;
  const waiting = []; // { prio, resolve }
  return async (fn, prio = 0) => {
    if (active >= max) {
      await new Promise((resolve) => {
        waiting.push({ prio, resolve });
        waiting.sort((a, b) => a.prio - b.prio);
      });
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = waiting.shift();
      if (next) next.resolve();
    }
  };
}
const ollamaSlot = makePrioLimiter(1);
let msgSeq = 0;
const OLLAMA_CHUNK = 30;

function ollamaError(e, cfg) {
  const m = String((e && e.message) || e);
  const err = new Error(m);
  err.connection = true;
  return err;
}

async function ollamaBatch(texts, target, context, cfg, alive = () => true, prio = 0) {
  const base = (cfg.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const model = cfg.ollamaModel || 'hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL';
  // « L » = traduction réplique par réplique (les anciennes traductions par lot de Hy-MT2 sont ignorées)
  const key = (t) => `${/hy-mt/i.test(model) ? 'ollamaL' : 'ollama'}|${model}|${target}|${t}`;
  const out = new Array(texts.length).fill(null);
  const todo = [];
  texts.forEach((t, i) => {
    const hit = cache.get(key(t));
    if (hit) out[i] = hit;
    else todo.push(i);
  });

  // Hy-MT2 est fait pour traduire un texte à la fois : on lui envoie chaque réplique seule, avec ses voisines
  // comme contexte. Impossible alors qu'une réplique « glisse » sur la suivante (décalage).
  if (/hy-mt/i.test(model)) {
    let done = 0;
    for (const i of todo) {
      const before = (context.before || []).concat(texts.slice(0, i)).slice(-5);
      const after = texts.slice(i + 1, i + 3);
      let v = null;
      try {
        v = await ollamaSlot(() => (alive() ? hyLine(base, model, texts[i], target, { ...context, before, after }) : 'STOP'), prio);
      } catch (e) {
        if (e.connection && done === 0) throw e;
      }
      if (v === 'STOP') return out; // page fermée ou rechargée : on abandonne
      if (v) {
        out[i] = v;
        remember(key(texts[i]), v);
        done++;
      }
    }
    const missing = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    if (missing.length && alive()) {
      const g = await freeBatch(missing.map((i) => texts[i]), target).catch(() => []);
      missing.forEach((i, k) => (out[i] = g[k] || null));
    }
    return out;
  }

  const chunks = [];
  for (let i = 0; i < todo.length; i += OLLAMA_CHUNK) chunks.push(todo.slice(i, i + OLLAMA_CHUNK));
  let done = 0;
  for (let n = 0; n < chunks.length; n++) {
    const idx = chunks[n];
    const lines = idx.map((i) => texts[i]);
    const before = n === 0 ? context.before || [] : chunks[n - 1].slice(-5).map((i) => texts[i]);
    let res = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await ollamaSlot(() => (alive() ? ollamaCall(base, model, lines, target, { ...context, before }) : null), prio);
        if (res === null && !alive()) return out; // page fermée ou rechargée : on abandonne
      } catch (e) {
        // Ollama absent ou qui refuse l'extension : inutile d'insister, on bascule tout de suite
        if (e.connection && done === 0) throw e;
        res = null;
      }
      if (res && res.every(Boolean)) break; // complet : pas besoin de refaire le lot
    }
    if (res) {
      res.forEach((v, k) => {
        if (v) {
          out[idx[k]] = v;
          remember(key(lines[k]), v);
        }
      });
      done++;
    }
  }

  // répliques que le modèle local n'a pas rendues -> traducteurs gratuits
  const missing = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const g = await freeBatch(missing.map((i) => texts[i]), target).catch(() => []);
    missing.forEach((i, k) => (out[i] = g[k] || null));
  }
  return out;
}

async function ollamaCall(base, model, lines, target, context) {
  if (/hy-mt/i.test(model)) return hyCall(base, model, lines, target, context);
  const lang = LANGS[target] || target;
  const system =
    `Tu es un traducteur professionnel de sous-titres. Tu traduis en ${lang}.\n` +
    `Règles :\n` +
    `- ${lang[0].toUpperCase() + lang.slice(1)} naturel, fidèle au ton et au registre de chaque personnage, concis et lisible comme un sous-titre.\n` +
    `- Si le texte source est lui-même une traduction maladroite (par exemple de l'anglais traduit du chinois), retrouve le sens d'origine le plus probable, sans rien inventer.\n` +
    `- Une phrase peut être coupée sur plusieurs répliques qui se suivent : traduis l'ensemble, puis répartis-le sur les mêmes numéros. Ne fusionne jamais deux numéros et n'en saute aucun.\n` +
    `- Garde les noms propres, les titres et les rangs identiques d'une réplique à l'autre, et respecte strictement le glossaire.\n` +
    `- Les répliques précédentes servent uniquement de contexte : ne les traduis pas.\n` +
    `- Réponds UNIQUEMENT avec un objet JSON de la forme {"1": "...", "2": "..."}, avec exactement les numéros reçus, sans aucun autre texte.`;
  let user = '';
  if (context.work) user += `Œuvre : ${context.work}\n`;
  else if (context.title) user += `Titre de la vidéo : ${context.title}\n`;
  if (context.glossary) user += `Glossaire (terme = traduction imposée) :\n${context.glossary}\n`;
  if (context.before && context.before.length) user += `Répliques précédentes (contexte, ne pas traduire) :\n${context.before.join('\n')}\n`;
  const obj = {};
  lines.forEach((l, i) => (obj[i + 1] = l));
  user += `\nRépliques à traduire :\n${JSON.stringify(obj, null, 0)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let r;
  try {
    r = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: 'json',
        options: { temperature: 0.2, num_ctx: 8192 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (e) {
    throw ollamaError(new Error('Ollama ne répond pas (pas lancé ?).'));
  } finally {
    clearTimeout(timer);
  }
  if (r.status === 403) throw ollamaError(new Error('Ollama refuse l\'extension (erreur 403) : OLLAMA_ORIGINS n\'est pas réglé.'));
  if (r.status === 404) {
    startPull(base, model);
    throw ollamaError(new Error(pullState.text || `Téléchargement du modèle « ${shortName(model)} » dans Ollama…`));
  }
  if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
  const j = await r.json();
  let text = (j.message && j.message.content) || '';
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  const res = new Array(lines.length).fill(null);
  if (a < 0 || b <= a) return res;
  let parsed = {};
  try {
    parsed = JSON.parse(text.slice(a, b + 1));
  } catch (_) {
    return res;
  }
  for (const k in parsed) {
    const n = parseInt(k, 10);
    const v = typeof parsed[k] === 'string' ? parsed[k].trim() : '';
    if (n >= 1 && n <= lines.length && v) res[n - 1] = v;
  }
  return res;
}

// ---------------------------------------------------------------------  Hy-MT2 (Tencent)
// Modèle spécialisé en traduction. On suit les modèles de consigne publiés par Tencent :
// « Background Information » (contexte de l'œuvre + répliques précédentes), « Reference the following
// translations » (glossaire) et « Structured Data » (JSON : les numéros restent, seules les répliques
// sont traduites). Pas de consigne système, réglages recommandés par Tencent.
const LANGS_EN = {
  fr: 'French', en: 'English', es: 'Spanish', de: 'German', it: 'Italian',
  pt: 'Portuguese', ar: 'Arabic', 'zh-CN': 'Simplified Chinese', ja: 'Japanese',
};

async function hyCall(base, model, lines, target, context) {
  const lang = LANGS_EN[target] || target;
  let p = '';
  const bg = [];
  if (context.work) bg.push(context.work);
  else if (context.title) bg.push('Video title: ' + context.title);
  bg.push('These are consecutive subtitle lines of a video; a sentence can continue on the next line.');
  if (context.before && context.before.length) bg.push('Previous lines (context only, do not translate):\n' + context.before.join('\n'));
  p += '[Background Information]\n' + bg.join('\n') + '\n\n';
  const gl = String(context.glossary || '')
    .split('\n')
    .map((l) => l.split('='))
    .filter((x) => x.length === 2 && x[0].trim() && x[1].trim());
  if (gl.length) p += 'Reference the following translations:\n' + gl.map(([a, b]) => `${a.trim()} translates to ${b.trim()}`).join('\n') + '\n\n';
  const obj = {};
  lines.forEach((l, i) => (obj[i + 1] = l));
  p +=
    '### Task\n' +
    `Translate the user-facing text within the following JSON data into ${lang}, taking the provided background information into consideration. ` +
    'Use natural spoken language that fits each character, and keep names and titles consistent.\n' +
    '### Strict Rules\n' +
    '1. **Structure Preservation:** You MUST preserve the original JSON data structure exactly as it is: same keys, same number of entries.\n' +
    '2. **Selective Translation:** Translate ONLY the values (the subtitle lines).\n' +
    '3. **Strict Non-Translation:** NEVER translate or alter the keys. Leave them exactly in their original form.\n' +
    'Only output the translated JSON, without any additional explanation.\n' +
    '### Source Data\n' +
    JSON.stringify(obj);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let r;
  try {
    r = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05, num_ctx: 8192, num_predict: 80 + 60 * lines.length },
        messages: [{ role: 'user', content: p }],
      }),
    });
  } catch (e) {
    throw ollamaError(new Error('Ollama ne répond pas (pas lancé ?).'));
  } finally {
    clearTimeout(timer);
  }
  if (r.status === 403) throw ollamaError(new Error("Ollama refuse l'extension (erreur 403)."));
  if (r.status === 404) {
    startPull(base, model);
    throw ollamaError(new Error(pullState.text || `Téléchargement du modèle « ${shortName(model)} » dans Ollama…`));
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error('Ollama HTTP ' + r.status + (body ? ' : ' + body.slice(0, 160) : ''));
  }
  const j = await r.json();
  return parseNumbered((j.message && j.message.content) || '', lines.length);
}

function parseNumbered(text, n) {
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const res = new Array(n).fill(null);
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return res;
  let parsed = {};
  try {
    parsed = JSON.parse(text.slice(a, b + 1));
  } catch (_) {
    return res;
  }
  for (const k in parsed) {
    const i = parseInt(k, 10);
    const v = typeof parsed[k] === 'string' ? parsed[k].trim() : '';
    if (i >= 1 && i <= n && v) res[i - 1] = v;
  }
  return res;
}

// ---------------------------------------------------------------------  installation automatique du modèle
// Si le modèle n'est pas encore dans Ollama, l'extension le télécharge elle-même (comme « ollama pull »).
// Le téléchargement reprend là où il s'était arrêté si Chrome ou Ollama redémarrent.
const pullState = { running: false, text: '', model: '' };
const shortName = (m) => String(m).replace(/^hf\.co\/[^/]+\//, '').replace(/-GGUF/i, '');

async function startPull(base, model) {
  if (pullState.running) return;
  pullState.running = true;
  pullState.model = model;
  pullState.text = `Téléchargement du modèle ${shortName(model)} dans Ollama…`;
  await chrome.storage.local.set({ pullWanted: { base, model } });
  try {
    const r = await fetch(base + '/api/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let lastPct = -1;
    let ok = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (ev.error) throw new Error(ev.error);
        if (ev.total && ev.completed) {
          const pct = Math.floor((ev.completed / ev.total) * 100);
          if (pct !== lastPct && pct % 2 === 0) {
            lastPct = pct;
            pullState.text = `Téléchargement du modèle ${shortName(model)} : ${pct} % (${(ev.total / 1e9).toFixed(1)} Go). Traduction Google en attendant.`;
            await warn(pullState.text);
          }
        }
        if (ev.status === 'success') ok = true;
      }
    }
    if (!ok) throw new Error('téléchargement interrompu');
    pullState.text = '';
    await chrome.storage.local.set({ pullWanted: null, ollamaReadyAt: Date.now() });
    await warn(null);
  } catch (e) {
    pullState.text = `Téléchargement du modèle interrompu (${(e && e.message) || e}), reprise automatique bientôt.`;
    await warn(pullState.text);
  } finally {
    pullState.running = false;
  }
}

// reprise d'un téléchargement interrompu (Chrome fermé, Mac en veille…), vérifiée toutes les 30 s
async function resumePull() {
  const { pullWanted } = await chrome.storage.local.get('pullWanted');
  if (pullWanted && !pullState.running) startPull(pullWanted.base, pullWanted.model);
}
chrome.alarms.onAlarm.addListener((a) => a.name === 'stfr-update' && resumePull());

// ---------------------------------------------------------------------  accès à Ollama sans réglage
// Ollama refuse par défaut les demandes venant d'une extension (en-tête Origin « chrome-extension:// »)
// tant qu'on n'a pas réglé OLLAMA_ORIGINS dans le Terminal. Pour s'en passer, on retire cet en-tête,
// mais UNIQUEMENT pour les demandes faites par cette extension vers Ollama sur ce Mac.
// Les sites web, eux, restent bloqués par Ollama comme avant.
async function allowOllama() {
  try {
    const id = chrome.runtime.id;
    const rules = ['localhost', '127.0.0.1'].map((host, i) => ({
      id: 9001 + i,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
      condition: { urlFilter: `|http://${host}:11434/`, initiatorDomains: [id], resourceTypes: ['xmlhttprequest', 'other'] },
    }));
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id), addRules: rules });
  } catch (_) {}
}
allowOllama();

// ---------------------------------------------------------------------  passage à Hy-MT2 (demandé par l'utilisateur)
// Une seule fois, à l'installation de cette version : moteur « Local » avec Hy-MT2. Ensuite, c'est le
// choix fait dans le menu qui compte.
(async () => {
  try {
    const { migr080 } = await chrome.storage.local.get('migr080');
    if (migr080) return;
    const { ollamaModel } = await chrome.storage.local.get('ollamaModel');
    const set = { migr080: true };
    if (!ollamaModel || ollamaModel === 'qwen3:8b') set.ollamaModel = HY_MODEL;
    await chrome.storage.local.set(set);
    await chrome.storage.sync.set({ engine: 'ollama' });
  } catch (_) {}
})();

// Une réplique avec le modèle de consigne « contexte » de Tencent ([Background Information] / [Source Text]).
async function hyLine(base, model, line, target, context) {
  const lang = LANGS_EN[target] || target;
  const bg = [];
  if (context.work) bg.push(context.work);
  else if (context.title) bg.push('Video title: ' + context.title);
  bg.push('The text is one subtitle line of a video.');
  if (context.before && context.before.length) bg.push('Previous subtitle lines:\n' + context.before.join('\n'));
  if (context.after && context.after.length) bg.push('Next subtitle lines:\n' + context.after.join('\n'));
  let p = '';
  const gl = String(context.glossary || '')
    .split('\n')
    .map((l) => l.split('='))
    .filter((x) => x.length === 2 && x[0].trim() && x[1].trim());
  if (gl.length) p += 'Reference the following translations:\n' + gl.map(([a, b]) => `${a.trim()} translates to ${b.trim()}`).join('\n') + '\n\n';
  p +=
    '[Background Information]\n' + bg.join('\n') + '\n\n' +
    `Please translate the following text into ${lang}, taking the provided background information into consideration. ` +
    'Translate ONLY the source text, not the previous or next lines. ' +
    'Note that you should only output the translated result without any additional explanation.\n' +
    '[Source Text]\n' + line;

  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let r;
    try {
      r = await fetch(base + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          stream: false,
          options: {
            temperature: attempt ? 0.2 : 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05,
            num_ctx: 4096, num_predict: 40 + line.length * 2,
          },
          messages: [{ role: 'user', content: p }],
        }),
      });
    } catch (e) {
      throw ollamaError(new Error('Ollama ne répond pas (pas lancé ?).'));
    } finally {
      clearTimeout(timer);
    }
    if (r.status === 403) throw ollamaError(new Error("Ollama refuse l'extension (erreur 403)."));
    if (r.status === 404) {
      startPull(base, model);
      throw ollamaError(new Error(pullState.text || `Téléchargement du modèle « ${shortName(model)} » dans Ollama…`));
    }
    if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
    const j = await r.json();
    let v = ((j.message && j.message.content) || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    v = v.replace(/^\[?(Translation|Traduction)\]?\s*:?\s*/i, '').replace(/^["«“]\s*|\s*["»”]$/g, '').split('\n')[0].trim();
    // garde-fou : une traduction 3 fois plus longue que l'original a sans doute traduit les voisines aussi
    if (v && v.length <= line.length * 3 + 30) return v;
  }
  return null;
}
