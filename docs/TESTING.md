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

## 3. Tester les fonctions JS de la page telles quelles (sans navigateur)

Node ≥18 a `fetch`. Extraire le bloc de builders depuis `index.html` et l'exécuter avec des shims :

```js
import { readFileSync } from "fs";
const html = readFileSync("index.html", "utf8");
const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
const block = js.match(/(\/\/ ── Audio LTX 2\.3[\s\S]*?)\n\s*async function submitGraph/)[1];
const bg = js.match(/(function buildGraph\(raw, p\) \{[\s\S]*?\n    \})/)[1];
const shims = `const OLLAMA="http://localhost:11434", OLLAMA_MODEL="gemma4:e4b";
  const brief={value:"…scène…"}; const addEvent=(c,t)=>console.log(c,t);
  const getTemplate=async f=>readFileSync("workflows/"+f,"utf8");`;
const fns = new Function("readFileSync", shims + bg + block +
  "; return {buildStoryboardFullGraph, buildCampaignFullGraph, buildFLF2VGraph, applyLtxAudio, shotPromptsFromBrief};")(readFileSync);
// … construire un graphe, POST /prompt, poller /history
```

Syntaxe JS : `node --check` sur le script extrait, après CHAQUE modification d'index.html.

## 4. Inspecter le CONTENU des rendus

**Frames d'une vidéo** (pas de ffmpeg requis — ComfyUI fait tout) : copier le mp4 dans `~/comfyui-spark/basedir/input/` puis soumettre :
`LoadVideo → GetVideoComponents` → `ImageFromBatch(batch_index=k, length=1)` → `SaveImage` — puis regarder les PNG (première/dernière frame de chaque segment vs images attendues).

**Piste audio** : même chemin, `GetVideoComponents` slot 1 → `SaveAudioMP3(quality:"V0")` — un mp3 > 5 Ko ≈ 1 s confirme une piste réelle (le silence pèse bien moins).

**Raccourci quand `ffprobe`/`ffmpeg` sont installés** (vérifier `which ffprobe ffmpeg` — présents sur ce GB10) et que le fichier est accessible directement en filesystem (`output/studio/...`) : plus rapide que le graphe ComfyUI pour les métriques et frames ponctuelles.
- Nombre de frames réel + dimensions : `ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames,r_frame_rate,duration,width,height -of default=noprint_wrappers=1 <fichier.mp4>` — utile pour vérifier qu'un total (ex. animatic = somme des cuts) correspond aux frames **réellement rendues**, pas à la valeur brute calculée dans le graphe (cf. LESSONS : arrondi silencieux au 8n+1).
- Piste audio (codec/débit/continuité) : `ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels,duration,bit_rate -of default=noprint_wrappers=1 <fichier.mp4>` et `ffmpeg -i <fichier.mp4> -af silencedetect=noise=-40dB:d=0.3 -f null -` (aucune ligne `silence_start` = piste continue, notamment aux coupes d'un assemblage en cuts francs).
- Frame ponctuelle : `ffmpeg -y -i <fichier.mp4> -vf "select=eq(n\,<index>)" -vframes 1 <sortie.png>`.

## 5. Vérifier l'UI (headless Chromium)

Binaire Playwright en cache : `~/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell`.

```bash
CH=~/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell
$CH --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=1440,2400 --virtual-time-budget=8000 \
    --screenshot=/tmp/shot.png http://localhost:8090
$CH --headless ... --dump-dom http://localhost:8090 | grep pipelineSelect   # inspecter le DOM rendu
```

Largeurs à couvrir : 390 / 768 / 1250 / 1440. Pour capturer un état localStorage (ex. thème sombre) : créer une page helper même origine `setdark.html` contenant `<script>localStorage.setItem("theme","dark");location.replace("/")</script>`, capturer via son URL, puis la supprimer.

## 6. Check-list avant livraison d'une modification de génération

1. `node --check` du JS extrait.
2. Modèles référencés présents sur disque.
3. Rendu réel réduit **réussi** via les fonctions exactes de la page.
4. Frames inspectées (et mp3 extrait si audio).
5. Pour l'UI : capture clair + sombre à 2 largeurs minimum.
6. `Ctrl+Shift+R` côté utilisateur après déploiement (le HTML peut être en cache navigateur).
