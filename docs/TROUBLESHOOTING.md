# Troubleshooting — install and deployment (GB10)

*Version française : [TROUBLESHOOTING.fr.md](TROUBLESHOOTING.fr.md).*

This guide covers installing and running the stack, not render quality (see `docs/TESTING.md`)
nor pipeline pitfalls (see `docs/LESSONS.md`).

Every command below was run as is on a GB10 in service. None installs or deletes anything
unless explicitly stated.

## Common symptoms and their real cause

| What you see | Cause | Section |
|---|---|---|
| `Error: JSON.parse: unexpected character at line 1 column 1` | The response body is not JSON but nginx's **HTML** error page (502/504): ComfyUI or Ollama is not answering behind the reverse proxy | [1](#1-diagnosis-in-three-commands) |
| `Enhancement failed: NetworkError when attempting to fetch resource` | The request to `/ollama/api/chat` never completed (connection refused or dropped) | [1](#1-diagnosis-in-three-commands) |
| ComfyUI runs but sees no model | The models were downloaded into a folder this particular ComfyUI does not read | [2](#2-comfyui-does-not-see-the-models) |
| A padlock on `comfyui/` in the file manager | Folder created by dockerd as `root:root` (bind-mount whose source did not exist) — every model download then fails with "permission denied" | [2](#2-comfyui-does-not-see-the-models) |
| Reference2video: the vision description of the reference images fails silently — the video still renders, the event log (always in French) only shows `Description de « … » indisponible (ollama 413)` | nginx rejects the request body: before v1.4.4, `location ^~ /ollama/` had no `client_max_body_size` (1 MB default) and a base64 image of ~750 KB or more was answered 413 | [3](#3-ollama) |
| `skipped (native Ollama installed but not started)` | Ollama is installed outside Docker and its service is stopped | [3](#3-ollama) |
| `skipped (port 11434 busy)` / `port is already allocated` | Another process holds the port | [3](#3-ollama) |
| You are reinstalling on a machine where a previous version of the script already ran | Migration from the old layout to the sibling stacks | [4](#4-reinstalling-on-a-machine-where-a-previous-version-of-the-script-already-ran) |
| `git add` or an in-app update fails with "permission denied" under `.git/objects` | Git objects created as `root` by an old updater or a container | [8](#8-git-objects-owned-by-root) |
| The gallery says "Full gallery unavailable — images from this browser only", or trashing/renaming says "The gallery service did not complete: nothing was changed." | The `gallery` service does not answer, or cannot write to `output/` | [9](#9-gallery-service) |

**The prompt language is never the cause.** A `JSON.parse` failing at "line 1 column 1" means
the very first character received is not JSON (typically the `<` of `<html>`): the error
happens before any of the text you typed is even read.

## 1. Diagnosis in three commands

The application exposes a single port (8090) and reaches ComfyUI and Ollama through the nginx
reverse proxy. So test through that proxy, exactly like the browser does:

```bash
for u in /comfy/system_stats /ollama/api/version /update/status; do printf '%s -> ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:8090$u"; done
```

Three `200` means the services answer. A `502` or `504` on `/comfy/` or `/ollama/` is exactly
what produces the `JSON.parse` error in the browser. A `504` can also mean a call outlived its proxy timeout (`/ollama/` 300 s, `/update/` 600 s; see `docs/ARCHITECTURE.md` § Backend `updater`). Then:

```bash
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | grep -iE 'comfy|ollama|content-studio'
```

An `Exited` container explains everything: `install.sh` restarts it (it never creates a
duplicate), just run it again. Finally, the logs of whichever service is silent:

```bash
docker logs --tail 50 comfyui-nvidia
```

ComfyUI's very first start installs `comfy_kitchen` and takes several minutes — a `502` during
that window is normal, and `install.sh` waits up to 15 minutes for it.

## 2. ComfyUI does not see the models

The classic trap: the models are on disk, but not where this particular ComfyUI reads them.
The container's mounts are the source of truth, not the path you think you configured:

```bash
docker inspect comfyui-nvidia --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

Expected: `<home>/comfyui-spark/basedir -> /basedir`. Then the truth on the ComfyUI side —
what it actually offers in its menus:

```bash
curl -s http://localhost:8188/object_info/UNETLoader | grep -o 'minimax_h3[^"]*' | head -3
```

An empty answer while the files do exist almost always means `BASE_DIRECTORY: /basedir` is
missing from the ComfyUI stack: without that variable, the `mmartial` image ignores `/basedir`
and looks for its models in `/comfy/mnt/ComfyUI/models`. The reference stack is
`docker/stacks/comfyui.yml` — compare it with `~/comfyui-spark/compose.yaml`.

### Checking the integrity of downloaded models

```bash
M=~/comfyui-spark/basedir/models; while IFS='|' read -r d f s u; do case "$d" in ''|\#*) continue;; esac; case "$s" in ''|*[!0-9]*) continue;; esac; a=$(stat -c%s "$M/$d/$f" 2>/dev/null || echo 0); t=$((s/100)); [ "$t" -lt 1 ] && t=1; if [ "$a" -eq 0 ]; then r=MISSING; elif [ "$a" -ge $((s-t)) ] && [ "$a" -le $((s+t)) ]; then r=OK; else r=INCOMPLETE; fi; printf '%-11s %s\n' "$r" "$d/$f"; done < ~/ai-content-studio/scripts/models.txt
```

`MISSING` and `INCOMPLETE` are fixed by running `install.sh` again (`curl -C -` resumes an
interrupted download).

**Known limit of this check**: the tolerance is 1%, the same as `install.sh` uses, and it is
necessary — on the reference machine two files that have been in service for weeks differ by a
few kilobytes from the sizes in `scripts/models.txt` (republished Hugging Face revisions). A
file truncated by less than 1% would therefore pass as good. The only proof that counts
remains an actual render, inspected (`docs/TESTING.md`) — a ComfyUI job reporting "success"
proves nothing.

## 3. Ollama

`install.sh` detects Ollama **by its service** (`:11434`), not by a container: a native
(systemd) install is reused as is, and the `gemma4:e4b` model is pulled through the HTTP API.
Check and manual pull, valid in both cases:

```bash
curl -s http://localhost:11434/api/tags | grep -o '"gemma4:e4b"' || curl -X POST http://localhost:11434/api/pull -d '{"model":"gemma4:e4b"}'
```

If the summary shows `skipped (native Ollama installed but not started)`, a native Ollama
exists but does not answer and the script could not start it (no passwordless sudo). No
container is created in that case — deliberately, so that two Ollama instances never fight
over port 11434:

```bash
sudo systemctl enable --now ollama
```

Then run `install.sh` again. If the port is held by something else,
`sudo ss -ltnp 'sport = :11434'` tells you by what.

### Vision description of references fails with `ollama 413`

The reference2video pipeline describes each reference image with gemma (vision): the image travels
base64-encoded inside the `/ollama/api/chat` body. nginx's default request-body limit is 1 MB, so
from ~750 KB of image the request is answered **413** and the description is skipped (the video
still renders, the reference simply weighs less). Since v1.4.4, `nginx.conf` sets
`client_max_body_size 100m;` in `location ^~ /ollama/`. The file is mounted as a single file:
after pulling the change, **recreate** the nginx container, otherwise the running nginx keeps the
old configuration:

```bash
cd ~/ai-content-studio
docker compose up -d --force-recreate -t 0 ai-content-studio
```

## 4. Reinstalling on a machine where a previous version of the script already ran

This is the most frequent case: a first install was attempted before v1.0.7, when
`docker-compose.yml` also declared `comfyui` and `ollama` with their volumes under
`~/ai-content-studio/comfyui/`. That ComfyUI had no `BASE_DIRECTORY` and therefore did not read
the folder the script downloaded models into.

**What the script does on its own**: it recognises the containers created by the repository's
`docker-compose.yml` (compose label), removes them, recreates ComfyUI in `~/comfyui-spark` and
Ollama in `~/ollama`, and **copies** the weights from the `ollama-data` volume into
`~/ollama/data` so the model is not downloaded again.

It also moves the ComfyUI models from the old folder into the new one, before any download
(see step 3). It deletes nothing besides the two inherited containers: the old folder, once
emptied of its files, stays on disk.

### Step 1 — Get the current version of the script

```bash
cd ~/ai-content-studio && git pull && cat VERSION
```

The version must be **≥ 1.0.8**. Below that you would be running the very version that caused
the problem. If `git pull` refuses because of local changes, `git stash` them: there is
normally nothing worth keeping in this repository on a deployment machine.

### Step 2 — Take stock

```bash
du -sh ~/ai-content-studio/comfyui/basedir/models 2>/dev/null; du -sh ~/comfyui-spark/basedir/models 2>/dev/null; docker run --rm -v ollama-data:/v alpine sh -c 'du -sh /v; ls /v/models/manifests/registry.ollama.ai/library' 2>/dev/null; df -h /home | tail -1
```

Four pieces of information: what the old folder holds, what the new one already holds, whether
the inherited Ollama volume really contains `gemma4`, and the free space. You need **~150 GB**
for the full set of ComfyUI models.

### Step 3 — The old model folder: nothing to do (unless padlocked)

**The script handles it.** At step 5/7, before any download, it moves the content of
`~/ai-content-studio/comfyui/basedir/models` into the folder the running ComfyUI actually
reads. The move is done file by file (a sub-folder present on both sides does not block it) and
never overwrites a file already at the destination. Moved models whose size matches are then
recognised and **not downloaded again**:

```
3 file(s) found in the legacy model folder (/home/<you>/ai-content-studio/comfyui/basedir/models).
Moving them to /home/<you>/comfyui-spark/basedir/models — same filesystem, instant, and avoids downloading them again.
  moved: 3   left behind: 0
SKIP (already present, size matches): /home/<you>/comfyui-spark/basedir/models/vae/qwen_image_vae.safetensors
```

**The only case where you must step in**: `left behind` is not zero. The old folder was created
by Docker as root (the padlock), so you have no right to move anything out of it. The script
prints the exact command; take ownership then run it again and it will finish the move:

```bash
sudo chown -R "$(id -u):$(id -g)" ~/ai-content-studio/comfyui
```

Once `left behind: 0`, the old folder only holds empty directories:

```bash
rm -rf ~/ai-content-studio/comfyui
```

### Step 4 — Run the install

```bash
cd ~/ai-content-studio && HF_TOKEN=<your_hf_token> ./install.sh 2>&1 | tee ~/install-$(date +%F-%H%M).log
```

`HF_TOKEN` is not optional in practice: the 5 LTX 2.5 files come from a *gated* Hugging Face
repository and fail cleanly without a token (the other 17 download normally). The `tee` keeps a
trace: the command runs for hours, and most of the errors scroll by during the downloads.

Order of operations, with the durations to expect:

| Script step | What happens | Duration |
|---|---|---|
| 2/7 | Inherited containers removed, both stacks created, userscripts deployed | < 1 min |
| 2/7 | Ollama weights copied from the `ollama-data` volume | a few minutes (9.6 GB) |
| 5/7 | Missing ComfyUI models downloaded | several hours |
| 6/7 | `gemma4:e4b` pulled if missing | a few minutes |
| 6/7 | Waiting for ComfyUI's first start (`comfy_kitchen` install) | up to 15 min |

### Step 5 — What you should see scroll by

The lines that prove the migration actually happened:

```
WARNING: ComfyUI inherited from the old layout — migrating to /home/<you>/comfyui-spark.
Creating the ComfyUI stack in /home/<you>/comfyui-spark.
Userscripts deployed before first start: 2 file(s)
WARNING: Ollama inherited from the old layout — migrating to /home/<you>/ollama.
Copying weights from the 'ollama-data' volume into /home/<you>/ollama/data…
Creating the Ollama stack in /home/<you>/ollama.
Waiting for ComfyUI on :8188 (first start, userscripts installation)…
```

If instead you see `reused (comfyui-nvidia)` with no migration line, the container does not
carry the repository's compose label: it was created by hand (`docker run`) or by another
stack. The script never touches a container it does not own — in that case delete it yourself
after checking where it came from with the inventory in
[section 5](#inventory-first--who-owns-what), then run the script again.

### Step 6 — Read the log back

```bash
grep -nE "WARNING|failed|skipped|ERROR" ~/install-*.log
```

On a healthy install, all that remains are possible warnings about the LTX 2.5 files if
`HF_TOKEN` was missing.

### Step 7 — Verify

Run the script again: it is idempotent, and that is the best test.

```bash
cd ~/ai-content-studio && ./install.sh 2>&1 | tail -25
```

Expected: `reused` on all three services, `already present (not re-downloaded) : 22`,
`Ollama model gemma4:e4b: present`, four `HTTP 200`. Then the check that really matters — does
ComfyUI see its models:

```bash
docker inspect comfyui-nvidia --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' && curl -s http://localhost:8188/object_info/UNETLoader | grep -o 'minimax_h3[^"]*' | head -3
```

Finally, in the application (`http://<ip>:8090`): **✨ Enrich brief (LLM)** on a prompt field, then a
simple image generation (Krea 2) before trying video.

### If the script stops midway

Just run it again. It is idempotent at every step: downloads resume where they stopped
(`curl -C -`), stacks already created are reused, stopped containers are restarted instead of
being duplicated. Three special cases:

- **Interrupted while copying the Ollama weights**: `~/ollama/data` is incomplete, the model
  will simply be pulled through the API on the next run.
- **ComfyUI still silent after the 15-minute wait**: `docker logs comfyui-nvidia`. The first
  start builds/installs `comfy_kitchen`, and any error shows there in plain text.
- **Disk full during downloads**: partial files are kept; free some space and run again, the
  resume avoids starting over.

## 5. Starting from scratch

### Inventory first — who owns what

```bash
for c in $(docker ps -a --format '{{.Names}}'); do printf '%-30s %-48s %s\n' "$c" "$(docker inspect -f '{{.Config.Image}}' "$c")" "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c")"; done
```

The third column decides: containers pointing at `<home>/ai-content-studio/docker-compose.yml`
come from the install you are redoing. An empty column means a container created outside
compose (`docker run`), which belongs to nobody but you. A different file means another stack —
leave it alone.

### Targeted reset (recommended)

Destroys the install, **keeps the Docker images and the models already downloaded**. This
command only removes containers created by this repository's `docker-compose.yml` — exactly
those of a failed install, including the `comfyui`/`ollama` ones from the old layout — and
cannot touch a neighbouring stack:

```bash
docker ps -a --format '{{.Names}}' | while read -r c; do [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c" 2>/dev/null)" = "$HOME/ai-content-studio/docker-compose.yml" ] && docker rm -f "$c"; done; sudo rm -rf ~/ai-content-studio/comfyui ~/ai-content-studio/.env
```

If the inventory showed a ComfyUI or an Ollama **without a label** (created outside compose,
with `docker run`), the command above will not remove it: delete it by name, after checking it
really comes from your install attempt.

The `ollama-data` volume is kept: `install.sh` copies its weights into `~/ollama/data`, which
saves 9.6 GB of downloading. So is the `ai-content-studio_gallery-data` volume (gallery index, tags and favourites).

### Full reset

Everything goes, including the images (~30 GB) and **the models (~150 GB, several hours of
downloading)**:

```bash
docker rm -f ai-content-studio-web ai-content-studio-updater ai-content-studio-gallery comfyui-nvidia ollama-api 2>/dev/null; docker volume rm ollama-data ai-content-studio_gallery-data 2>/dev/null; docker rmi mmartial/comfyui-nvidia-docker:ubuntu24_cuda13.1-dgx-latest ollama/ollama:latest ai-content-studio-updater ai-content-studio-gallery 2>/dev/null; sudo rm -rf ~/comfyui-spark ~/ollama ~/ai-content-studio
```

Read the inventory again before running it: `~/comfyui-spark` may **predate** the app install
(that is the case on the reference machine, where this ComfyUI stack is older and managed by its
own `compose.yaml`) — destroying it would make you download 150 GB for nothing. Keep this for
corrupted models or a broken ComfyUI image. When in doubt, keep
`~/comfyui-spark/basedir/models`: files already present are never downloaded again.

### Reinstall

```bash
git clone https://github.com/yoyo-sama/dellaicontent.git ~/ai-content-studio && cd ~/ai-content-studio && HF_TOKEN=<your_hf_token> ./install.sh
```

### What you must not delete

Docker, the NVIDIA driver and `nvidia-container-toolkit` are never the cause of a failed
install of this stack, and `install.sh` does not install them — it checks they are there and
prints what to run if one is missing. `docker system prune -a` would reclaim space but force a
re-pull of every image: keep it for a saturated disk.

## 6. Checking that an install holds

The best test is to run the script again: it is idempotent.

```bash
cd ~/ai-content-studio && ./install.sh 2>&1 | tail -25
```

Expected: `reused` on all three services, `already present (not re-downloaded) : 22`,
`Ollama model gemma4:e4b: present`, and five `HTTP 200` health checks (`:8188`, `:11434`, `:8090`,
`/update/status`, `/gallery/health`). Only then open
`http://<ip>:8090`, test **✨ Enrich brief (LLM)** on a prompt field, then a simple image generation
(Krea 2) before trying video.

## 7. Rolling back a ComfyUI update

The app can update ComfyUI itself (prompt at load when it is older than `comfyui.min` in
`workflows/manifest.json`, see the README). The prompt shows the rollback command; the tag is `v`
+ the previous version (visible in the ComfyUI console header or `GET /comfy/system_stats`
before the update):

```bash
git -C ~/comfyui-spark/run/ComfyUI checkout v0.36.0 && docker restart comfyui-nvidia   # example tag
```

If the update went through but ComfyUI does not answer after ~3 min, read
`docker logs comfyui-nvidia --tail 50`. If the ComfyUI-Manager itself was upgraded in the process,
the reboot (`execv`) does not replay the container's userscripts: `docker restart comfyui-nvidia`.

## 8. Git objects owned by root

The `updater` container runs as the repository owner (`user: "${APP_UID:-1000}:${APP_GID:-1000}"`,
values written to `.env` by `install.sh`). An older updater ran as root and left root-owned
folders in `.git/objects`, which breaks `git add` for you. `install.sh` detects it and prints the
fix; to check and repair by hand:

```bash
find ~/ai-content-studio/.git ! -user "$(id -un)" -print -quit        # any output = wrong owner
sudo chown -R "$(id -un):$(id -gn)" ~/ai-content-studio/.git
cd ~/ai-content-studio && docker compose up -d --build --force-recreate updater
```

## 9. Gallery service

The `gallery` service (container `ai-content-studio-gallery`, `127.0.0.1:8094`, reached through `:8090/gallery/`) indexes ComfyUI's `output/` folder for the gallery: search, filters, dates, tags, favourites, trash. Generating never depends on it: when it does not answer, the gallery falls back on the images remembered by this browser (a note says so and the event log gets a `WARN`).

### 9.1 The service does not answer

```bash
curl -s http://localhost:8090/gallery/health                    # {"ok": true, "indexed": …, "scanning": …, "warning": null, …}
docker compose ps gallery                                       # Up ?
docker logs --tail 50 ai-content-studio-gallery                 # errors only: requests are not logged
docker inspect -f '{{.RestartCount}} {{.State.Status}}' ai-content-studio-gallery
```

- `docker compose ps gallery` shows nothing or `Exited`: `docker compose up -d --build gallery`.
- `RestartCount` keeps rising: the service crashes at start and Docker restarts it. The last log lines say why (port busy: 9.2; `output/` problem: 9.3).
- The container is `Up` and answers on `127.0.0.1:8094`, but `:8090/gallery/health` gives a `404` or an HTML page: the web container never loaded the `/gallery/` rule of `nginx.conf` (it is mounted as a single file, so a running nginx does not see the change). `docker compose up -d --force-recreate ai-content-studio`; add `-t 0` to avoid a ~10 s wait for the open WebSockets.
- `"indexed": 0` with `"scanning": true` right after a start: the first scan is running (about 15 s for 1 800 files); the gallery waits for it by itself. A `"warning"` means the output folder is missing or empty while the index is not: the service then deletes nothing — check that `output/` is really mounted.

### 9.2 Port 8094 is busy

The service runs in host network mode and always listens on `127.0.0.1:8094`. If another process holds that port the container exits at once and Docker keeps restarting it.

```bash
ss -ltnp "sport = :8094"          # who holds it?
```

Free the port, then `docker compose up -d gallery`. Changing the port means changing `PORT` in `docker-compose.yml` **and** the `proxy_pass` of `location ^~ /gallery/` in `nginx.conf` (then recreate the web container, see 9.1).

### 9.3 `output/` is not writable

Reading works, but trashing, renaming or restoring answers an error (the page says "The gallery service did not complete: nothing was changed."; the logs show a `PermissionError`). The service runs as `APP_UID:APP_GID` from `.env` (default 1000:1000), moves files with a hard link, and a folder or file it does not own cannot be moved.

```bash
ls -ld ~/comfyui-spark/basedir/output ~/comfyui-spark/basedir/output/.trash   # owner?
docker exec ai-content-studio-gallery id                                      # uid=1000 gid=1000
find ~/comfyui-spark/basedir/output ! -user "$(id -un)" -print -quit           # any output = a file owned by someone else
```

`install.sh` prints the fix without ever running it. Run it yourself, once:

```bash
sudo chown -R "$(id -u):$(id -g)" ~/comfyui-spark/basedir/output
```

This also happens when `output/` did not exist before the first `docker compose up`: Docker then creates it as `root`.

### 9.4 Re-index from scratch

The index only holds what can be recomputed from the files, **except tags and favourites**, which live only in the `gallery-data` volume: re-indexing erases them. The image files are never touched. To start over (corrupt index, `APP_UID` changed after the volume was created, schema doubt):

```bash
cd ~/ai-content-studio
docker compose down gallery && docker volume rm <project>_gallery-data && docker compose up -d --build gallery
```

`<project>` is the compose project name, i.e. the repository folder name (`ai-content-studio` for the default clone): `docker volume ls | grep gallery-data` gives the exact name. The first scan takes about 15 s for 1 800 files. The favourites of this browser (`galleryFavs`) are sent to the service only once: to send them again after a re-index, delete the `galleryFavsMigrated` key in the browser's local storage, then reload.

### 9.5 Emptying the trash

"Delete" in the gallery moves the file to `~/comfyui-spark/basedir/output/.trash/` and can be undone (Trash view, "Restore"). There is no permanent deletion in the interface: it is manual and **irreversible**.

```bash
rm -r ~/comfyui-spark/basedir/output/.trash
```

(or only one `.trash/<id>` folder). The service created these folders with its own UID, so no `sudo` is needed when it runs as you. Within a minute (`SCAN_INTERVAL`, 60 s) the Trash view empties: rows whose file is gone are deleted, with their tags.

### 9.6 After an update made by the updater

The in-app updater only runs `git pull`: it never rebuilds the `gallery` image nor recreates the web container. When an update touches `docker/gallery/` or `nginx.conf`, run:

```bash
cd ~/ai-content-studio
docker compose up -d --build gallery && docker compose up -d --force-recreate ai-content-studio
```

The second command is needed for any change of `nginx.conf` (single-file mount, see 9.1); add `-t 0` to skip the ~10 s wait for open WebSockets.
