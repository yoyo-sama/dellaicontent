import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

REPO_DIR = os.environ.get("REPO_DIR", "/repo")
LORAS_DIR = os.environ.get("LORAS_DIR", "/loras")
LORA_FOLDERS = {"Krea2", "H3"}
UPLOAD_CHUNK = 1024 * 1024


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
        if self.path != "/status":
            self._send_json(404, {"error": "not found"})
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
        self._send_json(200, {
            "updateAvailable": local_sha != remote_sha,
            "localSha": local_sha,
            "remoteSha": remote_sha,
        })

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/apply":
            self._handle_apply()
            return
        if parsed.path == "/loras/upload":
            self._handle_lora_upload(parse_qs(parsed.query))
            return
        self._send_json(404, {"error": "not found"})

    def _handle_apply(self):
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
        part_path = final_path + ".part"

        written = 0
        try:
            with open(part_path, "wb") as f:
                while written < length:
                    chunk = self.rfile.read(min(UPLOAD_CHUNK, length - written))
                    if not chunk:
                        break
                    f.write(chunk)
                    written += len(chunk)
        except OSError as e:
            self._send_json(500, {"error": str(e)})
            return

        if written != length:
            try:
                os.remove(part_path)
            except OSError:
                pass
            self._send_json(400, {"error": "upload interrupted (byte count mismatch)"})
            return

        os.rename(part_path, final_path)
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
