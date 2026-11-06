# Sous-titres FR (extension Chrome)

Traduit **instantanément** les sous-titres des vidéos (YouTube, Tubi et la plupart des sites) en français, en traduction seule (par défaut) ou en bilingue (original + traduction). Même principe qu'Immersive Translate.

Testé en conditions réelles sur Tubi (série chinoise sous-titrée en anglais et en espagnol).

## Installer (une seule fois)
1. Télécharge ce dépôt (bouton vert **Code → Download ZIP**) et dézippe-le.
2. Dans Chrome, ouvre `chrome://extensions` et active le **Mode développeur** (en haut à droite).
3. Clique **Charger l'extension non empaquetée** et choisis le dossier.
4. Lance une vidéo et active ses sous-titres. Sur YouTube, ils s'allument tout seuls.

**Mises à jour automatiques** : quand une nouvelle version est déposée dans le dossier (le fichier `version.txt` change), l'extension se recharge toute seule dans les 30 secondes. Il n'y a plus besoin de passer par `chrome://extensions`.

## Pourquoi c'est instantané
1. **Interception** : quand le lecteur télécharge son fichier de sous-titres (YouTube `timedtext`, `.srt`, `.vtt`, TTML), l'extension en garde une copie, avec toutes les répliques et leurs horaires.
2. **Tout est traduit d'avance** : un épisode entier tient en quelques demandes, en commençant par les répliques qui arrivent.
3. **Synchro sur l'horloge de la vidéo** : la bonne réplique traduite s'affiche à chaque image, sans attendre le réseau.
4. **Mémoire durable** : un épisode déjà traduit ne redemande plus rien, même après un redémarrage de Chrome.

## Ce que l'extension gère toute seule
- Les sous-titres d'origine du site sont masqués, et les nôtres prennent leur place exacte. Ils remontent quand les commandes du lecteur apparaissent.
- **Changement de langue dans le lecteur** (par exemple anglais vers espagnol sur Tubi) : l'extension suit la langue que le site affiche.
- **Sous-titres coupés dans le lecteur** : la traduction disparaît aussi.
- **Pubs** : rien ne s'affiche pendant une pub.
- **Sous-titres automatiques YouTube** (mot par mot) : ils sont regroupés en vraies phrases avant d'être traduits.
- Chrome Traduction et Immersive Translate ne peuvent pas retraduire notre affichage.
- **Fond des sous-titres** : avec ou sans fond noir, au choix dans le menu. Sans fond, le texte est blanc avec un contour noir.

## Traducteurs (au choix dans le menu de l'extension)
- **Google (par défaut, gratuit)** : Google Traduction, avec relais automatique vers Microsoft Edge si Google limite les demandes.
- **Microsoft (gratuit)** : traducteur de Microsoft Edge d'abord, Google en relais.
- **Claude (option, clé API)** : traduit par scène, avec le contexte. C'est payant à l'usage, environ 1 centime par heure de vidéo avec Haiku 5.5, et facturé à part de l'abonnement Claude.
- **Local — Ollama (option, gratuit et privé)** : un modèle de langage qui tourne sur ton Mac (par défaut `qwen3:8b`). Il traduit par scène, 30 répliques à la fois, avec les 5 précédentes comme contexte, le contexte de l'œuvre et ton glossaire. Rien ne quitte l'ordinateur.

Google et Microsoft sont des accès gratuits non officiels, qui peuvent changer sans prévenir. Avec Claude ou Ollama, le traducteur gratuit affiche tout de suite les premières répliques, puis la version avec contexte les remplace au fur et à mesure. Si le moteur choisi ne répond pas, l'extension bascule toute seule sur le gratuit : un « ! » apparaît alors sur son icône, et la raison s'affiche dans le menu.

Pour Claude et Ollama, deux champs facultatifs améliorent la traduction :
- **Contexte de l'œuvre**, par exemple : « Empresses in the Palace (甄嬛传), drame de cour Qing ; l'anglais est lui-même traduit du chinois » ;
- **Glossaire**, un terme par ligne, par exemple « Your Majesty = Votre Majesté ».

### Installer Ollama (une seule fois, seulement si tu choisis « Local »)
1. Installe Ollama depuis https://ollama.com.
2. Dans le Terminal :
   ```
   launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
   ollama pull qwen3:8b
   ```
   (ou `qwen3:14b` si ton Mac a 24 Go de mémoire ou plus : plus fin sur les titres et le ton).
3. Quitte puis relance Ollama.
4. Dans le menu de l'extension : **Moteur → Local — Ollama**, puis **Tester la connexion**.

Sans `OLLAMA_ORIGINS`, Ollama refuse l'extension (erreur 403).

## Limites
- Il faut des sous-titres en texte. Sans sous-titres, il faudra de la reconnaissance vocale (prochaine étape).
- Les sous-titres incrustés dans l'image ne sont pas lus (il faudrait de l'OCR).
- Safari : la conversion avec `xcrun safari-web-extension-converter` n'a pas encore été testée.

## Fichiers
- `inject.js` : capte les fichiers de sous-titres dans la page.
- `content.js` : découpe, traduction anticipée, synchro, affichage, suivi du lecteur.
- `background.js` : traducteurs (Google, Microsoft, Claude, Ollama), cache durable, mise à jour automatique.
- `popup.html/js` : réglages.
