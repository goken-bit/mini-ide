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
    runState: $("run-state"),
    runStats: $("run-stats"),
    console: $("console-out")
  };

  const LS = "minide.files.";
  let files = [];
  let current = null;
  let dirty = new Set();
  let errMap = {};        // filename -> {line: {col, msg}}
  let running = false;
  let runSeq = 0;

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

  function render() {
    var src = current && files[current] !== undefined ? files[current] : "";
    if (el.editor.value !== src) el.editor.value = src;
    var lang = current ? langOf(current) : null;
    el.hlCode.innerHTML = highlight(src, lang);
    el.hl.scrollTop = el.editor.scrollTop;
    el.hl.scrollLeft = el.editor.scrollLeft;
    buildGutter(src, lang);
    buildTabs();
    buildList();
    document.title = (dirty.has(current) ? "* " : "") + (current || "MiniIDE") + " — MiniIDE";
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
      var cls = errs[i] ? "err" : "";
      h += "<div" + (cls ? " class=\"" + cls + "\"" : "") + ">" + i + "</div>";
    }
    el.gutter.innerHTML = h;
    if (lang === "cpp" && n < 1000) {
      if (el.gutter.scrollHeight < el.gutter.clientHeight) {
        el.gutter.style.height = (n * 21 + 16) + "px";
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
    files.forEach(function (f) {
      h += '<li data-f="' + esc(f) + '" class="' + (f === current ? "active " : "") +
        (errMap[f] ? "error-file" : "") + '">' +
        '<span class="fname">' + esc(f) + (dirty.has(f) ? " \u25CF" : "") + "</span>" +
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

  function openFile(name) {
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
        }).catch(function (e) { console.error(e); files[current] = ""; render(); });
      }
    }
    render();
  }

  function closeTab(name) {
    if (name === current) current = null;
    files.splice(files.indexOf(name), 1);
    dirty.delete(name);
    delete errMap[name];
    var idx = current ? files.indexOf(current) : -1;
    if (current && idx >= 0) current = files[idx];
    else if (files.length) current = files[files.length - 1];
    render();
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
    }).catch(function (e) { alert(e.message); });
  }

  function deleteFile(n) {
    if (!confirm("Delete " + n + "?")) return;
    api("/api/files", { json: { action: "delete", name: n } }).then(function (j) {
      files = j.files;
      if (n === current) current = null;
      dirty.delete(n);
      delete errMap[n];
      if (files.length && !current) current = files[files.length - 1];
      render();
    }).catch(function (e) { alert(e.message); });
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
    }).catch(function (e) { alert(e.message); });
  }

  /* ---------- run ---------- */
  function log(html) {
    var d = document.createElement("div");
    d.innerHTML = html;
    el.console.appendChild(d);
    el.console.scrollTop = el.console.scrollHeight;
  }

  function run() {
    if (running) return;
    if (!current) return alert("Open or create a file first");
    var f = current;
    if (!files[f] && files[f] !== "") return alert("File not loaded yet");
    return saveFile(f).then(function () {
      running = true;
      runSeq++;
      var my = runSeq;
      errMap[f] = {};
      el.btnRun.disabled = true;
      el.btnRun.classList.add("running");
      el.runState.textContent = "running...";
      el.runState.className = "running";
      el.runStats.textContent = "";
      el.console.innerHTML = "";
      log("<div class='out-ln'>\u25B8 run " + esc(f) + "</div>");
      api("/api/run", { json: { path: f } }).then(function (r) {
        if (my !== runSeq) return;
        render();
        r.stdout.split("\n").forEach(function (ln) { if (ln) log("<div class='out-ln'>" + esc(ln) + "</div>"); });
        r.stderr.split("\n").forEach(function (ln) { if (ln) log("<div class='err-ln'>" + esc(ln) + "</div>"); });
        if (r.errors && r.errors.length) {
          errMap[f] = {};
          r.errors.forEach(function (e) {
            errMap[f][e.line] = e;
            var col = e.col ? ":" + e.col : "";
            log("<div class='errline'>" + esc(f) + col + ": " + esc(e.msg) + "</div>");
          });
        } else {
          errMap[f] = {};
        }
        log("<div class='out-ln'>\u23F1 exit " + r.exit_code + " in " + r.duration_ms + " ms</div>");
        el.runState.textContent = r.exit_code === 0 ? "OK" : "exit " + r.exit_code;
        el.runState.className = r.exit_code === 0 ? "ok" : "fail";
        el.runStats.textContent = r.duration_ms + " ms";
        render();
      }).catch(function (e) {
        if (e.status === 409) log("<div class='err-ln'>" + esc(e.message) + "</div>");
        else log("<div class='err-ln'>" + esc(e.message) + "</div>");
        el.runState.textContent = "error";
        el.runState.className = "fail";
      }).then(function () {
        running = false;
        el.btnRun.disabled = false;
        el.btnRun.classList.remove("running");
        if (my === runSeq && !el.runState.textContent) {
          el.runState.textContent = "idle";
          el.runState.className = "idle";
        }
      });
    });
  }

  function saveFile(name) {
    var content = files[name] || "";
    return api("/api/files", { json: { action: "save", name: name, content: content } }).then(function () {
      dirty.delete(name);
      render();
    });
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      var ta = el.editor;
      var s = ta.selectionStart;
      var before = ta.value.slice(0, s);
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
    }
  });

  el.btnRun.addEventListener("click", run);
  el.btnNew.addEventListener("click", newFile);
  el.btnCreate.addEventListener("click", function () {
    var n = el.inpName.value.trim();
    if (n) createFile(n);
  });
  el.inpName.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); if (el.inpName.value.trim()) createFile(el.inpName.value.trim()); }
  });

  function refresh() {
    api("/api/files").then(function (j) {
      files = j.files;
      if (current && !files.includes(current)) current = null;
      if (!current && files.length) {
        current = files[files.length - 1];
        api("/api/file?name=" + encodeURIComponent(current)).then(function (r) {
          files[current] = r.content;
          render();
        });
      }
      render();
    });
  }

  window.addEventListener("beforeunload", function (e) {
    if (dirty.size) { e.preventDefault(); e.returnValue = ""; }
  });

  refresh();
})();
