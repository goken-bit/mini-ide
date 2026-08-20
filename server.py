#!/usr/bin/env python3
import json, os, re, shutil, subprocess, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
WS = os.path.join(ROOT, "workspace")
STATIC = os.path.join(ROOT, "static")
HOST, PORT = "127.0.0.1", 8080
MAX_BODY = 4 << 20

NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_. +\-()\[\]]{0,99}$")
LANG_EXT = {".py": "python", ".pyw": "python",
            ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".c++": "cpp",
            ".c": "cpp", ".h": "cpp", ".hpp": "cpp", ".hh": "cpp"}
MIME = {".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml"}
RUN_LOCK = threading.Lock()
PYTHON = shutil.which("python3") or "/data/data/com.termux/files/usr/bin/python3"
CLANG = shutil.which("clang++") or "/data/data/com.termux/files/usr/bin/clang++"

PY_FRAME = re.compile(r'File "([^"]+)", line (\d+)')
CPP_DIAG = re.compile(r"^([^:]+):(\d+):(?:(?:(\d+)): )?((?:fatal )?error|warning): (.*)$", re.M)


def sanitize(name):
    if not isinstance(name, str) or not NAME_RE.match(name) or name.startswith("."):
        raise ValueError("invalid filename")
    p = os.path.join(WS, name)
    if os.path.commonpath([os.path.realpath(WS), os.path.realpath(p)]) != os.path.realpath(WS):
        raise ValueError("invalid filename")
    return name


def list_files():
    try:
        names = os.listdir(WS)
    except OSError:
        names = []
    return sorted(n for n in names if os.path.isfile(os.path.join(WS, n)))


def run_cmd(args, cwd, timeout):
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return {"stdout": p.stdout, "stderr": p.stderr, "exit_code": p.returncode}
    except subprocess.TimeoutExpired as e:
        tail = f"\n[process timed out after {timeout}s and was killed]"
        return {"stdout": (e.stdout or "") + tail, "stderr": e.stderr or "", "exit_code": 124}


def parse_py(stderr):
    errs, seen = [], set()
    lines = stderr.splitlines()
    for i, ln in enumerate(lines):
        m = PY_FRAME.search(ln)
        if not m:
            continue
        fname = m.group(1)
        try:
            lineno = int(m.group(2))
        except ValueError:
            continue
        col = None
        for j in range(i + 1, min(i + 4, len(lines))):
            s = lines[j].strip()
            if s.startswith("^"):
                col = lines[j].index("^") + 1
                break
        msg = ""
        for j in range(i + 1, len(lines)):
            s = lines[j]
            if s and not s[0].isspace() and PY_FRAME.search(s) is None:
                msg = s
                break
        key = (fname, lineno)
        if key in seen:
            continue
        seen.add(key)
        errs.append({"line": lineno, "col": col, "msg": msg})
    return errs


def parse_cpp(stderr):
    errs, seen = [], set()
    for m in CPP_DIAG.finditer(stderr):
        try:
            lineno, col = int(m.group(2)), int(m.group(3) or 0)
        except ValueError:
            continue
        if m.group(4) != "error" and not m.group(4).startswith("fatal error"):
            continue
        key = (lineno, col)
        if key in seen:
            continue
        seen.add(key)
        errs.append({"line": lineno, "col": col or None, "msg": m.group(5)})
    return errs


def run_file(path):
    ext = os.path.splitext(path)[1].lower()
    lang = LANG_EXT.get(ext)
    if lang is None:
        raise ValueError("unsupported language")
    fpath = os.path.join(WS, path)
    if not os.path.isfile(fpath):
        raise FileNotFoundError(path)
    t0 = time.monotonic()
    if lang == "python":
        out = run_cmd([PYTHON, "-u", path], cwd=WS, timeout=15)
        out["errors"] = parse_py(out["stderr"])
    else:
        binfd, binpath = tempfile.mkstemp(prefix="ide_bin_")
        os.close(binfd)
        try:
            comp = run_cmd([CLANG, "-std=c++17", "-O0", "-Wall",
                            "-fcolor-diagnostics=never", path, "-o", binpath],
                           cwd=WS, timeout=30)
            if comp["exit_code"] != 0 and "unknown argument" in comp["stderr"]:
                comp = run_cmd([CLANG, "-std=c++17", "-O0", "-Wall",
                                "-fno-color-diagnostics", path, "-o", binpath],
                               cwd=WS, timeout=30)
            out = comp
            out["errors"] = parse_cpp(comp["stderr"])
            if comp["exit_code"] == 0:
                run = run_cmd([binpath], cwd=WS, timeout=15)
                out = {"stdout": comp["stdout"] + run["stdout"],
                       "stderr": comp["stderr"] + run["stderr"],
                       "exit_code": run["exit_code"], "errors": out["errors"]}
        finally:
            try:
                os.unlink(binpath)
            except OSError:
                pass
    out["duration_ms"] = int((time.monotonic() - t0) * 1000)
    out["lang"] = lang
    return out


def api_files(req):
    name = sanitize(req.get("name", ""))
    action = req.get("action")
    if action == "create":
        p = os.path.join(WS, name)
        if os.path.exists(p):
            raise ValueError("file already exists")
        open(p, "w").close()
    elif action == "save":
        content = req.get("content", "")
        with open(os.path.join(WS, name), "w", encoding="utf-8") as f:
            f.write(content)
    elif action == "rename":
        new = sanitize(req.get("new_name", ""))
        if os.path.exists(os.path.join(WS, new)):
            raise ValueError("target already exists")
        shutil.move(os.path.join(WS, name), os.path.join(WS, new))
    elif action == "delete":
        os.remove(os.path.join(WS, name))
    else:
        raise ValueError("unknown action")
    return {"files": list_files()}


class Handler(BaseHTTPRequestHandler):
    server_version = "MiniIDE/1.0"

    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, root, code=200):
        p = os.path.join(root, path)
        if not os.path.isfile(p) or os.path.commonpath(
                [os.path.realpath(root), os.path.realpath(p)]) != os.path.realpath(root):
            self.send_error(404)
            return
        with open(p, "rb") as f:
            body = f.read()
        self.send_response(code)
        self.send_header("Content-Type", MIME.get(os.path.splitext(p)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
        except (ValueError, TypeError):
            n = 0
        if n > MAX_BODY:
            self._json(413, {"error": "payload too large"})
            return
        raw = self.rfile.read(n)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        parts = urlparse(self.path)
        path = parts.path
        if path == "/api/files":
            self._json(200, {"files": list_files()})
        elif path == "/api/file":
            q = {k: v[0] for k, v in parse_qs(parts.query).items()}
            name = q.get("name", "")
            p = os.path.join(WS, name)
            if not os.path.isfile(p) or os.path.commonpath(
                    [os.path.realpath(WS), os.path.realpath(p)]) != os.path.realpath(WS):
                self._json(404, {"error": "not found"})
                return
            with open(p, encoding="utf-8") as f:
                self._json(200, {"name": name, "content": f.read()})
        elif path in ("/", "/index.html"):
            self._file("index.html", STATIC)
        elif path in ("/app.js", "/style.css"):
            self._file(path.lstrip("/"), STATIC)
        else:
            self.send_error(404)

    def do_POST(self):
        if urlparse(self.path).path == "/api/run":
            try:
                req = self._body()
                path = sanitize(req.get("path", ""))
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            if not RUN_LOCK.acquire(blocking=False):
                self._json(409, {"error": "a run is already in progress"})
                return
            try:
                self._json(200, run_file(path))
            except (FileNotFoundError, ValueError) as e:
                self._json(404 if isinstance(e, FileNotFoundError) else 400, {"error": str(e)})
            finally:
                RUN_LOCK.release()
            return
        if urlparse(self.path).path == "/api/files":
            try:
                req = self._body()
                self._json(200, api_files(req))
            except (ValueError, OSError) as e:
                self._json(400, {"error": str(e)})
            return
        self.send_error(404)


def main():
    os.makedirs(WS, exist_ok=True)
    host = os.environ.get("HOST", "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    print(f"MiniIDE running: http://{host}:{port}  (open this URL in your browser)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
