#!/usr/bin/env python3
import codecs, json, os, queue, re, select, shutil, subprocess, tempfile, threading, time, uuid
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
SESSIONS = {}
VER_FILE = os.path.join(WS, ".versions.json")
VER_LOCK = threading.Lock()
VER_MAX = 30
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
    return sorted(n for n in names
                  if os.path.isfile(os.path.join(WS, n)) and not n.startswith("."))


def _read_versions():
    try:
        with open(VER_FILE, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_versions(v):
    tmp = VER_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(v, f, ensure_ascii=False)
    os.replace(tmp, VER_FILE)


def _push_version(v, name, content):
    lst = v.get(name) or []
    if not lst or lst[-1]["content"] != content:
        lst.append({"id": time.time_ns() // 1000,
                    "t": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "content": content})
        del lst[:-VER_MAX]
        v[name] = lst


def add_version(name, content):
    with VER_LOCK:
        v = _read_versions()
        _push_version(v, name, content)
        _write_versions(v)


def api_versions(name):
    name = sanitize(name)
    with VER_LOCK:
        v = _read_versions().get(name) or []
    return {"versions": [{"id": e["id"], "t": e["t"]} for e in reversed(v)]}


def api_revert(req):
    name = sanitize(req.get("name", ""))
    try:
        vid = int(req.get("id", 0))
    except (TypeError, ValueError):
        raise ValueError("invalid version")
    p = os.path.join(WS, name)
    with VER_LOCK:
        v = _read_versions()
        entry = next((e for e in (v.get(name) or []) if e["id"] == vid), None)
        if entry is None:
            raise ValueError("version not found")
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                cur = f.read()
            if cur != entry["content"]:
                _push_version(v, name, cur)
        _write_versions(v)
        content = entry["content"]
    with open(p, "w", encoding="utf-8") as f:
        f.write(content)
    return {"content": content, "files": list_files()}


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


def run_session(sess, path):
    t0 = time.monotonic()
    last_activity = [t0]
    IDLE_LIMIT = 60

    def emit(kind, data):
        if kind in ("out", "err"):
            last_activity[0] = time.monotonic()
        sess.events.put({"e": kind, "d": data})

    def pump(stream, is_err):
        dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
        buf = sess._errbuf if is_err else sess._outbuf
        fd = stream.fileno()
        try:
            while True:
                if select.select([stream], [], [], 0.1)[0]:
                    chunk = os.read(fd, 4096)
                    if not chunk:
                        break
                    text = dec.decode(chunk)
                    if text:
                        emit("err" if is_err else "out", text)
                        buf.append(text)
        except (OSError, ValueError):
            pass
        try:
            tail = dec.decode(b"", final=True)
            if tail:
                emit("err" if is_err else "out", tail)
                buf.append(tail)
        except Exception:
            pass

    proc = None
    binpath = None
    try:
        if sess.lang == "python":
            proc = subprocess.Popen([PYTHON, "-u", path], cwd=WS,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, bufsize=1,
                                    errors="replace")
        else:
            binfd, binpath = tempfile.mkstemp(prefix="ide_bin_")
            os.close(binfd)
            comp = run_cmd([CLANG, "-std=c++17", "-O0", "-Wall",
                            "-fcolor-diagnostics=never", path, "-o", binpath],
                           cwd=WS, timeout=30)
            if comp["exit_code"] != 0 and "unknown argument" in comp["stderr"]:
                comp = run_cmd([CLANG, "-std=c++17", "-O0", "-Wall",
                                "-fno-color-diagnostics", path, "-o", binpath],
                               cwd=WS, timeout=30)
            if comp["exit_code"] != 0:
                emit("err", comp["stderr"])
                emit("errs", parse_cpp(comp["stderr"]))
                emit("done", {"exit": comp["exit_code"], "duration": int((time.monotonic() - t0) * 1000)})
                sess.done.set()
                return
            proc = subprocess.Popen([binpath], cwd=WS, stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, bufsize=1, errors="replace")

        def write_stdin():
            while True:
                item = sess.stdin_q.get()
                if item is None:
                    try:
                        proc.stdin.close()
                    except (OSError, ValueError):
                        pass
                    return
                try:
                    proc.stdin.write(item + "\n")
                    proc.stdin.flush()
                    last_activity[0] = time.monotonic()
                except (OSError, ValueError):
                    return

        t_out = threading.Thread(target=pump, args=(proc.stdout, False), daemon=True)
        t_err = threading.Thread(target=pump, args=(proc.stderr, True), daemon=True)
        t_in = threading.Thread(target=write_stdin, daemon=True)
        t_out.start(); t_err.start(); t_in.start()

        while proc.poll() is None:
            if time.monotonic() - last_activity[0] > IDLE_LIMIT:
                proc.kill()
                emit("err", f"\n[process killed: no activity for {IDLE_LIMIT}s]")
                break
            time.sleep(0.05)
        t_out.join(); t_err.join()
        exit_code = proc.poll()
        if sess.lang == "python":
            emit("errs", parse_py("".join(sess._errbuf)))
        emit("done", {"exit": exit_code, "duration": int((time.monotonic() - t0) * 1000)})
    finally:
        sess.done.set()
        try:
            if binpath:
                os.unlink(binpath)
        except OSError:
            pass


def start_session(path):
    ext = os.path.splitext(path)[1].lower()
    lang = LANG_EXT.get(ext)
    if lang is None:
        raise ValueError("unsupported language")
    if not os.path.isfile(os.path.join(WS, path)):
        raise FileNotFoundError(path)
    if not RUN_LOCK.acquire(blocking=False):
        raise RuntimeError("a run is already in progress")
    sess = type("S", (), {})()
    sess.id = uuid.uuid4().hex[:12]
    sess.lang = lang
    sess.events = queue.Queue()
    sess.stdin_q = queue.Queue()
    sess.done = threading.Event()
    sess._errbuf = []
    sess._outbuf = []
    sess._pumps = 0
    SESSIONS[sess.id] = sess

    def runner():
        try:
            run_session(sess, path)
        except Exception as e:
            sess.events.put({"e": "err", "d": f"\n[internal error: {e}]"})
            sess.events.put({"e": "done", "d": {"exit": 1, "duration": 0}})
        finally:
            RUN_LOCK.release()
            time.sleep(5)
            SESSIONS.pop(sess.id, None)

    threading.Thread(target=runner, daemon=True).start()
    return sess.id


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
        add_version(name, content)
    elif action == "rename":
        new = sanitize(req.get("new_name", ""))
        if os.path.exists(os.path.join(WS, new)):
            raise ValueError("target already exists")
        shutil.move(os.path.join(WS, name), os.path.join(WS, new))
        with VER_LOCK:
            v = _read_versions()
            if name in v and new not in v:
                v[new] = v.pop(name)
                _write_versions(v)
    elif action == "delete":
        os.remove(os.path.join(WS, name))
        with VER_LOCK:
            v = _read_versions()
            if v.pop(name, None) is not None:
                _write_versions(v)
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
        elif path.startswith("/api/stream/"):
            sid = path.split("/")[-1]
            sess = SESSIONS.get(sid)
            if sess is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            try:
                while True:
                    try:
                        ev = sess.events.get(timeout=1.5)
                        line = json.dumps(ev["d"], ensure_ascii=False)
                        payload = f"event: {ev['e']}\ndata: {line}\n\n"
                        self.wfile.write(payload.encode("utf-8"))
                        self.wfile.flush()
                        if ev["e"] == "done":
                            break
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        if sess.done.is_set():
                            break
            except (ConnectionError, BrokenPipeError, OSError):
                pass
            finally:
                try:
                    self.wfile.close()
                except OSError:
                    pass
        elif path == "/api/file":
            q = {k: v[0] for k, v in parse_qs(parts.query).items()}
            name = q.get("name", "")
            p = os.path.join(WS, name)
            if name.startswith(".") or not os.path.isfile(p) or os.path.commonpath(
                    [os.path.realpath(WS), os.path.realpath(p)]) != os.path.realpath(WS):
                self._json(404, {"error": "not found"})
                return
            with open(p, encoding="utf-8") as f:
                self._json(200, {"name": name, "content": f.read()})
        elif path == "/api/versions":
            q = {k: v[0] for k, v in parse_qs(parts.query).items()}
            try:
                self._json(200, api_versions(q.get("name", "")))
            except ValueError as e:
                self._json(400, {"error": str(e)})
        elif path in ("/", "/index.html"):
            self._file("index.html", STATIC)
        elif path in ("/app.js", "/style.css"):
            self._file(path.lstrip("/"), STATIC)
        else:
            self.send_error(404)

    def do_POST(self):
        p = urlparse(self.path).path
        if p == "/api/run":
            try:
                req = self._body()
                path = sanitize(req.get("path", ""))
                sid = start_session(path)
            except RuntimeError as e:
                self._json(409, {"error": str(e)})
            except (FileNotFoundError, ValueError) as e:
                self._json(404 if isinstance(e, FileNotFoundError) else 400, {"error": str(e)})
            else:
                self._json(200, {"id": sid})
            return
        if p == "/api/input":
            try:
                req = self._body()
                sess = SESSIONS.get(req.get("id", ""))
                if sess is None or sess.done.is_set():
                    self._json(404, {"error": "no active run for this session"})
                    return
                if req.get("eof"):
                    sess.stdin_q.put(None)
                else:
                    sess.stdin_q.put(str(req.get("line", "")))
                self._json(200, {"ok": True})
            except (ValueError, OSError) as e:
                self._json(400, {"error": str(e)})
            return
        if p == "/api/files":
            try:
                req = self._body()
                self._json(200, api_files(req))
            except (ValueError, OSError) as e:
                self._json(400, {"error": str(e)})
            return
        if p == "/api/revert":
            try:
                self._json(200, api_revert(self._body()))
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
