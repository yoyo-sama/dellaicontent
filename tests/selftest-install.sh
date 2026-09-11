#!/usr/bin/env bash
# selftest-install.sh — exercises install.sh end to end against stubbed docker/curl/ss/
# systemctl/sudo, in a throwaway $HOME and a throwaway copy of the repo. Nothing on the real
# machine is touched: no container, no download, no write outside the temp directory.
#
# Why this exists: every bug found in v1 (root-owned bind mounts, models downloaded into a
# folder ComfyUI does not read, a second Ollama created next to a stopped native one, a
# summary claiming success while nothing worked) is only reproducible on a machine in a
# specific state. Stubs let us put the script in that state in a second, before shipping.
#
# Usage: tests/selftest-install.sh [scenario ...]     (no argument = all)

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

# ── Stubs ─────────────────────────────────────────────────────────────────────
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$TRACE"
# The Hugging Face token must never reach docker: through compose, it would land in a container's
# env (the ComfyUI template reads ${HF_TOKEN:-}), readable by anyone running docker inspect.
[ -n "${HF_TOKEN+set}" ] && echo "docker $*" >> "$STATE/docker_saw_hf_token"
# Compose labels a real container carries, per container. web-nginx/web-updater always carry this
# repo's docker-compose.yml, as on a real machine: with an empty label, this stub once hid the
# web container being taken for a legacy ComfyUI (then docker rm -f'd) by container_on_port.
labels_of() {   # container -> sets cfg (config_files) and svc (service)
  cfg=""; svc=""
  case "$1" in
    web-nginx)   cfg="$REPO_UNDER_TEST/docker-compose.yml"; svc=ai-content-studio ;;
    web-updater) cfg="$REPO_UNDER_TEST/docker-compose.yml"; svc=updater ;;
    # other projects on the machine: a sibling app's updater, a foreign web app on :8090
    canvas-ai-studio-updater) cfg="$HOME/canvas-ai-studio/docker-compose.yml"; svc=updater ;;
    other-web)                cfg="$HOME/other-web/docker-compose.yml"; svc=web ;;
    *comfy*|*ollama*)
      if [ "${SCN_LEGACY:-0}" = 1 ]; then cfg="$REPO_UNDER_TEST/docker-compose.yml"
      elif [ "${SCN_FOREIGN_COMFY:-0}" = 1 ] && [[ "$1" == *comfy* ]]; then
        # SCN_FOREIGN_CFG set but empty = a plain `docker run` container, no compose label at all
        cfg="${SCN_FOREIGN_CFG-$HOME/comfyui-spark/compose.yaml}"; [ -n "$cfg" ] && svc=comfyui
      fi ;;
  esac
}
case "$1" in
  info) echo "Runtime: nvidia"; exit 0 ;;
  compose)
    [[ "$*" == *--build* ]] && echo "#1 [updater] building (stub build output)"
    if [[ "$*" == *"up -d"* ]]; then
      [[ "$PWD" == *comfyui-spark ]] && touch "$STATE/comfy_up"
      [[ "$PWD" == *ollama ]] && touch "$STATE/ollama_up"
      [[ "$*" == *ai-content-studio* ]] && touch "$STATE/web_up"
      # a takeover passes its override explicitly (-f): only then does the recreated ComfyUI
      # get BASE_DIRECTORY and list the models on disk (see the curl stub)
      [[ "$*" == *" -f "*override* ]] && touch "$STATE/comfy_up" "$STATE/takeover_up"
    fi
    exit 0 ;;
  ps)
    if [[ "$*" == *"status=exited"* ]]; then
      [ -n "${SCN_STOPPED_COMFY:-}" ]  && printf '%s\tmmartial/comfyui-nvidia-docker:x\n' "$SCN_STOPPED_COMFY"
      [ -n "${SCN_STOPPED_OLLAMA:-}" ] && printf '%s\tollama/ollama:latest\n' "$SCN_STOPPED_OLLAMA"
      exit 0
    fi
    # the updater, looked up by its compose labels: only this repo's matches the filter
    if [[ "$*" == *"label=com.docker.compose.service=updater"* ]]; then
      [ -f "$STATE/web_up" ] && [[ "$*" == *"config_files=$REPO_UNDER_TEST/docker-compose.yml"* ]] && echo web-updater
      exit 0
    fi
    # running containers, by published port
    [[ "$*" == *"publish=8188"* ]] && { [ -f "$STATE/comfy_up" ] && echo comfyui-nvidia; exit 0; }
    [[ "$*" == *"publish=11434"* ]] && { [ -f "$STATE/ollama_up" ] && echo ollama-api; exit 0; }
    [[ "$*" == *"publish=8090"* ]] && { [ "${SCN_FOREIGN_WEB:-0}" = 1 ] && echo other-web; exit 0; }
    # nginx runs host-network (no published port): container_on_port finds it by mount instead.
    # Gated on $STATE/web_up, the same marker that drives the web/updater health checks below.
    [[ "$*" == *"network=host"* ]] && { [ -f "$STATE/web_up" ] && echo web-nginx; exit 0; }
    # every running container with its image: a foreign updater comes FIRST, so a lookup by
    # image name ("the first image containing 'updater'") would pick it
    if [[ "$*" == *'{{.Names}} {{.Image}}'* ]]; then
      [ "${SCN_FOREIGN_UPDATER:-0}" = 1 ] && echo "canvas-ai-studio-updater canvas-ai-studio-updater"
      [ -f "$STATE/web_up" ] && echo "web-updater updater:latest"
      exit 0
    fi
    exit 0 ;;
  start) touch "$STATE/${2}_started"; [ "${SCN_START_HEALS:-1}" = 1 ] && { [[ "$2" == *comfy* ]] && touch "$STATE/comfy_up"; [[ "$2" == *ollama* ]] && touch "$STATE/ollama_up"; }; exit 0 ;;
  rm) # only the named container goes down, not every service (v1 of this stub removed both,
      # which silently changed the scenario under test)
      touch "$STATE/rm_$3"
      [[ "$3" == *comfy* ]] && rm -f "$STATE/comfy_up"
      [[ "$3" == *ollama* ]] && rm -f "$STATE/ollama_up"
      exit 0 ;;
  inspect)
    labels_of "${@: -1}"   # the container is always the last argument
    [[ "$*" == *config_files* ]] && { [ -n "$cfg" ] && echo "$cfg"; exit 0; }
    # Order matters: config_files contains "com.docker.compose.project" as a substring too.
    [[ "$*" == *'"com.docker.compose.project"'* ]] && { [ -n "$cfg" ] && basename "$(dirname "${cfg%%,*}")"; exit 0; }
    [[ "$*" == *'"com.docker.compose.service"'* ]] && { [ -n "$svc" ] && echo "$svc"; exit 0; }
    [[ "$*" == *basedir* ]] && { [ -f "$STATE/comfy_up" ] && echo "${SCN_FOREIGN_BASEDIR:-$HOME/comfyui-spark/basedir}"; exit 0; }
    [[ "$*" == *root/.ollama* ]] && { echo "$HOME/ollama/data"; exit 0; }
    [[ "$*" == *'{{json .Mounts}}'* ]] && { echo "[{\"Source\":\"$REPO_UNDER_TEST\",\"Destination\":\"/usr/share/nginx/html\"}]"; exit 0; }
    # The third-party ComfyUI's environment, secrets included, as `-f '{{range .Config.Env}}..'`
    # or as a bare `docker inspect`: install.sh may pick the keys it needs out of it and must
    # never print or log the rest (scn_takeover_never_dumps_secrets).
    if [ "${SCN_FOREIGN_COMFY:-0}" = 1 ] && [[ "${@: -1}" == *comfy* ]]; then
      env_lines="OPENAI_API_KEY=sk-test123 WANTED_UID=1000 WANTED_GID=1000 PATH=/usr/bin"
      [ -n "${SCN_FOREIGN_HF_TOKEN:-}" ] && env_lines="HF_TOKEN=$SCN_FOREIGN_HF_TOKEN $env_lines"
      [ -f "$STATE/takeover_up" ] && env_lines="$env_lines BASE_DIRECTORY=/basedir"
      if [[ "$*" == *.Config.Env* ]]; then printf '%s\n' $env_lines
      elif [[ "$*" != *-f* ]]; then printf '{"Config":{"Env":["%s"]}}\n' "${env_lines// /\",\"}"
      fi
    fi
    exit 0 ;;
  volume) [ "${SCN_LEGACY:-0}" = 1 ] || [ "${SCN_VOL_OLLAMA:-0}" = 1 ]; exit ;;
  # `docker system df -v`, the Local Volumes section as the real one prints it
  system)
    { [ "${SCN_LEGACY:-0}" = 1 ] || [ "${SCN_VOL_OLLAMA:-0}" = 1 ]; } \
      && printf 'Local Volumes space usage:\n\nVOLUME NAME   LINKS     SIZE\nollama-data   1         66.4GB\n\nBuild cache usage: 0B\n'
    exit 0 ;;
  run) exit 0 ;;
esac
exit 0
STUB
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
url=""; out=""; prev=""; want_code=0; has_f=0
for a in "$@"; do
  case "$a" in -sf|-sfL|-f) has_f=1 ;; esac
  [ "$prev" = "-o" ] && out="$a"
  [ "$prev" = "-w" ] && [[ "$a" == *http_code* ]] && want_code=1
  case "$a" in http*|https*) url="$a" ;; esac
  prev="$a"
done
echo "curl $url" >> "$TRACE"
# Full argv, for tests proving a secret travels on stdin (-K -) and never on the command line
# (an argv secret sits in `ps aux` for as long as the request takes).
[ -n "${STATE:-}" ] && printf '%s\n' "$*" >> "$STATE/curl_argv"
# The config read on stdin (-K -), where the Authorization header travels. Read ONLY then: any
# other curl shares install.sh's stdin, which carries the scenario's scripted answers.
kcfg=""; case " $* " in *" -K - "*) kcfg="$(cat)" ;; esac
# -w '%{http_code}' : le vrai curl imprime le code même sur erreur HTTP. Sans ça, la phase
# de vérification lisait une chaîne vide et concluait à un échec.
# Mimics curl closely enough for the script's two usages: `curl -sf URL` (non-zero exit on
# failure) and `curl -s -o /dev/null -w '%{http_code}' URL` (exit 0, code printed).
finish() {
  [ "$want_code" = 1 ] && printf '%s' "$1"
  [ "$1" = 200 ] && exit 0
  [ "$has_f" = 1 ] && exit 22
  exit 0
}
comfy_ok() { [ -f "$STATE/comfy_up" ]; }
ollama_ok() { [ -f "$STATE/ollama_up" ] || [ "${SCN_NATIVE_OLLAMA_UP:-0}" = 1 ]; }
case "$url" in
  *localhost:8188*|*:8090/comfy/*)
    comfy_ok || finish 000
    if [[ "$url" == *object_info* ]]; then
      if [ "${SCN_FOREIGN_COMFY:-0}" = 1 ]; then
        # Foreign-ComfyUI takeover scenarios: the listing only starts naming the disk model once
        # compose was run with the override (see the docker stub) — the "before broken / after
        # fixed" proof. A scenario can also start with takeover_up: a healthy third-party ComfyUI.
        if [ -f "$STATE/takeover_up" ]; then
          echo '{"UNETLoader":{"input":{"required":{"unet_name":[["krea2_turbo_fp8_scaled.safetensors"]]}}}}'
        else
          echo '{"UNETLoader":{"input":{"required":{"unet_name":[["totally_unrelated_model.safetensors"]]}}}}'
        fi
      else
        echo '{"UNETLoader":{"input":{"required":{"unet_name":[["minimax_h3_fl2va_pruned_w4a8_mixed.safetensors"]]}}}}'
      fi
    fi
    finish 200 ;;
  *localhost:11434*|*:8090/ollama/*)
    ollama_ok || finish 000
    [[ "$url" == *api/tags* ]] && { [ -f "$STATE/pulled" ] && echo '{"models":[{"name":"gemma4:e4b"}]}'; }
    [[ "$url" == *api/pull* ]] && touch "$STATE/pulled"
    finish 200 ;;
  *:8090/update/status*) [ -f "$STATE/web_up" ] && finish 200 || finish 000 ;;
  *localhost:8090/*|*localhost:8090) [ -f "$STATE/web_up" ] && finish 200 || finish 000 ;;
  https://huggingface.co/api/whoami-v2)
    # Only the scenario's SCN_HF_VALID token is accepted; every other one is rejected (401).
    [[ "$kcfg" == *"Bearer ${SCN_HF_VALID:-@none@}\""* ]] && { echo '{"type":"user","name":"stub-user"}'; exit 0; }
    exit 22 ;;
  https://huggingface.co/*|https://*)
    # Downloads that carried an Authorization header: a rejected token must never be sent.
    [[ "$kcfg" == *Authorization* ]] && echo "$url" >> "$STATE/curl_auth"
    # A download writes a sparse file of exactly the size models.txt announces, so the
    # size check behaves like it would against the real Hugging Face file.
    [ -n "$out" ] || exit 0
    size="$(awk -F'|' -v u="$url" '$4==u{print $3; exit}' "$REPO_UNDER_TEST/scripts/models.txt")"
    [ -n "$size" ] || size=1
    truncate -s "$size" "$out" 2>/dev/null || printf 'x' > "$out"
    exit 0 ;;
esac
exit 1
STUB
printf '#!/usr/bin/env bash\n[ "${SCN_PORT_BUSY:-}" = "1" ] && [[ "$*" == *8188* ]] && { echo LISTEN; exit 0; }\nexit 1\n' > "$TMP/bin/ss"
printf '#!/usr/bin/env bash\n[ "$1" = cat ] && { [ "${SCN_NATIVE_OLLAMA:-0}" = 1 ] && exit 0 || exit 1; }\nexit 0\n' > "$TMP/bin/systemctl"
printf '#!/usr/bin/env bash\necho "sudo $*" >> "$TRACE"\n[ "${SCN_SUDO_OK:-0}" = 1 ] || exit 1\ntouch "$STATE/ollama_up"\nexit 0\n' > "$TMP/bin/sudo"
chmod +x "$TMP/bin"/*

# ── Harness ───────────────────────────────────────────────────────────────────
run_case() {   # name, then env assignments in SCN_*, exported by the caller
  CASE_HOME="$TMP/$1/home"; STATE="$TMP/$1/state"; TRACE="$TMP/$1/trace"
  REPO_UNDER_TEST="$TMP/$1/repo"
  rm -rf "$TMP/$1"; mkdir -p "$CASE_HOME" "$STATE"; : > "$TRACE"
  local f; for f in ${SCN_PRESTATE:-}; do touch "$STATE/$f"; done
  cp -a "$REPO_ROOT" "$REPO_UNDER_TEST"; rm -f "$REPO_UNDER_TEST/.env"; rm -rf "$REPO_UNDER_TEST/comfyui"
  export STATE TRACE REPO_UNDER_TEST
  if [ "${SCN_NATIVE_OLLAMA:-0}" = 1 ]; then printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/ollama"; chmod +x "$TMP/bin/ollama"; else rm -f "$TMP/bin/ollama"; fi
  # Optional extra fixture setup (third-party compose.yaml, pre-placed models, ...), run once
  # CASE_HOME/STATE/REPO_UNDER_TEST exist but before install.sh starts. Opt-in, unset by
  # default: the eight original scenarios never set it and behave exactly as before.
  [ -n "${SETUP_FN:-}" ] && "$SETUP_FN"
  shift
  # A bounded here-string, never the ambient stdin: a scenario that sets INSTALL_ASSUME_TTY
  # scripts its answers through SCN_STDIN, and every other scenario gets a harmless, already-
  # closed stdin — regardless of what the harness's OWN stdin looks like (this file is run both
  # with `</dev/null` and with a silent, open pipe; install.sh must never block on either).
  # SCN_PATH replaces the host PATH behind the stubs (a machine missing a command, e.g. python3).
  OUT="$(HOME="$CASE_HOME" PATH="$TMP/bin:${SCN_PATH:-$PATH}" bash "$REPO_UNDER_TEST/install.sh" "$@" 2>&1 <<<"${SCN_STDIN:-}")"
  RC=$?
}

assert()     { if printf '%s' "$OUT" | grep -qF -- "$1"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf '  FAIL: expected output %s\n' "$(printf '%q' "$1")"; fi; }
assert_not() { if printf '%s' "$OUT" | grep -qF -- "$1"; then FAIL=$((FAIL+1)); printf '  FAIL: unexpected output %s\n' "$(printf '%q' "$1")"; else PASS=$((PASS+1)); fi; }
assert_rc()  { if [ "$RC" = "$1" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf '  FAIL: exit %s, expected %s\n' "$RC" "$1"; fi; }
assert_file(){ if [ -e "$1" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf '  FAIL: missing %s\n' "$1"; fi; }
assert_no_file(){ if [ -e "$1" ]; then FAIL=$((FAIL+1)); printf '  FAIL: unexpected %s\n' "$1"; else PASS=$((PASS+1)); fi; }
assert_owner(){ if [ "$(stat -c%U "$1" 2>/dev/null)" = "$(id -un)" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf '  FAIL: %s not owned by the user\n' "$1"; fi; }
# File-content counterparts of assert/assert_not, for what lands in a log file or a written
# artifact rather than on $OUT (install.sh's own stdout).
assert_grep()     { if grep -qF -- "$2" "$1" 2>/dev/null; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf '  FAIL: %s missing from %s\n' "$(printf '%q' "$2")" "$1"; fi; }
assert_not_grep() { if grep -qF -- "$2" "$1" 2>/dev/null; then FAIL=$((FAIL+1)); printf '  FAIL: unexpected %s in %s\n' "$(printf '%q' "$2")" "$1"; else PASS=$((PASS+1)); fi; }
# An uninstall never shows the install/repair plan (its header and steps) nor its closing line.
assert_no_install_plan() {
  assert_not "=== Plan (mode:"
  assert_not "rebuild and restart the updater"
  assert_not "prove it: 3 endpoints"
  assert_not "Everything the app needs is in place."
}

# ── Scenarios ─────────────────────────────────────────────────────────────────
scn_virgin() {
  echo "· virgin machine: nothing installed"
  export SCN_LEGACY=0 SCN_NATIVE_OLLAMA=0 SCN_PORT_BUSY=0 SCN_STOPPED_COMFY= SCN_STOPPED_OLLAMA= SCN_NATIVE_OLLAMA_UP=0
  run_case virgin
  assert "creating the comfyui stack in $TMP/virgin/home/comfyui-spark"
  assert "userscripts deployed before first start: 2 file(s)"
  assert "creating the ollama stack"
  assert "gemma4:e4b downloaded"
  assert "models: 20 ok, 0 missing"
  assert "Everything the app needs is in place."
  assert_rc 0
  assert_file "$TMP/virgin/home/comfyui-spark/basedir/models"
  assert_file "$TMP/virgin/home/comfyui-spark/.env"
  assert_owner "$TMP/virgin/home/comfyui-spark/basedir"   # lesson 3: never root
  assert_owner "$TMP/virgin/home/ollama/data"
}

scn_legacy_containers() {
  echo "· machine running the old layout: containers created by the repo's own compose file"
  export SCN_LEGACY=1 SCN_NATIVE_OLLAMA=0 SCN_PORT_BUSY=0 SCN_STOPPED_COMFY= SCN_STOPPED_OLLAMA= SCN_NATIVE_OLLAMA_UP=0
  export SCN_PRESTATE="comfy_up ollama_up web_up"
  run_case legacy
  unset SCN_PRESTATE
  assert "inherited from the old layout"
  assert "copying weights from the legacy 'ollama-data' volume"
  assert "migrated to"
  if grep -q "docker rm -f" "$TMP/legacy/trace"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "  FAIL: the inherited container was never removed"; fi
  assert_rc 0
}

scn_legacy_models() {
  echo "· old layout + models already downloaded in the repo folder"
  export SCN_LEGACY=1 SCN_NATIVE_OLLAMA=0 SCN_PORT_BUSY=0 SCN_STOPPED_COMFY= SCN_STOPPED_OLLAMA= SCN_NATIVE_OLLAMA_UP=0
  rm -rf "$TMP/legmod"; mkdir -p "$TMP/legmod/home" "$TMP/legmod/state"
  STATE="$TMP/legmod/state"; TRACE="$TMP/legmod/trace"; REPO_UNDER_TEST="$TMP/legmod/repo"
  cp -a "$REPO_ROOT" "$REPO_UNDER_TEST"; rm -f "$REPO_UNDER_TEST/.env"
  mkdir -p "$REPO_UNDER_TEST/comfyui/basedir/models/vae"
  truncate -s 253806246 "$REPO_UNDER_TEST/comfyui/basedir/models/vae/qwen_image_vae.safetensors"
  export STATE TRACE REPO_UNDER_TEST
  OUT="$(HOME="$TMP/legmod/home" PATH="$TMP/bin:$PATH" bash "$REPO_UNDER_TEST/install.sh" 2>&1)"; RC=$?
  assert "1 file(s) found in the legacy model folder"
  assert "moved: 1   left behind: 0"
  assert_file "$TMP/legmod/home/comfyui-spark/basedir/models/vae/qwen_image_vae.safetensors"
  assert_rc 0
}

scn_native_ollama_down() {
  echo "· native Ollama installed but stopped, no passwordless sudo"
  export SCN_LEGACY=0 SCN_NATIVE_OLLAMA=1 SCN_SUDO_OK=0 SCN_PORT_BUSY=0 SCN_STOPPED_COMFY= SCN_STOPPED_OLLAMA= SCN_NATIVE_OLLAMA_UP=0
  run_case natdown
  assert "installed natively on this host but does not answer"
  assert "sudo systemctl enable --now ollama.service"
  assert_not "creating the ollama stack"      # never a second Ollama
  assert "SKIPPED (native install stopped)"
  assert_rc 2                                  # the app cannot generate: non-zero exit
}

scn_native_ollama_starts() {
  echo "· native Ollama stopped, sudo allowed"
  export SCN_LEGACY=0 SCN_NATIVE_OLLAMA=1 SCN_SUDO_OK=1 SCN_PORT_BUSY=0 SCN_STOPPED_COMFY= SCN_STOPPED_OLLAMA= SCN_NATIVE_OLLAMA_UP=0
  run_case natup
  assert "native ollama service started"
  assert_not "creating the ollama stack"
  assert_rc 0
}

scn_stopped_container() {
  echo "· ComfyUI present but its container is stopped"
  export SCN_LEGACY=0 SCN_NATIVE_OLLAMA=0 SCN_PORT_BUSY=0 SCN_STOPPED_COMFY=comfyui-old SCN_STOPPED_OLLAMA= SCN_NATIVE_OLLAMA_UP=0
  run_case stopped
  assert "found in a stopped container ('comfyui-old')"
  assert_not "creating the comfyui stack"      # never a duplicate
  assert_rc 0
}

scn_port_busy() {
  echo "· port 8188 held by something that does not answer"
  export SCN_LEGACY=0 SCN_NATIVE_OLLAMA=0 SCN_PORT_BUSY=1 SCN_STOPPED_COMFY= SCN_STOPPED_OLLAMA= SCN_NATIVE_OLLAMA_UP=0
  run_case portbusy
  assert "port 8188 is held by another process"
  assert_not "creating the comfyui stack"
  assert "SKIPPED (port 8188 busy)"
  assert_rc 2
}

scn_dry_run() {
  echo "· --dry-run on a virgin machine: says everything, does nothing"
  export SCN_LEGACY=0 SCN_NATIVE_OLLAMA=0 SCN_PORT_BUSY=0 SCN_STOPPED_COMFY= SCN_STOPPED_OLLAMA= SCN_NATIVE_OLLAMA_UP=0
  run_case dry --dry-run
  assert "DRY RUN"
  assert "would mkdir the bind-mount sources"
  if [ -d "$TMP/dry/home/comfyui-spark" ]; then FAIL=$((FAIL+1)); echo "  FAIL: --dry-run created $TMP/dry/home/comfyui-spark"; else PASS=$((PASS+1)); fi
  if grep -q "docker compose up" "$TMP/dry/trace" 2>/dev/null; then FAIL=$((FAIL+1)); echo "  FAIL: --dry-run ran docker compose up"; else PASS=$((PASS+1)); fi
}

# ── New scenarios (lot 4): interactive answers, --mode uninstall, the Hugging Face token ──────
# Baseline env for every scenario below, so a long export line is not repeated in each one. The
# eight scenarios above are untouched and keep doing their own exports exactly as before.
reset_scn() {
  export SCN_LEGACY=0 SCN_NATIVE_OLLAMA=0 SCN_PORT_BUSY=0 SCN_STOPPED_COMFY= SCN_STOPPED_OLLAMA= \
         SCN_NATIVE_OLLAMA_UP=0 SCN_SUDO_OK=0 SCN_FOREIGN_COMFY=0 SCN_FOREIGN_HF_TOKEN= \
         SCN_FOREIGN_WEB=0 SCN_FOREIGN_UPDATER=0 SCN_VOL_OLLAMA=0
  # unset, not emptied: an EMPTY SCN_FOREIGN_CFG means "no compose label"; set them with export
  unset SETUP_FN SCN_STDIN SCN_PRESTATE INSTALL_ASSUME_TTY HF_TOKEN \
        SCN_FOREIGN_CFG SCN_FOREIGN_BASEDIR SCN_HF_VALID SCN_PATH
}

write_foreign_compose_yaml() {   # a third-party compose.yaml in $COMFY_DIR: literal uid, no .env
  # No ${WANTED_UID and no .env next to it: that is what makes fingerprint() classify this
  # compose.yaml as "not ours" (FP_COMFY_YAML_OURS=0).
  mkdir -p "$CASE_HOME/comfyui-spark"
  cat > "$CASE_HOME/comfyui-spark/compose.yaml" <<'YAML'
services:
  comfyui:
    image: someoneelse/comfyui:latest
    environment:
      WANTED_UID: "1000"
YAML
}

fixture_foreign_dir_only() { write_foreign_compose_yaml; }

fixture_foreign_broken_comfy() {   # + one diffusion model on disk that object_info won't list yet
  write_foreign_compose_yaml
  mkdir -p "$CASE_HOME/comfyui-spark/basedir/models/diffusion_models"
  truncate -s 13141730784 "$CASE_HOME/comfyui-spark/basedir/models/diffusion_models/krea2_turbo_fp8_scaled.safetensors"
  sha256sum "$CASE_HOME/comfyui-spark/compose.yaml" | awk '{print $1}' > "$STATE/foreign_yaml_sha_before"
}

fixture_all_models_present() {   # every models.txt entry, correctly sized, already on disk
  local d f s u
  while IFS='|' read -r d f s u; do
    case "${d:-}" in ''|\#*) continue ;; esac
    u="${u%$'\r'}"
    { [ -n "$u" ] && [ "$u" != NON_TROUVE ]; } || continue
    mkdir -p "$CASE_HOME/comfyui-spark/basedir/models/$d"
    truncate -s "$s" "$CASE_HOME/comfyui-spark/basedir/models/$d/$f" 2>/dev/null
  done < "$REPO_ROOT/scripts/models.txt"
}

scn_plan_confirmed() {
  echo "· virgin machine, interactive plan confirmation: y -> installs"
  reset_scn
  export INSTALL_ASSUME_TTY=1
  SCN_STDIN=$'y\n'
  run_case plan_confirmed
  assert "creating the comfyui stack in $TMP/plan_confirmed/home/comfyui-spark"
  assert "creating the ollama stack"
  assert "Everything the app needs is in place."
  assert_rc 0
}

scn_plan_refused() {
  echo "· virgin machine, interactive plan confirmation: n -> nothing changes"
  reset_scn
  export INSTALL_ASSUME_TTY=1
  SCN_STDIN=$'n\n'
  run_case plan_refused
  assert "Nothing was changed."
  assert_rc 2
  assert_no_file "$TMP/plan_refused/home/comfyui-spark"
  assert_no_file "$TMP/plan_refused/home/ollama"
}

scn_legacy_down_migrated() {
  echo "· old layout: the ComfyUI container is inherited AND stopped -> migrated, never restarted"
  reset_scn
  SCN_LEGACY=1
  SCN_STOPPED_COMFY=comfyui-legacy-stopped
  run_case legacy_down_migrated
  assert "migrated to"
  assert_grep "$TMP/legacy_down_migrated/trace" "docker rm -f comfyui-legacy-stopped"
  assert_not_grep "$TMP/legacy_down_migrated/trace" "docker start comfyui-legacy-stopped"
  assert_rc 0
}

scn_takeover_accepted() {
  echo "· broken third-party ComfyUI, interactive takeover accepted (y y)"
  reset_scn
  SCN_FOREIGN_COMFY=1
  SCN_PRESTATE=comfy_up
  SETUP_FN=fixture_foreign_broken_comfy
  export INSTALL_ASSUME_TTY=1
  SCN_STDIN=$'y\ny\n'
  run_case takeover_accepted --skip-models
  local ovr="$TMP/takeover_accepted/home/comfyui-spark/compose.override.yaml"
  assert_file "$ovr"
  if head -n1 "$ovr" 2>/dev/null | grep -qF "written by install.sh"; then PASS=$((PASS+1))
  else FAIL=$((FAIL+1)); printf '  FAIL: %s has no "written by install.sh" marker on its first line\n' "$ovr"; fi
  assert_grep "$ovr" "BASE_DIRECTORY: /basedir"
  assert "ComfyUI now offers:"
  local before after
  before="$(cat "$TMP/takeover_accepted/state/foreign_yaml_sha_before" 2>/dev/null)"
  after="$(sha256sum "$TMP/takeover_accepted/home/comfyui-spark/compose.yaml" 2>/dev/null | awk '{print $1}')"
  if [ -n "$before" ] && [ "$before" = "$after" ]; then PASS=$((PASS+1))
  else FAIL=$((FAIL+1)); printf '  FAIL: third-party compose.yaml changed (sha256 %s -> %s)\n' "$before" "$after"; fi
}

scn_takeover_refused() {
  echo "· broken third-party ComfyUI, interactive takeover refused (y n)"
  reset_scn
  SCN_FOREIGN_COMFY=1
  SCN_PRESTATE=comfy_up
  SETUP_FN=fixture_foreign_broken_comfy
  export INSTALL_ASSUME_TTY=1
  SCN_STDIN=$'y\nn\n'
  run_case takeover_refused --skip-models
  assert "ComfyUI left exactly as it is"
  assert_no_file "$TMP/takeover_refused/home/comfyui-spark/compose.override.yaml"
  assert_rc 2
}

scn_takeover_no_tty() {
  echo "· broken third-party ComfyUI, no TTY and no --yes: refused without asking"
  reset_scn
  SCN_FOREIGN_COMFY=1
  SCN_PRESTATE=comfy_up
  SETUP_FN=fixture_foreign_broken_comfy
  run_case takeover_no_tty --skip-models
  assert "takeover needs a terminal, or --yes"
  assert_no_file "$TMP/takeover_no_tty/home/comfyui-spark/compose.override.yaml"
  assert_rc 2
}

scn_takeover_never_dumps_secrets() {
  echo "· takeover shows a summary of the third-party container, never its env: no secret on screen or in the log"
  reset_scn
  SCN_FOREIGN_COMFY=1
  SCN_FOREIGN_HF_TOKEN=hf_FAUXJETONTIERS123456   # the docker stub also carries OPENAI_API_KEY=sk-test123
  SCN_PRESTATE=comfy_up
  SETUP_FN=fixture_foreign_broken_comfy
  export INSTALL_ASSUME_TTY=1
  SCN_STDIN=$'y\ny\n'
  run_case takeover_never_dumps_secrets --skip-models
  local log; log="$(ls "$TMP/takeover_never_dumps_secrets/home"/install-*.log 2>/dev/null | head -n1)"
  assert "WANTED_UID/GID  : 1000/1000"
  assert_grep "$log" "WANTED_UID/GID  : 1000/1000"
  assert_not "hf_FAUXJETONTIERS123456"
  assert_not "sk-test123"
  assert_not_grep "$log" "hf_FAUXJETONTIERS123456"
  assert_not_grep "$log" "sk-test123"
}

scn_foreign_dir_only_refused() {
  echo "· third-party compose.yaml only, no container, no TTY: refused, nothing touched"
  reset_scn
  SETUP_FN=fixture_foreign_dir_only
  run_case foreign_dir_only_refused
  assert "No TTY: refused"
  assert_no_file "$TMP/foreign_dir_only_refused/state/comfy_up"
  assert_grep "$TMP/foreign_dir_only_refused/home/comfyui-spark/compose.yaml" 'WANTED_UID: "1000"'
  assert_rc 2
}

scn_uninstall_no_tty() {
  echo "· --mode uninstall, no TTY, no --yes: refused before touching anything"
  reset_scn
  run_case uninstall_no_tty --mode uninstall
  assert "uninstall needs a terminal, or --yes together with --components"
  assert_no_install_plan
  assert_rc 1
  assert_not_grep "$TMP/uninstall_no_tty/trace" "docker rm -f"
}

scn_uninstall_yes_components() {
  echo "· --mode uninstall --yes --components web, no TTY: only the web container is removed"
  reset_scn
  SCN_PRESTATE=web_up
  run_case uninstall_yes_components --mode uninstall --yes --components web
  assert_grep "$TMP/uninstall_yes_components/trace" "docker rm -f web-nginx"
  assert_not_grep "$TMP/uninstall_yes_components/trace" "docker rm -f web-updater"
  assert "=== Kept — nothing below was deleted ==="
  assert_no_install_plan
  assert "Uninstall finished: the data listed under Kept is untouched."
  assert_rc 0   # a successful uninstall exits 0: its health is not probed after removal
}

scn_uninstall_interactive_mixed() {
  echo "· --mode uninstall, interactive: web accepted (y), updater refused (n), in that order"
  reset_scn
  SCN_PRESTATE=web_up
  export INSTALL_ASSUME_TTY=1
  SCN_STDIN=$'y\nn\n'
  run_case uninstall_interactive_mixed --mode uninstall
  assert_grep "$TMP/uninstall_interactive_mixed/trace" "docker rm -f web-nginx"
  assert_not_grep "$TMP/uninstall_interactive_mixed/trace" "docker rm -f web-updater"
  assert "containers left in place: web-updater"
  assert_no_install_plan
  assert_rc 0   # a component the user declined is not a failure
}

scn_uninstall_never_touches_foreign() {
  echo "· foreign ComfyUI + --mode uninstall --yes --components web,updater,comfyui,ollama: foreign is never rm'd"
  reset_scn
  SCN_FOREIGN_COMFY=1
  SCN_PRESTATE="comfy_up web_up"
  run_case uninstall_never_touches_foreign --mode uninstall --yes --components web,updater,comfyui,ollama
  assert "NOT ours — will not be touched:"
  assert "comfyui-nvidia"
  assert_not_grep "$TMP/uninstall_never_touches_foreign/trace" "docker rm -f comfyui-nvidia"
  assert_grep "$TMP/uninstall_never_touches_foreign/trace" "docker rm -f web-nginx"
  assert_no_install_plan
  assert_rc 0
}

scn_hf_prompt_not_needed_when_complete() {
  echo "· every gated file already on disk: no Hugging Face token prompt"
  reset_scn
  SETUP_FN=fixture_all_models_present
  run_case hf_prompt_not_needed_when_complete
  assert_not "Hugging Face token (input hidden"
  assert "come from a gated repository (Lightricks/LTX-2.5) — all present"
  assert_rc 0
}

scn_hf_prompt_shown_when_gated_missing() {
  echo "· gated files missing, interactive, empty answer: continues without a token"
  reset_scn
  export INSTALL_ASSUME_TTY=1
  SCN_STDIN=$'y\n\n'
  run_case hf_prompt_shown_when_gated_missing
  assert "Continuing without a token"
}

scn_hf_token_never_logged_nor_in_argv() {
  echo "· HF_TOKEN env set (rejected), gated files missing: never logged, never in argv, never sent, never in docker's env"
  reset_scn
  export HF_TOKEN=FAUX-JETON-TEST-12345
  run_case hf_token_never_logged_nor_in_argv
  unset HF_TOKEN
  local log; log="$(ls "$TMP/hf_token_never_logged_nor_in_argv/home"/install-*.log 2>/dev/null | head -n1)"
  assert_not_grep "$log" "FAUX-JETON-TEST-12345"
  assert_not_grep "$TMP/hf_token_never_logged_nor_in_argv/state/curl_argv" "FAUX-JETON-TEST-12345"
  assert "Hugging Face token rejected by huggingface.co"
  # a rejected bearer token makes Hugging Face answer 401 even on public files: never sent
  assert_no_file "$TMP/hf_token_never_logged_nor_in_argv/state/curl_auth"
  assert_no_file "$TMP/hf_token_never_logged_nor_in_argv/state/docker_saw_hf_token"
}

scn_no_tty_silent_stdin() {
  echo "· virgin machine, no INSTALL_ASSUME_TTY, stdin open but silent: must not hang"
  local home state trace repo
  rm -rf "$TMP/no_tty_silent_stdin"
  mkdir -p "$TMP/no_tty_silent_stdin/home" "$TMP/no_tty_silent_stdin/state"
  home="$TMP/no_tty_silent_stdin/home"; state="$TMP/no_tty_silent_stdin/state"
  trace="$TMP/no_tty_silent_stdin/trace"; repo="$TMP/no_tty_silent_stdin/repo"
  : > "$trace"
  cp -a "$REPO_ROOT" "$repo"; rm -f "$repo/.env"; rm -rf "$repo/comfyui"
  rm -f "$TMP/bin/ollama"
  STATE="$state" TRACE="$trace" REPO_UNDER_TEST="$repo" \
    HOME="$home" PATH="$TMP/bin:$PATH" \
    timeout 90 bash "$repo/install.sh" < <(sleep 120) > "$TMP/no_tty_silent_stdin/out" 2>&1
  RC=$?
  OUT="$(cat "$TMP/no_tty_silent_stdin/out" 2>/dev/null)"
  if [ "$RC" = 124 ]; then
    FAIL=$((FAIL+1)); echo "  FAIL: install.sh hung — timeout 90 killed it while reading a silent, open stdin without INSTALL_ASSUME_TTY"
  else
    PASS=$((PASS+1))
  fi
}

# ── Lot 5 scenarios: one regression per fixed defect ─────────────────────────────────────────
scn_web_up_comfy_stopped() {   # F1
  echo "· web running, ComfyUI stopped, nothing on :8188/:11434: the web container is never taken for them"
  reset_scn
  SCN_PRESTATE=web_up
  SCN_STOPPED_COMFY=comfyui-old
  run_case web_up_comfy_stopped
  assert_not_grep "$TMP/web_up_comfy_stopped/trace" "docker rm -f web-nginx"
  assert_not "OLD LAYOUT"
  assert "found in a stopped container ('comfyui-old')"
  assert_rc 0
}

scn_web_up_comfy_absent() {   # F1
  echo "· web running, ComfyUI and Ollama absent: both created, the web container is never rm'd"
  reset_scn
  SCN_PRESTATE=web_up
  run_case web_up_comfy_absent
  assert_not_grep "$TMP/web_up_comfy_absent/trace" "docker rm -f web-nginx"
  assert_not "OLD LAYOUT"
  assert "creating the comfyui stack"
  assert "creating the ollama stack"
  assert_rc 0
}

fixture_own_complete() {   # our own ComfyUI stack (template + .env) with every model on disk
  mkdir -p "$CASE_HOME/comfyui-spark"
  cp "$REPO_UNDER_TEST/docker/stacks/comfyui.yml" "$CASE_HOME/comfyui-spark/compose.yaml"
  printf 'WANTED_UID=%s\nWANTED_GID=%s\n' "$(id -u)" "$(id -g)" > "$CASE_HOME/comfyui-spark/.env"
  fixture_all_models_present
}

scn_up_to_date() {   # F2
  echo "· our own complete install, every service up: UP TO DATE, exit 0"
  reset_scn
  SCN_PRESTATE="comfy_up ollama_up web_up pulled"
  SETUP_FN=fixture_own_complete
  run_case up_to_date
  assert "UP TO DATE — everything the app needs is in place"
  assert "1 of the 5 diffusion model(s) present on disk"
  assert_not "0 of the 0"
  assert "Everything the app needs is in place."
  assert_rc 0
  # F13d: the updater's build output lands in the log, not on screen, never discarded
  local log; log="$(ls "$TMP/up_to_date/home"/install-*.log 2>/dev/null | head -n1)"
  assert_grep "$log" "(stub build output)"
  assert_not "(stub build output)"
}

scn_verify_ollama_model_missing() {   # F11
  echo "· --check on a complete install whose Ollama lacks gemma4:e4b: reported, exit 2"
  reset_scn
  SCN_PRESTATE="comfy_up ollama_up web_up"   # no 'pulled': /api/tags lists nothing
  SETUP_FN=fixture_own_complete
  run_case verify_ollama_model_missing --check
  assert "gemma4:e4b is not present in Ollama"
  assert_rc 2
}

scn_refused_up_to_date() {   # F3
  echo "· plan refused on an UP TO DATE machine: nothing changed, exit 0 (the --check verdict)"
  reset_scn
  SCN_PRESTATE="comfy_up ollama_up web_up pulled"
  SETUP_FN=fixture_own_complete
  export INSTALL_ASSUME_TTY=1
  SCN_STDIN=$'n\n'
  run_case refused_up_to_date
  assert "Nothing was changed."
  assert_not_grep "$TMP/refused_up_to_date/trace" "compose up"
  assert_rc 0
}

fixture_foreign_healthy() { write_foreign_compose_yaml; fixture_all_models_present; }

scn_refused_foreign_ok() {   # F3
  echo "· plan refused on a healthy third-party-ComfyUI machine: same exit code as --check"
  reset_scn
  SCN_FOREIGN_COMFY=1
  SCN_PRESTATE="comfy_up takeover_up ollama_up web_up pulled"
  SETUP_FN=fixture_foreign_healthy
  run_case refused_foreign_ok_check --check
  local check_rc="$RC"
  export INSTALL_ASSUME_TTY=1
  SCN_STDIN=$'n\n'
  run_case refused_foreign_ok
  assert "FOREIGN COMFYUI"
  assert "Nothing was changed."
  assert_rc "$check_rc"
  assert_rc 0
}

fixture_foreign_broken_elsewhere() {   # the third-party stack lives in ~/stacks/comfy, not ~/comfyui-spark
  mkdir -p "$CASE_HOME/stacks/comfy/basedir/models/diffusion_models"
  printf 'services:\n  comfyui:\n    image: someoneelse/comfyui:latest\n' > "$CASE_HOME/stacks/comfy/docker-compose.yml"
  truncate -s 13141730784 "$CASE_HOME/stacks/comfy/basedir/models/diffusion_models/krea2_turbo_fp8_scaled.safetensors"
}

scn_takeover_elsewhere() {   # F5
  echo "· broken third-party ComfyUI whose compose file is in another directory: the takeover acts there"
  reset_scn
  local d="$TMP/takeover_elsewhere/home/stacks/comfy"
  SCN_FOREIGN_COMFY=1
  export SCN_FOREIGN_CFG="$d/docker-compose.yml" SCN_FOREIGN_BASEDIR="$d/basedir"
  SCN_PRESTATE=comfy_up
  SETUP_FN=fixture_foreign_broken_elsewhere
  run_case takeover_elsewhere --yes --skip-models
  assert "docker compose -p comfy -f $d/docker-compose.yml -f $d/docker-compose.override.yml up -d, in $d"
  assert "Take over this ComfyUI (project 'comfy', in $d)?"
  assert_grep "$d/docker-compose.override.yml" "BASE_DIRECTORY: /basedir"
  assert_grep "$TMP/takeover_elsewhere/trace" "compose -p comfy -f $d/docker-compose.yml -f $d/docker-compose.override.yml up -d"
  assert "ComfyUI now offers:"
  assert_no_file "$TMP/takeover_elsewhere/home/comfyui-spark"
  assert_rc 2   # --skip-models: the other models are still missing
}

scn_takeover_no_compose_label() {   # F5
  echo "· broken third-party ComfyUI started by a plain docker run: no takeover offered, even with --yes"
  reset_scn
  SCN_FOREIGN_COMFY=1
  export SCN_FOREIGN_CFG=""   # no compose label at all
  SCN_PRESTATE=comfy_up
  SETUP_FN=fixture_foreign_broken_comfy
  run_case takeover_no_compose_label --yes --skip-models
  assert "cannot be fixed automatically — see docs/TROUBLESHOOTING.md"
  assert_not "=== Third-party ComfyUI takeover ==="
  assert_no_file "$TMP/takeover_no_compose_label/home/comfyui-spark/compose.override.yaml"
  assert_not_grep "$TMP/takeover_no_compose_label/trace" "compose -p"
  assert_rc 2
}

scn_hf_token_valid_env() {   # F6
  echo "· valid HF_TOKEN in the environment: gated files fetched with it, docker never inherits it"
  reset_scn
  export HF_TOKEN=hf_VALIDENVTOKEN42 SCN_HF_VALID=hf_VALIDENVTOKEN42
  run_case hf_token_valid_env
  unset HF_TOKEN
  assert "Hugging Face token valid (user: stub-user)"
  assert_file "$TMP/hf_token_valid_env/state/curl_auth"
  assert_no_file "$TMP/hf_token_valid_env/state/docker_saw_hf_token"
  assert_not "hf_VALIDENVTOKEN42"
  assert_rc 0
}

fixture_empty_cache_saved_token() {   # an empty HF cache token in front of a valid saved one
  mkdir -p "$CASE_HOME/.cache/huggingface" "$CASE_HOME/.config/ai-content-studio"
  : > "$CASE_HOME/.cache/huggingface/token"
  printf 'hf_SAVEDTOKEN77\n' > "$CASE_HOME/.config/ai-content-studio/hf_token"
}

scn_hf_token_saved_behind_empty_cache() {   # F7
  echo "· empty ~/.cache/huggingface/token + a valid saved token: the saved token is used"
  reset_scn
  export SCN_HF_VALID=hf_SAVEDTOKEN77
  SETUP_FN=fixture_empty_cache_saved_token
  run_case hf_token_saved_behind_empty_cache
  assert "Hugging Face token valid (user: stub-user)"
  assert_not "No TTY: the Hugging Face token prompt is skipped"
  assert_file "$TMP/hf_token_saved_behind_empty_cache/state/curl_auth"
  assert_no_file "$TMP/hf_token_saved_behind_empty_cache/state/docker_saw_hf_token"
  assert_rc 0
}

fixture_empty_saved_token_644() {   # an existing, EMPTY, world-readable token file: skipped, then overwritten
  mkdir -p "$CASE_HOME/.config/ai-content-studio"
  : > "$CASE_HOME/.config/ai-content-studio/hf_token"; chmod 644 "$CASE_HOME/.config/ai-content-studio/hf_token"
}

scn_hf_token_prompt_saved_600() {   # F7
  echo "· token typed at the prompt and saved (y) over an existing 644 file: mode 600, never echoed"
  reset_scn
  export INSTALL_ASSUME_TTY=1 SCN_HF_VALID=hf_TYPEDTOKEN99
  SCN_STDIN=$'y\nhf_TYPEDTOKEN99\ny\n'
  SETUP_FN=fixture_empty_saved_token_644
  run_case hf_token_prompt_saved_600
  local f="$TMP/hf_token_prompt_saved_600/home/.config/ai-content-studio/hf_token"
  assert "token saved to"
  assert_grep "$f" "hf_TYPEDTOKEN99"
  if [ "$(stat -c %a "$f" 2>/dev/null)" = 600 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf '  FAIL: %s has mode %s, expected 600\n' "$f" "$(stat -c %a "$f" 2>/dev/null)"; fi
  assert_not "hf_TYPEDTOKEN99"
  assert_no_file "$TMP/hf_token_prompt_saved_600/state/docker_saw_hf_token"
}

fixture_legacy_duplicate() {   # one model both in the legacy repo folder and at its destination
  mkdir -p "$REPO_UNDER_TEST/comfyui/basedir/models/vae" "$CASE_HOME/comfyui-spark/basedir/models/vae"
  truncate -s 253806246 "$REPO_UNDER_TEST/comfyui/basedir/models/vae/qwen_image_vae.safetensors" \
                        "$CASE_HOME/comfyui-spark/basedir/models/vae/qwen_image_vae.safetensors"
}

scn_legacy_duplicate() {   # F8
  echo "· a legacy model already present at its destination: a duplicate, not OLD LAYOUT, left in both places"
  reset_scn
  SETUP_FN=fixture_legacy_duplicate
  run_case legacy_duplicate
  local legacy="$TMP/legacy_duplicate/repo/comfyui/basedir/models" dest="$TMP/legacy_duplicate/home/comfyui-spark/basedir/models"
  assert_not "OLD LAYOUT"
  assert "1 file(s) already present in $dest; the copy in $legacy is a duplicate you may delete yourself"
  assert_not "could not be moved"
  assert_file "$legacy/vae/qwen_image_vae.safetensors"
  assert_file "$dest/vae/qwen_image_vae.safetensors"
  assert_rc 0
}

fixture_legacy_one_dup_one_misplaced() {   # the duplicate above + one legacy file still to move
  fixture_legacy_duplicate
  mkdir -p "$REPO_UNDER_TEST/comfyui/basedir/models/loras"
  truncate -s 849608296 "$REPO_UNDER_TEST/comfyui/basedir/models/loras/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors"
}

scn_legacy_move_skips_duplicate() {   # F8
  echo "· legacy folder with one duplicate and one misplaced model: the latter moved, the duplicate reported, no root advice"
  reset_scn
  SETUP_FN=fixture_legacy_one_dup_one_misplaced
  run_case legacy_move_skips_duplicate
  local legacy="$TMP/legacy_move_skips_duplicate/repo/comfyui/basedir/models"
  assert "OLD LAYOUT"
  assert "moved: 1   left behind: 0"
  assert "is a duplicate you may delete yourself"
  assert_not "probably owned by root"
  assert_file "$legacy/vae/qwen_image_vae.safetensors"
  assert_file "$TMP/legacy_move_skips_duplicate/home/comfyui-spark/basedir/models/loras/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors"
  assert_rc 0
}

scn_uninstall_dry_run() {   # F9, F12
  echo "· --mode uninstall --dry-run: no install plan, would-lines only, volume sized without a container"
  reset_scn
  SCN_PRESTATE=web_up
  SCN_VOL_OLLAMA=1
  run_case uninstall_dry_run --mode uninstall --dry-run
  assert "would docker rm -f web-nginx"
  assert_not_grep "$TMP/uninstall_dry_run/trace" "docker rm -f"
  assert "ollama      66.4GB  volume 'ollama-data'"
  assert_not_grep "$TMP/uninstall_dry_run/trace" "docker run"
  assert_no_install_plan
  assert "Nothing was removed: this mode never removes anything."
  assert_rc 0
}

scn_foreign_dir_only_accepted() {   # F13c
  echo "· third-party compose.yaml only, start accepted (y y): started as announced, nothing of ours written there"
  reset_scn
  SETUP_FN=fixture_foreign_dir_only
  export INSTALL_ASSUME_TTY=1
  SCN_STDIN=$'y\ny\n'
  run_case foreign_dir_only_accepted --skip-models
  local d="$TMP/foreign_dir_only_accepted/home/comfyui-spark"
  assert_file "$TMP/foreign_dir_only_accepted/state/comfy_up"
  assert_no_file "$d/.env"
  assert_no_file "$d/userscripts_dir"
  assert_no_file "$d/run"
  assert_grep "$d/compose.yaml" 'WANTED_UID: "1000"'
}

scn_components_validated() {   # F13b
  echo "· --components with an unknown name: usage error listing the valid names, nothing run"
  reset_scn
  run_case components_validated --mode uninstall --yes --components web,comfy
  assert "valid names are web, updater, comfyui, ollama"
  assert_rc 1
  assert_not_grep "$TMP/components_validated/trace" "docker"
}

scn_smoke_without_python() {   # F13f
  echo "· --smoke without python3: announced as skipped in the plan, a warning, never a failure"
  reset_scn
  local d; mkdir -p "$TMP/nopy"   # the host PATH, every command but python3
  for d in ${PATH//:/ }; do [ -d "$d" ] && ln -s "$d"/* "$TMP/nopy/" 2>/dev/null; done
  rm -f "$TMP/nopy"/python3*
  export SCN_PATH="$TMP/nopy"
  SCN_PRESTATE="comfy_up ollama_up web_up pulled"
  SETUP_FN=fixture_own_complete
  run_case smoke_without_python --smoke
  assert "--smoke: skipped — python3 is not installed"
  assert "WARNING: --smoke skipped: python3 is not installed"
  assert_not "running a reduced real render"
  assert_rc 0
}

scn_uninstall_foreign_web_updater() {   # F10
  echo "· uninstall --yes --components web,updater: a foreign *-updater and a foreign app on :8090 are never removed"
  reset_scn
  SCN_PRESTATE=web_up
  SCN_FOREIGN_UPDATER=1   # canvas-ai-studio-updater, listed before ours by docker ps
  SCN_FOREIGN_WEB=1       # other-web publishes :8090
  run_case uninstall_foreign_web_updater --mode uninstall --yes --components web,updater
  assert_not_grep "$TMP/uninstall_foreign_web_updater/trace" "docker rm -f canvas-ai-studio-updater"
  assert_not_grep "$TMP/uninstall_foreign_web_updater/trace" "docker rm -f other-web"
  assert_grep "$TMP/uninstall_foreign_web_updater/trace" "docker rm -f web-updater"
  assert "NOT ours — will not be touched:"
  assert "  other-web "
  assert_no_install_plan
  assert_rc 0
}

ALL=(virgin legacy_containers legacy_models native_ollama_down native_ollama_starts stopped_container port_busy dry_run \
     plan_confirmed plan_refused legacy_down_migrated \
     takeover_accepted takeover_refused takeover_no_tty takeover_never_dumps_secrets \
     foreign_dir_only_refused \
     uninstall_no_tty uninstall_yes_components uninstall_interactive_mixed uninstall_never_touches_foreign \
     hf_prompt_not_needed_when_complete hf_prompt_shown_when_gated_missing \
     hf_token_never_logged_nor_in_argv \
     no_tty_silent_stdin \
     web_up_comfy_stopped web_up_comfy_absent up_to_date verify_ollama_model_missing \
     refused_up_to_date refused_foreign_ok takeover_elsewhere takeover_no_compose_label \
     hf_token_valid_env hf_token_saved_behind_empty_cache hf_token_prompt_saved_600 \
     legacy_duplicate legacy_move_skips_duplicate uninstall_dry_run uninstall_foreign_web_updater \
     foreign_dir_only_accepted components_validated smoke_without_python)
for s in "${@:-${ALL[@]}}"; do "scn_$s"; done
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
