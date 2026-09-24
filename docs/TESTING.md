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
`stub.js` **avant** le `<script>` inline et un `drive.js` après `</body>`, servir le tout avec
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

Syntaxe JS : `node --check` sur le script extrait d'`index.html`, après CHAQUE modification.

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
3. Banc headless (§3) : assertions sur les prompts compilés ET sur les graphes réellement soumis.
4. Rendu réel réduit **réussi** via les fonctions exactes de la page — impossible hors du GB10, donc
   à demander à l'utilisateur, en disant clairement ce qui est vérifié et ce qui ne l'est pas.
5. Frames inspectées (et mp3 extrait si audio).
6. Pour l'UI : capture clair + sombre à 2 largeurs minimum.
7. Toute formulation « qualifiée en rendu » touchée = nouveau rendu réel exigé, sinon ne pas y toucher.
8. `Ctrl+Shift+R` côté utilisateur après déploiement (le HTML peut être en cache navigateur).
