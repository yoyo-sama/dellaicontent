# AGENTS.md — guide agent pour AI Content Studio

Démo Dell GB10 : page statique unique (`index.html`) qui pilote ComfyUI (`:8188`) et Ollama (`:11434`). Pas de build, pas de dépendances côté frontend. Publique via nginx sur `:8090` (`docker compose up -d`). Seule exception backend : le service `updater` (`docker/updater/`, Python stdlib, `127.0.0.1:8093`) qui expose `/update/status` et `/update/apply` (proxifiés par nginx) pour la mise à jour git déclenchée depuis l'UI — voir le changelog du 2026-09-07 (suite 3).

## Commandes essentielles

```bash
docker compose up -d                                  # servir l'app (nginx :8090)
curl -s http://localhost:8188/system_stats | head -c 200   # ComfyUI vivant ?
curl -s http://localhost:11434/api/version                 # Ollama vivant ?
node --check <(python3 -c "import re;print(re.search(r'<script>(.*?)</script>', open('index.html').read(), re.S).group(1))")   # valider le JS
python3 tools/convert.py workflows/storyboard_animatic.json > /tmp/api.json   # UI→API (brut)
python3 tools/onboard.py <ui.json> --id X --label "…" --pipeline text2video --model "…"   # UI→API+placeholders+manifest+test
python3 tools/validate.py workflows/api/ltx25_t2v.json --reduce --frames 0,12 --audio      # rendu réel réduit + inspection
```

Modèles installés : `ls /home/sparks/comfyui-spark/basedir/models/<dossier>/` (diffusion_models, checkpoints, text_encoders, vae, loras, latent_upscale_models). Ne jamais référencer un `.safetensors` sans vérifier sa présence.

## Règles du projet (imposées par l'utilisateur)

- **Core ComfyUI nodes uniquement** — aucun custom node.
- **Simplest thing that works** — pas de feature/abstraction/validation au-delà du demandé.
- Enrichissement de prompt : **exclusivement `gemma4:e4b`** via Ollama (ne pas exposer d'autres LLM locaux).
- Clés API cloud : **sessionStorage uniquement** (jamais localStorage, jamais loguées).
- Restriction pipeline↔scénario : via `pipelines[].scenario` dans `manifest.json` (manifest v2), pas en JS.
- Le journal d'événements n'est pas traduit (choix assumé) ; tout le reste de l'UI est i18n FR/EN/ES/DE.

## Où est quoi dans index.html

Un seul fichier, trois zones : `<style>` (variables CSS + `:root[data-theme="dark"]`), HTML, `<script>` (~3 000 lignes). Repères JS par commentaires `// ── Section ──` : config/RATIOS/PIPELINE_*, i18n (I18N + translateTree), manifest & menus (refreshPipelineOptions/updateModelOptions), scénarios + nav par profils métiers (`PROFILES`), WebSocket+jobs, galerie (addAssetCard/groupFor/lightbox/prompts), Generate (handler + tryCloudGeneration), enrichissement Ollama, cloud (OpenAI/Gemini), marchés, **builders de graphes API** (makeGraphBuilder, addKrea2Shared/addKrea2Shot, addLtx25Shared/addLtx25Enhance, addFLF2VChain, applyMinimaxTurbo, addGrid, buildCampaignFullGraph, mergeGraph), **storyboard_v2 / reference2video** (orchestration multi-jobs : characterSheetFromBrief/locationSheetFromBrief/shotListFromBrief, submitCharsheetJob/submitLocsheetJob/submitKeyframeJob/submitGridJob/submitCutJob/submitAnimaticJob, generateStoryboardV2 mode Auto + directorStep1/2/3 mode Réalisateur, generateReference2Video), séquence FLF2V manuelle, monitor. Détails : `docs/ARCHITECTURE.md`.

## Pièges critiques (résumé — détail dans docs/LESSONS.md)

- **Krea 2 (toute la génération d'image du projet)** : le négatif du `KSampler` est routé par `ConditioningZeroOut` sur le **positif** — le texte négatif n'est jamais encodé, monter le cfg n'y changerait rien. Toute contrainte doit être formulée **positivement** dans le prompt (voir constante `SHEET_CLEAN`). Détail : LESSONS piège n°16.
- **Minimax H3** (t2v/i2v/r2v) : la longueur vidéo se cale sur la grille **17n+5** (pas le 8n+1 de LTX) — une demande de 1 s à 24 fps rend 39 frames (1,625 s), pas 24. Dimensions arrondies au multiple de 32 inférieur. Détail : LESSONS piège n°11. LoRA turbo câblée en dur dans les 3 templates (`LoraLoaderModelOnly`, retirée par `applyMinimaxTurbo` si OFF) : **8 steps validé**, 6 = plancher acceptable, **4 casse la colorimétrie** (à ne jamais exposer dans l'UI) — LESSONS piège n°12. Deux checkpoints transformer différents et non interchangeables : `*_fl2va_*` (t2v/i2v) vs `*_ref2va_*` (r2v).
- `LTXVAddGuide` **recadre brutalement** toute image guide au ratio ≠ latent → toujours `ImageScale(crop:"center")` avant (LTX 2.5, `addFLF2VChain`).
- L'audio LTX 2.5 **exige un VAE audio dédié** (`ltx-2.5-audio-vae-bf16.safetensors`), distinct du VAE vidéo — contrairement à l'ancien LTX 2.3 (legacy) qui l'incluait dans son checkpoint.
- LTX 2.5 distillé = **cfg 1** → l'adhérence au prompt repose entièrement sur l'enhancer intégré `TextGenerateLTX2Prompt` — ne jamais le retirer d'un graphe LTX. Contrairement à LTX 2.3, il accepte une image en entrée (`addLtx25Enhance`), à utiliser pour l'ancrer plutôt que le laisser inventer une scène.
- `ComfyMathExpression` : slot 0 = FLOAT, slot 1 = INT.
- Ids de graphe non numériques possibles ("PH") → filtrer avant `Math.max` pour générer des ids.
- La hauteur vidéo LTX est arrondie au multiple de 32 inférieur (720 → 704) ; les frames vidéo aussi, au 8n+1 inférieur (2 s@25fps calculé 51 → rendu réel 49).
- Prompt Qwen-Edit : bannir tout vocabulaire "storyboard/keyframe" (fait dessiner une planche annotée) — tout exprimer positivement (cfg 1 → negative ignoré).
- `storyboard_v2`/`reference2video` : les cuts i2v peuvent dériver vers un contenu sans rapport si le prompt = mouvement de caméra seul (enhancer `TextGenerateLTX2Prompt` sans entrée image à cfg 1 invente alors une scène). **Corrigé** : `submitCutJob` ancre le prompt sur `${scene}. ${charDesc}. ${locDesc}. Camera motion: ${motion}.` — vérifié 0 dérive sur le run qualifié LOT 4 (ancrage double). Ne jamais revenir à un prompt de mouvement seul. Détail : LESSONS piège n°9.
- `storyboard_v2` ancrage double (`qwen_edit_dual.json`) : l'image 1 (charsheet) alimente le conditioning ET le latent de départ (`VAEEncode`) ; l'image 2 (locsheet) ne doit alimenter QUE le conditioning (`TextEncodeQwenImageEditPlus`) — jamais `VAEEncode`, sinon la géométrie de départ vient du décor et non du personnage. Détail : LESSONS piège n°10.
- L'ancrage Qwen-Edit (`storyboard_v2`) ne suit **pas** les angles de caméra forts (zénithal, contre-plongée extrême) : il préserve la pose/composition de l'image de référence. Sans impact en usage normal (gemma ne propose pas ce type d'angle) — détail dans LESSONS piège n°8.
- **Ne jamais conclure d'un statut de job ComfyUI "success"** : plusieurs pipelines ont déjà cassé silencieusement par dérive de noms de fichiers modèles sur disque (fichier présent mais renommé/déplacé, substitution non signalée) — toujours inspecter le rendu réel (frames + audio). Détail : LESSONS piège n°14.
- Flux2 Klein 9B (`qwen_3_8b_fp8mixed` obligatoire) et l'essentiel d'Ernie-Image/Z-Image/LTX 2.3 sont **legacy** : plus utilisés par l'app, seulement par les workflows UI drag-drop de `workflows/*.json` (voir `workflows/README.md`).

## Validation obligatoire avant de livrer

La validation structurelle (nœuds dans `/object_info`, modèles sur disque, liens intègres) **ne suffit pas** : un rendu "success" peut être visuellement/sonorement faux. Toujours faire un rendu réel réduit (frames vidéo ≈ 25) puis inspecter frames et piste audio — méthode outillée dans `docs/TESTING.md`. Pour l'UI : captures headless Chromium (chemin du binaire dans TESTING) en clair/sombre et à 390/768/1250/1440 px.

## Historique du projet

`TOUR-DE-CONTROLE-CHANGELOG.md` (racine) journalise les orchestrations passées (lots, décisions, fichiers touchés) ; `docs/NOUVEAUX-MODELES-LOT1.md` détaille la qualification des modèles Krea 2/LTX 2.5/Minimax H3. Ce sont des comptes-rendus historiques (à lire pour le contexte), pas une doc d'état courant — `docs/ARCHITECTURE.md`, `docs/LESSONS.md`, `docs/TESTING.md`, ce fichier et les README sont les sources à jour.
