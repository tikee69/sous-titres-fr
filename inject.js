// Tourne DANS la page (monde "MAIN") dès le tout début du chargement.
// Rôle : quand le lecteur vidéo télécharge son fichier de sous-titres, on en garde une copie
// et on la passe au script de l'extension. Rien n'est modifié, le lecteur reçoit sa réponse normalement.
(() => {
  if (window.__stfrHook) return;
  window.__stfrHook = true;

  const URL_RE = /\/api\/timedtext|\/timedtext\?|[?&]fmt=(json3|vtt|srv3|ttml)|\.(vtt|srt|ttml|dfxp)(\?|#|$)|\/subtitles?[/?.]|\/captions?[/?.]/i;
  const TYPE_RE = /vtt|subrip|ttml|x-subtitle/i;

  const send = (url, text) => {
    if (typeof text !== 'string' || text.length < 10 || text.length > 20e6) return;
    window.postMessage({ __stfr: 'subs', url: String(url), text }, '*');
  };

  // fetch()
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input && (input.url || String(input));
        p.then((r) => {
          const ct = (r.headers && r.headers.get('content-type')) || '';
          if (URL_RE.test(r.url || url || '') || TYPE_RE.test(ct)) {
            r.clone().text().then((t) => send(r.url || url, t)).catch(() => {});
          }
        }).catch(() => {});
      } catch (_) {}
      return p;
    };
  }

  // XMLHttpRequest (utilisé par YouTube)
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (method, url) {
    this.__stfrUrl = url;
    return origOpen.apply(this, arguments);
  };
  XHR.send = function () {
    try {
      this.addEventListener('load', () => {
        try {
          const url = this.responseURL || String(this.__stfrUrl || '');
          const ct = this.getResponseHeader('content-type') || '';
          if (!URL_RE.test(url) && !TYPE_RE.test(ct)) return;
          let t = '';
          if (this.responseType === '' || this.responseType === 'text') t = this.responseText;
          else if (this.responseType === 'json') t = JSON.stringify(this.response);
          else if (typeof this.response === 'string') t = this.response;
          else if (this.response instanceof ArrayBuffer) t = new TextDecoder().decode(this.response);
          send(url, t);
        } catch (_) {}
      });
    } catch (_) {}
    return origSend.apply(this, arguments);
  };
})();
