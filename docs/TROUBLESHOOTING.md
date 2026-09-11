# Troubleshooting — install and deployment (GB10)

*Version française : [TROUBLESHOOTING.fr.md](TROUBLESHOOTING.fr.md).*

This guide covers installing and running the stack, not render quality (see `docs/TESTING.md`)
nor pipeline pitfalls (see `docs/LESSONS.md`).

**`install.sh` now diagnoses, repairs and — with `--mode uninstall` — removes this application
by itself.** Most of what used to be a manual runbook in this guide is now `./install.sh
--check` (read-only diagnosis), `./install.sh --dry-run` (same, but walks every step), or a
real run. The full guide to the script is [docs/INSTALL.md](INSTALL.md). What is left below is
symptom → cause, and the handful of things the script genuinely cannot do for you: it never
runs `sudo` on your behalf, and a gated Hugging Face download needs your own accepted terms.

Every command below was run as is on a GB10 in service. None installs or deletes anything
unless explicitly stated.

## Common symptoms and their real cause

| What you see | Cause | Section |
|---|---|---|
| `Error: JSON.parse: unexpected character at line 1 column 1` | The response body is not JSON but nginx's **HTML** error page (502/504): ComfyUI or Ollama is not answering behind the reverse proxy | [1](#1-diagnosis-in-three-commands) |
| `Enhancement failed: NetworkError when attempting to fetch resource` | The request to `/ollama/api/chat` never completed (connection refused or dropped) | [1](#1-diagnosis-in-three-commands) |
| ComfyUI runs but sees no model | The models were downloaded into a folder this particular ComfyUI does not read | [2](#2-comfyui-does-not-see-the-models) |
| A padlock on `comfyui-spark/` in the file manager | Folder created by dockerd as `root:root` (bind-mount whose source did not exist) — every model download then fails with "permission denied" | [2](#2-comfyui-does-not-see-the-models) |
| `SKIPPED (native install stopped)` | Ollama is installed outside Docker and its service is stopped, with no passwordless sudo to start it | [3](#3-ollama) |
| `SKIPPED (port 11434 busy)` / `port is already allocated` | Another process holds the port | [3](#3-ollama) |
| You are repairing or updating a machine where an older version already ran | Old layout, detected and migrated automatically | [4](#4-repairing-a-machine-where-an-older-version-already-ran) |
| You want the app gone, or a clean reinstall | `--mode uninstall`, or a full reset | [5](#5-uninstall--starting-from-scratch) |

**The prompt language is never the cause.** A `JSON.parse` failing at "line 1 column 1" means
the very first character received is not JSON (typically the `<` of `<html>`): the error
happens before any of the text you typed is even read.

## 1. Diagnosis in three commands

```bash
cd ~/ai-content-studio && ./install.sh --check
```

Read-only, and the fastest way to see what is wrong: one `state` line, then one line each for
`comfyui`, `ollama`, `web`, `updater`, `models`, `gated` and `disk`, then the same proxy
verification a real run ends with. Exits `0` when everything the app needs is in place, `2`
otherwise — so it doubles as a health check you can script.

A `502`/`504` on `/comfy/system_stats` or `/ollama/api/version` in that verification is exactly
what produces the browser's `JSON.parse` or `NetworkError`: nginx is answering, but with its
own HTML error page, not the service behind it.

To check a single endpoint or container by hand instead of running the script:

```bash
for u in /comfy/system_stats /ollama/api/version /update/status; do printf '%s -> ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:8090$u"; done
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | grep -iE 'comfy|ollama|content-studio'
docker logs --tail 50 comfyui-nvidia
```

An `Exited` container: run `./install.sh` again — it restarts a stopped container rather than
creating a second one. ComfyUI's very first start installs `comfy_kitchen` and takes several
minutes — a `502` during that window is normal, and `install.sh` waits up to 15 minutes for it.

## 2. ComfyUI does not see the models

The classic trap, unchanged: the models are on disk, but not where this particular ComfyUI
reads them. `./install.sh --check` already shows both sides, in the `comfyui` and
`models`/`gated` lines of the diagnosis — the number that matters is `lists: N of the M
diffusion model(s) present on disk`.

- **If ComfyUI is a third-party one** the script did not create (diagnosis reads `FOREIGN
  COMFYUI`) and `lists: 0 of …`: a real run — not `--dry-run`, which does not rehearse this
  step, see docs/INSTALL.md §16 — offers a **takeover**: an override file written next to its
  own compose file, adding `BASE_DIRECTORY`/`WANTED_UID`/`WANTED_GID` to its environment only.
  Image, ports, volumes and networks stay untouched, no model byte moves, and it asks for
  confirmation first. Undo is one `rm` plus `docker compose up -d`. Detail: docs/INSTALL.md §9.
- **If it is the installer's own ComfyUI**: `BASE_DIRECTORY: /basedir` is missing or wrong in
  `~/comfyui-spark/compose.yaml` — compare it with `docker/stacks/comfyui.yml`, fix it, then
  run `./install.sh` again. Without that variable the `mmartial` image ignores `/basedir` and
  looks for its models in `/comfy/mnt/ComfyUI/models` instead.

To inspect the same two facts by hand:

```bash
docker inspect comfyui-nvidia --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
curl -s http://localhost:8188/object_info/UNETLoader | grep -o 'minimax_h3[^"]*' | head -3
```

### A padlocked models folder

`install.sh` never runs `sudo` on your behalf. If `~/comfyui-spark/basedir` ends up owned by
`root` (a bind-mount whose source did not exist before the container's first start), the plan
prints the fix instead of attempting anything:

```
not done by this installer, which never runs sudo — fix it yourself: …/basedir belongs to
'root', every model download into it fails until you run: sudo chown -R <uid>:<gid> …
```

Run `sudo chown -R "$(id -u):$(id -g)" ~/comfyui-spark`, then `./install.sh` again.

### Checking the integrity of downloaded models

`./install.sh --check` already reports this as one `models` line (`N/M present`). For the
per-file detail it uses internally:

```bash
M=~/comfyui-spark/basedir/models; while IFS='|' read -r d f s u; do case "$d" in ''|\#*) continue;; esac; case "$s" in ''|*[!0-9]*) continue;; esac; a=$(stat -c%s "$M/$d/$f" 2>/dev/null || echo 0); t=$((s/100)); [ "$t" -lt 1 ] && t=1; if [ "$a" -eq 0 ]; then r=MISSING; elif [ "$a" -ge $((s-t)) ] && [ "$a" -le $((s+t)) ]; then r=OK; else r=INCOMPLETE; fi; printf '%-11s %s\n' "$r" "$d/$f"; done < ~/ai-content-studio/scripts/models.txt
```

`MISSING` and `INCOMPLETE` are fixed by running `./install.sh` again (`curl -C -` resumes an
interrupted download).

**Known limit of this check**: the tolerance is 1%, the same as `install.sh` uses, and it is
necessary — republished Hugging Face revisions can differ by a few kilobytes from
`scripts/models.txt`. A file truncated by less than 1% therefore passes as good. The only
proof that counts remains an actual render, inspected (`docs/TESTING.md`) — a ComfyUI job
reporting "success" proves nothing.

## 3. Ollama

`install.sh` detects Ollama **by its service** (`:11434`), not by a container: a native
(systemd) install is reused as is, and the `gemma4:e4b` model is pulled through the HTTP API
either way. Check and manual pull, valid in both cases:

```bash
curl -s http://localhost:11434/api/tags | grep -o '"gemma4:e4b"' || curl -X POST http://localhost:11434/api/pull -d '{"model":"gemma4:e4b"}'
```

If the summary shows `SKIPPED (native install stopped)`: a native Ollama exists but did not
answer, and the script's `sudo -n systemctl start ollama.service` failed — deliberately, it
never prompts for a password, and it never creates a container in that case either, so two
Ollama instances never fight over the port. The script prints:

```
WARNING: could not start the native ollama service (no passwordless sudo?)
    run it yourself, then run this script again:  sudo systemctl enable --now ollama.service
    no container was created, so two ollama instances never fight over port 11434
```

Run that command, then `./install.sh` again. If the port is held by something else instead,
`sudo ss -ltnp 'sport = :11434'` tells you by what.

## 4. Repairing a machine where an older version already ran

This is the most frequent case: a first install was attempted before v1.0.7, when
`docker-compose.yml` also declared `comfyui` and `ollama` with their volumes under
`~/ai-content-studio/comfyui/`. `install.sh` now does the whole migration itself: it removes
the inherited containers and recreates them as the `~/comfyui-spark`/`~/ollama` stacks, copies
the Ollama weights from the `ollama-data` volume into `~/ollama/data` (saves a 9.6 GB
download), and moves the ComfyUI models from the old folder into wherever the running ComfyUI
actually reads them — file by file, `mv -n`, nothing ever overwritten or deleted.

```bash
cd ~/ai-content-studio && git pull
./install.sh --check                                      # confirms: state OLD LAYOUT (pre-1.0.7)
./install.sh --dry-run                                     # walks every step as "would …", changes nothing
HF_TOKEN=hf_xxx ./install.sh                               # applies it (HF_TOKEN only if LTX 2.5 is still missing)
```

`install.sh` writes its own log to `~/install-YYYY-MM-DD-HHMM.log`; a run can take hours
because of the model downloads.

**What proves the migration happened**: the diagnosis line `state : OLD LAYOUT (pre-1.0.7) —
…`, and in the plan, a step starting `docker rm -f <container> (inherited: this repository's
compose file created it)` for ComfyUI and for Ollama. In the `Models: before -> after`
table afterwards, moved files show as `MOVED (from the legacy repository folder)`, files
already downloaded as `KEPT (already in place)`.

**A duplicate is reported** (`N file(s) already present in <dir>; the copy in <old> is a
duplicate you may delete yourself`): both copies are left in place on purpose — delete the old
one yourself if you want the space back; it never blocks anything or counts as work left to do.

**The move leaves files behind** (`moved: N left behind: M`, M not zero): the old folder is
owned by root.

```bash
sudo chown -R "$(id -u):$(id -g)" ~/ai-content-studio/comfyui
```

Then run `./install.sh` again — the move picks up where it left off.

**No migration step appears** (the container shows as `reused` instead of a `docker rm -f …
(inherited: …)` step): it was not created by this repository's own `docker-compose.yml`
(checked by compose label) — a container made by hand, or by another stack. The script never
touches it; use the inventory command in [§5](#inventory-first--who-owns-what) to see where it
actually comes from before deciding by hand.

**Verify**: run `./install.sh` again — it is idempotent, and that is the best test. Everything
should read `reused`, and the proxy checks should all read `HTTP 200`. Then in the app
(`http://<ip>:8090`): **✨ Enhance (LLM)** on a prompt field, then a simple Krea 2 image before
trying video.

## 5. Uninstall / starting from scratch

```bash
./install.sh --mode uninstall --dry-run     # preview, removes nothing
./install.sh --mode uninstall               # asks per component before removing anything
```

Only ever removes a container this installer created — checked by its own compose label, never
by name or image (docs/INSTALL.md §11). Models, Ollama weights, workflows, `.env` and the stack
files (`compose.yaml`, `compose.override.yaml`, userscripts) are always kept, and listed with
their sizes at the end under `Kept — nothing below was deleted`. Unattended (no terminal):
`./install.sh --mode uninstall --yes --components web,updater,comfyui,ollama`.

**Reinstall afterwards**: `./install.sh` again — it reuses whatever stack files were kept.

### Inventory first — who owns what

Useful before deciding on a container the uninstall left in the `NOT ours` list, or one that
was never made through `docker compose` at all:

```bash
for c in $(docker ps -a --format '{{.Names}}'); do printf '%-30s %-48s %s\n' "$c" "$(docker inspect -f '{{.Config.Image}}' "$c")" "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c")"; done
```

The third column decides: containers pointing at `<home>/ai-content-studio/docker-compose.yml`
(or, for ComfyUI/Ollama, at `~/comfyui-spark/compose.yaml`/`~/ollama/compose.yaml` written by
this installer) come from your install. An empty column means a container created outside
compose (`docker run`), which belongs to nobody but you. A different file means another
stack — leave it alone.

### Full reset (images and models too — several hundred GB re-downloaded)

`install.sh` never removes an image, a volume or a model file — deliberately: that is
expensive data, and it is essentially never what actually broke an install. If you genuinely
want all of it gone (a corrupted image, reclaiming disk space):

```bash
docker rm -f ai-content-studio-web ai-content-studio-updater comfyui-nvidia ollama-api 2>/dev/null; docker volume rm ollama-data 2>/dev/null; docker rmi mmartial/comfyui-nvidia-docker:ubuntu24_cuda13.1-dgx-latest ollama/ollama:latest ai-content-studio-updater 2>/dev/null; sudo rm -rf ~/comfyui-spark ~/ollama ~/ai-content-studio
```

Read the inventory above first: `~/comfyui-spark` may **predate** the app install (that is the
case on the reference machine, where this ComfyUI stack is older and managed by its own
`compose.yaml`) — destroying it would make you download 150 GB for nothing. When in doubt,
keep `~/comfyui-spark/basedir/models`: files already present are never downloaded again.

### Reinstall

```bash
git clone https://github.com/yoyo-sama/dellaicontent.git ~/ai-content-studio && cd ~/ai-content-studio && HF_TOKEN=hf_xxx ./install.sh
```

### What you must not delete

Docker, the NVIDIA driver and `nvidia-container-toolkit` are never the cause of a failed
install of this stack, and `install.sh` does not install them — it checks they are there and
prints what to run if one is missing. `docker system prune -a` would reclaim space but force a
re-pull of every image: keep it for a saturated disk, not for this app specifically.

## 6. Checking that an install holds

```bash
cd ~/ai-content-studio && ./install.sh --check
```

Idempotent and read-only: `state : UP TO DATE` and exit code `0` mean everything the app needs
is in place. Only then open `http://<ip>:8090`, test **✨ Enhance (LLM)** on a prompt field,
then a simple image generation (Krea 2) before trying video.
