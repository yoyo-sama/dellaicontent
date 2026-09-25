"""Gallery service (docs/GALERIE.md, Contrat C3-C6, read routes only).

Indexes the ComfyUI output folder into SQLite/FTS5 and serves it read-only. It never contacts
ComfyUI: there is no network client in this file (only http.server + urllib.parse for URLs).
`python3 server.py --check` runs the self-tests (no DB, no port).
"""
import base64
import datetime
import hashlib
import io
import json
import os
import re
import signal
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

from PIL import Image

ROOT = os.path.normpath(os.environ.get("OUTPUT_DIR", "/output"))
DATA = os.environ.get("DATA_DIR", "/data")
PORT = int(os.environ.get("PORT", "8094"))
SCAN_INTERVAL = float(os.environ.get("SCAN_INTERVAL", "60"))

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp"}
VID_EXT = {".mp4", ".webm", ".mov"}
FRESH_S = 5  # a file younger than this may still be written: the next pass takes it
PNG_SIG = b"\x89PNG\r\n\x1a\n"

PIPELINES = [(re.compile(r), p) for r, p in [
    (r"^studio/(story|relay)/", "storyboard_v2"),
    (r"^(studio/)?campaign/", "campaign_full"),
    (r"^studio/sequence_", "sequence2video"),
    (r"^studio/minimax_h3_r2v_", "reference2video"),
    (r"^studio/((ltx25|minimax_h3)_i2v|ltx25_flf2v)_", "image2video"),
    (r"^studio/(ltx25|minimax_h3)_t2v_", "text2video"),
    (r"^studio/(edit|qwen21_i2i|market_[a-z]+)_", "image2image"),
    (r"^studio/(krea2|qwen21_t2i|flux2|ernie|zimage)_", "text2image"),
    (r"^canvas/", "canvas"),
]]
APP_IN = re.compile(r"^(studio|canvas|campaign|storyboard|localized|video)/|^ai_studio_")
APP_OUT = re.compile(r"^studio/(lot1|lotA|q21|inspect)/|^studio/lot\d")
COUNTER = re.compile(r"_\d{5}_?\.\w+$")

PROMPT_CLASSES = {"CLIPTextEncode", "PrimitiveStringMultiline", "PrimitiveString", "TextGenerateLTX2Prompt",
                  "TextEncodeQwenImage21", "TextEncodeQwenImageEditPlus"}
TEXT_SKIP_KEYS = {"filename_prefix", "attention", "sigmas", "image", "video", "audio"}
TEXT_SKIP_END = (".safetensors", ".gguf", ".pt", ".png", ".jpg", ".mp4", ".webp")
MODEL_EXT = re.compile(r"\.(safetensors|gguf|ckpt|pt|pth|bin)$")

# ponytail: verrou global, un pool si la charge l'exige
LOCK = threading.RLock()
db = None
THUMB_SEM = threading.Semaphore(4)
STATE = {"scanning": True, "last": None, "secs": 0.0, "warning": None}
SCHEMA = """
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('image','video')),
  mtime INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL,
  w INTEGER, h INTEGER, duration REAL, prompt TEXT, texts TEXT, prefix TEXT, pipeline TEXT, model TEXT,
  loras TEXT NOT NULL DEFAULT '[]', seed INTEGER, app INTEGER NOT NULL DEFAULT 0,
  meta_ok INTEGER NOT NULL DEFAULT 1, fav INTEGER NOT NULL DEFAULT 0, trashed_at INTEGER, orig_key TEXT);
CREATE INDEX IF NOT EXISTS assets_list  ON assets (trashed_at, type, mtime DESC, key DESC);
CREATE INDEX IF NOT EXISTS assets_pipe  ON assets (pipeline);
CREATE INDEX IF NOT EXISTS assets_model ON assets (model);
CREATE INDEX IF NOT EXISTS assets_fav   ON assets (fav) WHERE fav = 1;
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (asset_id, tag_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS asset_tags_tag ON asset_tags (tag_id);
CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
  prompt, texts, key, model, tokenize = 'unicode61 remove_diacritics 2');
PRAGMA user_version = 1;
"""


class Err(Exception):
    def __init__(self, status, code, detail):
        self.status, self.code, self.detail = status, code, detail


def bad(detail):
    return Err(400, "bad_request", detail)


# ── Keys (C6) ────────────────────────────────────────────────────────────────

def safe_path(key, allow_trash=False):
    """Absolute path for a valid key with no symlink on the way, else None."""
    if not isinstance(key, str) or not 1 <= len(key) <= 1024 or "\0" in key or "\\" in key or key[0] == "/":
        return None
    try:
        key.encode("utf-8")
    except UnicodeEncodeError:
        return None
    segs = key.split("/")
    for i, s in enumerate(segs):
        if s in ("", ".", "..") or (s[0] == "." and not (allow_trash and i == 0 and s == ".trash")):
            return None
    if os.path.splitext(key)[1].lower() not in IMG_EXT | VID_EXT:
        return None
    p = os.path.join(ROOT, key)
    if os.path.realpath(p) != os.path.normpath(os.path.join(os.path.realpath(ROOT), key)):
        return None
    return p


def prefix_of(key):
    return COUNTER.sub("", key) if COUNTER.search(key) else os.path.splitext(key)[0]


def pipeline_of(key):
    return next((p for r, p in PIPELINES if r.search(key)), None)


def is_app(key):
    return bool(APP_IN.search(key) and not APP_OUT.search(key))


# ── Extraction (C5) ──────────────────────────────────────────────────────────

def png_prompt(p):
    """Graph JSON of the `prompt` tEXt chunk (read before IDAT), None if absent; raises if damaged."""
    with open(p, "rb") as f:
        if f.read(8) != PNG_SIG:
            raise ValueError("not a png")
        while True:
            head = f.read(8)
            if len(head) < 8:
                raise ValueError("truncated png")
            n, t = struct.unpack(">I4s", head)
            if t in (b"IDAT", b"IEND"):
                return None
            if t == b"tEXt" and n < 1 << 24:
                d = f.read(n)
                if len(d) < n:
                    raise ValueError("truncated chunk")
                k, _, v = d.partition(b"\0")
                if k == b"prompt":
                    return json.loads(v.decode("latin-1"))
                f.seek(4, 1)
            else:
                f.seek(n + 4, 1)


def probe(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", p],
                       capture_output=True, timeout=20)
    if r.returncode:
        raise ValueError("ffprobe failed")
    d = json.loads(r.stdout)
    v = next(s for s in d["streams"] if s.get("codec_type") == "video")
    fmt = d.get("format") or {}
    tags = {k.lower(): x for k, x in (fmt.get("tags") or {}).items()}
    graph = json.loads(tags["prompt"]) if "prompt" in tags else None
    dur = fmt.get("duration")
    return graph, v.get("width"), v.get("height"), float(dur) if dur else None


def graph_meta(g, prefix):
    """prompt / model / loras / seed / texts from an API graph, walking upstream of the save nodes."""
    if not isinstance(g, dict):
        raise ValueError("graph")
    nodes = {k: n for k, n in g.items() if isinstance(n, dict)}

    def ins(n):
        return n["inputs"] if isinstance(n.get("inputs"), dict) else {}

    def first(n, keys):
        return next((ins(n)[k] for k in keys if ins(n).get(k) is not None), None)

    starts = [k for k, n in nodes.items() if ins(n).get("filename_prefix") == prefix] \
        or [k for k, n in nodes.items() if "filename_prefix" in ins(n)]
    order, seen, stack = [], set(), starts[::-1]
    while stack:
        i = stack.pop()
        if i in seen or i not in nodes:
            continue
        seen.add(i)
        order.append(i)
        # The input of a TextGenerate is an LLM instruction, not the image prompt (it stays in `texts`).
        if nodes[i].get("class_type") == "TextGenerate":
            continue
        # The sampler's `negative` branch is not the prompt either (the longest text would often be the negative one).
        links = [v[0] for k, v in ins(nodes[i]).items()
                 if k != "negative" and isinstance(v, list) and len(v) == 2 and isinstance(v[0], str)]
        stack.extend(links[::-1])

    prompts, unet, ckpt, loras, seed = [], None, None, [], None
    for i in order:
        n = nodes[i]
        c, x = n.get("class_type") or "", ins(n)
        if c in PROMPT_CLASSES:
            t = first(n, ("text", "value", "prompt"))
            if isinstance(t, list) and t and t[0] in nodes:
                t = first(nodes[t[0]], ("value", "text", "prompt"))
            if isinstance(t, str) and t.strip():
                prompts.append(t.strip())
        if c == "UNETLoader" and unet is None and isinstance(x.get("unet_name"), str):
            unet = x["unet_name"]
        if c == "CheckpointLoaderSimple" and ckpt is None and isinstance(x.get("ckpt_name"), str):
            ckpt = x["ckpt_name"]
        if c.startswith("LoraLoader") and isinstance(x.get("lora_name"), str):
            name = MODEL_EXT.sub("", x["lora_name"])
            if name not in loras:
                loras.append(name)
        for k in ("seed", "noise_seed") if seed is None else ():
            s = x.get(k)
            if isinstance(s, list) and len(s) == 2 and s[0] in nodes and nodes[s[0]].get("class_type", "").startswith("Primitive"):
                s = ins(nodes[s[0]]).get("value")
            if type(s) is int:
                seed = s
                break
    texts = []
    for n in nodes.values():
        for k, v in ins(n).items():
            if (isinstance(v, str) and len(v) >= 20 and k not in TEXT_SKIP_KEYS and not k.endswith("_name")
                    and not v.lower().endswith(TEXT_SKIP_END) and v not in texts):
                texts.append(v)
    model = unet or ckpt
    return {"prompt": max(prompts, key=len, default=None), "texts": "\n".join(texts) or None,
            "model": MODEL_EXT.sub("", model) if model else None, "loras": loras, "seed": seed}


def extract(p, key, typ):
    m = {"w": None, "h": None, "duration": None, "prompt": None, "texts": None, "model": None,
         "loras": [], "seed": None, "meta_ok": 1}
    try:
        if typ == "image":
            with Image.open(p) as im:
                m["w"], m["h"] = im.size
            graph = png_prompt(p) if p.lower().endswith(".png") else None
        else:
            graph, m["w"], m["h"], m["duration"] = probe(p)
        if graph is not None:
            m.update(graph_meta(graph, prefix_of(key)))
    except Exception:  # damaged file: listed anyway, not retried until (mtime_ns, size) changes
        m["meta_ok"] = 0
    return m


# ── Index ────────────────────────────────────────────────────────────────────

def type_of(key):
    return "image" if os.path.splitext(key)[1].lower() in IMG_EXT else "video"


def upsert(key, st, m):
    v = (type_of(key), st.st_mtime_ns // 1_000_000, st.st_mtime_ns, st.st_size, m["w"], m["h"], m["duration"],
         m["prompt"], m["texts"], prefix_of(key), pipeline_of(key), m["model"], json.dumps(m["loras"]), m["seed"],
         int(is_app(key)), m["meta_ok"])
    cols = "type,mtime,mtime_ns,size,w,h,duration,prompt,texts,prefix,pipeline,model,loras,seed,app,meta_ok"
    with LOCK:
        db.execute("BEGIN")
        try:
            r = db.execute("SELECT id FROM assets WHERE key=?", (key,)).fetchone()
            if r:
                i = r["id"]
                db.execute("UPDATE assets SET " + ",".join(c + "=?" for c in cols.split(",")) + " WHERE id=?", v + (i,))
                db.execute("DELETE FROM assets_fts WHERE rowid=?", (i,))
            else:
                i = db.execute("INSERT INTO assets (key," + cols + ") VALUES (?" + ",?" * 16 + ")", (key,) + v).lastrowid
            db.execute("INSERT INTO assets_fts (rowid,prompt,texts,key,model) VALUES (?,?,?,?,?)",
                       (i, m["prompt"], m["texts"], key, m["model"]))
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise


def index_file(key, p, st):
    """Extract outside the lock, then upsert under it after a new stat. False if the file moved meanwhile."""
    m = extract(p, key, type_of(key))
    with LOCK:
        st2 = os.lstat(p)
        if (st2.st_mtime_ns, st2.st_size) != (st.st_mtime_ns, st.st_size):
            return False
        upsert(key, st2, m)
    return True


def delete_rows(ids):
    with LOCK:
        db.execute("BEGIN")
        for i in ids:
            db.execute("DELETE FROM assets_fts WHERE rowid=?", (i,))
            db.execute("DELETE FROM assets WHERE id=?", (i,))
        db.execute("COMMIT")


def walk():
    """{key: lstat} of indexable files: no symlink, no dot name."""
    found, stack = {}, [ROOT]
    while stack:
        try:
            it = os.scandir(stack.pop())
        except OSError:
            continue
        with it:
            for e in it:
                try:
                    if e.name[0] == "." or e.is_symlink():
                        continue
                    if e.is_dir(follow_symlinks=False):
                        stack.append(e.path)
                    elif os.path.splitext(e.name)[1].lower() in IMG_EXT | VID_EXT and e.is_file(follow_symlinks=False):
                        found[os.path.relpath(e.path, ROOT).replace(os.sep, "/")] = e.stat(follow_symlinks=False)
                except OSError:
                    continue
    return found


def scan():
    t0 = time.time()
    STATE["scanning"] = True
    try:
        if not os.path.isdir(ROOT):
            STATE["warning"] = "Dossier de sorties introuvable (%s) : aucune suppression." % ROOT
            return
        with LOCK:
            known = {r["key"]: (r["id"], r["mtime_ns"], r["size"])
                     for r in db.execute("SELECT id,key,mtime_ns,size FROM assets WHERE trashed_at IS NULL")}
            trash = {r["key"]: r["id"] for r in db.execute("SELECT id,key FROM assets WHERE trashed_at IS NOT NULL")}
        found = walk()
        for key, st in found.items():
            if time.time() - st.st_mtime < FRESH_S or known.get(key, (0, 0, 0))[1:] == (st.st_mtime_ns, st.st_size):
                continue
            p = safe_path(key)
            try:
                if p:
                    index_file(key, p, st)
            except OSError:
                pass
        if not found and (known or trash):
            STATE["warning"] = "Dossier de sorties vide alors que l'index contient %d fichier(s) : aucune suppression." % (
                len(known) + len(trash))
        else:
            STATE["warning"] = None
            gone = [k for k in known if k not in found] + list(trash)
            for k in gone:
                with LOCK:  # re-check just before deleting
                    if not os.path.lexists(os.path.join(ROOT, k)):
                        delete_rows([known[k][0] if k in known else trash[k]])
    finally:
        STATE["last"] = int(time.time() * 1000)
        STATE["secs"] = round(time.time() - t0, 2)
        STATE["scanning"] = False


def scan_loop():
    while True:
        try:
            scan()
        except Exception:
            traceback.print_exc()
        time.sleep(SCAN_INTERVAL)


# ── Reading ──────────────────────────────────────────────────────────────────

def asset_json(r, tags, full=False):
    key = r["key"]
    sub, _, fn = key.rpartition("/")
    v = r["mtime"]
    prompt = r["prompt"]
    return {
        "key": key, "filename": fn, "subfolder": sub, "type": r["type"],
        "url": "/comfy/view?filename=%s&subfolder=%s&type=output&v=%d" % (quote(fn, safe=""), quote(sub, safe=""), v),
        "thumb": "/gallery/thumb?key=%s&v=%d" % (quote(key, safe=""), v),
        "ts": v, "prompt": prompt if full or prompt is None else prompt[:400],
        "pipeline": r["pipeline"], "model": r["model"], "loras": json.loads(r["loras"]), "seed": r["seed"],
        "w": r["w"], "h": r["h"], "duration": r["duration"], "size": r["size"], "fav": bool(r["fav"]),
        "tags": tags.get(r["id"], []), "label": None,
        "trash": {"origKey": r["orig_key"], "at": r["trashed_at"]} if r["trashed_at"] is not None else None,
    }


def tags_of(ids):
    out = {}
    with LOCK:
        for i in range(0, len(ids), 500):
            part = ids[i:i + 500]
            for r in db.execute("SELECT asset_id, name FROM asset_tags JOIN tags ON tags.id = tag_id WHERE asset_id IN (%s)"
                                " ORDER BY name" % ",".join("?" * len(part)), part):
                out.setdefault(r["asset_id"], []).append(r["name"])
    return out


def to_int(s, name):
    try:
        v = int(s)
    except ValueError:
        raise bad("Paramètre %s invalide." % name)
    if abs(v) > 1 << 62:
        raise bad("Paramètre %s invalide." % name)
    return v


def filters(q):
    """WHERE clause shared by /assets and /dates (everything except type)."""
    w, a = [], []
    scope = q.get("scope", "app")
    if scope not in ("app", "all", "trash"):
        raise bad("Paramètre scope invalide.")
    w.append({"app": "trashed_at IS NULL AND app = 1", "all": "trashed_at IS NULL", "trash": "trashed_at IS NOT NULL"}[scope])
    if q.get("pipeline") == "none":
        w.append("pipeline IS NULL")
    elif q.get("pipeline"):
        w.append("pipeline = ?")
        a.append(q["pipeline"])
    if q.get("model"):
        w.append("model = ?")
        a.append(q["model"])
    if q.get("tag"):
        w.append("id IN (SELECT asset_id FROM asset_tags JOIN tags ON tags.id = tag_id WHERE tags.name = ?)")
        a.append(q["tag"])
    if q.get("fav") == "1":
        w.append("fav = 1")
    for k, op in (("from", ">="), ("to", "<")):
        if k in q:
            w.append("mtime %s ?" % op)
            a.append(to_int(q[k], k))
    words = re.findall(r"\w+", q.get("q", ""))[:8]
    if words:
        w.append("id IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?)")
        a.append(" AND ".join('"%s"*' % x.replace('"', '""') for x in words))
    return " AND ".join(w), a


def kind(q):
    t = q.get("type", "image")
    if t not in ("image", "video"):
        raise bad("Paramètre type invalide.")
    return t


def r_health(q):
    with LOCK:
        n, app, tr = db.execute("SELECT count(*) FILTER (WHERE trashed_at IS NULL), "
                                "count(*) FILTER (WHERE trashed_at IS NULL AND app = 1), "
                                "count(*) FILTER (WHERE trashed_at IS NOT NULL) FROM assets").fetchone()
    return {"ok": True, "root": ROOT, "indexed": n, "app": app, "trashed": tr,
            "scanning": STATE["scanning"], "lastScanMs": STATE["last"], "scanSeconds": STATE["secs"],
            "warning": STATE["warning"], "schema": 1}


def r_assets(q):
    typ, where_, args = kind(q), *filters(q)
    sort = q.get("sort", "new")
    if sort not in ("new", "old"):
        raise bad("Paramètre sort invalide.")
    limit = to_int(q.get("limit", "60"), "limit")
    if not 1 <= limit <= 200:
        raise bad("Paramètre limit invalide.")
    cond, cargs = "", []
    if q.get("cursor"):
        try:
            c = json.loads(base64.urlsafe_b64decode(q["cursor"] + "=" * (-len(q["cursor"]) % 4)))
            assert c[0] == sort and type(c[1]) is int and isinstance(c[2], str) and len(c) == 3
        except Exception:
            raise bad("Curseur invalide.")
        cond, cargs = " AND (mtime, key) %s (?, ?)" % ("<" if sort == "new" else ">"), [c[1], c[2]]
    d = "DESC" if sort == "new" else "ASC"
    with LOCK:
        counts = {"image": 0, "video": 0}
        counts.update({r[0]: r[1] for r in db.execute("SELECT type, count(*) FROM assets WHERE %s GROUP BY type" % where_, args)})
        rows = db.execute("SELECT * FROM assets WHERE %s AND type = ?%s ORDER BY mtime %s, key %s LIMIT ?" % (where_, cond, d, d),
                          args + [typ] + cargs + [limit + 1]).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        tg = tags_of([r["id"] for r in rows])
    nxt = None
    if more:
        nxt = base64.urlsafe_b64encode(json.dumps([sort, rows[-1]["mtime"], rows[-1]["key"]], ensure_ascii=False).encode()).decode().rstrip("=")
    return {"items": [asset_json(r, tg) for r in rows], "next": nxt, "counts": counts}


def by_key(key):
    with LOCK:
        return db.execute("SELECT * FROM assets WHERE key = ?", (key,)).fetchone()


def r_asset(q):
    key = q.get("key", "")
    trash = key.startswith(".trash/")
    p = safe_path(key, allow_trash=trash)
    if not p:
        raise bad("Clé invalide.")
    r = by_key(key)
    if r is None and not trash:  # valid key, file present, not indexed yet: index it now
        try:
            st = os.lstat(p)
            if stat.S_ISREG(st.st_mode) and index_file(key, p, st):
                r = by_key(key)
        except OSError:
            pass
    if r is None or (r["trashed_at"] is not None) != trash:
        raise Err(404, "not_found", "Fichier inconnu.")
    return asset_json(r, tags_of([r["id"]]), full=True)


def make_thumb(p, typ, duration):
    if typ == "image":
        im = Image.open(p)
    else:
        img = b""
        for t in ("0.5", "0") if (duration or 0) > 1 else ("0",):
            img = subprocess.run(["ffmpeg", "-v", "error", "-ss", t, "-i", p, "-frames:v", "1", "-f", "image2pipe",
                                  "-c:v", "png", "-"], capture_output=True, timeout=20).stdout
            if img:
                break
        im = Image.open(io.BytesIO(img))
    im.thumbnail((320, 320))
    im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info else "RGB")
    out = io.BytesIO()
    im.save(out, "WEBP", quality=75)
    return out.getvalue()


def r_thumb(q):
    key = q.get("key", "")
    trash = key.startswith(".trash/")
    p = safe_path(key, allow_trash=trash)
    if not p:
        raise bad("Clé invalide.")
    r = by_key(key)
    if r is None or (r["trashed_at"] is not None) != trash:
        raise Err(404, "not_found", "Fichier inconnu.")
    cache = os.path.join(DATA, "thumbs", hashlib.sha1(("%s|%d|%d" % (key, r["mtime_ns"], r["size"])).encode()).hexdigest() + ".webp")
    with THUMB_SEM:
        try:
            with open(cache, "rb") as f:
                return f.read()
        except OSError:
            pass
        try:
            data = make_thumb(p, r["type"], r["duration"])
        except Exception as e:
            sys.stderr.write("thumb %s: %s\n" % (key, e))
            raise Err(404, "not_found", "Miniature impossible.")
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(cache), suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, cache)
    return data


def r_dates(q):
    typ, where_, args = kind(q), *filters(q)
    unit = q.get("unit", "day")
    if unit not in ("day", "week", "month"):
        raise bad("Paramètre unit invalide.")
    tz = to_int(q.get("tzOffset", "0"), "tzOffset")
    if abs(tz) > 1500:
        raise bad("Paramètre tzOffset invalide.")
    with LOCK:
        rows = db.execute("SELECT (mtime - ?) / 86400000, count(*) FROM assets WHERE %s AND type = ? GROUP BY 1" % where_,
                          [tz * 60000] + args + [typ]).fetchall()
    ORD0 = 719163  # date.toordinal() of 1970-01-01
    per = {}
    for day, n in rows:  # day = days since epoch in the client's local time
        if unit == "day":
            s, e = day, day + 1
        elif unit == "week":  # Monday to Monday (1970-01-01 was a Thursday)
            s = day - (day + 3) % 7
            e = s + 7
        else:
            d = datetime.date.fromordinal(day + ORD0)
            s = d.replace(day=1).toordinal() - ORD0
            e = (d.replace(day=1) + datetime.timedelta(days=32)).replace(day=1).toordinal() - ORD0
        per[(s, e)] = per.get((s, e), 0) + n
    return {"unit": unit, "periods": [{"start": s * 86400000 + tz * 60000, "end": e * 86400000 + tz * 60000, "count": n}
                                      for (s, e), n in sorted(per.items(), reverse=True)]}


def r_facets(q):
    scope = q.get("scope", "app")
    if scope not in ("app", "all", "trash"):
        raise bad("Paramètre scope invalide.")
    w = {"app": "trashed_at IS NULL AND app = 1", "all": "trashed_at IS NULL", "trash": "trashed_at IS NOT NULL"}[scope]
    with LOCK:
        pl = db.execute("SELECT pipeline, count(*) FROM assets WHERE %s GROUP BY 1 ORDER BY 2 DESC, 1" % w).fetchall()
        md = db.execute("SELECT model, count(*) FROM assets WHERE %s AND model IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1" % w).fetchall()
        tg = db.execute("SELECT tags.name, count(assets.id) FROM tags LEFT JOIN asset_tags ON tag_id = tags.id "
                        "LEFT JOIN assets ON assets.id = asset_id AND assets.%s GROUP BY tags.id ORDER BY tags.name"
                        % w.replace(" AND ", " AND assets.")).fetchall()
    return {"pipelines": [{"id": a, "count": b} for a, b in pl], "models": [{"name": a, "count": b} for a, b in md],
            "tags": [{"name": a, "count": b} for a, b in tg]}


ROUTES = {"/health": r_health, "/assets": r_assets, "/asset": r_asset, "/thumb": r_thumb, "/dates": r_dates,
          "/facets": r_facets}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def log_error(self, fmt, *a):
        sys.stderr.write("gallery: " + fmt % a + "\n")

    def send(self, status, body, ctype, cache):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def dispatch(self, method):
        u = urlsplit(self.path)
        try:
            fn = ROUTES.get(u.path)
            if fn is None:
                raise Err(404, "not_found", "Route inconnue.")
            if method != "GET":
                raise Err(405, "method", "Méthode non autorisée.")
            r = fn({k: v[0] for k, v in parse_qs(u.query).items()})
            if isinstance(r, bytes):
                self.send(200, r, "image/webp", "public, max-age=31536000, immutable")
            else:
                self.send(200, json.dumps(r, ensure_ascii=False).encode(), "application/json; charset=utf-8", "no-store")
        except Err as e:
            self.send(e.status, json.dumps({"error": e.code, "detail": e.detail}, ensure_ascii=False).encode(),
                      "application/json; charset=utf-8", "no-store")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self.send(500, b'{"error": "internal", "detail": "Erreur interne."}', "application/json; charset=utf-8", "no-store")

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    do_PUT = do_DELETE = do_PATCH = do_HEAD = do_POST


# ── Self-test ────────────────────────────────────────────────────────────────

def check():
    global ROOT
    from PIL import PngImagePlugin
    with tempfile.TemporaryDirectory() as tmp:
        outside = os.path.join(tmp, "outside")
        os.makedirs(outside)
        open(os.path.join(outside, "secret.png"), "wb").close()
        ROOT = os.path.join(tmp, "out")
        os.makedirs(os.path.join(ROOT, "a b"))
        os.makedirs(os.path.join(ROOT, ".trash", "1-abc"))
        for f in ("a b/it's é.png", "x.png", ".trash/1-abc/x.png", "c.txt"):
            open(os.path.join(ROOT, f), "wb").close()
        os.symlink(os.path.join(outside, "secret.png"), os.path.join(ROOT, "lnk.png"))
        os.symlink(outside, os.path.join(ROOT, "dirlink"))
        os.symlink("x.png", os.path.join(ROOT, "inner.png"))
        assert safe_path("x.png") and safe_path("a b/it's é.png") and safe_path("A.PNG") is not None
        for k in ("", "/x.png", "../x.png", "a/../x.png", "a/../../x.png", "a//x.png", "./x.png", "a/./x.png", "x\0.png",
                  "a\\x.png", ".hidden.png", "a/.h/x.png", ".trash/1-abc/x.png", "c.txt", "x", "x" * 1030 + ".png",
                  "lnk.png", "inner.png", "dirlink/secret.png", "\udc80.png", None, 5):
            assert safe_path(k) is None, k
        assert safe_path(".trash/1-abc/x.png", allow_trash=True)
        for k in ("/.trash/x.png", ".trash/../x.png", ".trash/.h/x.png", "a/.trash/x.png"):
            assert safe_path(k, allow_trash=True) is None, k

        assert prefix_of("studio/krea2_00043_.png") == "studio/krea2"
        assert prefix_of("Krea2_turbo_00070_.png") == "Krea2_turbo"
        assert prefix_of("a b/it's_00001_.mp4") == "a b/it's" and prefix_of("foo.png") == "foo"
        for k, p in {"studio/story/key_01_00062_.png": "storyboard_v2", "studio/relay/s_1.png": "storyboard_v2",
                     "campaign/x.png": "campaign_full", "studio/campaign/x.png": "campaign_full",
                     "studio/sequence_00001_.mp4": "sequence2video", "studio/minimax_h3_r2v_1.mp4": "reference2video",
                     "studio/ltx25_i2v_1.mp4": "image2video", "studio/ltx25_flf2v_1.mp4": "image2video",
                     "studio/minimax_h3_i2v_1.mp4": "image2video", "studio/ltx25_t2v_1.mp4": "text2video",
                     "studio/edit_1.png": "image2image", "studio/market_fr_1.png": "image2image",
                     "studio/krea2_1.png": "text2image", "studio/zimage_1.png": "text2image",
                     "canvas/qwen_edit_1.png": "canvas", "Krea2_turbo_00070_.png": None, "validate/x.png": None,
                     "studio/lot1/krea2_1.png": None}.items():
            assert pipeline_of(k) == p, (k, pipeline_of(k))
        for k, a in {"studio/krea2_1.png": 1, "canvas/x.png": 1, "video/x.mp4": 1, "ai_studio_ab_00001_.png": 1,
                     "studio/lot1/x.png": 0, "studio/lotA/x.png": 0, "studio/q21/x.png": 0, "studio/inspect/x.png": 0,
                     "studio/lot12_x.png": 0, "studio/lotto/x.png": 1, "Krea2_turbo_1.png": 0, "validate/x.png": 0,
                     "debug/x.png": 0, "studiox/a.png": 0}.items():
            assert is_app(k) == bool(a), k

        g = {"1": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": "out/a"}},
             "2": {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": "out/b"}},
             "3": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "seed": ["5", 0], "positive": ["7", 0], "negative": ["13", 0]}},
             "4": {"class_type": "UNETLoader", "inputs": {"unet_name": "unet_a.safetensors"}},
             "5": {"class_type": "PrimitiveInt", "inputs": {"value": 111}},
             "6": {"class_type": "KSampler", "inputs": {"model": ["8", 0], "noise_seed": 222, "positive": ["9", 0]}},
             "7": {"class_type": "CLIPTextEncode", "inputs": {"text": ["10", 0], "clip": ["4", 1]}},
             "8": {"class_type": "LoraLoaderModelOnly", "inputs": {"lora_name": "L/lora_b.safetensors", "model": ["11", 0]}},
             "9": {"class_type": "TextGenerate", "inputs": {"prompt": ["12", 0]}},
             "10": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": "prompt A, un chat élégant"}},
             "11": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ckpt_b.ckpt"}},
             "13": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry, ugly, a much longer negative prompt than the positive one"}},
             "12": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": "You are a very long system instruction for the LLM"}}}
        a, b = graph_meta(g, "out/a"), graph_meta(g, "out/b")
        assert (a["prompt"], a["model"], a["loras"], a["seed"]) == ("prompt A, un chat élégant", "unet_a", [], 111), a
        assert (b["prompt"], b["model"], b["loras"], b["seed"]) == (None, "ckpt_b", ["L/lora_b"], 222), b
        assert "very long system" in b["texts"] and "prompt A" in a["texts"] and "longer negative" in a["texts"]
        assert graph_meta(g, "nope")["seed"] == 111  # no match: every node with a filename_prefix

        def png(path, info, bad_len=False):
            meta = PngImagePlugin.PngInfo()
            if info is not None:
                meta.add_text("prompt", info)
            Image.new("RGB", (5, 3)).save(path, pnginfo=meta)
            if bad_len:  # declare a tEXt chunk longer than the file
                d = open(path, "rb").read()
                i = d.index(b"tEXt")
                open(path, "wb").write(d[:i - 4] + struct.pack(">I", 10 ** 6) + d[i:])
        p1, p2, p3 = (os.path.join(tmp, n) for n in ("p1.png", "p2.png", "p3.png"))
        png(p1, json.dumps(g))
        png(p2, None)
        png(p3, json.dumps(g), bad_len=True)
        assert png_prompt(p1) == g and png_prompt(p2) is None
        try:
            png_prompt(p3)
            raise AssertionError("damaged png accepted")
        except ValueError:
            pass
        m = extract(p1, "out/a_00001_.png", "image")
        assert (m["meta_ok"], m["w"], m["h"], m["seed"]) == (1, 5, 3, 111), m
        assert extract(p3, "x_00001_.png", "image")["meta_ok"] == 0
    src = open(__file__).read()
    assert not re.search(r"^\s*(import|from)\s+(urllib\.request|http\.client|socket|requests)\b", src, re.M)
    print("check: OK")


def main():
    global db
    os.makedirs(os.path.join(DATA, "thumbs"), exist_ok=True)
    db = sqlite3.connect(os.path.join(DATA, "gallery.db"), check_same_thread=False, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA synchronous = NORMAL")
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(SCHEMA)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # PID 1 ignores SIGTERM otherwise
    threading.Thread(target=scan_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    srv.serve_forever()


if __name__ == "__main__":
    check() if "--check" in sys.argv else main()
