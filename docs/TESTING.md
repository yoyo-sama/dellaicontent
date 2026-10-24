# Méthode de validation

Règle d'or : **un job "success" ne prouve pas que le contenu est bon.** Chaque bug sérieux de ce projet (encodeur Flux2, recadrage FLF2V) a été trouvé en regardant les pixels, pas les statuts. Valider = rendu réel réduit + inspection visuelle/audio.

## 1. Validation structurelle (rapide, avant tout rendu)

```python
import json, re, urllib.request, os
info = json.load(urllib.request.urlopen("http://localhost:8188/object_info"))
d = json.load(open("workflows/xxx.json"))
# format UI : chaque n["type"] dans info (tolérer MarkdownNote/Note/Reroute + uuids de subgraphs),
# liens [id,src,slot,dst,slot,type] → src/dst existants ; subgraphs : dicts, frontières -10/-20.
# Tous les .safetensors référencés doivent exister sous ~/comfyui-spark/basedir/models/ (COMFY_BASEDIR pour surcharger)
```

## 2. Conversion UI→API et soumission

**Voie rapide** — `tools/validate.py` automatise tout ce qui suit (vérif structurelle + placeholders de test + soumission + poll + extraction frames/audio) :

```bash
python3 tools/validate.py workflows/api/ltx25_t2v.json --reduce --frames 0,12,24 --audio
```

Voie manuelle (debug fin) :

```bash
curl -s http://localhost:8188/object_info > tools/object_info.json   # rafraîchir si nœuds inconnus
python3 tools/convert.py workflows/storyboard_animatic.json > /tmp/api.json
```

Soumettre : `POST /prompt` avec `{"prompt": <graphe API>}` — un 400 renvoie `node_errors` détaillés (itérer dessus). Puis poller `GET /history/<prompt_id>` jusqu'à `status.completed` ou `status_str=="error"` (les erreurs d'exécution sont dans `status.messages`).

**Toujours tester en réduit** : vidéos à ~25 frames (patch du `length` des `EmptyLTXVLatentVideo` **et** des `frames_number` des `LTXVEmptyLatentAudio` dans une COPIE du graphe), batchs à 1. Ordres de grandeur GB10 : image Flux2 ≈ 8 s, segment FLF2V 25 frames ≈ 25 s, teaser t2v 1 s ≈ 30 s, gemma à froid ≈ 45 s.

### Après une mise à jour de ComfyUI

Sans GPU ni soumission : `--no-submit` s'arrête après la vérif structurelle (nœuds connus, liens, modèles sur disque) ; `--refresh` met `tools/object_info.json` à jour d'abord.

```bash
for f in workflows/api/*.json; do python3 tools/validate.py "$f" --refresh --no-submit || echo "KO $f"; done
```

Ne couvre **pas** les workflows construits en JS (storyboard, relay, etc. : assemblés dans `index.html` et `js/`, absents de `workflows/api/`) : un rendu réel réduit reste requis (règle d'`AGENTS.md`).

## 3. Banc headless : exécuter la page telle quelle, ComfyUI et Ollama bouchonnés

C'est la vérification la plus rentable du projet, et la seule possible hors du GB10 : ni ComfyUI ni
Ollama ne tournent en session distante. Elle exécute **la vraie page**, pas un extrait — donc elle
voit les prompts réellement compilés, les graphes réellement soumis et l'état réellement persisté.

Recette : copier le dépôt dans un dossier de travail, injecter dans la copie d'`index.html` un
`stub.js` **avant** `<script src="js/engine.js">` (l'engine fait ses appels réseau, la copie doit donc contenir `js/`), lui-même avant le `<script>` inline et un `drive.js` après `</body>`, servir le tout avec
`python3 -m http.server`, puis dumper le DOM et lire un `<pre id="testOut">` que le driver ajoute.

```js
// stub.js — aucun backend n'existe ici
window.__gemma = null;          // réponse JSON servie à gemmaJSON, test par test
window.__submitted = [];        // graphes POSTés sur /prompt
window.WebSocket = function () { return { addEventListener() {}, close() {}, send() {} }; };
const realFetch = window.fetch;
window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/api/chat")) {
    const b = JSON.parse(opts.body);
    window.__lastSystem = b.messages[0].content;   // la consigne envoyée est vérifiable
    window.__lastUser   = b.messages[1].content;   // ce que gemma reçoit AUSSI (strip-then-reappend)
    if (!window.__gemma) throw new Error("gemma hors ligne (bouchon)");
    return { ok: true, json: async () => ({ message: { content: JSON.stringify(window.__gemma) } }) };
  }
  if (u.includes("/prompt")) { window.__submitted.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ prompt_id: "pid" + window.__submitted.length }) }; }
  if (u.includes("manifest.json") || u.includes("workflows/")) return realFetch(url, opts);
  return { ok: true, json: async () => ({}) };
};
```

```js
// drive.js — construit un état `director` minimal, puis assertions
director = { pipeline: "storyboard_v2", /* … */ };
attachSheetAccessors(director);
const p = compileKeyframePrompt(director.shots[0], [director.charDesc]);
// … pousser les résultats dans un <pre id="testOut">
```

```bash
(cd site && python3 -m http.server 8777 &)
CH=/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell   # ou ~/.cache/ms-playwright/…
$CH --no-sandbox --disable-gpu --dump-dom --virtual-time-budget=60000 \
    http://127.0.0.1:8777/index.html | grep -o '<pre id="testOut">[^<]*'
```

Trois pièges qui coûtent du temps si on les redécouvre :

- Les `let`/`const` de premier niveau de la page **ne sont pas sur `window`**. Un script classique
  chargé après elle partage en revanche la même portée lexicale globale : écrire `director = …`
  fonctionne, `window.director = …` non.
- **Ne jamais `await` une fonction qui attend un job.** `waitForJobs` sonde `/history` sans fin sous
  bouchon : le driver ne rendrait jamais la main et rien ne serait écrit. Tout ce qui précède le
  premier `await` (état poussé, variante ajoutée, prompt rangé) est synchrone et s'observe en
  appelant la fonction **sans** l'attendre, suivi d'un court `setTimeout`.
- Le PNG bouchon doit être un **vrai** PNG : un base64 bricolé fait échouer `createImageBitmap` et
  toute la chaîne meurt sans autre trace qu'un WARN au journal. Monkeypatcher `addEvent` pour
  collecter les WARN est ce qui le révèle.

### Les bancs des Vagues 2 à 4 (Chromium + CDP + stubs) : la méthode, et ce qui fait foi

Les bancs des Vagues 2 à 4 généralisent cette recette : la vraie page (`index.html` ou `canvas.html`, `js/*.js` compris) est servie par `python3 -m http.server`, pilotée dans un **Chromium headless par CDP** (Chrome DevTools Protocol : un mini client Node 22, `WebSocket` et `fetch` globaux, sur le binaire `chrome-headless-shell` de Playwright ; aucune bibliothèque), avec un **profil Chrome vierge à chaque comparaison** (sinon le cache HTTP peut servir un `engine.js` périmé) et **tous les backends bouchonnés** (ComfyUI, Ollama, WebSocket, un vrai PNG). Le bouchon de `/comfy/prompt` est obligatoire dès qu'un banc clique « Générer » : sans lui, un job réel part (un banc de la Vague 2 a ainsi soumis un vrai job Krea 2). Un banc compare deux états du dépôt (`HEAD` et la copie modifiée, deux ports) sur le même scénario, et vérifie qu'il ne mesure pas dans le vide (**témoin négatif** : le même banc doit échouer sur un état volontairement cassé).

- **Matrice de graphes = l'étalon « graphes soumis identiques octet pour octet ».** Un scénario pilote l'UI (les 11 workflows du manifest et leurs variantes : LoRA, turbo 4/6/8/off, FL2VA, marchés, références r2v, bypass des fiches, keyframes à 1 et 2 sujets sur les deux moteurs, cuts LTX 2.5 et H3 avec tenue, relay 1 s / 2 s, annulation, vision gemma…) et enregistre ce que le réseau bouchonné a reçu : corps `POST /comfy/prompt` (`client_id` retiré, mais vérifié égal à celui du Studio), uploads (nom, `overwrite`, taille, type), corps `/ollama/api/chat`, WARN du journal. Avant/après doivent être **identiques au caractère près**. État de référence à la 1.4.0 : 37 scénarios · 112 corps `/prompt` (407 243 o) · 219 uploads · 17 corps ollama (15 103 o). **À la 1.4.1 : 37 scénarios · 112 corps `/prompt` (407 215 o) · 219 uploads · 17 corps ollama (15 094 o)** : 36 scénarios sur 37 sont restés identiques au caractère près, le seul écart (`krea2_lora_style_enrich`) est le changement voulu D1 (clé de sortie `{"prompt"}` de la consigne Krea 2 du Studio, `docs/TESTING.md` § « Consigne gemma selon le modèle »). **À la 1.4.3 : mêmes totaux (37 scénarios · 112 corps `/prompt` (407 215 o) · 219 uploads · 17 corps ollama (15 094 o)), 37/37 identiques à HEAD, 36/37 au golden (même exception D1)** : aucun des 17 corps ollama de la matrice ne passe par les trois routes corrigées (✨ `qwen_edit_i2i`, ✨ du brief de storyboard, ✨ d'une image de plan en moteur 2.1 : aucun de ces boutons n'est cliqué par la matrice, qui n'active l'auto-enrichissement que sur Krea 2), les prouver passe par `tools/prompt-systems.js`. **À la 1.4.4 : mêmes totaux, 37/37 identiques à HEAD** (aucun corps ollama de la matrice ne passe par le ✨ r2v dont la consigne change). **À la 1.4.5 : mêmes totaux, 37/37 identiques à HEAD, 36/37 au golden (même exception D1)** : la matrice n'active l'auto-enrichissement que sur Krea 2, dont la clé ne réécrit pas le négatif ; le correctif de `enrichBrief` (négatif et clé absente) se prouve par `tools/prompt-systems.js` (S-Q2, S-Q4). Toute retouche d'UI, d'i18n ou de mise en page (Vagues 3 et 4) a été rendue à cette matrice ; une retouche de prompt ou d'`engine.js` doit la faire bouger **seulement là où c'est voulu**, et le dire.
- **Zéro job sur simple interaction.** Chaque banc d'UI clique (cartes d'objectif, pipelines, langues, thème, feuilles du Canvas, ⤢, onglets, annuler, sélecteur « Type de sujet »…) avec `/comfy/prompt` bouchonné en compteur et exige **0 soumission** (règle d'AGENTS.md : rien ne part sans un clic sur un bouton de génération). Un témoin positif (un clic « Générer » = 1 prompt) prouve que le compteur compte.
- **Preuves i18n sur le DOM après retrait des `<script>`.** Les chaînes françaises du code vivent aussi dans les balises `<script>` : un scan du texte de la page en allemand y trouverait tout le français du JS. Le banc dumpe le DOM, **retire les `<script>`** puis cherche le français restant (nœuds texte, `placeholder`, `title`, `aria-label`) dans chacune des 4 langues, hors journal d'événements. Vide attendu.
- **Mesures d'UI** (aucun chevauchement, cibles ≥ 44 px sous 768 px, contraste ≥ 4,5:1 mesuré sur le fond réel, focus clavier, zéro écriture DOM au repos pour le Canvas) : par CDP, de 320 à 1440 px de large, en clair et en sombre.

**Où vivent ces bancs.** Hors dépôt, dans `~/.cache/ai-content-studio/` (un dossier par vague et par lot : `vague2/…`, `vague3/3a…3d`, `vague4/4a…4c`, `i13/…` ; le pilote CDP est `cdp.js`, les bouchons `stubs-2e.js`, la matrice `bench-graphs.js` dans les dossiers de lot). Ils **ne sont pas dans le dépôt** et ne doivent pas y être ajoutés : ils dépendent de ports et de copies de travail locales. Cette page décrit la méthode. **Deux tests de prompts, eux, sont dans le dépôt** : `tools/parity-prompts.js` (non-régression des compilateurs, node seul) et `tools/prompt-systems.js` (bonne consigne gemma selon le modèle). Le second est l'**exception assumée** à la règle « bancs hors dépôt » : il n'a besoin d'aucun port fixe ni d'aucune copie de travail (serveur statique en port 0, Chrome en port de débogage 0, profil temporaire supprimé à la fin), seulement de Node 22 et de `chrome-headless-shell` ; voir les deux sous-sections suivantes et `docs/ARCHITECTURE.md` § Code partagé.

**Rejouabilité.** Les bancs des vagues antérieures ne sont **pas rejouables tels quels** : leurs assertions lisent des libellés que la Vague 4 a renommés (« Générer les keyframes » → « Générer les images des plans », « ✎ Prompt de l'action » → « ✎ Réécrire l'action », « Re-générer » → « Régénérer », « Auto-Enrich » → « Enrichissement auto »…) et les cartes d'objectif ont remplacé le sélecteur de scénario. Seuls les bancs de **graphes** (la matrice ci-dessus) font foi, parce qu'ils pilotent l'UI par identifiants de code et ne lisent que le réseau bouchonné ; en réécrire les sélecteurs si un id de DOM change.

### Bancs de la galerie (1.4.0)

Le service `gallery` et la galerie de `index.html` ont leurs propres bancs, **hors dépôt** comme ceux des vagues (ils dépendent de ports et de copies de travail locales), dans `~/.cache/ai-content-studio/`. Seul `python3 server.py --check` est dans le dépôt : autotests du service (clés, expressions régulières, chunks PNG, extraction, course du rescan, restauration en collision), sur un dossier et une base temporaires, sans port — `docker exec ai-content-studio-gallery python3 /server.py --check`.

**Règle : toute écriture (favori, tag, renommage, corbeille, restauration, fichiers ajoutés ou supprimés) se fait UNIQUEMENT sur un jeu factice, jamais sur le vrai `output/`.** Les bancs d'écriture bougent des fichiers ; chaque instance de test monte un dossier fabriqué par `make_fixture.py`, jamais `~/comfyui-spark/basedir/output`. Un contrôle sur la production se fait en lecture seule, comme `galerie-b3b/prod-check.js` (toute requête qui n'est pas un GET y est refusée par le banc lui-même).

| Fichier (sous `~/.cache/ai-content-studio/`) | Rôle |
|---|---|
| `gallery-fixture/make_fixture.py <dest> [--expected F] [--force]` | Fabrique le **jeu factice** : environ 300 petits PNG et 20 mp4 dont les métadonnées `prompt` reprennent 5 vrais graphes (copiés en lecture seule dans `graph_*.json` à côté du script, source ensuite), dates réparties sur 60 jours, cas hostiles (liens symboliques, `.trash`, noms étranges, fichiers abîmés). `expected.json` est calculé **ici** à partir de la liste générée, jamais en appelant le service. `--force` ne remplace `<dest>` que s'il porte le marqueur `.fixture-marker`. |
| `galerie-b1/bench-api.py` (copie adaptée dans `galerie-b2/`), `run-bench.sh host\|docker [dossier]` | Banc de la **lecture** (`/health /assets /asset /thumb /dates /facets`, indexation à la demande, rescan) puis, sur une instance redémarrée sur un dossier **vide**, la garde anti-vidage. 273 contrôles + 5 de garde. `host` lance `server.py` directement, `docker` l'image `ai-content-studio-gallery:test` construite avant. |
| `galerie-b2/bench-write.py` | Banc de l'**écriture** : favoris, tags, renommage, corbeille, restauration (dont collision `_restored`), échec à mi-chemin (dossier source non inscriptible : 500 et liste du déjà-fait, pas de doublon). 85 contrôles. |
| `galerie-b2/bench-hostile.py` | Banc **hostile** (C6) : chaque cas porte son code attendu **et** la preuve qu'aucun fichier n'a bougé (empreinte de tout l'arbre du jeu factice : chemins, types, tailles, mtimes, cibles de liens, sha256). 146 contrôles. |
| `galerie-b2/run-b2.sh <dossier de server.py>` | Une passe complète en image Docker, jeu factice neuf, instance sur 127.0.0.1:8972 en uid 1000 : `--check`, hostile, écriture. |
| `galerie-b1/run-mutations.sh`, `galerie-b2/run-mutations-b2.sh` | **Mutations** : chaque variante d'une copie de `server.py` (contrôle d'origine retiré, anti-lien retiré, plafond de 100 clés retiré, `os.link` remplacé par `os.replace`, verrou `story/relay` retiré, relecture du rescan retirée, `..` laissé passer) doit être **tuée** par le banc. 7 mutants en B2 (un mutant équivalent a survécu une fois et a été redéfini), 2 en B1 (anti-lien, garde anti-vidage). |
| `galerie-b3b/serve.py [port] [dossier] [port_service]` (copies dans `galerie-b3a/`) | Serveur de test de **même origine** : le dossier de la page en statique, plus un relais `/gallery/*` vers l'instance de test avec `Host`, `Origin`, `Referer`, `Sec-Fetch-Site` et `Content-Type` conservés (sans eux le contrôle de même origine du service refuse tout POST). `/comfy/*` et `/ollama/*` y sont minimaux (les bancs les bouchonnent côté page). |
| `galerie-b3b/svc.sh start\|stop` | Instance de test du service (image `ai-content-studio-gallery:test`, port 8974, `SCAN_INTERVAL=3`) sur un jeu factice **neuf à chaque `start`**. |
| `galerie-a/bench-gallery.js` | La page réelle, **source navigateur** (200 entrées d'ancien format dans le localStorage) : paquets de 60, recherche, filtres, favoris, sélection, suppression annulable. 49 contrôles ; témoin négatif (`GALLERY_PAGE = Infinity`) : 41/49. |
| `galerie-b3b/bench-service.js` | La page réelle contre l'instance de test via `serve.py` : démarrage et repli, filtres, périodes, groupes par date, favoris, migration, corbeille. 152 contrôles, rejoués dans trois fuseaux (`TZ=Europe/Paris`, Los Angeles, Kolkata). Les groupes par date sont recalculés **autrement** que par la page. |
| `galerie-b3b/bench-meta.js` | Lightbox à métadonnées, tags, renommage, sélection multiple, vue Corbeille. 134 contrôles ; `NGINX=1` : la page est servie par un vrai `nginx:alpine` avec le `nginx.conf` du dépôt (seuls les ports changent), pour vérifier les clés `.trash` à travers nginx. |
| `galerie-b3b/bench-couture.js`, `nginx-check.sh` | « Couture » : chaque champ de l'objet C1 rendu par le service est lu quelque part dans la page (19/19 champs affichés ou cités, aucun champ mort) ; sondes nginx. |

Tous les bancs de page reprennent la méthode des vagues (Chromium headless par CDP, profil vierge, `/comfy/prompt` bouchonné et compté, témoin positif) et ajoutent : zéro soumission sur tous les clics, audit i18n du DOM sans les `<script>` dans les 4 langues, et des témoins négatifs (variantes qui doivent échouer). Les sorties des chaînes complètes sont dans le dossier `out/` de chaque lot.

**Procédure.** Construire l'image de test depuis le dépôt (`docker build -t ai-content-studio-gallery:test docker/gallery`), lancer `svc.sh start` (ou `run-b2.sh`), jouer le banc, puis **supprimer** conteneur et image `:test` ; vérifier que le port de test (8971–8974) est libre avant et après (`ss -ltnH "sport = :8974"`). Un banc de page contre une version modifiée de `index.html` se joue sur une copie du dépôt (dossier `after/`), jamais en modifiant la page servie en production.

### Non-régression des prompts (ex-« Parité des prompts Studio / Canvas »)

```bash
node tools/parity-prompts.js              # ~2 s, node seul : ni navigateur, ni réseau, ni Docker
node tools/parity-prompts.js --verbose    # diff plus long autour du premier écart de chaque groupe (échec)
node tools/parity-prompts.js --index <index.html> --engine <engine.js>   # comparer d'autres copies (témoins négatifs)
node tools/parity-prompts.js --baseline-file <index.html de a6d65c0>     # hors dépôt git (sinon la référence est lue par `git show`)
```

Depuis la 1.4.1 les compilateurs de prompt n'existent plus qu'en **une** copie, `js/engine.js` ; le Studio n'en garde que des adaptateurs (`docs/ARCHITECTURE.md` § Code partagé). Le test n'est donc plus une parité entre deux copies mais une **non-régression à trois voies contre une référence figée** : **référence** = les fonctions de prompt du Studio d'*avant* la source unique, extraites de `git show a6d65c0:index.html` (lu en mémoire ; `--baseline-file` en repli) ; **Studio actuel** = les adaptateurs extraits d'`index.html`, exécutés avec `engine.js` chargé puis déstructuré dans le même contexte `vm` (comme dans la page) ; **Engine** = `engine.js` seul, dans un autre contexte. Les helpers d'état (`currentStyleId`/`currentSheetTemplateId` d'un côté, `currentStyleText`/`currentSheetLayout` de l'autre) sont extraits pour de vrai des deux côtés, avec les mêmes bouchons DOM (`director`, sélecteurs, pipeline, `addEvent`, gemma). Sur une matrice fixe, chaque cas est comparé **octet pour octet** trois fois : référence = Engine, référence = Studio actuel, Studio actuel = Engine. Une ligne `PASS/FAIL groupe n/n · octets` par groupe, puis `TOUT PASSE` ou le nombre d'échecs. **À la 1.4.1 : 158 294 contrôles · 179 groupes · 52 652 cas × 3 voies · `Object.keys(Engine).length` = 83 · violations réseau 0 · TOUT PASSE.** Inchangé à la 1.4.2 (88 clés) et à la 1.4.3 (90 clés : `QWEN_EDIT_INSTRUCTION_ENRICH_SYSTEM`, `SHEET_BRIEF_ENRICH_SYSTEM`) : mêmes 158 294 contrôles, TOUT PASSE. Code de sortie : `0` tout passe, `1` écart ou appel réseau imprévu, `2` test inutilisable (fichier illisible, référence git introuvable, nom absent d'`index.html` ou d'`Engine`, bloc extrait qui ne s'exécute plus : jamais un « 0 contrôle, PASS »). **L'historique git doit rester disponible** : sans le commit `a6d65c0` (clone superficiel, historique réécrit), le test s'arrête en code 2 ; fournir alors l'`index.html` de ce commit avec `--baseline-file`.

**Ce que prouve cette référence** : la source unique est une extraction sans diff observable (au lot qui l'a faite : 158 296 contrôles, 52 653 cas, aucun écart avec la copie supprimée) ; tout changement ultérieur d'un compilateur la fait échouer **là où le texte a bougé**. Un changement de texte voulu se documente (exception comme `KREA2_ENRICH_SYSTEM` ci-dessous) ou se reporte dans le test ; il ne s'assouplit pas.

**Couvert** : `STYLE_PACKS` (14), `CAMERA_LIB`, `LIGHTING_LIB`, `SHEET_CLEAN`, gabarits de planche (`SHEET_TEMPLATES` : les 5 + `auto`, humain/autre, tous les styles), planche décor, `stripPromptPadding` (une entrée par terme de `PROMPT_PADDING`), fiches (`charDescFromFields`, `locDescFromFields`, `charKindOf`), keyframes à 1 et 2 sujets (avec ou sans `locDesc`), `compileCutPrompt`, cuts LTX 2.5 et H3 (`compileCutPromptFor`, `buildH3CutPrompt`, `h3CutSubjects`, `h3CutBodyText`), grammaire Ref2VA (`h3AssignSubjects`, `h3Summary`, `h3RefBody`, `buildH3RefPrompt`, `capH3Prompt` et son plafond de 7 000 caractères à la frontière exacte, `h3Alignment`, `h3VideoFrames`, `h3RealDuration`), cuts r2v du Canvas, carte Vidéo H3, `KEYFRAME_ANCHOR_*`, les adaptateurs d'état (style depuis `director.style`, le sélecteur ou un pipeline sans contrôle `style` → `none` ; gabarit depuis l'argument, `director.sheetTemplate`, le sélecteur ou `auto`), `KREA2_ENRICH_SYSTEM` (seule exception de texte admise : la clé de sortie `{"prompt"}` d'Engine au lieu de `{"positive_prompt"}` de la référence, voulue au lot qui a unifié Krea 2), et les trois fonctions gemma (`characterSheetFromBrief` avec `forceKind`, `locationSheetFromBrief`, `shotListFromBrief` : réponses rejouées, consigne et brief envoyés comparés, journal compris ; les alias caméra/lumière, `normalizeShotList` et `fallbackShots` par ce biais). Cas limites : champs vides ou non textuels, unicode, textes très longs, sujet sans description, plafond de 2 sujets par plan.

**Non couvert** : les fonctions d'orchestration réseau (`submit*Job`, `waitForJobs`, `directorStep*`, `generate*`, `runRelay`), les graphes eux-mêmes (voir la matrice de graphes ci-dessus), l'UI, les textes de journal hors des trois fonctions gemma, les consignes d'enrichissement propres au Studio (`ENRICH_SYSTEM`, `SHEET_DESC_ENRICH_SYSTEM`, `QWEN_EDIT_ENRICH_SYSTEM`, `SHOT_ACTION_ENRICH_SYSTEM`, `CUT_ENRICH_SYSTEM`, `H3_SCENARIO_SYSTEM` : pas d'équivalent dans `Engine` ; leur routage est vérifié par `tools/prompt-systems.js`) et les helpers Studio sans équivalent (`HOLD_MOTION`, `shotSubjects`/`shotCharDesc`, exercés seulement comme entrées de la comparaison). Il ne prouve pas que le texte est *bon*, seulement qu'il n'a pas bougé ; l'extraction suppose le formatage actuel d'`index.html` (indentation régulière).

**Une seule différence de flux voulue : `forceKind`.** Le Studio et le Canvas n'ont pas le même flux pour imposer le type de sujet, et le test le garde comme une différence *documentée*, jamais comme une parité (groupes `DIFFÉRENCE DE FLUX VOULUE — forceKind, deux jeux remplis`). Studio : gemma décide du type SANS consigne, puis la bascule « Type de sujet » (`#charKindToggle`, le vrai gestionnaire de clic, extrait d'`index.html` et exécuté par le test) reverse le texte déjà décrit dans le 1er champ du jeu imposé : l'identité du sujet est préservée, aucun nouvel appel gemma. Le Studio n'appelle donc jamais `forceKind`. Canvas : `Engine.characterSheetFromBrief(scene, cb, forceKind)` appelle gemma AVEC la consigne « kind is force, fill only the force field set » ; son jeu imposé décrit donc le bon sujet et se lit directement. Quand gemma remplit les DEUX jeux (par exemple `face`/`hair` ET `subject`), les deux flux donnent des descriptions différentes (`lined face, p` côté Studio, `a lion, p` côté Engine pour un type imposé « autre ») : ce n'est pas un défaut, l'entrée n'a de sens que dans le Canvas. Le test vérifie chaque flux contre SA spécification, dans les deux sens : (a) l'Engine lit le jeu imposé tel quel ; (b) Studio + bascule reverse toujours le texte du type décidé ; (c) les deux flux diffèrent si et seulement si le type décidé n'est pas le type imposé. Il échoue si l'un des deux comportements change (témoins négatifs : Engine qui ne lit plus le jeu imposé, Studio qui ne reverse plus). **À conserver** : une modification de ce flux doit remplacer ce groupe en connaissance de cause.

**Ajouter un cas** : une entrée dans la matrice concernée du script (`FIELDS`, `SHOTS`, `SUBJ`, `R2V`, `GEMMA17`, `PAD_TERMS`…) et, si besoin, un appel `same(groupe, valeurStudio, valeurEngine, libelléDeLEntrée)` (comparé aux trois voies). **Ajouter un nom** : le lister dans `REF_NAMES` (référence, `index.html` de `a6d65c0`), `CUR_NAMES` (adaptateurs et helpers d'`index.html` actuel) et/ou `ENGINE_NAMES` (clé de `Engine`), puis écrire la comparaison ; un nom listé et absent arrête le test avec un message explicite. Un terme ajouté à `PROMPT_PADDING` sans être ajouté à `PAD_TERMS` fait échouer le test (décompte des alternatives).

**Quand le lancer** : après toute modification d'un compilateur ou d'une constante de prompt, **dans `js/engine.js`** (jamais dans une copie : il n'y en a plus), ou d'un adaptateur d'`index.html`, dans le même lot. Un écart est un vrai changement de sortie : ne pas assouplir le test, corriger, ou, si le changement est voulu, l'écrire ici comme exception.

**Témoin de source unique** (fait à la livraison de la 1.4.1, rejoué pour cette documentation). Cinq copies d'`engine.js`, hors dépôt, avec un seul caractère ou mot changé dans un prompt (un caractère de `KEYFRAME_ANCHOR_SOLO` ; un mot de `SHEET_TEMPLATES.turnaround` ; la `note` de `H3_SUBJECT_KINDS.character` ; un terme retiré de `PROMPT_PADDING` ; un caractère de la consigne personnage de `characterSheetFromBrief`), passées par `--engine`, doivent faire échouer **uniquement** des groupes « référence = … » (10, 9, 16, 2 et 6 groupes en échec) et **aucun** groupe « Studio actuel = Engine » : le Studio lit bien la même source que l'Engine, et seule la référence figée voit le changement. Trois copies d'`index.html` dont un adaptateur est cassé (style `none` remplacé par `cinematic` ; décor omis qui ne se rabat plus sur `director.locDesc` ; gabarit qui ne lit plus `director.sheetTemplate`) font échouer des groupes « Studio actuel = Engine » (4, 1 et 3 groupes) en plus de la référence (8, 2 et 5 groupes en échec au total).

### Consigne gemma selon le modèle (`tools/prompt-systems.js`)

```bash
node tools/prompt-systems.js                    # 36 scénarios, puis les mutants M1 à M12 (≈ 5 min)
node tools/prompt-systems.js --no-mutants       # sans témoins négatifs
node tools/prompt-systems.js "S-H"              # filtre : regex d'identifiants de scénario (sans mutants) ; "^C-" = tout le Canvas
node tools/prompt-systems.js --show             # détaille les consignes et les textes de graphe reçus
node tools/prompt-systems.js --dump out.json    # enregistre, par scénario, appels gemma (consigne, sha256, contenu), graphes, journal
node tools/prompt-systems.js --root <arbre>     # un autre arbre que le dépôt (comparer avant/après un changement)
```

**Prérequis** : Node 22 (`fetch` et `WebSocket` globaux) et `chrome-headless-shell` de Playwright, cherché dans `$CHROME`, puis `~/.cache/ms-playwright/chromium_headless_shell-*`, puis `/opt/pw-browsers/` ; absent → sortie `2` (jamais un faux vert). Aucun port à réserver, aucun fichier à copier, aucun conteneur : serveur statique Node sur un port tiré au sort qui sert `--root` (le dépôt par défaut, sans copie), Chrome avec `--remote-debugging-port=0`, profil `mktemp` supprimé à la fin. C'est l'exception à la règle « bancs hors dépôt ».

**Ce que ça fait.** Pour chaque modèle (Krea 2, LTX 2.5, Minimax H3, Qwen) et chaque chemin d'enrichissement (bouton ✨ manuel, enrichissement auto, « Générer », cuts et relay du storyboard, cartes du Canvas), le test pilote la **vraie page** (`index.html` puis `canvas.html`, `js/*.js` compris), ComfyUI, Ollama et la WebSocket bouchonnés, en cliquant les vrais boutons, puis contrôle :
- chaque corps `/ollama/api/chat` : `model === "gemma4:e4b"`, nombre d'appels attendu (**0 pour LTX 2.5**), et la consigne système correspond à **exactement une** empreinte sha256 de la table figée (bloc `FP-BEGIN`…`FP-END` de l'outil, 27 empreintes) et c'est la bonne ; les messages disent « reçoit la consigne X au lieu de Y », « consigne inconnue » ou « aucune consigne » ; le contenu utilisateur est celui attendu (style en `PRIMARY_STYLE`, `<Subject N>` substitués par `SUBJECTREFn` avant l'appel, `<imageN>` par `Q21IMAGEREFn`) ;
- chaque corps `/comfy/prompt` respecte la grammaire du modèle : Krea 2 (`CLIPTextEncode`, `KSampler.negative` ← `ConditioningZeroOut`, aucun terme de remplissage, style en fin) ; LTX 2.5 (`TextGenerateLTX2Prompt` `use_default_template: true`, prose sans `subject_definitions` ni `<Subject`, 24 fps) ; H3 i2v (texte qui commence par `h3Alignment(…)`, ≤ 7 000 caractères) ; H3 cuts et r2v (6 champs dans l'ordre, `<Picture N>` seulement dans `subject_definitions`, jetons bien formés) ; keyframes (ancrage SOLO ou DUAL une seule fois) ;
- toute requête `/comfy` ou `/ollama` qui **atteint le serveur statique** (donc échappe aux bouchons) fait échouer le test ; seul `GET /comfy/view` des `<img>`/`<video>` est toléré (404).

**Routage vérifié** (Studio ; le Canvas aboutit aux mêmes textes) :

| Chemin | Consigne reçue par gemma |
|---|---|
| Krea 2 (`krea2_t2i`, `campaign_full`), ✨ ou auto | `KREA2_ENRICH_SYSTEM` (`{"prompt"}`) |
| LTX 2.5 t2v/i2v, `flf2v_chain`, ✨ ou auto | aucune (0 appel, ligne SYS « construit ses propres prompts ») |
| Minimax H3 t2v/i2v | `H3_VIDEO_ENRICH_SYSTEM`, puis `h3Alignment` en tête du texte (i2v) |
| Minimax H3 r2v ✨ (Studio et carte r2v du Canvas) | `R2V_BRIEF_ENRICH_SYSTEM`, jetons `<Subject N>` substitués puis rétablis ; au Canvas, sortie sans jeton cité → champ intact + erreur sous le bouton (C-H2) ; au Studio, brief intact + WARN et **aucun** `OK « Brief enrichi »` (S-H3, v1.4.4) |
| Qwen-Edit 2509 en `image2image` (`qwen_edit_i2i`), ✨ (S-Q3) | `QWEN_EDIT_INSTRUCTION_ENRICH_SYSTEM` (`{"instruction"}`, = `ENHANCE.qwenInstruction`) ; le négatif de l'utilisateur n'est pas réécrit |
| Brief d'un storyboard (`storyboard_v2` et `storyboard_v2_qwen21`), ✨ manuel (S-SB7) | `SHEET_BRIEF_ENRICH_SYSTEM` (`{"brief"}`, = `ENHANCE.sheetBrief`) ; brief envoyé tel quel, négatif intact, 0 job |
| Keyframes ✨ (S-SB3) | `QWEN_EDIT_ENRICH_SYSTEM(n)` en moteur 2509 (texte d'origine, empreintes inchangées) ; en moteur Qwen Image 2.1 le même texte avec « Qwen Image 2.1 » à la place de « Qwen-Image-Edit-2509 » (2 occurrences, empreintes propres) |
| Fiches, plans, planches ✨, action ✨, cuts et relay ✨, composeur H3 | `CHARACTER_/LOCATION_/SHOTLIST_SYSTEM`, `SHEET_DESC_…(kind)`, `SHOT_ACTION_…`, `CUT_ENRICH_…(moteur)`, `H3_SCENARIO_SYSTEM`, `REF_VISION_SYSTEM` |
| Qwen Image 2.1 t2i et i2i (témoins « non affectés ») | `ENRICH_SYSTEM` générique (`<imageN>` protégés en i2i ; sortie sans `<imageN>` cité → brief intact + WARN, aucun `OK « Brief enrichi »`, **négatif de l'utilisateur intact** ; enrichissement accepté → le négatif est celui de gemma, S-Q2 ; t2i, sortie JSON sans la clé attendue → un seul WARN « Enrichissement ignoré », brief et négatif intacts, aucun `OK`, 0 job, S-Q4) |

**Égalités entre pages** : le texte reçu par S-K1 = C-K1 (Krea 2), S-H1 = S-H2 = C-H1 (H3 vidéo), S-H3 = C-H2 (r2v), S-Q3 = C-Q2 (Qwen-Edit), S-SB7 = C-SB1 = C-SB2 (brief de storyboard), à l'octet près.

**Mutants (témoins négatifs).** Douze copies modifiées à la volée par le serveur statique (la cible doit apparaître exactement une fois), chacune devant faire échouer **un contrôle qui ne l'était pas** : M1 `KREA2_ENRICH_SYSTEM` et `H3_VIDEO_ENRICH_SYSTEM` échangés dans `engine.js` ; M2 la route H3 de `briefEnrichSystem` renvoie `ENRICH_SYSTEM` ; M3 `h3Alignment` retiré de `VideoNode` (`js/nodes-simple.js`) ; M4 `h3TokensOut` retiré de l'enrichissement r2v (`enrichBrief`) ; M5 `ENHANCE.videoPrompt` du Canvas remplacé par `krea2Prompt` ; M6 `h3TokensOut` retiré de l'enrichissement r2v du Canvas (`addEnhanceButton`, vu par C-H2) ; M7 la route `qwen_edit_i2i` de `briefEnrichSystem` retombe sur `ENRICH_SYSTEM` (vu par S-Q3) ; M8 la route `storyboard_v2*` retombe sur `ENRICH_SYSTEM` (vu par S-SB7) ; M9 `keyframeModelName` renvoie toujours le nom 2509 (le moteur 2.1 reçoit le texte 2509, vu par S-SB3) ; M10 l'événement `OK « Brief enrichi par … »` d'`enrichBrief` émis sans sa condition `applied`, donc aussi après un WARN d'écartement (vu par S-H3 et S-Q2) ; M11 le négatif de gemma écrit même après un écartement, condition `applied` retirée de `enrichBrief` (vu par S-Q2) ; M12 la branche « clé attendue absente » (WARN « Enrichissement ignoré ») retirée de `enrichBrief` (vu par S-Q4). Un mutant dont la cible a disparu s'affiche « cible absente : non compté » : après un renommage, adapter `MUTANTS`.

**Résultat à la 1.4.1** : `329 contrôles · 34 scénarios · tout vert`, mutants M1 à M5 tués, sortie 0 (24 scénarios Studio, 10 Canvas ; 2 min 42 s en entier sur cette machine). Une seule NOTE s'affichait, voulue : la carte r2v du Canvas envoyait les `<Subject N>` bruts à gemma (hors périmètre) — close en 1.4.2, voir ci-dessous. **Sur le Studio de la 1.4.0 (`a6d65c0`)**, le même test donnait 5 scénarios rouges, un par défaut de routage : S-H1 et S-H2 (Minimax H3 t2v/i2v recevait la consigne générique, qui réécrit un négatif que le gabarit H3 n'encode pas), S-H3 (r2v ✨ : consigne générique, jetons `<Subject N>` bruts chez gemma), S-L3 (LTX 2.5 ✨ : deux appels gemma, brief et négatif réécrits avant l'enhancer du graphe), S-L4 (`flf2v_chain` en auto : même cause, `enrich: builtin` manquait au manifest).

**Résultat à la 1.4.2** : `338 contrôles · 34 scénarios · tout vert`, mutants M1 à M6 tués, sortie 0 ; plus aucune NOTE. C-H2 (carte r2v du Canvas) passe de 11 à 20 contrôles : (1) le contenu utilisateur reçu par gemma contient `SUBJECTREF1`/`SUBJECTREF2` et aucun `<Subject` ; (2) la propriété ET le champ du panneau retrouvent `<Subject 1>`/`<Subject 2>` sans `SUBJECTREF` ; (3) avec un bouchon gemma qui renvoie une sortie SANS les jetons (`window.__cfg.dropTokens`), propriété et champ restent inchangés et « Enrichissement impossible : … » s'affiche sous le bouton ; (4) l'empreinte de la consigne reste celle de `R2V_BRIEF`. Sur l'arbre de la 1.4.1, C-H2 est rouge (14/20, les 6 contrôles ci-dessus) et tous les autres scénarios restent verts. Le comportement d'un brief SANS jeton et celui des quatre langues du message sont prouvés par un banc hors dépôt (envoi à gemma octet pour octet identique à la 1.4.1 ; sortie non normalisée).

**Résultat à la 1.4.3** : `364 contrôles · 35 scénarios · tout vert`, mutants M1 à M9 tués, sortie 0. Nouveau scénario S-SB7 (✨ du brief de `storyboard_v2` puis `storyboard_v2_qwen21` : 2 appels `SHEET_BRIEF`, brief reçu tel quel, clé `{"brief"}` écrite, négatif intact, 0 job, empreinte = C-SB1 = C-SB2) ; S-Q3 passe de `ENRICH_SYSTEM` à `QWEN_EDIT_INSTRUCTION` (empreinte = C-Q2, négatif intact, 0 job) ; S-SB3 contrôle désormais quatre empreintes (2509 à 1 et 2 sujets : inchangées ; 2.1 à 1 et 2 sujets : nouvelles) et que le moteur nommé est le bon et lui seul (2 occurrences chacun, 2.1 = 2509 au seul nom près). **Sur l'arbre de la 1.4.2 (`before/`), le même outil est rouge sur exactement S-SB3, S-SB7 et S-Q3** (les 32 autres verts). Un dump (`--dump`) avant/après donne des appels gemma, graphes, événements et sorties identiques (consigne par sha256, contenu utilisateur) pour les 32 autres scénarios, **dont les 10 du Canvas**. Hors outil : les empreintes de `ENHANCE.qwenInstruction` (`c1a42130…`) et `ENHANCE.sheetBrief` (`a3799383…`) n'ont pas bougé, le déplacement dans `js/engine.js` est donc verbatim.

**Résultat à la 1.4.4** : `378 contrôles · 35 scénarios · tout vert`, mutants **M1 à M10** tués, sortie 0. L'empreinte de `R2V_BRIEF` passe de `c34e55f2…` à **`207c517f…`** (consigne qui nomme et autorise les substituts SUBJECTREFn, LESSONS piège n°35) ; l'ancienne reste dans la table sous `R2V_BRIEF [avant v1.4.4]` pour nommer le rouge d'un arbre antérieur (27 empreintes) ; S-H3 = C-H2 à l'octet. S-H3 (16 contrôles) et S-Q2 (14) jouent un second ✨ avec un bouchon qui « oublie » les jetons (`__cfg.dropTokens`) : brief inchangé, WARN « Enrichissement écarté », **aucun** `OK « Brief enrichi par … »` ; après l'enrichissement accepté, exactement un. **M10** (l'événement OK sans sa condition `applied`) est tué par les deux. Sur l'arbre de la 1.4.3, le même outil est rouge sur exactement S-H3, S-Q2 et C-H2.

**Résultat à la 1.4.5** : `390 contrôles · 36 scénarios · tout vert`, mutants **M1 à M12** tués, sortie 0. Aucune empreinte de consigne ne change (27). S-Q2 passe de 14 à 16 contrôles : après l'écartement (bouchon qui « oublie » les `<imageN>`) le négatif de l'utilisateur est INTACT (le bouchon renvoie `negative_prompt: "blurry"`, différent du « low quality » de l'utilisateur, sinon le contrôle ne prouverait rien) ; après l'enrichissement accepté, le négatif est bien celui de gemma (consigne générique). **S-Q4** (nouveau, 10 contrôles : Qwen Image 2.1 t2i, le bouchon répond un JSON valide sans la clé attendue, `__cfg.noKey`) : une seule requête gemma, exactement 1 WARN « Enrichissement ignoré : la réponse de gemma ne contient pas le champ attendu », aucun `OK « Brief enrichi »`, brief et négatif intacts, 0 job. **M11** (négatif écrit même après un écartement, condition `applied` retirée) est tué par S-Q2 ; **M12** (branche « clé absente » retirée) par S-Q4. Sur l'arbre de la 1.4.4 (HEAD `7c60720`), le même outil est rouge sur exactement ces trois contrôles (S-Q2 : négatif écrasé ; S-Q4 : pas de WARN, négatif écrasé), les 34 autres scénarios verts ; dump avant/après : 34 scénarios identiques, S-Q2 et S-Q4 diffèrent seulement par ce négatif et ce WARN.

**Conservation des substituts par le VRAI gemma4:e4b (1.4.4, banc hors dépôt `~/.cache/ai-content-studio/fixrendus/gemma/measure.js`).** Le bouchon du test recopie toujours les jetons : seul le vrai modèle montre qu'une consigne les fait perdre. Appels directs à Ollama avec le corps exact de `gemmaJSON` (`gemma4:e4b`, `stream:false`, `format:"json"`, `think:false`, aucune option), contenu `h3TokensOut(brief)`, critère des deux pages (chaque `<Subject n>` cité présent après `h3NormalizeTokens(h3TokensIn(…))`), 20 briefs à 1 ou 2 substituts : consigne de la 1.4.3 **12/20** ; consigne de la 1.4.4 **40/40** (2 passages) ; 8 briefs sans substitut : anglais, aucun personnage, lieu, négatif ni jeton inventé. Par les vraies pages (copie servie avec `/ollama` vers le vrai gemma, `/comfy/` jamais relayé, 0 POST `/comfy/prompt`) : Studio **6/6**, Canvas **6/6** acceptés (rendu réel de la 1.4.3 : 1/7). Revers : gemma réécrit peu (10/40 ; 0/12 par les pages) ; deux variantes qui demandent d'« enrichir » conservent 20/20 mais inventent un `SUBJECTREF1` sur 6 à 7 briefs sans jeton sur 8 (non retenues, `TOUR-DE-CONTROLE-CHANGELOG.md` v1.4.4).

**Si une consigne change** (texte ou route) : le scénario qui la porte échoue (« consigne inconnue »). Si le changement est voulu, régénérer l'empreinte (bloc `FP`) et la SPEC dans le **même commit** ; ne jamais retirer le contrôle. **Limites** : ce test prouve *quelle* consigne gemma reçoit et *quelle* grammaire part à ComfyUI, pas que le rendu est meilleur. Le rendu réel réduit de Minimax H3 avec la nouvelle consigne (`H3_VIDEO_ENRICH_SYSTEM`, `R2V_BRIEF_ENRICH_SYSTEM`) reste à faire sur le GB10 (§ 6, point 4).

Syntaxe JS : `node --check` sur le script extrait d'`index.html` (et sur chaque `js/*.js`), après CHAQUE modification.

```bash
python3 -c "
import re,io
s=io.open('index.html',encoding='utf-8').read()
io.open('/tmp/app.js','w',encoding='utf-8').write(re.search(r'<script>(.*?)</script>', s, re.S).group(1))
" && node --check /tmp/app.js
```

Contrôle utile après tout rebase ou toute fusion touchant `I18N` : deux branches peuvent ajouter la
**même clé** sans que git signale quoi que ce soit, la seconde écrasant la première en silence.

```bash
python3 -c "
import re,io,collections
s=io.open('index.html',encoding='utf-8').read(); i=s.index('const I18N')
block=s[i:s.index(chr(10)+'    };', i)]
keys=re.findall(r'^\s{6}"((?:[^"\\\\]|\\\\.)*)":', block, re.M)
print([k for k,n in collections.Counter(keys).items() if n>1])"
```

Enfin, une formulation marquée « qualifiée en rendu » (le chemin de keyframe à un sujet, `turnaround`
+ sujet humain) ne se modifie pas sans un nouveau rendu réel : la vérifier **au caractère près** par
comparaison programmatique avec `main`, jamais à l'œil.

## 4. Inspecter le CONTENU des rendus

**Frames d'une vidéo** (pas de ffmpeg requis — ComfyUI fait tout) : copier le mp4 dans `~/comfyui-spark/basedir/input/` puis soumettre :
`LoadVideo → GetVideoComponents` → `ImageFromBatch(batch_index=k, length=1)` → `SaveImage` — puis regarder les PNG (première/dernière frame de chaque segment vs images attendues).

**Piste audio** : même chemin, `GetVideoComponents` slot 1 → `SaveAudioMP3(quality:"V0")` — un mp3 > 5 Ko ≈ 1 s confirme une piste réelle (le silence pèse bien moins).

**Raccourci quand `ffprobe`/`ffmpeg` sont installés** (vérifier `which ffprobe ffmpeg` — présents sur ce GB10) et que le fichier est accessible directement en filesystem (`output/studio/...`) : plus rapide que le graphe ComfyUI pour les métriques et frames ponctuelles.
- Nombre de frames réel + dimensions : `ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames,r_frame_rate,duration,width,height -of default=noprint_wrappers=1 <fichier.mp4>` — utile pour vérifier qu'un total (ex. animatic = somme des cuts) correspond aux frames **réellement rendues**, pas à la valeur brute calculée dans le graphe (cf. LESSONS : arrondi silencieux au 8n+1).
- Piste audio (codec/débit/continuité) : `ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels,duration,bit_rate -of default=noprint_wrappers=1 <fichier.mp4>` et `ffmpeg -i <fichier.mp4> -af silencedetect=noise=-40dB:d=0.3 -f null -` (aucune ligne `silence_start` = piste continue, notamment aux coupes d'un assemblage en cuts francs).
- Frame ponctuelle : `ffmpeg -y -i <fichier.mp4> -vf "select=eq(n\,<index>)" -vframes 1 <sortie.png>`.

## 5. Vérifier l'UI (headless Chromium)

Binaire Playwright : `/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell` en session
distante, `~/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell` sur un poste où
Playwright a déjà tourné.

```bash
CH=~/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell
$CH --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=1440,2400 --virtual-time-budget=8000 \
    --screenshot=/tmp/shot.png http://localhost:8090
$CH --headless ... --dump-dom http://localhost:8090 | grep pipelineSelect   # inspecter le DOM rendu
```

Largeurs à couvrir : 390 / 768 / 1250 / 1440. Pour capturer un état localStorage (ex. thème sombre) : créer une page helper même origine `setdark.html` contenant `<script>localStorage.setItem("theme","dark");location.replace("/")</script>`, capturer via son URL, puis la supprimer.

## 6. Check-list avant livraison d'une modification de génération

1. `node --check` du JS extrait, et contrôle des clés `I18N` dupliquées.
2. Modèles référencés présents sur disque.
3. Banc headless (§3) : assertions sur les prompts compilés ET sur les graphes réellement soumis ; `node tools/parity-prompts.js` pour toute retouche d'un compilateur de prompt (`js/engine.js`) et `node tools/prompt-systems.js` pour toute retouche d'une consigne gemma, de son routage ou du champ `enrich` du manifest ; pour tout changement d'UI, matrice de graphes identique octet pour octet et zéro job sur simple interaction.
4. Rendu réel réduit **réussi** via les fonctions exactes de la page — impossible hors du GB10, donc
   à demander à l'utilisateur, en disant clairement ce qui est vérifié et ce qui ne l'est pas.
5. Frames inspectées (et mp3 extrait si audio).
6. Pour l'UI : capture clair + sombre à 2 largeurs minimum.
7. Toute formulation « qualifiée en rendu » touchée = nouveau rendu réel exigé, sinon ne pas y toucher.
8. `Ctrl+Shift+R` côté utilisateur après déploiement (le HTML peut être en cache navigateur).
