# install.sh — installer user guide

`install.sh` installs, repairs, updates or uninstalls AI Content Studio on a Dell GB10 /
NVIDIA DGX Spark (ARM64). This has been the installer since version 1.1.0, replacing the
previous one (v1, retrievable with `git show 1322acb:install.sh`). Every run starts
with a read-only diagnosis, prints the plan it derives from that diagnosis, and acts only
after that. It is idempotent: running it again is always safe, and it is also
the best way to check an install.

This guide describes the script as it is written. `./install.sh --help` gives the short
version.

## 1. What it manages

Three Docker stacks, side by side in your home directory:

| Folder | Created from | Container(s) | Port |
|---|---|---|---|
| `~/ai-content-studio` (this repo) | `docker-compose.yml` | `ai-content-studio-web` (nginx, host network) and `ai-content-studio-updater` | 8090 |
| `~/comfyui-spark` | `docker/stacks/comfyui.yml`, copied to `compose.yaml` | `comfyui-nvidia` | 8188 |
| `~/ollama` | `docker/stacks/ollama.yml`, copied to `compose.yaml` | `ollama-api` | 11434 |

The browser only talks to `:8090`. nginx proxies `/comfy/` to ComfyUI, `/ollama/` to Ollama
and `/update/` to the updater. ComfyUI models live in `~/comfyui-spark/basedir/models`, or
wherever the running ComfyUI mounts `/basedir`. Ollama weights live in `~/ollama/data`.

The rules the script follows:

- A service that already answers is reused, whoever installed it. A stopped one is started,
  never duplicated. A port held by something that does not answer is left alone.
- Stack folders are created as you, before any container starts. If a bind-mount source
  is missing, Docker creates it as `root`, and the folder is then locked.
- It never asks for your password. The only `sudo` it runs is `sudo -n`, to start a native
  Ollama (§10). `sudo -n` cannot prompt. Anything else that needs root is printed for you to
  run.
- It never deletes a model, a volume, an image, a network or a folder. The only containers
  it removes are ones this repository created: old-layout containers, or containers you
  confirm during an uninstall.
- It never modifies a container it did not create. The one exception is the third-party
  ComfyUI takeover, which needs your confirmation (§9).

## 2. Requirements

Run the script from a clone of this repository. It reads `docker-compose.yml`,
`docker/stacks/`, `docker/userscripts/`, `scripts/models.txt` and `tools/validate.py` from its
own directory. It `cd`s into that directory first, so `~/ai-content-studio/install.sh` works
from anywhere. Do not copy the script elsewhere on its own.

```bash
git clone https://github.com/yoyo-sama/dellaicontent.git ~/ai-content-studio
cd ~/ai-content-studio
```

Run it as your normal user, not with `sudo`. The stacks are created under that user's
`$HOME` and owned by that user.

Checked at start (`=== Preflight ===`):

| Check | If it fails |
|---|---|
| Architecture is `aarch64` | warning, continues anyway |
| `docker` is in `PATH` | `ERROR: 'docker' not found in PATH`, exit 1 |
| `docker compose` v2 plugin | `ERROR: the 'docker compose' v2 plugin is missing`, exit 1 |
| NVIDIA runtime (`docker info` mentions nvidia, or `nvidia-smi` exists) | `WARNING: cannot confirm nvidia-container-toolkit — GPU services may fail to start` |
| `scripts/models.txt` exists | warning, model steps skipped |

Needed but not checked:

- your user can run `docker` without `sudo`
- `curl`
- network access to Docker Hub, huggingface.co and the Ollama registry
- about 149 GB of disk for the full model set. The diagnosis shows how much is still needed
  and how much is free.
- `python3`, for `--smoke` only

The script never installs Docker, the NVIDIA driver or `nvidia-container-toolkit`.

## 3. First run: check, dry-run, then install

```bash
./install.sh --check      # diagnosis + plan + verification, changes nothing
./install.sh --dry-run    # also walks every step and prints "would …", changes nothing
./install.sh              # real run: plan, then "Proceed with this plan? [y/N]"
```

- `--check` and `--dry-run` never ask anything. The only file they write is their log.
  Both exit `2` when the verification fails (proxy endpoints, models on disk, models listed
  by ComfyUI, `gemma4:e4b` present in Ollama — §4 step 8), so they also work as a health
  check. A missing `gemma4:e4b` also shows up as a `pull` step in the plan.
- In their output, read the `state` line, any `BROKEN` line or plan step starting
  `not done by this installer`, the `gated` and `disk` lines, and every `docker rm -f` step
  of the plan.
- A real run can take hours because of the model downloads. Downloads show no progress
  bar. To watch one, list its target folder: `ls -l ~/comfyui-spark/basedir/models/<folder>/`.

Trimmed `--check` output on a machine that runs a third-party ComfyUI:

```
=== Diagnosis ===
  state    : FOREIGN COMFYUI — a ComfyUI this installer did not create answers on :8188
  comfyui  : 'comfyui-nvidia' (mmartial/comfyui-nvidia-docker:ubuntu24_cuda13.1-dgx-latest)
             compose file    : ~/comfyui-spark/compose.yaml   (not written by this installer)
             BASE_DIRECTORY  : /basedir
             lists           : 5 of the 5 diffusion model(s) present on disk
  ollama   : 'ollama-api' answers on :11434 — not created by this installer, reused as is
             Ollama is also used over HTTP by: open-webui
  web      : answers on :8090 (ai-content-studio-web)
  updater  : answers on :8090/update/status (ai-content-studio-updater)
  models   : 20/20 present in ~/comfyui-spark/basedir/models
  gated    : 5 of the 20 come from a gated repository (Lightricks/LTX-2.5) — all present
  disk     : about 0 GB still needed, 573 GB free on ~/comfyui-spark/basedir/models

=== Plan (mode: repair) ===
   1. reuse the third-party ComfyUI 'comfyui-nvidia' as it is — no file written, no container touched
   2. reuse the Ollama 'ollama-api' answering on :11434 — not created by this installer, left as it is
   3. reuse the web app answering on :8090
   4. write ~/ai-content-studio/.env with COMFY_LORAS_DIR=… and create …/models/loras (the updater uploads LoRAs there)
   5. rebuild and restart the updater (picks up updater changes from this repository): docker compose up -d --build updater
   6. gemma4:e4b is already present — nothing to pull
   7. prove it: 3 endpoints through :8090, models on disk, models listed by ComfyUI, gemma4:e4b present
```

## 4. How a run works

This describes the `fresh`/`repair` pipeline. `--mode uninstall` shares steps 1-3 but
replaces step 4 onward with its own section — see §11.

1. **Preflight**: the checks in §2.
2. **Fingerprint**: one read-only pass that collects:
   - the health endpoints (`:8188/system_stats`, `:11434/api/version`, `:8090/`,
     `:8090/update/status`)
   - running containers, found by published port
   - stopped containers, found by image
   - compose labels and mounts
   - a native Ollama
   - the `ollama-data` volume and who uses it
   - the model files and free disk

   The plan is built from this single snapshot.
3. **Diagnosis**: one headline state, then one line per component.
4. **Plan**: numbered steps, followed by `kept, never deleted: …`. A step runs only if the
   plan printed it. Skipped entirely for `--mode uninstall` (real run or `--dry-run`): the
   `Uninstall` section (§11) is the plan there.
5. **Confirmation**: `Proceed with this plan? [y/N] `. An empty answer means no. `--yes`
   skips the question, and so does running without a terminal (§12). If you refuse, the
   script prints `Nothing was changed.` and carries on exactly like `--check`: the same
   read-only verification (step 8) decides the exit code, never the headline — a healthy
   third-party ComfyUI, for example, is not `UP TO DATE` and still exits 0.
6. **Execution**, in this order: Hugging Face token (if needed, §7) → ComfyUI takeover (if
   planned, §9) → ComfyUI → Ollama → web app → `.env` and updater → models (§8) →
   `gemma4:e4b` (§10).
7. **`Models: before -> after`**: one line per entry of `scripts/models.txt` (§8).
8. **Verification**, through nginx like the browser:
   - `/comfy/system_stats`, `/ollama/api/version` and `/update/status` must return HTTP
     200. Each gets up to 3 tries, 3 s apart.
   - every model must be on disk
   - ComfyUI must list the diffusion models present on disk
   - when `/ollama/api/version` answered 200, Ollama must have `gemma4:e4b` — checked
     through the proxy's `/ollama/api/tags`, not the model-pull step of §10

   Then the `--smoke` render, if you asked for it (§13).
9. **Summary**: one line per component, then the app, models, Ollama and log locations,
   then either `Everything the app needs is in place.` or `N problem(s) above — the app
   cannot generate reliably yet.` (uninstall prints a different closing line — see §11).

### Headline states

The headline summarises the diagnosis for you. The plan itself is decided component by
component (next table), so a mixed machine is handled correctly whatever the headline says.

| State | Meaning | What the plan proposes |
|---|---|---|
| `VIRGIN` | No ComfyUI, no Ollama, no web app, no `~/comfyui-spark/compose.yaml`, no model in the old repo folder | Mode `fresh`: create both stacks, start the web app and updater, download the models, pull `gemma4:e4b` |
| `UP TO DATE` | The installer's own ComfyUI stack, web app and updater all answer, all models are present and listed by ComfyUI, `gemma4:e4b` is present, Ollama answers | Reuse everything. Like every real run, it still rewrites `.env` and rebuilds the updater. |
| `OLD LAYOUT (pre-1.0.7)` | A ComfyUI or Ollama container (running or stopped) created by this repository's own `docker-compose.yml`, or model files left in `~/ai-content-studio/comfyui/basedir/models` | Copy the Ollama weights from the `ollama-data` volume into `~/ollama/data` (the volume is kept). `docker rm -f` the inherited containers: a stopped one is migrated, never restarted. Recreate them as the `~/comfyui-spark` and `~/ollama` stacks. Move the model files (§8). |
| `PARTIAL OR BROKEN` | Anything else: a part is missing, stopped or not answering | Decided per component, see below |
| `FOREIGN COMFYUI` | The ComfyUI on :8188, or `~/comfyui-spark/compose.yaml`, was not written by this installer. Takes priority over every other state. | Reuse it untouched. Propose a takeover if it cannot see the models (§9). Ask before starting a third-party compose file. |

Whether a ComfyUI was "written by this installer" is decided by content, not by path.
`~/comfyui-spark/compose.yaml` counts as the installer's only if it contains `${WANTED_UID`
and has a `.env` next to it.

### Per-component decisions

| Detected | ComfyUI (:8188) | Ollama (:11434) |
|---|---|---|
| Answers, in a container | reused, not recreated | reused, not recreated |
| Answers, no container visible (native or unmanaged) | reused as is | reused as is |
| Stopped container (image `mmartial/comfyui-nvidia-docker` / `ollama/ollama`) | `docker start` | `docker start` |
| `ollama` command or `ollama.service` unit present, not answering | — | the script tries to start the service (§10) |
| The installer's `compose.yaml`, but no container | `docker compose up -d` in `~/comfyui-spark` | — |
| A third-party `compose.yaml`, but no container | the script asks before starting it (§9) | — |
| Port held by a process that does not answer | nothing created: `SKIPPED (port 8188 busy)` | nothing created: `SKIPPED (port 11434 busy)` |
| Nothing | the stack is created | the stack is created |

Creating a stack takes these steps:

1. Create the bind-mount folders as you.
2. ComfyUI only: write a `.env` with your UID and GID, if none exists.
3. ComfyUI only: copy the userscripts into `userscripts_dir` before the first start.
4. Copy the template to `compose.yaml`. An existing `compose.yaml` is never overwritten.
5. Run `docker compose up -d`.
6. Wait for the service: up to 15 min for ComfyUI (its first start installs the userscripts),
   30 s for Ollama.

Web app: reused if `:8090` answers. Otherwise the script runs
`docker compose up -d ai-content-studio`. Every real run then rewrites
`~/ai-content-studio/.env` with a single line, `COMFY_LORAS_DIR=<models>/loras`, creates
that folder, and rebuilds the updater with `docker compose up -d --build updater`.

## 5. Modes

| Mode | When | What it does |
|---|---|---|
| `fresh` | chosen automatically on `VIRGIN`, or forced with `--mode fresh` | the pipeline in §4 |
| `repair` | chosen automatically on every other state, or forced with `--mode repair` | the same pipeline |
| `uninstall` | only with `--mode uninstall` | §11 |

`fresh` and `repair` differ only in the plan header. `--mode fresh` wipes nothing and
reinstalls nothing: the plan still comes from what is detected.

`--check` and `--dry-run` override `--mode`, in any order. For `fresh`/`repair` the forced
mode only shows up in the plan header. `--mode uninstall` is different: no install-style
plan is printed at all, in a real run or `--dry-run` — the `Uninstall` section (§11) is the
whole output, and `--dry-run` turns every `docker rm -f` there into `would docker rm -f …`.

## 6. Options

| Option | Effect |
|---|---|
| *(none)* | Install, repair or update according to the plan. In a terminal, asks for confirmation first. |
| `--check` | Read-only: preflight, diagnosis, plan, models table, proxy verification. Asks nothing. Exits 0 or 2 according to the current state. |
| `--dry-run` | Read-only walk through the whole pipeline. Each action is printed as `would …`, and nothing is created, downloaded or removed (the Hugging Face token step and the ComfyUI takeover are the exception — see §16). With `--mode uninstall`, previews the removals. |
| `--mode M` | Forces the mode: `fresh`, `repair` or `uninstall`. Any other value prints `Unknown mode: M (fresh, repair or uninstall)` and exits 1. |
| `--skip-models` | No download from `scripts/models.txt` and no Hugging Face token prompt. The run still moves models out of the old folder, still pulls `gemma4:e4b`, and still exits 2 if models are missing. |
| `--yes` | Skips the plan confirmation. Also accepts the ComfyUI takeover, and during an uninstall removes every owned component in scope without asking. It does not answer the token prompt, the token-save question, or the question about starting a third-party compose file. |
| `--components L` | Uninstall only, ignored otherwise. A comma-separated subset of `web,updater,comfyui,ollama`, without spaces. Validated right after the options are parsed, in every mode: an unknown name prints `Unknown component in --components 'L': valid names are web, updater, comfyui, ollama (comma-separated)` and exits 1. |
| `--smoke` | After verification, runs a reduced real render (§13). With `--check` or `--dry-run`, the render is only announced. |
| `--log FILE` | Log file path. Default: `~/install-YYYY-MM-DD-HHMM.log`. The script appends to it. |
| `-h`, `--help` | Prints the usage block and exits 0. |

Any other argument prints `Unknown option: X (try --help)` and exits 1. Options can be given
in any order. `--mode`, `--components` and `--log` take the next word as their value.

Environment variables:

| Variable | Use |
|---|---|
| `HF_TOKEN` | Hugging Face token, checked first (§7). Read once at startup, then `unset` from the script's own environment — it never reaches a container or a child process (§7). |
| `HOME` | Every location is derived from it: `~/comfyui-spark`, `~/ollama`, the log, the token files. |

## 7. Hugging Face token

Five files in `scripts/models.txt` come from the gated repository
`huggingface.co/Lightricks/LTX-2.5/`. To download them you need a Hugging Face account that
has accepted the model's terms on [huggingface.co/Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5),
and an access token.

**When the script looks for a token**: only on a real run, without `--skip-models`, when at
least one gated file is missing or incomplete. The plan then shows
`ask for a Hugging Face token (N gated file(s) missing)`. The token is looked for after the
plan confirmation and before any download.

**Where it looks, in order (the first non-empty candidate wins — an empty or unreadable
cache file does not hide a token saved further down the list):**

1. `$HF_TOKEN`
2. `~/.cache/huggingface/token` (first line), the Hugging Face CLI's default location
3. `~/.config/ai-content-studio/hf_token` (first line)
4. Only in a terminal: the prompt `Hugging Face token (input hidden, Enter to skip): `.
   Nothing is echoed as you type. Pressing Enter skips it.

Without a terminal the prompt is never shown. The script prints instead:
`No TTY: the Hugging Face token prompt is skipped — set HF_TOKEN, or save a token to
~/.config/ai-content-studio/hf_token (mode 600).`

**Validation**: the token is checked against `https://huggingface.co/api/whoami-v2`, then:

- `OK: Hugging Face token valid (user: <name>)`, or
- `WARNING: Hugging Face token rejected by huggingface.co — continuing without it.` The
  same message appears when huggingface.co cannot be reached.

Without a token, the script prints
`WARNING: Continuing without a token: the N gated file(s) will fail cleanly and be reported.`
The other models still download. The gated files show as `FAILED … (gated: no Hugging Face
token)` and the run exits 2.

**Saving it (opt-in):** after a valid token that did not already come from the config file,
the script asks
`Save this token to ~/.config/ai-content-studio/hf_token (mode 600)? [y/N] `. The default
is no. Without a terminal the answer is always no. If you say yes, the directory is created
and the file written under `umask 077`, then explicitly `chmod 600`'d — so an existing
file's old permissions never survive a resave. A failure to write it prints
`WARNING: could not save the token to ~/.config/ai-content-studio/hf_token` and changes
nothing else.

**Where the token never goes:**

- It is never printed and never written to the log. Only the user name is shown.
- It never appears on a command line. It reaches `curl` on stdin (`-K -`), so `ps` cannot
  show it.
- It is never written to any `.env` file.
- It is never exported. `$HF_TOKEN` is read once at the very top of the script and then
  `unset`; the accepted token lives only in an internal, non-exported shell variable. A
  rejected token is not sent anywhere else either.
- It never reaches a container. The ComfyUI compose template does read `${HF_TOKEN:-}`, but
  since the script's own environment never carries `HF_TOKEN` past its first line, every
  stack this script creates or recreates — including a takeover (§9) — gets an empty value
  there. `docker inspect` on a container made by this script never shows a token.

**Removing it:**

A ComfyUI container created by *this* script never had the token to begin with — nothing to
do there. Only a container from an older installer, or started by hand, may still carry it:

```bash
rm ~/.config/ai-content-studio/hf_token      # the saved copy
unset HF_TOKEN                                # the current shell
# a ComfyUI container that WAS created with the token by an older installer:
cd ~/comfyui-spark && env -u HF_TOKEN docker compose up -d --force-recreate
```

## 8. Models

- **List**: `scripts/models.txt`, one `folder|file|size|URL` line per entry: 20 entries,
  19 distinct files (the Qwen VAE is listed twice), about 149 GB.
- **Location**: the folder the running ComfyUI mounts on `/basedir`, plus `/models`. When no
  ComfyUI container exists yet, the default is `~/comfyui-spark/basedir/models`. The
  location is read again once the services are up.
- **Always preserved**: no model file is ever deleted or overwritten. Files already present
  are skipped, incomplete ones resume (`curl -C -`), and the old folder is moved with
  `mv -n`. An uninstall keeps them all.
- **Size check**: a file is `OK` when its size is within ±1% of the size in `models.txt`,
  `INCOMPLETE` otherwise, and `MISSING` when it is absent or empty. A file truncated by less
  than 1% therefore passes. Only an inspected render proves a model works
  (`docs/TESTING.md`).
- **Downloads**: one silent `curl` per file. A failed download does not stop the others.
  Before downloading, the script prints
  `models to fetch: N file(s), about X GB — free space: Y GB`. If the space is insufficient
  it prints `WARNING: not enough free space for the missing models`, continues, and counts
  it as a problem.
- **Folder not writable**: the script prints
  `ERROR: model directory is not writable: <dir>`, then the `sudo chown -R …` command to run,
  and skips the models. When `~/comfyui-spark/basedir` belongs to someone else, the plan
  warns ahead of time with a step starting `not done by this installer, which never runs
  sudo — fix it yourself: …`.
- **Migration from the old location**: files in `~/ai-content-studio/comfyui/basedir/models`
  are moved one by one into the models folder, keeping their sub-folders. Moving is instant
  on the same filesystem, and moved files are not downloaded again. Watch for the line
  `  moved: N   left behind: M`. If `left behind` is not 0, the old folder is usually owned
  by root: run the printed `sudo chown -R …` command and run the script again. A file that
  already exists at the destination is a **duplicate**, never overwritten or deleted: the
  script reports it (`N file(s) already present in <dir>; the copy in <old> is a duplicate
  you may delete yourself`) and leaves both copies in place — a duplicate is not counted as
  work still to do, and does not keep the machine flagged `OLD LAYOUT`. The emptied old
  folder itself is left in place.
- **`--skip-models`**: nothing from `models.txt` is downloaded, but the migration above still
  runs.
- **Report**: the `Models: before -> after` table labels each entry:

  | Label | Meaning |
  |---|---|
  | `KEPT` | `(already in place)` |
  | `MOVED` | `(from the legacy repository folder)` |
  | `DOWNLOADED` | fetched during this run |
  | `FAILED` | `(download failed)`, `(gated: no Hugging Face token)`, or `(missing)` |
  | `MANUAL` | `(no URL in models.txt)` |

  The table ends with a totals line and the location. With `--check` and `--dry-run`, a
  missing file shows as `FAILED … (missing — this mode downloads nothing)`.

## 9. An existing ComfyUI you did not install

**It works with the app** (it lists the models on disk): the script reuses it as is. It
writes no ComfyUI file and touches no container. The models still go into the folder it
mounts on `/basedir`, and `loras/` is created there. The userscripts, including
`comfy_kitchen`, are only deployed into stacks the installer creates.

**It is misconfigured for the app**, and the diagnosis says `=> BROKEN for this application:
the models are there, ComfyUI does not offer them`, when all of these hold:

- it answers on :8188, in a container
- at least one `diffusion_models` file from `models.txt` is on disk with the right size
- ComfyUI's `UNETLoader` list names none of those files

The usual cause is a missing `BASE_DIRECTORY`. The plan then either proposes a **takeover**,
or — if the container cannot be safely taken over — says so and stops there.

**Whether a takeover is even offered** is decided once, while building the plan, against the
fingerprint alone (nothing is attempted and then refused: it is simply not offered). It is
blocked when:

- the container carries no compose labels (no compose project, no config file, no service —
  it was not created by `docker compose`)
- its `config_files` label lists more than one compose file (an override can only replay
  the container's own file, plus this installer's own override from an earlier takeover —
  more inputs would drop files and change the container)
- it mounts nothing on `/basedir` (an environment override has nowhere to point the models)
- an override already sits next to its compose file and was not written by this installer
  (the installer's own override has `written by install.sh` on its first line)

When blocked, the plan prints one line naming the reason, for example:

```
leave the third-party ComfyUI 'comfyui-nvidia' untouched: it mounts nothing on /basedir, so an environment override cannot point it at the models. It cannot be fixed automatically — see docs/TROUBLESHOOTING.md, section 2 (ComfyUI does not see the models)
```

and nothing else happens for ComfyUI that run — no confirmation is asked. Verification (§4
step 8) still finds it lists none of the models, so the run still exits 2.

**When a takeover is offered**, the plan looks like:

```
write ~/comfyui-spark/compose.override.yaml — environment keys only: BASE_DIRECTORY=/basedir, WANTED_UID=<uid>, WANTED_GID=<gid>; the image, ports, volumes and networks of the third-party file are left untouched
docker compose -p <project> -f ~/comfyui-spark/compose.yaml -f ~/comfyui-spark/compose.override.yaml up -d, in ~/comfyui-spark — acts on the THIRD-PARTY project '<project>' and recreates '<container>' in place, after an explicit confirmation. No byte of model data is moved or re-downloaded. Undo: rm ~/comfyui-spark/compose.override.yaml && docker compose -p <project> -f ~/comfyui-spark/compose.yaml up -d
```

The directory and file names above are an example, not an assumption: the takeover acts
**wherever the container's own compose file actually lives** — read from its compose label,
never assumed to be `~/comfyui-spark` — and the override is named after that file the way
Compose pairs the two (`compose.yaml` → `compose.override.yaml`, `docker-compose.yml` →
`docker-compose.override.yml`), so it is auto-loaded there on a later plain `docker compose
up -d` too.

The steps:

1. The script prints a field summary of the current definition — container, image, compose
   project, compose file, networks, mounts, `BASE_DIRECTORY`, `WANTED_UID`/`WANTED_GID`,
   models listed — all values already collected by the read-only fingerprint. It never runs
   `docker inspect` here and never prints the container's raw environment, so a secret
   sitting elsewhere in it (on the reference machine, a third-party Hugging Face token) is
   never read, shown or logged (§14).
2. It asks `Take over this ComfyUI (project '<project>', in <dir>)? Its N models stay
   exactly where they are. [y/N] `. `--yes` accepts. Without a terminal and without `--yes`,
   it refuses with `WARNING: third-party ComfyUI takeover needs a terminal, or --yes on the
   command line. Left untouched.`
3. It writes the override next to the container's own compose file. That file stays
   byte-for-byte unchanged:

   ```yaml
   # written by install.sh — remove this file to restore the original definition
   services:
     <service>:
       environment:
         BASE_DIRECTORY: /basedir
         WANTED_UID: "<your uid>"
         WANTED_GID: "<your gid>"
   ```

4. It runs `docker compose -p <project> -f <compose file> -f <override> up -d` in that
   directory. This **recreates the third-party container**, and anything else that uses it
   loses it until it answers again (up to 15 min wait). No model is moved or downloaded
   again.
5. It reads the state again and prints `OK: ComfyUI now offers: …`, or
   `WARNING: ComfyUI still lists none of the N diffusion model(s) present on disk`.

To undo it at any time (the script prints the same command):

```bash
rm <override> && docker compose -p <project> -f <compose file> up -d
```

If you decline, the script prints `WARNING: ComfyUI left exactly as it is. The application
will not see the models it has on disk.` and the run exits 2.

**A third-party `compose.yaml` with no container**: the script asks
`Start the third-party project 'comfyui-spark' from a compose file this installer did not
write? [y/N] `. Only a terminal can answer this, and `--yes` does not. Without a terminal
it prints `No TTY: refused. A third-party compose project is never started without an
explicit yes.` If you answer yes, the script runs `docker compose up -d` in that directory
and does nothing else: no folder is created, no `.env` is written, no userscript is copied,
and the `compose.yaml` is never modified — it is entirely a third-party project's file.

**Caution**: if that `compose.yaml`'s bind-mount source folders do not exist yet, Docker
creates them itself when the container starts, owned by `root` — the same padlock problem
described in §8, "Folder not writable".

## 10. Ollama

Detection comes first from the service (`:11434/api/version`), then from containers,
native install and port:

| Found | What the script does |
|---|---|
| Answers, in a container created from `~/ollama/compose.yaml` | reused |
| Answers, in any other container | reused as is, never restarted or recreated |
| Answers, no container visible (native service) | reused as is |
| Stopped container with image `ollama/ollama` | `docker start`, then waits up to 30 s. A container that stays silent is reported `restarted but silent`, and the script suggests `docker logs`. |
| `ollama` command in `PATH` or an `ollama.service` unit, not answering | tries to start the service (below). **No container is created.** |
| Port held by a process that does not answer | nothing created, `SKIPPED (port 11434 busy)` |
| Old-layout container | weights copied from the `ollama-data` volume through a throwaway `alpine` container, then the container is removed and recreated in `~/ollama` |
| Nothing | `~/ollama` stack created, weights in `~/ollama/data` |

**Starting a native service**: as root the script runs `systemctl start ollama.service`.
As any other user it runs `sudo -n systemctl start ollama.service`. `sudo -n` never
prompts: without passwordless sudo it fails at once, and the script prints:

```
WARNING: could not start the native ollama service (no passwordless sudo?)
    run it yourself, then run this script again:  sudo systemctl enable --now ollama.service
    no container was created, so two ollama instances never fight over port 11434
```

The summary then shows `SKIPPED (native install stopped)` and the run exits 2.

**Model**: the app needs `gemma4:e4b`. The script pulls it through the HTTP API
(`POST /api/pull`), which works the same for a container and a native install. It then
checks `/api/tags`, because a pull can fail and still answer 200. The possible messages are:

- `OK: gemma4:e4b already present`
- `OK: gemma4:e4b downloaded`
- `WARNING: gemma4:e4b pull failed`
- `WARNING: Ollama does not answer — cannot check or pull gemma4:e4b`, shown in the summary
  as `UNAVAILABLE (no Ollama)`

A failed pull or an unanswering Ollama makes the run exit 2. `--skip-models` does not skip
this step.

**Other users**: the diagnosis lists containers that mount the `ollama-data` volume, and
running containers configured to reach `:11434` (for example `open-webui`). The volume is
copied from, never removed.

## 11. Uninstall

```bash
./install.sh --mode uninstall --dry-run                          # preview, removes nothing
./install.sh --mode uninstall                                    # asks for each component
./install.sh --mode uninstall --components web,updater           # only these two, still asks
./install.sh --mode uninstall --yes --components web,updater     # unattended, no questions
```

Unlike `fresh`/`repair`, no install-style plan is printed first (§5): this section is the
whole output, in a real run and in `--dry-run` alike.

**Components**, processed in this order:

| Name | Container | Counted as ours when |
|---|---|---|
| `web` | whatever container answers on `:8090` (usually `ai-content-studio-web`) | its compose label's `config_files` is exactly `~/ai-content-studio/docker-compose.yml` |
| `updater` | found by compose label (project `~/ai-content-studio/docker-compose.yml`, service `updater`) — never by image name | same as above |
| `comfyui` | `comfyui-nvidia` | created by the installer's stack (content check, §4) or by the old layout |
| `ollama` | `ollama-api` | created from `~/ollama/compose.yaml` or by the old layout |

A component with no container is skipped. The `Uninstall` section prints two lists:

- `OURS — created by this installer, offered for removal:`
- `NOT ours — will not be touched:`, with each container's image and compose file. When
  `ollama` is in scope, this list also shows the containers that mount `ollama-data` and the
  containers that use Ollama over HTTP.

Then it prints warnings:

```
  ComfyUI and Ollama can serve other applications on this machine.
  Ollama is also used by: open-webui — removing the Ollama container cuts them off, even though its data stays
```

Each owned component gets its own question, and an empty answer means no:
`Remove ai-content-studio-web (nginx:alpine, from ~/ai-content-studio/docker-compose.yml)? [y/N] `.
Declined components are listed at the end under `containers left in place: …`.

**What is removed**: only `docker rm -f <container>`, for each container you accepted.

**What is always kept** (the section `=== Kept — nothing below was deleted ===` lists it
with sizes):

- models, and the ComfyUI `input/` and `output/` folders
- `workflows/` and the whole repository, including `.env`
- Ollama weights: `~/ollama/data` or the `ollama-data` volume
- the stack folders and everything in them: `compose.yaml`, `.env`, `compose.override.yaml`,
  userscripts
- the saved token `~/.config/ai-content-studio/hf_token`
- Docker images, volumes and networks. Docker itself, the NVIDIA driver and
  `nvidia-container-toolkit` are untouched too.
- every container not in the OURS list

The models size is the sum of the `models.txt` sizes of the files present, so it is instant.
Other folders are measured with `du`, capped at 20 s; after that the size shows as
`(not measured)`.

**Without a terminal**, both `--yes` and `--components` are required. Otherwise the script
prints `ERROR: uninstall needs a terminal, or --yes together with --components
(web,updater,comfyui,ollama).`, exits 1 and removes nothing.

> **Careful**: in a terminal, `--yes` alone removes every owned component (all four in
> scope) without asking.

**Exit code**: 0 when every accepted removal succeeded; a declined component is not a
failure. 2 if a `docker rm -f` failed. Uninstall does not verify the app afterwards. The
summary's closing line is uninstall-specific: `Uninstall finished: the data listed under
Kept is untouched.` on a clean real run, `Nothing was removed: this mode never removes
anything.` on `--dry-run`, or `N problem(s) above — not everything announced could be
removed.` when a removal failed.

The `Models: before -> after` table (§8) still prints after the `Uninstall` section, even
though nothing here touches a model file — each entry just reads its current state (`KEPT`
if the file is complete, `FAILED (missing)` otherwise), unchanged by the uninstall itself.

To reinstall, run `./install.sh` again. It reuses the stack files that were kept.

## 12. Running without a terminal

The script is interactive only when its **standard input** is a terminal. Redirecting
output (`| tee …`) changes nothing. These run it without a terminal:

- `ssh host 'cd ~/ai-content-studio && ./install.sh'` (add `-t` to get one)
- cron, CI runners, systemd units
- standard input redirected, for example `./install.sh </dev/null`
- piping into it

Answers cannot be piped in: `yes | ./install.sh` makes stdin a pipe, so every question gets
its default answer.

| Question | In a terminal | Without a terminal |
|---|---|---|
| Plan confirmation | asked; empty = no; `--yes` skips it | skipped: `No TTY: proceeding without confirmation.` |
| Hugging Face token prompt | asked if no token was found | skipped with a message (§7) |
| Token save | asked, default no | `  no TTY: answered no` |
| ComfyUI takeover | asked; `--yes` accepts | refused unless `--yes` |
| Start a third-party compose file | asked, even with `--yes` | always refused |
| Uninstall removals | asked per component; `--yes` = all in scope | needs `--yes --components`, else exit 1 |
| `--check`, `--dry-run` | never ask | never ask |

For unattended installs, save the token once in an interactive run by answering `y` to the
save question. Later runs without a terminal find it in `~/.config/ai-content-studio/hf_token`.
You can also export `HF_TOKEN` in the environment.

## 13. `--smoke`

`--smoke` adds a real render after the verification. The script runs:

```
COMFY_BASEDIR=<models folder without /models> python3 tools/validate.py workflows/api/krea2_t2i.json --reduce
```

`validate.py` does the following:

1. Checks the graph structurally, against the node list in `tools/object_info.json` and the
   model files on disk.
2. Fills the placeholders with defaults: prompt `cinematic wide shot, golden hour lighting,
   subtle camera movement, film grain`, seed 42, 1280×720, batch 1.
3. Submits the graph straight to ComfyUI on `:8188`.
4. Polls for the result every 5 s and gives up after 600 s.

It renders one Krea 2 image into ComfyUI's output folder, under `studio/`: by default
`~/comfyui-spark/basedir/output/studio/krea2_*.png` (the graph's `SaveImage` prefix). It
needs the three Krea 2 files (about 18.6 GB). The only bound on how long it takes is the
600 s poll timeout below (`validate.py`'s default, not overridden by the installer) — that
includes any time spent loading those weights if ComfyUI has not loaded them yet.

`validate.py` prints its own `[OK]` / `[FAIL]` lines and a `=== Summary ===`. The installer
then prints `OK: smoke render succeeded` or `WARNING: smoke render failed — see the output
above`, and the summary shows `smoke OK` or `smoke FAILED`. A failure makes the run exit 2.

The script prints this note with the smoke test:

```
      note: --smoke talks to ComfyUI directly on :8188. It proves ComfyUI + models + disk,
            but NOT the nginx proxy. The three :8090 checks above are what prove the proxy.
            Both are needed; neither replaces the other.
```

With `--check` and `--dry-run`, the render is announced as `would …` and not run.
Uninstall never runs it.

## 14. Logs

- **Location**: `~/install-YYYY-MM-DD-HHMM.log` (for example
  `~/install-2026-09-11-0942.log`), or the file given with `--log`. The script appends to
  it, so two runs started in the same minute share one file. Every mode writes a log,
  `--check` and `--dry-run` included. `--help` and invalid arguments do not.
- **Content**: everything shown on screen (stdout and stderr): diagnosis, plan, questions,
  actions, the `docker compose up -d` output of the ComfyUI and Ollama stacks, the
  `validate.py` output, and the summary. The updater's `docker compose up -d --build`
  output is appended to the log rather than shown on screen (it can run to pages); on
  failure the script points at the log instead of dumping it there. The web app's compose
  output is discarded entirely.
- **Never in it**: the Hugging Face token. It is typed without echo, never printed, and sent
  to `curl` on stdin. Of the whoami answer, only the user name is logged.
- **Takeover**: what gets logged is the fingerprinted field summary described in §9 —
  container, image, compose project/file, networks, mounts, `BASE_DIRECTORY`,
  `WANTED_UID`/`WANTED_GID`, models listed — never a raw `docker inspect`. A secret sitting
  elsewhere in the third-party container's environment is never read, shown or logged.

To find the lines that matter:

```bash
grep -nE 'WARNING|ERROR|FAILED|SKIPPED' ~/install-*.log
```

## 15. Exit codes

| Code | Meaning |
|---|---|
| `0` | Nothing wrong was found. Install: everything the app needs is in place. `--check` / `--dry-run`: the verification passed. Uninstall: every accepted removal succeeded. |
| `1` | Usage or prerequisite error: unknown option or mode, `docker` or `docker compose` v2 missing, or an uninstall without a terminal and without `--yes --components`. |
| `2` | The run finished, but the app cannot generate: a service missing, stopped, silent or skipped; models missing or incomplete; `gemma4:e4b` unavailable; the Ollama model missing; a proxy check not HTTP 200; ComfyUI listing none of the models on disk; not enough disk space; a takeover declined, blocked or ineffective; smoke render failed; a refused plan that still fails the read-only proof (exactly like `--check`); `~/comfyui-spark/basedir` not owned by you; a `docker rm -f` failure during an uninstall. |

## 16. Known limitations

These are the user-visible limitations still true of this version — not bugs already fixed,
just corners it deliberately cuts:

- **`--dry-run` does not rehearse the Hugging Face token prompt or the ComfyUI takeover.**
  Both are described as plan lines, but the functions that actually run them
  (`hf_token_acquire`, `takeover_comfyui`) are only called on a real run — `--dry-run` never
  invokes them, not even to print a `would …` line. To see either in action, run for real.
- **In install/repair mode, any container publishing `:8090` is taken to be the web app.**
  The fingerprint just asks "does anything answer on `:8090`" and reuses whatever does; it
  is the uninstall path (§11), not this one, that checks the compose label before treating a
  container as ours. A different app bound to `:8090` would be reused as-is here.
- **The `Models: before -> after` table also prints during uninstall** (real run or
  `--dry-run`), even though uninstall never touches a model file — see §11.
- **`--check --mode uninstall` prints only the diagnosis, no uninstall preview.** `--check`
  short-circuits before the mode-specific pipeline runs, so it never lists what an uninstall
  would remove or keep. Use `./install.sh --mode uninstall --dry-run` to preview one.

## 17. Troubleshooting and self-test

For symptoms (`JSON.parse` / `NetworkError` in the browser, ComfyUI not seeing its models,
a padlocked folder, Ollama issues, reinstalling or resetting), see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) ([français](TROUBLESHOOTING.fr.md)).

The self-test harness runs `install.sh` through 42 scenarios against stubbed `docker`,
`curl`, `ss`, `systemctl`, `sudo` and `ollama`, with a throwaway `$HOME` and a throwaway
copy of the repository in a temp directory. It touches no real container, downloads
nothing, and writes nothing outside that directory:

```bash
bash tests/selftest-install.sh                         # all scenarios, a few minutes
bash tests/selftest-install.sh virgin dry_run          # a subset (names: see ALL= at the end of the file)
```

The harness ends with `N passed, M failed` and exits 0 only when nothing failed.
