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

- **Matrice de graphes = l'étalon « graphes soumis identiques octet pour octet ».** Un scénario pilote l'UI (les 11 workflows du manifest et leurs variantes : LoRA, turbo 4/6/8/off, FL2VA, marchés, références r2v, bypass des fiches, keyframes à 1 et 2 sujets sur les deux moteurs, cuts LTX 2.5 et H3 avec tenue, relay 1 s / 2 s, annulation, vision gemma…) et enregistre ce que le réseau bouchonné a reçu : corps `POST /comfy/prompt` (`client_id` retiré, mais vérifié égal à celui du Studio), uploads (nom, `overwrite`, taille, type), corps `/ollama/api/chat`, WARN du journal. Avant/après doivent être **identiques au caractère près**. État de référence à HEAD : **37 scénarios · 112 corps `/prompt` (407 243 o) · 219 uploads · 17 corps ollama (15 103 o)**. Toute retouche d'UI, d'i18n ou de mise en page (Vagues 3 et 4) a été rendue à cette matrice ; une retouche de prompt ou d'`engine.js` doit la faire bouger **seulement là où c'est voulu**, et le dire.
- **Zéro job sur simple interaction.** Chaque banc d'UI clique (cartes d'objectif, pipelines, langues, thème, feuilles du Canvas, ⤢, onglets, annuler, sélecteur « Type de sujet »…) avec `/comfy/prompt` bouchonné en compteur et exige **0 soumission** (règle d'AGENTS.md : rien ne part sans un clic sur un bouton de génération). Un témoin positif (un clic « Générer » = 1 prompt) prouve que le compteur compte.
- **Preuves i18n sur le DOM après retrait des `<script>`.** Les chaînes françaises du code vivent aussi dans les balises `<script>` : un scan du texte de la page en allemand y trouverait tout le français du JS. Le banc dumpe le DOM, **retire les `<script>`** puis cherche le français restant (nœuds texte, `placeholder`, `title`, `aria-label`) dans chacune des 4 langues, hors journal d'événements. Vide attendu.
- **Mesures d'UI** (aucun chevauchement, cibles ≥ 44 px sous 768 px, contraste ≥ 4,5:1 mesuré sur le fond réel, focus clavier, zéro écriture DOM au repos pour le Canvas) : par CDP, de 320 à 1440 px de large, en clair et en sombre.

**Où vivent ces bancs.** Hors dépôt, dans `~/.cache/ai-content-studio/` (un dossier par vague et par lot : `vague2/…`, `vague3/3a…3d`, `vague4/4a…4c`, `i13/…` ; le pilote CDP est `cdp.js`, les bouchons `stubs-2e.js`, la matrice `bench-graphs.js` dans les dossiers de lot). Ils **ne sont pas dans le dépôt** et ne doivent pas y être ajoutés : ils dépendent de ports et de copies de travail locales. Cette page décrit la méthode ; le dépôt ne contient **aucun test automatisé de parité** entre le Studio et l'engine (voir `docs/ARCHITECTURE.md` § Code partagé).

**Rejouabilité.** Les bancs des vagues antérieures ne sont **pas rejouables tels quels** : leurs assertions lisent des libellés que la Vague 4 a renommés (« Générer les keyframes » → « Générer les images des plans », « ✎ Prompt de l'action » → « ✎ Réécrire l'action », « Re-générer » → « Régénérer », « Auto-Enrich » → « Enrichissement auto »…) et les cartes d'objectif ont remplacé le sélecteur de scénario. Seuls les bancs de **graphes** (la matrice ci-dessus) font foi, parce qu'ils pilotent l'UI par identifiants de code et ne lisent que le réseau bouchonné ; en réécrire les sélecteurs si un id de DOM change.

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
3. Banc headless (§3) : assertions sur les prompts compilés ET sur les graphes réellement soumis ; pour tout changement d'UI, matrice de graphes identique octet pour octet et zéro job sur simple interaction.
4. Rendu réel réduit **réussi** via les fonctions exactes de la page — impossible hors du GB10, donc
   à demander à l'utilisateur, en disant clairement ce qui est vérifié et ce qui ne l'est pas.
5. Frames inspectées (et mp3 extrait si audio).
6. Pour l'UI : capture clair + sombre à 2 largeurs minimum.
7. Toute formulation « qualifiée en rendu » touchée = nouveau rendu réel exigé, sinon ne pas y toucher.
8. `Ctrl+Shift+R` côté utilisateur après déploiement (le HTML peut être en cache navigateur).
