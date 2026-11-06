// Service worker : traduit des lots de phrases.
// Deux moteurs :
//  - "google" : accès gratuit de Google Traduction, quasi instantané ;
//  - "claude" : API Claude avec ta clé, traduction qui tient compte du contexte (titre, phrases d'avant).
// Si Claude échoue (pas de clé, clé refusée, réseau…), on bascule automatiquement sur Google.

const PARALLEL = 2; // Google : 2 demandes à la fois au maximum
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'translate' || !Array.isArray(msg.texts)) return;
  checkUpdate();
  handle(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

async function handle(msg) {
  const target = msg.target || 'fr';
  await loadCache();
  if (msg.engine === 'claude') {
    const { apiKey, model } = await chrome.storage.local.get({ apiKey: '', model: 'claude-haiku-5-5' });
    if (apiKey) {
      try {
        const result = await claudeBatch(msg.texts, target, msg.context || {}, apiKey, model);
        return { ok: true, engine: 'claude', result };
      } catch (e) {
        await setStatus(String(e.message || e));
      }
    } else {
      await setStatus('Pas de clé API Claude : traduction Google utilisée.');
    }
  }
  return { ok: true, engine: 'google', result: await freeBatch(msg.texts, target) };
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
        const res = await claudeSlot(() => claudeCall(lines, target, { title: context.title, before }, key, model));
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
