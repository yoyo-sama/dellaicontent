# Revue de code — correction, performance, simplification (2026-09-23)

Revue complète de l'état `main` à `af14df8` (v1.2.0). Périmètre : `index.html` (script
L2186–8103), `canvas.html` + `js/engine.js` + `js/nodes-simple.js` + `js/nodes-advanced.js`
(+ `js/canvas-gallery.js`, `js/update-check.js` au passage), `workflows/manifest.json` et
`workflows/api/*.json`, `docker/updater/`, `docker-compose.yml`, `nginx.conf`, `install.sh`,
`docker/stacks/*.yml`, `scripts/models.txt` et les outils Python.

**Hors périmètre, volontairement** : ergonomie UI (revue séparée). **Aucune modification de
code** n'a été faite : ce document est le seul fichier écrit.

## Méthode et niveau de preuve

- Lecture intégrale du code, fichier par fichier, après lecture de `AGENTS.md`,
  `docs/ARCHITECTURE.md` et `docs/LESSONS.md`. Tout comportement qui y est qualifié comme
  choix délibéré (négatif ignoré à cfg 1, arrondis 32/8n+1/17n+5, LoRA turbo câblée en dur puis
  retirée en JS, bannissement positif, plafond 2 sujets, asymétrie Canvas 10 / storyboard 9,
  `negText` sans effet sur les planches, ré-upload des références à chaque keyframe noté
  `ponytail:`…) a été **écarté**. Quand le code a dérivé d'une règle documentée, c'est dit
  explicitement (« **Régression / dérive** »).
- Chaque trouvaille porte sa preuve : **vérifié** (exécuté : `node`, `curl`, `ss`, lecture du
  source ComfyUI dans le conteneur `comfyui-nvidia`) ou **lecture de code** (chemin d'exécution
  tracé, non exécuté). Aucun job GPU n'a été soumis pour cette revue.
- Les outils Python cités dans le cadrage comme `scripts/*.py` vivent en réalité dans
  `tools/` (`tools/convert.py`, `tools/onboard.py`, `tools/validate.py`) ; `scripts/` ne
  contient que `models.txt`. C'est `tools/` qui a été revu (et c'est bien ce que citent
  `AGENTS.md` et `ARCHITECTURE.md`).

---

## CRITIQUE

### C1 — `index.html` : décocher « Turbo Minimax H3 » retire la LoRA Lightning de Qwen-Edit (Localized Assets) — **régression / dérive**

`index.html` L3574-3576 (handler Generate, chemin générique) :

```js
applyMinimaxTurbo(graph, $("turboToggle").checked,
  (wf.pipeline === "text2video" || wf.pipeline === "image2video") ? Number($("turboSteps").value) : undefined);
```

`applyMinimaxTurbo` (L4326-4345) prend **le premier `LoraLoaderModelOnly` du graphe**, quel qu'il
soit. Or `workflows/api/qwen_edit_i2i.json` (pipeline `image2image`) en contient un : le nœud
`433:89`, LoRA `Qwen/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors`.

Scénario : l'utilisateur décoche « Turbo » sur un workflow Minimax H3, puis passe sur Localized
Assets. La case est masquée (`turbo` absent des `controls` d'`image2image`) mais garde son état.
Generate → la LoRA Lightning est retirée, Qwen-Edit tourne en 4 steps / cfg 1 **sans** la LoRA
distillée qui rend ces réglages valides → rendu dégradé avec un statut `success` (exactement le
cas d'aveuglement du piège n°14). `BasicScheduler` n'existant pas dans ce gabarit, rien d'autre ne
signale le problème.

**Vérifié** : fonction extraite d'`index.html` et exécutée sous `node` sur le gabarit réel —
`LoraLoaderModelOnly` avant/après turbo OFF : `1 → 0`.

Dérive documentaire : `docs/LESSONS.md` L94 affirme « no-op silencieux sur tout graphe sans cette
LoRA (Krea 2, LTX 2.5, **Qwen-Edit**), donc appelable sans condition » — faux pour Qwen-Edit, qui a
toujours porté un `LoraLoaderModelOnly`.

**Correction** (à la racine, une garde dans la fonction partagée plutôt qu'à chaque appelant) :

```js
const loraEntry = Object.entries(graph).find(([, n]) =>
  n.class_type === "LoraLoaderModelOnly" && String(n.inputs.lora_name).startsWith("H3/"));
```

À appliquer aux deux copies (`index.html` L4327 et `js/engine.js` L80), puis corriger la phrase de
LESSONS L94.

**État (2026-09-24)** : corrigé — commit `91bbd90`

### C2 — Canvas : les cartes « Vidéo » et « Génération vidéo » en moteur Minimax H3 soumettent un graphe invalide depuis le 2026-09-22 — **régression**

Depuis `0241cbb` (2026-09-22), `workflows/api/minimax_h3_i2v.json` câble `last_frame` sur un
`LoadImage` dont l'image est `"{{IMAGE2}}"` (nœud `lastimg`). Le Studio le retire via
`applyMinimaxLastFrame` quand aucune image de fin n'est fournie (piège documenté, LESSONS §
« `MiniMaxH3ImageToVideo` est un nœud à trois modes »). Le Canvas, lui, n'a jamais reçu
`applyMinimaxLastFrame` :

- `js/nodes-simple.js` L322-345 (`VideoNode.generate`, moteur `minimax_h3`) ;
- `js/nodes-advanced.js` L538-559 (`CutVideoNode.generate`, moteur `minimax_h3`).

`buildGraph` substitue `{{IMAGE2}}` par `""` → `LoadImage { image: "" }` → le job échoue.

**Vérifié à l'exécution** (lot 1A, ComfyUI 0.37.2, 2026-09-24) — et non à la validation comme
l'annonçait une première lecture du code : le prompt est **accepté** (HTTP 200, `node_errors: {}`)
puis le job échoue sur le nœud `lastimg` avec `[Errno 21] Is a directory: '/basedir/input'`
(`image: ""` se résout sur le dossier `input/` lui-même, qui existe donc passe la validation).
Effet pratique inchangé : les deux cartes H3 i2v du Canvas sont inutilisables (LTX 2.5 et le mode
`minimax_h3_r2v` ne sont pas touchés). **Corrigé** par le lot 1A (commit `91bbd90`).

**Correction** : porter `applyMinimaxLastFrame` dans `js/engine.js` et l'appeler juste après
`E.buildGraph(...)` dans les deux branches H3 (`E.applyMinimaxLastFrame(graph, false)`).
Illustre directement le coût de la duplication Studio/Canvas (voir I14).

**État (2026-09-24)** : corrigé — commit `91bbd90`

### C3 — `scripts/models.txt` : une installation neuve place la LoRA Lightning là où aucun gabarit ne la cherche — **régression du correctif du piège n°14**

`scripts/models.txt` L4 :

```
loras|Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors|…
```

`install.sh` télécharge donc le fichier dans `models/loras/`. Or, depuis le correctif du piège
n°14 (2026-09-01), `qwen_edit_i2i.json` et `qwen_edit_dual.json` (L109) référencent
`Qwen/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors`, c.-à-d. `models/loras/Qwen/`.

Sur une machine neuve : Localized Assets **et** les keyframes du storyboard avec le moteur par
défaut (2509) sont rejetés (`lora_name … not in list`). Sur ce GB10 le défaut est masqué parce
que les deux copies existent (**vérifié** : `loras/Qwen-Image-Edit-…` et
`loras/Qwen/Qwen-Image-Edit-…` présents).

**Correction** : `loras/Qwen|Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors|…`
(le script crée déjà `$target_dir`). Voir aussi M11 : `validate.py`/`onboard.py` n'auraient pas
détecté l'écart.

**État (2026-09-24)** : corrigé — commit `91bbd90`

---

## IMPORTANT

### I1 — `nginx.conf` / `docker-compose.yml` : tout le dépôt est servi publiquement, `.git/` et `.env` compris

`docker-compose.yml` L13 monte `./` comme racine web, `nginx.conf` L6/L44-47 sert tout fichier
existant. **Vérifié** sur `:8090` : `/.git/config` 200, `/.git/HEAD` 200, `/.env` 200,
`/.claude/settings.local.json` 200 (4,7 Ko, liste de permissions de l'agent),
`/tools/object_info.json` 200 (3 Mo), `/docker/updater/server.py` 200. `.git/` permet de
reconstruire tout l'historique ; aujourd'hui l'URL du remote ne contient pas de jeton, mais rien
n'empêche qu'un `git remote set-url https://<token>@…` fuie demain.

**Correction** (minimale) dans `nginx.conf`, avant `location /` :

```nginx
location ~ /\. { deny all; }
location ~ ^/(tools|docker|scripts)/ { deny all; }
```

**État (2026-09-24)** : corrigé — commit `b2700a0`

### I2 — ComfyUI et Ollama exposés sur toutes les interfaces, ComfyUI en `SECURITY_LEVEL: weak` + CORS `*` — **dérive** du commentaire de `nginx.conf`

`nginx.conf` L2 : « 8188/11434 are never exposed ». Faux : `docker/stacks/comfyui.yml` L12-13
et `docker/stacks/ollama.yml` L9-10 publient `8188:8188` et `11434:11434` sur `0.0.0.0`.
**Vérifié** (`ss -ltn`) : `0.0.0.0:8188`, `0.0.0.0:11434`. ComfyUI tourne avec
`SECURITY_LEVEL: weak` (le niveau le plus permissif de ComfyUI-Manager) et `--enable-cors-header`
(L26). **Vérifié** : un préflight `OPTIONS /prompt` avec `Origin: https://evil.example` répond
`Access-Control-Allow-Origin: *` + `Allow-Credentials: true`, et `/v2/manager/version` répond 200.

Conséquence : n'importe quel poste du LAN — ou n'importe quelle page web ouverte dans un
navigateur de ce LAN — peut soumettre des jobs, piloter le Manager (installation de custom nodes =
exécution de code sur le GB10) et supprimer des modèles Ollama (`DELETE /api/delete`). Le proxy
`/comfy/` et `/ollama/` de `:8090` expose en plus la totalité des deux API.

**Correction** :
1. `"127.0.0.1:8188:8188"` et `"127.0.0.1:11434:11434"` dans les deux gabarits de stack (nginx
   est en `network_mode: host`, il continue d'y accéder) ;
2. retirer `--enable-cors-header` : l'app passe par le proxy same-origin, elle n'en a pas besoin ;
3. `SECURITY_LEVEL: normal` ;
4. le lien « Open ComfyUI » (`index.html` L2313, `http://${HOST}:8188`) cessera alors de marcher à
   distance : le garder pour un usage local, ou documenter un tunnel SSH.

Hors `install.sh`, les stacks déjà déployées (`~/comfyui-spark/compose.yaml`) sont à corriger à la
main (`cp` seulement si absent, `install.sh` L193).

**État (2026-09-24)** : corrigé — commit `b2700a0`

### I3 — `docker/updater/server.py` : téléversement LoRA sans protection CSRF, écrasement silencieux, `.part` orphelin

`_handle_lora_upload` (L90-135) :
- **aucun contrôle d'origine** : un `fetch(…, {method:"POST", mode:"no-cors", body: blob})`
  depuis n'importe quel site est une requête « simple » que nginx transmet — une page tierce ouverte
  sur le LAN peut écrire jusqu'à 10 Go dans `models/loras/` ;
- `os.rename(part_path, final_path)` (L134) **écrase** un fichier existant : téléverser un
  `H3/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors` quelconque remplace la LoRA turbo
  câblée dans les 3 gabarits H3, sans avertissement ;
- `except OSError` (L122-124, disque plein, connexion coupée) renvoie 500 **sans supprimer** le
  `.part` ;
- deux téléversements concurrents du même nom écrivent le même `.part`.

**Correction** : refuser si `Sec-Fetch-Site` est présent et différent de `same-origin` (tous les
navigateurs actuels l'envoient) ; `if os.path.exists(final_path): 409` ; `os.remove(part_path)` dans
l'`except` ; `tempfile.mkstemp(dir=dest_dir, suffix=".part")` au lieu d'un nom fixe.

**État (2026-09-24)** : corrigé — commit `b2700a0`

### I4 — `nginx.conf` `/update/` : un LoRA de plusieurs Go est d'abord bufferisé en entier dans le conteneur nginx

`location /update/` (L33-38) relève `client_max_body_size` à 10g mais garde
`proxy_request_buffering on` (défaut). nginx écrit donc tout le corps dans `client_body_temp` (couche
inscriptible du conteneur `nginx:alpine`, même disque que les modèles) **avant** d'ouvrir la connexion
vers l'updater, qui réécrit ensuite le fichier : double écriture, jusqu'à 10 Go de disque transitoire,
et une barre de progression XHR qui atteint 100 % puis reste muette pendant toute la recopie.

**Correction** : `proxy_request_buffering off;` (+ `proxy_read_timeout 600s;`) dans
`location /update/`. Le serveur Python lit déjà le corps en flux par blocs de 1 Mo.

**État (2026-09-24)** : corrigé — commit `90a0122`

### I5 — `nginx.conf` `/ollama/` : timeout de lecture par défaut (60 s) sur des appels `stream:false`

`location /ollama/` (L26-31) ne fixe pas `proxy_read_timeout` (60 s par défaut). Tous les appels
gemma sont non streamés (`gemmaJSON` L5011-5028, `callOllama` L3686), donc rien ne transite avant la
fin de la génération. LESSONS § Application : « Premier appel à froid ≈ 45 s ». Un découpage de 16
plans (`shotListFromBrief`), un découpage de scénario en 10 segments ou une description vision
(`describeRefImages`) à froid dépassent 60 s → nginx renvoie 504 → `gemmaJSON` relance le même appel
sans `think` (deuxième attente) puis fait `res.json()` sur une page HTML → `SyntaxError` sans rapport
avec la cause.

**Correction** : `proxy_read_timeout 300s;` dans `location /ollama/`, et `if (!res.ok) throw new
Error(\`ollama ${res.status}\`)` après le second `fetch` de `gemmaJSON` (les deux copies).

**État (2026-09-24)** : corrigé — commit `90a0122` (volet nginx : `proxy_read_timeout 300s`) et commit `dc7b5d8` (volet `gemmaJSON` : « ollama <code> »)

### I6 — `cancelProject` interrompt n'importe quel job en cours, pas seulement ceux du projet

`index.html` L7973 : `fetch(\`${COMFY}/interrupt\`, { method: "POST" })` sans corps = interruption
**globale**. Le job qui tourne peut être une carte Canvas dans un autre onglet, ou le job d'un autre
utilisateur de la démo. **Vérifié** dans `/comfy/mnt/ComfyUI/server.py` L1163-1190 : la version
installée accepte `{"prompt_id": …}` et n'interrompt que si ce prompt est celui en cours.

**Correction** :

```js
await Promise.all(queued.map(id => fetch(`${COMFY}/interrupt`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt_id: id }) })));
```

(le `POST /queue {delete}` existant reste pour les jobs en attente).

**État (2026-09-24)** : corrigé — commit `f6a13c3`

### I7 — Étape 2 du storyboard : un échec laisse des keyframes « Génération… » pour toujours

`directorStep2` (L6720-6742) :
- une exception de `submitKeyframeJob` au plan k (ComfyUI qui rejette le graphe) sort de la boucle :
  les jobs 0..k-1 tournent sur le GPU mais `trackKeyframeCompletion` n'est jamais appelé pour eux, et
  les cartes 0..n-1 restent `pending` ;
- un job qui échoue fait rejeter `Promise.all` ; sa carte reste `pending`.

Or `renderKeyframeCard` (L6782-6785) désactive « 🔄 Régénérer » et « ✎ Prompt » sur une carte
`pending`. Seule issue : relancer toute l'étape 2 (voir I8), qui refait les N keyframes.

**Correction** : statut par keyframe, comme `regenerateKeyframe` le fait déjà :

```js
ids.map((id, i) => trackKeyframeCompletion(i, id).catch(err => {
  director.keyframes[i].status = "error"; renderKeyframeCard(i); addEvent("WARN", err.message, "warn");
}))
```

et un `try/catch` autour de chaque `submitKeyframeJob` qui pose `status = "error"` sur ce plan.

**État (2026-09-24)** : corrigé — commit `f6a13c3`

### I8 — « Générer les keyframes » réapparaît actif après une reprise de projet et efface keyframes verrouillées et montage sans confirmation

`updateGateState` (L6556) remet `#directorKeyframesBtn` visible dès que les planches sont validées,
sans regarder si des keyframes existent. `resetDirectorZone` (L6043) le réactive
(`disabled = false`). Après « Reprendre le projet » (`restoreProject` L7820 puis L7882), le bouton
est donc visible **et actif** au-dessus de keyframes déjà rendues. Un clic appelle `directorStep2`,
qui recrée `director.keyframes` (L6725) **sans tenir compte de `locked`**, remet
`cutPlan/cuts/order/animatic` à `null` (L6727) et soumet N nouveaux jobs. Le verrouillage
(`toggleLockKeyframe`) est donc contournable, et tout le montage est perdu.

Hors reprise, le même `updateGateState` le fait réapparaître (grisé, `disabled` resté à `true`) après
chaque fin de keyframe : bouton mort à l'écran.

**Correction** : `$("directorKeyframesBtn").style.display = unlocked && !director?.keyframes ? "" : "none";`
— une régénération passe déjà par les cartes, plan par plan.

**État (2026-09-24)** : corrigé — commit `f6a13c3`

### I9 — Montage : un seul cut en échec fait perdre tous les autres

`generateCuts` (L6926-6937) soumet les N cuts puis attend `waitForJobs(ids)` en bloc. Au premier
job en erreur, `waitForJobs` lève (L5237) : aucun cut n'est récupéré, `director.cuts` reste un tableau
de `null`, `renderMontage` n'affiche rien, et `regenerateCut(k)` est inutilisable (il exige
`director.cuts[k]`). Il faut relancer les N cuts — plusieurs minutes de GPU pour un seul échec,
pendant que les cuts restants continuent de tourner sans être collectés.

**Correction** : même motif que les keyframes — une attente par cut, `director.cuts[k] =
{ …, status: "error" }` en cas d'échec pour que « 🔄 Re-rendre ce plan » fonctionne sur lui seul.

**État (2026-09-24)** : corrigé — commit `f6a13c3`

### I10 — Prompt Relay : l'identité du personnage dépend de l'onglet de sujet affiché

`relayContext` (L7557-7567) prend `charDesc: charDescFromFields(director.charFields)` et
`renderRelaySegment` (L7596-7598) prend `director.charName` comme image de référence au premier
segment. Ces deux accesseurs pointent sur `chars[charIdx]`, le sujet **affiché** dans le menu
Personnage. Mais le shot minimal du relay (`relayShot`, L7247-7250) porte `subjects: [0]`, donc
`buildH3CutPrompt` → `h3CutSubjects` → `shotSubjects` décrit le **sujet 1**, et
`relaySubjectLegend` (composer de scénario) aussi.

Scénario : storyboard à deux sujets, l'onglet « Sujet 2 » est resté sélectionné, lancement du relay
en moteur H3 → keyframe composée sur la planche du sujet 2, `subject_definitions` qui décrit le sujet 1.
Rendu plausible et faux, sans signal.

**Correction** : dans `relayContext`/`renderRelaySegment`, lire explicitement
`const c = director.chars[0]` (`charDescFromFields(c.fields)`, `c.variants[c.active]?.inputName`).

**État (2026-09-24)** : corrigé — commit `f6a13c3`

### I11 — `waitForJobs` attend à l'infini un job qui n'existe plus

`index.html` L5226-5242 et `js/engine.js` L672-686 : tant que `/history/<id>` ne renvoie rien, la
boucle continue. Un redémarrage de ComfyUI (historique en RAM), un job retiré de la file depuis
l'interface ComfyUI ou depuis un autre onglet → attente éternelle toutes les 1,5 s. Côté Studio seul
« Annuler le projet » en sort ; côté Canvas **rien** (pas de `cancelToken`) : la carte reste
« running » jusqu'au rechargement de la page.

**Correction** : quand l'entrée est absente, vérifier `/queue` (une requête, déjà utilisée par
`pollMonitor`) ; absent de `queue_running` et `queue_pending` deux fois de suite → lever
« job perdu (ComfyUI redémarré ?) ».

**État (2026-09-24)** : corrigé — commit `dc7b5d8`

### I12 — `localStorage` : `assetPrompts` n'est jamais purgé, et les écritures ne sont pas protégées

`assetPrompts` (L3132) reçoit le prompt complet de chaque sortie (`recordPrompts` L3410-3419, appelé à
chaque job et 24 fois au démarrage par `preloadGallery`) : prompts H3 jusqu'à 7 000 caractères,
keyframes ~2-3 Ko. Aucune suppression n'existe (seul `galleryAssets` est plafonné à 200). Une fois le
quota (~5 Mo) atteint :
- `persistAsset` (L3278) lève `QuotaExceededError` dans `handleWS` → la carte d'asset n'est plus
  ajoutée à la galerie ;
- `saveAssetPrompts` lève dans `collectHistory` avant la boucle d'ajout → les vidéos non remontées
  par le WS sont perdues ;
- `saveProject` échoue (« Sauvegarde du projet impossible ») → la reprise de projet cesse de marcher.

**Correction** : dans `saveAssetPrompts`, ne garder que les clés présentes dans `galleryAssets`
(+ `cloud:*` de la session), et `try/catch` autour des `setItem` de `persistAsset`/`markDeleted`.

**État (2026-09-24)** : corrigé — commit `dc7b5d8`

### I13 — Canvas : aucune des corrections de prompt qualifiées depuis le 2026-09-21 n'y a été portée — **dérive** (à trancher)

Les cartes Canvas (`adv/charsheet`, `adv/storyboard`, `adv/cutvideo`, `adv/r2v`, `simple/video`)
utilisent des compilateurs de `js/engine.js` figés avant les pièges n°17 à n°32 :

| Règle documentée | Canvas (`js/engine.js` / nodes) |
|---|---|
| n°17 : squelette de fiche selon `kind`, gabarit non humain | `characterSheetFromBrief` L870-883 : schéma humain seul ; `buildCharsheetGraph` L750-759 : « one single person », « standing poses », « costume details » en dur → un lion sort anthropomorphe |
| n°17/n°32 : ancrage keyframe sans « standing » ni « costume » | `compileKeyframePrompt` L541-547 : « standing in that location », « face, hair, costume » |
| n°28 : décor nommé aussi après l'action | L532-538 : seulement dans la phrase de rôle |
| AGENTS : « Prompt Minimax H3 : grammaire structurée obligatoire » (n°19) + alignement I2VA | `Ref2VideoNode` L754-758 et `CutVideoNode` H3/r2v L541, L566 : chaîne plate `charDesc. locDesc. brief` ou prose LTX, ni `subject_definitions` ni `h3Alignment` |
| `stripPromptPadding` sur tout ce qui part vers Krea 2 | absent (fiches, `ENHANCE.krea2Prompt` de `canvas.html` L669) |

Les docs ne décrivent ces règles que pour `index.html` ; il faut donc **décider** si elles
s'appliquent au Canvas. Si oui, les fonctions existent déjà dans `index.html` (`CHAR_OTHER_FIELD_KEYS`,
`SHEET_TEMPLATES`/`sheetWords`, `KEYFRAME_ANCHOR_SOLO`, `buildH3RefPrompt`, `h3Alignment`,
`stripPromptPadding`) et se portent sans les modifier. Sinon, l'écrire dans `ARCHITECTURE.md` (« Canvas
= formulations antérieures au 2026-09-21, non qualifiées ») pour que personne ne s'y fie.

**État (2026-09-24)** : non corrigé — décision de l'utilisateur en attente (porter ou non les corrections de prompt au Canvas)

**État (2026-09-25)** : traité — l'utilisateur a décidé le 2026-09-24 de porter ces corrections au Canvas (Vague 3, lots A1 à A3) : `55b02ff` (portage dans `js/engine.js` : fiches selon le type de sujet, ancrages keyframe, grammaire H3, `STYLE_PACKS` à 14 styles, `Engine` de 57 à 75 clés), `4145b2c` (cartes branchées : fiches, cuts H3, carte Vidéo H3, r2v, « Enrichir »), `d001015` (cuts `minimax_h3_r2v` en grammaire Ref2VA, sélecteur « Type de sujet », `h3CutBodyText` exporté, `Engine` à 76 clés). **Reste ouvert** : le code est porté, donc dupliqué entre `index.html` et `js/engine.js` (I13-B, source unique : décision en attente) ; les keyframes à deux sujets ne sont pas câblées au Canvas (la 3ᵉ fiche reste une référence de plus) ; test de parité ajouté ensuite : `node tools/parity-prompts.js` (`docs/TESTING.md` § « Parité des prompts Studio / Canvas »).

### I14 — Duplication Studio / Canvas : une vingtaine de fonctions « portées verbatim » à maintenir deux fois

`index.html` recopie depuis `js/engine.js` : `buildGraph`, `getTemplate`, `extractFiles`,
`outputFiles`, `reupload`, `uploadBlob`, `viewURL`, `imageSize`, `videoSizeFor`, `makeGraphBuilder`,
`addKrea2Shared/Shot`, `addGrid`, `buildAnimaticGraph`, `applyMinimaxTurbo`, `addMinimaxRefs`,
`addQwen21Refs`, `fetchLoraOptions` + `H3_TURBO_LORAS`, `computeMPResolution`, `mpUnitForEngine`,
`MP_VALUES`, `gemmaJSON`, `fieldText`, `normalizeShotList` & co. `AGENTS.md`/`ARCHITECTURE.md` le
consignent comme un piège d'entretien (« toute nouvelle LoRA turbo à exclure doit être ajoutée aux
deux copies »), et C1/C2 en sont deux conséquences directes : un correctif fait d'un côté, pas de
l'autre.

Le seul obstacle cité dans le code (`index.html` L4411-4413) est que `js/engine.js` ouvre un
WebSocket dès son chargement (L867). Proposition, limitée au sous-ensemble **identique au caractère
près** (pas les compilateurs de prompt, qui divergent volontairement) : rendre la connexion WS
d'`engine.js` paresseuse (ouverte au premier `registerJob`), charger `js/engine.js` dans `index.html`
et remplacer les copies par `Engine.xxx`. Gain : ~300 lignes en moins et un seul point de correction.
Risque : modéré (le Studio n'a pas de tests de non-régression automatisés) — à faire après C1/C2,
avec la capture headless habituelle des deux apps.

**État (2026-09-24)** : corrigé — commit `aff8a12`

---

## MINEUR

### M1 — `index.html` : branche morte de `generateReference2Video` et `soulAnchors`

`BUILDERS.reference2video` (L3470-3472) n'appelle `generateReference2Video` que si
`#skipSheetsToggle` est coché, et la fonction traite ce cas puis `return` (L5934-5948). Les lignes
L5950-5966 (fiches gemma + planches + `setSoulAnchors`) sont inatteignables. `setSoulAnchors`
(L3044) n'a pas d'autre appelant : `soulAnchors` vaut toujours `null` et le repli de
`currentAnchors` (L3055) est mort. À supprimer (~25 lignes).

**État (2026-09-24)** : corrigé — commit `8037bde`

### M2 — `js/engine.js` : ~230 lignes sans appelant, dont un « mode Auto » interdit par AGENTS

Sans aucune référence hors commentaires dans `canvas.html` et `js/nodes-*.js` (**vérifié** par
recherche) : `generateStoryboardV2` (L967-1006, chaîne Auto complète — AGENTS : « Pas de mode Auto…
ne pas le réintroduire »), `generateReference2Video` (L1008-1032), `buildCampaignFullGraph` et
`mergeGraph` (L424-454, qui demandent encore « space for title text » alors que le titre incrusté est
abandonné depuis le 2026-09-21), `buildFLF2VGraph`, `addFLF2VChain`, `addLtx25Shared`,
`addLtx25Enhance`, `addVideoOutput`, `resolveImageJob`, `HOLD_MOTION`, `FLF2V_SIGMAS`. À retirer, ainsi
que leurs clés dans `global.Engine`.

**État (2026-09-24)** : corrigé — commit `8037bde`, à l'exception de `resolveImageJob`, toujours défini et exporté par `js/engine.js` (sans appelant hors commentaire)

### M3 — `index.html` : `callOllama` double `gemmaJSON`

`callOllama` (L3686-3702, seul appelant `enrichBrief`) refait ce que fait `gemmaJSON` (L5011-5028), avec
un paramètre au nom inversé (`withThink = true` pose `think: false`). `enrichBrief` (L3890-3891) relance
en outre l'appel sur **toute** erreur, réseau compris. Remplacer par `gemmaJSON(system, user)`.

**État (2026-09-24)** : corrigé — commit `dc7b5d8`

### M4 — `index.html` : `POST /prompt` et upload écrits trois fois

- Soumission : handler Generate (L3577-3586), `generateSequence` (L8042-8050), `submitGraph`
  (L5208-5219). Les deux premiers → `submitGraph(graph, label, sub)`.
- Upload : `uploadInputImage` (L3482-3488), `uploadRefFile` (L3494-3502), `uploadBlob` (L8015-8023)
  sont identiques au message d'erreur près → `uploadBlob` seul.
- `reupload` (L5255) reconstruit à la main l'URL de `viewURL` (L4859).

**État (2026-09-24)** : corrigé — commit `dc7b5d8` (les messages de journal de `submitGraph` remplacent ceux des anciennes copies)

### M5 — Moniteur : Ollama affiché « Ready » quand il est arrêté ; polling en onglet caché

`pollMonitor` L4123-4128 : `await fetch(\`${OLLAMA}/api/version\`)` ne teste pas `res.ok`. Ollama
arrêté → nginx renvoie 502 → la promesse se résout → « Ready ». Corriger par
`if (!(await fetch(…)).ok) throw 0;`. Le même poll (3 requêtes toutes les 4 s, L8084) tourne aussi
onglet masqué : `if (document.hidden) return;` en tête.

**État (2026-09-24)** : corrigé — commit `dc7b5d8`

### M6 — Une LoRA téléversée n'apparaît dans les sélecteurs qu'après rechargement

`fetchLoraOptions` n'est appelé qu'une fois par chargement de page (`index.html` L2254,
`js/engine.js` L392). Le téléversement (L4186-4191) ne rappelle que `loadModels`. Le texte de la carte
(« apparaît automatiquement dans les sélecteurs de style ») et ARCHITECTURE L51 (« re-scanné en
direct à chaque appel ») laissent croire l'inverse. Extraire le `.then` en `refreshLoraOptions()`
(`KREA2_LORAS.length = 1; H3_STYLE_LORAS.length = 1;` puis `push`, ce qui préserve les références
partagées) et l'appeler après un téléversement réussi.

**État (2026-09-24)** : corrigé — commit `dc7b5d8`

### M7 — WebSocket : `execution_interrupted` ignoré, pas de resynchronisation à la reconnexion

`handleWS` (L3087-3115) ne traite pas `execution_interrupted` (interruption depuis l'interface ComfyUI
ou un autre onglet) et `connectWS` (L3076-3085) ne relit rien à la reconnexion : un message de fin
perdu laisse la ligne « Running » et `runningJobs` jamais décrémenté, donc le bouton « Annuler » reste
affiché. `jobs` (L3072) n'est jamais purgé et retient des nœuds DOM déjà retirés de la liste.
Traiter `execution_interrupted` comme `execution_error` ; dans `ws.onopen`, relire `/history/<id>`
pour chaque id de `activeJobIds` ; `delete jobs[id]` en fin de job.

**État (2026-09-24)** : corrigé — commit `dc7b5d8`

### M8 — Uploads en `overwrite: true` avec le nom du fichier utilisateur

`uploadInputImage` L3484, `uploadRefFile` L3497, `uploadBlob` L8018, `js/engine.js` L801. Deux images
différentes portant le même nom (`image.png` collé depuis le presse-papiers) : la seconde remplace la
première dans `input/` pendant que le premier job attend dans la file → il est rendu avec la mauvaise
image. Le code lit déjà le nom renvoyé (`d.name`) : passer `overwrite` à `"false"` suffit, ComfyUI
renomme. (Pour `reupload`, les noms de sortie sont uniques : sans effet.)

**État (2026-09-24)** : corrigé — commit `dc7b5d8`

### M9 — `capH3Prompt` coupe la fin, c'est-à-dire ce qu'il prétend protéger

L5840-5844 : `text.slice(0, H3_PROMPT_CHARS)` retire `non_diegetic_music`, `overall_soundscape`, et
peut couper un jeton `<Subject N` au milieu — le commentaire L5837-5839 dit vouloir éviter
précisément la perte des champs de fin. Tronquer plutôt `detailed_description` (seul champ libre) de
l'excédent avant d'assembler. Probabilité faible (7 000 caractères), d'où « mineur ».

**État (2026-09-24)** : corrigé — commit `8037bde`

### M10 — `{{FRAMES}}` calculé à 25 fps par défaut alors que LTX 2.5 rend en 24 — dérive latente du « piège de fps silencieux »

`buildGraph` (`index.html` L2974, `js/engine.js` L34) : `(p.duration || 5) * (p.fps || 25) + 1` ;
`tools/validate.py` L372 : `--fps` par défaut 25. Aucun gabarit actuel n'utilise `{{FRAMES}}`, mais
`tools/onboard.py` L214-225 l'injecte sur tout `EmptyLTXVLatentVideo`/`LTXVEmptyLatentAudio`. Un futur
gabarit LTX 2.5 onboardé sans `--fps 24` repartirait sur le décompte à 25 fps que LESSONS (« Piège de
fps silencieux ») a éliminé partout ailleurs. Remplacer 25 par 24 (`LTX25_FPS`) aux trois endroits.

**État (2026-09-24)** : corrigé — commit `90a0122` (outils : `validate.py`/`onboard.py`, fps 24 par défaut) et commit `8037bde` (JS : `{{FRAMES}}` à 24 fps dans `buildGraph`)

### M11 — `validate.py` / `onboard.py` ne comparent que le nom de base des modèles

`tools/validate.py` L121-126 et L152-157, `tools/onboard.py` L246-261 : l'index contient les noms de
fichiers sans chemin, et la vérification fait `os.path.basename(ival) in index`. Un gabarit qui
référence `Qwen/X.safetensors` passe si `X.safetensors` existe **n'importe où** sous `models/` —
c'est exactement le cas de C3 et de la dérive du piège n°14, que l'outil ne peut donc pas voir.
Indexer les chemins relatifs à chaque dossier de catégorie
(`os.path.relpath(path, os.path.join(MODELS_DIR, <catégorie>))`) et comparer `ival` tel quel.

**État (2026-09-24)** : corrigé — commit `90a0122`

### M12 — `install.sh` : téléchargement directement sous le nom final

L461 : `curl -sfL -C - … -o "$target_path"`. Pendant le téléchargement (et après un échec), un
`.safetensors` partiel est visible et sélectionnable par ComfyUI. Et si un fichier local plus petit
existe sous le même nom (ancienne version), `-C -` **ajoute** la suite de la nouvelle à l'ancienne : le
fichier est corrompu et sa taille peut même tomber dans la tolérance de 1 % au passage suivant.
Télécharger vers `"$target_path.part"` (reprise sur le `.part` uniquement) puis `mv`. Accessoirement,
`HF_TOKEN` passe en argument de `curl` (L459-461), donc visible dans `ps` : préférer
`curl -K <(printf 'header = "Authorization: Bearer %s"\n' "$HF_TOKEN")`.

**État (2026-09-24)** : corrigé — commit `90a0122`

### M13 — Canvas : travail DOM à chaque frame, même au repos

`syncOverlays` (`canvas.html` L1199-1220) réécrit `width`, `height` et `transform` de chaque overlay
et, via `updateLiveProps` (L1615-1619), le `textContent` du statut à chaque `requestAnimationFrame`
— 60 fois par seconde tant que la page est ouverte. `graph.start()` (L1188) fait tourner en plus la
boucle d'exécution de litegraph alors qu'aucun nœud n'a d'`onExecute`. Mémoriser la dernière valeur
écrite et n'écrire que si elle change ; supprimer `graph.start()`.

**État (2026-09-24)** : corrigé — commit `0dc544f`

### M14 — Canvas : un état sauvegardé illisible bloque tout le démarrage

`canvas.html` L1231-1232 : `graph.configure(JSON.parse(saved))` sans `try`. Un JSON tronqué (quota,
onglet tué pendant l'écriture) lève dans l'IIFE principale : plus d'UI, et la seule réparation est
DevTools. `save()` (L1223) n'est pas protégé non plus. `try { … } catch { localStorage.removeItem(STORAGE_KEY); }`
avec un message.

**État (2026-09-24)** : corrigé — commit `0dc544f`

### M15 — Canvas dépend de jsdelivr pour litegraph, sans empreinte SRI

`canvas.html` L307 charge `litegraph.min.js` depuis `cdn.jsdelivr.net`. Démo hors ligne → `LiteGraph`
indéfini → `nodes-simple.js` lève au chargement → Canvas inutilisable (le Studio ne perd que sa
police). Sans attribut `integrity`, un CDN compromis exécute du code sur la même origine que le Studio
(accès à `localStorage`, à `/update/*`). Vendoriser le fichier dans `js/vendor/` (≈ 300 Ko), ou au
minimum ajouter `integrity` + `crossorigin`. Non documenté dans `AGENTS.md` (« pas de dépendances côté
frontend »).

**État (2026-09-24)** : corrigé — commit `0dc544f` + `dd86b67`

### M16 — Updater : « mise à jour disponible » vrai dès que le HEAD local diffère de `origin/main`

`server.py` L53-57 : `updateAvailable = local_sha != remote_sha`. Sur une branche locale en avance
(commits non poussés) ou une autre branche (ex. `install-v2`), la question « Une mise à jour est
disponible » s'affiche à **chaque** chargement du Studio et du Canvas, et « Oui » fait
`git pull --ff-only origin main` dans la branche courante (L83). Par ailleurs `git ls-remote` part sur
le réseau à chaque chargement de page, sans cache. Tester
`git merge-base --is-ancestor <remote> HEAD` (après un `fetch`), refuser `/apply` hors de `main`, et
mettre le résultat de `/status` en cache une minute.

**État (2026-09-24)** : corrigé — commit `90a0122` (sans `git fetch` dans `/status` : lecture seule, le SHA distant vient de `git ls-remote`). Depuis le commit `3df4c65` (Vague 2, décision Q9) l'updater ne tourne plus en root mais avec l'UID du propriétaire du dépôt (`APP_UID`/`APP_GID` dans `.env`) ; seul `/apply` fait un `git fetch`.

### M17 — `nginx.conf` `/comfy/` : 50 Mo maximum par upload

L23 : `client_max_body_size 50m`. Les vidéos de référence r2v (`#refVideosInput`) et les imports vidéo
du Canvas dépassent vite 50 Mo ; nginx répond 413 et l'UI affiche « Upload … refusé par ComfyUI »,
qui accuse le mauvais composant. Relever à 500m (ComfyUI n'a pas de limite plus basse par défaut).

**État (2026-09-24)** : corrigé — commit `90a0122`

### M18 — Relay : une liaison 🔗 « continue » devient silencieusement une coupure

`renderRelaySegment` L7584-7585 : `const mode = i === 0 || !prev ? "cut" : seg.mode;`. Si le segment
précédent n'a pas de bande de transition (extraction échouée, `extractTransitionStrip` L7197), le
segment passe par une keyframe Qwen-Edit — ce que LESSONS n°22 décrit comme produisant une coupure
visible — alors que l'utilisateur a demandé la continuité frame-exacte. Ajouter un `addEvent("WARN", …)`
ou refuser le rendu en demandant de re-générer le segment précédent.

**État (2026-09-24)** : corrigé — commit `f6a13c3` (refus du segment en mode `continue` sans frame de transition, pas de repli silencieux en coupure)

### M19 — Blobs et objectURLs jamais libérés

Variantes de planches (`resolveVariantJob` L6189), keyframes (`trackKeyframeCompletion` L6748),
restauration (`resolveFileRef` L7802), actifs cloud (L3836) : chaque rendu garde un blob PNG
1920×1088 + un objectURL jamais révoqués, y compris après `resetDirectorZone`. Sur une longue session
de régénérations la mémoire de l'onglet croît sans borne. `URL.revokeObjectURL` au remplacement d'une
variante non active et dans `resetDirectorZone` ; ne garder le blob que pour la variante active.

**État (2026-09-24)** : partiellement corrigé — commit `f6a13c3` pour les variantes de planches, les keyframes et la restauration (a-c) ; non corrigé pour (d)/(e) : l'aperçu et la séquence relisent ces URL, les révoquer les casserait

### M20 — Attentes orphelines : garde de session manquante dans `trackKeyframeCompletion` et `generateCuts`

`resolveVariantJob` vérifie que la session n'a pas été remplacée (L6193-6194) ; `trackKeyframeCompletion`
(L6746) et `generateCuts` (L6934) relisent `director` **après** l'`await` sans cette garde, et
`resetDirectorZone` (changement de pipeline, nouveau Generate) n'incrémente pas `cancelToken`. Effet le
plus probable : `WARN Cannot set properties of null` quand l'ancien job finit après un reset ; au pire,
écriture du résultat dans la session suivante. Capturer `const d = director` en entrée et sortir si
`director !== d`, comme `resolveVariantJob`.

**État (2026-09-24)** : corrigé — commit `f6a13c3`

### M21 — Clé Gemini passée en paramètre d'URL

`generateViaGemini` L3788 : `…:generateContent?key=${encodeURIComponent(key)}`. La règle projet
(sessionStorage seul, jamais loguée) est respectée — **vérifié** : la clé n'est lue que par
`getCloudKey`, jamais passée à `addEvent`, jamais persistée ; la purge des anciennes clés
`localStorage` est en place (L3720-3722) ; le Canvas n'a pas de clé. Mais une clé en query string
apparaît dans les onglets Réseau, les exports HAR et les journaux de tout proxy. L'API accepte l'en-tête
`x-goog-api-key` : l'utiliser.

**État (2026-09-24)** : corrigé — commit `dc7b5d8`

---

## COSMÉTIQUE

### K1 — Clé I18N dupliquée : « Détails » perd sa traduction allemande

`index.html` L2543 (`{ en, es, de }`) et L2594 (`{ en, es }`) : la seconde écrase la première dans le
littéral objet. **Vérifié** (seule clé dupliquée du dictionnaire). Supprimer L2594.

**État (2026-09-24)** : corrigé — commit `8037bde`

### K2 — `renderSheetLoraSelect` ne traduit pas « Aucun »

L2949 : `${l}` au lieu de `${tr(l)}` (`renderLoraSelect` L2943 le fait).

**État (2026-09-24)** : corrigé — commit `8037bde`

### K3 — Documentation en retard sur le code

- `AGENTS.md` L37 : « `<script>` (~3 000 lignes) » → ~5 900 aujourd'hui.
- `docs/ARCHITECTURE.md` L145 : montage par défaut `./comfyui/basedir/models/loras` ; le code
  (`docker-compose.yml` L28) dit `../comfyui-spark/basedir/models/loras`.
- `docs/ARCHITECTURE.md` § Stockage navigateur (L129-135) : manquent `galleryAssets`, `assetPrompts`,
  `studioProject`, `canvasGraphState`, `canvasLang`, `canvasTheme`, `canvasGalleryAssets`.
- `docs/LESSONS.md` L94 : « no-op … Qwen-Edit » (voir C1).
- `js/engine.js` L717-740 : renvois vers `ai-content-studio-cockpit/…/LOT-D-MEGAPIXELS.md`, absent de
  ce dépôt.

**État (2026-09-24)** : corrigé — commit `8037bde` (`LESSONS.md` L94 : commit `91bbd90`)

### K4 — Trois palettes `STATUS_COLOR` et des helpers de dessin morts

`js/nodes-simple.js` L32 et `js/nodes-advanced.js` L41 (`error: "#a33"`, `idle: "#666"`) contre
`canvas.html` L869 (`error: "#c0392b"`, `idle: "#94a3b8"`) : sur une même carte, la pastille
(`boxcolor`, palette des nœuds) et le texte du pied (palette du canvas) n'ont pas le même rouge.
`drawStatus`/`drawEmptyBody` des deux fichiers de nœuds sont écrasés par l'habillage de `canvas.html`
(L1139-1149) et ne servent plus ; `setStatus`/`buildOverlay` sont copiés à l'identique entre les deux
fichiers alors que `window.__simpleNodes` pourrait les exporter comme il exporte déjà `upstreamFile`.

**État (2026-09-24)** : corrigé — commit `0dc544f`

### K5 — `scripts/models.txt` : `qwen_image_vae.safetensors` listé deux fois

L3 et L7 (deux URLs, même fichier, même taille) : la seconde ligne est toujours un `SKIP`. En garder
une.

**État (2026-09-24)** : corrigé — commit `90a0122`

---

## Pistes de performance déjà connues, pour mémoire

Le `ponytail:` de `submitKeyframeJob` (`index.html` L5533-5534, ré-upload des références Qwen 2.1 à
chaque keyframe) reste l'exemple type : il n'est pas re-signalé. Dans la même famille, relevées
ci-dessus : attentes `/history` par keyframe en parallèle (N requêtes toutes les 1,5 s pendant l'étape 2,
alors que le WS signale déjà `execution_success` — I7/I11), ré-upload de **tous** les cuts à chaque
reprise de projet (`restoreProject` L7911-7917, alors que `relayResolveImage` montre déjà le motif
« à la demande »), `saveAssetPrompts` réécrit en entier 24 fois au démarrage (I12).

---

## Résumé chiffré

| Sévérité | Nombre | Trouvailles |
|---|---|---|
| Critique | 3 | C1, C2, C3 |
| Important | 14 | I1 → I14 |
| Mineur | 21 | M1 → M21 |
| Cosmétique | 5 | K1 → K5 |
| **Total** | **43** | dont 4 régressions / dérives de règles documentées (C1, C2, C3, I2) et 1 dérive à trancher (I13) |

Ordre de traitement suggéré : C1, C2, C3 (une à trois lignes chacun), puis I1/I2/I3 (exposition
réseau), puis I7/I8/I9 (pertes de travail GPU sur échec), puis I14 une fois ces correctifs posés.
