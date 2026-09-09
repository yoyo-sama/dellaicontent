#!/usr/bin/env python3
"""Valide un graphe API ComfyUI par un rendu réel (pas seulement structurel).

Un job "success" ne prouve pas que le contenu est bon (cf. docs/LESSONS.md) —
ce script soumet réellement le graphe à ComfyUI, attend le rendu, et peut en
extraire frames + audio pour inspection humaine.

Usage:
    python3 tools/validate.py <graphe_api.json> [--reduce] [--frames 0,12,24]
        [--audio] [--timeout 600] [--image nom_fichier.png] [--fps 25] [--refresh]

Options:
    --reduce         Sur une COPIE du graphe : force length des
                      EmptyLTXVLatentVideo à 25, frames_number des
                      LTXVEmptyLatentAudio à 25, batch_size des Empty*LatentImage à 1.
    --frames I,J,K   Pour chaque .mp4 produit, extrait ces indices de frame
                      (ImageFromBatch + SaveImage) sous output/validate/.
    --audio          Pour chaque .mp4 produit, extrait la piste audio (SaveAudioMP3).
    --timeout N      Timeout de poll en secondes pour un rendu (défaut 600).
    --image NOM      Nom de fichier déjà présent dans input/, requis si le
                      graphe contient un placeholder {{IMAGE}}.
    --fps N          FPS utilisé pour calculer FRAMES = fps*duration+1 (défaut 25).
    --refresh        Force le rafraîchissement de tools/object_info.json.

La validation structurelle (class_type connus, liens intègres, modèles
présents sur disque) se fait AVANT toute soumission ; un échec structurel
sort en code 1 sans rien soumettre à ComfyUI.

Exit code 0 seulement si toutes les étapes exécutées réussissent.
"""
import argparse
import copy
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request

COMFY_URL = "http://localhost:8188"
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
OBJECT_INFO_PATH = os.path.join(TOOLS_DIR, "object_info.json")
COMFY_BASEDIR = os.environ.get("COMFY_BASEDIR", os.path.expanduser("~/comfyui-spark/basedir"))
MODELS_DIR = os.path.join(COMFY_BASEDIR, "models")
OUTPUT_DIR = os.path.join(COMFY_BASEDIR, "output")
INPUT_DIR = os.path.join(COMFY_BASEDIR, "input")

DEFAULT_PROMPT = "cinematic wide shot, golden hour lighting, subtle camera movement, film grain"
DEFAULT_NEGATIVE = "blurry, low quality"
DEFAULT_SEED = 42
DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 720
DEFAULT_BATCH = 1
DEFAULT_DURATION = 1
REDUCE_FRAMES = 25

STRING_PLACEHOLDERS = ("PROMPT", "NEGATIVE_PROMPT", "IMAGE")
NUMERIC_PLACEHOLDERS = ("SEED", "WIDTH", "HEIGHT", "BATCH", "DURATION", "FRAMES")


# ── util ──────────────────────────────────────────────────────────────

def human_size(n):
    for unit in ("o", "Ko", "Mo", "Go"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}To"


class Step:
    """Accumulates OK/FAIL results for the final recap."""

    def __init__(self):
        self.results = []

    def ok(self, label):
        self.results.append((label, True, None))
        print(f"[OK] {label}")

    def fail(self, label, detail=None):
        self.results.append((label, False, detail))
        print(f"[FAIL] {label}" + (f" — {detail}" if detail else ""))

    def all_ok(self):
        return all(ok for _, ok, _ in self.results)

    def recap(self):
        print("\n=== Récapitulatif ===")
        for label, ok, detail in self.results:
            mark = "OK  " if ok else "FAIL"
            print(f"  [{mark}] {label}")


# ── object_info ───────────────────────────────────────────────────────

def load_object_info(refresh=False):
    if refresh or not os.path.exists(OBJECT_INFO_PATH):
        print(f"Rafraîchissement de {OBJECT_INFO_PATH} depuis {COMFY_URL}/object_info ...")
        with urllib.request.urlopen(f"{COMFY_URL}/object_info", timeout=30) as r:
            data = r.read()
        with open(OBJECT_INFO_PATH, "wb") as f:
            f.write(data)
    with open(OBJECT_INFO_PATH) as f:
        return json.load(f)


# ── structural validation ────────────────────────────────────────────

def is_link(v):
    return (
        isinstance(v, list) and len(v) == 2
        and isinstance(v[0], str)
        and isinstance(v[1], int) and not isinstance(v[1], bool)
    )


def build_models_index():
    idx = set()
    for root, _dirs, files in os.walk(MODELS_DIR):
        for f in files:
            idx.add(f)
    return idx


def structural_validate(graph, object_info, models_index):
    errors = []
    node_ids = set(graph.keys())
    for node_id, node in graph.items():
        if not isinstance(node, dict) or "class_type" not in node:
            errors.append(f"nœud {node_id}: pas de class_type")
            continue
        ctype = node["class_type"]
        if ctype not in object_info:
            errors.append(
                f"nœud {node_id}: class_type '{ctype}' introuvable dans object_info "
                f"(nœud custom ? essayer --refresh)"
            )
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        for iname, ival in inputs.items():
            if is_link(ival):
                src_id = ival[0]
                if src_id not in node_ids:
                    errors.append(
                        f"nœud {node_id} ({ctype}).{iname}: lien vers un nœud inexistant '{src_id}'"
                    )
            elif isinstance(ival, str) and ival.endswith(".safetensors"):
                if os.path.basename(ival) not in models_index:
                    errors.append(
                        f"nœud {node_id} ({ctype}).{iname}: modèle introuvable sous "
                        f"{MODELS_DIR}: '{ival}'"
                    )
    return errors


# ── placeholder substitution ─────────────────────────────────────────

def substitute(raw_text, values):
    text = raw_text
    for name in STRING_PLACEHOLDERS:
        if name in values:
            token = '"{{' + name + '}}"'
            text = text.replace(token, json.dumps(values[name]))
    for name in NUMERIC_PLACEHOLDERS:
        if name in values:
            token = '"{{' + name + '}}"'
            text = text.replace(token, str(values[name]))
    return text


def leftover_placeholders(text):
    return sorted(set(re.findall(r"\{\{[A-Z_]+\}\}", text)))


# ── --reduce patch ────────────────────────────────────────────────────

def apply_reduce(graph):
    g = copy.deepcopy(graph)
    for node in g.values():
        ctype = node.get("class_type", "")
        inputs = node.get("inputs", {})
        if ctype == "EmptyLTXVLatentVideo" and "length" in inputs:
            inputs["length"] = REDUCE_FRAMES
        if ctype == "LTXVEmptyLatentAudio" and "frames_number" in inputs:
            inputs["frames_number"] = REDUCE_FRAMES
        if ctype.startswith("Empty") and ctype.endswith("LatentImage") and "batch_size" in inputs:
            inputs["batch_size"] = 1
    return g


# ── ComfyUI HTTP ──────────────────────────────────────────────────────

def post_prompt(graph, client_id="validate"):
    payload = json.dumps({"prompt": graph, "client_id": client_id}).encode()
    req = urllib.request.Request(
        f"{COMFY_URL}/prompt", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"raw": body.decode(errors="replace")}


def print_node_errors(resp):
    err = resp.get("error")
    if err:
        print(f"  Erreur: {err.get('message')} — {err.get('details', '')}")
    for node_id, info in resp.get("node_errors", {}).items():
        print(f"  nœud {node_id} ({info.get('class_type', '?')}):")
        for e in info.get("errors", []):
            print(f"    - {e.get('message')}: {e.get('details', '')}")
    if "raw" in resp:
        print(f"  {resp['raw']}")


def poll_history(prompt_id, timeout):
    deadline = time.time() + timeout
    while True:
        try:
            with urllib.request.urlopen(f"{COMFY_URL}/history/{prompt_id}", timeout=30) as r:
                hist = json.loads(r.read())
        except urllib.error.URLError as e:
            print(f"  (poll history: {e}, retry)")
            hist = {}
        entry = hist.get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("completed") or status.get("status_str") == "error":
                return entry
        if time.time() >= deadline:
            return None
        time.sleep(5)


def collect_outputs(entry):
    files = []
    for node_id, out in entry.get("outputs", {}).items():
        if not isinstance(out, dict):
            continue
        for key, items in out.items():
            if not isinstance(items, list):
                continue
            for it in items:
                if isinstance(it, dict) and "filename" in it:
                    files.append((node_id, key, it.get("subfolder", ""), it["filename"]))
    return files


def run_graph(step, label, graph, timeout):
    """Submit graph, poll until done. Returns history entry or None on failure."""
    status, resp = post_prompt(graph)
    if status != 200:
        step.fail(f"{label}: soumission /prompt", f"HTTP {status}")
        print_node_errors(resp)
        return None
    prompt_id = resp.get("prompt_id")
    if not prompt_id:
        step.fail(f"{label}: soumission /prompt", f"pas de prompt_id dans la réponse: {resp}")
        return None
    step.ok(f"{label}: soumis (prompt_id {prompt_id})")
    entry = poll_history(prompt_id, timeout)
    if entry is None:
        step.fail(f"{label}: rendu", f"timeout après {timeout}s (prompt_id {prompt_id})")
        return None
    status_info = entry.get("status", {})
    if status_info.get("status_str") == "error":
        step.fail(f"{label}: rendu", "status_str=error")
        for m in status_info.get("messages", []):
            print(f"    {m}")
        return None
    step.ok(f"{label}: rendu terminé")
    return entry


# ── frame/audio extraction ───────────────────────────────────────────

def build_frames_graph(video_filename, frame_indices, base):
    g = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": video_filename}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
    }
    for i, idx in enumerate(frame_indices):
        fid, sid = f"f{i}", f"s{i}"
        g[fid] = {
            "class_type": "ImageFromBatch",
            "inputs": {"image": ["2", 0], "batch_index": idx, "length": 1},
        }
        g[sid] = {
            "class_type": "SaveImage",
            "inputs": {"images": [fid, 0], "filename_prefix": f"validate/{base}_f{idx}"},
        }
    return g


def build_audio_graph(video_filename, base):
    return {
        "1": {"class_type": "LoadVideo", "inputs": {"file": video_filename}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
        "audio_out": {
            "class_type": "SaveAudioMP3",
            "inputs": {"audio": ["2", 1], "filename_prefix": f"validate/{base}_audio", "quality": "V0"},
        },
    }


def inspect_videos(step, mp4s, frame_indices, want_audio, timeout):
    # Frames and audio are submitted as SEPARATE prompts: ComfyUI aborts a whole
    # prompt (and drops ALL its outputs) if any single node errors, so bundling
    # both in one job would let a missing audio track wipe out good frames.
    for n, (node_id, key, subfolder, filename) in enumerate(mp4s):
        src = os.path.join(OUTPUT_DIR, subfolder, filename)
        if not os.path.exists(src):
            step.fail(f"inspection {filename}", f"fichier introuvable: {src}")
            continue
        copy_name = f"_validate_{n}.mp4"
        dst = os.path.join(INPUT_DIR, copy_name)
        shutil.copyfile(src, dst)
        base = re.sub(r"[^A-Za-z0-9_-]", "_", os.path.splitext(filename)[0])
        try:
            if frame_indices:
                graph = build_frames_graph(copy_name, frame_indices, base)
                entry = run_graph(step, f"{filename}: extraction frames", graph, timeout)
                if entry is not None:
                    for _nid, key2, subf2, fn2 in collect_outputs(entry):
                        print(f"    frame extraite: {os.path.join(OUTPUT_DIR, subf2, fn2)}")
                    step.ok(f"{filename}: frames extraites sous {OUTPUT_DIR}/validate/")
            if want_audio:
                graph = build_audio_graph(copy_name, base)
                entry = run_graph(step, f"{filename}: extraction audio", graph, timeout)
                if entry is not None:
                    out_files = collect_outputs(entry)
                    if not out_files:
                        step.fail(f"{filename}: piste audio", "aucun fichier audio produit")
                    for _nid, key2, subf2, fn2 in out_files:
                        path = os.path.join(OUTPUT_DIR, subf2, fn2)
                        size = os.path.getsize(path) if os.path.exists(path) else 0
                        print(f"    audio extrait: {path} ({human_size(size)})")
                        if size < 5000:
                            step.fail(f"{filename}: piste audio", f"{human_size(size)} — probablement du silence")
                        else:
                            step.ok(f"{filename}: piste audio ({human_size(size)})")
        finally:
            if os.path.exists(dst):
                os.remove(dst)


# ── main ──────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="Valide un graphe API ComfyUI par un rendu réel.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("graph", help="chemin du graphe API JSON")
    p.add_argument("--reduce", action="store_true", help="réduit vidéo/latents pour un test rapide")
    p.add_argument("--frames", default=None, help="indices de frames à extraire, ex: 0,12,24")
    p.add_argument("--audio", action="store_true", help="extrait aussi la piste audio")
    p.add_argument("--timeout", type=int, default=600, help="timeout de poll en secondes (défaut 600)")
    p.add_argument("--image", default=None, help="nom de fichier dans input/ pour {{IMAGE}}")
    p.add_argument("--fps", type=int, default=25, help="fps pour FRAMES = fps*duration+1 (défaut 25)")
    p.add_argument("--refresh", action="store_true", help="force le rafraîchissement de object_info.json")
    return p.parse_args()


def main():
    args = parse_args()
    step = Step()

    if not os.path.exists(args.graph):
        print(f"Fichier introuvable: {args.graph}", file=sys.stderr)
        return 1

    with open(args.graph) as f:
        raw_text = f.read()
    try:
        graph = json.loads(raw_text)
    except json.JSONDecodeError as e:
        print(f"JSON invalide dans {args.graph}: {e}", file=sys.stderr)
        return 1

    # 1. structural validation (before any submission)
    object_info = load_object_info(refresh=args.refresh)
    models_index = build_models_index()
    errors = structural_validate(graph, object_info, models_index)
    if errors:
        step.fail("validation structurelle", f"{len(errors)} erreur(s)")
        for e in errors:
            print(f"  - {e}")
        step.recap()
        return 1
    step.ok("validation structurelle")

    # 2. placeholder substitution
    needs_image = '"{{IMAGE}}"' in raw_text
    if needs_image and not args.image:
        step.fail("substitution placeholders", "graphe contient {{IMAGE}} mais --image n'a pas été fourni")
        step.recap()
        return 1

    values = {
        "PROMPT": DEFAULT_PROMPT,
        "NEGATIVE_PROMPT": DEFAULT_NEGATIVE,
        "SEED": DEFAULT_SEED,
        "WIDTH": DEFAULT_WIDTH,
        "HEIGHT": DEFAULT_HEIGHT,
        "BATCH": DEFAULT_BATCH,
        "DURATION": DEFAULT_DURATION,
        "FRAMES": args.fps * DEFAULT_DURATION + 1,
    }
    if args.image:
        values["IMAGE"] = args.image

    substituted_text = substitute(raw_text, values)
    leftover = leftover_placeholders(substituted_text)
    if leftover:
        step.fail("substitution placeholders", f"placeholders non substitués: {', '.join(leftover)}")
        step.recap()
        return 1
    step.ok("substitution placeholders")

    try:
        final_graph = json.loads(substituted_text)
    except json.JSONDecodeError as e:
        step.fail("substitution placeholders", f"JSON invalide après substitution: {e}")
        step.recap()
        return 1

    if args.reduce:
        final_graph = apply_reduce(final_graph)
        step.ok(f"--reduce appliqué (length/frames_number={REDUCE_FRAMES}, batch_size=1)")

    # 3. submit + poll
    entry = run_graph(step, "rendu principal", final_graph, args.timeout)
    if entry is None:
        step.recap()
        return 1

    out_files = collect_outputs(entry)
    if not out_files:
        step.fail("sorties du rendu principal", "aucun fichier de sortie trouvé dans l'historique")
    else:
        print("  Fichiers produits:")
        for _nid, key, subfolder, filename in out_files:
            print(f"    {key}: {subfolder}/{filename}")
        step.ok(f"{len(out_files)} fichier(s) de sortie")

    # 4. frame/audio inspection
    if args.frames or args.audio:
        mp4s = [f for f in out_files if f[3].lower().endswith(".mp4")]
        if not mp4s:
            print("  Aucune vidéo .mp4 produite — inspection frames/audio ignorée.")
        else:
            frame_indices = [int(x) for x in args.frames.split(",")] if args.frames else []
            inspect_videos(step, mp4s, frame_indices, args.audio, args.timeout)

    step.recap()
    return 0 if step.all_ok() else 1


if __name__ == "__main__":
    sys.exit(main())
