(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = {
    editor: $("editor"),
    hl: $("highlight"),
    hlCode: $("hl-code"),
    gutter: $("gutter"),
    codeWrap: $("code-wrap"),
    tabs: $("tabs"),
    filelist: $("filelist"),
    inpName: $("inp-name"),
    btnCreate: $("btn-create"),
    btnNew: $("btn-new"),
    btnRun: $("btn-run"),
    btnLoad: $("btn-load"),
    btnSave: $("btn-save"),
    btnHistory: $("btn-history"),
    btnWrap: $("btn-wrap"),
    btnTheme: $("btn-theme"),
    btnFontInc: $("btn-font-inc"),
    btnFontDec: $("btn-font-dec"),
    fontSizeLabel: $("font-size-label"),
    btnZip: $("btn-zip"),
    btnDl: $("btn-dl"),
    stPos: $("st-pos"),
    stLang: $("st-lang"),
    stDirty: $("st-dirty"),
    stWords: $("st-words"),
    btnClear: $("btn-clear"),
    btnCopy: $("btn-copy"),
    argsRow: $("args-row"),
    inpArgs: $("inp-args"),
    findLayer: $("find-layer"),
    findPre: $("find-pre"),
    findBar: $("findbar"),
    findInp: $("find-inp"),
    findRepl: $("find-repl"),
    findPrev: $("find-prev"),
    findNext: $("find-next"),
    findCase: $("find-case"),
    findRep: $("find-rep"),
    findRepall: $("find-repall"),
    findCount: $("find-count"),
    findClose: $("find-close"),
    searchResults: $("search-results"),
    filePicker: $("file-picker"),
    runState: $("run-state"),
    runStats: $("run-stats"),
    console: $("console-out"),
    stdinRow: $("console-input-row"),
    stdinInp: $("console-inp"),
    btnEof: $("btn-eof"),
    inpStdin: $("inp-stdin"),
    stdinFile: $("stdin-file"),
    btnStdinFile: $("btn-stdin-file"),
    btnStdinClear: $("btn-stdin-clear"),
    sidebar: $("sidebar"),
    consolePanel: $("console"),
    btnToggleSidebar: $("btn-toggle-sidebar"),
    btnToggleConsole: $("btn-toggle-console"),
    handleSidebar: $("handle-sidebar"),
    handleConsole: $("handle-console"),
    backdrop: $("sidebar-backdrop"),
    toolbar: $("code-toolbar")
  };

  const LS = "minide.files.";
  let files = [];
  let current = null;
  let dirty = new Set();
  let errMap = {};        // filename -> {line: {col, msg}}
  let running = false;
  let runSeq = 0;
  let argsMap = {};       // filename -> [args...]
  let prefs = { wrap: false, theme: "dark", size: 14, sidebarVisible: true, consoleVisible: true };
  let findState = { open: false, q: "", repl: "", case: false, matches: [], idx: 0 };
  let persistTimer = null;
  let pending = null;

  const LANG_OF = {
    py: "python", pyw: "python",
    cpp: "cpp", cc: "cpp", cxx: "cpp", "c++": "cpp",
    c: "cpp", h: "cpp", hpp: "cpp", hh: "cpp"
  };
  const PY = { int: 1, float: 1, complex: 1, bool: 1, str: 1, bytes: 1,
    list: 1, dict: 1, set: 1, tuple: 1, None: 1, True: 1, False: 1,
    and: 1, or: 1, not: 1, in: 1, is: 1, if: 1, elif: 1, else: 1,
    for: 1, while: 1, break: 1, continue: 1, return: 1, yield: 1,
    def: 1, class: 1, lambda: 1, global: 1, nonlocal: 1, pass: 1,
    raise: 1, try: 1, except: 1, finally: 1, with: 1, as: 1, assert: 1,
    from: 1, import: 1, del: 1, async: 1, await: 1, match: 1, case: 1,
    print: 1, len: 1, range: 1, super: 1, self: 1 };
  const CPP = { int: 1, char: 1, float: 1, double: 1, bool: 1, void: 1,
    auto: 1, struct: 1, class: 1, enum: 1, union: 1, namespace: 1,
    using: 1, template: 1, typename: 1, public: 1, private: 1,
    protected: 1, virtual: 1, static: 1, const: 1, constexpr: 1,
    extern: 1, inline: 1, volatile: 1, signed: 1, unsigned: 1, short: 1,
    long: 1, new: 1, delete: 1, if: 1, else: 1, for: 1, while: 1,
    do: 1, switch: 1, case: 1, default: 1, break: 1, continue: 1,
    return: 1, goto: 1, try: 1, catch: 1, throw: 1, typedef: 1,
    operator: 1, friend: 1, explicit: 1, mutable: 1, register: 1,
    sizeof: 1, this: 1, true: 1, false: 1, nullptr: 1, include: 1,
    define: 1, ifdef: 1, ifndef: 1, endif: 1, define: 1, include: 1,
    pragma: 1, using: 1, std: 1, cout: 1, cin: 1, endl: 1, main: 1 };
  const NUM_RE = /^\d+(\.\d+)?([eE][+-]?\d+)?[uUlLfF]*$/;

  function api(url, opts) {
    opts = opts || {};
    if (opts.json !== undefined) {
      opts.method = opts.method || "POST";
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      opts.body = JSON.stringify(opts.json);
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || r.status + " " + r.statusText); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  function langOf(name) {
    var m = /\.([A-Za-z0-9+]+)$/.exec(name);
    return m ? LANG_OF[m[1].toLowerCase()] || null : null;
  }
  function extOf(name) { var m = /\.([A-Za-z0-9+]+)$/.exec(name); return m ? m[1] : ""; }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  /* ---------- highlighting ---------- */
  function highlight(src, lang) {
    if (!lang) return esc(src);
    var out = "", i = 0, n = src.length;
    var syms = (lang === "python" ? PY : CPP);
    while (i < n) {
      var c = src[i];
      if (c === "\n") { out += "\n"; i++; continue; }
      if (c === " ") { out += " "; i++; continue; }
      if (c === "\t") { out += "\t"; i++; continue; }
      if (c === "#" || (c === "/" && src[i + 1] === "/")) {
        var j = src.indexOf("\n", i); if (j < 0) j = n;
        out += '<span class="tok-c">' + esc(src.slice(i, j)) + "</span>"; i = j; continue;
      }
      if (lang === "cpp" && c === "/" && src[i + 1] === "*") {
        var k = src.indexOf("*/", i + 2);
        j = k < 0 ? n : k + 2;
        out += '<span class="tok-c">' + esc(src.slice(i, j)) + "</span>"; i = j; continue;
      }
      if (lang === "python" && c === '"' || lang === "python" && c === "'" ||
          lang === "cpp" && c === '"' && src[i + 1] !== '"' && src[i + 2] !== '"' ||
          lang === "cpp" && c === "'" && src[i + 1] !== "'" && src[i + 2] !== "'") {
        var q = c, d = 0;
        j = i + 1;
        while (j < n && (src[j] !== q || src[j - 1] === "\\")) {
          if (src[j] === q && src[j - 1] === "\\" && j + 1 < n && src[j + 1] === q) j++;
          j++;
        }
        if (j < n) j++;
        out += '<span class="tok-s">' + esc(src.slice(i, j)) + "</span>"; i = j; continue;
      }
      if (c >= "0" && c <= "9" || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
        j = i;
        while (j < n && /[0-9a-zA-Z_.]/.test(src[j]) && !(src[j] === "." && src[j + 1] === ".")) j++;
        var num = src.slice(i, j);
        if (NUM_RE.test(num) || /^0[xXbBoO]?[0-9a-fA-F_]+$/.test(num)) {
          out += '<span class="tok-n">' + esc(num) + "</span>"; i = j; continue;
        }
        out += esc(num); i = j; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        j = i;
        while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
        var w = src.slice(i, j);
        if (syms[w]) out += '<span class="tok-k">' + esc(w) + "</span>";
        else out += esc(w);
        i = j; continue;
      }
      out += esc(c); i++;
    }
    return out;
  }

  function highlightWithLens(src, lang, errs) {
    if (!errs || !Object.keys(errs).length) return highlight(src, lang);
    var lines = src.split("\n");
    var out = "";
    for (var i = 0; i < lines.length; i++) {
      var ln = i + 1;
      var html = highlight(lines[i], lang);
      var er = errs[ln];
      if (er) {
        var cls = er.kind === "warning" ? "lens-warn" : "lens-err";
        html = '<span class="' + cls + '" title="' + esc(er.msg) + '">' + (html || " ") + "</span>";
      }
      out += html;
      if (i < lines.length - 1) out += "\n";
    }
    return out;
  }

  function render() {
    var src = current && files[current] !== undefined ? files[current] : "";
    if (el.editor.value !== src) el.editor.value = src;
    var lang = current ? langOf(current) : null;
    var errs = current ? (errMap[current] || {}) : {};
    el.hlCode.innerHTML = highlightWithLens(src, lang, errs);
    el.hl.scrollTop = el.editor.scrollTop;
    el.hl.scrollLeft = el.editor.scrollLeft;
    buildGutter(src, lang);
    buildTabs();
    buildList();
    document.title = (dirty.has(current) ? "* " : "") + (current || "MiniIDE") + " — MiniIDE";
    updateStatus();
    syncArgsInput();
    renderFindLayer();
    schedulePersist();
  }

  function lineCount(src) {
    var c = 1;
    for (var i = 0; i < src.length; i++) if (src[i] === "\n") c++;
    return c;
  }

  function buildGutter(src, lang) {
    var n = lineCount(src);
    var errs = errMap[current] || {};
    var h = "";
    for (var i = 1; i <= n; i++) {
      var er = errs[i];
      var cls = er ? (er.kind === "warning" ? "warn" : "err") : "";
      var tip = er ? ' title="' + esc(er.msg) + '"' : "";
      h += "<div" + (cls ? " class=\"" + cls + "\"" + tip : "") + ">" + i + "</div>";
    }
    el.gutter.innerHTML = h;
    if (lang === "cpp" && n < 1000) {
      if (el.gutter.scrollHeight < el.gutter.clientHeight) {
        el.gutter.style.height = (n * LH() + 16) + "px";
      } else el.gutter.style.height = "";
    }
    el.gutter.scrollTop = el.editor.scrollTop;
  }

  /* ---------- tabs & sidebar ---------- */
  function buildTabs() {
    var h = "";
    files.forEach(function (f) {
      h += '<button class="tab' + (f === current ? " active" : "") + '" data-tab="' + esc(f) + '">' +
        esc(f) + (dirty.has(f) ? '<span class="dot">\u25CF</span>' : "") +
        '<span class="x">\u00D7</span></button>';
    });
    el.tabs.innerHTML = h;
    Array.prototype.forEach.call(el.tabs.children, function (t) {
      t.addEventListener("click", function (e) {
        var f = t.getAttribute("data-tab");
        if (e.target.classList.contains("x")) { closeTab(f); return; }
        openFile(f);
      });
    });
  }

  function buildList() {
    var h = "";
    var lastF = null;
    files.forEach(function (f) {
      var i = f.lastIndexOf("/");
      var folder = i >= 0 ? f.slice(0, i) : "";
      if (folder !== lastF) {
        lastF = folder;
        if (folder) h += '<li class="fld" data-f="">' + esc(folder) + "/</li>";
      }
      var depth = folder ? folder.split("/").length : 0;
      h += '<li data-f="' + esc(f) + '" style="padding-left:' + (6 + depth * 16) + 'px" class="' +
        (f === current ? "active " : "") + (errMap[f] ? "error-file" : "") + '">' +
        '<span class="fname">' + esc(i >= 0 ? f.slice(i + 1) : f) + (dirty.has(f) ? " \u25CF" : "") + "</span>" +
        '<span class="fops">' +
        '<button class="fbtn" data-op="rename">\u270E</button>' +
        '<button class="fbtn del" data-op="del">\u2715</button>' +
        "</span></li>";
    });
    el.filelist.innerHTML = h || '<li style="color:var(--dim);cursor:default">(empty)</li>';
    Array.prototype.forEach.call(el.filelist.children, function (li) {
      var f = li.getAttribute("data-f");
      if (!f) return;
      li.addEventListener("click", function (e) {
        var btn = e.target.closest(".fbtn");
        if (btn) {
          if (btn.getAttribute("data-op") === "rename") renameFile(f);
          else deleteFile(f);
          return;
        }
        openFile(f);
      });
    });
  }

  function openFile(name, done) {
    if (!files.includes(name)) return;
    if (current !== name) {
      var prev = current;
      current = name;
      if (prev && !files.includes(prev)) dirty.delete(prev);
      var had = files[current];
      if (had === undefined) {
        api("/api/file?name=" + encodeURIComponent(current)).then(function (j) {
          files[current] = j.content;
          render();
          if (done) done();
        }).catch(function (e) { console.error(e); files[current] = ""; render(); if (done) done(); });
        return;
      }
    }
    render();
    if (done) done();
  }

  function closeTab(name) {
    var doClose = function () {
      if (name === current) current = null;
      files.splice(files.indexOf(name), 1);
      dirty.delete(name);
      delete errMap[name];
      var idx = current ? files.indexOf(current) : -1;
      if (current && idx >= 0) current = files[idx];
      else if (files.length) current = files[files.length - 1];
      render();
    };
    if (!dirty.has(name)) return doClose();
    themedDialog({
      title: "Unsaved changes",
      html: "Close <b class='file'>" + esc(name) + "</b> without saving?",
      buttons: [
        { label: "Cancel", value: "cancel" },
        { label: "Don't Save", value: "discard" },
        { label: "Save", value: "save", kind: "primary" }
      ]
    }).then(function (r) {
      if (r === "cancel") return;
      if (r === "save") return saveFile(name).then(doClose);
      doClose();
    });
  }

  function promptName(prefill) {
    var v = window.prompt("File name:", prefill || "");
    return v === null ? null : v.trim();
  }

  function newFile() {
    var n = promptName();
    if (n === null) return;
    el.inpName.value = n;
    createFile(n);
  }

  function createFile(n) {
    if (!n) return;
    api("/api/files", { json: { action: "create", name: n } }).then(function (j) {
      files = j.files;
      current = n;
      files[n] = "";
      render();
    }).catch(function (e) { notify(esc(e.message)); });
  }

  function deleteFile(n) {
    var doDelete = function () {
      api("/api/files", { json: { action: "delete", name: n } }).then(function (j) {
        files = j.files;
        if (n === current) current = null;
        dirty.delete(n);
        delete errMap[n];
        if (files.length && !current) current = files[files.length - 1];
        render();
      }).catch(function (e) { notify(esc(e.message)); });
    };
    themedDialog({
      title: "Delete file",
      html: "Delete <b class='file'>" + esc(n) + "</b>?" +
        (dirty.has(n) ? "<br><br>It has unsaved changes." : ""),
      buttons: [
        { label: "Cancel", value: "cancel" },
        { label: "Delete", value: "del", kind: "danger" }
      ]
    }).then(function (r) {
      if (r !== "del") return;
      if (!dirty.has(n)) return doDelete();
      themedDialog({
        title: "Unsaved changes",
        html: "<b class='file'>" + esc(n) + "</b> has unsaved changes.",
        buttons: [
          { label: "Cancel", value: "cancel" },
          { label: "Delete anyway", value: "discard", kind: "danger" },
          { label: "Save & Delete", value: "save", kind: "primary" }
        ]
      }).then(function (r2) {
        if (r2 === "cancel") return;
        if (r2 === "save") return saveFile(n).then(doDelete);
        doDelete();
      });
    });
  }

  function renameFile(n) {
    var nn = promptName(n);
    if (nn === null || nn === n) return;
    api("/api/files", { json: { action: "rename", name: n, new_name: nn } }).then(function (j) {
      files = j.files;
      if (n === current) current = nn;
      if (dirty.has(n)) { dirty.delete(n); dirty.add(nn); }
      if (errMap[n]) { errMap[nn] = errMap[n]; delete errMap[n]; }
      render();
    }).catch(function (e) { notify(esc(e.message)); });
  }

  function saveCurrent() {
    if (!current) return notify("Open or create a file first.");
    if (files[current] === undefined) return notify("File not loaded yet.");
    saveFile(current).then(function () {
      el.btnSave.classList.add("saved");
      el.btnSave.textContent = "Saved \u2713";
      el.runStats.textContent = "saved " + new Date().toLocaleTimeString();
      setTimeout(function () {
        el.btnSave.classList.remove("saved");
        el.btnSave.textContent = "Save";
      }, 1500);
    });
  }

  function loadCurrent() {
    el.filePicker.value = "";
    el.filePicker.click();
  }

  function handlePicked(file) {
    var name = file.name;
    if (!name) return;
    if (name.indexOf("/") >= 0 || /^\./.test(name) || !/^[A-Za-z0-9_][A-Za-z0-9_ .+\-()\[\]]{0,99}$/.test(name)) {
      return notify("Invalid file name: <b class='file'>" + esc(name) + "</b>");
    }
    var doImport = function () {
      var reader = new FileReader();
      reader.onload = function () {
        var content = String(reader.result || "");
        api("/api/files", { json: { action: "create", name: name } }).then(function (j) {
          files = j.files;
          files[name] = content;
          dirty.add(name);
          current = name;
          errMap[name] = {};
          render();
          el.runStats.textContent = "opened " + name;
          return saveFile(name);
        }).catch(function (e) {
          notify(esc(e.message));
        });
      };
      reader.onerror = function () { notify("Could not read the selected file."); };
      reader.readAsText(file);
    };
    if (files.indexOf(name) >= 0) {
      themedDialog({
        title: "File exists",
        html: "<b class='file'>" + esc(name) + "</b> already exists in the workspace.<br>Replace its contents with the file you picked?",
        buttons: [
          { label: "Cancel", value: "cancel" },
          { label: "Replace", value: "ok", kind: "primary" }
        ]
      }).then(function (r) {
        if (r !== "ok") return;
        doImport();
      });
    } else {
      doImport();
    }
  }

  /* ---------- themed modal ---------- */
  function themedDialog(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      var box = document.createElement("div");
      box.className = "modal";
      var title = document.createElement("div");
      title.className = "modal-title";
      title.textContent = opts.title;
      var msg = document.createElement("div");
      msg.className = "modal-msg";
      if (opts.html) msg.innerHTML = opts.html;
      else msg.textContent = opts.message || "";
      var foot = document.createElement("div");
      foot.className = "modal-buttons";
      var buttons = opts.buttons || [{ label: "OK", value: "ok" }];
      buttons.forEach(function (b, i) {
        var btn = document.createElement("button");
        btn.className = "modal-btn" + (b.kind === "primary" ? " primary" : "") +
          (b.kind === "danger" ? " danger" : "");
        btn.textContent = b.label;
        btn.addEventListener("click", close.bind(null, b.value));
        foot.appendChild(btn);
        if (i === 0) btn.focus();
      });
      function close(v) {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(v);
      }
      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          close(buttons[buttons.length - 1].value);
        } else if (e.key === "Enter") {
          e.preventDefault();
          close(buttons[0].value);
        }
      }
      document.addEventListener("keydown", onKey, true);
      overlay.addEventListener("mousedown", function (e) {
        if (e.target === overlay) close(buttons[buttons.length - 1].value);
      });
      box.appendChild(title);
      box.appendChild(msg);
      box.appendChild(foot);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  function notify(msg) {
    return themedDialog({ title: "MiniIDE", html: msg, buttons: [{ label: "OK", value: "ok", kind: "primary" }] });
  }

  /* ---------- run ---------- */
  var curSeg = null;
  var curSid = null;

  function log(html) {
    var d = document.createElement("div");
    d.innerHTML = html;
    el.console.appendChild(d);
    el.console.scrollTop = el.console.scrollHeight;
  }

  function streamOut(cls, chunk) {
    var parts = String(chunk).split("\n");
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].length) {
        if (!curSeg || curSeg.cls !== cls) {
          curSeg = { el: document.createElement("div"), cls: cls };
          curSeg.el.className = cls;
          el.console.appendChild(curSeg.el);
        }
        curSeg.el.textContent += parts[i];
      }
      if (i < parts.length - 1) curSeg = null;
    }
    el.console.scrollTop = el.console.scrollHeight;
  }

  function setRunBtn(stopMode) {
    el.btnRun.textContent = stopMode ? "\u25A0 Stop" : "\u25B6 Run";
    el.btnRun.title = stopMode ? "Stop the running process" : "Run (Ctrl+Enter)";
  }

  function finalizeRun(my) {
    if (my !== runSeq) return;
    running = false;
    el.btnRun.classList.remove("running");
    setRunBtn(false);
    el.stdinRow.classList.remove("show");
    if (!el.runState.textContent) {
      el.runState.textContent = "idle";
      el.runState.className = "idle";
    }
    if (pending) {
      var p = pending;
      pending = null;
      if (p === "run") run();
      else repl();
    }
  }

  function shlexSplit(s) {
    var out = [], cur = "", q = null, esc = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (esc) { cur += c; esc = false; continue; }
      if (c === "\\" && q !== "'") { esc = true; continue; }
      if (q) {
        if (c === q) q = null;
        else cur += c;
      } else {
        if (c === '"' || c === "'") q = c;
        else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } }
        else cur += c;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function run() {
    if (!current) return notify("Open or create a file first.");
    var f = current;
    if (!files[f] && files[f] !== "") return notify("File not loaded yet.");
    if (running) { pending = "run"; if (curSid) api("/api/stop", { json: { id: curSid } }).catch(function () {}); return; }
    saveFile(f).then(function () {
      var stdinSrc = el.inpStdin ? el.inpStdin.value : "";
      var payload = { path: f, args: argsMap[f] || [] };
      if (stdinSrc) payload.stdin = stdinSrc;
      startRun(api("/api/run", { json: payload }), f);
    });
  }

  function repl() {
    if (running) { pending = "repl"; if (curSid) api("/api/stop", { json: { id: curSid } }).catch(function () {}); return; }
    startRun(api("/api/shell", { json: { cmd: "python3 -q -i" } }), null);
  }

  function startRun(promise, errFile) {
    if (!prefs.consoleVisible) {
      prefs.consoleVisible = true;
      applyConsoleState();
      persist();
    }
    running = true;
    runSeq++;
    var my = runSeq;
    curSid = null;
    if (errFile) errMap[errFile] = {};
    curSeg = null;
    el.btnRun.classList.add("running");
    setRunBtn(true);
    el.runState.textContent = "running...";
    el.runState.className = "running";
    el.runStats.textContent = "";
    el.console.innerHTML = "";
    streamOut("out-ln", (errFile ? "\u25B8 run " + errFile : "\u25B8 shell") + "\n");
    promise.then(function (r) {
      if (my !== runSeq) return finalizeRun(my);
      curSid = r.id;
      var es = new EventSource("/api/stream/" + r.id);
      var closed = false;

      function sendInput(line, eof) {
        if (!curSid) return;
        api("/api/input", { json: eof ? { id: curSid, eof: true } : { id: curSid, line: line } })
          .catch(function (e2) { streamOut("err-ln", "\n[input error: " + e2.message + "]\n"); });
      }

      es.addEventListener("out", function (e) {
        if (my !== runSeq) return;
        streamOut("out-ln", JSON.parse(e.data));
      });
      es.addEventListener("err", function (e) {
        if (my !== runSeq) return;
        streamOut("err-ln", JSON.parse(e.data));
      });
      es.addEventListener("errs", function (e) {
        if (my !== runSeq || !errFile) return;
        var errs = JSON.parse(e.data) || [];
        errMap[errFile] = {};
        errs.forEach(function (er) {
          errMap[errFile][er.line] = er;
          var col = er.col ? ":" + er.col : "";
          var kind = er.kind === "warning" ? "warnline" : "errline";
          log('<div class="' + kind + '" data-line="' + er.line + '" data-file="' + esc(errFile) + '">' +
            esc(errFile) + col + " [" + (er.kind || "error") + "]: " + esc(er.msg) + "</div>");
        });
        render();
      });
      es.addEventListener("done", function (e) {
        if (my !== runSeq) return;
        var d = JSON.parse(e.data);
        log("<div class='out-ln'>\u23F1 exit " + d.exit + " in " + d.duration + " ms</div>");
        el.runState.textContent = d.exit === 0 ? "OK" : "exit " + d.exit;
        el.runState.className = d.exit === 0 ? "ok" : "fail";
        el.runStats.textContent = d.duration + " ms";
        render();
        closed = true;
        es.close();
        finalizeRun(my);
      });
      es.onerror = function () {
        if (closed || my !== runSeq) { es.close(); return; }
        closed = true;
        es.close();
        el.runState.textContent = "error";
        el.runState.className = "fail";
        finalizeRun(my);
      };
      el.stdinRow.classList.add("show");
      el.stdinRow.classList.remove("hide");
      el.stdinInp.disabled = false;
      el.btnEof.disabled = false;
      el.stdinInp.value = "";
      el.stdinInp.focus();
    }).catch(function (e) {
      if (my !== runSeq) return finalizeRun(my);
      streamOut("err-ln", e.message + "\n");
      el.runState.textContent = "error";
      el.runState.className = "fail";
      finalizeRun(my);
    });
  }

  function saveFile(name) {
    var content = files[name] || "";
    return api("/api/files", { json: { action: "save", name: name, content: content } }).then(function () {
      dirty.delete(name);
      render();
    });
  }

  /* ---------- history ---------- */
  function openHistory() {
    if (!current) return notify("Open or create a file first.");
    api("/api/versions?name=" + encodeURIComponent(current)).then(function (j) {
      if (!j.versions.length) {
        return notify("No saved versions of <b class='file'>" + esc(current) + "</b> yet. Save the file to create a checkpoint.");
      }
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      var box = document.createElement("div");
      box.className = "modal";
      var title = document.createElement("div");
      title.className = "modal-title";
      title.textContent = "History \u2014 " + current;
      var msg = document.createElement("div");
      msg.className = "modal-msg";
      msg.textContent = "Pick a version to restore. The current content is kept in history, so nothing is lost.";
      var list = document.createElement("div");
      list.className = "hv-list";
      j.versions.forEach(function (ver, i) {
        var row = document.createElement("div");
        row.className = "hv-row";
        var lab = document.createElement("span");
        lab.className = "hv-time";
        lab.textContent = ver.t + (i === 0 ? "  (latest)" : "");
        var btn = document.createElement("button");
        btn.className = "modal-btn";
        btn.textContent = "Restore";
        btn.addEventListener("click", function () { doRevert(ver, close); });
        row.appendChild(lab);
        row.appendChild(btn);
        list.appendChild(row);
      });
      var foot = document.createElement("div");
      foot.className = "modal-buttons";
      var closeBtn = document.createElement("button");
      closeBtn.className = "modal-btn primary";
      closeBtn.textContent = "Close";
      closeBtn.addEventListener("click", close);
      foot.appendChild(closeBtn);
      function close() {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(); }
      }
      document.addEventListener("keydown", onKey, true);
      overlay.addEventListener("mousedown", function (e) {
        if (e.target === overlay) close();
      });
      box.appendChild(title);
      box.appendChild(msg);
      box.appendChild(list);
      box.appendChild(foot);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    }).catch(function (e) { notify(esc(e.message)); });
  }

  function doRevert(ver, close) {
    var warn = dirty.has(current) ? "<br><b style='color:var(--danger, #c33)'>Unsaved changes will be lost.</b>" : "";
    themedDialog({
      title: "Restore version?",
      html: "Restore <b class='file'>" + esc(current) + "</b> to the save from <b>" + esc(ver.t) + "</b>?" + warn,
      buttons: [
        { label: "Cancel", value: "cancel" },
        { label: "Restore", value: "ok", kind: "primary" }
      ]
    }).then(function (r) {
      if (r !== "ok") return;
      api("/api/revert", { json: { name: current, id: ver.id } }).then(function (j) {
        files[current] = j.content;
        dirty.delete(current);
        el.editor.value = j.content;
        render();
        el.runStats.textContent = "restored " + ver.t;
        if (close) close();
      }).catch(function (e) { notify(esc(e.message)); });
    });
  }

  /* ---------- status bar & prefs ---------- */
  function lineCol(pos) {
    var s = el.editor.value.slice(0, pos);
    var ln = 1, col = 1;
    for (var i = 0; i < s.length; i++) {
      if (s[i] === "\n") { ln++; col = 1; } else col++;
    }
    return [ln, col];
  }

  function langLabel(name) {
    var L = { python: "Python", cpp: "C++" };
    var m = langOf(name);
    return m ? (L[m] || m) : "text";
  }

  function updateStatus() {
    if (!current) {
      el.stPos.textContent = "Ln 1, Col 1";
      el.stLang.textContent = "\u2014";
      el.stDirty.textContent = "";
      el.stWords.textContent = "";
      return;
    }
    var lc = lineCol(el.editor.selectionStart);
    el.stPos.textContent = "Ln " + lc[0] + ", Col " + lc[1];
    el.stLang.textContent = langLabel(current);
    el.stDirty.textContent = dirty.has(current) ? "\u25CF" : "";
    var w = (files[current] || "").trim().split(/\s+/).filter(Boolean).length;
    el.stWords.textContent = w + " word" + (w === 1 ? "" : "s");
  }

  function LH() { return prefs.size + 7; }

  function applyPrefs() {
    document.documentElement.classList.toggle("light", prefs.theme === "light");
    el.btnTheme.textContent = prefs.theme === "light" ? "\u263E" : "\u263D";
    document.documentElement.style.setProperty("--size", prefs.size + "px");
    document.documentElement.style.setProperty("--lh", LH() + "px");
    el.fontSizeLabel.textContent = prefs.size;
    applyWrap();
    applySidebarState();
    applyConsoleState();
  }

  function applyWrap() {
    el.editor.wrap = prefs.wrap ? "soft" : "off";
    el.editor.classList.toggle("wrap", prefs.wrap);
    el.hl.classList.toggle("wrap", prefs.wrap);
    el.findPre.classList.toggle("wrap", prefs.wrap);
    el.btnWrap.classList.toggle("on", prefs.wrap);
  }

  function applySidebarState() {
    var v = !!prefs.sidebarVisible;
    el.sidebar.classList.toggle("collapsed", !v);
    el.btnToggleSidebar.setAttribute("aria-expanded", String(v));
    el.btnToggleSidebar.title = (v ? "Hide" : "Show") + " sidebar (Ctrl+B)";
    el.handleSidebar.setAttribute("aria-expanded", String(v));
    el.handleSidebar.title = (v ? "Hide" : "Show") + " sidebar (Ctrl+B)";
    var isMobile = window.matchMedia("(max-width: 640px)").matches;
    if (isMobile) {
      if (v) {
        el.backdrop.hidden = false;
        requestAnimationFrame(function () {
          el.backdrop.classList.add("show");
        });
      } else {
        el.backdrop.classList.remove("show");
        setTimeout(function () { if (!prefs.sidebarVisible) el.backdrop.hidden = true; }, 220);
      }
      el.backdrop.setAttribute("aria-hidden", v ? "false" : "true");
    } else {
      el.backdrop.hidden = true;
      el.backdrop.classList.remove("show");
      el.backdrop.setAttribute("aria-hidden", "true");
    }
  }

  function applyConsoleState() {
    var v = !!prefs.consoleVisible;
    el.consolePanel.classList.toggle("collapsed", !v);
    el.btnToggleConsole.setAttribute("aria-expanded", String(v));
    el.btnToggleConsole.title = (v ? "Hide" : "Show") + " terminal (Ctrl+J)";
    el.handleConsole.setAttribute("aria-expanded", String(v));
    el.handleConsole.title = (v ? "Hide" : "Show") + " terminal (Ctrl+J)";
  }

  function toggleSidebar() {
    prefs.sidebarVisible = !prefs.sidebarVisible;
    applySidebarState();
    persist();
  }

  function toggleConsole() {
    prefs.consoleVisible = !prefs.consoleVisible;
    applyConsoleState();
    persist();
  }

  function onLayoutTransitionEnd(e) {
    if (e.target !== el.sidebar && e.target !== el.consolePanel) return;
    if (e.propertyName !== "width" && e.propertyName !== "max-height" && e.propertyName !== "transform" && e.propertyName !== "flex-basis") return;
    syncScroll();
    render();
  }

  /* ---------- find & replace ---------- */
  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function findRegex() {
    if (!findState.q) return null;
    try {
      return new RegExp(escRe(findState.q), "g" + (findState.case ? "" : "i"));
    } catch (e) { return null; }
  }

  function renderFindLayer() {
    var layer = el.findLayer;
    var errs = current ? (errMap[current] || {}) : {};
    var hasLens = errs && Object.keys(errs).length;
    if (!findState.open || !findState.q) {
      if (hasLens && current) {
        var src2 = el.editor.value;
        var lines2 = src2.split("\n");
        var out2 = "";
        for (var li = 0; li < lines2.length; li++) {
          var er = errs[li + 1];
          var html2 = esc(lines2[li]);
          if (er) {
            var cls2 = er.kind === "warning" ? "lens-warn" : "lens-err";
            html2 = '<span class="' + cls2 + '" title="' + esc(er.msg) + '">' + (html2 || " ") + "</span>";
          }
          out2 += html2;
          if (li < lines2.length - 1) out2 += "\n";
        }
        el.findPre.innerHTML = out2;
        layer.style.display = "";
        layer.scrollTop = el.editor.scrollTop;
        layer.scrollLeft = el.editor.scrollLeft;
        return;
      }
      layer.style.display = "none"; return;
    }
    var src = el.editor.value;
    var re = findRegex();
    var out = "", last = 0, k = 0;
    findState.matches = [];
    if (re) {
      var m;
      while (k < 10000 && (m = re.exec(src))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        findState.matches.push({ s: m.index, e: m.index + m[0].length });
        k++;
      }
    }
    findState.matches.forEach(function (mm, i) {
      out += esc(src.slice(last, mm.s)) +
        '<span class="fm' + (i === findState.idx ? " cur" : "") + '">' +
        esc(src.slice(mm.s, mm.e)) + "</span>";
      last = mm.e;
    });
    out += esc(src.slice(last));
    if (hasLens) {
      var parts = out.split("\n");
      var rebuilt = "";
      for (var pi = 0; pi < parts.length; pi++) {
        var er2 = errs[pi + 1];
        var seg = parts[pi];
        if (er2) {
          var cls3 = er2.kind === "warning" ? "lens-warn" : "lens-err";
          seg = '<span class="' + cls3 + '" title="' + esc(er2.msg) + '">' + (seg || " ") + "</span>";
        }
        rebuilt += seg;
        if (pi < parts.length - 1) rebuilt += "\n";
      }
      out = rebuilt;
    }
    el.findPre.innerHTML = out || "";
    layer.style.display = "";
    layer.scrollTop = el.editor.scrollTop;
    layer.scrollLeft = el.editor.scrollLeft;
    updateFindCount();
  }

  function updateFindCount() {
    el.findCount.textContent = findState.matches.length ?
      (findState.idx + 1) + "/" + findState.matches.length : "no matches";
  }

  function scrollToMatch(mm) {
    var src = el.editor.value;
    var ln = 1, pos;
    for (var i = 0; i < src.length && i < mm.s; i++) if (src[i] === "\n") ln++;
    var lh = LH();
    el.editor.scrollTop = Math.max(0, (ln - 1) * lh - el.editor.clientHeight / 2 + lh / 2);
    syncScroll();
  }

  function goFind(dir) {
    if (!findState.matches.length) { updateFindCount(); return; }
    findState.idx = (findState.idx + dir + findState.matches.length) % findState.matches.length;
    var mm = findState.matches[findState.idx];
    el.editor.focus();
    el.editor.setSelectionRange(mm.s, mm.e);
    scrollToMatch(mm);
    renderFindLayer();
  }

  function setFindResult() {
    renderFindLayer();
    if (findState.matches.length) {
      findState.idx = 0;
      var mm = findState.matches[0];
      el.editor.setSelectionRange(mm.s, mm.e);
      scrollToMatch(mm);
    } else {
      el.editor.setSelectionRange(el.editor.selectionStart, el.editor.selectionStart);
    }
  }

  function openFind() {
    findState.open = true;
    el.findBar.hidden = false;
    el.findInp.value = findState.q;
    el.findRepl.value = findState.repl;
    el.findCase.checked = findState.case;
    if (!findState.q) {
      var sel = el.editor.value.slice(el.editor.selectionStart, el.editor.selectionEnd);
      if (sel && !/\n/.test(sel)) { findState.q = sel; el.findInp.value = sel; }
    }
    setFindResult();
    if (findState.q) doGlobalSearch(findState.q);
    else if (el.searchResults) { el.searchResults.hidden = true; el.searchResults.innerHTML = ""; }
    el.findInp.focus();
    el.findInp.select();
  }

  function closeFind() {
    findState.open = false;
    el.findBar.hidden = true;
    el.findLayer.style.display = "none";
    if (el.searchResults) { el.searchResults.hidden = true; el.searchResults.innerHTML = ""; }
    render();
    el.editor.focus();
  }

  function replaceOne() {
    if (!findState.matches.length) return;
    var mm = findState.matches[findState.idx];
    el.editor.setRangeText(findState.repl, mm.s, mm.e, "select");
    var ev = new Event("input", { bubbles: true });
    el.editor.dispatchEvent(ev);
    setFindResult();
  }

  function replaceAll() {
    if (!findState.matches.length) return;
    var v = el.editor.value;
    var out = "", last = 0;
    findState.matches.forEach(function (mm) {
      out += v.slice(last, mm.s) + findState.repl;
      last = mm.e;
    });
    out += v.slice(last);
    el.editor.value = out;
    files[current] = out;
    dirty.add(current);
    var ev = new Event("input", { bubbles: true });
    el.editor.dispatchEvent(ev);
    setFindResult();
  }

  /* ---------- editor navigation ---------- */
  function jumpToLine(line) {
    var src = el.editor.value;
    var lines = src.split("\n");
    if (line < 1) line = 1;
    if (line > lines.length) line = lines.length;
    var pos = 0;
    for (var i = 0; i < line - 1; i++) pos += lines[i].length + 1;
    el.editor.focus();
    el.editor.setSelectionRange(pos, pos);
    var lh = LH();
    el.editor.scrollTop = Math.max(0, (line - 1) * lh - el.editor.clientHeight / 2 + lh / 2);
    syncScroll();
    var g = el.gutter.children[line - 1];
    if (g) {
      g.classList.add("flash");
      setTimeout(function () { g.classList.remove("flash"); }, 600);
    }
    updateStatus();
  }

  /* ---------- persist / restore ---------- */
  function persist() {
    var docs = {};
    files.forEach(function (f) {
      if (files[f] !== undefined || dirty.has(f)) {
        docs[f] = { c: files[f] || "", d: dirty.has(f) };
        if (argsMap[f]) docs[f].a = argsMap[f];
      }
    });
    try {
      localStorage.setItem(LS + "state", JSON.stringify({
        tabs: files, docs: docs, current: current,
        wrap: prefs.wrap, theme: prefs.theme, size: prefs.size,
        sidebarVisible: prefs.sidebarVisible, consoleVisible: prefs.consoleVisible
      }));
    } catch (e) {}
  }

  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 1000);
  }

  function flushPersist() {
    clearTimeout(persistTimer);
    persist();
  }

  function restoreState() {
    var st = null;
    try { st = JSON.parse(localStorage.getItem(LS + "state")); } catch (e) {}
    if (!st) return;
    prefs.wrap = !!st.wrap;
    prefs.theme = st.theme === "light" ? "light" : "dark";
    prefs.size = Math.min(32, Math.max(10, +st.size || 14));
    if (typeof st.sidebarVisible === "boolean") prefs.sidebarVisible = st.sidebarVisible;
    if (typeof st.consoleVisible === "boolean") prefs.consoleVisible = st.consoleVisible;
    applyPrefs();
    if (Array.isArray(st.tabs) && st.tabs.length) {
      files = st.tabs.slice();
      files.forEach(function (f) {
        if (st.docs && st.docs[f]) {
          files[f] = st.docs[f].c || "";
          if (st.docs[f].d) dirty.add(f);
          if (st.docs[f].a) argsMap[f] = st.docs[f].a;
        }
      });
      current = typeof st.current === "string" && files.indexOf(st.current) >= 0 ?
        st.current : files[files.length - 1];
    }
  }

  /* ---------- console ops & export ---------- */
  function copyConsole() {
    var txt = el.console.innerText;
    if (!txt) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).catch(function () {});
      return;
    }
    var ta = document.createElement("textarea");
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    ta.remove();
  }

  function dlZip() {
    var a = document.createElement("a");
    a.href = "/api/export?as=workspace";
    a.download = "workspace.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function dlCurrent() {
    if (!current) return notify("Open or create a file first.");
    var blob = new Blob([files[current] || ""], { type: "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = current.split("/").pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- events ---------- */
  el.editor.addEventListener("input", function () {
    if (files[current] !== undefined) files[current] = el.editor.value;
    if (files[current] !== undefined) dirty.add(current);
    render();
  });

  var prevScroll = 0;
  function syncScroll() {
    if (el.editor.scrollTop !== prevScroll) {
      prevScroll = el.editor.scrollTop;
      el.hl.scrollTop = el.editor.scrollTop;
      el.gutter.scrollTop = el.editor.scrollTop;
      if (findState.open) {
        el.findLayer.scrollTop = el.editor.scrollTop;
        el.findLayer.scrollLeft = el.editor.scrollLeft;
      }
    }
    if (el.hl.scrollLeft !== el.editor.scrollLeft) {
      el.hl.scrollLeft = el.editor.scrollLeft;
    }
  }
  el.editor.addEventListener("scroll", syncScroll);

  el.editor.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.keyCode === 13)) {
      e.preventDefault();
      run();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      openFind();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "h" || e.key === "H")) {
      e.preventDefault();
      openFind();
      el.findRepl.focus();
      el.findRepl.select();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "/") {
      e.preventDefault();
      var ta = el.editor;
      var lang = langOf(current);
      var comm = lang === "cpp" ? "// " : "# ";
      var s = ta.selectionStart, ee = ta.selectionEnd;
      var val = ta.value;
      var ls = val.lastIndexOf("\n", s - 1) + 1;
      var le = val.indexOf("\n", ee);
      if (le < 0) le = val.length;
      var block = val.slice(ls, le);
      var lines = block.split("\n");
      var allComm = lines.every(function (ln) { return !ln.trim() || ln.trim().startsWith(comm.trim()); });
      var out = lines.map(function (ln) {
        if (!ln.trim()) return ln;
        var ind = (ln.match(/^[ \t]*/) || [""])[0];
        var rest = ln.slice(ind.length);
        if (allComm) {
          if (rest.startsWith(comm)) return ind + rest.slice(comm.length);
          if (rest.startsWith(comm.trim())) return ind + rest.slice(comm.trim().length).replace(/^ /, "");
          return ln;
        } else {
          return ind + comm + rest;
        }
      }).join("\n");
      ta.setRangeText(out, ls, le, "end");
      var ev2 = new Event("input", { bubbles: true });
      ta.dispatchEvent(ev2);
      return;
    }
    var PAIRS = { "(": ")", "[": "]", "{": "}", "\"": "\"", "'": "'", "<": ">" };
    if (!e.ctrlKey && !e.metaKey && !e.altKey && PAIRS[e.key] && !e.shiftKey || (e.key === '"' || e.key === "'")) {
      var ta2 = el.editor;
      var s2 = ta2.selectionStart, e2 = ta2.selectionEnd;
      var close = PAIRS[e.key] || e.key;
      if (s2 !== e2) {
        e.preventDefault();
        var sel = ta2.value.slice(s2, e2);
        ta2.setRangeText(e.key + sel + close, s2, e2, "end");
        ta2.setSelectionRange(s2 + 1, e2 + 1);
        var ev3 = new Event("input", { bubbles: true });
        ta2.dispatchEvent(ev3);
        return;
      } else {
        var nxt = ta2.value[s2] || "";
        if (nxt === close && (e.key === '"' || e.key === "'" || e.key === ")" || e.key === "]" || e.key === "}")) {
          e.preventDefault();
          ta2.setSelectionRange(s2 + 1, s2 + 1);
          return;
        }
        if (e.key === "(" || e.key === "[" || e.key === "{" || e.key === '"' || e.key === "'") {
          e.preventDefault();
          ta2.setRangeText(e.key + close, s2, e2, "end");
          ta2.setSelectionRange(s2 + 1, s2 + 1);
          var ev4 = new Event("input", { bubbles: true });
          ta2.dispatchEvent(ev4);
          syncScroll();
          render();
          return;
        }
      }
    }
    if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      var ta = el.editor;
      var s = ta.selectionStart;
      if (s === ta.selectionEnd && s > 0) {
        var before = ta.value.slice(0, s);
        var after = ta.value.slice(s, s + 1);
        var pair = before[before.length - 1] + after;
        if (pair === "()" || pair === "[]" || pair === "{}" || pair === '""' || pair === "''" || pair === "<>") {
          e.preventDefault();
          ta.setRangeText("", s - 1, s + 1, "end");
          var ev = new Event("input", { bubbles: true });
          ta.dispatchEvent(ev);
          return;
        }
        var lineStart = before.lastIndexOf("\n") + 1;
        var col = s - lineStart;
        var indent = before.slice(lineStart);
        if (col >= 4 && col % 4 === 0 && /^[ \t]+$/.test(indent)) {
          e.preventDefault();
          ta.setRangeText("", s - 4, s, "end");
          var ev5 = new Event("input", { bubbles: true });
          ta.dispatchEvent(ev5);
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      var ta = el.editor;
      var s = ta.selectionStart;
      var before = ta.value.slice(0, s);
      var after = ta.value.slice(s);
      var lineStart = before.lastIndexOf("\n") + 1;
      var curLine = before.slice(lineStart);
      var indent = (/^[ \t]*/.exec(curLine) || [""])[0];
      var next = indent;
      var trimmed = curLine.trim();
      if (langOf(current) === "python" && trimmed.endsWith(":")) {
        next += "    ";
      } else if (langOf(current) === "cpp") {
        if (trimmed.endsWith("{")) next += "    ";
        else if (trimmed.startsWith("}") && indent.length >= 4) next = indent.slice(4);
      }
      if (after[0] === "}" || after[0] === ")" || after[0] === "]") {
        ta.setRangeText("\n" + next, s, ta.selectionEnd, "end");
        var mid = s + 1 + next.length;
        ta.setRangeText("\n" + indent, mid, mid, "end");
        ta.setSelectionRange(mid, mid);
        var ev6 = new Event("input", { bubbles: true });
        ta.dispatchEvent(ev6);
        syncScroll();
        render();
        return;
      }
      ta.setRangeText("\n" + next, s, ta.selectionEnd, "end");
      var ev = new Event("input", { bubbles: true });
      ta.dispatchEvent(ev);
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      var s = el.editor.selectionStart;
      el.editor.setRangeText("    ", s, el.editor.selectionEnd, "end");
      var ev = new Event("input", { bubbles: true });
      el.editor.dispatchEvent(ev);
    } else if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      var ta3 = el.editor;
      var ss = ta3.selectionStart;
      var bef = ta3.value.slice(0, ss);
      var lst2 = bef.lastIndexOf("\n") + 1;
      if (ta3.value.slice(lst2, ss).startsWith("    ")) {
        ta3.setRangeText("", lst2, lst2 + 4, "end");
        var ev7 = new Event("input", { bubbles: true });
        ta3.dispatchEvent(ev7);
      }
    }
  });

  el.btnRun.addEventListener("click", run);
  el.btnLoad.addEventListener("click", loadCurrent);
  el.filePicker.addEventListener("change", function () {
    var f = el.filePicker.files && el.filePicker.files[0];
    if (f) handlePicked(f);
  });
  el.btnSave.addEventListener("click", saveCurrent);
  el.btnHistory.addEventListener("click", openHistory);
  el.editor.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      saveCurrent();
    }
  });

  el.btnWrap.addEventListener("click", function () {
    prefs.wrap = !prefs.wrap;
    applyWrap();
    persist();
    el.editor.focus();
  });
  el.btnTheme.addEventListener("click", function () {
    prefs.theme = prefs.theme === "light" ? "dark" : "light";
    applyPrefs();
    persist();
  });
  el.btnFontDec.addEventListener("click", function () {
    if (prefs.size <= 10) return;
    prefs.size--;
    applyPrefs();
    persist();
    render();
  });
  el.btnFontInc.addEventListener("click", function () {
    if (prefs.size >= 32) return;
    prefs.size++;
    applyPrefs();
    persist();
    render();
  });
  el.btnZip.addEventListener("click", dlZip);
  el.btnDl.addEventListener("click", dlCurrent);
  el.btnClear.addEventListener("click", function () { el.console.innerHTML = ""; });
  el.btnCopy.addEventListener("click", copyConsole);

  function syncArgsInput() {
    el.argsRow.classList.toggle("show", !!current);
    if (!current) el.inpArgs.value = "";
    else if (argsMap[current]) {
      el.inpArgs.value = argsMap[current].map(function(a){ return /\s/.test(a) ? '"' + a.replace(/"/g,'\\"') + '"' : a; }).join(" ");
    } else el.inpArgs.value = "";
  }
  el.inpArgs.addEventListener("input", function () {
    if (!current) return;
    var v = el.inpArgs.value.trim();
    argsMap[current] = v ? shlexSplit(v) : [];
    schedulePersist();
  });

  function doGlobalSearch(q) {
    if (!q || q.length < 2) { el.searchResults.hidden = true; el.searchResults.innerHTML = ""; return; }
    api("/api/search?q=" + encodeURIComponent(q)).then(function (j) {
      var hits = j.hits || [];
      if (!hits.length) {
        el.searchResults.hidden = false;
        el.searchResults.innerHTML = '<div style="color:var(--dim);padding:4px">no workspace matches</div>';
        return;
      }
      var h = "";
      hits.forEach(function (hit) {
        h += '<div class="search-hit" data-file="' + esc(hit.file) + '" data-line="' + hit.line + '">' +
          '<span class="search-hit-file">' + esc(hit.file) + ':' + hit.line + '</span>' +
          '<span class="search-hit-text">' + esc(hit.text) + '</span></div>';
      });
      el.searchResults.hidden = false;
      el.searchResults.innerHTML = h;
    }).catch(function () { el.searchResults.hidden = true; });
  }

  el.findInp.addEventListener("input", function () {
    findState.q = el.findInp.value;
    setFindResult();
    doGlobalSearch(findState.q);
  });
  el.findRepl.addEventListener("input", function () { findState.repl = el.findRepl.value; });
  el.findCase.addEventListener("change", function () {
    findState.case = el.findCase.checked;
    setFindResult();
  });
  el.findPrev.addEventListener("click", function () { goFind(-1); });
  el.findNext.addEventListener("click", function () { goFind(1); });
  el.findRep.addEventListener("click", replaceOne);
  el.findRepall.addEventListener("click", replaceAll);
  el.findClose.addEventListener("click", closeFind);
  if (el.searchResults) {
    el.searchResults.addEventListener("click", function (e) {
      var hit = e.target.closest(".search-hit");
      if (!hit) return;
      var file = hit.getAttribute("data-file");
      var line = +hit.getAttribute("data-line");
      var go = function () { jumpToLine(line); };
      if (file !== current) openFile(file, go);
      else go();
    });
  }
  el.findInp.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); goFind(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  el.findRepl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); replaceOne(); }
    else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });

  el.editor.addEventListener("keyup", updateStatus);
  el.editor.addEventListener("click", updateStatus);
  el.editor.addEventListener("select", updateStatus);

  el.console.addEventListener("click", function (e) {
    var t = e.target.closest(".errline") || e.target.closest(".warnline");
    if (!t) return;
    var line = +t.getAttribute("data-line");
    var file = t.getAttribute("data-file");
    var go = function () { jumpToLine(line); };
    if (file && file !== current) openFile(file, go);
    else go();
  });

  el.btnToggleSidebar.addEventListener("click", toggleSidebar);
  el.btnToggleConsole.addEventListener("click", toggleConsole);
  el.handleSidebar.addEventListener("click", toggleSidebar);
  el.handleConsole.addEventListener("click", toggleConsole);
  el.backdrop.addEventListener("click", function () {
    if (prefs.sidebarVisible) toggleSidebar();
  });
  el.sidebar.addEventListener("transitionend", onLayoutTransitionEnd);
  el.consolePanel.addEventListener("transitionend", onLayoutTransitionEnd);
  window.addEventListener("resize", function () { applySidebarState(); });
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "F" || e.key === "f")) {
      e.preventDefault();
      openFind();
      if (el.findInp) { el.findInp.focus(); el.findInp.select(); }
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === "b" && !e.shiftKey) {
      e.preventDefault();
      toggleSidebar();
    } else if ((k === "j" || e.key === "`" || e.code === "Backquote") && !e.shiftKey) {
      e.preventDefault();
      toggleConsole();
    }
  });

  el.btnEof.addEventListener("click", function () {
    if (!running || !curSid) return;
    var sid = curSid;
    curSid = null;
    el.stdinInp.disabled = true;
    el.btnEof.disabled = true;
    api("/api/input", { json: { id: sid, eof: true } }).catch(function () {});
  });
  el.stdinInp.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    var line = el.stdinInp.value;
    el.stdinInp.value = "";
    if (!running || !curSid) return;
    api("/api/input", { json: { id: curSid, line: line } }).catch(function () {});
  });
  el.btnNew.addEventListener("click", newFile);
  el.btnCreate.addEventListener("click", function () {
    var n = el.inpName.value.trim();
    if (n) createFile(n);
  });
  el.inpName.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); if (el.inpName.value.trim()) createFile(el.inpName.value.trim()); }
  });

  if (el.toolbar) {
    el.toolbar.addEventListener("click", function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      e.preventDefault();
      var ins = btn.getAttribute("data-ins");
      var isTab = btn.hasAttribute("data-tab");
      var isUndo = btn.hasAttribute("data-undo");
      var arrow = btn.getAttribute("data-arrow");
      var ta = el.editor;
      ta.focus();
      if (isTab) {
        var s = ta.selectionStart;
        ta.setRangeText("    ", s, ta.selectionEnd, "end");
        var ev = new Event("input", { bubbles: true });
        ta.dispatchEvent(ev);
        syncScroll(); render();
        return;
      }
      if (isUndo) {
        try { document.execCommand("undo"); } catch (err) {}
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        syncScroll(); render();
        return;
      }
      if (arrow) {
        var d = parseInt(arrow, 10);
        var pos = ta.selectionStart;
        var np = Math.max(0, Math.min(ta.value.length, pos + d));
        ta.setSelectionRange(np, np);
        updateStatus();
        syncScroll();
        return;
      }
      if (ins !== null) {
        var s2 = ta.selectionStart, e2 = ta.selectionEnd;
        ta.setRangeText(ins, s2, e2, "end");
        var ev2 = new Event("input", { bubbles: true });
        ta.dispatchEvent(ev2);
        syncScroll(); render();
      }
    });
  }

  if (el.btnStdinFile) {
    el.btnStdinFile.addEventListener("click", function () { el.stdinFile.click(); });
  }
  if (el.stdinFile) {
    el.stdinFile.addEventListener("change", function () {
      var f = el.stdinFile.files && el.stdinFile.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () { el.inpStdin.value = String(r.result || ""); };
      r.readAsText(f);
    });
  }
  if (el.btnStdinClear) {
    el.btnStdinClear.addEventListener("click", function () { el.inpStdin.value = ""; el.stdinFile.value = ""; });
  }

  function refresh() {
    if ("serviceWorker" in navigator) {
      try { navigator.serviceWorker.register("/sw.js"); } catch (e) {}
    }
    api("/api/files").then(function (j) {
      var joined = j.files.slice();
      files.forEach(function (f) {
        if (files[f] !== undefined && joined.indexOf(f) < 0) joined.push(f);
      });
      files = joined;
      if (current && !files.includes(current)) current = null;
      if (!current && files.length) {
        current = files[files.length - 1];
        if (files[current] === undefined) {
          api("/api/file?name=" + encodeURIComponent(current)).then(function (r) {
            files[current] = r.content;
            render();
          });
        }
      }
      render();
      flushPersist();
    });
  }

  window.addEventListener("beforeunload", function (e) {
    flushPersist();
    if (dirty.size) { e.preventDefault(); e.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushPersist();
  });

  applyPrefs();
  restoreState();
  render();
  refresh();
})();
