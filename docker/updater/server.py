import json
import os
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

REPO_DIR = os.environ.get("REPO_DIR", "/repo")
LORAS_DIR = os.environ.get("LORAS_DIR", "/loras")
LORA_FOLDERS = {"Krea2", "H3"}
UPLOAD_CHUNK = 1024 * 1024
STATUS_TTL = 60
# (timestamp, 200 payload of /status): avoids an ls-remote on every page load.
# ponytail: one global cache, cleared by a successful /apply; a remote push stays invisible for up to 60 s.
status_cache = (0.0, None)


def parse_ls_remote_sha(output):
    """Extract the SHA (first column) from the first line of `git ls-remote` output."""
    return output.strip().split("\n")[0].split("\t")[0]


def run_git(*args):
    return subprocess.run(
        ["git", "-C", REPO_DIR, *args],
        capture_output=True,
        text=True,
    )


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        global status_cache
        if self.path != "/status":
            self._send_json(404, {"error": "not found"})
            return

        cached_at, cached = status_cache
        if cached is not None and time.time() - cached_at < STATUS_TTL:
            self._send_json(200, cached)
            return

        local = run_git("rev-parse", "HEAD")
        if local.returncode != 0:
            self._send_json(500, {"error": local.stderr.strip()})
            return

        remote = run_git("ls-remote", "origin", "main")
        if remote.returncode != 0:
            self._send_json(500, {"error": remote.stderr.strip()})
            return

        local_sha = local.stdout.strip()
        remote_sha = parse_ls_remote_sha(remote.stdout)
        # An update only exists on main, and only if the remote is not already in our history
        # (branch ahead = nothing to pull). No `git fetch`: the updater runs as root and would
        # dirty .git; a SHA unknown locally (rc 128) means the remote moved on.
        branch = run_git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        update = branch == "main" and run_git("merge-base", "--is-ancestor", remote_sha, "HEAD").returncode != 0
        payload = {
            "updateAvailable": update,
            "localSha": local_sha,
            "remoteSha": remote_sha,
        }
        status_cache = (time.time(), payload)
        self._send_json(200, payload)

    def do_POST(self):
        site = self.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            self._send_json(403, {"error": "cross-site request refused"})
            return
        parsed = urlparse(self.path)
        if parsed.path == "/apply":
            self._handle_apply()
            return
        if parsed.path == "/loras/upload":
            self._handle_lora_upload(parse_qs(parsed.query))
            return
        self._send_json(404, {"error": "not found"})

    def _handle_apply(self):
        global status_cache
        if run_git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() != "main":
            self._send_json(200, {"success": False, "error": "not on main"})
            return

        dirty = run_git("status", "--porcelain")
        if dirty.returncode != 0:
            self._send_json(500, {"error": dirty.stderr.strip()})
            return
        if dirty.stdout.strip():
            self._send_json(200, {"success": False, "error": "working tree not clean"})
            return

        fetch = run_git("fetch", "origin", "main")
        if fetch.returncode != 0:
            self._send_json(200, {"success": False, "error": fetch.stderr.strip()})
            return

        pull = run_git("pull", "--ff-only", "origin", "main")
        if pull.returncode != 0:
            self._send_json(200, {"success": False, "error": pull.stderr.strip()})
            return

        status_cache = (0.0, None)
        self._send_json(200, {"success": True})

    def _handle_lora_upload(self, query):
        folder = (query.get("folder") or [""])[0]
        if folder not in LORA_FOLDERS:
            self._send_json(400, {"error": f"invalid folder (must be Krea2 or H3): {folder!r}"})
            return

        raw_filename = (query.get("filename") or [""])[0]
        filename = os.path.basename(raw_filename)
        if not filename or filename != raw_filename or ".." in filename or not filename.endswith(".safetensors"):
            self._send_json(400, {"error": "filename must be a bare name ending in .safetensors"})
            return

        length = self.headers.get("Content-Length")
        if length is None or not length.isdigit():
            self._send_json(400, {"error": "missing or invalid Content-Length"})
            return
        length = int(length)

        dest_dir = os.path.join(LORAS_DIR, folder)
        os.makedirs(dest_dir, exist_ok=True)
        final_path = os.path.join(dest_dir, filename)
        if os.path.exists(final_path):
            self._send_json(409, {"error": f"file already exists: {folder}/{filename}"})
            return
        fd, part_path = tempfile.mkstemp(dir=dest_dir, suffix=".part")

        written = 0
        try:
            with os.fdopen(fd, "wb") as f:
                while written < length:
                    chunk = self.rfile.read(min(UPLOAD_CHUNK, length - written))
                    if not chunk:
                        break
                    f.write(chunk)
                    written += len(chunk)
        except OSError as e:
            try:
                os.remove(part_path)
            except OSError:
                pass
            self._send_json(500, {"error": str(e)})
            return

        if written != length:
            try:
                os.remove(part_path)
            except OSError:
                pass
            self._send_json(400, {"error": "upload interrupted (byte count mismatch)"})
            return

        # mkstemp creates 0600 and this container writes as root: ComfyUI (uid 1000) must read it.
        os.chmod(part_path, 0o644)
        try:
            os.link(part_path, final_path)  # unlike rename, never overwrites
        except FileExistsError:
            os.remove(part_path)
            self._send_json(409, {"error": f"file already exists: {folder}/{filename}"})
            return
        os.remove(part_path)
        self._send_json(200, {"ok": True, "path": f"{folder}/{filename}"})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    if "--check" in sys.argv:
        sample = "abc123def456abc123def456abc123def456abcd\trefs/heads/main\n"
        assert parse_ls_remote_sha(sample) == "abc123def456abc123def456abc123def456abcd"
        print("self-check OK")
        sys.exit(0)

    subprocess.run(["git", "config", "--global", "--add", "safe.directory", REPO_DIR])
    ThreadingHTTPServer(("127.0.0.1", 8093), Handler).serve_forever()
