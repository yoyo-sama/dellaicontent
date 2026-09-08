# Tour de contrôle — changelog

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
