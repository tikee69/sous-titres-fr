const DEFAULTS = { enabled: true, target: 'fr', mode: 'bilingual', size: 1, autoCC: true, engine: 'google' };
const LOCAL = { apiKey: '', model: 'claude-haiku-5-5', status: null };
const $ = (id) => document.getElementById(id);

function showClaude() {
  $('claudeBox').hidden = $('engine').value !== 'claude';
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('enabled').checked = s.enabled;
  $('autoCC').checked = s.autoCC;
  $('target').value = s.target;
  $('mode').value = s.mode;
  $('size').value = String(s.size);
  $('engine').value = s.engine;
  showClaude();
});

// la clé reste uniquement sur cet ordinateur (stockage local, non synchronisé)
chrome.storage.local.get(LOCAL, (s) => {
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  if (s.status && Date.now() - s.status.at < 10 * 60e3) $('status').textContent = s.status.text;
});

for (const id of ['enabled', 'autoCC']) {
  $(id).addEventListener('change', (e) => chrome.storage.sync.set({ [id]: e.target.checked }));
}
for (const id of ['target', 'mode', 'engine']) {
  $(id).addEventListener('change', (e) => {
    chrome.storage.sync.set({ [id]: e.target.value });
    showClaude();
  });
}
$('size').addEventListener('change', (e) => chrome.storage.sync.set({ size: parseFloat(e.target.value) }));
$('model').addEventListener('change', (e) => chrome.storage.local.set({ model: e.target.value, status: null }));
$('apiKey').addEventListener('change', (e) => {
  chrome.storage.local.set({ apiKey: e.target.value.trim(), status: null });
  $('status').textContent = '';
  // relance la traduction dans les onglets ouverts
  chrome.storage.sync.get({ engine: 'google' }, (s) => {
    if (s.engine === 'claude') chrome.storage.sync.set({ engine: 'google' }, () => chrome.storage.sync.set({ engine: 'claude' }));
  });
});
