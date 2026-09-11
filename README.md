🇫🇷 [Lire en français](README.fr.md)

# Dell AI Content Studio — Media & Entertainment demo on GB10

**Current version: 1.1.0** — see `TOUR-DE-CONTROLE-CHANGELOG.md` for the change history.

**Fully local** AI creative studio: image generation (Krea 2, Qwen-Edit) and video generation with audio (LTX 2.5, Minimax H3) via ComfyUI on a Dell Pro Max GB10, with prompt enrichment by a local LLM (Ollama). The application is served by nginx, with no build step and no framework (aside from a small `updater` backend service that handles in-app updates — see below) — two static modes to choose from: the `index.html` form (guided scenarios, see below) and the `canvas.html` node editor (see dedicated section below).

## Deployment (clone & run)

### Prerequisites

- Linux machine with an **NVIDIA GPU**, driver installed, and
  [`nvidia-container-toolkit`](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) configured for Docker.
- **Docker** + **Docker Compose** (the `docker compose` plugin).

### Automatic installation (recommended)

```bash
git clone <url-du-repo> ~/ai-content-studio
cd ~/ai-content-studio
./install.sh
```

`install.sh` diagnoses the machine's real state first — containers, mounts, compose labels;
never the `VERSION` file — prints the plan it is about to run, asks for confirmation, then
executes it: whichever of the 3 services (web app `:8090`, ComfyUI `:8188`, Ollama `:11434`)
already answers is reused as is (including a native systemd Ollama, or a third-party ComfyUI),
whatever is missing is created in its own stack at the root of the home directory
(`~/comfyui-spark`, `~/ollama`), missing models are downloaded, and `gemma4:e4b` is pulled into
Ollama. It never recreates or destroys a service it doesn't own, and it is fully
**idempotent** — re-running it is always safe, and it is also the best way to check an install.
The script's output and code comments are in English. Full guide, in English:
**[docs/INSTALL.md](docs/INSTALL.md)**.

**Repairing a machine, or updating one an older version already ran on?**

```bash
cd ~/ai-content-studio && git pull
./install.sh --check      # read-only diagnosis, changes nothing
./install.sh --dry-run    # also walks every step and prints "would …", changes nothing
./install.sh              # applies the plan (asks for confirmation first)
```

An old layout (ComfyUI/Ollama containers created by this repository's own
`docker-compose.yml`, from before 1.0.7) is detected and migrated automatically. Models are
always kept and never re-downloaded once present on disk, whichever layout they came from.
→ **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** for symptom-by-symptom diagnosis
(`JSON.parse`/`NetworkError` errors in the browser, ComfyUI not seeing its models, a native
Ollama not starting, …).

**Uninstall:**

```bash
./install.sh --mode uninstall
```

Asks, one component at a time (web app, updater, ComfyUI, Ollama), before removing
anything — and only ever removes a container this installer itself created. Models, Ollama
weights, workflows and the stack files are always kept; the script prints exactly what stays
and where.

**`HF_TOKEN` (Hugging Face token, optional but required for LTX 2.5)**: 5 model files come
from a **"gated"** (access-restricted) Hugging Face repository — an anonymous download fails
with a 401 until you've accepted the model's terms. To get them:

1. Create an account on [huggingface.co](https://huggingface.co/) if you don't have one.
2. Accept the access terms on the model page:
   [huggingface.co/Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5).
3. Generate an access token in your HF account settings (Settings → Access Tokens).
4. Either let `install.sh` prompt for it (hidden input) the moment a gated file is actually
   missing, or supply it up front as an environment variable:

```bash
HF_TOKEN=hf_xxx ./install.sh
```

Without a token, the other models (Krea 2, Qwen-Edit, Minimax H3) download normally — only
the 5 LTX 2.5 files fail cleanly and are reported in the final summary, without blocking the
rest of the installation.

### Manual installation / troubleshooting

For anyone who prefers to understand each step, doesn't have a full internet connection to
download everything at once, or wants to audit what `install.sh` automates:

```bash
git clone <url-du-repo> ~/ai-content-studio
cd ~/ai-content-studio
docker compose up -d                                   # app only (nginx :8090 + updater)
docker compose -f ~/comfyui-spark/compose.yaml up -d   # ComfyUI (:8188)
docker compose -f ~/ollama/compose.yaml up -d          # Ollama  (:11434)
```

Three separate stacks, one per service, each at the root of the home directory:

| Folder | Container | Image | Port | Role |
|---|---|---|---|---|
| `~/ai-content-studio` | `ai-content-studio-web` + `ai-content-studio-updater` | `nginx:alpine` | 8090 | Serves `index.html`/`canvas.html` + reverse-proxies to ComfyUI/Ollama |
| `~/comfyui-spark` | `comfyui-nvidia` | `mmartial/comfyui-nvidia-docker:ubuntu24_cuda13.1-dgx-latest` | 8188 | Image/video generation engine |
| `~/ollama` | `ollama-api` | `ollama/ollama:latest` | 11434 | Local LLM for prompt enrichment |

`install.sh` creates the two sibling stacks from the `docker/stacks/*.yml` templates, and
creates their folders **before** the containers: a bind-mount whose source does not exist
yet is created by Docker as `root`, which locks the folder and makes every subsequent model
download fail. ComfyUI models live in `~/comfyui-spark/basedir/models/`, Ollama weights in
`~/ollama/data/`.

`BASE_DIRECTORY: /basedir` in the ComfyUI stack is not optional: without it ComfyUI ignores
`/basedir` and looks for its models in `/comfy/mnt/ComfyUI/models`. Neither are the
`--disable-pinned-memory --reserve-vram 8` flags (GB10 unified memory).

The Ollama service pulls `gemma4:e4b` on startup (`ollama pull` is idempotent, it won't
re-download a model that's already present); if needed, run it manually:

```bash
curl -X POST http://localhost:11434/api/pull -d '{"model":"gemma4:e4b"}'
```

**Important: model weights are NOT in the Git repository** (several dozen GB in total) —
download them manually into `~/comfyui-spark/basedir/models/<folder>/` according to the table below
(same URLs as `scripts/models.txt`, used by `install.sh`), before running a generation. For
LTX 2.5, see the `HF_TOKEN` section above (gated repository). The `docker/userscripts/*.sh`
userscripts (including `comfy_kitchen`) must be copied manually into the ComfyUI container's
`userscripts_dir` folder if you don't go through `install.sh`.

### Post-startup health checks

```bash
curl http://localhost:8090/                    # static app
curl http://localhost:8188/system_stats         # ComfyUI alive
curl http://localhost:11434/api/version          # Ollama alive
```

### Models to download

Each file goes into `~/comfyui-spark/basedir/models/<folder>/` (ComfyUI stack path; adjust
if your models live elsewhere). `install.sh` automatically downloads the 19 distinct files below from
`scripts/models.txt` (source of truth — same URLs, same order); the manual list that follows
is equivalent for anyone who prefers `curl`/a browser.

#### Current pipelines (Krea 2, Qwen-Edit, LTX 2.5, Minimax H3)

19 distinct files in 20 rows (the Qwen VAE serves both Qwen-Edit and Krea 2), URLs verified via an actual HTTP request against Hugging Face (`resolve/main/...`,
exact sizes in bytes in `scripts/models.txt`).

| Model / pipeline | File | Target folder | Size | URL |
|---|---|---|---|---|
| Qwen-Edit | `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | `diffusion_models/` | 19 GB | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors) |
| Qwen-Edit (encoder) | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `text_encoders/` | 8.7 GB | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors) |
| Qwen-Edit (VAE, shared with Krea 2) | `qwen_image_vae.safetensors` | `vae/` | 243 MB | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors) |
| Qwen-Edit (Lightning 4-step LoRA) | `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors` | `loras/` | 810 MB | [resolve/main](https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors) |
| Krea 2 (transformer) | `krea2_turbo_fp8_scaled.safetensors` | `diffusion_models/` | 13 GB | [resolve/main](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors) |
| Krea 2 (encoder) | `qwen3vl_4b_fp8_scaled.safetensors` | `text_encoders/` | 4.9 GB | [resolve/main](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors) |
| Krea 2 (VAE, shared with Qwen-Edit) | `qwen_image_vae.safetensors` | `vae/` | 243 MB | [resolve/main](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors) |
| LTX 2.5 (distilled transformer) ⚠️ gated | `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` | `diffusion_models/` | 21 GB | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors) |
| LTX 2.5 (video VAE) ⚠️ gated | `ltx-2.5-video-vae-bf16.safetensors` | `vae/` | 1.4 GB | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-bf16.safetensors) |
| LTX 2.5 (audio VAE) ⚠️ gated | `ltx-2.5-audio-vae-bf16.safetensors` | `vae/` | 348 MB | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors) |
| LTX 2.5 (main encoder) ⚠️ gated | `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` | `text_encoders/` | 15 GB | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors) |
| LTX 2.5 (prompt-enhancer encoder) | `gemma4_e2b_it_bf16.safetensors` | `text_encoders/` | 9.6 GB | [resolve/main](https://huggingface.co/Comfy-Org/gemma-4/resolve/main/text_encoders/gemma4_e2b_it_bf16.safetensors) |
| LTX 2.5 (x2 latent upscaler, t2v/i2v only) ⚠️ gated | `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | `latent_upscale_models/` | 950 MB | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors) |
| Minimax H3 t2v/i2v (transformer) ⚠️ community reupload | `minimax_h3_fl2va_pruned_w4a8_mixed.safetensors` | `diffusion_models/` | 11.7 GB | [resolve/main](https://huggingface.co/AX1Y2JP/MiniMax-H3-W4A8-ConvRot/resolve/main/minimax_h3_fl2va_pruned_w4a8_mixed.safetensors) |
| Minimax H3 r2v (transformer, different checkpoint) ⚠️ community reupload | `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors` | `diffusion_models/` | 11.7 GB | [resolve/main](https://huggingface.co/AX1Y2JP/MiniMax-H3-W4A8-ConvRot/resolve/main/minimax_h3_ref2va_pruned_w4a8_mixed.safetensors) |
| Minimax H3 (encoder) | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | 15 GB | [resolve/main](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors) |
| Minimax H3 (video VAE) | `minimax_h3_video_vae_fp16.safetensors` | `vae/` | 4.9 GB | [resolve/main](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors) |
| Minimax H3 (audio VAE) | `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | 578 MB | [resolve/main](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) |
| Minimax H3 (turbo LoRA, t2v/i2v/r2v) ⚠️ community reupload | `minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors` | `loras/H3/` | 592 MB | [resolve/main](https://huggingface.co/koongrizzly/MiniMax_H3_int4_W4A8_ConvRot_Pruned/resolve/main/loras/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors) |
| Minimax H3 (4-step turbo LoRA, t2v/i2v only — required for the 4-step option in the UI) | `minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors` | `loras/H3/` | 1.9 GB | [resolve/main](https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors) |

> **Caveat 1 — LTX 2.5 "gated"** (5 files marked ⚠️ gated above): the
> [`Lightricks/LTX-2.5`](https://huggingface.co/Lightricks/LTX-2.5) repository is
> access-restricted on Hugging Face — an anonymous download fails with a 401 until you've
> accepted the model's terms with an HF account **and** supplied an access token
> (`HF_TOKEN=<token> ./install.sh`, see the Deployment section above). This isn't a URL
> problem: the links are correct, access is simply gated by HF.
>
> **Caveat 2 — Minimax H3 "community reupload"** (3 files marked ⚠️ above): the 2 quantized
> `w4a8_mixed` checkpoints (`AX1Y2JP/MiniMax-H3-W4A8-ConvRot`) and the turbo LoRA
> (`koongrizzly/MiniMax_H3_int4_W4A8_ConvRot_Pruned`) do **not** come from an official
> Comfy-Org/Minimax repository, but from community reuploads. The filename and exact size
> match the expected specs and were verified via an actual HTTP request, but the integrity
> of the content is backed only by the repository's reputation/traction (tens of thousands
> of downloads), not by an official publisher. Worth noting before relying on it in
> production — without this being a red flag in itself.

> **Legacy models** (Flux2 Klein 9B, Ernie-Image, Z-Image, LTX 2.3): no longer used by the
> app (:8090), but still referenced by the drag-and-drop UI workflows `workflows/*.json`
> (`campaign_generator.json`, `storyboard_animatic.json`, `ernie_turbo.json`, `ernie_quality.json`,
> `localized_assets.json`) — see `workflows/README.md` if you still want to load them
> directly into ComfyUI.

### Required Ollama model

`gemma4:e4b` — pulled automatically when the `ollama` service starts (see above), or
manually:

```bash
curl -X POST http://localhost:11434/api/pull -d '{"model":"gemma4:e4b"}'
```

### Canvas mode (node editor)

In addition to the `index.html` form, the application offers a second mode: `canvas.html`, a
ComfyUI-style node editor (drag-and-drop cards, visual wiring). Accessible via
`http://<host>:8090/canvas.html`, or via the "Canvas" button in the header of the main
interface. This is an additional mode — it doesn't replace the `index.html` form, the two
coexist and share the same origin (no extra nginx/Docker configuration is needed). A drawer
docked at the bottom of the screen gives access to the generation history (Images/Videos
tabs), and a thumbnail can be dragged onto a "Media import" card to reuse it directly.

### `comfy_kitchen` acceleration (DGX Spark / ARM64)

The `ModelAttentionBackend` attention-acceleration node (value `comfy kitchen attention`) is
wired in right after the model loader in the `workflows/api/*.json` templates for the 4
model families (Krea 2, LTX 2.5, Minimax H3, Qwen-Edit). The `comfy_kitchen` package itself
is installed and kept up to date **automatically** by `install.sh`, via the
`docker/userscripts/15-comfy_kitchen-DGX_Spark.sh` userscript deployed in the ComfyUI
container — nothing to install manually. This acceleration is specific to ARM64/DGX Spark
hardware (compiled from source when the container starts, idempotently); on any other
architecture the userscript cleanly disables itself (immediate `exit 0`) without blocking
startup.

## Update

Deployments made from this commit onward (or from a later one) include an automatic update
check: when Studio (`index.html`) or Canvas (`canvas.html`) loads in the browser, the app
checks whether a newer version is available on GitHub. If one is, a popup offers to install
it; if you agree, the update downloads and applies automatically (`git pull` in the
background), then a second popup prompts you to refresh the browser.

**Older deployments** (installed before this feature was introduced, so without the
`updater` service): a one-time manual update is required to get the feature itself —
subsequent updates can then be done from the UI:

```bash
cd ai-content-studio
git pull origin main
docker compose up -d --build
```

`--build` is required here: it's what builds and starts the new `updater` service, which
didn't exist yet on this deployment.

## The 3 scenarios (see spec `ai_content_studio_media_entertainment_gb10.md`)

| Scenario | Dedicated pipelines | Deliverables |
|---|---|---|
| **Campaign Generator** | `campaign_full` (one job) + generic pipelines | 2:3 posters, 16:9 thumbnails, 1:1 social, vertical video teaser with audio |
| **Storyboard + Animatic** | `storyboard_v2` (charsheet+locsheet+keyframes+cuts), `reference2video` (Minimax H3, a single job), `sequence2video` (manual FLF2V) | N-shot storyboard + assembled animatic, OR a single video with a consistent character+setting, OR a manual first-frame→last-frame animatic, with audio |
| **Localized Assets** | image2image + target markets | Per-market variants (North America, Europe, Middle East, Asia…) via Qwen-Edit |

A **role-based navigation** layer (Director/Storyboard artist, Art director/Motion designer,
Social media/Marketing, Editor/Post-production) preselects scenario + pipeline without
changing the routing above.

Generic pipelines available everywhere: text2image (Krea 2 Turbo), image2image (Qwen-Edit
2509), text2video and image2video (LTX 2.5 and Minimax H3, selectable in the Model menu;
optional native audio, Minimax H3 turbo can be toggled on).

**Style LoRAs**: text2image, text2video, image2video and reference2video (Minimax H3) offer an
optional style-LoRA selector, in both Studio and Canvas. The list is discovered live from
whatever `.safetensors` files sit under `loras/Krea2/`/`loras/H3/` on disk (no hand-picked
allowlist) — new files can be added straight from Studio's Model Management panel (browser
upload only, no download-by-URL).

## Directory layout

```
index.html                  ← form mode (CSS + HTML + JS)
canvas.html                 ← node-editor mode (ComfyUI-style)
js/                         ← canvas mode engine (engine.js, nodes-simple.js, nodes-advanced.js)
install.sh                  ← one-command idempotent install/update (recommended)
docker-compose.yml          ← app only: nginx (8090) + updater (8093)
docker/stacks/*.yml         ← templates for the sibling stacks: ~/comfyui-spark and ~/ollama
docker/userscripts/         ← scripts deployed into the ComfyUI container by install.sh (including comfy_kitchen)
scripts/models.txt          ← 20 lines, 19 distinct required models: folder|file|size|URL (source of truth for install.sh and the README)
workflows/
  manifest.json             ← feeds the app's Pipeline/Model menus
  api/*.json                ← single-branch API templates with {{PROMPT}}… placeholders
  *.json                    ← full UI-format workflows (drag-and-drop into ComfyUI)
  README.md                 ← workflow details
tools/convert.py            ← UI→API converter (see docs/TESTING.md)
docs/
  INSTALL.md                ← install.sh user guide: modes, options, Hugging Face token, uninstall
  TROUBLESHOOTING.md        ← install/deploy troubleshooting: symptoms, diagnosis, repair, clean reinstall
  TROUBLESHOOTING.fr.md     ← same guide in French
  ARCHITECTURE.md           ← anatomy of the app and its formats
  LESSONS.md                ← pitfalls & validated patterns (READ BEFORE MODIFYING)
  TESTING.md                ← validation method (real renders, frame/audio extraction)
ai_content_studio_media_entertainment_gb10.md   ← original functional spec
dell_ai_content_studio_prototype.html           ← old prototype (legacy, unused)
```

## Picking the project back up

1. Read `CLAUDE.md` (conventions and commands), then `docs/LESSONS.md` **before making any changes to ComfyUI graphs** — the pitfalls documented there are costly to rediscover the hard way.
2. Any change to generation must be validated with an **actual render** AND a **visual/audio inspection** of the result (method in `docs/TESTING.md`) — a "success" job status can still produce wrong content.
3. The UI is checked with headless Chromium (multi-resolution screenshots, light/dark themes) — see `docs/TESTING.md`.
