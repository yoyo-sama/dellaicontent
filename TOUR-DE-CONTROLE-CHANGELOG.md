# Tour de contrôle — changelog

## 2026-09-09 (suite) — v1.0.8 — Service installé mais arrêté : redémarré, pas doublé

`install.sh` ne testait que « le service répond-il ? ». Répondre non ne veut pas dire absent : le conteneur peut exister à l'arrêt, ou Ollama être installé nativement et son service systemd stoppé. Dans les deux cas la version précédente créait une stack — conflit de nom de conteneur dans le premier cas (les noms sont uniques), deux Ollama qui se disputent le port 11434 au prochain boot dans le second.

Ordre de traitement quand un service ne répond pas, pour ComfyUI comme pour Ollama :

1. **Conteneur arrêté** (`exited`/`created`/`paused`) portant l'image du rôle → `docker start`, puis attente de la santé HTTP (`restart_stopped_service`). Un conteneur qui démarre sans répondre est signalé comme tel et **rien d'autre n'est créé** — c'est un problème à regarder dans `docker logs`, pas à contourner par un doublon.
2. **Ollama natif arrêté** (`command -v ollama`, ou unité `ollama.service` connue de systemd) → `systemctl start ollama` en root, sinon `sudo -n systemctl start ollama`. Le `-n` est essentiel : il échoue immédiatement au lieu d'attendre un mot de passe qui ne viendra jamais dans un script non interactif. En cas d'échec, la commande à lancer est affichée et aucun conteneur n'est créé.
3. **Port occupé** par autre chose → rien créé, message explicite.
4. **Rien de tout ça** → création de la stack, comme avant.

Ajouté au passage : `wait_for_http` (attente factorisée) et `resolve_comfy_paths` (les bind-mounts du conteneur font autorité sur les chemins par défaut) — cette dernière est maintenant appelée aussi sur le chemin « conteneur redémarré », sans quoi les modèles auraient pu être téléchargés à côté du dossier réellement lu par ce ComfyUI-là.

### Vérification

Détection des conteneurs arrêtés testée sur le vrai Docker de la machine (conteneur `ollama/ollama` créé puis détecté, le conteneur en marche étant bien ignoré, sonde supprimée). Les trois branches testées bout en bout en simulation (`docker`/`curl`/`sudo`/`systemctl` stubés) : conteneur Ollama arrêté → `restarted (ollama-old)` + modèle tiré ; Ollama natif arrêté sans sudo autorisé → `skipped`, marche à suivre affichée, récapitulatif `Ollama unavailable` ; Ollama natif arrêté avec démarrage réussi → `started (native service)` + modèle tiré. Non-régression : exécution réelle d'`install.sh` sur ce GB10, tout réutilisé, chemins résolus, health-checks 200.

## 2026-09-09 — v1.0.7 — Une stack Docker par service à la racine du home (déploiement GB10 corrigé)

Déclencheur : installation sur une machine neuve. Génération impossible, `Error: JSON.parse: unexpected character at line 1 column 1` (le `await res.json()` de `submitGraph` sur une page d'erreur HTML de nginx) et `Enhancement failed: NetworkError`. Cause réelle trouvée en remontant depuis un détail signalé par l'utilisateur — un cadenas sur le dossier `comfyui/` du repo :

1. **`docker-compose.yml` et `install.sh` n'étaient pas d'accord sur l'emplacement des modèles.** Le service `comfyui` du compose de l'app n'avait aucun bloc `environment` — donc pas de `BASE_DIRECTORY: /basedir`, alors que l'image `mmartial` ne relocalise ses modèles que sur cette variable. ComfyUI lisait `/comfy/mnt/ComfyUI/models` pendant qu'`install.sh` téléchargeait dans `/basedir/models`. Manquaient aussi les flags GB10 de la stack de référence (`--disable-pinned-memory --reserve-vram 8`) et `WANTED_UID/GID`.
2. **Dossiers créés par dockerd en `root`.** Les bind-mounts (`./comfyui/basedir`, `./run`, `./userscripts_dir`) étaient créés par Docker au premier `up -d`, donc en root:root : d'où le cadenas, et surtout l'échec en « permission denied » de tous les `mkdir`/`curl` de l'étape 5. Seul `loras/` existait (créé par le bind-mount de l'updater) — d'où un dossier de modèles vide.
3. **Ordonnancement.** Les userscripts (installation de comfy_kitchen) étaient copiés en étape 4, soit APRÈS la création du conteneur en étape 2 — ils ne sont joués qu'au démarrage, donc jamais sur une installation fraîche. Et le script se terminait « OK » sans jamais attendre que ComfyUI réponde sur :8188, alors que son premier boot dure plusieurs minutes.

### Structure retenue (demandée par l'utilisateur, identique au poste de référence)

Une stack par service, chacune à la racine du home : `~/ai-content-studio` (app + updater), `~/comfyui-spark` (ComfyUI), `~/ollama` (Ollama). Le compose du repo ne déclare plus que `ai-content-studio` et `updater` ; les deux voisines sont créées par `install.sh` depuis les gabarits `docker/stacks/comfyui.yml` et `docker/stacks/ollama.yml`. Le gabarit ComfyUI est le décalque de `~/comfyui-spark/compose.yaml` de la machine de référence, **sans le `HF_TOKEN` en dur** (`${HF_TOKEN:-}`) et sans son réseau externe `ai-studio-net`.

### Fichiers touchés

- `docker-compose.yml` — services `comfyui` et `ollama` retirés ; défaut du montage LoRA sur la stack voisine (`../comfyui-spark/basedir/models/loras`)
- `docker/stacks/comfyui.yml`, `docker/stacks/ollama.yml` — nouveaux gabarits
- `install.sh` — `COMFY_DIR`/`OLLAMA_DIR` sous `$HOME`, fonctions `create_comfy_stack`/`create_ollama_stack`/`copy_userscripts`, dossiers créés côté utilisateur AVANT les conteneurs, userscripts déposés avant le premier `up -d`, garde d'écriture sur le dossier de modèles (échec explicite au lieu de 19 téléchargements en erreur), attente de ComfyUI sur :8188 après création, migration depuis l'ancienne mise en page, récapitulatif avec les emplacements réels
- `README.md`, `README.fr.md`, `AGENTS.md` — trois stacks au lieu de trois services, chemins de modèles en `~/comfyui-spark/basedir/models/`
- `VERSION` — 1.0.7

### Sortie terminal en anglais + Ollama détecté au niveau service

Tous les messages d'`install.sh` sont en anglais (commentaires du code laissés en français, comme le reste du dépôt). Deux corrections de robustesse remontées par un test sur poste Ubuntu où Ollama était **installé nativement** (systemd, donc pas un conteneur) : `find_container_by_port` ne trouvait rien, le script tombait sur `OLLAMA_CONTAINER="(inconnu)"` et abandonnait silencieusement le pull du modèle.

- **Pull par l'API HTTP** (`POST /api/pull`, résultat revérifié par `/api/tags` car l'API répond 200 même quand le tirage échoue en cours de flux) au lieu de `docker exec` : identique que Ollama tourne dans notre conteneur, dans celui d'un autre projet, ou nativement. La branche « conteneur non identifié » disparaît.
- **Garde de port** avant toute création de stack : si `:8188`/`:11434` est occupé par un service qui ne répond pas au health-check, rien n'est créé et le script dit quoi libérer — au lieu de laisser Docker échouer sur « port is already allocated ».

Corrigé au passage : `find_container_by_port` pouvait désigner l'updater plutôt que nginx pour le port 8090 (les deux montent la racine du repo en network host) — la destination `/usr/share/nginx/html` les distingue.

### Aucun chemin ni uid en dur

Le poste cible n'a pas le même utilisateur que la machine de référence. `install.sh` ne connaît que `$HOME` et `$REPO_ROOT` (déduit de `BASH_SOURCE`). Le gabarit ComfyUI passe par `WANTED_UID: "${WANTED_UID:-1000}"` / `WANTED_GID` et `install.sh` écrit les valeurs réelles (`id -u`/`id -g`) dans `~/comfyui-spark/.env`, lu par compose y compris lors d'un `docker compose up -d` lancé à la main plus tard. `tools/validate.py` et `tools/onboard.py`, qui pointaient en dur sur `/home/sparks/comfyui-spark/basedir`, dérivent désormais de `COMFY_BASEDIR` avec repli sur `~/comfyui-spark/basedir` ; `docs/TESTING.md` idem. Les chemins `/home/sparks` restants ne sont plus que des relevés historiques (LESSONS, ARCHITECTURE, NOUVEAUX-MODELES, ce changelog).

### Migration d'une machine déjà installée en ancienne mise en page

`install.sh` détecte un conteneur ComfyUI ou Ollama dont le label compose pointe sur le `docker-compose.yml` du repo, le supprime et recrée la stack voisine. Les poids Ollama sont repris du volume nommé `ollama-data` (copie vers `~/ollama/data`, évite 9,6 Go de retéléchargement) ; les modèles ComfyUI de l'ancien `~/ai-content-studio/comfyui/basedir/models` ne sont PAS déplacés automatiquement — le script affiche le chemin et laisse l'utilisateur faire le `mv`.

### Vérification

1. **Chemin réutilisation** : `install.sh` exécuté en vrai sur la machine de référence — les trois services préexistants réutilisés sans être touchés, chemins résolus sur `/home/sparks/comfyui-spark/basedir/models`, 20 modèles reconnus, aucun dossier créé à tort.
2. **Chemin création (poste vierge)** : `install.sh` rejoué avec `docker` et `curl` remplacés par des stubs (aucun conteneur, santé HTTP en échec) et un `$HOME` temporaire — les deux stacks sont créées, tous les dossiers appartiennent à l'utilisateur (aucun dossier root, le bug d'origine), les userscripts sont déposés AVANT le `up -d`, `.env` pointe sur la stack, la boucle d'attente sur `:8188` sort dès que le service répond.
3. **Stack Ollama réellement démarrée** (copie isolée, port 21434, conteneur `ollama-selftest`) : `/api/version` répond, l'entrypoint enchaîne sur `ollama pull gemma4:e4b`, le bind-mount `./data` se remplit. Détruit après coup. C'était la seule pièce nouvelle — l'ancien compose utilisait un volume nommé.
4. **Stack ComfyUI** : `docker compose config` depuis un dossier neuf — `BASE_DIRECTORY`, flags GB10 et les trois montages résolus en absolu sous le dossier de la stack ; `WANTED_UID/GID` prennent bien la valeur du `.env` (testé avec 4242/4343, valeurs arbitraires ≠ 1000).
5. **Outils** : `HOME=/home/alice` → `validate.MODELS_DIR = /home/alice/comfyui-spark/basedir/models` ; `COMFY_BASEDIR=/srv/comfy` → `/srv/comfy/models`.

Non prouvé ici, et qui ne peut l'être que sur la machine cible : le premier boot réel de ComfyUI (build comfy_kitchen) et les téléchargements de modèles.

## 2026-09-08 (suite 2) — v1.0.6 — Mode Réalisateur par défaut sur `reference2video` (revue des fiches avant lancement vidéo) + bypass "Ignorer les fiches" (références utilisateur seules, jusqu'à 9)

Deux lots liés autour du pipeline `reference2video` (Minimax H3, cohérence personnage+décor en un seul job vidéo), demandés par l'utilisateur après constat que le flux Auto seul (aucun arrêt de revue avant un rendu vidéo coûteux) ne convenait pas à cet usage. Les deux vérifiés par un vrai rendu ComfyUI inspecté (jamais le seul statut de job).

### Mode Réalisateur porté sur `reference2video`, DÉFAUT ON (Auto reste le défaut de `storyboard_v2`, inchangé)

Jusqu'ici seul `storyboard_v2` avait un mode Auto/Réalisateur — une coquille studio plein écran (`enterStudio()`, `#studioNav`, `STUDIO_SECTIONS`) à 4 étapes (Personnage → Décor → Storyboard → Montage). `reference2video` n'avait qu'un flux Auto un clic (fiches + vidéo, aucun arrêt de revue). L'utilisateur a demandé un mode Réalisateur pour `reference2video` aussi, mais **allégé** : revoir/régénérer les 2 fiches (personnage, décor) avant de lancer le job vidéo, SANS étape Storyboard/keyframes/Montage (ce pipeline est un seul job vidéo, pas un montage plan par plan) — et **par défaut** pour ce pipeline précisément.

Implémentation : réutilisation du cœur de revue de planches déjà générique côté `storyboard_v2` (`director.charFields/locFields/charVariants/locVariants/charActive/locActive/validated`, `renderSheetMenu`/`regenerateSheet`/`importSheetImage`/`anchorsReady`/`updateValidateButtonState` — aucune de ces fonctions n'était storyboard-spécifique, elles opéraient déjà sur des `kind` génériques `"char"`/`"loc"`), pas une reconstruction. Nouvelles pièces :
- **`director.pipeline`** (`"storyboard_v2"` ou `"reference2video"`) ajouté partout où un `director` est construit : `directorStep1`, le nouveau `directorStepR2V1`, et le chemin de reprise de `restoreProject`.
- **3ᵉ étape minimale dédiée** : `STUDIO_SECTIONS.video` → nouvelle section `#studioVideoR2V` (ligne de statut `#studioVideoR2VStatus` + bouton unique `#directorR2VLaunchBtn` "Lancer la vidéo"), à la place des étapes Storyboard/Montage de `storyboard_v2`.
- **`updateStudioNavForPipeline()`** : montre/masque les onglets `#studioNav` selon `director?.pipeline` — `storyboard`+`montage` pour `storyboard_v2`, `video` pour `reference2video`. `director` absent (juste après un reset) retombe sur la forme `storyboard_v2` par défaut — comportement identique à avant pour toute session non-r2v.
- **`updateGateState()`** branche désormais sur `director?.pipeline === "reference2video"` : pour r2v, active/désactive directement `#directorR2VLaunchBtn` + l'onglet Vidéo sur la même condition (`anchorsReady() && director.validated`) que `storyboard_v2` utilisait déjà pour débloquer son onglet Storyboard — même sémantique, cible différente. **Le choix de tester `=== "reference2video"` plutôt que `=== "storyboard_v2"` n'est pas cosmétique** : `resetDirectorZone()` met `director = null` AVANT d'appeler `updateGateState()`, et avec le test retenu `director` null retombe sur la branche `storyboard_v2` (comportement historique) — un test symétrique inversé aurait laissé les onglets dans le mauvais état à chaque reset. Détail : `docs/LESSONS.md` piège n°18.
- **`directorStepR2V1(seed, width, height)`** (nouveau) : soumet uniquement les 2 jobs de fiches (personnage+décor), construit un `director` allégé — sans `shots`/`keyframes`/`cutPlan` — plus le contexte du job final (`seed, width, height, wf, negText, duration, turboOn, loraName`) **figé à cet instant précis** pour que le lancement, plus tard, ne relise pas un formulaire que l'utilisateur aurait modifié entre-temps (même principe déjà appliqué par `directorStep1` pour son propre champ `style`).
- **`generateReference2VideoFromDirector()`** (nouveau, câblée sur le bouton `#directorR2VLaunchBtn`) : lit `charName`/`locName`/`charDesc`/`locDesc` de la session `director` validée (getters déjà existants — variante active / champs édités) au lieu de régénérer quoi que ce soit, puis exécute exactement la seconde moitié de ce que le chemin Auto faisait déjà. Cette queue commune (collecte des références supplémentaires → construction du graphe → greffe refs/turbo/style-LoRA → soumission) a été extraite dans un nouveau helper **`submitReference2VideoGraph({...})`**, appelé à la fois par le chemin Auto et par ce nouveau chemin de lancement Réalisateur (seule différence entre les deux appelants : d'où viennent `prompt`/`image`/`image2`).
- **`BUILDERS.reference2video`** dispatche désormais vers `directorStepR2V1` quand le mode Réalisateur est actif (miroir de ce que `storyboard_v2` fait déjà vers `directorStep1`), au lieu d'appeler systématiquement le chemin Auto.
- **`updateModelOptions()`** appelle `setDirectorMode(true)` spécifiquement quand le pipeline nouvellement sélectionné est `reference2video` (sans toucher au défaut existant de `storyboard_v2`, qui reste ce que l'utilisateur a réglé en dernier, Auto/`false` par défaut au chargement de la page).
- `"mode"` ajouté aux `controls` de `reference2video` (`PIPELINES_FALLBACK` dans `index.html` **et** `workflows/manifest.json`) pour que les boutons Auto/Réalisateur existants deviennent visibles sur ce pipeline.

**Correctif induit, non explicitement demandé mais nécessaire à la correction** : `saveProject()` (persistance de session LOT C, clé localStorage `studioProject`) est désormais gardée par `director.pipeline === "storyboard_v2"` uniquement (`if (!director || director.pipeline !== "storyboard_v2") return;`). Une session Réalisateur `reference2video` n'a rien d'analogue à "reprendre" (2 fiches puis un seul job vidéo, pas de `shots`/`keyframes`/`cutPlan`) ; sans cette garde, `saveProject()` aurait écrit un blob de projet malformé/incomplet que `restoreProject()` ne sait reconstruire que sous la forme `storyboard_v2` (elle force `pipeline: "storyboard_v2"` sur tout ce qu'elle restaure) — cassant silencieusement ou corrompant la reprise pour de vraies sessions `storyboard_v2` partageant la même clé `localStorage`.

**Vérifié en rendu réel (jamais sur le seul statut de job) :**
- **`storyboard_v2` re-testé de bout en bout** pour confirmer zéro régression : les 4 onglets restent intacts, revue/gate des planches inchangée, Storyboard/Montage toujours atteignables exactement comme avant.
- **`reference2video` Réalisateur** : défaut ON confirmé, le studio n'affiche que Personnage/Décor/Vidéo, revue de planches fonctionnelle, lancement correctement gaté, un vrai rendu soumis depuis une session VALIDÉE — graphe ComfyUI en file inspecté avant soumission : `ref_image_0`/`ref_image_1` pointaient bien vers les images des planches validées (pas des planches fraîchement régénérées). Sortie réelle `minimax_h3_r2v_00007_.mp4` — 1376×768, h264+aac, 2,33 s — confirmée par `ffprobe` et une frame médiane décodée montrant le bon personnage/décor (pas de contenu corrompu/générique).
- **Mode Auto re-confirmé fonctionnel** : basculé explicitement en arrière, fiches fraîches régénérées comme avant.

### "Ignorer les fiches" — bypass complet, références utilisateur seules, cap porté de 7 à 9

Nouvelle case à cocher `#skipSheetsToggle` (contrôle manifest `"skipSheets"` → wrap `skipSheetsWrap`, `reference2video` seul, dans `PIPELINES_FALLBACK` **et** `workflows/manifest.json`). Cochée, saute entièrement `submitCharsheetJob`/`submitLocsheetJob` — fonctionne identiquement en mode Auto ou Réalisateur (`BUILDERS.reference2video` vérifie le bypass **avant** de tester le mode Réalisateur, puisqu'il n'y a rien à revoir quand rien n'est auto-généré : bypass coché route toujours vers le chemin Auto, quel que soit l'état du toggle mode).

Mécanique : les 2 **premiers** fichiers de l'input multi-fichiers déjà existant "images de référence supplémentaires" (`#refImagesInput`, jusqu'ici réservé au mécanisme d'extras d'un chantier antérieur) sont uploadés via `uploadRefFile()` (déjà existant) et deviennent directement `ref_image_0`/`ref_image_1` (arguments `image`/`image2` de `buildGraph`) — confirmé contre le vrai template `workflows/api/minimax_h3_r2v.json` : nœuds `137`/`139`, des `LoadImage` câblés sur `{{IMAGE}}`/`{{IMAGE2}}`, alimentant `MiniMaxH3ReferenceToVideo.inputs["ref_images.ref_image_0"]`/`["ref_images.ref_image_1"]`. Les fichiers **restants** (3ᵉ et suivants) passent par le mécanisme d'extras existant `collectRefExtras()`/`addMinimaxRefs()`, **totalement inchangé** — `collectRefExtras` a seulement gagné un paramètre optionnel `imageFiles` pour que le chemin bypass lui passe "les fichiers à partir du 3ᵉ" au lieu de le laisser relire `#refImagesInput.files` brut ; les caps/index propres au mécanisme d'extras (7 pour les images, indexation `ref_image_{i+2}`) n'ont pas été touchés. Net : 2 fichiers (bypass, en `image`/`image2`) + jusqu'à 7 (extras inchangés) = **jusqu'à 9 références au total**, toutes fournies par l'utilisateur — obtenu sans toucher aux caps/index du mécanisme d'extras, seulement en changeant où vont les 2 premiers fichiers. Le prompt vidéo retombe sur le seul texte brut du brief (`brief.value.trim()`) quand le bypass est actif, faute de `charDesc`/`locDesc` disponibles. Validation : erreur explicite levée avant toute soumission si moins de 2 fichiers sont attachés au moment où le bypass est coché (`ref_image_0`/`ref_image_1` sont structurellement requis par le template, un job ne peut pas être soumis sans eux).

**Vérifié en rendu réel** : 3 fichiers image réels attachés, bypass coché (testé avec le mode Réalisateur également activé, pour confirmer qu'il court-circuite bien toute l'UI de revue et route directement vers la génération, zéro entrée en studio) — graphe en file confirmé avec `ref_image_0`/`ref_image_1`/`ref_image_2` exactement les 3 fichiers uploadés (le 3ᵉ via le chemin d'extras `addMinimaxRefs` inchangé, pas un cas spécial), sortie vidéo réelle confirmée par `ffprobe` + une frame décodée montrant un contenu cohérent. Les cas 0 fichier et 1 fichier confirmés lever l'erreur de validation avant toute soumission de job.

### Fichiers touchés
`index.html` (JS uniquement : `director.pipeline`, `STUDIO_SECTIONS.video`, `#studioVideoR2V`/`#directorR2VLaunchBtn`, `updateStudioNavForPipeline`, `updateGateState`, `directorStepR2V1`, `generateReference2VideoFromDirector`, `submitReference2VideoGraph`, `BUILDERS.reference2video`, `updateModelOptions`, `saveProject`, `#skipSheetsToggle`, `collectRefExtras`), `workflows/manifest.json` (`controls` de `reference2video` : `+mode`, `+skipSheets`).

## 2026-09-08 (suite) — v1.0.5 — Logo Dell réel, parité rail Canvas/Studio, LoRA en accès libre (découverte live + upload), sélecteur de style porté sur Studio, références r2v étendues

Six lots indépendants, tous vérifiés en conditions réelles (plusieurs avec un vrai rendu ComfyUI), livrés dans la même session.

### Logo Dell Technologies réel (`assets/dell-technologies-logo.png`)
L'utilisateur a fourni un vrai logo Dell Technologies (PNG 658×85, fond transparent, gris uni `rgb(169,169,169)`). Remplace deux approximations : côté Studio (`index.html`), le `.brand-mark` CSS-dessiné (bordures biseautées imitant un "D") + le texte littéral "Dell Technologies" cèdent la place à un `<img>` (`height:28px`, échelle du header) ; côté Canvas (`canvas.html`), l'ancien SVG deux tons (`#007db8`/`#808080`, illisible sur fond sombre sans un fond blanc forcé en CSS) est remplacé par le nouveau PNG neutre, ce qui permet de retirer le hack `.brand-logo { background:#fff; padding; border-radius }` — le nouvel asset se lit tel quel dans les deux thèmes. `assets/dell-technologies-logo.svg` supprimé après vérification qu'aucune autre référence ne subsistait.

### Séparateur de rail + parité du switcher Canvas/Studio
`index.html` : `.rail-top` (le duo de pilules Studio/Canvas en tête du rail d'icônes gauche) gagne `border-bottom`/`padding-bottom`/`margin-bottom` — un vrai séparateur visuel entre ce bloc d'identité et les boutons icône-seule en dessous (Node Monitor/Model Management/Local LLM/Advanced), qui n'avaient jusqu'ici aucune respiration. `canvas.html` : le lien de sortie vers `index.html` se limitait à un unique emoji `⌂` noyé dans la rangée d'icônes utilitaires (thème/fit/clear). Remplacé par une vraie paire de pilules `.rail-switch` sous le logo — "Canvas" (active, dégradé plein) + "Studio" (outline, lien vers `index.html`) — mêmes SVG que le rail de Studio, traduits dans les tokens déjà existants de `canvas.html` (`.rail-pill-active` reprend la recette dégradé de `.btn-primary`, `.rail-pill-outline` celle de `.btn-outline`) plutôt que copiés tels quels. L'ancien `⌂` et son entrée i18n ("App formulaire") retirés.

### Découverte live des LoRA (Canvas) — fin de la liste curée à la main
`js/engine.js` limitait `KREA2_LORAS` à 3 fichiers choisis à la main (en excluant volontairement des fichiers à contenu explicite présents dans le même dossier disque) et `H3_STYLE_LORAS` à un unique placeholder `["", "Aucun"]`. **Demande explicite de l'utilisateur : retirer cette curation** — tout `.safetensors` réellement présent sous `loras/Krea2/`/`loras/H3/` doit apparaître, contenu explicite inclus. Nouvelle fonction `fetchLoraOptions()` : scan de `GET /object_info/LoraLoaderModelOnly` (endpoint ComfyUI existant, déjà re-scanné en direct par ComfyUI à chaque appel — vérifié empiriquement qu'un fichier tout juste déposé apparaît sans redémarrage) — zéro nouveau backend pour cette partie. `KREA2_LORAS`/`H3_STYLE_LORAS` deviennent des tableaux mutables, peuplés en `push` (pas réassignés) par un fetch fire-and-forget au chargement du module, filtrés par préfixe de dossier (`Krea2/…`, `H3/…`) et par un nouvel ensemble `H3_TURBO_LORAS` (les 2 LoRA turbo déjà pilotées par le toggle turbo/steps dédié — seules exclusions, aucun autre filtre). Piège découvert au passage : `js/nodes-simple.js`/`js/nodes-advanced.js` passaient un tableau **déjà résolu** (`E.KREA2_LORAS.map(l => l[0])`) aux combos litegraph — comme le fetch réseau se termine après la construction du nœud, le combo restait figé sur la liste vide initiale. Corrigé en passant une **fonction** (`values: () => E.KREA2_LORAS.map(...)` / référence `loraIds`/`h3LoraIds`) — litegraph relit `options.values()` à chaque ouverture du menu (confirmé en lisant `litegraph.js`), donc le menu reflète toujours l'état courant du tableau.

### Téléversement de LoRA depuis le navigateur (Studio) — nouvelle capacité backend
Deux options envisagées (upload navigateur vs téléchargement serveur par URL) ; la seconde écartée après un passage sécurité qui a signalé le profil de risque type SSRF d'un serveur qui irait chercher une URL fournie par l'utilisateur — **seul l'upload a été construit**. `docker/updater/server.py` (le petit serveur HTTP stdlib qui exposait déjà `GET /status`/`POST /apply` pour la mise à jour git depuis l'UI, cf. suite 3 du 2026-09-07) étendu : `HTTPServer`→`ThreadingHTTPServer` (un gros upload ne doit pas bloquer le polling de `/status`), nouvel env `LORAS_DIR`, nouvelle route `POST /loras/upload?folder=<Krea2|H3>&filename=<nom>.safetensors` — corps de requête = octets bruts du fichier (pas de parseur multipart : `python:3-alpine` en 3.12 n'a plus le module `cgi`, et le frontend XHR le `File` brut en query string + body). `folder` validé contre une liste blanche stricte à 2 valeurs, `filename` assaini (nom nu, extension `.safetensors` uniquement, aucune traversée de chemin), écriture en streaming par blocs de 1 Mo dans un fichier `.part`, puis `os.rename()` atomique vers le nom final seulement après vérification du compte d'octets — nécessaire car `/object_info`/`/models/loras` re-scannent le dossier à chaque appel ComfyUI : un fichier partiellement écrit visible en cours d'upload pourrait être sélectionné et utilisé cassé. `docker-compose.yml` : service `updater` gagne `LORAS_DIR=/loras` + le volume `${COMFY_LORAS_DIR:-./comfyui/basedir/models/loras}:/loras:rw`. `install.sh` : après sa détection déjà existante du vrai chemin hôte d'un ComfyUI externe réutilisé (ce poste ne démarre pas son ComfyUI via ce `docker-compose.yml`, il réutilise un conteneur du projet voisin `comfyui-spark`), écrit désormais un `.env` (`COMFY_LORAS_DIR=$COMFY_MODELS_DIR/loras`) et force `docker compose up -d --build --force-recreate updater` pour que le nouveau mount prenne effet. `nginx.conf` : `location /update/` gagne `client_max_body_size 10g;` (des LoRA de plusieurs Go dépasseraient sans ça la limite par défaut de 1 Mo). `.gitignore` : ajout de `.env` (généré par `install.sh`, spécifique à la machine). `index.html` : nouvelle carte "LoRAs" dans le panneau Model Management — inventaire live (`GET /comfy/models/loras`, même schéma que `diffusion_models`/`checkpoints` déjà affichés là) + formulaire d'ajout (dossier Krea2/H3, fichier `.safetensors`, bouton Téléverser) câblé en `XMLHttpRequest` (nécessaire pour la progression réelle via `xhr.upload.onprogress`, pas disponible avec `fetch`). **Vérifié en conditions réelles** : un fichier de 5 Mo téléversé depuis l'UI live, confirmé identique octet pour octet sur disque, confirmé apparu immédiatement dans le listing live de ComfyUI, fichier de test supprimé après coup.

### Sélecteur de LoRA de style porté sur Studio (jusqu'ici Canvas seul l'avait)
Studio (`index.html`) n'avait aucune UI de LoRA de style, même après le lot #3 ci-dessus. Port : `index.html` étant un fichier autonome (n'importe pas `js/engine.js`, même convention "dupliquer, pas partager" déjà utilisée pour les mégapixels/steps turbo portés lors d'une session antérieure), duplication verbatim de `H3_TURBO_LORAS`/`KREA2_LORAS`/`H3_STYLE_LORAS`/`loraLabel()`/`fetchLoraOptions()`, plus une nouvelle `renderLoraSelect()` qui repeuple le `<select id="loraStyleSelect">` — contrairement aux combos litegraph de Canvas, un `<select>` DOM a besoin d'un rendu explicite (rappelé au changement de pipeline/modèle via `updateModelLabel()` et une fois le fetch résolu). Nouvelle fonction générique `applyStyleLora(graph, loraName, anchorClassType)` — greffe une `LoraLoaderModelOnly` en amont du nœud dont le `class_type` est `anchorClassType`, en reciblant tout ce qui pointait vers la même sortie `model`. Anchor généralisé car les templates diffèrent : `KSampler` pour `krea2_t2i`, `BasicScheduler` pour les 3 templates Minimax H3 (les deux confirmés en lisant les JSON réels, pas supposés). Câblé dans `CONTROL_WRAPS` (`lora`→`loraStyleWrap`) et les `controls` de `text2image`/`text2video`/`image2video`/`reference2video` (`PIPELINES_FALLBACK` + `workflows/manifest.json`) — pas sur `image2image` ni sur les fiches personnage/décor internes de `storyboard_v2`/`campaign_full` (Canvas a bien un style LoRA sur ses `CharsheetNode`/`LocsheetNode`, mais le câblage dans l'orchestration multi-jobs de Studio était hors périmètre de ce lot — écart réel, noté pour un futur lot). Appelée **après** `applyMinimaxTurbo` dans tous les sites d'appel — jamais avant, car `applyMinimaxTurbo` retrouve sa propre LoRA par `class_type` et une LoRA de style insérée en premier serait retrouvée à sa place. **Vérifié en rendu réel** : Krea 2 + une LoRA de style sélectionnée → graphe ComfyUI mis en file inspecté (nouveau nœud `LoraLoaderModelOnly` correctement greffé avec le bon `lora_name`, `KSampler.inputs.model` reciblé dessus) → image de sortie récupérée et confirmée visuellement conforme au style choisi (ni vide ni corrompue).

### Références supplémentaires pour `reference2video` (Studio) — Canvas les avait déjà
Canvas (`Ref2VideoNode`/`js/engine.js`) supportait déjà jusqu'à 7 images de référence en plus des 2 planches auto-générées (9 au total), 3 vidéos, 3 audios, via `addMinimaxRefs(graph, refs)` — un greffon générique qui retrouve le nœud `MiniMaxH3ReferenceToVideo` et câble des `LoadImage`/`LoadVideo`+`GetVideoComponents`/`LoadAudio` sur ses familles d'entrées `ref_images.ref_image_N`/`ref_videos.ref_video_N`/`ref_video_audios.ref_video_audio_N`/`ref_audios.ref_audio_N` (une vidéo de référence fournit son audio automatiquement via les 2 sorties de `GetVideoComponents`, aucune UI séparée nécessaire pour cet appariement). `generateReference2Video` côté Studio était figée à exactement `ref_image_0`/`ref_image_1` (charsheet/locsheet), sans moyen d'en ajouter. `addMinimaxRefs` porté verbatim dans `index.html`. Nouvelle UI : 3 champs `<input type=file multiple>` natifs (images/vidéos/audios), visibles uniquement pour `reference2video`, même idiome "multi-fichier natif, cap + avertissement à la soumission" que la séquence FLF2V déjà présente dans ce fichier (`seqFiles`) — en plus simple, sans UI de réordonnancement (ces références n'ont pas de contrainte d'ordre contrairement à une séquence FLF2V). Nouvelle `collectRefExtras()` : cap à 7/3/3, avertit et tronque au-delà, upload en parallèle via `/upload/image` (endpoint ComfyUI non restreint par content-type malgré son nom, déjà utilisé ainsi pour vidéo/audio ailleurs dans ce fichier). Câblé dans `CONTROL_WRAPS` (`refs`→`refExtrasWrap`) et les `controls` de `reference2video` seul. **Vérifié en rendu réel** : une vraie image attachée comme référence supplémentaire → graphe mis en file inspecté, `MiniMaxH3ReferenceToVideo.inputs["ref_images.ref_image_2"]` pointant vers un nouveau nœud `LoadImage` greffé avec le fichier uploadé → vidéo de sortie téléchargée et confirmée cohérente (non corrompue), durée/résolution/piste audio toutes correctes.

## 2026-09-08 — v1.0.4 — Studio : mégapixels + steps turbo H3, portés depuis Canvas

Canvas (`canvas.html`+`js/engine.js`) avait déjà, depuis une session de dev antérieure, un
sélecteur de mégapixels et un choix de steps pour la LoRA turbo Minimax H3 ; Studio
(`index.html`) était resté sur l'ancienne table `RATIOS` fixe et un turbo figé à 8 steps
implicites. Portage **verbatim** de la logique Canvas déjà validée côté rendu réel, plutôt
qu'une re-dérivation — mêmes formules, mêmes constantes.

### Mégapixels/résolution (`#mpSelect`, 14 valeurs de 0.2 à 2.0)
Nouvelle fonction `computeMPResolution(mp, ratioStr, unit)` (formule identique à
`js/engine.js` : `largeur = round(sqrt(1.045 · mp · 1e6 · ar) / unit) · unit`, `ar` inversé
pour la hauteur). Remplace la table `RATIOS` pour les 3 pipelines vidéo `text2video`,
`image2video` et `reference2video` uniquement (`text2image`/`image2image` gardent `RATIOS`
inchangée). Unité d'arrondi dépendante du moteur (`mpUnitForEngine`) : **64 pour LTX 2.5**
(architecture 2 passes base+upsample, corruption silencieuse de la résolution sans cet
arrondi), **32 pour Minimax H3** (inchangé). Moteur déduit du préfixe d'id du workflow
(`ltx25_*` vs `minimax_h3_*`), pas d'un champ UI séparé.

### Steps LoRA turbo H3 (`#turboSteps`, 4/6/8, défaut 8 — t2v/i2v seulement)
`applyMinimaxTurbo(graph, turboOn, steps)` passe à 3 arguments (`steps` optionnel,
rétrocompatible : omis, le comportement est strictement celui d'avant). Turbo ON + `steps`
fourni : 6 ou 8 conservent la LoRA turbo du template et fixent `BasicScheduler.steps` ; **4
bascule sur un LoRA différent**, `H3/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors`
(nouvelle constante `MINIMAX_FL2V_LORA_4STEP`), parce que la LoRA turbo d'origine casse la
colorimétrie à 4 steps (constat toujours valide, LESSONS piège n°12) alors que cette
nouvelle LoRA a été spécifiquement entraînée pour 4 steps et validée sans ce défaut (rendu
réel, session Canvas antérieure). **Contrainte préservée depuis Canvas** : cette LoRA
`fl2v` n'est compatible qu'avec le checkpoint `*_fl2va_*` de t2v/i2v — `reference2video`
utilise un checkpoint `*_ref2va_*` différent et non interchangeable, donc pas de sélecteur
de steps pour r2v : `applyMinimaxTurbo(graph, turboOn)` y reste appelée à 2 arguments,
comportement turbo-ON-8-steps/turbo-OFF-20-steps inchangé.

### Suivi UI (même session)
`#turboToggle` est désormais grisé/désactivé quand le workflow sélectionné est LTX 2.5 (la
LoRA n'existe pas dans ses templates, le contrôle était cliquable mais sans effet).
`#turboSteps` est grisé dès que LTX 2.5 est sélectionné, ou que `#turboToggle` est décoché.
Nouvelle fonction `updateTurboControls()`, appelée depuis `updateModelLabel()` et sur
l'événement `change` de `#turboToggle`. CSS : `textarea:disabled, input:disabled,
select:disabled { opacity: .45; cursor: not-allowed; }`.

`workflows/manifest.json` : `controls` de `text2video`/`image2video` gagnent `mp` et
`turboSteps` ; `reference2video` gagne `mp` seul.

**Vérifié en rendu réel** (mp=0.3, ratio 1:1, Minimax H3, steps=4) : graphe soumis avec
`w0=544 h0=544`, `.mp4` rendu confirmé par `ffprobe` à 544×544, 39 frames @ 24 fps ; graphe
ComfyUI mis en file confirmé avec `BasicScheduler.steps=4` **et** `lora_name` pointant vers
le nouveau LoRA `fl2v_turbo_4step`, pas l'ancien.

## 2026-09-07 (suite 5) — v1.0.3 — Correctif : install.sh ne démarrait jamais le service updater

Bug trouvé lors d'une relecture d'`install.sh` : sur une installation fraîche, le script
démarrait bien ComfyUI, Ollama et l'app web, mais oubliait le 4e service du
`docker-compose.yml`, `updater` (backend du module de mise à jour depuis l'UI, voir suite 3
ci-dessous). Résultat silencieux — aucune erreur à l'installation, le popup de mise à jour ne
fonctionnait simplement jamais côté Studio/Canvas.

Correctif : ajout d'un bloc `docker compose up -d updater` inconditionnel en section 2/7,
d'une ligne dédiée dans le récapitulatif final (section 7/7), et d'un health-check réel sur
`/update/status` (et non une simple vérification que le conteneur est "up"). Vérifié en
conditions réelles : HTTP 200 sur `/update/status`, comportement idempotent sur 2 exécutions
successives d'`install.sh`.

## 2026-09-07 (suite 4) — v1.0.2 — Galerie Canvas (onglets + glisser-déposer), logo Dell, renommage et reclassification des cartes

### Galerie Canvas (`js/canvas-gallery.js`, nouveau, chargé par `canvas.html`)
Tiroir fixé en bas de l'écran (poignée "Galerie"), qui s'ouvre à ~22 % de la hauteur d'écran
au clic. Reprend le principe de la galerie de `index.html` (vignettes cliquables sur
l'historique ComfyUI) mais en version simplifiée : deux onglets séparés Images/Vidéos (même
logique que `.gallery-tabs`/`switchGalleryTab` côté Studio), alimentés par `GET
/history?max_items=24` sur ComfyUI. Persistance via une clé `localStorage` dédiée, distincte
de celle du Studio — la galerie survit donc aux rechargements de la page Canvas. Chaque
vignette est `draggable` et peut être glissée-déposée sur une carte "Import média" posée sur
le canvas, qui reçoit alors directement la référence du fichier déjà présent côté serveur
ComfyUI (aucun ré-upload déclenché).

### Portage depuis un repo voisin (dev)
Les 4 éléments suivants ont été portés depuis un repo de développement voisin, jamais
mentionné publiquement dans le README :
- Logo Dell Technologies réel (`assets/dell-technologies-logo.svg`) affiché dans le panneau
  flottant gauche du Canvas, sur fond clair fixe (le SVG source utilise des couleurs fixes
  `#007db8`/`#808080`, illisibles telles quelles sur fond sombre).
- Renommage de cartes pour plus de clarté fonctionnelle : Krea 2 → "Création d'image",
  Qwen-Edit → "Édition d'image", Personnage → "Fiche de personnage", Décor → "Fiche de
  décor".
- Reclassification du mode avancé : Fiche de personnage, Fiche de décor et Storyboard sont
  désormais classées dans la catégorie "Image" (et non plus "Vidéo"), ces cartes produisant
  des images et non des vidéos.
- Boutons "+" ajoutés sur les entrées charsheet/locsheet de la carte Reference2Video.

Le repo voisin a sa propre galerie plein écran ; elle n'a **délibérément pas** été portée,
le tiroir déjà en place dans ce repo (voir ci-dessus) la remplace fonctionnellement.

## 2026-09-07 (suite 3) — v1.0.1 — Mise à jour depuis l'UI (popup Studio/Canvas)

Cadré via `/architect` (deux points tranchés avec l'utilisateur : check au chargement de page
uniquement, pas de poll en tâche de fond ; aucune authentification sur les nouveaux
endpoints, cohérent avec `/comfy/`/`/ollama/`) puis exécuté par tour-de-controle en 2 lots
parallèles (backend/frontend, fichiers disjoints, contrat JSON figé au plan) + vérification
d'intégration par l'orchestrateur.

### Nouveau service `updater` (`docker/updater/Dockerfile`, `docker/updater/server.py`)
Serveur HTTP Python stdlib (zéro dépendance), `network_mode: host`, écoute
`127.0.0.1:8093` — le port 8091 initialement prévu au plan était déjà occupé par un
conteneur de prod sans rapport (`ai-content-studio-cockpit-web`), vérifié avant bascule.
Monte le repo en lecture-écriture (`./:/repo:rw`, contrairement au mount `:ro` de nginx) via
`REPO_DIR` (défaut `/repo`). Deux routes : `GET /status` (compare `git rev-parse HEAD` local
à `git ls-remote origin main` distant) et `POST /apply` (`git fetch` + `git pull --ff-only`,
refuse proprement si le working tree n'est pas clean — jamais de force/stash). Ajouté à
`docker-compose.yml`, reverse-proxifié par `nginx.conf` sous `location /update/` (même
modèle que le bloc `/ollama/` existant).

### `js/update-check.js` (nouveau, partagé Studio + Canvas)
Au chargement de `index.html` et `canvas.html` : `fetch("update/status")` (silencieux si le
service est down) → si mise à jour dispo, `confirm()` natif ("l'installer ?") → sur oui,
`POST update/apply` → sur succès, `confirm()` natif ("rafraîchir maintenant ?") →
`location.reload()`. Décision prise après lecture du code réel : aucun système de modale
custom n'existait dans ces deux pages (juste une lightbox média inadaptée dans `index.html`
et un `confirm()` déjà utilisé une fois pour la suppression) — `confirm()`/`alert()` natifs
retenus plutôt que d'en inventer un.

### Vérification (orchestrateur, pas seulement les rapports de lots)
Re-lu chaque diff (`docker-compose.yml`, `nginx.conf`, `index.html`/`canvas.html` : +1 ligne
chacun, 0 suppression). Cycle complet `/status`→`/apply`→`/status` rejoué sur un **clone
jetable** du repo (jamais sur la prod réelle) désynchronisé d'un commit : `updateAvailable`
passe bien de `true` à `false` après un apply réussi, avec les bons SHA à chaque étape.
Sur le vrai repo de prod (dirty pendant ce chantier) : `/apply` refuse bien
(`{"success": false, "error": "working tree not clean"}`) sans toucher à git. Processus de
test et clone jetable nettoyés après coup.

### Réserve assumée (signalée, pas corrigée dans ce lot)
Les deux endpoints sont exposés sans authentification sur le port 8090 déjà public — décision
explicitement validée par l'utilisateur au cadrage (cohérence avec `/comfy/`/`/ollama/`,
usage perso/LAN), pas un oubli. Limite du MVP également assumée : un futur commit qui
toucherait `nginx.conf`/`docker-compose.yml` ne serait pas pleinement appliqué par un simple
`git pull` (pas de restart de conteneur automatique).

## 2026-09-07 (suite 2) — Installation automatique (`install.sh`), URLs de modèles vérifiées, comfy_kitchen embarqué

Chantier de fiabilisation du déploiement : jusqu'ici la procédure était manuelle (`docker
compose up -d` + téléchargement des modèles un par un, avec plusieurs URLs jamais vérifiées)
et `comfy_kitchen` (accélération d'attention ARM64/DGX Spark) devait être installé et câblé
à la main.

### `install.sh` (nouveau, racine)
Script bash unique, idempotent (testé sur deux exécutions consécutives : réutilisation
confirmée, aucun retéléchargement). Détecte les 3 services (app web `:8090`, ComfyUI
`:8188`, Ollama `:11434`) **par rôle réel** (santé HTTP), pas par nom de conteneur —
réutilise tout ce qui tourne déjà et ne recrée/ne détruit jamais un conteneur qu'il ne
possède pas (vérification par les labels docker-compose). Met à jour ComfyUI par
`pull`+`recreate` uniquement s'il est géré par CE `docker-compose.yml`. Copie
`docker/userscripts/*.sh` vers le dossier `userscripts_dir` réel du conteneur ComfyUI
utilisé. Télécharge les modèles manquants depuis `scripts/models.txt` (skip si déjà présent
avec la bonne taille). Gère un `HF_TOKEN` optionnel en variable d'environnement pour les
dépôts Hugging Face gated (`HF_TOKEN=xxx ./install.sh`). Tire `gemma4:e4b` sur Ollama si
absent.

### `scripts/models.txt` (nouveau) — 19 fichiers, URLs vérifiées par requête HTTP réelle
Deux réserves honnêtes, documentées dans le README, pas escamotées :
- Les 4 fichiers LTX 2.5 viennent d'un dépôt Hugging Face **gated** — téléchargement anonyme
  en 401 tant que les conditions n'ont pas été acceptées sur `huggingface.co/Lightricks/LTX-2.5`
  avec un compte, et qu'un jeton d'accès n'a pas été fourni (`HF_TOKEN`).
- Les 3 fichiers Minimax H3 (2 checkpoints quantifiés `w4a8_mixed` + LoRA turbo) viennent de
  **reuploads communautaires** (`AX1Y2JP/MiniMax-H3-W4A8-ConvRot`,
  `koongrizzly/MiniMax_H3_int4_W4A8_ConvRot_Pruned`), pas d'un dépôt officiel Comfy-Org/Minimax
  — nom de fichier et taille conformes et vérifiés, mais l'intégrité du contenu ne repose que
  sur la réputation/traction du dépôt, pas sur un éditeur officiel.

### `docker/userscripts/` (nouveau) — `comfy_kitchen` embarqué et câblé
2 scripts (copies strictes de scripts déjà validés ailleurs) installent `comfy_kitchen`
(accélération d'attention ARM64/DGX Spark) au démarrage du conteneur ComfyUI, de façon
idempotente. `install.sh` les déploie automatiquement, rien à faire manuellement. Le nœud
`ModelAttentionBackend` (`comfy kitchen attention`) a été câblé juste après le chargeur de
modèle dans les 9 templates `workflows/api/*.json` — **vérifié par rendu réel** (frames +
audio inspectés) sur au moins un représentant de chaque famille (Krea 2, LTX 2.5, Minimax
H3, Qwen-Edit) sans dégradation constatée ; les autres templates de la même famille ont été
câblés **par analogie de topologie** (même schéma de nœuds), pas individuellement testés par
rendu.

### Documentation
`README.md` : section Déploiement réécrite (installation automatique en une commande en
premier, procédure manuelle/dépannage conservée en repli explicite), `HF_TOKEN` documenté,
tableau des 19 modèles aligné sur `scripts/models.txt` (URLs directes `resolve/main`, 3
tailles jusqu'ici `<à compléter>` renseignées), les deux réserves ci-dessus rendues visibles,
mention de `canvas.html` (mode additionnel) et de `comfy_kitchen` (automatique, ARM64
uniquement).

### Reste ouvert
Rien n'est encore poussé vers GitHub à ce stade — le push est géré séparément par
l'orchestrateur après validation finale.

## 2026-09-07 (suite) — Point d'entrée visible vers le canvas dans le rail

Suite immédiate de la promotion ci-dessous : l'utilisateur a fourni une capture d'écran du
header et demandé un bouton "Canvas" à côté de "Studio", avec le logo Dell décalé pour
éviter le chevauchement qu'un second bouton créerait.

- Nouveau lien `.rail-canvas` → `canvas.html`, dans un conteneur `.rail-top` (flex row) qui
  place Studio+Canvas côte à côte en tête du rail vertical — le reste du rail (Monitor/
  Models/LLM/Advanced) reste empilé verticalement, inchangé. Style volontairement distinct
  du panneau actif (contour au lieu de rempli) : Canvas est une sortie vers une autre page,
  pas un panneau du studio.
- `.brand` (logo Dell) gagne un `margin-left: 150px` : le rail est en `overflow:visible` et
  déborde par-dessus le header plutôt que de le repousser (ce sont deux frères flex
  indépendants, pas liés par une grille commune) — élargir `grid-template-columns` du
  header n'aurait rien changé, d'où ce choix après mesure réelle du rendu.

Vérifié en direct sur le port 8090 : positionnement sans chevauchement (clair/sombre),
navigation Canvas fonctionnelle, non-régression du système de panneaux existant.

## 2026-09-07 — Promotion du canvas créatif (Piste 3) comme mode additionnel, sans toucher à index.html

Développé et qualifié dans le projet sœur `../ai-content-studio-canvas` (voir son propre
`TOUR-DE-CONTROLE-CHANGELOG.md` pour tout l'historique des lots : import média local,
cartes use-case câblées, LoRA/résolution vidéo, enrichissement de prompt LLM, filtre
Image/Vidéo, barre de progression). Décision explicite de l'utilisateur : le canvas
devient un **mode additionnel** accessible en plus du formulaire existant — pas un
remplacement. `index.html` et l'expérience formulaire ne sont **pas touchés**.

### Fichiers ajoutés (copie strictement identique à `ai-content-studio-canvas`, diff vide)
- `canvas.html` (nouveau, racine).
- `js/engine.js`, `js/nodes-simple.js`, `js/nodes-advanced.js` (nouveau dossier `js/`).

### Pourquoi aucun changement de nginx/docker-compose n'était nécessaire
`nginx.conf` de ce repo a déjà un `location / { try_files $uri $uri/ =404; }` qui sert
n'importe quel fichier statique du dossier monté — `canvas.html` et `js/*.js` sont donc
immédiatement accessibles sur `http://<host>:8090/canvas.html` sans redémarrage ni
modification de configuration (bind-mount `./:/usr/share/nginx/html:ro`, déjà en place).
Les 9 templates `workflows/api/*.json` déjà présents ici sont byte-identiques à ceux du
canvas (vérifié) — aucun template à copier.

### Lien retour
`canvas.html` a déjà un lien "⌂ App formulaire" vers `index.html` (construit dès l'origine
pour coexister à la même origine) — fonctionne immédiatement une fois les fichiers en
place, sans modification. Aucun lien ajouté dans l'autre sens (`index.html` → canvas) :
non demandé, `index.html` reste intact à l'octet près.

### Vérification
Testé en direct sur le port 8090 (pas seulement 8092) : chargement de `canvas.html` sans
erreur console, un vrai job Krea 2 soumis et abouti (fichier généré, `outFile` posé), et
`index.html` rechargé après coup pour confirmer l'absence de régression sur l'app
formulaire existante. `git status` du dépôt canvas vérifié propre avant la copie ; diff
byte-à-byte des 4 fichiers copiés confirmé vide.

### Reste ouvert
Aucun lien visible depuis l'interface `index.html` vers le canvas — accès uniquement par
URL directe (`/canvas.html`) pour l'instant, décision explicite de ne pas toucher au
formulaire existant. À reconsidérer si l'utilisateur souhaite un jour un point d'entrée
visible.

## 2026-09-02 — Promotion du rapprochement visuel avec la maquette (suite du Cockpit affiné)

Développé et qualifié dans le projet cockpit (`../ai-content-studio-cockpit`, voir son propre
changelog pour le détail lot par lot), promu ici après validation utilisateur sur plusieurs
itérations successives.

### Fichiers touchés
- `index.html` seul.

### Changements
- Police DM Sans (Google Fonts) + palette bleue + cartes "glass" (fond translucide, flou,
  ombre douce) alignées sur la maquette de refonte, en clair et en sombre.
- Rail de navigation vertical à gauche : icônes SVG sobres monochromes (Studio, Node Monitor,
  Model Management, Local LLM, Advanced), agrandissement au survol révélant le nom complet
  (réutilise le mécanisme déjà existant sur les profils métiers). Un panneau ouvert reste
  affiché tant que son icône (ou son nom) n'est pas re-cliquée — cliquer ailleurs dans
  l'interface ne le referme plus.
- Contenu associé à chaque icône (gauges GPU/RAM/queue, gestion des modèles, LLM local,
  console ComfyUI + plateformes cloud) affiché **dans la colonne de gauche elle-même**, qui
  s'élargit sous l'icône sélectionnée — le studio principal (formulaire Generate, galerie)
  ne bouge pas.
- Onglets de scénario (Campaign Generator / Storyboard + Animatic / Localized Assets) en
  pilules horizontales compactes, au lieu de 3 grandes cartes descriptives.
- Header restauré avec titre/sous-titre/"Powered by Dell Pro Max GB10" + sélecteurs de
  langue et de thème directement visibles (plus besoin d'un panneau "Réglages" séparé,
  supprimé du rail).
- Badge d'identité "Ancrage actif" repositionné en haut à droite.
- Galerie à cartes agrandies.

### Vérification
Chaque étape vérifiée par rendu réel headless (clair/sombre, plusieurs largeurs), tests
d'interaction DOM réels (clics, survols, mesures de position/taille), et re-test systématique
de la sélection `storyboard_v2` + bascule Auto/Réalisateur à chaque itération — voir le
changelog du projet cockpit pour le détail complet, lot par lot.

### Retour arrière
`git revert` du commit de promotion restaure l'état précédent (rail moins abouti, header
réduit).

## 2026-09-02 — Promotion "Cockpit affiné" (Piste 1 de la refonte visuelle)

Refonte ergonomique développée et qualifiée dans un projet distinct
(`../ai-content-studio-cockpit`, cf. son propre `TOUR-DE-CONTROLE-CHANGELOG.md` pour le détail
des lots et de la vérification par rendu réel), promue ici après validation utilisateur pour
remplacer la version courante. `index.html` de ce projet était resté strictement identique au
commit de départ du cockpit (`2b1243f`) entre-temps — promotion par simple copie de fichier,
aucun conflit à résoudre.

### Fichiers touchés
- `index.html` — rail de profils métiers en icônes (au lieu de pleine largeur), formulaire
  Generate condensé en barre horizontale, cartes de galerie agrandies, pastille d'identité
  "Soul ID" persistante (charsheet/locsheet ancrée visible sans rouvrir l'étape 0 du mode
  Réalisateur de `storyboard_v2`). Aucune logique de génération/graphe ComfyUI modifiée.
- `docs/REFONTE-COCKPIT.md` — NOUVEAU, brief de la refonte (copié depuis le projet cockpit).

### Vérification (déjà faite dans le projet cockpit avant promotion, non refaite ici)
Cycle réel du mode Réalisateur avec ComfyUI/Ollama (charsheet+locsheet générées, pastille
vérifiée par hash SHA-256 contre les fichiers PNG réels), i18n EN/DE vérifié sur DOM rendu,
`git diff` limité à `index.html` — voir le changelog du projet cockpit pour le détail complet.

### Suite prévue
Un rapprochement visuel avec la maquette de refonte (typographie, palette, effet "glass", style
des pastilles de nav — actuellement l'identité visuelle Dell d'origine a été conservée, la
maquette n'a pas été suivie sur ce plan) est en cours dans le projet cockpit, à promouvoir ici
de la même façon une fois qualifié.

### Retour arrière
`git diff HEAD~1 -- index.html docs/REFONTE-COCKPIT.md | git apply -R` restaure l'état
précédent (ou `git revert` du commit).

## 2026-09-01 — Lot 5+6 : correctif de la dérive de noms de modèles (piège n°14)

Découvert par la vérification du Lot 3 : 3 pipelines historiques + le nouveau
`reference2video` étaient cassés par des noms de fichiers modèles obsolètes sur disque,
indépendamment de tout travail de ce chantier. Correction en 2 temps (Lot 5 délégué sonnet
pour 3 des 4 références, Lot 6 fait directement par l'orchestrateur pour la 4ᵉ une fois le
remplacement non-ambigu) — les 4 corrigées et validées par rendu réel + inspection :

| Référence cassée | Fichier(s) | Remplacement | Preuve |
|---|---|---|---|
| LoRA Qwen-Edit déplacée | `workflows/api/qwen_edit_i2i.json`, `qwen_edit_dual.json` | `"Qwen/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors"` | `output/studio/edit_00006_.png` |
| `flux-2-klein-9b-fp8` absent | `index.html` (`addFluxShot`) | `flux-2-klein-9b-kv-fp8.safetensors` (1er candidat `base-9b-fp8` rejeté après inspection — image cassée malgré `success`) | job `campaign_full` réel, `output/studio/campaign/{poster,thumbnail,social,teaser}_0000{6,7}_*` |
| `gemma_3_12B_it_fp4_mixed` absent | `index.html` (`addLtxShared`), `ltx_t2v.json`, `ltx_i2v.json` | `gemma_3_12B_it_fp8_scaled.safetensors` | rendu réduit + teaser `campaign_full` réel |
| `ernie-image.safetensors` absent | `index.html` (`addErnieShared`/`addErnieShot`) | `ernie-image-turbo.safetensors` + steps 20→8, cfg 4→1 (alignement sur `ernie_turbo_t2i.json` déjà validé) | `output/studio/lot6_erniefix_test_00001_.png` |

**Conséquence** : le pipeline `reference2video` (livrable clé du Lot 2, cohérence personnage+décor)
est maintenant fonctionnel de bout en bout, charsheet → locsheet → `minimax_h3_r2v` inclus.
Détail complet dans `docs/LESSONS.md` (piège n°14 + sous-entrées de correctif).

## 2026-09-01 — Lot 3 : navigation par profils métiers Media & Entertainment

Couche de présentation par profil ajoutée AU-DESSUS des 3 onglets scénario existants
(`const PROFILES`, `index.html:2047`), sans toucher au routing sous-jacent
(`activeScenario`/`SCENARIOS`/`refreshPipelineOptions`). 4 profils : Réalisateur/Storyboard
artist (storyboard_v2 + reference2video), DA/Motion designer (text2image Krea 2), Social
media/Marketing (campaign_full), Monteur/Post-production (galerie + localization).

### Fichiers touchés
- `index.html` seul (+ `docs/LESSONS.md`, entrées ajoutées, aucune modifiée/supprimée)

### Vérification (Phase 3, rejouée indépendamment du rapport d'agent)
- Captures headless clair/sombre × 390/768/1250/1440px inspectées visuellement — nav propre,
  4 colonnes ≥1181px repliant à 1/2 colonnes en dessous, aucune rupture.
- `node --check` sur le JS extrait : OK.
- `git diff --stat docs/LESSONS.md` : 38 insertions, 0 suppression.

### Découverte majeure (hors périmètre de ce lot, documentée piège n°14 dans LESSONS.md)
La qualification en conditions réelles a révélé que **3 pipelines étaient déjà cassés avant
ce chantier**, par dérive de noms de fichiers modèles sur disque (indépendant de la nav —
reproduit à l'identique via le chemin de navigation historique) : `campaign_full`
(`flux-2-klein-9b-fp8.safetensors` absent), Localized Assets / image2image (LoRA Qwen
déplacée dans `loras/Qwen/` sans préfixe dans le template), et `addErnieShot`
(`ernie-image.safetensors` absent) — ce dernier casse aussi **`reference2video`**, livrable
clé du Lot 2, dès l'étape charsheet. Correctif ciblé lancé en Lot 5 (voir plus bas).

## 2026-09-01 — Lot 1 : validation des 3 nouveaux modèles (Krea 2, LTX 2.5, Minimax H3)

Orchestration tour-de-controle (plan cadré via /architect). Objectif : remplacer Flux2/Ernie/
Z-Image (Krea 2), LTX 2.3 (LTX 2.5) et ajouter Minimax H3 (t2v/i2v/r2v + toggle LoRA turbo),
avec exigence critique client sur r2v : cohérence de scène (personnage + décor) garantie par
génération de reference sheets (charsheet + locsheet) injectées nativement dans
`MiniMaxH3ReferenceToVideo` (jusqu'à 9 `ref_images`, tags `<Picture i>`).

### Fichiers touchés (nouveaux, aucun fichier existant modifié)
- `workflows/api/krea2_t2i.json`, `ltx25_t2v.json`, `ltx25_i2v.json`, `ltx25_flf2v.json`,
  `minimax_h3_t2v.json`, `minimax_h3_i2v.json`, `minimax_h3_r2v.json` — 7 templates API validés
  par rendu réel réduit + inspection (frames + audio).
- `docs/NOUVEAUX-MODELES-LOT1.md` — NOUVEAU, synthèse des fichiers modèles/LoRA exacts utilisés
  par pipeline, écarts vs templates officiels ComfyUI, décisions steps/turbo, verdict cohérence r2v.
- `docs/LESSONS.md` — 4 entrées ajoutées (aucune modifiée/supprimée) : grille de longueur H3
  en 17n+5, LoRA turbo H3 instable sous 6 steps, coupe franche FLF2V en rendu réduit 25 frames,
  ref2va/fl2va — bien distinguer les deux rôles de checkpoint Minimax H3.

### Décisions clés (vérifiées par inspection réelle, pas seulement rapport d'agent)
- **Krea 2** : `krea2_turbo_fp8_scaled.safetensors` + `qwen3vl_4b_fp8_scaled.safetensors` +
  `qwen_image_vae.safetensors` — correspond exactement au template officiel ComfyUI, aucune
  substitution nécessaire.
- **LTX 2.5** : `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` (variante
  choisie par l'utilisateur) + VAE/text-encoders/upscaler dédiés — correspond exactement au
  template officiel.
- **Minimax H3** : checkpoints réels (`*_pruned_w4a8_mixed.safetensors`) divergent des noms du
  template officiel (`*_pruned_int8_convrot.safetensors`) — substitution documentée et validée.
  LoRA turbo (`minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors`) validée **ON à 8
  steps** (qualité ≈ identique à OFF/20 steps, 2,5× plus rapide) ; 4 steps rejeté (colorimétrie
  effondrée, artefacts de bande sur r2v) ; 6 steps = plancher acceptable.
- **Cohérence r2v (exigence client)** : CONFIRMÉE par comparaison visuelle directe — personnage
  (cheveux blanc-argenté pixie, ciré jaune à boucles, écharpe rouge, traits du visage) ET décor
  (pierre blanche, fenêtres cintrées, escalier en colimaçon) de `charsheet_00001_.png`/
  `locsheet_00001_.png` retrouvés à l'identique dans les frames de `h3_r2v_face8` et
  `h3_r2v_turbo6/8`. Preuves : `/home/sparks/comfyui-spark/basedir/output/validate/lot1/`
  (64 fichiers : 36 frames PNG, 12 planches comparatives, 12 pistes audio extraites).

### Incident de session (résolu sans perte)
Le premier agent du lot a vu sa session interrompue (process Claude Code arrêté) après avoir
terminé tous les rendus GPU mais avant d'écrire la synthèse — transcript perdu (non résumable).
Tout le travail était néanmoins intact sur disque (templates + rendus + reference sheets) ;
un second agent (frais, sans contexte de session) a inventorié l'existant, inspecté réellement
chaque preuve (extraction de frames, lecture visuelle, ffprobe audio) sans aucun re-rendu GPU,
et écrit la synthèse manquante. Confirme la leçon déjà connue de ce projet : écrire les
livrables durables sur disque au fil de l'eau permet une reprise à coût quasi nul même après
perte totale du transcript.

### Retour arrière
Tout en fichiers nouveaux, non commités. Aucun fichier existant du projet modifié par ce lot.

## 2026-07-17/18 — Ancrage double : character sheet enrichie + location sheet

Orchestration en 4 lots séquentiels (plan Fable 5). Motif : visage ré-inventé en gros plan
(planche 3 vues sans portrait), décor porté par le seul texte → variations entre cases.

### Fichiers touchés
- `workflows/api/qwen_edit_dual.json` — NOUVEAU template Qwen-Edit à 2 images de référence
  (image1 = planche personnage → conditioning + latent ; image2 = planche décor → conditioning
  SEUL via LoadImage `79` + FluxKontextImageScale `433:118` sur les deux TextEncodeQwenImageEditPlus).
  L'ancien `qwen_edit_i2i.json` reste intact : bascule arrière = 1 ligne `anchor` du manifest.
- `index.html` — fiches gemma structurées (`characterSheetFromBrief` {face,hair,outfit,accessories,
  palette}, NOUVELLE `locationSheetFromBrief` {place,architecture,materials,lighting,palette}) ;
  planches Ernie 1920×1088 sans texte (`buildCharsheetGraph` turnaround+portrait+expressions+palette,
  NOUVELLE `buildLocsheetGraph` décor multi-angles) ; `{{IMAGE2}}` dans `buildGraph` ; `keyframePrompt`
  gabarit dual ; `submitKeyframeJob` +locName (3 call sites), `submitCutJob` +locDesc (2 call sites
  + tenue) ; ÉTAPE 0 du mode Réalisateur (cartes des 2 planches, `regenerateAnchor` seed+1,
  bouton "Valider les planches" + gating avec ré-invalidation).
- `workflows/manifest.json` — `anchor: "api/qwen_edit_dual.json"`.
- `docs/ARCHITECTURE.md`, `docs/LESSONS.md` (leçons dual + verdict qualification), `CLAUDE.md`,
  `workflows/README.md` (timings) — documentation alignée.

### Qualification (run dual N=4 + tenue, 2026-07-17 22:47→23:03, ~17 min bout-en-bout)
- Visage : portrait de la charsheet retrouvé à l'identique sur les 4 cases dont le plan rapproché — avant, casque/combinaison variaient entre cases.
- Décor : les 4 keyframes montrent LE site de la locsheet — avant, 4 lieux sans rapport.
- Cuts : 0/5 dérives (frames médianes contrôlées) contre 4/9 au run N=8 initial.
- Animatic : 245 frames exactes (5×49), audio continu.
- Timings : planche ~2 min chacune, keyframe ~27-32 s, cut 2 s ~2 min, gemma ~50 s.

### Retour arrière
Tout en non-commité. Bascule keyframes mono-ancre : `anchor` → `api/qwen_edit_i2i.json`.

## 2026-07-17 — Refonte du scénario Storyboard + Animatic (`storyboard_v2`)

Orchestration en 4 lots (plan Fable 5, exécution déléguée, vérification adversariale).
Motif : perte de cohérence des sujets entre cases, animatic FLF2V décevant, UI sans point de contrôle.

### Fichiers touchés
- `index.html` — cœur de la refonte (JS + formulaire + CSS, ~640 lignes nettes ajoutées)
- `workflows/manifest.json` — pipeline `storyboard_v2` (champ `anchor`, contrôle `mode`), suppression `storyboard_full`/`storyboard_full_ernie`
- `docs/ARCHITECTURE.md`, `docs/LESSONS.md` (pièges n°8/n°9), `docs/TESTING.md`, `CLAUDE.md`, `workflows/README.md` — documentation alignée sur le code

### Changements
1. **Mécanique** (Lot 1, opus) : chaîne multi-jobs character sheet Ernie → N keyframes ancrées Qwen-Image-Edit 2509 (1 job/case, template désigné par le champ manifest `anchor` — bascule de modèle = 1 ligne) → grille contact-sheet adaptative (`cols=ceil(sqrt(n))`, N∈[4,16]) → 1 cut i2v LTX 2.3 deux-passes par keyframe → assemblage cuts francs + audio (`studio/story/animatic`). Anciennes fonctions `buildStoryboardFullGraph`/`generateStoryboardFull`/`shotPromptsFromBrief` supprimées ; `sequence2video` (FLF2V manuel) et `campaign_full` conservés intacts. Reprise 1 : `keyframePrompt` durci (photoréalisme, plein cadre, instance unique, remise en scène — tout en positif, cfg 1 = negative ignoré).
2. **UI double mode** (Lot 2, sonnet) : sélecteur Auto/Réalisateur (contrôle manifest `mode`) ; mode Réalisateur en 3 étapes (plans éditables scene/angle/motion → cartes keyframes régénérables seed+1 / verrouillables → animatic lancé après validation) ; i18n FR/EN/ES/DE, thème via variables CSS. Refactor en sous-fonctions partagées `submitCharsheetJob`/`submitKeyframeJob`/`submitGridJob`/`submitCutJob`/`submitAnimaticJob` sans changement des graphes.
3. **Qualification** (Lot 3, sonnet) : run Auto N=8 réel chronométré (~19 min ; keyframe ~17 s, cut 2 s ~88 s en régime), projection 16 cases ≈ 34 min ; verdict ancrage GO (identité 8/8, adhérence aux angles extrêmes partielle — piège n°8) ; découverte du piège n°9 (dérive des cuts).
4. **Correctif piège n°9** (lot ciblé, opus) : `submitCutJob` ancre désormais l'enhancer LTX sur le contenu réel de la keyframe (prompt `scene + charDesc + camera motion` au lieu du mouvement seul) — validé par re-rendu des 3 cuts qui déviaient (fontaine/costume/blé → personnage et décor conservés en frame médiane).

### Incidents notables
- Le lot baseline a exécuté un `git checkout workflows/manifest.json` interdit (~10:15), écrasant des éditions en cours du Lot 1 — détecté, le Lot 1 a ré-appliqué et re-vérifié l'intégralité du manifest.
- Le run animatic N=8 archivé (`animatic_00014_.mp4` et antérieurs) est ANTÉRIEUR au correctif des cuts : un nouveau run reflétera la qualité corrigée.

### Retour arrière
Tout est en non-commité par-dessus le refactor layout préexistant (lui aussi non commité). `git diff` pour l'ensemble ; pas de commit effectué par les agents.
