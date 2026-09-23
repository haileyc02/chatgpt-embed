"use strict";

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, Platform, Modal, setIcon } = require("obsidian");

const VIEW_TYPE = "chatgpt-embed-view";

const PARTITION = "persist:chatgpt-embed";

// Google blocks sign-in from embedded Chromium/Electron. A Firefox UA often gets through,
// but only apply it on Google's pages.
const UA_FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0";
const UA_CHROME_OLD =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const DEFAULT_SETTINGS = {
  url: "https://chatgpt.com/",
  openLocation: "right", // "right" | "tab"
  zoom: 1.0,
  userAgent: "", // empty = auto: a clean Chrome UA matching Obsidian's real Chromium version
  googleFirefoxUA: true, // only on accounts.google.com, to get past "browser may not be secure"
  chromePath: "", // empty = auto-detect
};

// ---------- "Log in with Chrome" (CDP) helpers ----------
// We launch a normal Chrome (not automation-controlled, so Google allows sign-in) with a
// separate profile and a local debugging port, wait until the user is logged in to ChatGPT,
// read the cookies over the Chrome DevTools Protocol, and copy them into Obsidian.

function defaultChromePaths() {
  const os = require("os");
  const path = require("path");
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (process.platform === "win32") {
    const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] || "";
    return [
      path.join(pf, "Google/Chrome/Application/chrome.exe"),
      path.join(pf86, "Google/Chrome/Application/chrome.exe"),
      path.join(local, "Google/Chrome/Application/chrome.exe"),
      path.join(pf86, "Microsoft/Edge/Application/msedge.exe"),
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

function findChrome(custom) {
  const fs = require("fs");
  const list = custom ? [custom] : defaultChromePaths();
  return list.find((p) => {
    try { return fs.existsSync(p); } catch (e) { return false; }
  });
}

// Talks to Chrome over --remote-debugging-pipe (fd 3 = to Chrome, fd 4 = from Chrome).
// No network port, no origin checks.
class ChromePipe {
  constructor(proc) {
    this.proc = proc;
    this.buf = "";
    this.id = 0;
    this.pending = new Map();
    proc.stdio[4].on("data", (d) => {
      this.buf += d.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const raw = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { continue; }
        const cb = msg.id && this.pending.get(msg.id);
        if (cb) { this.pending.delete(msg.id); cb(msg); }
      }
    });
  }
  call(method, params, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(method + " timeout")); }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(t);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      });
      try {
        this.proc.stdio[3].write(JSON.stringify({ id, method, params: params || {} }) + "\0");
      } catch (e) {
        clearTimeout(t); this.pending.delete(id); reject(e);
      }
    });
  }
}

const isChatGPTDomain = (d) => {
  d = (d || "").replace(/^\./, "");
  return d === "chatgpt.com" || d.endsWith(".chatgpt.com");
};
const isSessionCookie = (name) => name.startsWith("__Secure-next-auth.session-token");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function autoChromeUA() {
  const ver = (process.versions && process.versions.chrome) || "128.0.0.0";
  const major = ver.split(".")[0];
  const os =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function isGoogleLogin(url) {
  try {
    const h = new URL(url).hostname;
    return h === "accounts.google.com" || h.endsWith(".accounts.google.com");
  } catch (e) {
    return false;
  }
}

const SESSION_NAME = "__Secure-next-auth.session-token";

// Clean a value copied from DevTools: trim whitespace/newlines and surrounding quotes.
function cleanValue(v) {
  return String(v || "").replace(/\s+/g, "").replace(/^"(.*)"$/, "$1");
}

// Accepts many formats and returns [{name, value, ...}]:
//  - JSON exported by cookie extensions (Cookie-Editor, EditThisCookie): [{name, value, domain, ...}]
//  - Rows copied from DevTools' Cookies table (tab-separated: name<TAB>value<TAB>domain...)
//  - "name=value; name2=value2" (also a raw "Cookie:" header)
//  - a bare token value (treated as the unchunked session token)
function parseCookieInput(text) {
  text = (text || "").trim();
  if (!text) return [];

  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      let arr = JSON.parse(text);
      if (!Array.isArray(arr)) arr = arr.cookies || [arr];
      return arr
        .filter((c) => c && c.name && c.value != null)
        .filter((c) => !c.domain || isChatGPTDomain(c.domain))
        .map((c) => ({ name: c.name, value: cleanValue(c.value) }));
    } catch (e) {
      /* fall through */
    }
  }

  if (text.includes("\t")) {
    return text
      .split(/\r?\n/)
      .map((row) => row.split("\t"))
      .filter((cols) => cols.length >= 2 && cols[0].trim() && cols[1].trim())
      .map((cols) => ({ name: cols[0].trim(), value: cleanValue(cols[1]) }));
  }

  text = text.replace(/^cookie:\s*/i, "");
  if (/^[\w.\-]+=/.test(text)) {
    return text
      .split(/;\s*/)
      .map((pair) => {
        const i = pair.indexOf("=");
        return i > 0 ? { name: pair.slice(0, i).trim(), value: cleanValue(pair.slice(i + 1)) } : null;
      })
      .filter((c) => c && c.name && c.value);
  }

  return [{ name: SESSION_NAME, value: cleanValue(text) }];
}

function getElectronSession() {
  try {
    const electron = require("electron");
    const remote = electron.remote || require("@electron/remote");
    return remote.session.fromPartition(PARTITION);
  } catch (e) {
    return null;
  }
}

class TextModal extends Modal {
  constructor(app, title, text) {
    super(app);
    this.title = title;
    this.text = text;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "这里只有 Cookie 的名字，没有 Cookie 的值，可以放心截图或复制发出去。",
    });
    const pre = contentEl.createEl("pre", { cls: "chatgpt-embed-diag", text: this.text });
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "复制", cls: "mod-cta" }).addEventListener("click", async () => {
      await navigator.clipboard.writeText(this.text);
      new Notice("已复制");
    });
  }
  onClose() { this.contentEl.empty(); }
}

class CookieImportModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("chatgpt-embed-cookie-modal");
    contentEl.createEl("h3", { text: "用 Cookie 登录 ChatGPT" });

    const steps = contentEl.createEl("ol");
    [
      "在 Chrome 里打开 chatgpt.com 并确认已登录。",
      "按 Cmd+Option+I（Windows：F12）打开开发者工具 → Application → 左侧 Cookies → https://chatgpt.com。",
      "在右上角筛选框输入 session-token，会看到 .0 和 .1 两行。",
      "分别双击每一行的 Value 那一格 → Cmd+A 全选 → Cmd+C 复制，粘贴到下面对应的框里。",
    ].forEach((t) => steps.createEl("li", { text: t }));

    const mkField = (label, placeholder) => {
      const wrap = contentEl.createDiv({ cls: "chatgpt-embed-field" });
      wrap.createEl("label", { text: label });
      const ta = wrap.createEl("textarea", { cls: "chatgpt-embed-cookie-input" });
      ta.placeholder = placeholder;
      ta.rows = 3;
      const hint = wrap.createDiv({ cls: "chatgpt-embed-hint" });
      ta.addEventListener("input", () => {
        const v = cleanValue(ta.value);
        hint.setText(v ? `已粘贴 ${v.length} 个字符` : "");
      });
      return ta;
    };
    const f0 = mkField(SESSION_NAME + ".0", "粘贴 .0 的 Value（通常以 eyJ 开头，约 3000–4000 个字符）");
    const f1 = mkField(SESSION_NAME + ".1", "粘贴 .1 的 Value（比 .0 短）");

    // Advanced: any other format
    const details = contentEl.createEl("details", { cls: "chatgpt-embed-advanced" });
    details.createEl("summary", { text: "其他格式（只有一个 session-token / Cookie-Editor 导出的 JSON / 从表格复制的整行）" });
    const fx = details.createEl("textarea", { cls: "chatgpt-embed-cookie-input" });
    fx.rows = 4;
    fx.placeholder = "支持：\n• 只有一个 __Secure-next-auth.session-token 时，直接粘贴它的值\n• Cookie-Editor 扩展导出的 JSON\n• name=value; name2=value2";

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Cookie 等同于你的登录凭证：只会写进 Obsidian 内嵌浏览器，不会保存在插件设置或笔记库里。不要发给任何人。",
    });

    const status = contentEl.createDiv({ cls: "chatgpt-embed-status" });
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    const ok = row.createEl("button", { text: "登录", cls: "mod-cta" });

    ok.addEventListener("click", async () => {
      let cookies = [];
      const v0 = cleanValue(f0.value);
      const v1 = cleanValue(f1.value);
      if (v0) cookies.push({ name: SESSION_NAME + ".0", value: v0 });
      if (v1) cookies.push({ name: SESSION_NAME + ".1", value: v1 });
      if (fx.value.trim()) cookies = cookies.concat(parseCookieInput(fx.value));

      if (!cookies.some((c) => isSessionCookie(c.name))) {
        status.setText("❌ 没有填 session-token。请至少粘贴 .0 的值。");
        return;
      }
      if (v1 && !v0) {
        status.setText("❌ 只填了 .1，还需要 .0。");
        return;
      }
      if (v0 && !v0.startsWith("eyJ")) {
        status.setText("⚠️ .0 的值通常以 eyJ 开头，请确认复制的是 Value 列、而且复制完整。仍会尝试登录…");
      } else if (v0 && !v1 && v0.length > 3500) {
        status.setText("⚠️ .0 很长，通常还需要 .1。仍会尝试登录…");
      } else {
        status.setText("正在登录…");
      }

      ok.disabled = true;
      this.plugin.loginLog = [];
      try {
        const good = await this.plugin.importCookies(cookies);
        if (good) {
          new Notice("Cookie 已导入，正在打开 ChatGPT…", 5000);
          this.close();
        } else {
          status.setText("❌ 写入失败。请运行命令「诊断登录问题」并截图。");
        }
      } finally {
        ok.disabled = false;
      }
    });
  }
  onClose() {
    this.contentEl.empty();
  }
}

class ChatGPTView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.webview = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "ChatGPT"; }
  getIcon() { return "message-square"; }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass("chatgpt-embed-container");

    // Toolbar
    const bar = container.createDiv({ cls: "chatgpt-embed-toolbar" });
    const btn = (icon, label, onClick) => {
      const b = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.addEventListener("click", onClick);
      return b;
    };
    btn("arrow-left", "后退", () => this.webview?.canGoBack() && this.webview.goBack());
    btn("arrow-right", "前进", () => this.webview?.canGoForward() && this.webview.goForward());
    btn("rotate-cw", "刷新", () => this.webview?.reload());
    btn("home", "回到首页", () => this.webview?.loadURL(this.plugin.settings.url));
    btn("external-link", "在浏览器中打开", () => {
      const u = this.webview?.getURL?.() || this.plugin.settings.url;
      window.open(u);
    });
    btn("log-in", "用 Chrome 登录（推荐，Google 账号用这个）", () => this.plugin.loginWithChrome());
    btn("key-round", "手动导入登录 Cookie", () =>
      new CookieImportModal(this.app, this.plugin).open()
    );

    // Electron <webview>: iframes don't work because chatgpt.com forbids framing.
    const wv = document.createElement("webview");
    wv.addClass("chatgpt-embed-webview");
    wv.setAttribute("src", this.plugin.settings.url);
    wv.setAttribute("partition", PARTITION); // keeps you logged in
    wv.setAttribute("allowpopups", "");
    const baseUA = this.plugin.settings.userAgent || autoChromeUA();
    wv.setAttribute("useragent", baseUA);
    container.appendChild(wv);
    this.webview = wv;

    // Swap UA per site: Firefox UA only for Google sign-in, normal Chrome UA everywhere else
    // (a Firefox UA on chatgpt.com trips Cloudflare and the page never loads).
    let currentUA = baseUA;
    const onNav = (e) => {
      if (e.isMainFrame === false || !e.url) return;
      const want = this.plugin.settings.googleFirefoxUA && isGoogleLogin(e.url) ? UA_FIREFOX : baseUA;
      if (want === currentUA) return;
      currentUA = want;
      try {
        wv.stop();
        wv.setUserAgent(want);
        wv.loadURL(e.url);
      } catch (err) {
        console.error("chatgpt-embed: UA switch failed", err);
      }
    };
    wv.addEventListener("did-start-navigation", onNav);
    wv.addEventListener("did-redirect-navigation", onNav);

    wv.addEventListener("dom-ready", () => {
      try { wv.setZoomFactor(Number(this.plugin.settings.zoom) || 1); } catch (e) {}
    });
  }

  async onClose() {
    this.webview = null;
    this.contentEl.empty();
  }
}

class ChatGPTEmbedPlugin extends Plugin {
  async onload() {
    if (!Platform.isDesktopApp) {
      new Notice("ChatGPT Embed 只支持桌面版 Obsidian");
      return;
    }
    await this.loadSettings();
    this.loginLog = [];

    this.registerView(VIEW_TYPE, (leaf) => new ChatGPTView(leaf, this));

    this.addRibbonIcon("message-square", "打开 ChatGPT", () => this.activateView());

    this.addCommand({
      id: "open-chatgpt",
      name: "打开 ChatGPT",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "open-chatgpt-in-tab",
      name: "在新标签页打开 ChatGPT",
      callback: () => this.activateView("tab"),
    });
    this.addCommand({
      id: "open-chatgpt-in-sidebar",
      name: "在右侧边栏打开 ChatGPT",
      callback: () => this.activateView("right"),
    });

    this.addCommand({
      id: "login-with-chrome",
      name: "用 Chrome 登录 ChatGPT（自动同步登录状态）",
      callback: () => this.loginWithChrome(),
    });

    this.addCommand({
      id: "diagnose-login",
      name: "诊断登录问题",
      callback: async () => new TextModal(this.app, "ChatGPT Embed 诊断", await this.diagnostics()).open(),
    });

    this.addCommand({
      id: "import-chatgpt-cookie",
      name: "导入 ChatGPT 登录状态（Cookie）",
      callback: () => new CookieImportModal(this.app, this).open(),
    });

    this.addSettingTab(new ChatGPTSettingTab(this.app, this));
  }

  getWebviews() {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map((l) => l.view && l.view.webview)
      .filter(Boolean);
  }

  log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    this.loginLog.push(line);
    if (this.loginLog.length > 200) this.loginLog.shift();
    console.log("chatgpt-embed:", msg);
  }

  async loginWithChrome() {
    if (this._chromeLoginRunning) return new Notice("已经在等待 Chrome 登录了");
    this.loginLog = [];
    const chrome = findChrome(this.settings.chromePath);
    this.log("Chrome 路径: " + (chrome || "未找到"));
    if (!chrome) {
      new Notice("找不到 Chrome，请在插件设置里填写 Chrome 路径", 8000);
      return;
    }
    const path = require("path");
    const os = require("os");
    // Separate Chrome profile, kept outside the vault so it never gets synced.
    const profileDir = path.join(os.homedir(), ".obsidian-chatgpt-embed", "chrome-profile");

    let proc;
    try {
      proc = require("child_process").spawn(
        chrome,
        [
          `--user-data-dir=${profileDir}`,
          "--remote-debugging-pipe",
          "--no-first-run",
          "--no-default-browser-check",
          "https://chatgpt.com/auth/login",
        ],
        { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
      );
    } catch (e) {
      this.log("启动失败: " + e.message);
      new Notice("启动 Chrome 失败：" + e.message, 8000);
      return;
    }

    this._chromeLoginRunning = true;
    let exited = false;
    proc.on("exit", (code) => { exited = true; this.log("Chrome 退出, code=" + code); });
    proc.on("error", (e) => this.log("Chrome 进程错误: " + e.message));
    const cdp = new ChromePipe(proc);
    const notice = new Notice("已打开 Chrome：请在里面登录 ChatGPT（可以用 Google）。登录完成、看到聊天界面后会自动同步回 Obsidian。", 0);
    const deadline = Date.now() + 10 * 60 * 1000;
    let lastNames = "";
    let lastErr = "";

    try {
      try {
        const v = await cdp.call("Browser.getVersion", {}, 15000);
        this.log("已连接 Chrome: " + v.product);
      } catch (e) {
        this.log("连接 Chrome 失败: " + e.message);
        throw new Error("无法连接到 Chrome（" + e.message + "）。如果 Chrome 窗口已打开，请先完全退出 Chrome 再试。");
      }

      while (Date.now() < deadline) {
        await sleep(2000);
        if (exited) throw new Error("Chrome 已关闭，还没检测到登录");
        let res;
        try {
          res = await cdp.call("Storage.getCookies");
        } catch (e) {
          if (e.message !== lastErr) this.log("读取 Cookie 失败: " + e.message);
          lastErr = e.message;
          continue;
        }
        const gpt = ((res && res.cookies) || []).filter((c) => isChatGPTDomain(c.domain));
        const names = gpt.map((c) => c.name).sort().join(", ");
        if (names !== lastNames) {
          this.log("Chrome 里的 chatgpt.com Cookie: " + (names || "(无)"));
          lastNames = names;
        }
        if (!gpt.some((c) => isSessionCookie(c.name))) continue;

        this.log("检测到登录 Cookie，开始写入 Obsidian");
        const ok = await this.importCookies(gpt);
        try { await cdp.call("Browser.close"); } catch (e) {}
        notice.hide();
        new Notice(
          ok ? "登录成功，已同步到 Obsidian ✅" : "读到了登录状态，但写入 Obsidian 失败。请运行命令「诊断登录问题」并截图。",
          8000
        );
        return;
      }
      throw new Error("等待超时（10 分钟）");
    } catch (e) {
      notice.hide();
      this.log("结束: " + e.message);
      new Notice("用 Chrome 登录没有完成：" + e.message + "\n可运行命令「诊断登录问题」查看详情。", 10000);
      try { if (!exited) proc.kill(); } catch (err) {}
    } finally {
      this._chromeLoginRunning = false;
    }
  }

  // Accepts either {name, value} pairs (manual paste) or full CDP cookie objects.
  // Returns true if a session cookie is present in Obsidian's partition afterwards.
  async importCookies(cookies) {
    const defaultExpiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    const sameSiteMap = { Strict: "strict", Lax: "lax", None: "no_restriction" };
    let count = 0;

    const ses = getElectronSession();
    this.log("Electron session 可用: " + !!ses);
    const replacingSession = cookies.some((c) => isSessionCookie(c.name));
    if (ses) {
      // Remove old session-token chunks first; leftovers would corrupt the reassembled token.
      if (replacingSession) {
        try {
          const existing = await ses.cookies.get({});
          for (const c of existing.filter((c) => isChatGPTDomain(c.domain) && isSessionCookie(c.name))) {
            await ses.cookies.remove(`https://${c.domain.replace(/^\./, "")}${c.path || "/"}`, c.name);
          }
          this.log("已清除旧的 session-token");
        } catch (e) {
          this.log("清除旧 session-token 失败: " + e.message);
        }
      }
      // Write HttpOnly cookies straight into the webview's session.
      for (const c of cookies) {
        const full = "domain" in c;
        const hostOnly = full && !c.domain.startsWith(".");
        const host = full ? c.domain.replace(/^\./, "") : "chatgpt.com";
        const details = {
          url: `https://${host}${(full && c.path) || "/"}`,
          path: (full && c.path) || "/",
          name: c.name,
          value: c.value,
          secure: full ? !!c.secure : true,
          httpOnly: full ? !!c.httpOnly : true,
          sameSite: (full && sameSiteMap[c.sameSite]) || "lax",
        };
        if (!hostOnly && !c.name.startsWith("__Host-")) details.domain = full ? c.domain : ".chatgpt.com";
        if (full && !c.session && c.expires > 0) details.expirationDate = c.expires;
        else details.expirationDate = defaultExpiry; // keep session cookies across restarts
        if (details.sameSite === "no_restriction") details.secure = true;
        try {
          await ses.cookies.set(details);
          count++;
        } catch (e) {
          this.log(`写入 ${c.name} 失败: ${e.message}`);
        }
      }
      try { await ses.cookies.flushStore(); } catch (e) {}
    } else {
      // Fallback: open chatgpt.com in the view and set cookies via document.cookie.
      let wv = this.getWebviews()[0];
      if (!wv) {
        await this.activateView();
        await sleep(1500);
        wv = this.getWebviews()[0];
      }
      if (!wv) {
        this.log("没有可用的 ChatGPT 视图");
        return false;
      }
      try {
        await wv.loadURL("https://chatgpt.com/robots.txt");
      } catch (e) {
        this.log("打开 chatgpt.com 失败: " + e.message);
      }
      const expire = replacingSession
        ? ["", ".0", ".1", ".2", ".3"]
            .map((sfx) => `document.cookie=${JSON.stringify(`${SESSION_NAME}${sfx}=; domain=.chatgpt.com; path=/; secure; max-age=0`)};`)
            .join("")
        : "";
      const js = expire + cookies
        .map((c) => {
          const dom = c.name.startsWith("__Host-") ? "" : "domain=.chatgpt.com; ";
          return `document.cookie=${JSON.stringify(
            `${c.name}=${c.value}; ${dom}path=/; secure; samesite=lax; max-age=2592000`
          )};`;
        })
        .join("");
      try {
        await wv.executeJavaScript(js);
        count = cookies.length;
      } catch (e) {
        this.log("document.cookie 写入失败: " + e.message);
      }
    }
    this.log(`写入了 ${count}/${cookies.length} 个 Cookie`);

    const ok = await this.hasSessionCookie();
    this.log("写入后检查登录 Cookie: " + (ok === null ? "无法检查" : ok ? "存在" : "不存在"));

    for (const wv of this.getWebviews()) {
      try { wv.loadURL(this.settings.url); } catch (e) {}
    }
    if (!this.getWebviews().length) await this.activateView();
    if (ok !== false && count > 0) this.verifySessionSoon();
    return ok !== false && count > 0;
  }

  // Ask ChatGPT itself whether the imported cookie is accepted.
  async verifySessionSoon() {
    await sleep(4000);
    const wv = this.getWebviews()[0];
    if (!wv) return;
    try {
      const r = await wv.executeJavaScript(
        `fetch("/api/auth/session",{credentials:"include"}).then(r=>r.json()).then(j=>({ok:!!(j&&j.user),email:j&&j.user&&j.user.email||""})).catch(e=>({ok:false,err:String(e)}))`
      );
      this.log("ChatGPT 会话检查: " + (r.ok ? "已登录" : "未登录" + (r.err ? " (" + r.err + ")" : "")));
      if (r.ok) new Notice("✅ 已登录 ChatGPT" + (r.email ? "：" + r.email : ""), 5000);
      else new Notice("⚠️ ChatGPT 没有接受这个 Cookie：可能已过期，或 .0/.1 没复制完整。请在 Chrome 里刷新 chatgpt.com 后重新复制。", 12000);
    } catch (e) {
      this.log("会话检查失败: " + e.message);
    }
  }

  // true / false, or null if we can't tell.
  async hasSessionCookie() {
    const ses = getElectronSession();
    if (ses) {
      try {
        const list = await ses.cookies.get({ url: "https://chatgpt.com/" });
        return list.some((c) => isSessionCookie(c.name));
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  async diagnostics() {
    const lines = [];
    lines.push("插件版本: " + this.manifest.version);
    lines.push("Electron: " + (process.versions.electron || "?") + "  Chrome: " + (process.versions.chrome || "?"));
    lines.push("系统: " + process.platform);
    lines.push("Chrome 路径: " + (findChrome(this.settings.chromePath) || "未找到"));
    const ses = getElectronSession();
    lines.push("Electron session 可用: " + !!ses);
    if (ses) {
      try {
        const list = await ses.cookies.get({});
        const gpt = list.filter((c) => isChatGPTDomain(c.domain));
        lines.push("Obsidian 里的 chatgpt.com Cookie: " + (gpt.map((c) => c.name).join(", ") || "(无)"));
      } catch (e) {
        lines.push("读取 Cookie 失败: " + e.message);
      }
    }
    for (const wv of this.getWebviews()) {
      try { lines.push("视图当前网址: " + wv.getURL()); } catch (e) {}
      try { lines.push("视图 UA: " + wv.getUserAgent()); } catch (e) {}
    }
    lines.push("");
    lines.push("—— 上次“用 Chrome 登录”的日志 ——");
    lines.push(...(this.loginLog.length ? this.loginLog : ["(还没有运行过)"]));
    return lines.join("\n");
  }

  async clearLogin() {
    const ses = getElectronSession();
    if (ses) {
      await ses.clearStorageData();
    } else {
      for (const wv of this.getWebviews()) {
        try {
          await wv.executeJavaScript("localStorage.clear();sessionStorage.clear();");
        } catch (e) {}
      }
    }
    for (const wv of this.getWebviews()) {
      try { wv.reload(); } catch (e) {}
    }
  }

  onunload() {}

  async activateView(where) {
    const loc = where || this.settings.openLocation;
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length && !where) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = loc === "tab" ? workspace.getLeaf("tab") : workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Migrate users of v1.0.0, whose saved Chrome UA gets rejected by Google.
    // Also migrate v1.1.0, whose global Firefox UA broke chatgpt.com itself.
    if (this.settings.userAgent === UA_CHROME_OLD || this.settings.userAgent === UA_FIREFOX) {
      this.settings.userAgent = "";
      await this.saveSettings();
    }
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class ChatGPTSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("网址")
      .setDesc("默认 https://chatgpt.com/ ，也可以填某个 GPT 或项目的链接")
      .addText((t) =>
        t.setValue(this.plugin.settings.url).onChange(async (v) => {
          this.plugin.settings.url = v.trim() || DEFAULT_SETTINGS.url;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("默认打开位置")
      .addDropdown((d) =>
        d
          .addOption("right", "右侧边栏")
          .addOption("tab", "新标签页")
          .setValue(this.plugin.settings.openLocation)
          .onChange(async (v) => {
            this.plugin.settings.openLocation = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("缩放比例")
      .setDesc("侧边栏较窄时可以调小，例如 0.8（重新打开视图后生效）")
      .addSlider((s) =>
        s.setLimits(0.5, 1.5, 0.05).setValue(this.plugin.settings.zoom).setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.zoom = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("User-Agent")
      .setDesc("ChatGPT 页面用的 UA。留空 = 自动（推荐）。修改后需重新打开视图。")
      .addTextArea((t) =>
        t.setValue(this.plugin.settings.userAgent).onChange(async (v) => {
          this.plugin.settings.userAgent = v.trim();
          await this.plugin.saveSettings();
        })
      )
      .addExtraButton((b) =>
        b.setIcon("reset").setTooltip("恢复默认（自动）").onClick(async () => {
          this.plugin.settings.userAgent = "";
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Google 登录页伪装成 Firefox")
      .setDesc("只在 accounts.google.com 生效，帮助绕过“此浏览器可能不安全”。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.googleFirefoxUA).onChange(async (v) => {
          this.plugin.settings.googleFirefoxUA = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("用 Chrome 登录")
      .setDesc("打开一个普通的 Chrome 窗口，你在里面用 Google 登录 ChatGPT，插件自动把登录状态同步回来。登录过期了再点一次即可。")
      .addButton((b) =>
        b.setButtonText("用 Chrome 登录").setCta().onClick(() => this.plugin.loginWithChrome())
      );

    new Setting(containerEl)
      .setName("Chrome 路径")
      .setDesc("留空自动查找（Chrome / Edge / Brave）。找不到时再手动填写。")
      .addText((t) =>
        t
          .setPlaceholder(findChrome("") || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
          .setValue(this.plugin.settings.chromePath)
          .onChange(async (v) => {
            this.plugin.settings.chromePath = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("手动导入 Cookie")
      .setDesc("备用办法：在普通浏览器登录后，手动复制 Cookie 粘贴进来。")
      .addButton((b) =>
        b.setButtonText("导入 Cookie").onClick(() =>
          new CookieImportModal(this.app, this.plugin).open()
        )
      );

    new Setting(containerEl)
      .setName("诊断登录问题")
      .setDesc("显示登录过程的日志（不含 Cookie 的值）。遇到问题时截图给开发者。")
      .addButton((b) =>
        b.setButtonText("打开诊断").onClick(async () =>
          new TextModal(this.app, "ChatGPT Embed 诊断", await this.plugin.diagnostics()).open()
        )
      );

    new Setting(containerEl)
      .setName("退出登录 / 清除数据")
      .setDesc("清除内嵌浏览器里的 Cookie 和缓存")
      .addButton((b) =>
        b.setButtonText("清除").setWarning().onClick(async () => {
          await this.plugin.clearLogin();
          new Notice("已清除");
        })
      );
  }
}

module.exports = ChatGPTEmbedPlugin;
