const DEFAULTS = { enabled: true, target: 'fr', mode: 'translation', size: 1, autoCC: true, engine: 'google', bg: true };
const LOCAL = {
  apiKey: '', model: 'claude-haiku-5-5', status: null,
  ollamaUrl: 'http://localhost:11434', ollamaModel: 'hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL', workContext: '', glossary: '',
};
const $ = (id) => document.getElementById(id);

function showEngine() {
  const e = $('engine').value;
  $('claudeBox').hidden = e !== 'claude';
  $('ollamaBox').hidden = e !== 'ollama';
  $('contextBox').hidden = e !== 'claude' && e !== 'ollama';
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('enabled').checked = s.enabled;
  $('autoCC').checked = s.autoCC;
  $('bg').checked = s.bg !== false;
  $('target').value = s.target;
  $('mode').value = s.mode;
  $('size').value = String(s.size);
  $('engine').value = s.engine;
  showEngine();
});

// la clé et les réglages locaux restent sur cet ordinateur (stockage local, non synchronisé)
chrome.storage.local.get(LOCAL, (s) => {
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('ollamaUrl').value = s.ollamaUrl;
  $('ollamaModel').value = s.ollamaModel;
  $('workContext').value = s.workContext;
  $('glossary').value = s.glossary;
  if (s.status && Date.now() - s.status.at < 10 * 60e3) $('status').textContent = s.status.text;
});

// relance la traduction dans les onglets ouverts (le moteur « change » le temps d'un instant)
function retranslate() {
  chrome.storage.sync.get({ engine: 'google' }, (s) => {
    if (s.engine === 'google') return;
    chrome.storage.sync.set({ engine: 'google' }, () => chrome.storage.sync.set({ engine: s.engine }));
  });
}

for (const id of ['enabled', 'autoCC', 'bg']) {
  $(id).addEventListener('change', (e) => chrome.storage.sync.set({ [id]: e.target.checked }));
}
for (const id of ['target', 'mode', 'engine']) {
  $(id).addEventListener('change', (e) => {
    chrome.storage.sync.set({ [id]: e.target.value });
    showEngine();
    if (id === 'engine') {
      // nouveau moteur : on efface l'ancien avertissement (et le « ! » sur l'icône)
      chrome.storage.local.set({ status: null });
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: 'Sous-titres FR' });
      $('status').textContent = '';
    }
  });
}
$('size').addEventListener('change', (e) => chrome.storage.sync.set({ size: parseFloat(e.target.value) }));
$('model').addEventListener('change', (e) => chrome.storage.local.set({ model: e.target.value, status: null }, retranslate));
$('apiKey').addEventListener('change', (e) => {
  chrome.storage.local.set({ apiKey: e.target.value.trim(), status: null }, retranslate);
  $('status').textContent = '';
});
for (const id of ['ollamaUrl', 'ollamaModel', 'workContext', 'glossary']) {
  $(id).addEventListener('change', (e) => chrome.storage.local.set({ [id]: e.target.value.trim(), status: null }, retranslate));
}

$('ollamaTestBtn').addEventListener('click', async () => {
  const out = $('ollamaTest');
  const base = ($('ollamaUrl').value.trim() || 'http://localhost:11434').replace(/\/+$/, '');
  const model = $('ollamaModel').value.trim() || 'hf.co/unsloth/Hy-MT2-7B-GGUF:UD-Q4_K_XL';
  out.className = '';
  out.textContent = 'Test en cours…';
  try {
    const r = await fetch(base + '/api/tags');
    if (r.status === 403) throw new Error("Ollama refuse l'extension (403). Ferme et rouvre le menu, puis réessaie.");
    if (!r.ok) throw new Error('Ollama répond une erreur ' + r.status + '.');
    const j = await r.json();
    const names = (j.models || []).map((m) => m.name);
    const found = names.some((n) => n === model || n === model + ':latest' || n.split(':')[0] === model);
    if (found) {
      out.className = 'ok';
      out.textContent = `Ollama fonctionne et le modèle « ${model} » est installé.`;
    } else {
      out.className = 'ko';
      out.textContent = `Ollama fonctionne. Le modèle « ${model} » n'est pas encore installé : l'extension le téléchargera toute seule à la première vidéo.` + (names.length ? ' Modèles présents : ' + names.join(', ') + '.' : '');
    }
  } catch (e) {
    out.className = 'ko';
    out.textContent = e instanceof TypeError ? "Ollama ne répond pas à cette adresse : est-il lancé ?" : e.message;
  }
});
