#!/usr/bin/env bash
# install.sh — idempotent install/update of the Dell AI Content Studio stack (nginx web,
# ComfyUI, Ollama) on GB10/DGX Spark. Detects services by their actual role (HTTP health)
# rather than by container name, reuses everything already running, and never recreates or
# destroys a container it does not own.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"
COMPOSE="docker compose"

# Target layout (same as the reference machine): one stack per service, each at the root of
# the home directory. This repo only deploys the app; ComfyUI and Ollama own their folders.
COMFY_DIR="$HOME/comfyui-spark"
OLLAMA_DIR="$HOME/ollama"

section() { printf '\n=== %s ===\n' "$*"; }
warn()    { printf 'WARNING: %s\n' "$*"; }

is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# Finds the container actually answering on a given port:
# 1) through the published port mapping (docker ps --filter publish=PORT)
# 2) otherwise, among network_mode: host containers, the one bind-mounting the root of THIS
#    repo (our nginx runs in host network mode, so it publishes no port).
find_container_by_port() {
  local port="$1" name c
  name=$(docker ps --filter "publish=${port}" --format '{{.Names}}' 2>/dev/null | head -n1)
  if [ -n "$name" ]; then
    printf '%s\n' "$name"
    return 0
  fi
  for c in $(docker ps --filter "network=host" --format '{{.Names}}' 2>/dev/null); do
    # The repo is mounted by nginx AND by the updater (both in host network mode): the nginx
    # destination is what tells apart the one actually serving the port.
    if docker inspect --format '{{json .Mounts}}' "$c" 2>/dev/null \
       | grep -qF "\"Source\":\"${REPO_ROOT}\"" \
       && docker inspect --format '{{json .Mounts}}' "$c" 2>/dev/null \
       | grep -qF '"Destination":"/usr/share/nginx/html"'; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

# Is the port held by any process at all (docker or not)?
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3>&-
  fi
}

# Refuses to create a stack when the port is already held by something other than the
# expected service (a natively installed Ollama that is down, a ComfyUI outside docker,
# another service): without this, docker fails with the opaque "port is already allocated".
port_taken_by_other() {   # $1=port  $2=readable service name
  port_busy "$1" || return 1
  warn "port $1 is in use but $2 does not answer its health check."
  echo "  Another process holds it — a native install that is stopped or broken, or another service."
  echo "  Free the port (e.g. 'sudo systemctl stop ollama') or start that service, then run this script again."
  echo "  Nothing was created."
  return 0
}

# Waits for a URL to answer. $1=url $2=number of attempts $3=delay between attempts (s).
wait_for_http() {
  local i
  for i in $(seq 1 "$2"); do
    curl -sf "$1" >/dev/null 2>&1 && return 0
    sleep "$3"
  done
  curl -sf "$1" >/dev/null 2>&1
}

# A service may be installed but STOPPED: its container exists, its port is free. Creating a
# second one would fail on a name clash (container names are unique) and, for Ollama, would
# leave two instances fighting over the same port. So we restart the existing one instead.
# Returns: 0 = started and healthy, 2 = started but silent, 1 = no matching stopped container.
RESTARTED_CONTAINER=""
restart_stopped_service() {   # $1=image pattern  $2=readable name  $3=health url  $4=attempts  $5=delay
  local c
  c="$(docker ps -a --filter status=exited --filter status=created --filter status=paused \
        --format '{{.Names}}\t{{.Image}}' 2>/dev/null | awk -F'\t' -v p="$1" 'index($2,p){print $1; exit}')"
  [ -n "$c" ] || return 1
  RESTARTED_CONTAINER="$c"
  echo "$2 found in a stopped container ('$c') — starting it instead of creating a second one."
  docker start "$c" >/dev/null 2>&1 || { warn "could not start container '$c'."; return 2; }
  if wait_for_http "$3" "$4" "$5"; then
    echo "OK: $2 answers."
    return 0
  fi
  warn "container '$c' was started but $2 still does not answer — see 'docker logs $c'."
  return 2
}

# Ollama installed natively (official installer + systemd) is not a container, and creating
# one while it is merely stopped would leave two instances fighting over port 11434. So we
# try to start the existing service instead.
NATIVE_OLLAMA_PRESENT=0
native_ollama_present() {
  command -v ollama >/dev/null 2>&1 && return 0
  command -v systemctl >/dev/null 2>&1 && systemctl cat ollama.service >/dev/null 2>&1
}
start_native_ollama() {
  native_ollama_present || return 1
  NATIVE_OLLAMA_PRESENT=1
  echo "Ollama is installed natively on this host but not answering — trying to start it."
  if [ "$(id -u)" = 0 ]; then
    systemctl start ollama >/dev/null 2>&1
  else
    # 'sudo -n' NEVER asks for a password: either passwordless sudo is already allowed, or
    # it fails immediately — an install script must never hang on a prompt.
    sudo -n systemctl start ollama >/dev/null 2>&1
  fi
  if wait_for_http "http://localhost:11434/api/version" 15 2; then
    echo "OK: native Ollama service started."
    return 0
  fi
  warn "could not start the native Ollama service automatically (no passwordless sudo?)."
  echo "  Start it yourself, then run this script again:"
  echo "    sudo systemctl enable --now ollama     # or, without systemd: ollama serve &"
  echo "  No Ollama container was created, to avoid two instances fighting over port 11434."
  return 1
}

# Actual paths of a ComfyUI container, read from its bind-mounts (they override the default
# paths: that is where this particular ComfyUI really reads its models).
resolve_comfy_paths() {   # $1=container
  local us bd
  us="$(docker inspect --format '{{ range .Mounts }}{{ if eq .Destination "/userscripts_dir" }}{{ .Source }}{{ end }}{{ end }}' "$1" 2>/dev/null || true)"
  bd="$(docker inspect --format '{{ range .Mounts }}{{ if eq .Destination "/basedir" }}{{ .Source }}{{ end }}{{ end }}' "$1" 2>/dev/null || true)"
  [ -n "$us" ] && COMFY_USERSCRIPTS_DIR="$us"
  [ -n "$bd" ] && COMFY_MODELS_DIR="$bd/models"
  if [ -z "$us" ] || [ -z "$bd" ]; then
    warn "/userscripts_dir or /basedir mount not found on this container — deploy userscripts/models manually for it."
  else
    echo "Actual paths detected: userscripts_dir=$COMFY_USERSCRIPTS_DIR ; models=$COMFY_MODELS_DIR"
  fi
}

# Deploys the ComfyUI userscripts (including the comfy_kitchen installer) into the folder
# given as argument and returns how many files were copied. These scripts only run when the
# container STARTS: on a stack we create, call this before 'up -d'.
copy_userscripts() {
  local dest="$1" f copied=0
  [ -d "$REPO_ROOT/docker/userscripts" ] || { printf '0\n'; return 0; }
  mkdir -p "$dest" 2>/dev/null || { printf '0\n'; return 1; }
  for f in "$REPO_ROOT"/docker/userscripts/*; do
    [ -f "$f" ] || continue
    cp -f "$f" "$dest/" 2>/dev/null && chmod +x "$dest/$(basename "$f")" && copied=$((copied + 1))
  done
  printf '%s\n' "$copied"
}

create_comfy_stack() {
  echo "Creating the ComfyUI stack in $COMFY_DIR."
  # Folders are created BEFORE the container: a bind-mount whose source does not exist yet
  # is created by dockerd as root:root — the folder is then locked for the user, and every
  # model download afterwards fails with "permission denied".
  mkdir -p "$COMFY_DIR/basedir/models" "$COMFY_DIR/run" "$COMFY_DIR/userscripts_dir"
  [ -f "$COMFY_DIR/compose.yaml" ] || cp "$REPO_ROOT/docker/stacks/comfyui.yml" "$COMFY_DIR/compose.yaml"
  # Real uid/gid of the current user: compose reads this .env from the project directory,
  # including on a 'docker compose up -d' run by hand later on.
  [ -f "$COMFY_DIR/.env" ] || printf 'WANTED_UID=%s\nWANTED_GID=%s\n' "$(id -u)" "$(id -g)" > "$COMFY_DIR/.env"
  echo "Userscripts deployed before first start: $(copy_userscripts "$COMFY_DIR/userscripts_dir") file(s)"
  ( cd "$COMFY_DIR" && $COMPOSE up -d )
  COMFY_CREATED=1
  COMFY_CONTAINER="$(find_container_by_port 8188 || echo "comfyui-nvidia")"
  COMFY_USERSCRIPTS_DIR="$COMFY_DIR/userscripts_dir"
  COMFY_MODELS_DIR="$COMFY_DIR/basedir/models"
}

create_ollama_stack() {
  echo "Creating the Ollama stack in $OLLAMA_DIR."
  mkdir -p "$OLLAMA_DIR/data"
  [ -f "$OLLAMA_DIR/compose.yaml" ] || cp "$REPO_ROOT/docker/stacks/ollama.yml" "$OLLAMA_DIR/compose.yaml"
  ( cd "$OLLAMA_DIR" && $COMPOSE up -d )
  OLLAMA_CONTAINER="$(find_container_by_port 11434 || echo "ollama-api")"
}

# ---------------------------------------------------------------------------
section "1/7 Environment checks"
# ---------------------------------------------------------------------------
ARCH="$(uname -m)"
if [ "$ARCH" != "aarch64" ]; then
  warn "detected architecture '$ARCH' (this script targets GB10/DGX Spark hardware, ARM64)."
  echo "  Some steps (comfy_kitchen and other ARM-specific userscripts) may not apply."
  echo "  Continuing anyway (graceful degradation)."
else
  echo "OK: aarch64 architecture (GB10/DGX Spark)."
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: 'docker' not found in PATH. Install Docker before running this script again." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: the 'docker compose' (v2) plugin is missing. Install it before running this script again." >&2
  exit 1
fi
echo "OK: docker + docker compose available."

if docker info >/dev/null 2>&1 && docker info 2>/dev/null | grep -qi 'nvidia'; then
  echo "OK: nvidia runtime detected by 'docker info'."
elif command -v nvidia-smi >/dev/null 2>&1; then
  echo "OK: 'nvidia-smi' available (nvidia-container-toolkit likely installed)."
else
  warn "cannot confirm nvidia-container-toolkit is installed. GPU services (ComfyUI/Ollama) may fail to start. Continuing."
fi

# ---------------------------------------------------------------------------
section "2/7 Detecting services by actual role (HTTP health), not by name"
# ---------------------------------------------------------------------------

# --- ComfyUI (port 8188) ---
COMFY_USERSCRIPTS_DIR="$COMFY_DIR/userscripts_dir"
COMFY_MODELS_DIR="$COMFY_DIR/basedir/models"
COMFY_CONTAINER=""
COMFY_STATUS=""
COMFY_CREATED=0

echo "--- ComfyUI (:8188) ---"
if curl -sf http://localhost:8188/system_stats >/dev/null 2>&1; then
  COMFY_CONTAINER="$(find_container_by_port 8188 || true)"
  if [ -z "$COMFY_CONTAINER" ]; then
    warn "ComfyUI answers on :8188 but no matching container could be identified. Reusing the service as is, without container management."
    COMFY_STATUS="reused (container not identified)"
  else
    echo "ComfyUI already running in container '$COMFY_CONTAINER' — reusing it, no recreation."
    COMFY_STATUS="reused ($COMFY_CONTAINER)"

    IMAGE="$(docker inspect --format '{{.Config.Image}}' "$COMFY_CONTAINER" 2>/dev/null || true)"
    PROJECT="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$COMFY_CONTAINER" 2>/dev/null || true)"
    CONFIGFILE="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$COMFY_CONTAINER" 2>/dev/null || true)"

    if [[ "$IMAGE" == mmartial/comfyui-nvidia-docker* ]]; then
      if [ "$CONFIGFILE" = "$REPO_ROOT/docker-compose.yml" ]; then
        # Container created by the OLD layout (comfyui/ollama services inside the app's
        # compose file, volumes under $REPO_ROOT/comfyui, without BASE_DIRECTORY: that
        # ComfyUI does not even read /basedir). We replace it with the dedicated stack.
        warn "ComfyUI inherited from the old layout — migrating to $COMFY_DIR."
        docker rm -f "$COMFY_CONTAINER" >/dev/null 2>&1 || true
        if [ -d "$REPO_ROOT/comfyui/basedir/models" ]; then
          echo "  Old model folder left untouched: $REPO_ROOT/comfyui/basedir/models"
          echo "  Move its content to $COMFY_DIR/basedir/models to avoid downloading again."
        fi
        create_comfy_stack
        COMFY_STATUS="migrated to $COMFY_DIR ($COMFY_CONTAINER)"
      else
        warn "same image (mmartial/comfyui-nvidia-docker) but the container is managed by ANOTHER compose project (project='${PROJECT:-none}', file='${CONFIGFILE:-none/not-compose}')."
        echo "  No automatic update: recreating it from THIS docker-compose.yml would use different volume paths and disconnect it from its real models/userscripts."
        echo "  Update it manually through its own mechanism."
      fi
    else
      warn "ComfyUI container found with a different image ('$IMAGE') — we never touch a container we do not own. No update."
    fi

    # The effective bind-mounts are the source of truth (useful even when the container
    # belongs to another compose project).
    resolve_comfy_paths "$COMFY_CONTAINER"
  fi
else
  echo "No ComfyUI answering on :8188."
  restart_stopped_service "mmartial/comfyui-nvidia-docker" "ComfyUI" "http://localhost:8188/system_stats" 90 10
  rc=$?
  if [ "$rc" -eq 0 ]; then
    COMFY_CONTAINER="$RESTARTED_CONTAINER"
    COMFY_STATUS="restarted ($COMFY_CONTAINER)"
    resolve_comfy_paths "$COMFY_CONTAINER"
  elif [ "$rc" -eq 2 ]; then
    COMFY_CONTAINER="$RESTARTED_CONTAINER"
    COMFY_STATUS="restarted but not answering ($COMFY_CONTAINER)"
    resolve_comfy_paths "$COMFY_CONTAINER"
  elif port_taken_by_other 8188 "ComfyUI"; then
    COMFY_STATUS="skipped (port 8188 busy)"
  else
    create_comfy_stack
    COMFY_STATUS="created ($COMFY_CONTAINER, stack $COMFY_DIR)"
  fi
fi

# --- Ollama (port 11434) ---
OLLAMA_CONTAINER=""
OLLAMA_STATUS=""
echo "--- Ollama (:11434) ---"
if curl -sf http://localhost:11434/api/version >/dev/null 2>&1; then
  OLLAMA_CONTAINER="$(find_container_by_port 11434 || true)"
  # Ollama may run outside docker (native/systemd install): we no longer need to identify a
  # container to act on it, the model is pulled through the HTTP API (step 6).
  [ -z "$OLLAMA_CONTAINER" ] && OLLAMA_CONTAINER="native or unidentified service"
  OLLAMA_CONFIGFILE="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$OLLAMA_CONTAINER" 2>/dev/null || true)"
  if [ "$OLLAMA_CONFIGFILE" = "$REPO_ROOT/docker-compose.yml" ]; then
    warn "Ollama inherited from the old layout — migrating to $OLLAMA_DIR."
    mkdir -p "$OLLAMA_DIR/data"
    docker rm -f "$OLLAMA_CONTAINER" >/dev/null 2>&1 || true
    # Recover the weights from the inherited named volume: avoids re-downloading gemma4:e4b (9.6 GB).
    if docker volume inspect ollama-data >/dev/null 2>&1; then
      echo "Copying weights from the 'ollama-data' volume into $OLLAMA_DIR/data…"
      docker run --rm -v ollama-data:/from -v "$OLLAMA_DIR/data":/to alpine sh -c 'cp -a /from/. /to/' \
        || warn "weight copy failed — gemma4:e4b will be downloaded again."
    fi
    create_ollama_stack
    OLLAMA_STATUS="migrated to $OLLAMA_DIR ($OLLAMA_CONTAINER)"
  else
    echo "Ollama already running ($OLLAMA_CONTAINER) — reusing it, no recreation."
    OLLAMA_STATUS="reused ($OLLAMA_CONTAINER)"
  fi
else
  echo "No Ollama answering on :11434."
  restart_stopped_service "ollama/ollama" "Ollama" "http://localhost:11434/api/version" 15 2
  rc=$?
  if [ "$rc" -eq 0 ]; then
    OLLAMA_CONTAINER="$RESTARTED_CONTAINER"
    OLLAMA_STATUS="restarted ($OLLAMA_CONTAINER)"
  elif [ "$rc" -eq 2 ]; then
    OLLAMA_CONTAINER="$RESTARTED_CONTAINER"
    OLLAMA_STATUS="restarted but not answering ($OLLAMA_CONTAINER)"
  elif start_native_ollama; then
    OLLAMA_CONTAINER="native or unidentified service"
    OLLAMA_STATUS="started (native service)"
  elif [ "$NATIVE_OLLAMA_PRESENT" -eq 1 ]; then
    OLLAMA_STATUS="skipped (native Ollama installed but not started)"
  elif port_taken_by_other 11434 "Ollama"; then
    OLLAMA_STATUS="skipped (port 11434 busy)"
  else
    create_ollama_stack
    OLLAMA_STATUS="created ($OLLAMA_CONTAINER, stack $OLLAMA_DIR)"
  fi
fi

# --- App web (port 8090) ---
WEB_CONTAINER=""
WEB_STATUS=""
echo "--- App web (:8090) ---"
if curl -sf http://localhost:8090/ >/dev/null 2>&1; then
  WEB_CONTAINER="$(find_container_by_port 8090 || true)"
  [ -z "$WEB_CONTAINER" ] && WEB_CONTAINER="(inconnu)"
  echo "Web app already running in '$WEB_CONTAINER' — reusing it, no recreation."
  WEB_STATUS="reused ($WEB_CONTAINER)"
else
  echo "No web app answering on :8090 — creating it via docker compose."
  $COMPOSE up -d ai-content-studio
  WEB_CONTAINER="$(find_container_by_port 8090 || echo "ai-content-studio-web")"
  WEB_STATUS="created ($WEB_CONTAINER)"
fi

# --- Updater service ---
# Created as the user before the updater's bind-mount: otherwise dockerd creates it as root
# and uploading a LoRA from the UI fails.
mkdir -p "$COMFY_MODELS_DIR/loras" 2>/dev/null || warn "cannot create $COMFY_MODELS_DIR/loras (permissions?)."
echo "COMFY_LORAS_DIR=$COMFY_MODELS_DIR/loras" > "$REPO_ROOT/.env"
echo "LoRA path persisted in .env: COMFY_LORAS_DIR=$COMFY_MODELS_DIR/loras"

UPDATER_STATUS=""
echo "--- Updater service ---"
$COMPOSE up -d --build --force-recreate updater >/dev/null 2>&1 && UPDATER_STATUS="started" || UPDATER_STATUS="failed to start (see 'docker compose logs updater')"
echo "Updater service: $UPDATER_STATUS"

# ---------------------------------------------------------------------------
section "3/7 (merged into step 2 above: detection + ComfyUI update)"
# ---------------------------------------------------------------------------
echo "See above."

# ---------------------------------------------------------------------------
section "4/7 Deploying comfy_kitchen userscripts"
# ---------------------------------------------------------------------------
copied="$(copy_userscripts "$COMFY_USERSCRIPTS_DIR")"
echo "OK: ${copied:-0} file(s) copied to $COMFY_USERSCRIPTS_DIR"
if [ "$COMFY_CREATED" -eq 0 ]; then
  echo "Pre-existing ComfyUI: restart its stack so these userscripts actually run."
fi

# ---------------------------------------------------------------------------
section "5/7 Downloading models (scripts/models.txt)"
# ---------------------------------------------------------------------------
MODELS_FILE="$REPO_ROOT/scripts/models.txt"
DOWNLOADED_OK=()
SKIPPED_OK=()
FAILED_DL=()
MISSING_MANUAL=()

mkdir -p "$COMFY_MODELS_DIR" 2>/dev/null || true
if [ ! -w "$COMFY_MODELS_DIR" ]; then
  warn "model folder is not writable — downloads skipped: $COMFY_MODELS_DIR"
  echo "  Usual cause: folder created by Docker as root (padlock in the file manager)."
  echo "  Fix: sudo chown -R $(id -u):$(id -g) \"$COMFY_DIR\" then run this script again."
elif [ -f "$MODELS_FILE" ]; then
  while IFS='|' read -r dossier fichier taille url || [ -n "${dossier:-}" ]; do
    [ -z "${dossier:-}" ] && continue
    case "$dossier" in \#*) continue ;; esac
    url="${url%$'\r'}"
    target_dir="$COMFY_MODELS_DIR/$dossier"
    target_path="$target_dir/$fichier"

    if [ -z "$url" ] || [ "$url" = "NON_TROUVE" ]; then
      MISSING_MANUAL+=("$target_path")
      continue
    fi

    if [ -f "$target_path" ] && is_uint "$taille" && [ "$taille" -gt 0 ]; then
      actual_size="$(stat -c '%s' "$target_path" 2>/dev/null || echo 0)"
      if [ "$actual_size" -gt "$taille" ]; then diff=$((actual_size - taille)); else diff=$((taille - actual_size)); fi
      tolerance=$((taille / 100))
      [ "$tolerance" -lt 1 ] && tolerance=1
      if [ "$diff" -le "$tolerance" ]; then
        echo "SKIP (already present, size matches): $target_path"
        SKIPPED_OK+=("$target_path")
        continue
      fi
    fi

    mkdir -p "$target_dir"
    echo "Downloading: $fichier -> $target_path"
    # Some Hugging Face repositories (e.g. Lightricks/LTX-2.5) are "gated": an anonymous
    # download fails with 401 until the terms have been accepted on huggingface.co with an
    # account and an access token is provided. HF_TOKEN is used when set in the environment;
    # otherwise gated files fail cleanly and show up in the summary's failure list, without
    # blocking the other downloads.
    HF_AUTH_ARGS=()
    if [ -n "${HF_TOKEN:-}" ] && [[ "$url" == *"huggingface.co"* ]]; then
      HF_AUTH_ARGS=(-H "Authorization: Bearer ${HF_TOKEN}")
    fi
    if curl -sfL -C - "${HF_AUTH_ARGS[@]}" -o "$target_path" "$url"; then
      DOWNLOADED_OK+=("$target_path")
    else
      warn "download failed for '$fichier' from $url"
      FAILED_DL+=("$target_path ($url)")
    fi
  done < "$MODELS_FILE"
else
  echo "scripts/models.txt not found — no model to download for now."
fi

# ---------------------------------------------------------------------------
section "6/7 Required Ollama model (gemma4:e4b)"
# ---------------------------------------------------------------------------
GEMMA_STATUS="unknown"
if ! curl -sf http://localhost:11434/api/version >/dev/null 2>&1; then
  warn "Ollama is not answering on :11434 — cannot check or pull gemma4:e4b."
  GEMMA_STATUS="Ollama unavailable"
elif curl -sf http://localhost:11434/api/tags 2>/dev/null | grep -q '"gemma4:e4b"'; then
  echo "OK: gemma4:e4b already present."
  GEMMA_STATUS="present"
else
  echo "gemma4:e4b missing — pulling through the Ollama HTTP API (may take several minutes)..."
  # Through the API rather than 'docker exec': same behaviour whether Ollama runs in our
  # container, in another project's, or natively (systemd) — that last case used to leave the
  # model missing without the script noticing.
  curl -s -X POST http://localhost:11434/api/pull -d '{"model":"gemma4:e4b"}' -o /dev/null
  # /api/pull answers 200 even when the pull fails mid-stream: check the result again.
  if curl -sf http://localhost:11434/api/tags 2>/dev/null | grep -q '"gemma4:e4b"'; then
    GEMMA_STATUS="downloaded"
  else
    warn "gemma4:e4b pull failed — check 'curl -X POST localhost:11434/api/pull -d '\''{\"model\":\"gemma4:e4b\"}'\''"
    GEMMA_STATUS="failed"
  fi
fi

# ComfyUI replays its userscripts on the very first start (comfy_kitchen installation):
# several minutes during which :8188 does not answer yet. Without this wait, the script used
# to finish with "OK" while the app could not generate anything.
if [ "$COMFY_CREATED" -eq 1 ]; then
  echo
  echo "Waiting for ComfyUI on :8188 (first start, userscripts installation)…"
  for _ in $(seq 1 90); do
    curl -sf http://localhost:8188/system_stats >/dev/null 2>&1 && break
    sleep 10
  done
  if curl -sf http://localhost:8188/system_stats >/dev/null 2>&1; then
    echo "OK: ComfyUI answers."
  else
    warn "ComfyUI still not answering after 15 min — see 'docker logs comfyui-nvidia'."
  fi
fi

# ---------------------------------------------------------------------------
section "7/7 Final summary"
# ---------------------------------------------------------------------------
echo "Services:"
echo "  - ComfyUI : ${COMFY_STATUS:-unknown}"
echo "  - Ollama  : ${OLLAMA_STATUS:-unknown}"
echo "  - Web     : ${WEB_STATUS:-unknown}"
echo "  - Updater : ${UPDATER_STATUS:-unknown}"
echo
echo "Locations:"
echo "  - app     : $REPO_ROOT"
echo "  - ComfyUI : $COMFY_MODELS_DIR (models)"
OLLAMA_DATA="$(docker inspect --format '{{ range .Mounts }}{{ if eq .Destination "/root/.ollama" }}{{ .Source }}{{ end }}{{ end }}' "$OLLAMA_CONTAINER" 2>/dev/null || true)"
echo "  - Ollama  : ${OLLAMA_DATA:-$OLLAMA_DIR}"
echo
echo "Ollama model gemma4:e4b: $GEMMA_STATUS"
echo
echo "ComfyUI models (scripts/models.txt):"
echo "  - already present (not re-downloaded) : ${#SKIPPED_OK[@]}"
echo "  - downloaded this run                 : ${#DOWNLOADED_OK[@]}"
if [ "${#FAILED_DL[@]}" -gt 0 ]; then
  echo "  - download failures:"
  printf '      %s\n' "${FAILED_DL[@]}"
  echo "    (if the failure is a Lightricks/LTX-2.5 file: that Hugging Face repo is 'gated' —"
  echo "    accept its terms on the HF page with your account, then re-run this script as"
  echo "    HF_TOKEN=<your_token> ./install.sh)"
fi
if [ "${#MISSING_MANUAL[@]}" -gt 0 ]; then
  echo "  - to download manually (URL NON_TROUVE, see README):"
  printf '      %s\n' "${MISSING_MANUAL[@]}"
fi
echo
echo "Final health checks:"
for p in 8188 11434 8090; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${p}/" 2>/dev/null || echo "000")"
  echo "  - :$p -> HTTP $code"
done
code_update="000"
for _ in 1 2 3 4 5; do
  code_update="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8090/update/status" 2>/dev/null || echo "000")"
  [ "$code_update" = "200" ] && break
  sleep 2
done
echo "  - /update/status -> HTTP $code_update"
