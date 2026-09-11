#!/usr/bin/env bash
# install2.sh — v2 of the Dell AI Content Studio installer for GB10/DGX Spark.
#
# Same job as install.sh v1 (deploy nginx web + updater here, ComfyUI in ~/comfyui-spark,
# Ollama in ~/ollama), rebuilt around the lessons that v1 learned the hard way:
#
#  1. ONE decision tree for every service, not one copy per service. In v1, ComfyUI and
#     Ollama each carried their own 40-line branch: the "service installed but stopped" fix
#     had to be written twice, and the native-install case was missed on one of them for a
#     while. Here `ensure_service` is generic and driven by a table.
#  2. "Does not answer" never means "absent". A service can be a stopped container, a native
#     systemd unit that is down, or something else holding the port. Creating a second
#     instance is always wrong (name clash, two daemons fighting for a port).
#  3. Bind-mount source directories are created as the user BEFORE the container. A source
#     that does not exist is created by dockerd as root:root — that single fact is what broke
#     the first GB10 deployment (locked folder, every model download failing).
#  4. A container's mounts are the truth about where it reads models, never the default path.
#  5. Verification goes through nginx (:8090/comfy/...), because that is the path the browser
#     takes. Testing :8188 directly hides a broken proxy.
#  6. Report reality and exit accordingly: a run that leaves the app unable to generate must
#     not exit 0.
#  7. Everything is re-runnable, and every destructive-looking step is refused rather than
#     forced: no sudo on the user's behalf, no touching a container we do not own.
#  8. ONE state collector. `fingerprint` reads every signal once, `verdict_*` turn those
#     signals into one verdict per component, `headline_state` summarises them FOR DISPLAY
#     only, `build_plan` derives the steps from the verdicts and `run_plan` executes them.
#     The five displayed states are a summary, never a branch selector: a real machine is
#     mixed (a third-party ComfyUI, a foreign Ollama, our own web app) and a single global
#     `case` on the state would lie about it.
#
# Usage:
#   ./install2.sh                 install / repair / update, idempotent
#   ./install2.sh --check         diagnose only, change nothing (the runbook, as code)
#   ./install2.sh --dry-run       print the plan and each step it would take, change nothing
#                                 (with --mode uninstall: what it would remove)
#   ./install2.sh --mode M        fresh | repair: only the plan's header changes — the steps always
#                                 come from the state of the machine. uninstall: remove the
#                                 containers this installer created, never any data
#   ./install2.sh --skip-models   download no model file. The Ollama model is still pulled, legacy
#                                 models are still moved, and missing model files still exit 2
#   ./install2.sh --yes           answer yes to the plan confirmation, to the takeover of a broken
#                                 third-party ComfyUI and to the uninstall removals (without a
#                                 terminal, uninstall also needs --components). Never answers the
#                                 Hugging Face token prompt, the question to save that token, nor
#                                 the question to start a third-party compose file
#   ./install2.sh --components L  uninstall only: comma-separated web,updater,comfyui,ollama
#   ./install2.sh --smoke         after the install, prove it with a reduced real render (python3)
#   ./install2.sh --log FILE      log file (default ~/install2-YYYY-MM-DD-HHMM.log)
#
# Exit codes: 0 everything the app needs is in place (uninstall: everything announced was done)
#             1 usage/prerequisite error
#             2 finished — --check included — but the app cannot generate, or an uninstall could
#               not remove a container it owns

set -uo pipefail

# The Hugging Face token never reaches a child process: exported, it lands in every container
# `docker compose up` creates (the ComfyUI template reads ${HF_TOKEN:-}), readable by anyone who
# runs docker inspect. It moves into plain, non-exported variables before anything else runs:
# HF_TOK_ENV is what the environment offered, HF_TOK only ever a token huggingface.co accepted.
HF_TOK_ENV="${HF_TOKEN:-}"; HF_TOK=""; export -n HF_TOK_ENV HF_TOK; unset HF_TOKEN

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"
COMPOSE="docker compose"

COMFY_DIR="$HOME/comfyui-spark"
OLLAMA_DIR="$HOME/ollama"
OLLAMA_MODEL="gemma4:e4b"
MODELS_FILE="$REPO_ROOT/scripts/models.txt"
WEB_PORT=8090
# A gated file is defined by its URL, never by a hardcoded count: models.txt holds five.
GATED_REPO="huggingface.co/Lightricks/LTX-2.5/"

MODE=auto               # auto | check | dry-run | fresh | repair | uninstall
MODE_ARG=""             # value of --mode, used for the plan header even in check/dry-run
PLAN_MODE=repair
SKIP_MODELS=0
ASSUME_YES=0
SMOKE=0
COMPONENTS=""
LOG_FILE="$HOME/install2-$(date +%F-%H%M).log"

while [ $# -gt 0 ]; do
  case "$1" in
    --check)       MODE=check ;;
    --dry-run)     MODE=dry-run ;;
    --mode)        shift
                   case "${1:-}" in
                     fresh|repair|uninstall) MODE_ARG="$1"; [ "$MODE" = auto ] && MODE="$1" ;;
                     *) echo "Unknown mode: ${1:-} (fresh, repair or uninstall)" >&2; exit 1 ;;
                   esac ;;
    --skip-models) SKIP_MODELS=1 ;;
    --yes)         ASSUME_YES=1 ;;
    --smoke)       SMOKE=1 ;;
    --components)  shift; COMPONENTS="${1:-}" ;;
    --log)         shift; LOG_FILE="${1:-}" ;;
    -h|--help)     sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
  shift
done
# A typo in --components must not silently shrink an uninstall to nothing.
[[ -z "$COMPONENTS" || "$COMPONENTS" =~ ^(web|updater|comfyui|ollama)(,(web|updater|comfyui|ollama))*$ ]] \
  || { echo "Unknown component in --components '$COMPONENTS': valid names are web, updater, comfyui, ollama (comma-separated)" >&2; exit 1; }

# ── Output ────────────────────────────────────────────────────────────────────
# Everything is teed to a log file, in every mode: a real run lasts hours and the interesting
# lines scroll past during downloads. v1 asked the user to pipe through tee by hand.
# The terminal is tested BEFORE the redirection: afterwards stdout is always the tee pipe.
BOLD=""; RESET=""
[ -t 1 ] && { BOLD=$'\033[1m'; RESET=$'\033[0m'; }
exec > >(tee -a "$LOG_FILE") 2>&1
section() { printf '\n%s=== %s ===%s\n' "$BOLD" "$*" "$RESET"; }
info()    { printf '%s\n' "$*"; }
ok()      { printf 'OK: %s\n' "$*"; }
warn()    { printf 'WARNING: %s\n' "$*"; }
err()     { printf 'ERROR: %s\n' "$*" >&2; }
# Actions are announced before they run, and skipped in check/dry-run mode.
would()   { printf '  would %s\n' "$*"; }
acting()  { case "$MODE" in fresh|repair|uninstall) return 0 ;; *) return 1 ;; esac; }

is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# Collected for the final summary; each entry is "service|status".
declare -a REPORT=()
report() { REPORT+=("$1|$2"); }
PROBLEMS=0

# ── Asking the user ───────────────────────────────────────────────────────────
# INSTALL2_ASSUME_TTY is a documented test hook: the harness pipes the answers in on stdin,
# which is not a terminal, and still needs the interactive path. `read` therefore always
# reads stdin, never /dev/tty, or that injection would be impossible.
interactive() { [ -t 0 ] || [ -n "${INSTALL2_ASSUME_TTY:-}" ]; }

# `read -r -p` prints nothing at all when stdin is not a terminal (verified): every question
# is printed here, explicitly, before the read. Empty answer = no, everywhere.
confirm() {   # question
  local ans
  printf '%s\n' "$1"
  # No terminal means nobody will ever answer. A read here would block forever on an open but
  # silent stdin (ssh without -t, a CI runner, a service) — this froze the first v2 prompt for
  # the Hugging Face token. The default answer is "no" everywhere, so give it without reading.
  interactive || { info "  no TTY: answered no"; return 1; }
  read -r ans || ans=""
  case "$ans" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

# ── Service table ─────────────────────────────────────────────────────────────
# port | health path | image pattern | stack dir | template | native unit | tries | delay
service_spec() {
  case "$1" in
    comfyui) printf '8188|/system_stats|mmartial/comfyui-nvidia-docker|%s|docker/stacks/comfyui.yml||90|10\n' "$COMFY_DIR" ;;
    ollama)  printf '11434|/api/version|ollama/ollama|%s|docker/stacks/ollama.yml|ollama.service|15|2\n' "$OLLAMA_DIR" ;;
    *)       return 1 ;;
  esac
}
spec_field() { service_spec "$1" | cut -d'|' -f"$2"; }

# Per-service preparation, run once, before the container exists. This is where lesson 3
# lives: every bind-mount source is created here, by us, as the current user.
prepare_comfyui() {
  mkdir -p "$COMFY_DIR/basedir/models" "$COMFY_DIR/run" "$COMFY_DIR/userscripts_dir"
  # Real uid/gid: compose reads this .env from the project directory, including on a manual
  # `docker compose up -d` later on.
  [ -f "$COMFY_DIR/.env" ] || printf 'WANTED_UID=%s\nWANTED_GID=%s\n' "$(id -u)" "$(id -g)" > "$COMFY_DIR/.env"
  # Userscripts only run when the container starts, so they must be in place beforehand.
  local n=0 f
  for f in "$REPO_ROOT"/docker/userscripts/*; do
    [ -f "$f" ] || continue
    cp -f "$f" "$COMFY_DIR/userscripts_dir/" && chmod +x "$COMFY_DIR/userscripts_dir/$(basename "$f")" && n=$((n + 1))
  done
  info "  userscripts deployed before first start: $n file(s)"
}
prepare_ollama() { mkdir -p "$OLLAMA_DIR/data"; }

# Run just before a legacy container is replaced: rescue what it owned. The volume is copied
# from, never removed: on a real machine it can belong to somebody else (open-webui).
premigrate_ollama() {
  case "$VERDICT_OLLAMA" in legacy-up|legacy-down) ;; *) return 0 ;; esac
  docker volume inspect ollama-data >/dev/null 2>&1 || return 0
  info "  copying weights from the legacy 'ollama-data' volume into $OLLAMA_DIR/data (avoids a 9.6 GB download)"
  acting || return 0
  mkdir -p "$OLLAMA_DIR/data"
  docker run --rm -v ollama-data:/from -v "$OLLAMA_DIR/data":/to alpine sh -c 'cp -a /from/. /to/' \
    || warn "weight copy failed — $OLLAMA_MODEL will be pulled again."
}
premigrate_comfyui() { :; }

# ── Primitives ────────────────────────────────────────────────────────────────
health() { curl -sf -m 10 "http://localhost:$1$2" >/dev/null 2>&1; }

wait_health() {   # port path tries delay
  local i
  for i in $(seq 1 "$3"); do
    health "$1" "$2" && return 0
    sleep "$4"
  done
  health "$1" "$2"
}

port_busy() {
  if command -v ss >/dev/null 2>&1; then ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
  else (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3>&-
  fi
}

container_on_port() {
  local name c
  name=$(docker ps --filter "publish=$1" --format '{{.Names}}' 2>/dev/null | head -n1)
  [ -n "$name" ] && { printf '%s\n' "$name"; return 0; }
  # nginx runs in host network mode and publishes nothing: identify it by the mount that
  # only it has (the updater also mounts the repo root, at a different destination). For the
  # web port only: asked about :8188 or :11434 while nothing publishes them, this fallback used
  # to answer "the web container" — whose compose label made it a legacy ComfyUI to rm -f.
  [ "$1" = "$WEB_PORT" ] || return 1
  for c in $(docker ps --filter "network=host" --format '{{.Names}}' 2>/dev/null); do
    docker inspect --format '{{json .Mounts}}' "$c" 2>/dev/null | grep -qF "\"Source\":\"$REPO_ROOT\"" \
      && docker inspect --format '{{json .Mounts}}' "$c" 2>/dev/null | grep -qF '"Destination":"/usr/share/nginx/html"' \
      && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

stopped_container_for() {   # image pattern
  docker ps -a --filter status=exited --filter status=created --filter status=paused \
    --format '{{.Names}}\t{{.Image}}' 2>/dev/null | awk -F'\t' -v p="$1" 'index($2,p){print $1; exit}'
}

compose_label_of() {   # container key
  [ -n "$1" ] || return 0
  docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null
}

native_unit_present() {   # unit
  [ -n "$1" ] || return 1
  command -v "${1%.service}" >/dev/null 2>&1 && return 0
  command -v systemctl >/dev/null 2>&1 && systemctl cat "$1" >/dev/null 2>&1
}

# ── The state fingerprint (A.1) ───────────────────────────────────────────────
# Read-only, run once, identical in every mode. Nothing below re-probes: ensure_service,
# the diagnosis and the plan all consume these variables. Failures are tolerated silently:
# a missing container or an unreachable port is a signal, not an error.
VERDICT_COMFY=""; VERDICT_OLLAMA=""; VERDICT_WEB=""; VERDICT_MODELS=""
COMFY_ROOT_OWNED=0
HEADLINE=""; HEADLINE_LINE=""
declare -a PLAN=() KEPT=()

# One flag per announced step. build_plan raises a flag on the very line that prints the step,
# run_plan performs a step ONLY when its flag is up: the printed plan and the pipeline read the
# same source of truth, so what is announced is exactly what runs.
PLAN_DO_TAKEOVER=0; PLAN_DO_WEB=0; PLAN_DO_ENV=0; PLAN_DO_UPDATER=0
PLAN_DO_MIGRATE=0;  PLAN_DO_TOKEN=0; PLAN_DO_MODELS=0; PLAN_DO_SMOKE=0

fingerprint() {
  local d f s u dfdir

  FP_ARCH="$(uname -m)"

  # ComfyUI
  FP_COMFY_HEALTH=0; health 8188 /system_stats && FP_COMFY_HEALTH=1
  FP_COMFY_RUN="$(container_on_port 8188 || true)"
  FP_COMFY_STOPPED="$(stopped_container_for 'mmartial/comfyui-nvidia-docker')"
  FP_COMFY_CFGFILE=""; FP_COMFY_PROJECT=""; FP_COMFY_SERVICE=""; FP_COMFY_IMAGE=""; FP_COMFY_BASEDIR=""
  FP_COMFY_MOUNTS=""; FP_COMFY_ENV_BASE=""; FP_COMFY_ENV_UID=""; FP_COMFY_ENV_GID=""; FP_COMFY_NETS=""
  if [ -n "$FP_COMFY_RUN" ]; then
    FP_COMFY_CFGFILE="$(compose_label_of "$FP_COMFY_RUN" com.docker.compose.project.config_files)"
    FP_COMFY_PROJECT="$(compose_label_of "$FP_COMFY_RUN" com.docker.compose.project)"
    FP_COMFY_SERVICE="$(compose_label_of "$FP_COMFY_RUN" com.docker.compose.service)"
    FP_COMFY_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$FP_COMFY_RUN" 2>/dev/null)"
    FP_COMFY_BASEDIR="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/basedir"}}{{.Source}}{{end}}{{end}}' "$FP_COMFY_RUN" 2>/dev/null)"
    FP_COMFY_MOUNTS="$(docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' "$FP_COMFY_RUN" 2>/dev/null)"
    # One key at a time, straight from the pipe: the rest of Config.Env (a third-party container's
    # secrets, on the reference machine a Hugging Face token) never lands in a variable.
    FP_COMFY_ENV_BASE="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$FP_COMFY_RUN" 2>/dev/null | sed -n 's/^BASE_DIRECTORY=//p')"
    FP_COMFY_ENV_UID="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$FP_COMFY_RUN" 2>/dev/null | sed -n 's/^WANTED_UID=//p')"
    FP_COMFY_ENV_GID="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$FP_COMFY_RUN" 2>/dev/null | sed -n 's/^WANTED_GID=//p')"
    FP_COMFY_NETS="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$FP_COMFY_RUN" 2>/dev/null)"; FP_COMFY_NETS="${FP_COMFY_NETS% }"
  fi
  # Where a takeover would act: next to the container's REAL compose file (first entry of the
  # comma-separated label), wherever it lives — never $COMFY_DIR by assumption. The override is
  # named the way Compose pairs it with that file (compose.yaml -> compose.override.yaml, auto-
  # loaded on a later plain `docker compose up -d` there); the takeover itself passes it with -f.
  FP_COMFY_CFGDIR=""; FP_COMFY_OVR=""
  if [ -n "$FP_COMFY_CFGFILE" ]; then
    f="${FP_COMFY_CFGFILE%%,*}"; FP_COMFY_CFGDIR="${f%/*}"; f="${f##*/}"
    FP_COMFY_OVR="$FP_COMFY_CFGDIR/${f%.*}.override.${f##*.}"
  fi
  FP_COMFY_STOPPED_CFG="$(compose_label_of "$FP_COMFY_STOPPED" com.docker.compose.project.config_files)"
  # "Is this ComfyUI ours?" — the compose label is NOT enough: a third-party stack can sit at
  # exactly the path our template would occupy. The content decides. Our template writes
  # WANTED_UID: "${WANTED_UID:-1000}" (a variable) and install2.sh writes the .env next to it;
  # a hand-written file has the literal uid and no .env.
  FP_COMFY_YAML=0; [ -f "$COMFY_DIR/compose.yaml" ] && FP_COMFY_YAML=1
  FP_COMFY_YAML_OURS=0
  [ "$FP_COMFY_YAML" = 1 ] && grep -qF '${WANTED_UID' "$COMFY_DIR/compose.yaml" 2>/dev/null \
    && [ -f "$COMFY_DIR/.env" ] && FP_COMFY_YAML_OURS=1
  FP_COMFY_OWNER="$(stat -c%U "$COMFY_DIR/basedir" 2>/dev/null || true)"
  # Read straight from :8188, not through nginx: this asks ComfyUI what it offers, and the
  # proxy is proven separately by verify().
  FP_COMFY_LISTS=""
  [ "$FP_COMFY_HEALTH" = 1 ] && FP_COMFY_LISTS="$(curl -s -m 10 http://localhost:8188/object_info/UNETLoader 2>/dev/null)"

  # Ollama
  FP_OLLAMA_HEALTH=0; health 11434 /api/version && FP_OLLAMA_HEALTH=1
  FP_OLLAMA_RUN="$(container_on_port 11434 || true)"
  FP_OLLAMA_STOPPED="$(stopped_container_for 'ollama/ollama')"
  FP_OLLAMA_CFGFILE="$(compose_label_of "$FP_OLLAMA_RUN" com.docker.compose.project.config_files)"
  FP_OLLAMA_STOPPED_CFG="$(compose_label_of "$FP_OLLAMA_STOPPED" com.docker.compose.project.config_files)"
  FP_OLLAMA_DATA=""
  [ -n "$FP_OLLAMA_RUN" ] && FP_OLLAMA_DATA="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/root/.ollama"}}{{.Type}} {{.Name}}{{.Source}}{{end}}{{end}}' "$FP_OLLAMA_RUN" 2>/dev/null)"
  FP_OLLAMA_NATIVE=0; native_unit_present ollama.service && FP_OLLAMA_NATIVE=1
  FP_VOL_OLLAMA=0; docker volume inspect ollama-data >/dev/null 2>&1 && FP_VOL_OLLAMA=1
  # Two different ways to depend on Ollama, kept apart because they mean different things to
  # the user: containers that MOUNT the 'ollama-data' volume, and containers that talk to the
  # Ollama SERVICE over HTTP (a chat frontend like open-webui: OLLAMA_BASE_URL=...:11434, no
  # mount at all). Removing Ollama cuts the second kind off its LLM even though the volume stays.
  # Running containers only are scanned for HTTP clients, so exited leftovers do not pollute it.
  FP_VOL_OLLAMA_USERS="$(docker ps -a --filter volume=ollama-data --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')"; FP_VOL_OLLAMA_USERS="${FP_VOL_OLLAMA_USERS% }"
  FP_OLLAMA_CLIENTS=""
  for u in $(docker ps --format '{{.Names}}' 2>/dev/null); do
    case " $FP_VOL_OLLAMA_USERS $FP_OLLAMA_RUN " in *" $u "*) continue ;; esac
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$u" 2>/dev/null | grep -q ':11434' \
      && FP_OLLAMA_CLIENTS="$FP_OLLAMA_CLIENTS $u"
  done
  FP_OLLAMA_CLIENTS="${FP_OLLAMA_CLIENTS# }"
  FP_GEMMA=0
  [ "$FP_OLLAMA_HEALTH" = 1 ] && FP_GEMMA="$(curl -sf -m 10 http://localhost:11434/api/tags 2>/dev/null | grep -c "\"$OLLAMA_MODEL\"")"
  is_uint "$FP_GEMMA" || FP_GEMMA=0

  # Web app + updater
  FP_WEB_HEALTH=0; health "$WEB_PORT" / && FP_WEB_HEALTH=1
  FP_UPD_HEALTH=0; health "$WEB_PORT" /update/status && FP_UPD_HEALTH=1
  FP_WEB_RUN="$(container_on_port "$WEB_PORT" || true)"
  FP_WEB_CFGFILE="$(compose_label_of "$FP_WEB_RUN" com.docker.compose.project.config_files)"
  # The updater is found by its compose labels (this repo's compose file, service "updater"), never
  # by image name: another checkout of the app on the same machine runs its own "*-updater".
  FP_UPD_RUN="$(docker ps --filter "label=com.docker.compose.project.config_files=$REPO_ROOT/docker-compose.yml" \
    --filter label=com.docker.compose.service=updater --format '{{.Names}}' 2>/dev/null | head -n1)"

  # Ports
  FP_PORT_8188=0; port_busy 8188 && FP_PORT_8188=1
  FP_PORT_11434=0; port_busy 11434 && FP_PORT_11434=1
  FP_PORT_8090=0; port_busy "$WEB_PORT" && FP_PORT_8090=1

  # Models: the container's mounts are the truth, the default path is the fallback (lesson 4).
  if [ -n "$FP_COMFY_BASEDIR" ]; then FP_MODELS_DIR="$FP_COMFY_BASEDIR/models"
  else FP_MODELS_DIR="$COMFY_DIR/basedir/models"; fi
  MODELS_DIR="$FP_MODELS_DIR"

  # Models downloaded by the old layout, inside the repository, where no ComfyUI reads them. One
  # already present at its destination is a DUPLICATE, not a misplaced model: counted as
  # misplaced, it kept the machine in OLD LAYOUT forever (mv -n refuses to overwrite, exit 1).
  # When ComfyUI reads the legacy folder itself (an inherited container), every file is misplaced.
  FP_LEGACY_DIR="$REPO_ROOT/comfyui/basedir/models"
  FP_LEGACY_DIR_N=0; FP_LEGACY_DUP_N=0
  while IFS= read -r -d '' f; do
    if [ "$FP_MODELS_DIR" != "$FP_LEGACY_DIR" ] && [ -e "$FP_MODELS_DIR/${f#"$FP_LEGACY_DIR"/}" ]; then
      FP_LEGACY_DUP_N=$((FP_LEGACY_DUP_N + 1))
    else FP_LEGACY_DIR_N=$((FP_LEGACY_DIR_N + 1)); fi
  done < <(find "$FP_LEGACY_DIR" -type f -print0 2>/dev/null)

  scan_models
  FP_MODELS_OK="$MODELS_OK"; FP_MODELS_BAD="$MODELS_BAD"; FP_MODELS_BYTES="$MODELS_BYTES_NEEDED"
  FP_MODELS_TOTAL=$((MODELS_OK + MODELS_BAD))

  # Gated files are counted, never hardcoded.
  FP_GATED_TOTAL=0; FP_GATED_BAD=0
  if [ -f "$MODELS_FILE" ]; then
    while IFS='|' read -r d f s u; do
      case "${d:-}" in ''|\#*) continue ;; esac
      u="${u%$'\r'}"
      case "$u" in *"$GATED_REPO"*) ;; *) continue ;; esac
      FP_GATED_TOTAL=$((FP_GATED_TOTAL + 1))
      [ "$(model_status "$d" "$f" "$s")" = OK ] || FP_GATED_BAD=$((FP_GATED_BAD + 1))
    done < "$MODELS_FILE"
  fi

  # Free space where the models will land (the deepest existing parent, so this works on a
  # virgin machine where nothing has been created yet).
  dfdir="$FP_MODELS_DIR"
  while [ ! -d "$dfdir" ] && [ "$dfdir" != / ]; do dfdir="$(dirname "$dfdir")"; done
  FP_DISK_DIR="$dfdir"
  FP_DISK_FREE_GB="$(df -Pk "$dfdir" 2>/dev/null | awk 'NR==2{print int($4/1000000)}')"
  is_uint "${FP_DISK_FREE_GB:-}" || FP_DISK_FREE_GB=0

  # "Which diffusion models does ComfyUI list?" for EVERY ComfyUI, ours included: verdict_comfyui
  # only asks comfy_broken about third-party ones, which left FP_COMFY_LISTED at 0 for our own
  # stack — the headline could never be UP TO DATE and the diagnosis read "0 of the 0".
  comfy_broken || true
}

# "This third-party ComfyUI is BROKEN for us" — the three conditions of A.1.4 and nothing
# else. The comparison is made against the diffusion model names actually on disk, never
# against a hardcoded name: on a machine holding only the Krea 2 files, a hardcoded grep
# would wrongly conclude "broken". No diffusion model on disk = inconclusive = not broken.
FP_COMFY_DISK_N=0; FP_COMFY_LISTED=0; FP_COMFY_LISTED_NAMES=""
comfy_broken() {
  local d f s u
  FP_COMFY_DISK_N=0; FP_COMFY_LISTED=0; FP_COMFY_LISTED_NAMES=""
  [ "$FP_COMFY_HEALTH" = 1 ] || return 1
  [ -f "$MODELS_FILE" ] || return 1
  while IFS='|' read -r d f s u; do
    case "${d:-}" in ''|\#*) continue ;; esac
    [ "$d" = diffusion_models ] || continue
    [ "$(model_status "$d" "$f" "$s")" = OK ] || continue
    FP_COMFY_DISK_N=$((FP_COMFY_DISK_N + 1))
    case "$FP_COMFY_LISTS" in
      *"$f"*) FP_COMFY_LISTED=$((FP_COMFY_LISTED + 1)); FP_COMFY_LISTED_NAMES="$FP_COMFY_LISTED_NAMES$f " ;;
    esac
  done < "$MODELS_FILE"
  [ "$FP_COMFY_DISK_N" -gt 0 ] || return 1
  [ "$FP_COMFY_LISTED" -eq 0 ]
}

# ── Verdicts (A.1.3) — first rule that matches wins ───────────────────────────
verdict_comfyui() {
  # The compose label is examined BEFORE the "stopped container" case: an inherited container
  # that is merely stopped must be migrated, not restarted (the real defect of v1's tree).
  if [ -n "$FP_COMFY_RUN" ] && [ "$FP_COMFY_CFGFILE" = "$REPO_ROOT/docker-compose.yml" ]; then VERDICT_COMFY=legacy-up
  elif [ -n "$FP_COMFY_STOPPED" ] && [ "$FP_COMFY_STOPPED_CFG" = "$REPO_ROOT/docker-compose.yml" ]; then VERDICT_COMFY=legacy-down
  elif [ "$FP_COMFY_HEALTH" = 1 ] && [ -n "$FP_COMFY_RUN" ] && [ "$FP_COMFY_YAML_OURS" = 0 ] && comfy_broken; then VERDICT_COMFY=foreign-broken
  elif [ "$FP_COMFY_HEALTH" = 1 ] && [ -n "$FP_COMFY_RUN" ] && [ "$FP_COMFY_YAML_OURS" = 0 ]; then VERDICT_COMFY=foreign-ok
  elif [ "$FP_COMFY_HEALTH" = 1 ] && [ -n "$FP_COMFY_RUN" ]; then VERDICT_COMFY=ours-up
  elif [ "$FP_COMFY_HEALTH" = 1 ]; then VERDICT_COMFY=unmanaged-up
  elif [ -n "$FP_COMFY_STOPPED" ]; then VERDICT_COMFY=stopped
  elif [ "$FP_COMFY_YAML" = 1 ] && [ "$FP_COMFY_YAML_OURS" = 1 ]; then VERDICT_COMFY=ours-dir-only
  elif [ "$FP_COMFY_YAML" = 1 ]; then VERDICT_COMFY=foreign-dir-only
  elif [ "$FP_PORT_8188" = 1 ]; then VERDICT_COMFY=port-busy
  else VERDICT_COMFY=absent
  fi
  # Orthogonal modifier, cumulative with any verdict: the padlock of lesson 3.
  COMFY_ROOT_OWNED=0
  if [ -n "$FP_COMFY_OWNER" ] && [ "$FP_COMFY_OWNER" != "$(id -un)" ]; then
    COMFY_ROOT_OWNED=1; PROBLEMS=$((PROBLEMS + 1))
  fi
}

verdict_ollama() {
  if [ -n "$FP_OLLAMA_RUN" ] && [ "$FP_OLLAMA_CFGFILE" = "$REPO_ROOT/docker-compose.yml" ]; then VERDICT_OLLAMA=legacy-up
  elif [ -n "$FP_OLLAMA_STOPPED" ] && [ "$FP_OLLAMA_STOPPED_CFG" = "$REPO_ROOT/docker-compose.yml" ]; then VERDICT_OLLAMA=legacy-down
  elif [ "$FP_OLLAMA_HEALTH" = 1 ] && [ -n "$FP_OLLAMA_RUN" ] && [ "$FP_OLLAMA_CFGFILE" = "$OLLAMA_DIR/compose.yaml" ]; then VERDICT_OLLAMA=ours-up
  elif [ "$FP_OLLAMA_HEALTH" = 1 ] && [ -n "$FP_OLLAMA_RUN" ]; then VERDICT_OLLAMA=foreign
  elif [ "$FP_OLLAMA_HEALTH" = 1 ]; then VERDICT_OLLAMA=native-up
  elif [ -n "$FP_OLLAMA_STOPPED" ]; then VERDICT_OLLAMA=stopped
  elif [ "$FP_OLLAMA_NATIVE" = 1 ]; then VERDICT_OLLAMA=native-down
  elif [ "$FP_PORT_11434" = 1 ]; then VERDICT_OLLAMA=port-busy
  else VERDICT_OLLAMA=absent
  fi
}

verdict_web() {
  if [ "$FP_WEB_HEALTH" = 1 ]; then VERDICT_WEB=up
  elif [ -n "$FP_WEB_RUN" ]; then VERDICT_WEB=down
  else VERDICT_WEB=absent
  fi
}

verdict_models() {
  if [ "$FP_LEGACY_DIR_N" -gt 0 ]; then VERDICT_MODELS=misplaced
  elif [ "$MODE" != check ] && [ "$MODE" != dry-run ] && [ -d "$FP_MODELS_DIR" ] && [ ! -w "$FP_MODELS_DIR" ]; then VERDICT_MODELS=unreadable
  elif [ "$FP_MODELS_BAD" -eq 0 ]; then VERDICT_MODELS=complete
  else VERDICT_MODELS=partial
  fi
}

# The five states are a DISPLAY summary of the verdicts above, never a branch selector.
headline_state() {
  case "$VERDICT_COMFY" in
    foreign-ok|foreign-broken|foreign-dir-only)
      HEADLINE="FOREIGN COMFYUI"
      HEADLINE_LINE="FOREIGN COMFYUI — a ComfyUI this installer did not create answers on :8188"
      return ;;
  esac
  case "$VERDICT_COMFY:$VERDICT_OLLAMA:$VERDICT_MODELS" in
    legacy-*:*|*:legacy-*:*|*:*:misplaced)
      HEADLINE="OLD LAYOUT"
      HEADLINE_LINE="OLD LAYOUT (pre-1.0.7) — containers created by this repository's own compose file"
      return ;;
  esac
  if [ "$VERDICT_COMFY" = absent ] && [ "$VERDICT_OLLAMA" = absent ] && [ "$VERDICT_WEB" = absent ] \
     && [ "$FP_LEGACY_DIR_N" -eq 0 ] && [ "$FP_COMFY_YAML" = 0 ]; then
    HEADLINE="VIRGIN"; HEADLINE_LINE="VIRGIN — no part of this application is installed"; return
  fi
  if [ "$VERDICT_COMFY" = ours-up ] && [ "$VERDICT_WEB" = up ] && [ "$FP_UPD_HEALTH" = 1 ] \
     && [ "$VERDICT_MODELS" = complete ] && [ "$FP_COMFY_LISTED" -gt 0 ] && [ "$FP_GEMMA" -gt 0 ]; then
    case "$VERDICT_OLLAMA" in
      ours-up|native-up|foreign)
        HEADLINE="UP TO DATE"; HEADLINE_LINE="UP TO DATE — everything the app needs is in place"; return ;;
    esac
  fi
  HEADLINE="PARTIAL OR BROKEN"
  HEADLINE_LINE="PARTIAL OR BROKEN — some of the parts are missing, stopped or not answering"
}

# ── Diagnosis (A.2.1) ─────────────────────────────────────────────────────────
dline() { printf '  %-9s: %s\n' "$1" "$2"; }
dcont() { printf '             %s\n' "$*"; }
dfield() { dcont "$(printf '%-16s: %s' "$1" "$2")"; }

diagnosis() {
  section "Diagnosis"
  dline state "$HEADLINE_LINE"

  case "$VERDICT_COMFY" in
    legacy-up)
      dline comfyui "'$FP_COMFY_RUN' answers on :8188 — compose file $FP_COMFY_CFGFILE"
      [ -n "$FP_COMFY_ENV_BASE" ] || dcont "BASE_DIRECTORY is unset in that container: this is why it lists no model" ;;
    legacy-down)
      dline comfyui "stopped container '$FP_COMFY_STOPPED' — compose file $FP_COMFY_STOPPED_CFG"
      dcont "an inherited container is migrated, never restarted" ;;
    foreign-ok|foreign-broken)
      dline comfyui "'$FP_COMFY_RUN' (${FP_COMFY_IMAGE:-image unknown})"
      dfield "compose project" "${FP_COMFY_PROJECT:-(none)}"
      dfield "compose file" "${FP_COMFY_CFGFILE:-(none)}   (not written by this installer)"
      dfield networks "${FP_COMFY_NETS:-(none)}"
      diag_mounts
      dfield BASE_DIRECTORY "${FP_COMFY_ENV_BASE:-(unset)}"
      dfield lists "$FP_COMFY_LISTED of the $FP_COMFY_DISK_N diffusion model(s) present on disk"
      [ "$VERDICT_COMFY" = foreign-broken ] \
        && dcont "=> BROKEN for this application: the models are there, ComfyUI does not offer them" ;;
    ours-up)
      dline comfyui "'$FP_COMFY_RUN' answers on :8188 — stack $COMFY_DIR/compose.yaml"
      dfield lists "$FP_COMFY_LISTED of the $FP_COMFY_DISK_N diffusion model(s) present on disk" ;;
    unmanaged-up)  dline comfyui "answers on :8188, in no container this script can see — reused as is" ;;
    stopped)       dline comfyui "stopped container '$FP_COMFY_STOPPED' — to be started, never duplicated" ;;
    ours-dir-only) dline comfyui "no container, but $COMFY_DIR/compose.yaml was written by this installer" ;;
    foreign-dir-only)
      dline comfyui "no container, and $COMFY_DIR/compose.yaml was not written by this installer"
      dcont "starting it would start the third-party project '$(basename "$COMFY_DIR")'" ;;
    port-busy)     dline comfyui "does not answer, but :8188 is held by another process" ;;
    *)             dline comfyui "absent (no container, no $COMFY_DIR/compose.yaml, :8188 free)" ;;
  esac
  [ "$COMFY_ROOT_OWNED" = 1 ] && dcont "$COMFY_DIR/basedir belongs to '$FP_COMFY_OWNER', not to $(id -un) — every download will fail"

  case "$VERDICT_OLLAMA" in
    legacy-up)   dline ollama "'$FP_OLLAMA_RUN' answers on :11434 — compose file $FP_OLLAMA_CFGFILE" ;;
    legacy-down) dline ollama "stopped container '$FP_OLLAMA_STOPPED' — compose file $FP_OLLAMA_STOPPED_CFG" ;;
    ours-up)     dline ollama "'$FP_OLLAMA_RUN' answers on :11434 — stack $OLLAMA_DIR/compose.yaml" ;;
    foreign)     dline ollama "'$FP_OLLAMA_RUN' answers on :11434 — not created by this installer, reused as is" ;;
    native-up)   dline ollama "answers on :11434, in no container this script can see (native service)" ;;
    stopped)     dline ollama "stopped container '$FP_OLLAMA_STOPPED' — to be started, never duplicated" ;;
    native-down) dline ollama "installed natively on this host, service stopped" ;;
    port-busy)   dline ollama "does not answer, but :11434 is held by another process" ;;
    *)           dline ollama "absent (no container, no native service, :11434 free)" ;;
  esac
  [ "$FP_VOL_OLLAMA" = 1 ] && dcont "the 'ollama-data' volume exists, mounted by: ${FP_VOL_OLLAMA_USERS:-nobody} — copied from, never removed"
  [ -n "$FP_OLLAMA_CLIENTS" ] && dcont "Ollama is also used over HTTP by: $FP_OLLAMA_CLIENTS"

  case "$VERDICT_WEB" in
    up)     dline web "answers on :$WEB_PORT${FP_WEB_RUN:+ ($FP_WEB_RUN)}" ;;
    down)   dline web "container ${FP_WEB_RUN} present but :$WEB_PORT does not answer" ;;
    *)      dline web "absent (:$WEB_PORT free)" ;;
  esac
  if [ "$FP_UPD_HEALTH" = 1 ]; then dline updater "answers on :$WEB_PORT/update/status${FP_UPD_RUN:+ ($FP_UPD_RUN)}"
  elif [ -n "$FP_UPD_RUN" ];  then dline updater "container $FP_UPD_RUN present but /update/status does not answer"
  else                             dline updater "absent"; fi

  dline models "$FP_MODELS_OK/$FP_MODELS_TOTAL present in $FP_MODELS_DIR"
  [ -n "$FP_COMFY_BASEDIR" ] || dcont "(default path: no container yet to read the truth from)"
  [ "$VERDICT_MODELS" = misplaced ] \
    && dcont "$FP_LEGACY_DIR_N file(s) in $FP_LEGACY_DIR — a folder no ComfyUI reads"
  [ "$FP_LEGACY_DUP_N" -gt 0 ] \
    && dcont "$FP_LEGACY_DUP_N file(s) already present in $FP_MODELS_DIR; the copy in $FP_LEGACY_DIR is a duplicate you may delete yourself"
  [ "$VERDICT_MODELS" = unreadable ] \
    && dcont "$FP_MODELS_DIR is not writable — usual cause: created by Docker as root"
  if [ "$FP_GATED_BAD" -gt 0 ]; then
    dline gated "$FP_GATED_BAD gated file(s) missing (Lightricks/LTX-2.5) — a Hugging Face token will be asked for"
  else
    dline gated "$FP_GATED_TOTAL of the $FP_MODELS_TOTAL come from a gated repository (Lightricks/LTX-2.5) — all present"
  fi
  dline disk "about $((FP_MODELS_BYTES / 1000000000)) GB still needed, $FP_DISK_FREE_GB GB free on $FP_DISK_DIR"
}

diag_mounts() {
  local l first=1
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    if [ "$first" = 1 ]; then dfield mounts "$l"; first=0
    else printf '                               %s\n' "$l"; fi
  done <<< "$FP_COMFY_MOUNTS"
  [ "$first" = 1 ] && dfield mounts "(none)"
  return 0
}

# ── The plan (A.2) ────────────────────────────────────────────────────────────
step() { PLAN+=("$*"); }
kept() { KEPT+=("$*"); }

build_plan() {
  local why
  PLAN=(); KEPT=()
  PLAN_DO_TAKEOVER=0; PLAN_DO_WEB=0; PLAN_DO_ENV=0; PLAN_DO_UPDATER=0
  PLAN_DO_MIGRATE=0;  PLAN_DO_TOKEN=0; PLAN_DO_MODELS=0; PLAN_DO_SMOKE=0

  case "$VERDICT_COMFY" in
    legacy-up)
      step "docker rm -f $FP_COMFY_RUN               (inherited: this repository's compose file created it)"
      step "create $COMFY_DIR/{basedir/models,run,userscripts_dir} as you, deploy the userscripts, then docker compose up -d" ;;
    legacy-down)
      step "docker rm -f $FP_COMFY_STOPPED               (inherited and stopped: migrated, never restarted)"
      step "create $COMFY_DIR/{basedir/models,run,userscripts_dir} as you, deploy the userscripts, then docker compose up -d" ;;
    foreign-ok)
      step "reuse the third-party ComfyUI '$FP_COMFY_RUN' as it is — no file written, no container touched" ;;
    foreign-broken)
      why="$(takeover_blocker)"
      if [ -n "$why" ]; then
        step "leave the third-party ComfyUI '$FP_COMFY_RUN' untouched: $why. It cannot be fixed automatically — see docs/TROUBLESHOOTING.md, section 2 (ComfyUI does not see the models)"
      else
        PLAN_DO_TAKEOVER=1
        step "write $FP_COMFY_OVR — environment keys only: BASE_DIRECTORY=/basedir, WANTED_UID=$(id -u), WANTED_GID=$(id -g); the image, ports, volumes and networks of the third-party file are left untouched"
        step "docker compose -p $FP_COMFY_PROJECT -f ${FP_COMFY_CFGFILE%%,*} -f $FP_COMFY_OVR up -d, in $FP_COMFY_CFGDIR — acts on the THIRD-PARTY project '$FP_COMFY_PROJECT' and recreates '$FP_COMFY_RUN' in place, after an explicit confirmation. No byte of model data is moved or re-downloaded. Undo: rm $FP_COMFY_OVR && docker compose -p $FP_COMFY_PROJECT -f ${FP_COMFY_CFGFILE%%,*} up -d"
      fi ;;
    ours-up)      step "reuse the running ComfyUI '$FP_COMFY_RUN' — no container recreated" ;;
    unmanaged-up) step "reuse whatever answers on :8188 — no container created" ;;
    stopped)      step "docker start $FP_COMFY_STOPPED — the ComfyUI already installed here, never a second one" ;;
    ours-dir-only) step "create $COMFY_DIR/{basedir/models,run,userscripts_dir} as you, deploy the userscripts, then docker compose up -d in $COMFY_DIR (stack written by this installer)" ;;
    foreign-dir-only)
      step "docker compose up -d in $COMFY_DIR starts the THIRD-PARTY project '$(basename "$COMFY_DIR")' defined by a file this installer did not write" ;;
    port-busy)    step "leave :8188 alone: it is held by another process and ComfyUI does not answer — nothing created" ;;
    *)
      step "create $COMFY_DIR/{basedir/models,run,userscripts_dir} as you (never as root)"
      step "write $COMFY_DIR/.env with WANTED_UID=$(id -u) WANTED_GID=$(id -g)"
      step "copy the userscript(s) into $COMFY_DIR/userscripts_dir BEFORE the first start"
      step "copy docker/stacks/comfyui.yml to $COMFY_DIR/compose.yaml, then docker compose up -d" ;;
  esac
  # Not a blocker: services, web app, updater and the Ollama model do not depend on it, and the
  # model steps refuse a folder they cannot write to on their own. Only the user can fix it.
  [ "$COMFY_ROOT_OWNED" = 1 ] \
    && step "not done by this installer, which never runs sudo — fix it yourself: $COMFY_DIR/basedir belongs to '$FP_COMFY_OWNER', every model download into it fails until you run: sudo chown -R $(id -u):$(id -g) \"$COMFY_DIR\""

  case "$VERDICT_OLLAMA" in
    legacy-up|legacy-down)
      step "copy the weights of the 'ollama-data' volume into $OLLAMA_DIR/data (avoids a 9.6 GB download)"
      step "docker rm -f ${FP_OLLAMA_RUN:-$FP_OLLAMA_STOPPED}               (inherited: this repository's compose file created it)"
      step "create $OLLAMA_DIR/data, copy docker/stacks/ollama.yml, then docker compose up -d" ;;
    ours-up)     step "reuse the running Ollama '$FP_OLLAMA_RUN' — no container recreated" ;;
    foreign)     step "reuse the Ollama '$FP_OLLAMA_RUN' answering on :11434 — not created by this installer, left as it is" ;;
    native-up)   step "reuse the native Ollama service answering on :11434" ;;
    stopped)     step "docker start $FP_OLLAMA_STOPPED — the Ollama already installed here, never a second one" ;;
    native-down) step "start the native service: sudo -n systemctl start ollama.service (no container is created either way)" ;;
    port-busy)   step "leave :11434 alone: it is held by another process and Ollama does not answer — nothing created" ;;
    *)           step "create $OLLAMA_DIR/data, copy docker/stacks/ollama.yml, then docker compose up -d" ;;
  esac

  if [ "$VERDICT_WEB" = up ]; then
    step "reuse the web app answering on :$WEB_PORT"
  else
    PLAN_DO_WEB=1
    step "docker compose up -d ai-content-studio          (nginx :$WEB_PORT, from this repository)"
  fi
  PLAN_DO_ENV=1
  step "write $REPO_ROOT/.env with COMFY_LORAS_DIR=$FP_MODELS_DIR/loras and create $FP_MODELS_DIR/loras (the updater uploads LoRAs there)"
  # The updater is rebuilt on every acting run: that is how the service picks up the updater
  # changes this repository received since the last run. Announced as such, never as a reuse.
  PLAN_DO_UPDATER=1
  step "rebuild and restart the updater (picks up updater changes from this repository): docker compose up -d --build updater"

  if [ "$VERDICT_MODELS" = misplaced ]; then
    PLAN_DO_MIGRATE=1
    step "move $FP_LEGACY_DIR_N model file(s) from $FP_LEGACY_DIR to $FP_MODELS_DIR — file by file, mv -n, nothing overwritten, nothing re-downloaded"
  fi
  if [ "$SKIP_MODELS" = 1 ]; then
    step "--skip-models: no model is downloaded"
  elif [ "$FP_MODELS_BAD" -gt 0 ]; then
    if [ "$FP_GATED_BAD" -gt 0 ]; then
      PLAN_DO_TOKEN=1
      step "ask for a Hugging Face token ($FP_GATED_BAD gated file(s) missing)"
    fi
    PLAN_DO_MODELS=1
    step "download $FP_MODELS_BAD model file(s), about $((FP_MODELS_BYTES / 1000000000)) GB, into $FP_MODELS_DIR"
  fi
  [ "$FP_GEMMA" -gt 0 ] && step "$OLLAMA_MODEL is already present — nothing to pull" \
    || step "pull $OLLAMA_MODEL through the Ollama HTTP API"
  step "prove it: 3 endpoints through :$WEB_PORT, models on disk, models listed by ComfyUI, $OLLAMA_MODEL present"
  if [ "$SMOKE" = 1 ] && ! command -v python3 >/dev/null 2>&1; then
    step "--smoke: skipped — python3 is not installed, so the reduced real render cannot run"
  elif [ "$SMOKE" = 1 ]; then
    PLAN_DO_SMOKE=1
    step "--smoke: a reduced real render — python3 tools/validate.py workflows/api/krea2_t2i.json --reduce, direct to ComfyUI on :8188 (bypasses the nginx proxy verified above)"
  fi

  # The "kept" block is printed even when it is empty: what is NOT deleted is part of the plan.
  if ! acting; then
    kept "nothing on disk is removed by this mode."
  elif [ "$HEADLINE" = VIRGIN ]; then
    kept "nothing exists yet to keep."
  else
    [ "$FP_LEGACY_DIR_N" -gt 0 ] && kept "$REPO_ROOT/comfyui — emptied of the files moved, the folder stays"
    [ "$FP_LEGACY_DUP_N" -gt 0 ] && kept "the $FP_LEGACY_DUP_N duplicate file(s) in $FP_LEGACY_DIR — yours to delete"
    [ "$FP_VOL_OLLAMA" = 1 ] && kept "the 'ollama-data' volume — copied from, never removed"
    kept "the git repository, Docker, the NVIDIA driver"
  fi
}

print_plan() {
  section "Plan (mode: $PLAN_MODE)"
  local i=0 l
  for l in "${PLAN[@]}"; do i=$((i + 1)); printf '  %2d. %s\n' "$i" "$l"; done
  printf '\n'
  i=0
  for l in "${KEPT[@]}"; do
    i=$((i + 1))
    if [ "$i" = 1 ]; then printf '  kept, never deleted: %s\n' "$l"
    else printf '                       %s\n' "$l"; fi
  done
  case "$VERDICT_COMFY:$VERDICT_OLLAMA" in
    legacy-*:legacy-*) printf "  no container outside '%s' and '%s' is touched.\n" "${FP_COMFY_RUN:-$FP_COMFY_STOPPED}" "${FP_OLLAMA_RUN:-$FP_OLLAMA_STOPPED}" ;;
    *)                 printf '  no container outside the ones named above is touched.\n' ;;
  esac
}

# ── The one decision tree (lessons 1, 2, 3, 7) ────────────────────────────────
# Consumes the fingerprint: nothing here re-probes what fingerprint already read.
ensure_service() {   # name
  local name="$1" spec port path image dir tmpl unit tries delay verdict c sc rc
  spec="$(service_spec "$name")" || { err "unknown service $name"; return 1; }
  IFS='|' read -r port path image dir tmpl unit tries delay <<< "$spec"

  info "--- $name (:$port) ---"

  if [ "$name" = comfyui ]; then verdict="$VERDICT_COMFY"; c="$FP_COMFY_RUN"; sc="$FP_COMFY_STOPPED"
  else                           verdict="$VERDICT_OLLAMA"; c="$FP_OLLAMA_RUN"; sc="$FP_OLLAMA_STOPPED"
  fi

  case "$verdict" in
    # Inherited from the old layout. The compose label was tested before the "stopped
    # container" case, so a stopped inherited container lands here and is migrated.
    legacy-up|legacy-down)
      [ "$verdict" = legacy-down ] && c="$sc"
      warn "$name runs in a container inherited from the old layout ($c) — replacing it with the $dir stack"
      if acting; then
        "premigrate_$name"
        docker rm -f "$c" >/dev/null 2>&1 || true
      else
        would "remove container $c and recreate the stack in $dir"
      fi
      create_stack "$name" && report "$name" "migrated to $dir" || report "$name" "migration FAILED"
      ;;

    # It answers in a container we can see: reuse it, whatever wrote it.
    ours-up|foreign|foreign-ok|foreign-broken)
      ok "$name already running in '$c' — reused, not recreated"
      report "$name" "reused ($c)"
      ;;

    # It answers, but in nothing we can identify: a native service, or an unmanaged process.
    unmanaged-up|native-up)
      ok "$name answers and is not a container we can see (native service, or unmanaged) — reused as is"
      report "$name" "reused (native or unidentified)"
      ;;

    # It does not answer. Absent is the LAST hypothesis, never the first.
    stopped)
      info "  $name found in a stopped container ('$sc') — starting it rather than creating a second one"
      if acting; then
        docker start "$sc" >/dev/null 2>&1 || warn "could not start '$sc'"
        if wait_health "$port" "$path" "$tries" "$delay"; then
          ok "$name answers"; report "$name" "restarted ($sc)"
        else
          warn "'$sc' was started but $name still does not answer — see 'docker logs $sc'"
          report "$name" "restarted but silent ($sc)"; PROBLEMS=$((PROBLEMS + 1))
        fi
      else
        would "docker start $sc"; report "$name" "would restart ($sc)"
      fi
      ;;

    native-down)
      info "  $name is installed natively on this host but does not answer — trying to start the service"
      if acting; then
        # 'sudo -n' never prompts: either passwordless sudo is allowed, or it fails at once.
        # An installer must not hang on a password prompt nobody will type.
        if [ "$(id -u)" = 0 ]; then systemctl start "$unit" >/dev/null 2>&1
        else sudo -n systemctl start "$unit" >/dev/null 2>&1; fi
        if wait_health "$port" "$path" "$tries" "$delay"; then
          ok "native $name service started"; report "$name" "started (native service)"
        else
          warn "could not start the native $name service (no passwordless sudo?)"
          info "    run it yourself, then run this script again:  sudo systemctl enable --now $unit"
          info "    no container was created, so two $name instances never fight over port $port"
          report "$name" "SKIPPED (native install stopped)"; PROBLEMS=$((PROBLEMS + 1))
        fi
      else
        would "sudo -n systemctl start $unit"; report "$name" "would start (native)"
      fi
      ;;

    port-busy)
      warn "port $port is held by another process but $name does not answer its health check"
      info "    free the port or start that service, then run this script again — nothing was created"
      report "$name" "SKIPPED (port $port busy)"; PROBLEMS=$((PROBLEMS + 1))
      ;;

    # Genuinely absent, or a stack directory with no container behind it.
    *)
      create_stack "$name"; rc=$?
      case "$rc" in
        0) report "$name" "created ($dir)" ;;
        2) : ;;   # refused by the user: create_stack already reported it
        *) report "$name" "creation FAILED" ;;
      esac
      ;;
  esac
}

create_stack() {   # name
  local name="$1" port path dir tmpl tries delay proj
  port="$(spec_field "$name" 1)"; path="$(spec_field "$name" 2)"
  dir="$(spec_field "$name" 4)";  tmpl="$(spec_field "$name" 5)"
  tries="$(spec_field "$name" 7)"; delay="$(spec_field "$name" 8)"
  info "  creating the $name stack in $dir"
  if ! acting; then
    would "mkdir the bind-mount sources, copy $tmpl to $dir/compose.yaml, then 'docker compose up -d'"
    return 0
  fi
  # Guard: a compose project is named after its directory, so `docker compose up -d` here
  # would act on a THIRD-PARTY project when the compose.yaml is not ours. Never silently.
  if [ "$name" = comfyui ] && [ "$FP_COMFY_YAML" = 1 ] && [ "$FP_COMFY_YAML_OURS" = 0 ]; then
    proj="$(basename "$dir")"
    if interactive; then
      confirm "Start the third-party project '$proj' from a compose file this installer did not write? [y/N] "
    else
      info "Start the third-party project '$proj' from a compose file this installer did not write? [y/N] "
      info "No TTY: refused. A third-party compose project is never started without an explicit yes."
      false
    fi || {
      warn "ComfyUI left exactly as it is: $dir/compose.yaml was not written by this installer."
      report "$name" "SKIPPED (third-party compose file)"; PROBLEMS=$((PROBLEMS + 1)); return 2
    }
    # Accepted: started exactly as announced, and nothing more — no .env, no userscript, no
    # folder written into a directory that belongs to somebody else's project.
  else
    "prepare_$name"
    # The third-party file is never overwritten, in any mode.
    [ -f "$dir/compose.yaml" ] || cp "$REPO_ROOT/$tmpl" "$dir/compose.yaml"
  fi
  ( cd "$dir" && $COMPOSE up -d ) || { err "'docker compose up -d' failed in $dir"; PROBLEMS=$((PROBLEMS + 1)); return 1; }
  info "  waiting for $name on :$port (first start can be long: image, userscripts, model load)"
  if wait_health "$port" "$path" "$tries" "$delay"; then
    ok "$name answers"
  else
    warn "$name still does not answer — see 'docker logs' for its container"
    PROBLEMS=$((PROBLEMS + 1))
  fi
}

# ── Model directory: the container's mounts are the truth (lesson 4) ──────────
resolve_models_dir() {   # [container]
  local c="${1:-}" src
  MODELS_DIR="$COMFY_DIR/basedir/models"
  [ -n "$c" ] || c="$(container_on_port 8188 || true)"
  [ -n "$c" ] || return 0
  src="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/basedir"}}{{.Source}}{{end}}{{end}}' "$c" 2>/dev/null)"
  if [ -n "$src" ]; then
    MODELS_DIR="$src/models"
    info "models directory read from the running container: $MODELS_DIR"
  else
    warn "the ComfyUI container exposes no /basedir mount — using the default $MODELS_DIR"
  fi
}

# ── Models: before -> after (A.6.2) ───────────────────────────────────────────
# migrate_legacy_models and download_models drop the entries they touched into these four flat
# "|dir/file|dir/file|" strings; the report reads models.txt back in file order and classifies
# each entry from them. Four strings and a case beat a data structure for four categories.
DELTA_MOVED="|"; DELTA_DOWNLOADED="|"; DELTA_FAILED="|"; DELTA_MANUAL="|"

delta_size() { awk -v b="${1:-0}" 'BEGIN{ if (b + 0 >= 1000000000) printf "%.1f GB", b / 1000000000; else printf "%.1f MB", b / 1000000 }'; }

report_models_delta() {
  local d f s u key cat why n=0 kept=0 moved=0 got=0 failed=0 manual=0
  section "Models: before -> after"
  [ -f "$MODELS_FILE" ] || { info "  $MODELS_FILE not found — nothing to report"; return 0; }
  while IFS='|' read -r d f s u; do
    case "${d:-}" in ''|\#*) continue ;; esac
    u="${u%$'\r'}"; key="$d/$f"; n=$((n + 1))
    if [[ "$DELTA_MANUAL" == *"|$key|"* ]]; then
      cat=MANUAL; why="(no URL in models.txt)"; manual=$((manual + 1))
    elif [[ "$DELTA_DOWNLOADED" == *"|$key|"* ]]; then
      cat=DOWNLOADED; why=""; got=$((got + 1))
    elif [[ "$DELTA_FAILED" == *"|$key|"* ]]; then
      cat=FAILED; why="(download failed)"; failed=$((failed + 1))
      case "$u" in *"$GATED_REPO"*) [ -n "$HF_TOK" ] || why="(gated: no Hugging Face token)" ;; esac
    elif [[ "$DELTA_MOVED" == *"|$key|"* ]]; then
      cat=MOVED; why="(from the legacy repository folder)"; moved=$((moved + 1))
    elif [ "$(model_status "$d" "$f" "$s")" = OK ]; then
      cat=KEPT; why="(already in place)"; kept=$((kept + 1))
    else
      cat=FAILED; failed=$((failed + 1))
      acting && why="(missing)" || why="(missing — this mode downloads nothing)"
    fi
    printf '  %-10s %-80s %10s  %s\n' "$cat" "$key" "$(delta_size "$s")" "$why"
  done < "$MODELS_FILE"
  printf '  ---\n'
  printf '  %s entries: %s kept, %s moved, %s downloaded, %s failed, %s manual\n' \
    "$n" "$kept" "$moved" "$got" "$failed" "$manual"
  printf '  location: %s\n' "$MODELS_DIR"
}

# Models downloaded by the old layout sit inside the repo, where ComfyUI does not read them.
migrate_legacy_models() {
  local legacy="$REPO_ROOT/comfyui/basedir/models" f rel moved=0 failed=0 dup=0
  local files=()
  [ -d "$legacy" ] && [ "$legacy" != "$MODELS_DIR" ] || return 0
  while IFS= read -r -d '' f; do files+=("$f"); done < <(find "$legacy" -type f -print0 2>/dev/null)
  [ "${#files[@]}" -gt 0 ] || return 0
  info "${#files[@]} file(s) found in the legacy model folder ($legacy)"
  if ! acting; then would "move them to $MODELS_DIR (same filesystem, instant)"; return 0; fi
  for f in "${files[@]}"; do
    rel="${f#"$legacy"/}"
    # Already at its destination: a duplicate. Never moved over it, never deleted — the user's call.
    [ -e "$MODELS_DIR/$rel" ] && { dup=$((dup + 1)); continue; }
    mkdir -p "$MODELS_DIR/$(dirname "$rel")" 2>/dev/null
    if mv -n "$f" "$MODELS_DIR/$rel" 2>/dev/null; then
      moved=$((moved + 1)); DELTA_MOVED="$DELTA_MOVED$rel|"
    else failed=$((failed + 1)); fi
  done
  info "  moved: $moved   left behind: $failed"
  [ "$dup" -eq 0 ] || info "  $dup file(s) already present in $MODELS_DIR; the copy in $legacy is a duplicate you may delete yourself"
  [ "$failed" -eq 0 ] || {
    warn "$failed file(s) could not be moved — the legacy folder is probably owned by root"
    info "    sudo chown -R $(id -u):$(id -g) \"$REPO_ROOT/comfyui\"   then run this script again"
  }
}

# Size check with the SAME 1% tolerance as the downloader. Strict equality is wrong: some
# files legitimately differ by a few kB from models.txt (republished Hugging Face revisions).
# A file truncated by less than 1% therefore still passes — only an inspected render proves
# a model is sound (docs/TESTING.md).
model_status() {   # dir file size -> OK | INCOMPLETE | MISSING
  local path="$MODELS_DIR/$1/$2" want="$3" have tol
  is_uint "$want" || { printf 'OK\n'; return; }
  have="$(stat -c%s "$path" 2>/dev/null || echo 0)"
  [ "$have" -eq 0 ] && { printf 'MISSING\n'; return; }
  tol=$((want / 100)); [ "$tol" -lt 1 ] && tol=1
  if [ "$have" -ge $((want - tol)) ] && [ "$have" -le $((want + tol)) ]; then printf 'OK\n'; else printf 'INCOMPLETE\n'; fi
}

scan_models() {   # sets MODELS_OK / MODELS_BAD / MODELS_BYTES_NEEDED
  MODELS_OK=0; MODELS_BAD=0; MODELS_BYTES_NEEDED=0
  [ -f "$MODELS_FILE" ] || return 0
  local d f s u st
  while IFS='|' read -r d f s u; do
    case "${d:-}" in ''|\#*) continue ;; esac
    st="$(model_status "$d" "$f" "$s")"
    if [ "$st" = OK ]; then MODELS_OK=$((MODELS_OK + 1))
    else MODELS_BAD=$((MODELS_BAD + 1)); is_uint "$s" && MODELS_BYTES_NEEDED=$((MODELS_BYTES_NEEDED + s)); fi
  done < "$MODELS_FILE"
}

download_models() {
  # Only a token huggingface.co accepted: an invalid bearer token makes it answer 401 even on
  # public files, so a rejected (or never checked) one is not sent at all.
  local d f s u st target rc=0 done_=0 fail=0 tok="$HF_TOK"
  [ -f "$MODELS_FILE" ] || { warn "$MODELS_FILE not found — no model to download"; return 0; }
  while IFS='|' read -r d f s u; do
    case "${d:-}" in ''|\#*) continue ;; esac
    u="${u%$'\r'}"
    target="$MODELS_DIR/$d/$f"
    [ -z "$u" ] || [ "$u" = NON_TROUVE ] && { info "MANUAL (no URL in models.txt): $target"; DELTA_MANUAL="$DELTA_MANUAL$d/$f|"; continue; }
    st="$(model_status "$d" "$f" "$s")"
    [ "$st" = OK ] && continue
    info "downloading ($st): $d/$f"
    if ! acting; then would "curl -C - -o $target"; continue; fi
    mkdir -p "$MODELS_DIR/$d"
    # Gated Hugging Face repositories (LTX 2.5) answer 401 without a token: those fail
    # cleanly and are reported, they never abort the rest. The header travels to curl on
    # stdin (-K -), never on argv — an argv secret sits in `ps aux` for as long as the
    # request takes.
    if { [ -n "$tok" ] && [[ "$u" == *huggingface.co* ]] && printf 'header = "Authorization: Bearer %s"\n' "$tok"; } \
         | curl -sfL -C - -K - -o "$target" "$u"; then
      done_=$((done_ + 1)); DELTA_DOWNLOADED="$DELTA_DOWNLOADED$d/$f|"
    else
      fail=$((fail + 1)); DELTA_FAILED="$DELTA_FAILED$d/$f|"; warn "download failed: $f"; rc=1
    fi
  done < "$MODELS_FILE"
  info "downloaded: $done_   failed: $fail"
  return $rc
}

ensure_ollama_model() {
  if ! health 11434 /api/version; then
    warn "Ollama does not answer — cannot check or pull $OLLAMA_MODEL"
    report "$OLLAMA_MODEL" "UNAVAILABLE (no Ollama)"; PROBLEMS=$((PROBLEMS + 1)); return
  fi
  if curl -sf -m 10 http://localhost:11434/api/tags | grep -q "\"$OLLAMA_MODEL\""; then
    ok "$OLLAMA_MODEL already present"; report "$OLLAMA_MODEL" "present"; return
  fi
  if ! acting; then would "pull $OLLAMA_MODEL through the Ollama API"; report "$OLLAMA_MODEL" "would pull"; return; fi
  info "pulling $OLLAMA_MODEL through the HTTP API (works for a container as well as a native install)"
  curl -s -X POST http://localhost:11434/api/pull -d "{\"model\":\"$OLLAMA_MODEL\"}" -o /dev/null
  # /api/pull answers 200 even when the pull fails mid-stream: verify against /api/tags.
  if curl -sf -m 10 http://localhost:11434/api/tags | grep -q "\"$OLLAMA_MODEL\""; then
    ok "$OLLAMA_MODEL downloaded"; report "$OLLAMA_MODEL" "downloaded"
  else
    warn "$OLLAMA_MODEL pull failed"; report "$OLLAMA_MODEL" "FAILED"; PROBLEMS=$((PROBLEMS + 1))
  fi
}

# ── Hugging Face token (A.4.1) ─────────────────────────────────────────────────
# Order: $HF_TOKEN, then two on-disk locations, then a masked prompt (empty = skip).
# ~/comfyui-spark/compose.yaml is NEVER read for this: a third-party stack's secret,
# if any, is not ours to reuse. The header travels to curl on stdin (-K -), never on
# argv, so it never sits in `ps aux` for the seconds the request takes.
hf_token_check() {   # token -> prints the whoami-v2 JSON body (caller only extracts "name" from
                      # it, never displays or logs it whole: it can carry account metadata),
                      # exit 0 valid / 1 invalid or unreachable
  printf 'header = "Authorization: Bearer %s"\n' "$1" | curl -sf -m 10 -K - https://huggingface.co/api/whoami-v2 2>/dev/null
}

hf_token_acquire() {
  local token="$HF_TOK_ENV" src=env whoami name d="$HOME/.config/ai-content-studio"
  # First NON-EMPTY candidate wins: an empty or unreadable (root-owned) cache file must not hide
  # the token saved in our own config file.
  [ -n "$token" ] || { token="$(head -n1 "$HOME/.cache/huggingface/token" 2>/dev/null | tr -d '[:space:]')"; src=cache; }
  [ -n "$token" ] || { token="$(head -n1 "$d/hf_token" 2>/dev/null | tr -d '[:space:]')"; src=config; }

  if [ -z "$token" ] && interactive; then
    printf 'Hugging Face token (input hidden, Enter to skip): '
    read -rs token; printf '\n'
    src=prompt
  elif [ -z "$token" ]; then
    info "No TTY: the Hugging Face token prompt is skipped — set HF_TOKEN, or save a token to $HOME/.config/ai-content-studio/hf_token (mode 600)."
  fi
  [ -n "$token" ] || { warn "Continuing without a token: the $FP_GATED_BAD gated file(s) will fail cleanly and be reported."; return 0; }

  if whoami="$(hf_token_check "$token")" && [ -n "$whoami" ]; then
    # Extraction by sed/grep, never jq (no new dependency): the username is not a secret,
    # the rest of the JSON (account metadata) is never printed or logged.
    name="$(printf '%s' "$whoami" | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')"
    ok "Hugging Face token valid (user: ${name:-unknown})"
  else
    warn "Hugging Face token rejected by huggingface.co — continuing without it."
    return 0
  fi
  HF_TOK="$token"   # never exported: see the top of this file

  # Opt-in save, mode 600 in a 700 directory — set explicitly, never left to the umask: an existing
  # file keeps its old mode through `>`. Skipped when it is already sitting in our own config file.
  [ "$src" = config ] && return 0
  if confirm "Save this token to $d/hf_token (mode 600)? [y/N] "; then
    if ( umask 077; mkdir -p "$d" && printf '%s\n' "$token" > "$d/hf_token" && chmod 600 "$d/hf_token" ); then
      ok "token saved to $d/hf_token (mode 600)"
    else
      warn "could not save the token to $d/hf_token"
    fi
  fi
  return 0
}

# ── Taking over a third-party ComfyUI (A.5) ───────────────────────────────────
# Not a rewrite: an override written NEXT TO the container's own compose file (wherever that is:
# its compose label says so) and passed to compose with -f, under that project's name. Compose
# also auto-loads it there later. `environment` merges, so the missing keys are added while the
# image, ports, volumes and the external network of the third-party file survive untouched —
# no model byte moves, nothing is re-downloaded, and undoing it is one rm plus one `up -d`.
TAKEOVER_MARK="# written by install2.sh — remove this file to restore the original definition"

takeover_fields() {   # before | after
  info "  --- ComfyUI, $1 the takeover ---"
  dfield container "$FP_COMFY_RUN"
  dfield image "${FP_COMFY_IMAGE:-(unknown)}"
  dfield "compose project" "${FP_COMFY_PROJECT:-(none)}"
  dfield "compose file" "${FP_COMFY_CFGFILE:-(none)}"
  dfield networks "${FP_COMFY_NETS:-(none)}"
  diag_mounts
  dfield BASE_DIRECTORY "${FP_COMFY_ENV_BASE:-(unset)}"
  dfield "WANTED_UID/GID" "${FP_COMFY_ENV_UID:-(unset)}/${FP_COMFY_ENV_GID:-(unset)}"
  dfield lists "$FP_COMFY_LISTED of the $FP_COMFY_DISK_N diffusion model(s) present on disk"
}

# Why a broken third-party ComfyUI cannot be taken over — nothing when it can. Decided from the
# fingerprint alone, by build_plan: a takeover is either announced and run, or never offered.
takeover_blocker() {
  if [ -z "$FP_COMFY_CFGFILE" ] || [ -z "$FP_COMFY_PROJECT" ] || [ -z "$FP_COMFY_SERVICE" ]; then
    printf 'it was not created by docker compose (no compose labels)\n'
  # Only its own file (plus our override, after an earlier ineffective takeover) is replayed:
  # with more, `-f <file> -f <override>` would drop the others and change the container.
  elif [[ "${FP_COMFY_CFGFILE%",$FP_COMFY_OVR"}" == *,* ]]; then
    printf 'it was created from several compose files (%s)\n' "$FP_COMFY_CFGFILE"
  # BASE_DIRECTORY must name the DESTINATION of the mount holding the models. That mount is
  # what the fingerprint read the models directory from, so it is /basedir or there is none.
  elif [ -z "$FP_COMFY_BASEDIR" ]; then
    printf 'it mounts nothing on /basedir, so an environment override cannot point it at the models\n'
  elif [ -f "$FP_COMFY_OVR" ] && ! head -n1 "$FP_COMFY_OVR" | grep -qF 'written by install2.sh'; then
    printf '%s already exists and was not written by this installer\n' "$FP_COMFY_OVR"
  fi
}

takeover_comfyui() {
  local ovr="$FP_COMFY_OVR" cfg="${FP_COMFY_CFGFILE%%,*}" dir="$FP_COMFY_CFGDIR" proj="$FP_COMFY_PROJECT" undo
  undo="rm $ovr && docker compose -p $proj -f $cfg up -d"
  section "Third-party ComfyUI takeover"

  # Eligibility (A.5.2 step 1). The three conditions of A.1.4 are checked again here, against
  # the names really on disk: this step exists only while they hold. What else could rule it
  # out (no compose labels, no /basedir mount, a foreign override) kept build_plan from offering it.
  if ! comfy_broken; then
    info "  this ComfyUI offers the diffusion models present on disk — nothing to take over."
    return 0
  fi

  # The summary above is ALL that is shown of the third-party definition: fingerprinted values,
  # never `docker inspect` nor its environment. That env can hold any secret (on the reference
  # machine, a Hugging Face token in clear) and a redaction filter only knows the names it lists.
  takeover_fields before

  info "  compose project: $proj, from $cfg. 'docker compose -p $proj -f $cfg -f $ovr up -d', in $dir, therefore acts on THAT project's containers. That is exactly what this step does, on purpose, and it is why it never runs without the confirmation below."

  # Confirmation 3 (A.3.2). Without a terminal, only an explicit --yes authorises it.
  if [ "$ASSUME_YES" = 1 ]; then
    info "Take over this ComfyUI (project '$proj', in $dir)? Its $FP_MODELS_OK models stay exactly where they are. [y/N] "
    info "--yes on the command line: taking over."
  elif interactive; then
    confirm "Take over this ComfyUI (project '$proj', in $dir)? Its $FP_MODELS_OK models stay exactly where they are. [y/N] " || {
      warn "ComfyUI left exactly as it is. The application will not see the models it has on disk."
      PROBLEMS=$((PROBLEMS + 1)); return 0
    }
  else
    warn "third-party ComfyUI takeover needs a terminal, or --yes on the command line. Left untouched."
    PROBLEMS=$((PROBLEMS + 1)); return 0
  fi

  # The environment block and nothing else, marker on the first line.
  {
    printf '%s\n' "$TAKEOVER_MARK"
    printf 'services:\n  %s:\n    environment:\n' "$FP_COMFY_SERVICE"
    printf '      BASE_DIRECTORY: /basedir\n'
    printf '      WANTED_UID: "%s"\n      WANTED_GID: "%s"\n' "$(id -u)" "$(id -g)"
  } > "$ovr" || { err "could not write $ovr"; PROBLEMS=$((PROBLEMS + 1)); return 0; }
  ok "written: $ovr (environment keys only — image, ports, volumes and networks untouched)"

  ( cd "$dir" && $COMPOSE -p "$proj" -f "$cfg" -f "$ovr" up -d ) || {
    err "'docker compose up -d' failed in $dir"
    info "  undo, at any time: $undo"
    PROBLEMS=$((PROBLEMS + 1)); return 0
  }
  wait_health 8188 /system_stats 90 10 || warn "ComfyUI does not answer after the takeover — see 'docker logs $FP_COMFY_RUN'"

  # Same collector, read again: the container was recreated, every field above changed.
  fingerprint
  takeover_fields after
  if [ "$FP_COMFY_LISTED" -gt 0 ]; then
    # unquoted on purpose: the names are split on spaces to keep the first three
    ok "ComfyUI now offers: $(printf '%s\n' $FP_COMFY_LISTED_NAMES | head -3 | tr '\n' ' ')"
    report comfyui "taken over ($FP_COMFY_RUN, $ovr)"
  else
    warn "ComfyUI still lists none of the $FP_COMFY_DISK_N diffusion model(s) present on disk"
    report comfyui "takeover ineffective ($FP_COMFY_RUN)"
    PROBLEMS=$((PROBLEMS + 1))
  fi
  info "  undo, at any time: $undo"
}

# ── Uninstall (A.6) ────────────────────────────────────────────────────────────
# Ownership is decided by compose label, never by name or image: a container is "ours"
# only when its compose project config_files is one of OUR OWN compose files (current or
# the old repo-root layout). Everything else is listed and left exactly as it is. This
# function only ever runs `docker rm -f` on a container the user explicitly confirmed —
# no volume, no image, no bind-mount directory, no `sudo`, is ever touched.

# Disk usage helpers for the "Kept" summary (A.6.1 step 6). An unbounded `du` on a
# several-hundred-GB models directory can take minutes on a cold disk, so it is never used for
# that: the "models" total is the SUM of models.txt sizes for entries actually present (instant
# — model_status is already an in-memory stat). Every other directory goes through `timeout 20 du -sh`, falling
# back to "(not measured)" rather than hanging the uninstall.
sized_dir() {   # dir -> "<size>" or "(not measured)"
  local out; out="$(timeout 20 du -sh "$1" 2>/dev/null | cut -f1)"
  printf '%s\n' "${out:-(not measured)}"
}
# Never a throwaway container to measure a volume: it would create a container (and may pull an
# image) even in --dry-run. The daemon already knows the size: its line in the Local Volumes
# section of `docker system df -v` reads "<name>  <links>  <size>".
sized_volume() {   # docker volume name -> "<size>" or "(size unknown)"
  local out
  out="$(timeout 20 docker system df -v 2>/dev/null \
    | awk -v v="$1" '/^Local Volumes space usage/{f=1; next} /^Build cache/{f=0} f && $1 == v {print $3; exit}')"
  printf '%s\n' "${out:-(size unknown)}"
}
kept_models_size() {
  local d f s u bytes=0
  if [ -f "$MODELS_FILE" ]; then
    while IFS='|' read -r d f s u; do
      case "${d:-}" in ''|\#*) continue ;; esac
      [ "$(model_status "$d" "$f" "$s")" = OK ] && is_uint "$s" && bytes=$((bytes + s))
    done < "$MODELS_FILE"
  fi
  delta_size "$bytes"
}
# Other apps relying on Ollama, minus the Ollama container itself (that one is reported
# separately, as owned or foreign).
ollama_other_users() {
  local u out=""
  for u in $FP_VOL_OLLAMA_USERS $FP_OLLAMA_CLIENTS; do
    case "$u" in "$FP_OLLAMA_RUN"|"$FP_OLLAMA_STOPPED"|"") continue ;; esac
    out="$out$u "
  done
  printf '%s\n' "${out% }"
}

# The DATA that survives, never the containers: a container not removed (declined, foreign,
# or --dry-run) is reported separately, under "containers left in place" — conflating the two
# is exactly what made a previous run of this uninstaller print web/updater as "kept" in the
# same breath the plan said it would remove them.
print_kept_summary() {
  section "Kept — nothing below was deleted"
  local basedir="${FP_MODELS_DIR%/models}" other stacks=""

  [ -d "$FP_MODELS_DIR" ]       && printf '  models      %s  %s  (the files of scripts/models.txt; the folder may hold more)\n' "$(kept_models_size)" "$FP_MODELS_DIR"
  [ -d "$basedir/output" ]      && printf '  output      %s  %s\n' "$(sized_dir "$basedir/output")" "$basedir/output"
  [ -d "$basedir/input" ]       && printf '  input       %s  %s\n' "$(sized_dir "$basedir/input")" "$basedir/input"
  [ -d "$REPO_ROOT/workflows" ] && printf '  workflows   %s  %s\n' "$(sized_dir "$REPO_ROOT/workflows")" "$REPO_ROOT/workflows"

  if [ -d "$OLLAMA_DIR/data" ]; then
    printf '  ollama      %s  %s\n' "$(sized_dir "$OLLAMA_DIR/data")" "$OLLAMA_DIR/data"
  elif [ "$FP_VOL_OLLAMA" = 1 ]; then
    other="$(ollama_other_users)"
    if [ -n "$other" ]; then
      printf "  ollama      %s  volume 'ollama-data'  (Ollama also serves: %s)\n" "$(sized_volume ollama-data)" "$other"
    else
      printf "  ollama      %s  volume 'ollama-data'\n" "$(sized_volume ollama-data)"
    fi
  fi

  [ -f "$COMFY_DIR/compose.yaml" ]  && stacks="$stacks$COMFY_DIR/compose.yaml, "
  [ -f "$OLLAMA_DIR/compose.yaml" ] && stacks="$stacks$OLLAMA_DIR/compose.yaml, "
  [ -n "$stacks" ] && printf '  stack files          %s\n' "${stacks%, }"

  printf '  repository            %s  (git clone untouched)\n' "$REPO_ROOT"
  info "  Docker, the NVIDIA driver and nvidia-container-toolkit are untouched."
}

uninstall_run() {
  section "Uninstall"

  # Real removal needs a way to ask; --dry-run never does (acting() is false for it), so
  # only a real, acting run is gated here. Confirmations 5..n (A.3.2) are the per-component
  # questions below; without a terminal, --yes alone is not enough — --components must also
  # name what "yes" applies to, or an unattended run could wipe everything unattended.
  if acting && ! interactive && ! { [ "$ASSUME_YES" = 1 ] && [ -n "$COMPONENTS" ]; }; then
    err "uninstall needs a terminal, or --yes together with --components (web,updater,comfyui,ollama)."
    exit 1
  fi

  local want="web,updater,comfyui,ollama"
  [ -n "$COMPONENTS" ] && want="$COMPONENTS"

  local -a ours=() foreign=() left_in_place=()
  local name container dir label

  for name in web updater comfyui ollama; do
    case ",$want," in *",$name,"*) ;; *) continue ;; esac
    case "$name" in
      comfyui) container="${FP_COMFY_RUN:-$FP_COMFY_STOPPED}"; dir="$COMFY_DIR" ;;
      ollama)  container="${FP_OLLAMA_RUN:-$FP_OLLAMA_STOPPED}"; dir="$OLLAMA_DIR" ;;
      web)     container="$FP_WEB_RUN"; dir="" ;;
      updater) container="$FP_UPD_RUN"; dir="" ;;
    esac
    [ -n "$container" ] || continue   # absent: nothing to classify, nothing to keep either

    case "$name" in
      # Ours only when created by this repo's own compose file: whatever publishes :$WEB_PORT may
      # be another app (the updater was already looked up by its labels, see fingerprint).
      web|updater)
        if [ "$(compose_label_of "$container" com.docker.compose.project.config_files)" = "$REPO_ROOT/docker-compose.yml" ]; then
          ours+=("$name|$container|$dir")
        else
          foreign+=("$name|$container|$dir")
        fi ;;
      # Reuse VERDICT_COMFY/VERDICT_OLLAMA, not a fresh path comparison: a third-party
      # ComfyUI can sit at exactly $COMFY_DIR/compose.yaml (this is not hypothetical — it is
      # the real layout on the machine this was written on), and FP_COMFY_YAML_OURS is the
      # only signal that tells the two apart by content, the same one the verdict already used.
      comfyui)
        case "$VERDICT_COMFY" in
          legacy-up|legacy-down|ours-up|ours-dir-only) ours+=("$name|$container|$dir") ;;
          foreign-ok|foreign-broken|foreign-dir-only)  foreign+=("$name|$container|$dir") ;;
          *)
            case "$(compose_label_of "$container" com.docker.compose.project.config_files)" in
              "$REPO_ROOT/docker-compose.yml") ours+=("$name|$container|$dir") ;;
              "$COMFY_DIR/compose.yaml")
                [ "$FP_COMFY_YAML_OURS" = 1 ] && ours+=("$name|$container|$dir") || foreign+=("$name|$container|$dir") ;;
              *) foreign+=("$name|$container|$dir") ;;
            esac ;;
        esac ;;
      ollama)
        case "$VERDICT_OLLAMA" in
          legacy-up|legacy-down|ours-up) ours+=("$name|$container|$dir") ;;
          foreign)                       foreign+=("$name|$container|$dir") ;;
          *)
            case "$(compose_label_of "$container" com.docker.compose.project.config_files)" in
              "$OLLAMA_DIR/compose.yaml"|"$REPO_ROOT/docker-compose.yml") ours+=("$name|$container|$dir") ;;
              *) foreign+=("$name|$container|$dir") ;;
            esac ;;
        esac ;;
    esac
  done

  # Other applications on this machine that depend on Ollama (e.g. a chat frontend talking to
  # it over HTTP) are relevant context for the questions below even though nothing here would
  # ever remove them — they are never "ours" and never asked about.
  local extra already n c d
  case ",$want," in
    *,ollama,*)
      for extra in $FP_VOL_OLLAMA_USERS $FP_OLLAMA_CLIENTS; do
        [ -n "$extra" ] || continue
        already=0
        for label in "${ours[@]}" "${foreign[@]}"; do
          IFS='|' read -r n c d <<< "$label"
          [ "$c" = "$extra" ] && { already=1; break; }
        done
        [ "$already" = 1 ] || foreign+=("$extra|$extra|")
      done ;;
  esac

  local img cfg other
  info "OURS — created by this installer, offered for removal:"
  if [ "${#ours[@]}" -eq 0 ]; then info "  (none)"; else
    for label in "${ours[@]}"; do IFS='|' read -r n c d <<< "$label"; info "  $n: $c"; done
  fi

  info "NOT ours — will not be touched:"
  if [ "${#foreign[@]}" -eq 0 ]; then info "  (none)"; else
    for label in "${foreign[@]}"; do
      IFS='|' read -r n c d <<< "$label"
      img="$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null)"
      cfg="$(compose_label_of "$c" com.docker.compose.project.config_files)"
      info "  $c   ${img:-(image unknown)}   ${cfg:-(no compose label)}"
    done
  fi

  # One question per owned, in-scope component (confirmations 5..n, A.3.2). ComfyUI and Ollama
  # are never ours alone: other things on this machine may depend on them, so the risk is
  # spelled out once, here, before any of the removal questions.
  info "  ComfyUI and Ollama can serve other applications on this machine."
  other="$(ollama_other_users)"
  [ -n "$other" ] && info "  Ollama is also used by: $other — removing the Ollama container cuts them off, even though its data stays"

  local do_rm=0
  for label in "${ours[@]}"; do
    IFS='|' read -r n c d <<< "$label"
    if ! acting; then
      would "docker rm -f $c   ($n)"
      left_in_place+=("$label")
      continue
    fi
    img="$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null)"
    cfg="$(compose_label_of "$c" com.docker.compose.project.config_files)"
    if [ "$ASSUME_YES" = 1 ]; then
      do_rm=1
    else
      confirm "Remove $c (${img:-image unknown}, from ${cfg:-compose file unknown})? [y/N] " && do_rm=1 || do_rm=0
    fi
    if [ "$do_rm" = 1 ]; then
      if docker rm -f "$c" >/dev/null 2>&1; then
        ok "$n removed ($c)"
      else
        warn "docker rm -f failed for $c"; left_in_place+=("$label"); PROBLEMS=$((PROBLEMS + 1))
      fi
    else
      left_in_place+=("$label")
    fi
  done

  if [ "${#left_in_place[@]}" -gt 0 ]; then
    local names=""
    for label in "${left_in_place[@]}"; do IFS='|' read -r n c d <<< "$label"; names="$names$c, "; done
    info "containers left in place: ${names%, }"
  fi

  print_kept_summary
}

# ── Running the plan (A.4, steps 8 to 15) ─────────────────────────────────────
# The order is the same in every mode; only the content of the plan changes. The bind-mount
# sources are created inside create_stack, before its `docker compose up -d` (lesson 3).
run_plan() {
  local before
  section "Services"
  ensure_service comfyui
  ensure_service ollama

  info "--- web app + updater (:$WEB_PORT, this repo's compose) ---"
  if [ "$PLAN_DO_WEB" = 0 ]; then
    ok "web app already answers — reused"; report web "reused"
  elif acting; then
    $COMPOSE up -d ai-content-studio >/dev/null 2>&1 && { ok "web app started"; report web created; } \
      || { err "could not start the web app"; report web FAILED; PROBLEMS=$((PROBLEMS + 1)); }
  else
    would "docker compose up -d ai-content-studio"; report web "would create"
  fi
  resolve_models_dir
  # The updater needs the LoRA folder to exist as us, otherwise dockerd creates it as root
  # and uploading a LoRA from the UI fails. mkdir -p creates the models directory on the way.
  if [ "$PLAN_DO_ENV" = 1 ]; then
    if acting; then
      mkdir -p "$MODELS_DIR/loras" 2>/dev/null
      printf 'COMFY_LORAS_DIR=%s\n' "$MODELS_DIR/loras" > "$REPO_ROOT/.env"
    else
      would "write $REPO_ROOT/.env with COMFY_LORAS_DIR=$MODELS_DIR/loras and create $MODELS_DIR/loras"
    fi
  fi
  if [ "$PLAN_DO_UPDATER" = 1 ]; then
    if acting; then
      # The build output goes to the log only: pages of build lines would bury the run on screen,
      # and discarding them left a failed build with nothing to diagnose it from.
      $COMPOSE up -d --build updater >> "$LOG_FILE" 2>&1 && report updater started \
        || { err "the updater could not be rebuilt — its build output is in $LOG_FILE"; report updater FAILED; PROBLEMS=$((PROBLEMS + 1)); }
    else
      would "docker compose up -d --build updater"; report updater "would start"
    fi
  fi

  section "Models"
  # Step 11: the mounts of the containers that are now running have the last word.
  before="$MODELS_DIR"
  resolve_models_dir
  [ "$MODELS_DIR" = "$before" ] || info "models directory changed once the services were up: $before -> $MODELS_DIR"
  [ "$PLAN_DO_MIGRATE" = 1 ] && migrate_legacy_models
  if acting && [ ! -w "$MODELS_DIR" ]; then
    err "model directory is not writable: $MODELS_DIR"
    info "  usual cause: created by Docker as root. Fix: sudo chown -R $(id -u):$(id -g) \"$COMFY_DIR\""
    report models "SKIPPED (not writable)"; PROBLEMS=$((PROBLEMS + 1))
  elif [ "$SKIP_MODELS" = 1 ]; then
    info "--skip-models: download skipped"; report models "skipped (--skip-models)"
  else
    if [ "$PLAN_DO_MODELS" = 1 ]; then disk_guard; download_models || true; fi
    scan_models
    report models "$MODELS_OK ok / $MODELS_BAD missing or incomplete"
    [ "$MODELS_BAD" -eq 0 ] || PROBLEMS=$((PROBLEMS + 1))
  fi

  section "Ollama model"
  ensure_ollama_model
}

# ── Verification: through nginx, like the browser (lesson 5) ──────────────────
# ── The proof: a reduced real render, --smoke (A.7) ───────────────────────────
# verify() above only proves the endpoints answer, through the proxy, exactly like the
# browser. It does not prove a render actually works (lesson 6). --smoke does: it reuses
# tools/validate.py, which talks to ComfyUI directly on :8188 — never through nginx — so
# it is a DIFFERENT proof, not a replacement for the proxy checks above.
smoke_test() {
  if [ "$PLAN_DO_SMOKE" = 0 ]; then
    # --smoke asked for, but build_plan found no python3: a warning, never a failure.
    [ "$SMOKE" = 1 ] && warn "--smoke skipped: python3 is not installed"
    return 0
  fi
  local basedir="${MODELS_DIR%/models}"
  info "      note: --smoke talks to ComfyUI directly on :8188. It proves ComfyUI + models + disk,"
  info "            but NOT the nginx proxy. The three :8090 checks above are what prove the proxy."
  info "            Both are needed; neither replaces the other."
  if ! acting; then
    would "COMFY_BASEDIR=$basedir python3 tools/validate.py workflows/api/krea2_t2i.json --reduce"
    return 0
  fi
  info "  running a reduced real render: python3 tools/validate.py workflows/api/krea2_t2i.json --reduce"
  if COMFY_BASEDIR="$basedir" python3 "$REPO_ROOT/tools/validate.py" "$REPO_ROOT/workflows/api/krea2_t2i.json" --reduce; then
    ok "smoke render succeeded"; report smoke "OK"
  else
    warn "smoke render failed — see the output above"; report smoke FAILED; PROBLEMS=$((PROBLEMS + 1))
  fi
}

verify() {
  section "Verification (through the nginx proxy, exactly like the browser)"
  local u code bad=0 i comfy_code=000 ollama_code=000
  for u in /comfy/system_stats /ollama/api/version /update/status; do
    # Retry before printing: a service recreated seconds ago (the updater, typically) answers
    # 502 for a moment. Printing that first code and then quietly forgiving it — as the first
    # version of this function did — shows the user a red line under a green summary.
    for i in 1 2 3; do
      code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://localhost:$WEB_PORT$u" 2>/dev/null || echo 000)"
      [ "$code" = 200 ] && break
      [ "$i" -lt 3 ] && sleep 3
    done
    printf '  :%s%-22s -> HTTP %s\n' "$WEB_PORT" "$u" "$code"
    [ "$code" = 200 ] || bad=$((bad + 1))
    [ "$u" = /comfy/system_stats ] && comfy_code="$code"
    [ "$u" = /ollama/api/version ] && ollama_code="$code"
  done
  [ "$bad" -eq 0 ] || PROBLEMS=$((PROBLEMS + bad))

  scan_models
  printf '  models: %s ok, %s missing or incomplete (in %s)\n' "$MODELS_OK" "$MODELS_BAD" "$MODELS_DIR"
  [ "$MODELS_BAD" -eq 0 ] || PROBLEMS=$((PROBLEMS + 1))

  # Does ComfyUI actually offer them? A model on disk that ComfyUI cannot see is the exact
  # failure this whole v2 exists to prevent. The comparison is against the diffusion model
  # names REALLY on disk, never a hardcoded one: a machine holding only the Krea 2 files would
  # fail a hardcoded check while being perfectly healthy.
  if [ "$comfy_code" = 200 ]; then
    FP_COMFY_HEALTH=1
    FP_COMFY_LISTS="$(curl -s -m 10 "http://localhost:$WEB_PORT/comfy/object_info/UNETLoader" 2>/dev/null)"
    comfy_broken   # recomputes FP_COMFY_DISK_N / FP_COMFY_LISTED / FP_COMFY_LISTED_NAMES
    if [ "$FP_COMFY_DISK_N" -eq 0 ]; then
      info "  no diffusion model on disk yet — nothing for ComfyUI to list"
    elif [ "$FP_COMFY_LISTED" -gt 0 ]; then
      ok "ComfyUI lists its models ($FP_COMFY_LISTED of the $FP_COMFY_DISK_N on disk, e.g. ${FP_COMFY_LISTED_NAMES%% *})"
    else
      warn "ComfyUI lists none of the $FP_COMFY_DISK_N diffusion model(s) present on disk — check BASE_DIRECTORY and its /basedir mount"
      PROBLEMS=$((PROBLEMS + 1))
    fi
  fi

  # The model the plan promised, asked through the proxy like everything above: an Ollama that
  # answers without it cannot enhance a single prompt.
  if [ "$ollama_code" = 200 ]; then
    if curl -s -m 10 "http://localhost:$WEB_PORT/ollama/api/tags" 2>/dev/null | grep -q "\"$OLLAMA_MODEL\""; then
      ok "Ollama has $OLLAMA_MODEL"
    else
      warn "$OLLAMA_MODEL is not present in Ollama — prompt enhancement cannot work"
      PROBLEMS=$((PROBLEMS + 1))
    fi
  fi

  smoke_test
  return 0
}

summary() {
  section "Summary"
  local line
  for line in "${REPORT[@]}"; do printf '  %-14s %s\n' "${line%%|*}" "${line#*|}"; done
  local oc odata=""
  oc="$(container_on_port 11434 || true)"
  [ -n "$oc" ] && odata="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/root/.ollama"}}{{.Source}}{{end}}{{end}}' "$oc" 2>/dev/null)"
  [ -n "$odata" ] || odata="native service or unmanaged — not handled by this script"
  [ -d "$OLLAMA_DIR" ] && [ -z "$oc" ] && odata="$OLLAMA_DIR"
  printf '\n  app      : %s\n  ComfyUI  : %s (models)\n  Ollama   : %s\n' "$REPO_ROOT" "$MODELS_DIR" "$odata"
  printf '  log      : %s\n' "$LOG_FILE"
  if [ "$PLAN_MODE" = uninstall ]; then
    if [ "$PROBLEMS" -ne 0 ]; then line="$PROBLEMS problem(s) above — not everything announced could be removed."
    elif acting; then          line="Uninstall finished: the data listed under Kept is untouched."
    else                       line="Nothing was removed: this mode never removes anything."
    fi
    printf '\n%s%s%s\n' "$BOLD" "$line" "$RESET"
  elif [ "$PROBLEMS" -eq 0 ]; then
    printf '\n%sEverything the app needs is in place.%s\n' "$BOLD" "$RESET"
  else
    printf '\n%s%s problem(s) above — the app cannot generate reliably yet.%s\n' "$BOLD" "$PROBLEMS" "$RESET"
  fi
}

# ── Phases ────────────────────────────────────────────────────────────────────
preflight() {
  section "Preflight"
  [ "$(uname -m)" = aarch64 ] && ok "aarch64 (GB10/DGX Spark)" || warn "architecture $(uname -m): this script targets GB10/DGX Spark (ARM64), continuing anyway"
  command -v docker >/dev/null 2>&1 || { err "'docker' not found in PATH"; exit 1; }
  docker compose version >/dev/null 2>&1 || { err "the 'docker compose' v2 plugin is missing"; exit 1; }
  ok "docker + docker compose available"
  if docker info 2>/dev/null | grep -qi nvidia; then ok "nvidia runtime detected"
  elif command -v nvidia-smi >/dev/null 2>&1; then ok "nvidia-smi available"
  else warn "cannot confirm nvidia-container-toolkit — GPU services may fail to start"; fi
  [ -f "$MODELS_FILE" ] || warn "$MODELS_FILE not found — model steps will be skipped"
}

disk_guard() {
  # A run that dies at 90% of a 150 GB download wastes hours. Check first.
  local avail_kb need_gb avail_gb
  scan_models
  [ "$MODELS_BYTES_NEEDED" -gt 0 ] || return 0
  avail_kb="$(df -Pk "$MODELS_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
  is_uint "${avail_kb:-}" || return 0
  need_gb=$((MODELS_BYTES_NEEDED / 1000000000)); avail_gb=$((avail_kb / 1000000))
  info "models to fetch: $MODELS_BAD file(s), about ${need_gb} GB — free space: ${avail_gb} GB"
  [ "$avail_gb" -gt "$need_gb" ] || { warn "not enough free space for the missing models"; PROBLEMS=$((PROBLEMS + 1)); }
}

# ── The 19 steps, in the same order in every mode (A.4) ───────────────────────
main() {
  info "log: $LOG_FILE"
  [ "$MODE" = dry-run ] && info "DRY RUN — nothing will be created, downloaded or removed"
  [ "$MODE" = check ]   && info "CHECK — read-only diagnosis"

  preflight
  fingerprint
  verdict_comfyui; verdict_ollama; verdict_web; verdict_models
  headline_state

  if   [ -n "$MODE_ARG" ];      then PLAN_MODE="$MODE_ARG"
  elif [ "$MODE" = uninstall ]; then PLAN_MODE=uninstall
  elif [ "$HEADLINE" = VIRGIN ];   then PLAN_MODE=fresh
  else                               PLAN_MODE=repair
  fi
  [ "$MODE" = auto ] && MODE="$PLAN_MODE"

  diagnosis
  # The install/repair plan means nothing to an uninstall (real or --dry-run): what it would
  # remove, and what it keeps, is listed by uninstall_run itself.
  if [ "$PLAN_MODE" != uninstall ]; then build_plan; print_plan; fi

  case "$MODE" in
    check)     : ;;       # read-only: the diagnosis and the plan above are the whole output
    # --dry-run walks the very same pipeline with acting() false: every step announces
    # itself with "would ..." and nothing is created, downloaded or removed. --mode uninstall
    # --dry-run keeps that promise for uninstall_run specifically (MODE_ARG carries the
    # "uninstall" intent through, since --dry-run above overwrites plain $MODE).
    dry-run)   if [ "$MODE_ARG" = uninstall ]; then uninstall_run; else run_plan; fi ;;
    uninstall) uninstall_run ;;
    *)
      if [ "$ASSUME_YES" = 1 ]; then
        info "--yes: proceeding without confirmation."
      elif interactive; then
        if ! confirm "Proceed with this plan? [y/N] "; then
          info "Nothing was changed."
          # From here on this IS a --check: the same read-only proof below decides the exit code,
          # never the headline — a healthy third-party ComfyUI is not UP TO DATE and still generates.
          MODE=check
        fi
      else
        info "No TTY: proceeding without confirmation."
      fi
      if [ "$MODE" != check ]; then
        [ "$PLAN_DO_TOKEN" = 1 ] && hf_token_acquire
        [ "$PLAN_DO_TAKEOVER" = 1 ] && takeover_comfyui
        run_plan
      fi
      ;;
  esac

  report_models_delta
  # Uninstall removes components on purpose: probing their health afterwards would turn every
  # successful uninstall into a failure (exit 2 while the removal went exactly as announced).
  # Its exit code comes from uninstall_run alone: 2 only if a component we own could not be removed.
  [ "$MODE" != uninstall ] && [ "$MODE_ARG" != uninstall ] && verify
  summary
  [ "$PROBLEMS" -eq 0 ] || exit 2
}

main
