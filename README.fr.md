🇬🇧 [Read this in English](README.md)

# Dell AI Content Studio — démo Media & Entertainment sur GB10

**Version actuelle : 1.0.4** — voir `TOUR-DE-CONTROLE-CHANGELOG.md` pour l'historique des changements.

Studio créatif IA **100 % local** : génération d'images (Krea 2, Qwen-Edit) et de vidéos avec audio (LTX 2.5, Minimax H3) via ComfyUI sur un Dell Pro Max GB10, enrichissement de prompt par LLM local (Ollama). L'application est servie par nginx, sans build, sans framework (à l'exception d'un petit service `updater` dédié aux mises à jour, voir plus bas) — deux modes statiques au choix : le formulaire `index.html` (scénarios guidés, voir plus bas) et l'éditeur de nœuds `canvas.html` (voir section dédiée ci-dessous).

## Déploiement (clone & run)

### Prérequis

- Machine Linux avec **GPU NVIDIA**, driver installé, et
  [`nvidia-container-toolkit`](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) configuré pour Docker.
- **Docker** + **Docker Compose** (plugin `docker compose`).

### Installation automatique (recommandée)

```bash
git clone <url-du-repo> ai-content-studio
cd ai-content-studio
./install.sh
```

`install.sh` fait tout en une commande, de façon **idempotente** (relançable sans risque,
testé sur deux exécutions consécutives) :

1. Vérifie l'environnement (architecture, `docker`/`docker compose`, runtime NVIDIA).
2. Détecte les 3 services (app web `:8090`, ComfyUI `:8188`, Ollama `:11434`) **par rôle réel**
   (santé HTTP), pas par nom de conteneur — réutilise tout ce qui tourne déjà (y compris un
   service lancé en dehors de ce `docker-compose.yml`) et ne recrée/ne détruit jamais un
   conteneur qu'il ne possède pas (vérification par les labels docker-compose). Si un
   ComfyUI existant est bien géré par CE `docker-compose.yml`, il est mis à jour par
   `pull` + `recreate` ; sinon, aucune mise à jour automatique (message explicite pour le
   faire manuellement).
3. Copie `docker/userscripts/*.sh` (dont le script d'installation de `comfy_kitchen`, voir
   plus bas) vers le dossier `userscripts_dir` réel du conteneur ComfyUI utilisé.
4. Télécharge les modèles manquants listés dans `scripts/models.txt` dans
   `comfyui/basedir/models/<dossier>/` (skip automatique si le fichier est déjà présent avec
   la bonne taille — aucun retéléchargement inutile).
5. Tire le modèle Ollama `gemma4:e4b` s'il est absent.
6. Affiche un récapitulatif final (statut des 3 services, modèles téléchargés/déjà présents/
   en échec, health-checks).

**`HF_TOKEN` (jeton Hugging Face, optionnel mais nécessaire pour LTX 2.5)** : les 4 fichiers
de modèle LTX 2.5 proviennent d'un dépôt Hugging Face **"gated"** (accès restreint) — un
téléchargement anonyme échoue en 401 tant que vous n'avez pas accepté les conditions du
modèle. Pour les récupérer :

1. Créez un compte sur [huggingface.co](https://huggingface.co/) si besoin.
2. Acceptez les conditions d'accès sur la page du modèle :
   [huggingface.co/Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5).
3. Générez un jeton d'accès dans vos paramètres de compte HF (Settings → Access Tokens).
4. Relancez l'installation avec le jeton en variable d'environnement :

```bash
HF_TOKEN=<votre_jeton> ./install.sh
```

Sans `HF_TOKEN`, les autres modèles (Krea 2, Qwen-Edit, Minimax H3) se téléchargent
normalement — seuls les 4 fichiers LTX 2.5 échouent proprement et remontent dans le
récapitulatif final, sans bloquer le reste de l'installation.

### Installation manuelle / dépannage

Pour qui préfère comprendre chaque étape, n'a pas de connexion internet complète pour tout
télécharger d'un coup, ou veut auditer ce qu'`install.sh` automatise :

```bash
git clone <url-du-repo> ai-content-studio
cd ai-content-studio
docker compose up -d
```

`docker-compose.yml` définit 3 services :

| Service | Image | Port | Rôle |
|---|---|---|---|
| `ai-content-studio` | `nginx:alpine` | 8090 | Sert `index.html`/`canvas.html` + reverse-proxy vers ComfyUI/Ollama |
| `comfyui` | `mmartial/comfyui-nvidia-docker:ubuntu24_cuda13.1-dgx-latest` | 8188 | Moteur de génération d'images/vidéos |
| `ollama` | `ollama/ollama:latest` | 11434 | LLM local pour l'enrichissement de prompt |

Les volumes ComfyUI sont montés par défaut sous `./comfyui/` à la racine du repo
(`comfyui/basedir`, `comfyui/run`, `comfyui/userscripts_dir`) — modifiables dans
`docker-compose.yml` si vos modèles vivent déjà ailleurs sur la machine. Le service `ollama`
tire automatiquement le modèle `gemma4:e4b` au démarrage (`ollama pull` est idempotent, il ne
retélécharge pas un modèle déjà présent) ; si besoin, relancez-le manuellement :

```bash
docker compose exec ollama ollama pull gemma4:e4b
```

**Important : les poids de modèles ne sont PAS dans le dépôt Git** (plusieurs dizaines de Go
au total) — à télécharger manuellement dans `comfyui/basedir/models/<dossier>/` selon le
tableau ci-dessous (mêmes URLs que `scripts/models.txt`, utilisé par `install.sh`), avant de
lancer une génération. Pour LTX 2.5, voir la section `HF_TOKEN` ci-dessus (dépôt gated).
Les userscripts `docker/userscripts/*.sh` (dont `comfy_kitchen`) sont à copier manuellement
dans le dossier `userscripts_dir` du conteneur ComfyUI si vous ne passez pas par `install.sh`.

### Health-checks post-démarrage

```bash
curl http://localhost:8090/                    # app statique
curl http://localhost:8188/system_stats         # ComfyUI vivant
curl http://localhost:11434/api/version          # Ollama vivant
```

### Modèles à télécharger

Chaque fichier va dans `comfyui/basedir/models/<dossier>/` (chemin hôte par défaut ; adaptez
si vous avez changé le mapping de volume). `install.sh` télécharge automatiquement les 19
fichiers ci-dessous depuis `scripts/models.txt` (source de vérité — mêmes URLs, même ordre) ;
la liste manuelle qui suit est équivalente pour qui préfère `curl`/navigateur.

#### Pipelines actuels (Krea 2, Qwen-Edit, LTX 2.5, Minimax H3)

19 fichiers, URLs vérifiées par requête HTTP réelle sur Hugging Face (`resolve/main/...`,
tailles exactes en octets dans `scripts/models.txt`).

| Modèle / pipeline | Fichier | Dossier cible | Taille | URL |
|---|---|---|---|---|
| Qwen-Edit | `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | `diffusion_models/` | 19 Go | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors) |
| Qwen-Edit (encodeur) | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `text_encoders/` | 8,7 Go | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors) |
| Qwen-Edit (VAE, partagé Krea 2) | `qwen_image_vae.safetensors` | `vae/` | 243 Mo | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors) |
| Qwen-Edit (LoRA Lightning 4 steps) | `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors` | `loras/` | 810 Mo | [resolve/main](https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors) |
| Krea 2 (transformer) | `krea2_turbo_fp8_scaled.safetensors` | `diffusion_models/` | 13 Go | [resolve/main](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors) |
| Krea 2 (encodeur) | `qwen3vl_4b_fp8_scaled.safetensors` | `text_encoders/` | 4,9 Go | [resolve/main](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors) |
| Krea 2 (VAE, partagé Qwen-Edit) | `qwen_image_vae.safetensors` | `vae/` | 243 Mo | [resolve/main](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors) |
| LTX 2.5 (transformer distillé) ⚠️ gated | `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` | `diffusion_models/` | 21 Go | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors) |
| LTX 2.5 (VAE vidéo) ⚠️ gated | `ltx-2.5-video-vae-bf16.safetensors` | `vae/` | 1,4 Go | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-bf16.safetensors) |
| LTX 2.5 (VAE audio) ⚠️ gated | `ltx-2.5-audio-vae-bf16.safetensors` | `vae/` | 348 Mo | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors) |
| LTX 2.5 (encodeur principal) ⚠️ gated | `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` | `text_encoders/` | 15 Go | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors) |
| LTX 2.5 (encodeur enhancer prompt) | `gemma4_e2b_it_bf16.safetensors` | `text_encoders/` | 9,6 Go | [resolve/main](https://huggingface.co/Comfy-Org/gemma-4/resolve/main/text_encoders/gemma4_e2b_it_bf16.safetensors) |
| LTX 2.5 (upscaler latent x2, t2v/i2v uniquement) ⚠️ gated | `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | `latent_upscale_models/` | 950 Mo | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors) |
| Minimax H3 t2v/i2v (transformer) ⚠️ reupload communautaire | `minimax_h3_fl2va_pruned_w4a8_mixed.safetensors` | `diffusion_models/` | 12 Go | [resolve/main](https://huggingface.co/AX1Y2JP/MiniMax-H3-W4A8-ConvRot/resolve/main/minimax_h3_fl2va_pruned_w4a8_mixed.safetensors) |
| Minimax H3 r2v (transformer, checkpoint différent) ⚠️ reupload communautaire | `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors` | `diffusion_models/` | 11 Go | [resolve/main](https://huggingface.co/AX1Y2JP/MiniMax-H3-W4A8-ConvRot/resolve/main/minimax_h3_ref2va_pruned_w4a8_mixed.safetensors) |
| Minimax H3 (encodeur) | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | 15 Go | [resolve/main](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors) |
| Minimax H3 (VAE vidéo) | `minimax_h3_video_vae_fp16.safetensors` | `vae/` | 4,9 Go | [resolve/main](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors) |
| Minimax H3 (VAE audio) | `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | 578 Mo | [resolve/main](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) |
| Minimax H3 (LoRA turbo, t2v/i2v/r2v) ⚠️ reupload communautaire | `minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors` | `loras/H3/` | 592 Mo | [resolve/main](https://huggingface.co/koongrizzly/MiniMax_H3_int4_W4A8_ConvRot_Pruned/resolve/main/loras/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors) |

> **Réserve 1 — LTX 2.5 "gated"** (5 fichiers marqués ⚠️ gated ci-dessus) : le dépôt
> [`Lightricks/LTX-2.5`](https://huggingface.co/Lightricks/LTX-2.5) est à accès restreint sur
> Hugging Face — un téléchargement anonyme échoue en 401 tant que vous n'avez pas accepté
> les conditions du modèle avec un compte HF **et** fourni un jeton d'accès
> (`HF_TOKEN=<token> ./install.sh`, voir section Déploiement ci-dessus). Ce n'est pas un
> problème d'URL : les liens sont corrects, l'accès est simplement conditionné par HF.
>
> **Réserve 2 — Minimax H3 "reupload communautaire"** (3 fichiers marqués ⚠️ ci-dessus) : les
> 2 checkpoints quantifiés `w4a8_mixed` (`AX1Y2JP/MiniMax-H3-W4A8-ConvRot`) et le LoRA turbo
> (`koongrizzly/MiniMax_H3_int4_W4A8_ConvRot_Pruned`) ne viennent **pas** d'un dépôt officiel
> Comfy-Org/Minimax, mais de reuploads communautaires. Le nom de fichier et la taille exacte
> correspondent aux specs attendues et ont été vérifiés par requête HTTP réelle, mais
> l'intégrité du contenu n'est garantie que par la réputation/traction du dépôt (dizaines de
> milliers de téléchargements), pas par un éditeur officiel. À noter avant de s'appuyer
> dessus en production — sans que ce soit un signal d'alarme en soi.

> **Modèles legacy** (Flux2 Klein 9B, Ernie-Image, Z-Image, LTX 2.3) : plus utilisés par
> l'app (:8090), mais toujours référencés par les workflows UI drag-drop `workflows/*.json`
> (`campaign_generator.json`, `storyboard_animatic.json`, `ernie_turbo.json`, `ernie_quality.json`,
> `localized_assets.json`) — voir `workflows/README.md` si vous voulez encore les charger
> directement dans ComfyUI.

### Modèle Ollama requis

`gemma4:e4b` — tiré automatiquement au démarrage du service `ollama` (voir plus haut), ou
manuellement :

```bash
docker compose exec ollama ollama pull gemma4:e4b
```

### Mode Canvas (éditeur de nœuds)

En plus du formulaire `index.html`, l'application propose un second mode : `canvas.html`, un
éditeur de nœuds façon ComfyUI (glisser-déposer de cartes, câblage visuel). Accessible via
`http://<host>:8090/canvas.html`, ou via le bouton "Canvas" dans l'en-tête de l'interface
principale. C'est un mode additionnel — il ne remplace pas le formulaire `index.html`, les
deux coexistent et partagent la même origine (aucune configuration nginx/Docker
supplémentaire n'est nécessaire). Un tiroir fixé en bas de l'écran donne accès à l'historique
des générations (onglets Images/Vidéos), et une vignette peut être glissée sur une carte
"Import média" pour la réutiliser directement.

### Accélération `comfy_kitchen` (DGX Spark / ARM64)

Le nœud d'accélération d'attention `ModelAttentionBackend` (valeur `comfy kitchen attention`)
est câblé juste après le chargeur de modèle dans les templates `workflows/api/*.json` des 4
familles de modèles (Krea 2, LTX 2.5, Minimax H3, Qwen-Edit). Le paquet `comfy_kitchen`
lui-même est installé et maintenu à jour **automatiquement** par `install.sh`, via le
userscript `docker/userscripts/15-comfy_kitchen-DGX_Spark.sh` déployé dans le conteneur
ComfyUI — rien à installer manuellement. Cette accélération est spécifique au matériel
ARM64/DGX Spark (compilation depuis les sources au démarrage du conteneur, idempotente) ;
sur toute autre architecture le userscript se désactive proprement (`exit 0` immédiat) sans
bloquer le démarrage.

## Mise à jour

Les déploiements réalisés à partir de ce commit (ou d'un commit plus récent) intègrent une
vérification de mise à jour automatique : au chargement de Studio (`index.html`) ou de Canvas
(`canvas.html`) dans le navigateur, l'application vérifie si une nouvelle version est
disponible sur GitHub. Si c'est le cas, une popup propose de l'installer ; en cas d'accord, la
mise à jour se télécharge et s'applique automatiquement (`git pull` en arrière-plan), puis une
seconde popup invite à rafraîchir le navigateur.

**Déploiements plus anciens** (installés avant l'introduction de cette fonctionnalité, donc
sans le service `updater`) : une mise à jour manuelle, une seule fois, est nécessaire pour
obtenir la fonctionnalité elle-même — les mises à jour suivantes pourront ensuite se faire
depuis l'interface :

```bash
cd ai-content-studio
git pull origin main
docker compose up -d --build
```

`--build` est nécessaire ici : c'est ce qui construit et démarre le nouveau service `updater`,
qui n'existait pas encore sur ce déploiement.

## Les 3 scénarios (cf. spec `ai_content_studio_media_entertainment_gb10.md`)

| Scénario | Pipelines dédiés | Livrables |
|---|---|---|
| **Campaign Generator** | `campaign_full` (une tâche) + pipelines génériques | Posters 2:3, thumbnails 16:9, social 1:1, teaser vidéo vertical avec audio |
| **Storyboard + Animatic** | `storyboard_v2` (charsheet+locsheet+keyframes+cuts), `reference2video` (Minimax H3, 1 seul job), `sequence2video` (FLF2V manuel) | Storyboard N plans + animatic assemblé, OU vidéo unique personnage+décor cohérents, OU animatic first-frame→last-frame manuel, avec audio |
| **Localized Assets** | image2image + marchés cibles | Variantes par plaque (North America, Europe, Middle East, Asia…) via Qwen-Edit |

Une couche de **navigation par profils métiers** (Réalisateur/Storyboard artist, DA/Motion designer,
Social media/Marketing, Monteur/Post-production) présélectionne scénario + pipeline sans changer le
routing ci-dessus.

Pipelines génériques disponibles partout : text2image (Krea 2 Turbo), image2image (Qwen-Edit 2509),
text2video et image2video (LTX 2.5 et Minimax H3, au choix dans le menu Modèle ; audio natif
optionnel, turbo Minimax H3 activable).

## Arborescence

```
index.html                  ← mode formulaire (CSS + HTML + JS)
canvas.html                 ← mode éditeur de nœuds (façon ComfyUI)
js/                         ← moteur du mode canvas (engine.js, nodes-simple.js, nodes-advanced.js)
install.sh                  ← installation/mise à jour idempotente en une commande (recommandé)
docker-compose.yml          ← 3 services : nginx (8090), comfyui (8188), ollama (11434)
docker/userscripts/         ← scripts déployés dans le conteneur ComfyUI par install.sh (dont comfy_kitchen)
scripts/models.txt          ← 19 modèles requis : dossier|fichier|taille|URL (source de vérité pour install.sh et le README)
workflows/
  manifest.json             ← alimente les menus Pipeline/Modèle de l'app
  api/*.json                ← templates API mono-branche avec placeholders {{PROMPT}}…
  *.json                    ← workflows complets format UI (drag-drop dans ComfyUI)
  README.md                 ← détail des workflows
tools/convert.py            ← convertisseur UI→API (voir docs/TESTING.md)
docs/
  ARCHITECTURE.md           ← anatomie de l'app et des formats
  LESSONS.md                ← pièges & patterns validés (LIRE AVANT DE MODIFIER)
  TESTING.md                ← méthode de validation (rendus réels, extraction frames/audio)
ai_content_studio_media_entertainment_gb10.md   ← spec fonctionnelle d'origine
dell_ai_content_studio_prototype.html           ← ancien prototype (legacy, non utilisé)
```

## Reprise du projet

1. Lire `CLAUDE.md` (conventions et commandes), puis `docs/LESSONS.md` **avant toute modification des graphes ComfyUI** — les pièges y sont coûteux à redécouvrir.
2. Toute modification de génération doit être validée par un **rendu réel** ET une **inspection visuelle/audio** du résultat (méthode dans `docs/TESTING.md`) — un job "success" peut produire un contenu faux.
3. L'UI se vérifie en headless Chromium (captures multi-résolutions, thèmes clair/sombre) — voir `docs/TESTING.md`.
