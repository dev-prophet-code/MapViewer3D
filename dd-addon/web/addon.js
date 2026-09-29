(function () {
  const STORAGE_KEY = "mapviewer3d.url";
  const DEFAULT_PORT = "8795";

  const frame = document.querySelector("#viewer");
  const help = document.querySelector("#help");
  const helpReason = document.querySelector("#helpReason");
  const statusEl = document.querySelector("#status");
  const urlInput = document.querySelector("#urlInput");
  const openTab = document.querySelector("#openTab");
  const portHint = document.querySelector("#portHint");

  function readStored() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) || "";
    } catch (_) {
      return "";
    }
  }

  function writeStored(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch (_) {
      /* storage can be blocked inside sandboxed iframes */
    }
  }

  function defaultUrl() {
    const host = window.location.hostname || "127.0.0.1";
    const proto = window.location.protocol === "https:" ? "https:" : "http:";
    return `${proto}//${host.includes(":") ? `[${host}]` : host}:${DEFAULT_PORT}/`;
  }

  // Only http(s) URLs are accepted; anything else falls back to the default.
  function normalize(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
    try {
      const url = new URL(withScheme);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      if (!url.pathname.endsWith("/")) url.pathname += "/";
      url.username = "";
      url.password = "";
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  function setStatus(kind, text) {
    statusEl.className = `status ${kind}`;
    statusEl.textContent = text;
  }

  function showHelp(reason) {
    frame.hidden = true;
    help.hidden = false;
    helpReason.textContent = reason;
    setStatus("down", "Not reachable");
  }

  // The viewer answers /api/version with JSON. no-cors keeps this working
  // cross-origin: a resolved fetch means something is listening on that port.
  async function probe(base) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 6000);
    try {
      await fetch(new URL("api/version", base), {
        mode: "no-cors",
        cache: "no-store",
        signal: controller.signal
      });
      return { ok: true };
    } catch (error) {
      const mixed =
        window.location.protocol === "https:" && new URL(base).protocol === "http:";
      return {
        ok: false,
        reason: mixed
          ? "This page is served over https, but the viewer URL is plain http. Browsers block that here."
          : `No answer from ${base}.`
      };
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function load() {
    const base = normalize(urlInput.value) || defaultUrl();
    urlInput.value = base;
    openTab.href = base;
    portHint.textContent = new URL(base).port || DEFAULT_PORT;
    setStatus("", "Checking…");

    const result = await probe(base);
    if (!result.ok) {
      showHelp(result.reason);
      return;
    }
    help.hidden = true;
    frame.hidden = false;
    if (frame.src !== base) frame.src = base;
    setStatus("ok", "Connected");
  }

  document.querySelector("#saveUrl").addEventListener("click", () => {
    const value = normalize(urlInput.value);
    if (urlInput.value.trim() && !value) {
      setStatus("down", "Invalid URL (use http:// or https://)");
      return;
    }
    writeStored(value === defaultUrl() ? "" : value);
    load();
  });
  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") document.querySelector("#saveUrl").click();
  });
  document.querySelector("#retry").addEventListener("click", load);

  urlInput.value = readStored();
  load();
})();
