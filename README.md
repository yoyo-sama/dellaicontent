🇫🇷 [Lire en français](README.fr.md)

# Dell AI Content Studio — Media & Entertainment demo on GB10

**Current version: 1.2.0** — see `TOUR-DE-CONTROLE-CHANGELOG.md` for the change history.

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

> **Something not working, or a machine where a previous install was attempted?**
> → **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — symptom → cause table, diagnosis
> in three commands, step-by-step reinstall on an already-installed machine, and clean reset.

`install.sh` does everything in a single command, **idempotently** (safe to re-run, tested
across two consecutive runs):

1. Checks the environment (architecture, `docker`/`docker compose`, NVIDIA runtime).
2. Detects the 3 services (web app `:8090`, ComfyUI `:8188`, Ollama `:11434`) **by actual
   role** (HTTP health check), not by container name — reuses anything already running,
   **including an Ollama installed natively (systemd), which is not a container**, and never
   recreates/destroys a service it doesn't own (checked via docker-compose labels). Whatever
   is missing is created in its own stack at the root of the home directory
   (`~/comfyui-spark`, `~/ollama`) from the `docker/stacks/*.yml` templates, with their folders
   created as the user BEFORE the containers. If a port is held by a service that does not
   answer, nothing is created and the script says what to free — instead of letting Docker
   fail on "port is already allocated". A service that is **installed but stopped** is
   restarted rather than duplicated: a stopped container is started again (`docker start`),
   and a native Ollama (systemd) is started via `sudo -n systemctl start ollama` — never
   blocking on a password prompt: if passwordless sudo is not available, the script prints
   the command to run and creates nothing. An install made with the old layout (`comfyui`/`ollama`
   services inside the app compose file) is migrated automatically.
3. Copies `docker/userscripts/*.sh` (including the `comfy_kitchen` install script, see
   below) into the actual `userscripts_dir` folder of the ComfyUI container in use.
4. Downloads the models listed in `scripts/models.txt` that are missing, into
   `~/comfyui-spark/basedir/models/<folder>/` (automatically skipped if the file is already present
   with the correct size — no unnecessary re-downloading).
5. Pulls the `gemma4:e4b` Ollama model if it's missing, **through the HTTP API**
   (`POST /api/pull`) rather than `docker exec`: same behaviour whether Ollama runs in a
   container or natively.
6. Waits for ComfyUI to answer on `:8188` when it has just been created (first start takes
   several minutes to install the userscripts), then displays a final summary (service
   status, actual locations, models, health checks).

The script's output and code comments are in English.

**`HF_TOKEN` (Hugging Face token, optional but required for LTX 2.5)**: the 4 LTX 2.5 model
files come from a **"gated"** (access-restricted) Hugging Face repository — an anonymous
download fails with a 401 until you've accepted the model's terms. To get them:

1. Create an account on [huggingface.co](https://huggingface.co/) if you don't have one.
2. Accept the access terms on the model page:
   [huggingface.co/Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5).
3. Generate an access token in your HF account settings (Settings → Access Tokens).
4. Re-run the installation with the token as an environment variable:

```bash
HF_TOKEN=<votre_jeton> ./install.sh
```

Without `HF_TOKEN`, the other models (Krea 2, Qwen-Edit, Minimax H3) download normally — only
the 4 LTX 2.5 files fail cleanly and are reported in the final summary, without blocking the
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

ComfyUI only listens on `127.0.0.1` (remote access to its UI goes through `:8090/comfy/`); an existing install must carry these 3 changes over by hand into `~/comfyui-spark/compose.yaml` (port `"127.0.0.1:8188:8188"`, `SECURITY_LEVEL: normal`, `--enable-cors-header` removed from `COMFY_CMDLINE_EXTRA`), since `install.sh` only copies the template when it is missing.

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
if your models live elsewhere). `install.sh` automatically downloads the 22 files below from
`scripts/models.txt` (source of truth — same URLs); the manual list that follows
is equivalent for anyone who prefers `curl`/a browser.

#### Current pipelines (Krea 2, Qwen-Edit, Qwen Image 2.1, LTX 2.5, Minimax H3)

22 files, URLs verified via an actual HTTP request against Hugging Face (`resolve/main/...`,
exact sizes in bytes in `scripts/models.txt`).

| Model / pipeline | File | Target folder | Size | URL |
|---|---|---|---|---|
| Qwen-Edit | `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | `diffusion_models/` | 19 GB | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors) |
| Qwen-Edit (encoder) | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `text_encoders/` | 8.7 GB | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors) |
| Qwen-Edit (VAE, shared with Krea 2) | `qwen_image_vae.safetensors` | `vae/` | 243 MB | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors) |
| Qwen-Edit (Lightning 4-step LoRA) | `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors` | `loras/Qwen/` | 810 MB | [resolve/main](https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors) |
| Krea 2 (transformer) | `krea2_turbo_fp8_scaled.safetensors` | `diffusion_models/` | 13 GB | [resolve/main](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors) |
| Krea 2 (encoder) | `qwen3vl_4b_fp8_scaled.safetensors` | `text_encoders/` | 4.9 GB | [resolve/main](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors) |
| LTX 2.5 (distilled transformer) ⚠️ gated | `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` | `diffusion_models/` | 21 GB | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors) |
| LTX 2.5 (video VAE) ⚠️ gated | `ltx-2.5-video-vae-bf16.safetensors` | `vae/` | 1.4 GB | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-bf16.safetensors) |
| LTX 2.5 (audio VAE) ⚠️ gated | `ltx-2.5-audio-vae-bf16.safetensors` | `vae/` | 348 MB | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors) |
| LTX 2.5 (main encoder) ⚠️ gated | `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` | `text_encoders/` | 15 GB | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors) |
| LTX 2.5 (prompt-enhancer encoder) | `gemma4_e2b_it_bf16.safetensors` | `text_encoders/` | 9.6 GB | [resolve/main](https://huggingface.co/Comfy-Org/gemma-4/resolve/main/text_encoders/gemma4_e2b_it_bf16.safetensors) |
| LTX 2.5 (x2 latent upscaler, t2v/i2v only) ⚠️ gated | `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | `latent_upscale_models/` | 950 MB | [resolve/main](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors) |
| Minimax H3 t2v/i2v (transformer) ⚠️ community reupload | `minimax_h3_fl2va_pruned_w4a8_mixed.safetensors` | `diffusion_models/` | 12 GB | [resolve/main](https://huggingface.co/AX1Y2JP/MiniMax-H3-W4A8-ConvRot/resolve/main/minimax_h3_fl2va_pruned_w4a8_mixed.safetensors) |
| Minimax H3 r2v (transformer, different checkpoint) ⚠️ community reupload | `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors` | `diffusion_models/` | 11 GB | [resolve/main](https://huggingface.co/AX1Y2JP/MiniMax-H3-W4A8-ConvRot/resolve/main/minimax_h3_ref2va_pruned_w4a8_mixed.safetensors) |
| Minimax H3 (encoder) | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | 15 GB | [resolve/main](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors) |
| Minimax H3 (video VAE) | `minimax_h3_video_vae_fp16.safetensors` | `vae/` | 4.9 GB | [resolve/main](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors) |
| Minimax H3 (audio VAE) | `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | 578 MB | [resolve/main](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) |
| Minimax H3 (turbo LoRA, t2v/i2v/r2v) ⚠️ community reupload | `minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors` | `loras/H3/` | 592 MB | [resolve/main](https://huggingface.co/koongrizzly/MiniMax_H3_int4_W4A8_ConvRot_Pruned/resolve/main/loras/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors) |
| Minimax H3 (4-step turbo LoRA, t2v/i2v only — required for the 4-step option in the UI) | `minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors` | `loras/H3/` | 1.9 GB | [resolve/main](https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors) |
| Qwen Image 2.1 (transformer) | `qwen_image_2.1_int8_convrot.safetensors` | `diffusion_models/` | 6.8 GB | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors) |
| Qwen Image 2.1 (encoder) | `qwen3vl_8b_int8_convrot.safetensors` | `text_encoders/` | 8.7 GB | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors) |
| Qwen Image 2.1 (VAE) | `qwen_image_2.1_vae_bf16.safetensors` | `vae/` | 644 MB | [resolve/main](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors) |

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

### Minimum ComfyUI version

`workflows/manifest.json` declares the oldest ComfyUI the shipped models need
(`"comfyui": { "min": "0.37.0" }` — the version installed for Qwen Image 2.1). When Studio or
Canvas loads and the running ComfyUI is older, a single confirmation offers to update it to the
latest stable release through the ComfyUI-Manager (proxied at `/comfy/v2/manager/`). Accepting
restarts ComfyUI (about 30 s) and interrupts running jobs, so the update is refused while the
queue is not empty. Declining silences the prompt for the browser session. To go back to the
previous version (the prompt shows the exact command, tag = `v` + old version):

```bash
git -C ~/comfyui-spark/run/ComfyUI checkout <old tag, e.g. v0.36.0> && docker restart comfyui-nvidia
```

## The 3 scenarios (see spec `ai_content_studio_media_entertainment_gb10.md`)

| Scenario | Dedicated pipelines | Deliverables |
|---|---|---|
| **Campaign Generator** | `campaign_full` (one job) + generic pipelines | 2:3 posters, 16:9 thumbnails, 1:1 social, vertical video teaser with audio |
| **Storyboard + Animatic** | `storyboard_v2` (charsheet+locsheet+keyframes+cuts), `reference2video` (Minimax H3, a single job), `sequence2video` (manual FLF2V) | N-shot storyboard + assembled animatic, OR a single video with a consistent character+setting, OR a manual first-frame→last-frame animatic, with audio |
| **Localized Assets** | image2image + target markets | Per-market variants (North America, Europe, Middle East, Asia…) via Qwen-Edit |

A **role-based navigation** layer (Director/Storyboard artist, Art director/Motion designer,
Social media/Marketing, Editor/Post-production) preselects scenario + pipeline without
changing the routing above.

### The storyboard studio

`storyboard_v2` and `reference2video` always run through a **step-by-step review** in a
full-screen studio — there is no auto mode, and nothing is ever sent to render without a click.

- **Subject and location sheets.** Two structured sheets are written by the local LLM, then
  rendered by Krea 2 as multi-view reference sheets. Every field stays editable, every sheet
  keeps a history of variants you can switch between, and a sheet can be replaced by an image
  of your own. The LLM decides whether a subject is a person or something else (animal,
  creature, robot, object), which you can correct in one click; the sheet's vocabulary and its
  anti-anthropomorphic guard follow that choice.
- **Sheet layout picker.** Five layouts (turnaround + expressions + costume, expression column
  + props, large portrait + head row, large portrait + garment flats, action poses + gear),
  chosen from thumbnails that draw their own box layout.
- **Several subjects per storyboard.** Subjects are added one at a time as empty slots you
  describe yourself. Each shot tags which subjects it anchors — at most two plus the location,
  a hard ceiling set by the three image inputs of the anchoring node.
- **Editable shot list.** Camera, light, action, emotion, duration and free details per shot,
  with the keyframe rendered next to the shot it illustrates, regenerable and lockable.
- **Editable prompts everywhere.** Both sheets, every keyframe, every cut and every shot action
  open the same editor showing the text actually sent to the graph. What you apply goes in
  **verbatim** and is kept with the project; re-enrichment by the local LLM never touches the
  structural parts of the prompt, which the app restores itself.
- **Cut engine.** LTX 2.5 by default, or Minimax H3 with its structured prompt grammar, stored
  per cut.
- **Prompt Relay.** One to ten chained segments, linked either continuously (the previous
  segment's exact frame carries over) or as a cut. On the H3 engine a scenario composer splits
  a screenplay across the segments; any segment can be re-rendered on its own, its transition
  frame picked among the last five, and given an end frame (FL2VA).

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
scripts/models.txt          ← 22 required models: folder|file|size|URL (source of truth for install.sh and the README)
workflows/
  manifest.json             ← feeds the app's Pipeline/Model menus
  api/*.json                ← single-branch API templates with {{PROMPT}}… placeholders
  *.json                    ← full UI-format workflows (drag-and-drop into ComfyUI)
  README.md                 ← workflow details
tools/convert.py            ← UI→API converter (see docs/TESTING.md)
docs/
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
