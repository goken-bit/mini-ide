#!/usr/bin/env python3
import codecs, io, json, os, queue, re, select, shlex, shutil, subprocess, tempfile, threading, time, uuid, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
WS = os.path.join(ROOT, "workspace")
STATIC = os.path.join(ROOT, "static")
HOST, PORT = "127.0.0.1", 8080
MAX_BODY = 4 << 20

NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_. +\-()\[\]/]{0,199}$")
SRCS_RE = re.compile(r"^\s*srcs\s*=\s*(.+?)\s*$")
FLAGS_RE = re.compile(r"^\s*flags\s*=\s*(.+?)\s*$")
LANG_EXT = {".py": "python", ".pyw": "python",
            ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".c++": "cpp",
            ".c": "cpp", ".h": "cpp", ".hpp": "cpp", ".hh": "cpp"}
MIME = {".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml"}
RUN_LOCK = threading.Lock()
SESSIONS = {}
VER_FILE = os.path.join(WS, ".versions.json")
VER_LOCK = threading.Lock()
VER_MAX = 30
def _resolve_exe(name, fallback):
    p = shutil.which(name)
    if p and os.path.isabs(p) and os.path.isfile(p):
        return p
    if os.path.isabs(fallback) and os.path.isfile(fallback):
        return fallback
    return p or fallback

PYTHON = _resolve_exe("python3", "/data/data/com.termux/files/usr/bin/python3")
CLANG = _resolve_exe("clang++", "/data/data/com.termux/files/usr/bin/clang++")

PY_FRAME = re.compile(r'File "([^"]+)", line (\d+)')
CPP_DIAG = re.compile(r"^([^:]+):(\d+):(?:(?:(\d+)): )?((?:fatal )?error|warning): (.*)$", re.M)


def sanitize(name):
    if isinstance(name, str) and "\\" in name:
        name = name.replace("\\", "/")
    if not isinstance(name, str) or not NAME_RE.match(name) or name.startswith("."):
        raise ValueError("invalid filename")
    for seg in name.split("/"):
        if seg in ("", ".", ".."):
            raise ValueError("invalid filename")
    p = os.path.join(WS, name)
    if os.path.commonpath([os.path.realpath(WS), os.path.realpath(p)]) != os.path.realpath(WS):
        raise ValueError("invalid filename")
    return name


def list_files():
    out = []
    try:
        for root, dirs, names in os.walk(WS):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for n in names:
                if n.startswith("."):
                    continue
                out.append(os.path.relpath(os.path.join(root, n), WS).replace(os.sep, "/"))
    except OSError:
        pass
    return sorted(out)


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
    except FileNotFoundError:
        exe = args[0] if args else "compiler"
        if "clang" in exe:
            msg = "clang++ not installed. Install with: apt install clang  or  pkg install clang\n"
        else:
            msg = f"{exe} not found. Please install it.\n"
        return {"stdout": "", "stderr": msg, "exit_code": 127}
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
        kind = "warning" if "warning" in m.group(4) else "error"
        key = (lineno, col, kind)
        if key in seen:
            continue
        seen.add(key)
        errs.append({"line": lineno, "col": col or None, "msg": m.group(5), "kind": kind})
    return errs


def sess_emit(sess, kind, data):
    sess.events.put({"e": kind, "d": data})


def run_proc(sess, proc, parse=None):
    try:
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
            if sess.stop.is_set():
                proc.kill()
                emit("err", "\n[process stopped]")
                break
            if time.monotonic() - last_activity[0] > IDLE_LIMIT:
                proc.kill()
                emit("err", f"\n[process killed: no activity for {IDLE_LIMIT}s]")
                break
            time.sleep(0.05)
        t_out.join(); t_err.join()
        exit_code = proc.poll()
        if parse == "py":
            emit("errs", parse_py("".join(sess._errbuf)))
        emit("done", {"exit": exit_code, "duration": int((time.monotonic() - t0) * 1000)})
        sess.done.set()
    except FileNotFoundError as e:
        exe = str(e.filename) if getattr(e, 'filename', None) else str(e)
        if "clang" in exe or "clang" in str(e):
            sess.events.put({"e": "err", "d": "clang++ not installed. Install with: apt install clang  or  pkg install clang\n"})
        else:
            sess.events.put({"e": "err", "d": f"{exe} not found. Please install it.\n"})
        sess.events.put({"e": "done", "d": {"exit": 127, "duration": 0}})
        sess.done.set()
    except Exception as e:
        sess.events.put({"e": "err", "d": f"\n[internal error: {e}]\n"})
        sess.events.put({"e": "done", "d": {"exit": 1, "duration": 0}})
        sess.done.set()


def cpp_srcs(main):
    if os.path.splitext(main)[1].lower() not in (".cpp", ".cc", ".cxx", ".c++"):
        return [main]
    proj = os.path.join(WS, "project.txt")
    srcs = None
    if os.path.isfile(proj):
        try:
            with open(proj, encoding="utf-8") as f:
                for ln in f.read().splitlines():
                    m = SRCS_RE.match(ln)
                    if m:
                        srcs = [s for s in m.group(1).split() if s]
                        break
        except OSError:
            pass
    if not srcs:
        return [main]
    out = [sanitize(s) for s in srcs]
    if main not in out:
        out.append(main)
    return out


def cpp_flags():
    proj = os.path.join(WS, "project.txt")
    if not os.path.isfile(proj):
        return []
    try:
        with open(proj, encoding="utf-8") as f:
            for ln in f.read().splitlines():
                m = FLAGS_RE.match(ln)
                if m:
                    try:
                        return shlex.split(m.group(1))
                    except ValueError:
                        return [s for s in m.group(1).split() if s]
    except OSError:
        pass
    return []


def run_session(sess, path):
    if sess.lang == "python":
        try:
            proc = subprocess.Popen([PYTHON, "-u", path] + sess.args, cwd=WS,
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, text=True, bufsize=1,
                                            errors="replace")
        except FileNotFoundError:
            sess_emit(sess, "err", "python3 not found. Please install Python 3.\n")
            sess_emit(sess, "done", {"exit": 127, "duration": 0})
            sess.done.set()
            return
        run_proc(sess, proc, "py")
        return
    binfd, binpath = tempfile.mkstemp(prefix="ide_bin_")
    os.close(binfd)
    try:
        if not os.path.isfile(CLANG):
            sess_emit(sess, "err", "C++ compiler not found: clang++ not installed. Install with: apt install clang  or  pkg install clang\n")
            sess_emit(sess, "errs", [])
            sess_emit(sess, "done", {"exit": 127, "duration": 0})
            sess.done.set()
            return
        srcs = cpp_srcs(path)
        flags = cpp_flags()
        comp = run_cmd([CLANG, "-std=c++17", "-O0", "-Wall",
                        "-fcolor-diagnostics=never"] + flags + srcs + ["-o", binpath],
                       cwd=WS, timeout=30)
        if comp["exit_code"] != 0 and "unknown argument" in comp["stderr"]:
            comp = run_cmd([CLANG, "-std=c++17", "-O0", "-Wall",
                            "-fno-color-diagnostics"] + flags + srcs + ["-o", binpath],
                           cwd=WS, timeout=30)
        if "not installed" in comp.get("stderr", "") or "not found" in comp.get("stderr", ""):
            sess_emit(sess, "err", comp["stderr"])
            sess_emit(sess, "done", {"exit": 127, "duration": 0})
            sess.done.set()
            return
        if comp["exit_code"] != 0:
            sess_emit(sess, "err", comp["stderr"])
            sess_emit(sess, "errs", parse_cpp(comp["stderr"]))
            sess_emit(sess, "done", {"exit": comp["exit_code"], "duration": 0})
            sess.done.set()
            return
        if comp["stderr"]:
            warns = parse_cpp(comp["stderr"])
            if warns:
                sess_emit(sess, "err", comp["stderr"])
                sess_emit(sess, "errs", warns)
        try:
            proc = subprocess.Popen([binpath] + sess.args, cwd=WS,
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, text=True, bufsize=1,
                                            errors="replace")
        except FileNotFoundError:
            sess_emit(sess, "err", "Failed to execute compiled binary.\n")
            sess_emit(sess, "done", {"exit": 127, "duration": 0})
            sess.done.set()
            return
        run_proc(sess, proc)
    except FileNotFoundError as e:
        exe = str(getattr(e, 'filename', '') or e)
        if "clang" in exe.lower():
            sess_emit(sess, "err", "C++ compiler not found: clang++ not installed. Install with: apt install clang  or  pkg install clang\n")
        else:
            sess_emit(sess, "err", f"C++ compiler not found: {exe}. Install with: apt install clang  or  pkg install clang\n")
        sess_emit(sess, "done", {"exit": 127, "duration": 0})
        sess.done.set()
    finally:
        try:
            os.unlink(binpath)
        except OSError:
            pass


def run_shell(sess, cmd):
    try:
        proc = subprocess.Popen(cmd, shell=True, cwd=WS,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, bufsize=1,
                                        errors="replace")
    except FileNotFoundError as e:
        sess_emit(sess, "err", f"shell not found: {e}\n")
        sess_emit(sess, "done", {"exit": 127, "duration": 0})
        sess.done.set()
        return
    run_proc(sess, proc)


def start_session(kind, target, args=None):
    if kind == "run":
        p = os.path.join(WS, target)
        if not os.path.isfile(p):
            raise FileNotFoundError(target)
        lang = LANG_EXT.get(os.path.splitext(target)[1].lower())
        if lang is None:
            raise ValueError("unsupported language")
        if lang == "cpp" and not os.path.isfile(CLANG):
            raise FileNotFoundError("C++ compiler not found: clang++ not installed. Install with: apt install clang  or  pkg install clang")
        if lang == "python" and not os.path.isfile(PYTHON):
            raise FileNotFoundError("Python interpreter not found: python3 not installed.")
    else:
        lang = "shell"
    if not RUN_LOCK.acquire(timeout=5):
        raise RuntimeError("a run is already in progress")
    sess = type("S", (), {})()
    sess.id = uuid.uuid4().hex[:12]
    sess.kind = kind
    sess.lang = lang
    sess.target = target
    sess.args = args or []
    sess.stop = threading.Event()
    sess.events = queue.Queue()
    sess.stdin_q = queue.Queue()
    sess.done = threading.Event()
    sess._errbuf = []
    sess._outbuf = []
    SESSIONS[sess.id] = sess

    def runner():
        try:
            if kind == "shell":
                run_shell(sess, target)
            else:
                run_session(sess, target)
        except FileNotFoundError as e:
            msg = str(e)
            if "clang" in msg.lower() or (kind == "run" and sess.lang == "cpp"):
                sess_emit(sess, "err", "C++ compiler not found: clang++ not installed. Install with: apt install clang  or  pkg install clang\n")
            else:
                sess_emit(sess, "err", f"Executable not found: {msg}. Please install it.\n")
            sess_emit(sess, "done", {"exit": 127, "duration": 0})
            sess.done.set()
        except Exception as e:
            sess_emit(sess, "err", f"\n[internal error: {e}]")
            sess_emit(sess, "done", {"exit": 1, "duration": 0})
            sess.done.set()
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
        d = os.path.dirname(p)
        if d:
            os.makedirs(d, exist_ok=True)
        open(p, "w").close()
    elif action == "save":
        content = req.get("content", "")
        p = os.path.join(WS, name)
        d = os.path.dirname(p)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        add_version(name, content)
    elif action == "rename":
        new = sanitize(req.get("new_name", ""))
        if os.path.exists(os.path.join(WS, new)):
            raise ValueError("target already exists")
        d = os.path.dirname(os.path.join(WS, new))
        if d:
            os.makedirs(d, exist_ok=True)
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


def check_args(args):
    if isinstance(args, str):
        try:
            args = shlex.split(args)
        except ValueError as e:
            raise ValueError(str(e))
    if not isinstance(args, list):
        raise ValueError("args must be a list")
    total = 0
    for a in args:
        if not isinstance(a, str) or not a or "\n" in a or "\0" in a or len(a) > 4096:
            raise ValueError("invalid argument")
        total += len(a)
    if total > 65536:
        raise ValueError("too many arguments")
    return args


def api_search(q):
    if not isinstance(q, str) or not q.strip():
        raise ValueError("missing query")
    q = q.strip()
    if len(q) > 200:
        raise ValueError("query too long")
    hits = []
    low = q.lower()
    for rel in list_files():
        p = os.path.join(WS, rel)
        try:
            with open(p, encoding="utf-8", errors="ignore") as f:
                for idx, line in enumerate(f, 1):
                    if low in line.lower():
                        hits.append({"file": rel, "line": idx, "text": line.rstrip("\n")[:300]})
                        if len(hits) >= 200:
                            return hits
        except OSError:
            continue
    return hits


def export_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in list_files():
            z.write(os.path.join(WS, rel), rel)
    return buf.getvalue()


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
        elif path == "/api/search":
            q = {k: v[0] for k, v in parse_qs(parts.query).items()}
            try:
                hits = api_search(q.get("q", ""))
                self._json(200, {"hits": hits})
            except ValueError as e:
                self._json(400, {"error": str(e)})
        elif path == "/api/export":
            body = export_zip()
            q = {k: v[0] for k, v in parse_qs(parts.query).items()}
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition",
                             'attachment; filename="' + (q.get("as") or "workspace") + '.zip"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif path in ("/", "/index.html"):
            self._file("index.html", STATIC)
        elif path in ("/app.js", "/style.css", "/manifest.json", "/sw.js"):
            self._file(path.lstrip("/"), STATIC)
        else:
            self.send_error(404)

    def do_POST(self):
        p = urlparse(self.path).path
        if p == "/api/run":
            try:
                req = self._body()
                path = sanitize(req.get("path", ""))
                args = check_args(req.get("args") or [])
                sid = start_session("run", path, args)
                stdin_src = req.get("stdin")
                if isinstance(stdin_src, str) and stdin_src:
                    sess = SESSIONS.get(sid)
                    if sess is not None:
                        for ln in stdin_src.splitlines():
                            sess.stdin_q.put(ln)
            except RuntimeError as e:
                self._json(409, {"error": str(e)})
            except (FileNotFoundError, ValueError) as e:
                self._json(404 if isinstance(e, FileNotFoundError) else 400, {"error": str(e)})
            else:
                self._json(200, {"id": sid})
            return
        if p == "/api/stop":
            try:
                req = self._body()
                sess = SESSIONS.get(req.get("id", ""))
                if sess is None or sess.done.is_set():
                    self._json(404, {"error": "no active run for this session"})
                    return
                sess.stop.set()
                self._json(200, {"ok": True})
            except (ValueError, OSError) as e:
                self._json(400, {"error": str(e)})
            return
        if p == "/api/shell":
            try:
                req = self._body()
                cmd = str(req.get("cmd", "")).strip()
                if not cmd or "\0" in cmd or len(cmd) > 8192:
                    raise ValueError("invalid command")
                sid = start_session("shell", cmd)
            except RuntimeError as e:
                self._json(409, {"error": str(e)})
            except (FileNotFoundError, ValueError) as e:
                self._json(400, {"error": str(e)})
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
    global PYTHON, CLANG
    os.makedirs(WS, exist_ok=True)
    py = shutil.which("python3")
    if not py or not os.path.isabs(py) or not os.path.isfile(py):
        py = "/data/data/com.termux/files/usr/bin/python3"
    PYTHON = py
    if not os.path.isfile(PYTHON):
        print("[warn] python3 not found at " + PYTHON + ". Install Python 3.", flush=True)
    cl = shutil.which("clang++")
    if not cl or not os.path.isabs(cl) or not os.path.isfile(cl):
        cl = "/data/data/com.termux/files/usr/bin/clang++"
    CLANG = cl
    if not os.path.isfile(CLANG):
        print("[warn] C++ compiler not found: clang++ not found at " + CLANG, flush=True)
        print("       Install with: apt install clang  or  pkg install clang", flush=True)
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
