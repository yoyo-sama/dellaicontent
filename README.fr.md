🇬🇧 [Read this in English](README.md)

# Dell AI Content Studio — démo Media & Entertainment sur GB10

**Version actuelle : 1.3.0** — voir `TOUR-DE-CONTROLE-CHANGELOG.md` pour l'historique des changements.

Studio créatif IA **100 % local** : génération d'images (Krea 2, Qwen-Edit, Qwen Image 2.1) et de vidéos avec audio (LTX 2.5, Minimax H3) via ComfyUI sur un Dell Pro Max GB10, enrichissement de prompt par LLM local (Ollama). L'application est servie par nginx, sans build, sans framework (à l'exception d'un petit service `updater` dédié aux mises à jour, voir plus bas) — deux modes statiques au choix : le formulaire `index.html` (scénarios guidés, voir plus bas) et l'éditeur de nœuds `canvas.html` (voir section dédiée ci-dessous).

## Déploiement (clone & run)

### Prérequis

- Machine Linux avec **GPU NVIDIA**, driver installé, et
  [`nvidia-container-toolkit`](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) configuré pour Docker.
- **Docker** + **Docker Compose** (plugin `docker compose`).

### Installation automatique (recommandée)

```bash
git clone <url-du-repo> ~/ai-content-studio
cd ~/ai-content-studio
./install.sh
```

> **Quelque chose ne marche pas, ou poste sur lequel une installation a déjà été tentée ?**
> → **[docs/TROUBLESHOOTING.fr.md](docs/TROUBLESHOOTING.fr.md)** — table symptôme → cause, diagnostic
> en trois commandes, procédure de réinstallation pas à pas, et remise à zéro.

`install.sh` fait tout en une commande, de façon **idempotente** (relançable sans risque,
testé sur deux exécutions consécutives) :

1. Vérifie l'environnement (architecture, `docker`/`docker compose`, runtime NVIDIA).
2. Détecte les 3 services (app web `:8090`, ComfyUI `:8188`, Ollama `:11434`) **par rôle réel**
   (santé HTTP), pas par nom de conteneur — réutilise tout ce qui tourne déjà, **y compris un
   Ollama installé nativement (systemd), qui n'est pas un conteneur**, et ne recrée/ne détruit
   jamais un service qu'il ne possède pas (vérification par les labels docker-compose). Ce qui
   manque est créé dans sa propre stack à la racine du home (`~/comfyui-spark`, `~/ollama`)
   depuis les gabarits `docker/stacks/*.yml`, dossiers créés côté utilisateur AVANT les
   conteneurs. Si un port est occupé par un service qui ne répond pas, rien n'est créé et le
   script explique quoi libérer — au lieu de laisser Docker échouer sur « port is already
   allocated ». Un service **installé mais arrêté** est redémarré plutôt que doublé : un
   conteneur à l'arrêt est relancé (`docker start`), et un Ollama natif (systemd) est
   démarré via `sudo -n systemctl start ollama` — sans jamais bloquer sur une invite de mot
   de passe : si sudo n'est pas autorisé sans mot de passe, le script affiche la commande à
   lancer et ne crée rien. Une installation faite avec l'ancienne mise en page (services `comfyui`/`ollama`
   dans le compose de l'app) est migrée automatiquement.
3. Copie `docker/userscripts/*.sh` (dont le script d'installation de `comfy_kitchen`, voir
   plus bas) vers le dossier `userscripts_dir` réel du conteneur ComfyUI utilisé.
4. Télécharge les modèles manquants listés dans `scripts/models.txt` dans
   `~/comfyui-spark/basedir/models/<dossier>/` (skip automatique si le fichier est déjà présent avec
   la bonne taille — aucun retéléchargement inutile).
5. Tire le modèle Ollama `gemma4:e4b` s'il est absent, **par l'API HTTP** (`POST /api/pull`)
   et non par `docker exec` : identique que Ollama tourne dans un conteneur ou nativement.
6. Attend que ComfyUI réponde sur `:8188` quand il vient d'être créé (premier démarrage :
   plusieurs minutes d'installation des userscripts), puis affiche un récapitulatif final
   (statut des services, emplacements réels, modèles, health-checks).

La sortie du script et ses commentaires de code sont en anglais.

**`HF_TOKEN` (jeton Hugging Face, optionnel mais nécessaire pour LTX 2.5)** : les 5 fichiers
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
normalement — seuls les 5 fichiers LTX 2.5 échouent proprement et remontent dans le
récapitulatif final, sans bloquer le reste de l'installation.

Le jeton ne passe jamais en argument de ligne de commande (`curl -K -`, invisible dans `ps`), et
le gabarit de la stack ComfyUI le relaie en `HF_TOKEN: ${HF_TOKEN:-}`, jamais en dur : pour que le
conteneur en marche le voie, mettez `HF_TOKEN=<jeton>` dans `~/comfyui-spark/.env` (mode 600), à
côté de `compose.yaml` et non dedans.

### Installation manuelle / dépannage

Pour qui préfère comprendre chaque étape, n'a pas de connexion internet complète pour tout
télécharger d'un coup, ou veut auditer ce qu'`install.sh` automatise :

```bash
git clone <url-du-repo> ~/ai-content-studio
cd ~/ai-content-studio
docker compose up -d                                   # app seule (nginx :8090 + updater)
docker compose -f ~/comfyui-spark/compose.yaml up -d   # ComfyUI (:8188)
docker compose -f ~/ollama/compose.yaml up -d          # Ollama  (:11434)
```

Trois stacks distinctes, une par service, chacune à la racine du home :

| Dossier | Conteneur | Image | Port | Rôle |
|---|---|---|---|---|
| `~/ai-content-studio` | `ai-content-studio-web` + `ai-content-studio-updater` | `nginx:alpine` | 8090 | Sert `index.html`/`canvas.html` + reverse-proxy vers ComfyUI/Ollama |
| `~/comfyui-spark` | `comfyui-nvidia` | `mmartial/comfyui-nvidia-docker:ubuntu24_cuda13.1-dgx-latest` | 8188 | Moteur de génération d'images/vidéos |
| `~/ollama` | `ollama-api` | `ollama/ollama:latest` | 11434 | LLM local pour l'enrichissement de prompt |

ComfyUI n'écoute que sur `127.0.0.1` (accès distant à son interface par `:8090/comfy/`) ; une installation existante doit reporter à la main ces 3 changements dans `~/comfyui-spark/compose.yaml` (port `"127.0.0.1:8188:8188"`, `SECURITY_LEVEL: normal`, `--enable-cors-header` retiré de `COMFY_CMDLINE_EXTRA`), `install.sh` ne recopiant le gabarit que s'il est absent.

Le conteneur `updater` tourne avec l'UID du propriétaire du dépôt, pas en root : `install.sh`
écrit `APP_UID`/`APP_GID` (1000 par défaut) dans `.env`, et affiche le `chown` exact à lancer si
`.git` contient des fichiers appartenant à quelqu'un d'autre (laissés par un ancien updater root).

`install.sh` crée les deux stacks voisines à partir des gabarits `docker/stacks/*.yml`, en
créant leurs dossiers **avant** les conteneurs : un bind-mount dont la source n'existe pas
encore est créé par Docker en `root`, ce qui cadenasse le dossier et fait échouer tous les
téléchargements de modèles ensuite. Modèles ComfyUI dans `~/comfyui-spark/basedir/models/`,
poids Ollama dans `~/ollama/data/`.

`BASE_DIRECTORY: /basedir` dans la stack ComfyUI n'est pas optionnel : sans lui, ComfyUI
ignore `/basedir` et cherche ses modèles dans `/comfy/mnt/ComfyUI/models`. Les flags
`--disable-pinned-memory --reserve-vram 8` non plus (mémoire unifiée GB10).

Le service Ollama tire `gemma4:e4b` au démarrage (`ollama pull` est idempotent, il ne
retélécharge pas un modèle déjà présent) ; si besoin, relancez-le manuellement :

```bash
curl -X POST http://localhost:11434/api/pull -d '{"model":"gemma4:e4b"}'
```

**Important : les poids de modèles ne sont PAS dans le dépôt Git** (plusieurs dizaines de Go
au total) — à télécharger manuellement dans `~/comfyui-spark/basedir/models/<dossier>/` selon le
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

Chaque fichier va dans `~/comfyui-spark/basedir/models/<dossier>/` (chemin de la stack
ComfyUI ; adaptez si vos modèles vivent ailleurs). `install.sh` télécharge automatiquement les 22
fichiers ci-dessous depuis `scripts/models.txt` (source de vérité — mêmes URLs) ;
la liste manuelle qui suit est équivalente pour qui préfère `curl`/navigateur.

#### Pipelines actuels (Krea 2, Qwen-Edit, Qwen Image 2.1, LTX 2.5, Minimax H3)

22 fichiers, URLs vérifiées par requête HTTP réelle sur Hugging Face (`resolve/main/...`,
tailles exactes en octets dans `scripts/models.txt`).

| Modèle / pipeline | Fichier | Dossier cible | Taille | URL |
|---|---|---|---|---|
| Qwen-Edit | `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | `diffusion_models/` | 19 Go | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors) |
| Qwen-Edit (encodeur) | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `text_encoders/` | 8,7 Go | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors) |
| Qwen-Edit (VAE, partagé Krea 2) | `qwen_image_vae.safetensors` | `vae/` | 243 Mo | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors) |
| Qwen-Edit (LoRA Lightning 4 steps) | `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors` | `loras/Qwen/` | 810 Mo | [resolve/main](https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors) |
| Krea 2 (transformer) | `krea2_turbo_fp8_scaled.safetensors` | `diffusion_models/` | 13 Go | [resolve/main](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors) |
| Krea 2 (encodeur) | `qwen3vl_4b_fp8_scaled.safetensors` | `text_encoders/` | 4,9 Go | [resolve/main](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors) |
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
| Minimax H3 (LoRA turbo 4 steps, t2v/i2v uniquement — requise pour l'option 4 steps de l'UI) | `minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors` | `loras/H3/` | 1,9 Go | [resolve/main](https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors) |
| Qwen Image 2.1 (transformer) | `qwen_image_2.1_int8_convrot.safetensors` | `diffusion_models/` | 6,8 Go | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors) |
| Qwen Image 2.1 (encodeur) | `qwen3vl_8b_int8_convrot.safetensors` | `text_encoders/` | 8,7 Go | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors) |
| Qwen Image 2.1 (VAE) | `qwen_image_2.1_vae_bf16.safetensors` | `vae/` | 644 Mo | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors) |

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
curl -X POST http://localhost:11434/api/pull -d '{"model":"gemma4:e4b"}'
```

### Mode Canvas (éditeur de nœuds)

En plus du formulaire `index.html`, l'application propose un second mode : `canvas.html`, un
éditeur de nœuds façon ComfyUI (glisser-déposer de cartes, câblage visuel). Accessible via
`http://<host>:8090/canvas.html`, ou via le bouton "Canvas" de la paire « Studio | Canvas » (même
ordre sur les deux pages). C'est un mode additionnel — il ne remplace pas le formulaire
`index.html`, les deux coexistent et partagent la même origine (aucune configuration
nginx/Docker supplémentaire n'est nécessaire). Ils partagent aussi langue (FR/EN/ES/DE) et
thème : les deux pages lisent et écrivent les mêmes clés navigateur `lang` et `theme`. Un tiroir
fixé en bas de l'écran donne accès à l'historique des générations (onglets Images/Vidéos,
traduit), et une vignette peut être glissée sur une carte "Import média" pour la réutiliser
directement.

Sous 768 px, la palette et le panneau Propriétés deviennent deux feuilles basculantes en bas
d'écran (une seule ouverte à la fois) et le canvas prend toute la largeur ; le bouton ⤢ recadre
la vue sur les cartes. La carte Fiche personnage a un sélecteur « Type de sujet » (auto /
humain / autre) qui corrige le choix du LLM à la génération suivante, et les cartes Storyboard,
Vidéo, Génération vidéo et Reference2Video composent leurs prompts avec les règles corrigées du Studio (planches
selon le sujet, grammaire de prompt Minimax H3).
La carte Création d'image a un sélecteur Moteur — Krea 2 Turbo par défaut, ou Qwen Image 2.1 (mêmes tailles et même
graphe que le Studio ; pas de LoRA de style dans ce cas).

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

### Version minimale de ComfyUI

`workflows/manifest.json` déclare la plus ancienne version de ComfyUI dont les modèles livrés
ont besoin (`"comfyui": { "min": "0.37.0" }`, la version installée pour Qwen Image 2.1). Au
chargement de Studio ou de Canvas, si le ComfyUI en marche est plus ancien, une confirmation
unique propose de le mettre à jour vers le dernier stable via le ComfyUI-Manager (proxifié sur
`/comfy/v2/manager/`). L'accepter redémarre ComfyUI (environ 30 s) et interrompt les jobs en
cours : la mise à jour est donc refusée tant que la file n'est pas vide. Un refus fait taire
l'invite pour la session du navigateur. Pour revenir à la version précédente (l'invite affiche
la commande exacte, tag = `v` + ancienne version) :

```bash
git -C ~/comfyui-spark/run/ComfyUI checkout <ancien tag, ex. v0.36.0> && docker restart comfyui-nvidia
```

## Les 3 scénarios (cf. spec `ai_content_studio_media_entertainment_gb10.md`)

| Scénario | Pipelines dédiés | Livrables |
|---|---|---|
| **Campaign Generator** | `campaign_full` (une tâche) + pipelines génériques | Posters 2:3, thumbnails 16:9, social 1:1, teaser vidéo vertical avec audio |
| **Storyboard + Animatic** | `storyboard_v2` (charsheet+locsheet+keyframes+cuts), `reference2video` (Minimax H3, 1 seul job), `sequence2video` (FLF2V manuel) | Storyboard N plans + animatic assemblé, OU vidéo unique personnage+décor cohérents, OU animatic first-frame→last-frame manuel, avec audio |
| **Localized Assets** | image2image + marchés cibles | Variantes par plaque (North America, Europe, Middle East, Asia…) via Qwen-Edit |

Le Studio s'ouvre sur quatre **cartes d'objectif** — Affiche / visuel, Pub courte / campagne,
Trailer narratif (plusieurs plans), Déclinaisons locales — chacune avec une ligne de description.
Une carte ne fait que présélectionner scénario + pipeline : elle n'écrit jamais dans le brief
(l'exemple est un `placeholder`) et ne lance rien. Le libellé du bouton principal dit ce que le
clic va lancer (« Générer les planches (étape 1/3) », « Lancer la campagne… »), et avec un brief
vide il ne lance rien (sauf les déclinaisons par marché, dont le prompt vient des marchés choisis).

### Ce que vous voyez en travaillant

- **Barre de session**, sous l'en-tête : les deux planches ancrées en vignettes (clic =
  agrandir), le stepper 1-2-3 (Planches › Storyboard › Montage, ou Planches › Vidéo),
  « Job k/n · mm:ss » tant que des jobs tournent, et la mémoire GPU en permanence. Affichage seul.
- **Annuler plutôt que confirmer** pour une suppression de galerie ou un sujet retiré : un
  bandeau avec un bouton Annuler pendant 5 s, en pause tant qu'il a le focus clavier. Un sujet
  retiré remet ses planches, variantes, étiquettes de plans et validation.
- **Bande de vignettes des plans** en tête de la section Storyboard : une vignette par plan avec
  son statut ; un clic défile jusqu'au plan et ne lance rien.
- **Galerie lisible** : chaque carte affiche le nom du pipeline et un extrait du prompt (nom de
  fichier en infobulle).
- **Glisser une image de la galerie** directement sur un champ d'image : image d'entrée, dernière
  image (FL2VA), images de référence supplémentaires (jusqu'à 9 en Image2Image avec Qwen Image
  2.1, 7 en Reference2Video et dans le storyboard Qwen 2.1) ou animatic FLF2V. Les fichiers
  glissés depuis l'ordinateur marchent aussi. Le champ se remplit exactement comme si vous aviez
  choisi l'image par Browse, ou par « Utiliser en entrée » / « Séquence » ; rien n'est rendu.
  Ces deux boutons restent la voie au clavier, et le toucher continue de les utiliser (le
  glisser-déposer HTML5 ne fonctionne pas au toucher).
- **File de jobs repliable**, comme « Options avancées » : le titre indique le nombre de jobs,
  l'état ouvert/replié est mémorisé, et une pastille « Erreur » apparaît pendant le repli si un
  job échoue.
- **Langues** : FR, EN, ES, DE, pour toute l'interface y compris infobulles et statuts de job ;
  le français, l'espagnol et l'allemand s'adressent à vous au tutoiement (tu / tú / du). Le
  journal d'événements et les messages d'erreur restent en français, non traduits.
- **Petits écrans** : sous 768 px, le rail et l'en-tête restent dans le flux, les sections du
  studio défilent jusqu'à elles, les actions de projet sont en bas, et chaque cible fait au moins
  44 px.

### Le studio storyboard

`storyboard_v2` et `reference2video` passent toujours par une **revue étape par étape** dans un
studio plein écran — il n'y a pas de mode auto, et rien ne part jamais en rendu sans un clic.

- **Planches sujet et décor.** Deux fiches structurées sont écrites par le LLM local, puis rendues
  par Krea 2 en planches de référence multi-vues. Chaque champ reste éditable, chaque planche garde
  un historique de variantes entre lesquelles basculer, et une planche peut être remplacée par une
  image à vous. Le LLM tranche si un sujet est une personne ou autre chose (animal, créature, robot,
  objet), ce qui se corrige en un clic ; le vocabulaire de la planche et sa clause anti-anthropomorphe
  suivent ce choix.
- **Choix du gabarit de planche.** Cinq compositions (turnaround + expressions + costume, colonne
  d'expressions + accessoires, grand portrait + rangée de têtes, grand portrait + vêtements à plat,
  poses d'action + équipement), choisies sur des vignettes qui dessinent leur propre disposition.
- **Plusieurs sujets par storyboard.** Les sujets s'ajoutent un par un, en emplacements vides que
  vous décrivez vous-même. Chaque plan désigne les sujets qu'il ancre — deux au maximum plus le
  décor, un plafond dur imposé par les trois entrées image du nœud d'ancrage.
- **Liste de plans éditable.** Caméra, lumière, action, émotion, durée et détails libres par plan,
  avec la keyframe affichée en face du plan qu'elle illustre, régénérable et verrouillable.
- **Prompts éditables partout.** Les deux planches, chaque keyframe, chaque cut et l'action de chaque
  plan ouvrent le même éditeur, qui montre le texte réellement envoyé au graphe. Ce que vous appliquez
  part **verbatim** et reste rangé avec le projet ; un ré-enrichissement par le LLM local ne touche
  jamais aux parties structurelles du prompt, que l'app remet elle-même.
- **Moteur des cuts.** LTX 2.5 par défaut, ou Minimax H3 avec sa grammaire de prompt structurée,
  rangé sur chaque cut.
- **Prompt Relay.** Un à dix segments enchaînés, liés soit en continu (la frame exacte du segment
  précédent enchaîne), soit en coupure. Sur le moteur H3, un composer de scénario répartit un récit
  entre les segments ; n'importe quel segment se re-rend seul, avec son image de transition au choix
  parmi les cinq dernières frames, et une image de fin possible (FL2VA).

Pipelines génériques disponibles partout : text2image (Krea 2 Turbo par défaut, Qwen Image 2.1 au choix
dans le menu Moteur), image2image (Qwen-Edit 2509 par défaut, Qwen Image 2.1 au choix — image d'entrée plus jusqu'à 9 références,
sortie à la taille de la source), text2video et image2video (LTX 2.5 et Minimax H3, au choix dans le menu Modèle ; audio natif
optionnel, turbo Minimax H3 activable).

L'image2image Qwen Image 2.1 accepte jusqu'à 10 images en tout : l'image d'entrée plus jusqu'à 9 références supplémentaires (bloc
« Références supplémentaires », affiché pour ce seul moteur). L'image d'entrée est `<image1>`, les références sont `<image2>`,
`<image3>`… dans l'ordre de la liste ; cite-les dans la consigne (ex. : « mets le personnage de `<image1>` dans le décor de
`<image2>` »). Qwen-Edit 2509 reste à une image.

**LoRA de style** : text2image, text2video, image2video et reference2video (Minimax H3) proposent
un sélecteur de LoRA de style optionnel, aussi bien dans Studio que dans Canvas. La liste est
découverte en direct depuis les fichiers `.safetensors` présents sous `loras/Krea2/`/`loras/H3/`
sur le disque (plus de liste curée à la main) — de nouveaux fichiers peuvent être ajoutés
directement depuis le panneau Model Management de Studio (téléversement navigateur uniquement,
pas de récupération par URL).

## Arborescence

```
index.html                  ← mode formulaire (CSS + HTML + JS)
canvas.html                 ← mode éditeur de nœuds (façon ComfyUI)
js/                         ← engine.js (partagé par les deux pages), nodes-simple.js, nodes-advanced.js,
                              canvas-gallery.js (Canvas), update-check.js (les deux pages)
js/vendor/                  ← litegraph.js 0.7.18 + CSS vendorisés (Canvas, sans CDN)
install.sh                  ← installation/mise à jour idempotente en une commande (recommandé)
docker-compose.yml          ← app seule : nginx (8090) + updater (8093)
docker/stacks/*.yml         ← gabarits des stacks voisines : ~/comfyui-spark et ~/ollama
docker/userscripts/         ← scripts déployés dans le conteneur ComfyUI par install.sh (dont comfy_kitchen)
scripts/models.txt          ← 22 modèles requis : dossier|fichier|taille|URL (source de vérité pour install.sh et le README)
workflows/
  manifest.json             ← alimente les menus Pipeline/Modèle de l'app
  api/*.json                ← templates API mono-branche avec placeholders {{PROMPT}}…
  *.json                    ← workflows complets format UI (drag-drop dans ComfyUI)
  README.md                 ← détail des workflows
tools/                      ← convert.py (UI→API), onboard.py, validate.py (voir docs/TESTING.md)
docs/
  TROUBLESHOOTING.md        ← dépannage installation/déploiement (EN) : symptômes, diagnostic, réparation, remise à zéro
  TROUBLESHOOTING.fr.md     ← même guide en français
  ARCHITECTURE.md           ← anatomie de l'app et des formats
  LESSONS.md                ← pièges & patterns validés (LIRE AVANT DE MODIFIER)
  TESTING.md                ← méthode de validation (rendus réels, bancs headless, extraction frames/audio)
  CODE-REVIEW-*.md          ← revues de code et d'UX du 2026-09-23, avec l'état de chaque trouvaille
ai_content_studio_media_entertainment_gb10.md   ← spec fonctionnelle d'origine
dell_ai_content_studio_prototype.html           ← ancien prototype (legacy, non utilisé)
```

## Reprise du projet

1. Lire `CLAUDE.md` (conventions et commandes), puis `docs/LESSONS.md` **avant toute modification des graphes ComfyUI** — les pièges y sont coûteux à redécouvrir.
2. Toute modification de génération doit être validée par un **rendu réel** ET une **inspection visuelle/audio** du résultat (méthode dans `docs/TESTING.md`) — un job "success" peut produire un contenu faux.
3. L'UI se vérifie en headless Chromium (captures multi-résolutions, thèmes clair/sombre) — voir `docs/TESTING.md`.
