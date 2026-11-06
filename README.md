# Sous-titres FR v0.3.2 (extension Chrome)

Traduit instantanément les sous-titres des vidéos (YouTube et autres sites) en français, en bilingue (original + traduction) ou en traduction seule. Même principe qu'Immersive Translate.

## Installer
1. Dézippe le dossier `sous-titres-fr`.
2. Dans Chrome, ouvre `chrome://extensions` et active **Mode développeur** (en haut à droite).
3. Clique **Charger l'extension non empaquetée** et choisis le dossier `sous-titres-fr`.
4. Recharge les onglets YouTube déjà ouverts, puis lance une vidéo.

Sur YouTube, les sous-titres s'allument tout seuls (désactivable). Ailleurs, active les sous-titres du lecteur.

Pour mettre à jour : remplace les fichiers du dossier, puis clique la flèche ↻ de l'extension dans `chrome://extensions`.

## Pourquoi c'est instantané
1. **Interception** : quand le lecteur télécharge son fichier de sous-titres (YouTube `timedtext`, `.vtt`, `.srt`, TTML), l'extension en garde une copie : toutes les phrases avec leurs horaires.
2. **Phrases reconstruites** : les sous-titres automatiques YouTube arrivent mot par mot ; ils sont regroupés en vraies phrases (ponctuation, pauses, longueur), ce qui améliore beaucoup la traduction.
3. **Tout est traduit d'avance** : d'abord les 6 phrases qui arrivent, puis le reste de la vidéo, par lots, avec 6 requêtes en parallèle et un cache.
4. **Synchro sur l'horloge de la vidéo** : à chaque image, l'extension affiche la phrase correspondant à `currentTime`. Aucun appel réseau pendant la lecture. Avance, retour et vitesse ×2 fonctionnent.

Sources prises en charge, de la meilleure à la moins bonne :
- fichier de sous-titres intercepté (YouTube, la plupart des lecteurs) ;
- pistes `<track>` du navigateur ;
- repli : lecture du texte affiché à l'écran (petit délai, pour les lecteurs exotiques).

## Traduire avec Claude (plus précis, tient compte du contexte)
1. Crée une clé API sur https://console.anthropic.com/settings/keys et ajoute un peu de crédit. C'est payant à l'usage.
2. Ouvre le menu de l'extension, choisis **Traducteur → Claude**, puis colle la clé.
3. Modèle **Haiku 5.5** (rapide, par défaut) ou **Sonnet 5.5** (plus fin, environ 20 fois plus cher).

Comment ça se passe :
- Google traduit tout de suite les premières phrases, pour qu'il n'y ait aucune attente.
- En parallèle, Claude reçoit le titre de la vidéo et toutes les phrases par paquets de 40, chaque paquet avec les phrases qui le précèdent comme contexte.
- Chaque phrase de Claude remplace celle de Google dès qu'elle arrive, en général en une ou deux secondes.
- Claude corrige aussi les erreurs des sous-titres automatiques et garde un ton cohérent (tutoiement, vocabulaire récurrent).
- Si la clé manque ou est refusée, l'extension repasse sur Google et affiche la raison dans le menu.

Ce que ça coûte, à titre indicatif : une heure de vidéo fait environ 30 000 tokens envoyés et 15 000 reçus. Avec Haiku 5.5 (0,10 $ / 0,50 $ par million), ça fait à peu près 1 centime. Avec Sonnet 5.5 (2 $ / 10 $), environ 20 centimes.

La clé reste dans Chrome, sur ton ordinateur (stockage local non synchronisé). Elle ne sert qu'à appeler api.anthropic.com.

## Fichiers
- `inject.js` : capte les fichiers de sous-titres dans la page.
- `content.js` : découpe, traduction anticipée, synchro et affichage.
- `background.js` : appels de traduction groupés, en parallèle et en cache.
- `popup.html/js` : réglages (activer, bilingue, langue, taille, sous-titres YouTube automatiques).

## Limites
- Il faut des sous-titres en texte. Sans sous-titres, il faudrait de la reconnaissance vocale (prochaine étape possible).
- Les sous-titres incrustés dans l'image ne sont pas lus (il faudrait de l'OCR).
- La traduction passe par l'accès gratuit non officiel de Google Traduction. Ça peut ralentir en cas d'usage très intensif.

## Safari
Sur un Mac avec Xcode : `xcrun safari-web-extension-converter sous-titres-fr`.
