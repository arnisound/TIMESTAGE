# TimeStage

Chronomètre de scène pour conférences, cultes, meetups, remises de prix : une
**fenêtre de régie**, une **fenêtre d'affichage**, le partage par **QR code**,
des **messages à l'orateur**, les **questions du public modérées**, un
**déroulé de session** — et un **mode hors ligne** qui fonctionne sans aucun
réseau, directement dans le navigateur.

Aucun compte, aucune base de données, aucune donnée personnelle : une salle est
un code à 5 caractères qui vit en mémoire sur le serveur.

> **GitHub Pages ne peut pas héberger l'application complète** : c'est un
> hébergement de fichiers, il n'exécute pas Node, donc ni salles ni WebSocket.
> Le workflow fourni y publie la **version statique** — le chrono hors ligne,
> complet et utilisable seul. Pour la régie et l'affichage sur deux appareils,
> les QR codes et les questions du public, il faut faire tourner le serveur
> Node quelque part — [Render](#render--serveur-complet-gratuit) le fait
> gratuitement en trois clics. Tout est expliqué dans [Déploiement](#déploiement).

## Démarrage

```bash
npm install
npm start           # http://localhost:3000
```

En développement : `npm run dev` (rechargement à chaud du serveur).
Tests : `npm test`. Version statique : `npm run build:static`.

Variables d'environnement :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | Port d'écoute |
| `HOST` | `0.0.0.0` | Interface d'écoute |
| `TIMESTAGE_DATA` | `data/rooms.json` | Fichier de sauvegarde des salles ; `none` pour tout garder en mémoire |

## Les quatre fenêtres

| Page | URL | Pour qui |
| --- | --- | --- |
| Accueil | `/` | Créer une session ou rejoindre une salle |
| Régie | `/c/CODE` | La technique : pilote tout |
| Affichage | `/d/CODE` | L'écran de scène ou le retour orateur |
| Questions | `/q/CODE` | Le public, depuis son téléphone |
| Hors ligne | `/offline` | Chrono local, sans serveur |

La régie est protégée par une **clé** générée à la création de la salle. Elle est
conservée dans le navigateur qui a créé la session et incluse dans le QR code
« Régie » — ce QR code permet donc de prendre la main depuis une tablette, mais
ne doit être montré qu'à l'équipe technique. Sur un nouvel appareil, la régie
demande simplement de coller ce lien.

## Fonctionnalités

**Chronomètre**
- Trois modes : compte à rebours, chronomètre (compte croissant), horloge.
- Format libre : heures (auto / toujours / jamais), minutes, secondes,
  millisecondes (1, 2 ou 3 chiffres). Préréglages `MM:SS`, `HH:MM:SS`,
  `MM:SS.cc`, `MM`, `SS.mmm`.
- Saisie souple des durées : `5`, `5:30`, `1h15`, `2m30s`, `90s`, `750ms`.
- Seuils ambre et rouge réglables, dépassement en négatif, clignotement de fin.
- Ajustement à chaud (± durée) et décalage du temps écoulé (± avance).
- Toutes les fenêtres sont synchronisées sur l'horloge du serveur : l'écran de
  scène et le retour orateur affichent la même seconde.

**Déroulé de session**
- Parties avec titre, intervenant, durée, mode et notes de régie.
- Chargement en un clic, précédent / suivant, enchaînement automatique.
- Import / export JSON pour préparer la session à l'avance.

**Messages**
- Presets modifiables (« Merci de conclure », « Parlez plus fort »…).
- Message libre, quatre styles, clignotement, masquage automatique.

**Questions du public**
- Le public scanne un QR code, écrit sa question, et voit le temps restant.
- La régie relit, valide, projette ou rejette. **Rien n'atteint l'écran sans
  validation** : les questions en attente ne sont jamais envoyées à l'affichage.
- Limitation de débit et filtrage des doublons côté serveur.

**Affichage**
- Plein écran, chiffres dimensionnés automatiquement, thèmes sombre / clair /
  contraste maximal, écran noir instantané.
- Titre, intervenant, heure du jour, barre de progression et partie suivante
  activables séparément.
- Verrouillage de la mise en veille de l'écran (Wake Lock) et masquage du curseur.
- Si le réseau tombe, l'affichage **continue de compter** et se reconnecte seul.

**Mode hors ligne**
- `/offline` fonctionne sans aucune connexion une fois la page visitée : le
  service worker met l'application en cache.
- Chrono complet, formats, messages, déroulé local — le tout dans le navigateur.
- « Ouvrir l'affichage » lance une seconde fenêtre (second écran, vidéoprojecteur)
  synchronisée par `BroadcastChannel`, toujours sans réseau.

## Raccourcis clavier (régie)

| Touche | Action |
| --- | --- |
| `Espace` | Démarrer / pause |
| `R` / `Maj+R` | Remise à zéro / relancer |
| `N` / `P` | Partie suivante / précédente |
| `↑` / `↓` | ± 1 minute |
| `M` | Aller au champ message |
| `Échap` | Masquer le message |
| `B` | Écran noir |
| `F` | Plein écran (fenêtre d'affichage) |

## Architecture

```
brand/               Logo source (SVG d'origine, texte vectorisable)
scripts/build-static.mjs  Génère dist/ : version statique (chrono hors ligne)
server/index.js      HTTP, API REST, WebSocket, service des fichiers statiques
server/rooms.js      État des salles, commandes, modération, persistance
shared/time.js       Formatage et analyse des durées (serveur + navigateur)
shared/timer.js      Machine à états du chronomètre (fonctions pures)
public/              Pages, styles et scripts (aucune étape de build)
public/sw.js         Service worker : mise en cache pour le mode hors ligne
test/                Tests unitaires et d'intégration (node:test)
```

Le serveur est la source de vérité en ligne : il garde l'état de chaque salle et
diffuse un instantané complet à chaque changement. Les clients ne comptent pas
le temps eux-mêmes, ils **dérivent** l'affichage de `startedAt` + horloge serveur
estimée (compensation du trajet aller-retour par ping/pong), ce qui évite toute
dérive entre les écrans.

### API HTTP

| Méthode | Route | Description |
| --- | --- | --- |
| `POST` | `/api/rooms` | Crée une salle, renvoie le code et la clé de régie. Un `code` peut être demandé pour reprendre une salle perdue après un redémarrage (409 s'il est déjà pris) |
| `GET` | `/api/rooms/:code` | Existence et état public d'une salle |
| `POST` | `/api/rooms/:code/questions` | Envoi d'une question (repli sans WebSocket) |
| `GET` | `/api/qr.svg?data=…` | QR code en SVG |
| `GET` | `/api/health` | Sonde de santé |

### WebSocket (`/ws`)

Client → serveur : `hello`, `ping`, `cmd` (régie uniquement), `question`.
Serveur → client : `welcome`, `state`, `pong`, `ack`, `error`.

Les commandes portent des noms explicites : `timer.start`, `timer.setFormat`,
`session.load`, `message.send`, `question.show`, `settings.update`…

## Déploiement

TimeStage a deux moitiés : une partie **statique** (le chrono lui-même, qui
tourne dans le navigateur) et une partie **serveur** (les salles, la
synchronisation WebSocket, les QR codes, les questions du public).

### GitHub Pages — version statique, sans serveur

GitHub Pages ne sert que des fichiers : il ne peut pas exécuter Node, donc ni
salles, ni WebSocket. En revanche il héberge très bien le **chrono hors ligne**,
qui est complet à lui seul :

- chronomètre, formats H/M/S/MS, modes, seuils, dépassement ;
- messages à l'orateur et presets ;
- déroulé local (parties, chargement, suivant/précédent) ;
- seconde fenêtre d'affichage sur le même appareil (vidéoprojecteur, second
  écran), synchronisée par `BroadcastChannel` ;
- fonctionnement **sans aucune connexion** grâce au service worker.

Ce qui demande le serveur : régie et affichage sur **deux appareils
différents**, QR codes de partage, questions du public.

Mise en route, une fois :

1. **Settings → Pages → Build and deployment → Source : GitHub Actions.**
2. Fusionner cette branche dans `main` (le workflow
   `.github/workflows/pages.yml` se déclenche sur `main`), ou lancer
   **Actions → GitHub Pages → Run workflow** sur la branche de votre choix.
3. Le site est publié sur `https://<compte>.github.io/<dépôt>/`.

Pour construire la même chose en local :

```bash
npm run build:static     # écrit dans dist/
npx serve dist           # ou n'importe quel serveur de fichiers
```

Si vous hébergez aussi le serveur complet, définissez la variable de dépôt
`TIMESTAGE_SERVER_URL` (Settings → Secrets and variables → Actions → Variables) :
la page statique affichera un lien direct vers votre instance.

### Render — serveur complet, gratuit

Render exécute le serveur Node tel quel : **toutes les fonctions** marchent, y
compris la régie et l'affichage sur deux appareils, les QR codes et les
questions du public.

1. Créer un compte sur [render.com](https://render.com) (aucune carte requise
   pour le plan gratuit).
2. **New → Blueprint**, choisir ce dépôt : le fichier `render.yaml` est détecté
   et décrit tout le service.
3. **Apply**. Le premier déploiement prend deux à trois minutes.
4. L'application est en ligne sur `https://timestage-xxxx.onrender.com`.

Pensez ensuite à renseigner cette URL dans la variable de dépôt
`TIMESTAGE_SERVER_URL` (GitHub → Settings → Secrets and variables → Actions →
Variables) : la page GitHub Pages affichera un lien vers votre instance.

#### Ce qu'implique le plan gratuit

| Contrainte | Conséquence | Ce que fait TimeStage |
| --- | --- | --- |
| Mise en veille après 15 min sans trafic | La première ouverture attend ~1 min | La page d'accueil réveille le serveur dès son ouverture et affiche « Le serveur se réveille… » au lieu de figer |
| Le trafic WebSocket compte comme activité | Pas de mise en veille **pendant** un événement | Chaque écran envoie un battement toutes les 10 s |
| Redémarrage = salles perdues (mémoire vive) | Le code de salle disparaîtrait | La régie propose de **recréer la salle avec le même code** et rejoue le déroulé, les réglages et les presets sauvegardés localement. Les QR codes déjà distribués restent valables et les écrans se reconnectent seuls |
| Pendant la coupure | — | Les affichages **continuent de compter** sur l'horloge estimée ; rien ne se fige à l'écran |

En pratique : ouvrez l'application cinq minutes avant de commencer, le temps
que le serveur soit chaud, et tout se passe sans accroc. Pour éviter toute
attente, un service de ping gratuit (UptimeRobot, cron-job.org) qui appelle
`/api/health` toutes les dix minutes garde le service éveillé — sachant qu'un
service actif en permanence consomme environ 730 des 750 heures gratuites
mensuelles.

### Autres hébergements

**Docker**, partout ailleurs :

```bash
docker build -t timestage .
docker run -p 3000:3000 -v timestage-data:/app/data timestage
```

Sur un hébergement avec disque persistant, laissez `TIMESTAGE_DATA` par défaut :
les salles survivent alors aux redémarrages.

**Derrière un reverse proxy**, laissez passer la mise à niveau WebSocket sur `/ws` :

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Servez l'application en HTTPS : le mode hors ligne (service worker), le plein
écran et le Wake Lock l'exigent en dehors de `localhost`.

Les salles inactives depuis 48 h sont purgées automatiquement.

## Identité visuelle

Le logo source est dans `brand/timestage-logo.svg`. Son texte utilise la police
Arial Rounded MT Bold : pour éviter toute dépendance à une police installée,
l'application utilise deux dérivés générés depuis cette source :

- `public/icons/icon.svg` — la marque **sans texte** (badge, anneau doré, onde,
  aiguilles) : favicon et pastille dans les barres de titre, lisible jusqu'à 32 px ;
- `public/icons/logo.png` et les icônes 192/512 — le logo complet en matriciel,
  fidèle au fichier d'origine, pour l'accueil et l'installation en application.

Pour les régénérer après une modification du logo, voir les dérivés listés
ci-dessus : la marque sans texte se reconstruit en retirant les groupes `<text>`
du SVG source (en conservant `fill-rule:evenodd` sur la racine, sinon les
anneaux se remplissent en disques pleins).

## Licence

MIT — voir [LICENSE](LICENSE).
