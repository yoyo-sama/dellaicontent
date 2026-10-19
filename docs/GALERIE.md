# Galerie — Chantier 1.4.0 (livré)

**État : livré en six lots (L0, B1, B2, A, B3a, B3b), puis documentation (D) et version 1.4.0.** Ce document garde le cadrage d'origine (Pourquoi, Décisions, Hors périmètre), décrit ce qui a été livré lot par lot, liste les écarts actés et les limites connues, puis porte le contrat (§ Contrat), corrigé uniquement pour les écarts actés dans les commits ou les notes de lot. Vue d'ensemble de l'architecture : `docs/ARCHITECTURE.md` § Galerie et § Backend `gallery`.

## Pourquoi

Avant 1.4.0, la galerie ne montrait que les 200 dernières entrées mémorisées dans le navigateur (localStorage `galleryAssets`, coupé par `slice(0,200)` dans `persistAsset` ; prompts dans `assetPrompts`). Or `~/comfyui-spark/basedir/output` contient environ 1 766 images et vidéos (1 396 PNG d'environ 1,5 Mo, 370 mp4 d'environ 1 Mo). Chaque vignette chargeait l'image d'origine. Les douleurs : retrouver une image précise (mot du prompt, pipeline, modèle), parcourir par période ou par session, historique perdu.

## Décisions

- **Voie A puis B.** Pas de SmartGallery ni de galerie tierce (option refusée).
- **A = front seul** (`index.html`) : un composant à deux sources de données derrière une interface unique, grille dense avec curseur de taille, chargement par paquets de 60, recherche dans les prompts connus, filtres pipeline et favoris, favoris locaux, sélection multiple. On conserve tout : « → Utiliser en entrée », glisser-déposer, « ➕ Séquence », lightbox, 🗑 avec « Annuler », onglets Images/Vidéos et compteurs, groupes par dossier. Les nouvelles entrées sont horodatées (`ts`) sans casser l'ancien format.
- **B = service Docker** `gallery`. Python stdlib + SQLite/FTS5 + Pillow + ffmpeg, non root, sur `127.0.0.1:8094`, joignable seulement par nginx `/gallery/`. `output/` est monté en rw ; un volume dédié garde l'index et les miniatures. Il indexe tout l'output (scan puis rescan incrémental), avec prompt, modèle, LoRA, seed, taille, pipeline et date. Tags et favoris vivent en SQLite, jamais dans les fichiers. Supprimer = déplacer vers `output/.trash/` (récupérable, purge manuelle), avec restauration. Les collections sont des tags. Le service ne soumet JAMAIS de job ComfyUI. Si le service est injoignable, le front retombe sur la source navigateur.

## Hors périmètre

Galerie du Canvas branchée sur le service, notes/commentaires/rôles, exposition client, remix, OmniQuery, transcodage, gestion de dossiers (seul le renommage dans le même dossier est prévu), virtual scrolling complet, SmartGallery.

## Lots livrés

A était en parallèle de B1 puis B2 ; le reste était séquentiel. Les SHA sont ceux de `git log` (branche `main`).

| Lot | Commit | Date (git) | Contenu livré |
|---|---|---|---|
| L0 | `990cc64` | 2026-09-25 | Ce document (cadrage et contrat) et les règles du chantier dans `AGENTS.md`. |
| B1 | `08c83a5` | 2026-09-25 | Service `gallery` : `docker/gallery/{Dockerfile,server.py}`, service et volume `gallery-data` dans `docker-compose.yml`, `location ^~ /gallery/` dans `nginx.conf`, `install.sh` (dossier `output/`, `COMFY_OUTPUT_DIR` dans `.env`, build du service, recréation du web, health-check). Lecture seule : `/health /assets /asset /thumb /dates /facets`, indexeur SQLite/FTS5, miniatures WebP. |
| B2 | `48693b5` | 2026-09-25 | Écriture et sécurité : `/fav /tags /tag /rename /trash /restore`, contrôle de même origine, corbeille `output/.trash/`, restauration, verrou `studio/(story\|relay)/` sur le renommage ; correctif du rescan de B1 (perte de tags et de favoris lors d'un renommage pendant un scan). |
| A | `6846b51` | 2026-09-25 | `index.html` seul. Galerie en liste de données à deux sources (`browserSource` livrée ici), rendu par paquets de 60, grille dense à curseur de taille, recherche, filtre pipeline, favoris locaux (`galleryFavs`), sélection multiple, état vide. |
| B3a | `1c57cba` | 2026-09-26 | `index.html` seul. `serviceSource` : liste indexée, « Tout afficher », filtres modèle / tag / pipeline / période, groupes par jour, semaine ou mois, « Aller à… », favoris et corbeille côté service, choix de la source au démarrage et repli automatique, migration des favoris locaux. |
| B3b | `11f3ae7` | 2026-10-19 | `index.html` seul. Lightbox à panneau de métadonnées, « Réutiliser le prompt », renommage, tags (lightbox et sélection multiple), vue Corbeille avec restauration, `[data-raw]` pour les données venues du service. |
| D | (ce lot) | — | Documentation à l'état livré et `VERSION` 1.4.0. Aucun code. |

### Ce que fait la galerie livrée

- **Deux sources derrière une interface unique** (§ C2) : `browserSource` (historique du navigateur, repli) et `serviceSource` (index complet de `output/`). Au démarrage, `galleryBoot()` interroge `GET /gallery/health` (délai 3 s) : réponse `ok` = source service, sinon source navigateur et note « Galerie complète indisponible — images de ce navigateur seulement ». Une erreur réseau ou HTTP ≥ 500 d'un `list` en cours de session fait aussi retomber sur la source navigateur (`galleryFallback`) ; une erreur 4xx est journalisée sans basculer.
- **Recherche et filtres** : mots du prompt, du nom de fichier ou du modèle (tous les mots, préfixes admis, sans accents), pipeline (dont « Autre »), modèle, tag, favoris, période (Du / Au, « Aller à… » par jour, semaine ou mois), « Tout afficher » (périmètre `all` : tout l'output, pas seulement ce que produit l'app).
- **Rendu** : paquets de 60 par `IntersectionObserver`, miniatures WebP du service (`/gallery/thumb`, y compris pour les vidéos, avec pastille ▶), glisser-déposer et « → Utiliser en entrée » sur l'image pleine résolution (`/comfy/view`).
- **Lightbox à panneau** (service) : prompt complet (`detail`), seed, modèle, LoRA, taille, durée, poids, date, chemin, tags ; « Copier », « → Utiliser en entrée », « ↺ Réutiliser le prompt » (écrit dans le brief sur ce clic seulement, avec « Annuler », sans aucun job), « ✎ Renommer ».
- **Tags, favoris, corbeille** : tags par image ou par lot de 100 ; favoris migrés du navigateur une seule fois ; 🗑 déplace vers `.trash/` avec bandeau « Annuler » ; vue « Corbeille (n) » avec « Restaurer ». Aucune suppression définitive, ni bouton ni route.
- **Repli** : tout asset reçu en direct est aussi mémorisé côté navigateur (`persistAsset`, avec `ts`), donc la source navigateur reste utile quand le service est arrêté.

## Écarts actés

Écarts par rapport au contrat, tous décidés et reportés dans le § Contrat ci-dessous (marqués « Écart acté ») ou ici.

- **B1, extraction du prompt** (2026-09-25) : la remontée du graphe s'arrête aux nœuds `class_type == "TextGenerate"` (leur entrée est une consigne de LLM, pas un prompt d'image) et ne suit jamais l'entrée nommée `negative`. Sans cela `Krea2_turbo_00070_.png` aurait eu pour prompt la consigne système (2 131 caractères) au lieu de la description (289), et 80 PNG `Qwen_image_2.1_*` auraient pris leur négatif par défaut, plus long que le positif. Consigne et négatif restent dans `texts` : la recherche les trouve.
- **B2, contrôle de même origine** (2026-09-25) : il s'exécute avant le routage ; un POST sans `Content-Type` JSON sur une route de lecture répond 415, pas 405 ; PUT, DELETE, PATCH et HEAD répondent 405 partout ; les clés en double dans une requête sont refusées (400) ; les 500 de `/trash` et `/restore` portent la liste de ce qui est déjà fait ; un renommage ne change que la clé (pipeline et périmètre « app » gardent leur valeur d'origine).
- **B2, correctif du rescan** : avant toute suppression de ligne, le rescan relit la ligne par sa clé sous le verrou (B1 supprimait par l'id du cliché et perdait tags et favori d'un fichier renommé pendant un scan). Preuve : le même test échoue avec la boucle de B1.
- **B2, noms de tag** : unicité sans casse sur toute la casse Unicode (`casefold`, « Été » = « ÉTÉ »), en plus du `COLLATE NOCASE` de SQLite qui ne replie que l'ASCII.
- **B3a, bornes de période** : « Du » = minuit local du jour choisi ; « Au » = minuit local du **lendemain** du jour choisi (`to` du service est exclu : sans cela « Du = Au » donnerait une période vide).
- **B3a/B3b, interface de source (C2)** : `serviceSource.tag(keys, add, remove)` travaille par lots de 100 et **rend** `[{key, tags}]` (le contrat disait `Promise<void>`) ; `restore(trashKeys)` travaille par lots de 100 et **rend** `[{trashKey, key}]` ; `list` n'ajoute plus les éléments `cloud:*` de session en `scope=trash` ; `svcFetch` conserve le champ `error` du service dans `code`.
- **B3a, clés historiques** : `pkey` (hors contrat) = `${subfolder}/${filename}` sert aux clés localStorage historiques (`deletedAssets`, `assetPrompts`) et au cache de cartes ; les nouvelles clés (favoris `galleryFavs`, requêtes au service) suivent le format du contrat.
- **B3b, `[data-raw]`** : `translateTree` ignore les nœuds texte sous un élément portant `data-raw` (prompt, seed, puces de tag, options des listes Modèle et Tag) : un tag ou un modèle nommé « Image » ou « Canvas » n'est jamais traduit.
- **B3b, nginx et clés `.trash`** : aucune clé `.trash/…` ne voyage dans un chemin d'URL (corps JSON pour les POST, query encodée pour `GET /gallery/thumb` et `/gallery/asset`). Vérifié derrière un vrai nginx (`nginx:alpine` avec le `nginx.conf` du dépôt). `location ^~ /gallery/` passe avant la regex `location ~ /\.` : `GET /gallery/.trash/x` n'est donc pas refusé par nginx (le service répond 404) ; la règle « nginx refuse `/.` » ne protège que le site statique.
- **B3b, ComfyUI et `.trash`** : ComfyUI `/comfy/view` sert les fichiers sous `.trash/…` (constaté en lecture sur la production, 200 `image/png`). L'interface ne s'en sert pas : la vue Corbeille passe uniquement par `/gallery/thumb`.

## Limites connues

**Indexation et données**

- **LoRA court-circuitée** : `loras` liste tout nœud `LoraLoader*` situé en amont du nœud de sauvegarde ; une LoRA contournée par un switch est quand même listée.
- **Prompt des fichiers ComfyUI manuels** : dans un fichier produit à la main dans ComfyUI (hors app), le texte le plus long peut être la consigne système de l'enhancer plutôt que le prompt de l'utilisateur ; la remontée ne s'arrête que sur `class_type == "TextGenerate"`. La consigne reste dans `texts`, donc la recherche trouve le fichier.
- **Date = `mtime`** du fichier. Renommer, mettre à la corbeille et restaurer ne la changent pas (déplacement par lien physique, même inode). La vue Corbeille classe par date du fichier, pas par date de suppression.
- **Rescan de 60 s** : un fichier créé ou modifié en dehors du service apparaît au plus tard après `SCAN_INTERVAL` (60 s par défaut ; `docker-compose.yml` ne le fixe pas) ; un fichier de moins de 5 s est ignoré (il peut être en cours d'écriture), `/asset` l'indexe à la demande. Un fichier supprimé en dehors du service disparaît de l'index au passage suivant. Le cache de miniatures n'est jamais purgé.
- **Fichiers abîmés** (`meta_ok = 0` : PNG tronqué, mp4 de 0 octet, `ffprobe` en échec) : listés avec un prompt `null`, sans miniature (404), non réessayés tant que `(mtime_ns, size)` ne change pas.
- **Sessions storyboard** : elles désignent leurs fichiers d'output par leur nom. Le renommage des clés `studio/story/` et `studio/relay/` est donc refusé (409 `locked`). La corbeille reste permise : un fichier mis à la corbeille n'est plus à son emplacement tant qu'il n'est pas restauré.
- **Collision `_restored`** : ComfyUI réutilise le numéro d'un fichier supprimé s'il était le dernier ; si l'emplacement d'origine est repris, la restauration rend `<stem>_restored<ext>`, puis `_restored2`… ; annuler une suppression dont le service a ainsi renommé le fichier recharge la grille mais le miroir navigateur du repli garde l'ancien nom.
- **Périmètre « app »** : la regex d'exclusion (`^studio/(lot1|lotA|q21|inspect)/|^studio/lot\d`) est une proposition du plan, implémentée telle quelle (§ C5).

**Interface**

- **Pas de retrait de tag en masse**, pas de renommage de tag, pas de compte par tag dans les listes (`/facets` les donne, la page ne les affiche pas). `/facets` ne dépend que de `scope` : les listes Modèle et Tag ne se resserrent pas selon les autres filtres.
- **Sélection multiple** : suppression limitée à 100 éléments (message, rien ne bouge) ; tags, favoris et restauration travaillent par lots de 100, et une panne au milieu laisse les premiers lots appliqués alors que le bandeau dit « rien n'a été modifié ».
- **Migration des favoris locaux** : clés inconnues du service ignorées (le lot refusé est rejoué clé par clé) ; un favori posé en mode repli **après** la migration n'est pas reporté ; `galleryFavs` n'est jamais vidé.
- **`/dates`** calcule ses périodes avec le `tzOffset` du jour (contrat) : pour une période tombée en heure d'hiver, « Aller à… » peut déborder d'une heure autour de minuit. Les groupes de la grille sont calculés dans le navigateur avec l'heure locale réelle de chaque fichier.
- **Source navigateur** : `promptForNode` ne lit pas les nœuds `TextEncodeQwenImage21` ni `TextEncodeQwenImageEditPlus` ni `PrimitiveString` : un prompt écrit littéralement dans l'un de ces nœuds (cas des images Qwen 2.1) manque donc côté navigateur. Non corrigé (hors périmètre) ; le service, lui, les lit.
- **Rail « Studio | Canvas »** : il déborde et recouvre le début du champ de recherche à partir de 768 px (défaut préexistant, visible dès avant la galerie sur « Options avancées » ; non corrigé).
- **Une lightbox pleine résolution n'existe pas pour la corbeille** (miniature seulement).

**Sécurité et exploitation**

- Le contrôle `Origin` = `Host` ne protège pas d'un rebinding DNS (même exposition que le reste de l'app : ComfyUI est proxifié sans authentification). Parade possible : liste d'hôtes autorisés (`server_name` nginx).
- Un fichier de `output/` qui n'appartient pas à l'UID du service (créé en root) ne peut pas être déplacé : `os.link` échoue (`protected_hardlinks=1`), réponse 500, rien ne bouge.
- `nginx.conf` est monté en fichier unique : après modification, le conteneur web doit être recréé (`docker compose up -d --force-recreate ai-content-studio`).
- **Q3 (source unique des prompts Studio / Engine, I13-B)** : toujours ouverte, décision de l'utilisateur en attente ; le garde-fou reste `node tools/parity-prompts.js`.

## Preuves (bancs hors dépôt, voir `docs/TESTING.md` § « Bancs de la galerie »)

- **B1** : banc de lecture 269 contrôles + garde anti-vidage 5, 0 échec ; scan initial de 1 767 fichiers en 14,4 s dans le conteneur (dominé par `ffprobe` des mp4), rescan sans changement 0,01 s, base de 10 Mo ; `indexed` = `find … | wc -l` (écart 0).
- **B2** : `--check` du service, banc hostile 146 contrôles, banc d'écriture 85, banc de lecture 273 + 5 ; 7 mutations du service, toutes tuées (la mutation 3 a d'abord survécu : mutant équivalent, redéfinie puis tuée).
- **A** : `bench-gallery` 49/49 (témoin négatif 41/49) ; graphes soumis identiques octet pour octet (37 scénarios, 112 corps `/prompt`, 407 243 o, 219 uploads, 17 corps ollama, 15 103 o) ; parité des prompts 52 119 contrôles.
- **B3a** : `bench-service` 152/152, aussi dans les fuseaux Los Angeles et Kolkata ; témoin négatif tué ; couture champ par champ.
- **B3b** : `bench-meta` 134/134, aussi derrière un vrai nginx et dans le fuseau Los Angeles ; 19/19 champs de l'objet C1 affichés ou cités ; `proofs-4a` 159, `proofs-4b` 92, `proofs-mem` 44 ; audit i18n vide dans les 4 langues.

## Contrat

> Source unique. Le lot L0 l'a copié **tel quel** dans ce § Contrat ; B1, B2, B3a et B3b s'y sont conformés, A a implémenté le §2 (source navigateur). Le lot D ne l'a corrigé que pour les **écarts actés** dans les commits ou les notes de lot (marqués « Écart acté »).

### C1. Objet « asset » commun (JSON côté service, objet JS côté navigateur)

```jsonc
{
  "key": "studio/story/key_01_00062_.png", // chemin relatif POSIX sous output/, JAMAIS de "/" initial ; racine : "ai_studio_x.png"
                                           // corbeille : ".trash/<ms>-<hex6>/<clé d'origine>" ; image cloud de session : "cloud:<nom>"
  "filename": "key_01_00062_.png",
  "subfolder": "studio/story",             // "" à la racine
  "type": "image",                         // "image" | "video"
  "url": "/comfy/view?filename=key_01_00062_.png&subfolder=studio%2Fstory&type=output&v=1758791234567",
                                           // pleine résolution : lightbox, « Utiliser en entrée », glisser-déposer.
                                           // Navigateur : URL /view historique sans &v ; cloud : blob:
  "thumb": "/gallery/thumb?key=studio%2Fstory%2Fkey_01_00062_.png&v=1758791234567",
                                           // navigateur : = url pour une image, null pour une vidéo
  "ts": 1758791234567,                     // ms epoch ; service = mtime ; navigateur = horodatage à l'ajout, null si entrée d'avant 1.4.0
  "prompt": "…",                           // /assets : 400 caractères max ; /asset : complet ; null si inconnu
  "pipeline": "storyboard_v2",             // clé de PIPELINE_LABELS, ou "canvas", ou null (= « Autre »)
  "model": "qwen_image_edit_2509_fp8_e4m3fn", // nom de fichier sans extension ; null si inconnu
  "loras": ["Qwen/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16"], // sans extension
  "seed": 653521632,                       // entier littéral, sinon null
  "w": 1280, "h": 720,                     // pixels réels du fichier (null côté navigateur)
  "duration": null,                        // s (vidéo), sinon null
  "size": 1534221,                         // octets (null côté navigateur)
  "fav": false,
  "tags": [],                              // noms ; toujours [] côté navigateur
  "label": null,                           // navigateur seulement : libellé du job ; service : null
  "trash": null                            // service, périmètre "trash" : {"origKey": "...", "at": ms}
}
```

Clés du navigateur. Les clés historiques en localStorage (`galleryAssets`, `deletedAssets`, `assetPrompts`) **gardent** leur format `${subfolder}/${filename}` (donc `/x.png` à la racine) : pas de migration. La source navigateur expose `key = subfolder ? subfolder + "/" + filename : filename`. Les nouvelles clés localStorage (favoris) prennent le format du contrat.

### C2. Interface JS de source (index.html)

```js
// Une source = un objet littéral. Deux implémentations : browserSource (lot A), serviceSource (lot B3a).
// Variable courante : gallerySource ; rechargement : galleryReload().
const source = {
  id: "browser" | "service",
  caps: { scope, models, tags, dates, rename, trash },   // booléens ; l'UI n'affiche que ce que la source sait faire
  // f = { type: "image"|"video", q: "", pipeline: "" | id | "none", fav: false,
  //       model: "", tag: "", from: null|ms, to: null|ms, sort: "new"|"old", scope: "app"|"all"|"trash" }
  // Champs non gérés par la source (d'après caps) : ignorés. cursor null = 1re page. Page = 60.
  list(f, cursor),       // → Promise<{ items: Asset[], next: string|null, counts: { image: n, video: n } }>
                         //   counts = nombre d'éléments qui passent TOUS les filtres sauf `type`
  setFav(keys, on),      // → Promise<void>
  remove(assets),        // → Promise<undo>, undo = () => Promise<void> (passé à undoToast)
  // service seulement :
  detail(key),           // → Promise<Asset> (prompt complet ; indexe à la demande un fichier récent)
  dates(unit, f),        // → Promise<{ start, end, count }[]>, unit = "day"|"week"|"month"
  facets(f),             // → Promise<{ pipelines, models, tags }>
  tag(keys, add, remove),// → Promise<[{key, tags}]>    (écart acté B3b : le contrat disait Promise<void> ; lots de 100)
  rename(key, name),     // → Promise<Asset>
  restore(trashKeys)     // → Promise<[{trashKey, key}]> (écart acté B3b : le contrat disait Promise<void> ; lots de 100)
};
```

- `browserSource.caps` = tout à `false`. `serviceSource.caps` = tout à `true`.
- **Les éléments de session** (`cloud:*`) sont toujours affichés en tête, quelle que soit la source. **Écart acté (B3b)** : sauf dans le périmètre `trash`, où la source service n'en ajoute pas.
- **Un asset reçu en direct** (WebSocket ou historique) est toujours persisté dans la source navigateur (`persistAsset`, avec `ts`), même quand la source active est le service, pour que le repli reste utile.

### C3. API HTTP du service `gallery`

- nginx `location ^~ /gallery/ { proxy_pass http://127.0.0.1:8094/; proxy_set_header Host $http_host; proxy_set_header X-Real-IP $remote_addr; client_max_body_size 1m; proxy_read_timeout 60s; }`. **Il faut `$http_host` et non `$host`** : `$http_host` garde le port, ce qu'exige la comparaison avec Origin.
- Toutes les réponses JSON portent `Cache-Control: no-store`. Erreur = `{"error": "<code>", "detail": "<texte FR>"}`.
- Codes d'erreur :

| HTTP | `error` | Cas |
|---|---|---|
| 400 | `bad_request` | paramètre, clé, nom ou curseur invalide |
| 403 | `cross_origin` | contrôle de même origine échoué |
| 404 | `not_found` | clé ou fichier inconnu, route inconnue, miniature impossible (PNG abîmé, vidéo de 0 octet) |
| 405 | `method` | méthode non autorisée sur la route |
| 409 | `exists` ou `locked` | destination déjà prise, ou dossier verrouillé |
| 413 | `too_large` | plus de 100 clés, ou corps de plus de 64 Ko |
| 415 | `json_required` | POST sans `Content-Type: application/json` |
| 500 | `internal` | erreur interne |

**Lecture (lot B1)**

| Route | Paramètres | Réponse |
|---|---|---|
| `GET /health` | aucun | `{"ok":true,"root":"/output","indexed":n,"app":n,"trashed":n,"scanning":bool,"lastScanMs":ms\|null,"scanSeconds":x,"warning":null\|"texte","schema":1}`. L'UI lit `ok`, `indexed`, `scanning` et `warning` ; les autres champs servent au diagnostic par curl. |
| `GET /assets` | `type=image\|video` (défaut image), `q`, `pipeline=<id>\|none`, `model`, `tag`, `fav=1`, `from`/`to` (ms epoch, from inclus, to exclu), `scope=app\|all\|trash` (défaut app), `sort=new\|old` (défaut new), `limit` 1-200 (défaut 60), `cursor` | `{"items":[Asset…],"next":"<curseur>"\|null,"counts":{"image":n,"video":n}}` |
| `GET /asset?key=` | clé (y compris `.trash/…` si à la corbeille) | Asset avec `prompt` complet. Clé valide et fichier présent mais pas encore indexé : il est indexé tout de suite. Sinon 404. |
| `GET /thumb?key=&v=` | clé, version | `image/webp`, côté long 320 px au plus, `Cache-Control: public, max-age=31536000, immutable` |
| `GET /dates` | mêmes filtres que /assets (sans cursor, limit, sort) + `unit=day\|week\|month` + `tzOffset` (minutes, = `new Date().getTimezoneOffset()`) | `{"unit":"day","periods":[{"start":ms,"end":ms,"count":n}…]}`, du plus récent au plus ancien. Semaine = du lundi au lundi. |
| `GET /facets` | `scope` | `{"pipelines":[{"id":"text2image"\|null,"count":n}],"models":[{"name":"…","count":n}],"tags":[{"name":"…","count":n}]}`. Les tags à 0 sont inclus ; la corbeille est exclue sauf si `scope=trash`. |

- **Curseur** : `base64url(JSON [sort, mtime, key])`, opaque pour le client. Pagination par clé (`mtime DESC, key DESC` pour `new`, ordre inverse pour `old`). Un curseur d'un autre `sort` est refusé en 400.
- **`q`** : `re.findall(r"\w+", q)[:8]`. Chaque mot devient `"mot"*` (guillemets doublés), reliés par `AND`, dans `MATCH` sur `assets_fts` (prompt, texts, key, model). Aucun mot : filtre ignoré.

**Écriture (lot B2).** Toutes les routes sont en POST, corps JSON de 64 Ko au plus, même origine obligatoire (§C6).

| Route | Corps | Réponse |
|---|---|---|
| `/fav` | `{"keys":[≤100],"fav":bool}` | `{"ok":true,"changed":n}` |
| `/tags` | `{"name":"…"}` (1-40 caractères après trim, sans caractère de contrôle, unique sans casse ; écart acté B2 : casse Unicode complète, `casefold`) | `{"ok":true,"tag":{"name","count"}}`, idempotent |
| `/tag` | `{"keys":[≤100],"add":[noms],"remove":[noms]}` | `{"ok":true,"assets":[{"key","tags":[…]}]}`. Un tag ajouté qui n'existe pas est créé. |
| `/rename` | `{"key":"…","name":"nouveau.png"}` | `{"ok":true,"asset":Asset}`. Même dossier, même extension (sans casse), 150 caractères au plus, ni `/`, ni `\`, ni NUL, ni caractère de contrôle, pas de `.` initial. 409 `exists` si la destination existe, 409 `locked` si la clé correspond à `^studio/(story\|relay)/` (fichiers référencés par les sessions storyboard). |
| `/trash` | `{"keys":[≤100]}` | `{"ok":true,"trashed":[{"key":"<origine>","trashKey":".trash/<ms>-<hex6>/<origine>"}]}`. Toutes les clés sont validées avant tout déplacement. Si un déplacement échoue, réponse 500 avec la liste de ce qui est déjà déplacé. |
| `/restore` | `{"keys":[trashKeys ≤100]}` | `{"ok":true,"restored":[{"trashKey","key"}]}`. Si l'origine est prise, le fichier revient sous `<stem>_restored<ext>`, puis `_restored2`… |

**Écarts actés (lot B2, 2026-09-25)** : le contrôle C6 s'exécute avant le routage (un POST sans `Content-Type` JSON sur une route de lecture répond 415, pas 405) ; PUT, DELETE, PATCH et HEAD répondent 405 sur toute route ; des clés en double dans une requête → 400 `bad_request` ; les 500 de `/trash` **et** `/restore` portent la liste de ce qui est déjà fait (`trashed` / `restored`) ; un renommage ne change que la clé (pipeline et périmètre « app » gardent leur valeur d'origine) ; le rescan relit la ligne par sa clé sous le verrou avant toute suppression (correction d'une perte de tags/favoris lors d'un renommage pendant un scan).

Il n'existe **aucune** route de suppression définitive. La purge de la corbeille est manuelle : `rm -r output/.trash`.

### C4. Schéma SQLite (`/data/gallery.db`, créé en entier par B1)

```sql
PRAGMA journal_mode = WAL;   -- à l'ouverture
PRAGMA foreign_keys = ON;    -- à chaque connexion
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS assets (
  id         INTEGER PRIMARY KEY,
  key        TEXT    NOT NULL UNIQUE,        -- chemin relatif POSIX ; à la corbeille : ".trash/<id>/<orig_key>"
  type       TEXT    NOT NULL CHECK (type IN ('image','video')),
  mtime      INTEGER NOT NULL,               -- ms epoch = date de l'asset
  mtime_ns   INTEGER NOT NULL,               -- détection de changement au rescan
  size       INTEGER NOT NULL,
  w INTEGER, h INTEGER, duration REAL,
  prompt     TEXT,                           -- prompt positif retenu (complet)
  texts      TEXT,                           -- repli de recherche : tous les textes ≥ 20 car. du graphe, joints par '\n'
  prefix     TEXT,                           -- key sans compteur ni extension ("studio/story/key_01")
  pipeline   TEXT,                           -- table C5 ; NULL = « Autre »
  model      TEXT,
  loras      TEXT    NOT NULL DEFAULT '[]',  -- JSON
  seed       INTEGER,
  app        INTEGER NOT NULL DEFAULT 0,     -- 1 = périmètre « app »
  meta_ok    INTEGER NOT NULL DEFAULT 1,     -- 0 = extraction en échec, réessayée seulement si mtime_ns/size changent
  fav        INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,                        -- ms ; NULL = hors corbeille
  orig_key   TEXT                            -- clé d'origine si à la corbeille
);
CREATE INDEX IF NOT EXISTS assets_list  ON assets (trashed_at, type, mtime DESC, key DESC);
CREATE INDEX IF NOT EXISTS assets_pipe  ON assets (pipeline);
CREATE INDEX IF NOT EXISTS assets_model ON assets (model);
CREATE INDEX IF NOT EXISTS assets_fav   ON assets (fav) WHERE fav = 1;

CREATE TABLE IF NOT EXISTS tags (
  id      INTEGER PRIMARY KEY,
  name    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (asset_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS asset_tags_tag ON asset_tags (tag_id);

-- rowid = assets.id ; tenue à jour dans la MÊME transaction que assets (insert, update, delete, rename, trash)
CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
  prompt, texts, key, model, tokenize = 'unicode61 remove_diacritics 2'
);
```

Tags et favoris sont rattachés à `assets.id`. Renommer ou envoyer à la corbeille ne modifie donc **qu'une ligne** (`key`, et la colonne `key` de `assets_fts`), dans la même transaction que le déplacement du fichier. Les PNG ne sont jamais réécrits. Tags et favoris ne vont jamais dans les fichiers.

### C5. Règles d'indexation

- **Fichiers indexés** : `.png .jpg .jpeg .webp` → `image` ; `.mp4 .webm .mov` → `video`. Tout le reste est ignoré (mp3, fichiers témoins).
- **Parcours** : `os.scandir` récursif, `follow_symlinks=False`. On **saute** tout lien symbolique et tout nom qui commence par « . » (d'où `.trash`). On saute aussi tout fichier dont `mtime` a moins de 5 s : il est peut-être en cours d'écriture, le prochain passage le prendra.
- **Passages** : un scan initial au démarrage (dans un thread), puis toutes les `SCAN_INTERVAL` s (défaut 60).
- **Mise à jour incrémentale** : un fichier nouveau, ou dont `(mtime_ns, size)` a changé, est extrait hors verrou puis upserté sous verrou, après un nouveau `stat`.
- **Fichier disparu** : sa ligne est supprimée sous verrou, après une nouvelle vérification `os.path.lexists`. **Garde anti-vidage** : si la racine est absente, ou si le parcours ne trouve 0 fichier alors que la base a plus de 0 ligne hors corbeille, **aucune suppression** et `health.warning` est renseigné.
- **Lignes à la corbeille** : supprimées seulement si leur fichier `.trash/…` a disparu (purge manuelle).
- **Date** = `mtime`.
- **Taille** : IHDR (PNG) ou Pillow pour les images, ffprobe pour les vidéos.
- **Métadonnées** :
  - graphe = chunk PNG `tEXt` `prompt`, lu avant IDAT ; pour une vidéo, `ffprobe -v error -print_format json -show_format -show_streams` puis `format.tags.prompt`.
  - Nœuds de départ = nœuds dont `inputs.filename_prefix` == `prefix` du fichier. S'il n'y en a aucun, tous les nœuds qui ont un `filename_prefix`.
  - On remonte les liens vers l'amont, comme `promptForNode` d'index.html.
  - **prompt** = la plus longue chaîne parmi `CLIPTextEncode.text`, `PrimitiveStringMultiline.value`, `PrimitiveString.value`, `TextGenerateLTX2Prompt.prompt`, `TextEncodeQwenImage21.prompt`, `TextEncodeQwenImageEditPlus.prompt`, en suivant un saut de lien vers `value`/`text`/`prompt`. **Jamais** `negative_prompt`. **Écart acté (lot B1, 2026-09-25)** : la remontée d'un `TextGenerate*` (LLM d'enrichissement) s'arrête à ce nœud, sinon la consigne système de l'enhancer (plus longue que le prompt) serait retenue ; la remontée ne suit jamais l'entrée nommée `negative` (le négatif par défaut de Qwen 2.1 est plus long que le positif). Consigne système et négatif restent dans `texts` : la recherche les trouve.
  - **model** = premier `UNETLoader.unet_name`, sinon `CheckpointLoaderSimple.ckpt_name`, trouvé en amont.
  - **loras** = `lora_name` de `LoraLoader*` en amont. Limite connue : une LoRA court-circuitée par un switch est quand même listée.
  - **seed** = premier `seed` ou `noise_seed` entier littéral, ou atteint par un saut vers un `Primitive*`.
  - **texts** = toutes les valeurs chaîne de 20 caractères ou plus du graphe, sauf les clés `filename_prefix`, `attention`, `sigmas`, `image`, `video`, `audio`, `*_name`, et sauf les valeurs qui finissent par `.safetensors .gguf .pt .png .jpg .mp4 .webp`.
- **prefix** = `key` privée de `_\d{5}_?\.\w+$`, sinon de son extension.
- **Périmètre « app »** : `app = 1` si la clé correspond à `^(studio|canvas|campaign|storyboard|localized|video)/|^ai_studio_` **et** pas à `^studio/(lot1|lotA|q21|inspect)/|^studio/lot\d`. La seconde regex est une proposition du plan, à confirmer par l'utilisateur ; la retirer coûte une ligne.
- **Pipeline** (première correspondance) :

```
^studio/(story|relay)/                          → storyboard_v2
^(studio/)?campaign/                            → campaign_full
^studio/sequence_                               → sequence2video
^studio/minimax_h3_r2v_                         → reference2video
^studio/((ltx25|minimax_h3)_i2v|ltx25_flf2v)_   → image2video
^studio/(ltx25|minimax_h3)_t2v_                 → text2video
^studio/(edit|qwen21_i2i|market_[a-z]+)_        → image2image
^studio/(krea2|qwen21_t2i|flux2|ernie|zimage)_  → text2image
^canvas/                                        → canvas
sinon                                           → null
```

### C6. Sécurité (frontière)

- **Clé** : chaîne de 1 à 1 024 caractères, sans NUL ni `\`, sans `/` initial. Aucun segment vide, `.` ou `..`. Aucun segment qui commence par « . », sauf le premier segment `.trash` pour une clé de corbeille (routes `/restore`, `/thumb`, `/asset`, seulement si la ligne est à la corbeille). Extension autorisée.
- **Contrôle anti-lien** : `os.path.realpath(join(ROOT, key)) == os.path.normpath(join(realpath(ROOT), key))`. L'égalité garantit qu'aucun lien symbolique n'apparaît sur le chemin.
- **Existence** : les routes qui agissent sur un asset exigent aussi une **ligne en base**.
- **Écriture** : POST seulement, sinon 405.
  - `Content-Type` qui commence par `application/json`, sinon 415.
  - `Sec-Fetch-Site`, s'il est présent, doit valoir `same-origin`, sinon 403.
  - `Origin`, s'il est présent, doit avoir un `netloc` égal à l'en-tête `Host`. Sinon il faut un `Referer` présent dont le `netloc` est égal à `Host`. Sinon 403.
- **Plafonds** : 100 clés par requête, 64 Ko de corps.
- **Déplacements** (renommage, corbeille, restauration) : `os.makedirs(dest_dir)`, puis `os.link(src, dst)` (qui échoue si `dst` existe, donc jamais d'écrasement), puis `os.unlink(src)`. Tout se fait sous le verrou global, dans la transaction SQLite, avec rollback si `link` échoue.
- **Aucune** autre suppression de fichier. Aucun client réseau dans le service : il ne contacte **jamais** ComfyUI.
- **Conteneur non root** : `user: ${APP_UID:-1000}:${APP_GID:-1000}`.

