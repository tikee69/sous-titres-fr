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

## Traducteurs
- **Gratuit, par défaut** : Google Traduction, avec relais automatique vers le traducteur de Microsoft Edge si Google limite les demandes. Ce sont des accès gratuits non officiels, qui peuvent changer sans prévenir.
- **Claude** (option, plus précis, tient compte du contexte) : clé API à créer sur console.anthropic.com. C'est payant à l'usage, environ 1 centime par heure de vidéo avec Haiku 5.5. C'est facturé à part de l'abonnement Claude. Google ou Microsoft affichent tout de suite les premières répliques, puis Claude les remplace au fur et à mesure.

## Limites
- Il faut des sous-titres en texte. Sans sous-titres, il faudra de la reconnaissance vocale (prochaine étape).
- Les sous-titres incrustés dans l'image ne sont pas lus (il faudrait de l'OCR).
- Safari : la conversion avec `xcrun safari-web-extension-converter` n'a pas encore été testée.

## Fichiers
- `inject.js` : capte les fichiers de sous-titres dans la page.
- `content.js` : découpe, traduction anticipée, synchro, affichage, suivi du lecteur.
- `background.js` : traducteurs (Google, Microsoft, Claude), cache durable, mise à jour automatique.
- `popup.html/js` : réglages.
