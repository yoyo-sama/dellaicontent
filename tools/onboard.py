#!/usr/bin/env python3
"""Onboards a ComfyUI UI workflow (drag-drop export) as a studio API template.

Converts the workflow, injects the {{PROMPT}}, {{NEGATIVE_PROMPT}}, {{SEED}}, {{WIDTH}},
{{HEIGHT}}, {{BATCH}}, {{FRAMES}} and {{IMAGE}} placeholders in the right places, checks
that the referenced models exist, writes workflows/api/<id>.json and adds the matching
entry to workflows/manifest.json.

Usage:
    python3 tools/onboard.py <workflow_ui.json> --id <id> --label "<label>" \\
        --pipeline <pipeline> --model "<model name>" \\
        [--fps N] [--enrich builtin] [--dry-run] [--no-test] [--yes] \\
        [--image file_name_in_input]

Options:
    --fps N       Added as is to the manifest entry when given.
    --enrich builtin  Added as is to the manifest entry when given.
    --dry-run     Writes nothing (neither workflows/api/ nor manifest.json); prints
                  everything it would have done.
    --no-test     Does not call tools/validate.py after writing.
    --yes         Asks no interactive question when positive-prompt candidates are
                  ambiguous (keeps every detected candidate).
    --image NAME  File already present in input/, used when --no-test is not passed and
                  the graph contains {{IMAGE}}.

Steps: (1) refresh tools/object_info.json; (2) convert the UI workflow into an API graph
through tools/convert.py; (3) inject the placeholders; (4) check the referenced
.safetensors (exit 1 if one is missing); (5) write workflows/api/<id>.json; (6) update
workflows/manifest.json (refuses if the id already exists); (7) unless --no-test, run
tools/validate.py --reduce on the written file and relay its exit code.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(TOOLS_DIR)
OBJECT_INFO_PATH = os.path.join(TOOLS_DIR, "object_info.json")
VALIDATE_PY = os.path.join(TOOLS_DIR, "validate.py")
MANIFEST_PATH = os.path.join(ROOT_DIR, "workflows", "manifest.json")
API_DIR = os.path.join(ROOT_DIR, "workflows", "api")
COMFY_BASEDIR = os.environ.get("COMFY_BASEDIR", os.path.expanduser("~/comfyui-spark/basedir"))
MODELS_DIR = os.path.join(COMFY_BASEDIR, "models")
INPUT_DIR = os.path.join(COMFY_BASEDIR, "input")
COMFY_URL = "http://localhost:8188"

TEXT_FIELDS = ("text", "prompt")
PRIMITIVE_STRING_TYPES = ("PrimitiveStringMultiline", "PrimitiveString")
TEXTGEN_TYPES = ("TextGenerateLTX2Prompt", "TextGenerate")


# ── object_info ───────────────────────────────────────────────────────

def refresh_object_info():
    print(f"Refreshing {OBJECT_INFO_PATH} from {COMFY_URL}/object_info ...")
    try:
        with urllib.request.urlopen(f"{COMFY_URL}/object_info", timeout=30) as r:
            data = r.read()
        with open(OBJECT_INFO_PATH, "wb") as f:
            f.write(data)
    except (urllib.error.URLError, OSError) as e:
        if os.path.exists(OBJECT_INFO_PATH):
            print(f"  WARN: refresh failed ({e}) — using the existing file")
        else:
            print(f"ERROR: refresh failed ({e}) and {OBJECT_INFO_PATH} does not exist", file=sys.stderr)
            sys.exit(1)


# ── link / graph helpers ─────────────────────────────────────────────

def is_link(v):
    return (
        isinstance(v, list) and len(v) == 2
        and isinstance(v[0], str)
        and isinstance(v[1], int) and not isinstance(v[1], bool)
    )


def resolve_leaf(api, start_id, want):
    """Walk conditioning-passthrough nodes from start_id until a text-bearing
    leaf (a node with a 'text' or 'prompt' input) is found."""
    visited = set()
    node_id = start_id
    while True:
        if node_id in visited or node_id not in api:
            return None
        visited.add(node_id)
        node = api[node_id]
        inputs = node.get("inputs", {})
        for f in TEXT_FIELDS:
            if f in inputs:
                return (node_id, node["class_type"], f)
        nxt = None
        for cand in (want, "conditioning"):
            v = inputs.get(cand)
            if is_link(v):
                nxt = v[0]
                break
        if nxt is None:
            return None
        node_id = nxt


def find_injection_target(api, node_id, field, visited=None):
    """Given a text-bearing leaf's field, resolve where the placeholder
    should actually be written: the field itself if literal/unconnected,
    the 'value' of a PrimitiveString(Multiline) it's linked to, or (recursively)
    the 'prompt' of a TextGenerate* node upstream (per project convention:
    prompt-enhancer nodes own the user prompt, not the CLIPTextEncode)."""
    visited = visited if visited is not None else set()
    if node_id in visited:
        return (node_id, field)
    visited.add(node_id)
    node = api.get(node_id)
    if node is None:
        return (node_id, field)
    val = node.get("inputs", {}).get(field)
    if not is_link(val):
        return (node_id, field)
    src_id = val[0]
    src = api.get(src_id)
    if src is None:
        return (node_id, field)
    sctype = src["class_type"]
    if sctype in PRIMITIVE_STRING_TYPES:
        return (src_id, "value")
    if sctype in TEXTGEN_TYPES:
        return find_injection_target(api, src_id, "prompt", visited)
    # Unresolvable intermediate (unknown node) -- fall back to overwriting
    # the leaf's own field directly (breaks the link, but stays correct).
    return (node_id, field)


def collect_prompt_candidates(api):
    pos_entries, neg_entries = [], []
    for node in api.values():
        inputs = node.get("inputs", {})
        if is_link(inputs.get("positive")):
            pos_entries.append(inputs["positive"][0])
        if is_link(inputs.get("negative")):
            neg_entries.append(inputs["negative"][0])
    pos_leaves, neg_leaves = {}, {}
    for src in pos_entries:
        r = resolve_leaf(api, src, "positive")
        if r:
            pos_leaves[r[0]] = r
    for src in neg_entries:
        r = resolve_leaf(api, src, "negative")
        if r:
            neg_leaves[r[0]] = r
    return pos_leaves, neg_leaves


def excerpt_of(api, leaf_id, field):
    val = api[leaf_id].get("inputs", {}).get(field)
    return val[:80] if isinstance(val, str) else f"(lien -> {val})"


def inject_prompts(api, yes, log):
    pos_leaves, neg_leaves = collect_prompt_candidates(api)
    if not pos_leaves:
        log.append("WARN: no positive text node detected -- {{PROMPT}} not injected")
    chosen = pos_leaves
    if len(pos_leaves) > 1:
        items = list(pos_leaves.items())
        print(f"Several positive candidates detected ({len(items)}):")
        for i, (leaf_id, (_id, ctype, field)) in enumerate(items):
            print(f"  [{i}] node {leaf_id} ({ctype}).{field}: {excerpt_of(api, leaf_id, field)!r}")
        if not yes:
            try:
                sel = input("Indices to keep, comma-separated (Enter = all): ").strip()
            except EOFError:
                sel = ""
            if sel:
                idxs = {int(x) for x in sel.split(",")}
                chosen = {leaf_id: v for i, (leaf_id, v) in enumerate(items) if i in idxs}

    injected_leaf_ids = set()
    for leaf_id, ctype, field in chosen.values():
        target_id, target_field = find_injection_target(api, leaf_id, field)
        api[target_id]["inputs"][target_field] = "{{PROMPT}}"
        injected_leaf_ids.add(leaf_id)
        log.append(f"PROMPT -> node {target_id} ({api[target_id]['class_type']}).{target_field} "
                    f"(source: {leaf_id}/{ctype}.{field})")

    for leaf_id, ctype, field in neg_leaves.values():
        if leaf_id in injected_leaf_ids:
            # negative resolves to the SAME node as positive (e.g. ConditioningZeroOut(positive)):
            # no separate negative text exists, nothing to inject.
            continue
        target_id, target_field = find_injection_target(api, leaf_id, field)
        api[target_id]["inputs"][target_field] = "{{NEGATIVE_PROMPT}}"
        log.append(f"NEGATIVE_PROMPT -> node {target_id} ({api[target_id]['class_type']}).{target_field} "
                    f"(source: {leaf_id}/{ctype}.{field})")


def inject_seeds(api, log):
    for node_id, node in api.items():
        inputs = node.get("inputs", {})
        for k in list(inputs.keys()):
            if k == "seed" or k == "noise_seed" or k.endswith(".seed"):
                inputs[k] = "{{SEED}}"
                log.append(f"SEED -> node {node_id} ({node['class_type']}).{k}")


def inject_dimensions(api, log):
    for node_id, node in api.items():
        ctype = node.get("class_type", "")
        inputs = node.get("inputs", {})
        if ctype.startswith("Empty") and "Latent" in ctype:
            is_video = "Video" in ctype
            fields = [("width", "{{WIDTH}}"), ("height", "{{HEIGHT}}"), ("batch_size", "{{BATCH}}")]
            if is_video:
                fields.append(("length", "{{FRAMES}}"))
            for field, ph in fields:
                if field in inputs:
                    inputs[field] = ph
                    log.append(f"{ph} -> node {node_id} ({ctype}).{field}")
        if ctype == "LTXVEmptyLatentAudio" and "frames_number" in inputs:
            inputs["frames_number"] = "{{FRAMES}}"
            log.append(f"{{{{FRAMES}}}} -> node {node_id} ({ctype}).frames_number")


def inject_images(api, pipeline, log):
    if "image2" not in pipeline and "outpaint" not in pipeline:
        return
    nodes = [n for n in api.items() if n[1].get("class_type") == "LoadImage" and "image" in n[1].get("inputs", {})]
    if not nodes:
        log.append("WARN: image2*/outpaint pipeline but no LoadImage node found")
        return
    if len(nodes) > 1:
        log.append(f"WARN: {len(nodes)} LoadImage nodes found -- {{{{IMAGE}}}} injected in all of them "
                    f"(ids: {', '.join(n[0] for n in nodes)})")
    for node_id, node in nodes:
        old = node["inputs"]["image"]
        node["inputs"]["image"] = "{{IMAGE}}"
        log.append(f"IMAGE -> node {node_id} (LoadImage).image (was: {old!r})")


# ── model existence check ────────────────────────────────────────────

def build_models_index():
    idx = set()
    for root, _dirs, files in os.walk(MODELS_DIR):
        for f in files:
            idx.add(f)
    return idx


def check_safetensors(api, models_index):
    missing = []
    for node_id, node in api.items():
        for iname, ival in node.get("inputs", {}).items():
            if isinstance(ival, str) and ival.endswith(".safetensors"):
                if os.path.basename(ival) not in models_index:
                    missing.append((node_id, node.get("class_type"), iname, ival))
    return missing


# ── manifest ──────────────────────────────────────────────────────────

def load_manifest():
    with open(MANIFEST_PATH) as f:
        return json.load(f)


def manifest_has_id(manifest, wf_id):
    return any(w.get("id") == wf_id for w in manifest.get("workflows", []))


# ── main ──────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="Onboards a ComfyUI UI workflow as a studio API template.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("workflow", help="path to the ComfyUI UI workflow (drag-drop export)")
    p.add_argument("--id", required=True)
    p.add_argument("--label", required=True)
    p.add_argument("--pipeline", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--fps", type=int, default=None)
    p.add_argument("--enrich", default=None, choices=["builtin"])
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--no-test", action="store_true")
    p.add_argument("--yes", action="store_true", help="no interactive question when ambiguous")
    p.add_argument("--image", default=None, help="file in input/ for the self-test when {{IMAGE}} is present")
    return p.parse_args()


def main():
    args = parse_args()

    if not os.path.exists(args.workflow):
        print(f"File not found: {args.workflow}", file=sys.stderr)
        return 1

    if os.path.exists(MANIFEST_PATH):
        manifest = load_manifest()
        if manifest_has_id(manifest, args.id):
            print(f"ERROR: id '{args.id}' already exists in {MANIFEST_PATH}", file=sys.stderr)
            return 1
    else:
        print(f"ERROR: manifest not found: {MANIFEST_PATH}", file=sys.stderr)
        return 1

    # (1) refresh object_info.json
    refresh_object_info()

    # (2) convert UI -> API
    sys.path.insert(0, TOOLS_DIR)
    import convert  # noqa: E402  (reads OBJECT_INFO from disk at import time)

    try:
        api, warnings = convert.convert_file(args.workflow)
    except Exception as e:
        print(f"ERROR: UI->API conversion failed: {e}", file=sys.stderr)
        return 1
    print(f"Conversion: {len(api)} nodes, {len(warnings)} converter warning(s).")

    # (3) inject placeholders
    log = []
    inject_prompts(api, args.yes, log)
    inject_seeds(api, log)
    inject_dimensions(api, log)
    inject_images(api, args.pipeline, log)

    print("\nInjected placeholders:")
    for line in log:
        print(f"  {line}")

    # (4) verify safetensors
    models_index = build_models_index()
    missing = check_safetensors(api, models_index)
    if missing:
        print(f"\nERROR: {len(missing)} model(s) not found under {MODELS_DIR}:", file=sys.stderr)
        for node_id, ctype, iname, val in missing:
            print(f"  node {node_id} ({ctype}).{iname}: {val}", file=sys.stderr)
        return 1
    print(f"\n{len(models_index)} files indexed under {MODELS_DIR} -- every referenced .safetensors exists.")

    out_path = os.path.join(API_DIR, f"{args.id}.json")
    manifest_entry = {
        "id": args.id,
        "label": args.label,
        "pipeline": args.pipeline,
        "model": args.model,
        "file": f"api/{args.id}.json",
    }
    if args.enrich:
        manifest_entry["enrich"] = args.enrich
    if args.fps is not None:
        manifest_entry["fps"] = args.fps

    if args.dry_run:
        print(f"\n--dry-run: nothing was written. Would have written {out_path} and added to {MANIFEST_PATH}:")
        print(json.dumps(manifest_entry, indent=2, ensure_ascii=False))
        return 0

    # (5) write api file
    with open(out_path, "w") as f:
        json.dump(api, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"\nÉcrit: {out_path}")

    # (6) update manifest
    manifest["workflows"].append(manifest_entry)
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"Manifest updated: {MANIFEST_PATH} (+{args.id})")

    # (7) test
    if args.no_test:
        return 0
    needs_image = '"{{IMAGE}}"' in json.dumps(api)
    cmd = [sys.executable, VALIDATE_PY, out_path, "--reduce"]
    if needs_image:
        image_name = args.image
        if not image_name:
            for fn in sorted(os.listdir(INPUT_DIR)):
                if fn.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                    image_name = fn
                    break
        if not image_name:
            print("ERROR: the graph contains {{IMAGE}} but no test image is available "
                  "(--image, or a file in input/)", file=sys.stderr)
            return 1
        cmd += ["--image", image_name]
    print(f"\nLancement: {' '.join(cmd)}")
    result = subprocess.run(cmd)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
