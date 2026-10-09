// The page the service worker shows when a navigation can't reach the server
// (/offline.html -- precached by /sw.js). Self-contained on purpose: no external
// CSS/fonts/scripts, because by definition nothing else may be loadable.
// It tells apart "your device is offline" from "the server is down / restarting",
// re-checks on its own, and reloads the page the moment the server answers.
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function offlinePageHtml({ name = "The app" } = {}) {
  const n = esc(name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#044a78">
<meta name="color-scheme" content="light">
<title>${n} - Offline</title>
<style>
  :root { color-scheme: light; --brand:#044a78; --brand-2:#0a6aa8; --bg:#ffffff; --card:#ffffff; --text:#0f2a3d; --muted:#5b7083; --line:#dbe5ee; --ok:#15803d; --bad:#b91c1c; --warn:#b45309; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text);
    background: #ffffff;
    display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { width: min(480px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 18px;
    box-shadow: 0 24px 60px -24px rgba(4,74,120,.35); overflow: hidden; }
  .bar { height: 5px; background: linear-gradient(90deg, var(--brand), var(--brand-2)); }
  .body { padding: 34px 30px 26px; text-align: center; }
  .badge { width: 88px; height: 88px; margin: 0 auto 20px; border-radius: 50%; display: grid; place-items: center;
    background: color-mix(in srgb, var(--brand) 10%, transparent); position: relative; }
  .badge::after { content: ""; position: absolute; inset: -8px; border-radius: 50%; border: 2px solid var(--brand); opacity: .25; animation: pulse 2.4s ease-out infinite; }
  .badge svg { width: 42px; height: 42px; stroke: var(--brand); fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .badge .ic-server { display: none; }
  body.server-down .badge .ic-wifi { display: none; }
  body.server-down .badge .ic-server { display: block; }
  body.server-down .badge { background: color-mix(in srgb, var(--warn) 14%, transparent); }
  body.server-down .badge::after { border-color: var(--warn); }
  body.server-down .badge svg { stroke: var(--warn); }
  @keyframes pulse { 0% { transform: scale(.9); opacity: .4; } 100% { transform: scale(1.25); opacity: 0; } }
  .app { font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--brand-2); margin: 0 0 8px; }
  h1 { margin: 0 0 10px; font-size: 1.55rem; line-height: 1.2; }
  p.lead { margin: 0 auto; max-width: 36ch; color: var(--muted); line-height: 1.55; font-size: .97rem; }
  .status { margin: 24px 0 6px; border: 1px solid var(--line); border-radius: 12px; text-align: left; overflow: hidden; }
  .row { display: flex; align-items: center; gap: 10px; padding: 11px 14px; font-size: .9rem; }
  .row + .row { border-top: 1px solid var(--line); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); flex: none; }
  .row .label { flex: 1; }
  .row .val { font-weight: 600; color: var(--muted); }
  .row.ok .dot { background: var(--ok); } .row.ok .val { color: var(--ok); }
  .row.bad .dot { background: var(--bad); } .row.bad .val { color: var(--bad); }
  .row.wait .dot { animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: .25; } }
  .actions { margin-top: 22px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  button { font: inherit; font-weight: 600; border: 0; border-radius: 10px; padding: 11px 22px; cursor: pointer;
    background: var(--brand); color: #fff; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; }
  button:hover { background: var(--brand-2); }
  button:disabled { opacity: .7; cursor: default; }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; display: none; animation: rot .7s linear infinite; }
  button.busy .spin { display: inline-block; }
  @keyframes rot { to { transform: rotate(360deg); } }
  .foot { margin: 18px 0 0; font-size: .8rem; color: var(--muted); min-height: 1.2em; }
  .help { margin-top: 14px; font-size: .82rem; color: var(--muted); line-height: 1.5; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>
</head>
<body>
<main class="card" role="main">
  <div class="bar"></div>
  <div class="body">
    <div class="badge" aria-hidden="true">
      <svg class="ic-wifi" viewBox="0 0 24 24"><path d="M2 8.8a15 15 0 0 1 4-2.4M22 8.8a15 15 0 0 0-9.4-4.7M5 12.9a10 10 0 0 1 3.2-2M19 12.9a10 10 0 0 0-5.3-2.8M8.5 16.4a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/><path d="M3 3l18 18"/></svg>
      <svg class="ic-server" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/><path d="M3 3l18 18"/></svg>
    </div>
    <p class="app">${n}</p>
    <h1 id="title">You're offline</h1>
    <p class="lead" id="lead">Your device isn't connected to the internet. Check your Wi&#8209;Fi or mobile data and we'll reconnect automatically.</p>

    <div class="status" aria-live="polite">
      <div class="row wait" id="rowNet"><span class="dot"></span><span class="label">Your connection</span><span class="val" id="valNet">Checking&hellip;</span></div>
      <div class="row wait" id="rowSrv"><span class="dot"></span><span class="label">${n} server</span><span class="val" id="valSrv">Checking&hellip;</span></div>
    </div>

    <div class="actions">
      <button type="button" id="retry"><span class="spin"></span><span id="retryLabel">Try again</span></button>
    </div>
    <p class="foot" id="foot">&nbsp;</p>
    <p class="help" id="help">Anything you were typing hasn't been saved. Reconnect, then repeat the last step.</p>
  </div>
</main>
<script>
(function () {
  var AUTO_MS = 10000, timer = null, countdown = null, checking = false;
  var $ = function (id) { return document.getElementById(id); };
  function setRow(row, val, state, text) {
    $(row).className = "row " + state; $(val).textContent = text;
  }
  function ping() {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 6000);
    return fetch("/check-session", { cache: "no-store", signal: ctl.signal })
      .then(function () { clearTimeout(t); return true; }) // any HTTP answer = server is up
      .catch(function () { clearTimeout(t); return false; });
  }
  function render(netUp, srvUp) {
    setRow("rowNet", "valNet", netUp ? "ok" : "bad", netUp ? "Connected" : "No internet");
    if (!netUp) { setRow("rowSrv", "valSrv", "wait", "Waiting for connection"); }
    else setRow("rowSrv", "valSrv", srvUp ? "ok" : "bad", srvUp ? "Online" : "Not responding");
    document.body.classList.toggle("server-down", netUp && !srvUp);
    if (!netUp) {
      $("title").textContent = "You're offline";
      $("lead").innerHTML = "Your device isn't connected to the internet. Check your Wi&#8209;Fi or mobile data and we'll reconnect automatically.";
    } else if (!srvUp) {
      $("title").textContent = "Can't reach the server";
      $("lead").innerHTML = "You're online, but the ${n} server isn't responding. It may be offline, restarting or under maintenance.";
      $("help").textContent = "If this continues for more than a few minutes, contact your administrator.";
    }
  }
  function check(manual) {
    if (checking) return; checking = true;
    var btn = $("retry"); btn.classList.add("busy"); btn.disabled = true; $("retryLabel").textContent = "Checking\\u2026";
    var netUp = navigator.onLine;
    (netUp ? ping() : Promise.resolve(false)).then(function (srvUp) {
      render(netUp, srvUp);
      if (netUp && srvUp) { $("foot").textContent = "Back online - reloading\\u2026"; location.reload(); return; }
      checking = false; btn.classList.remove("busy"); btn.disabled = false; $("retryLabel").textContent = "Try again";
      schedule();
    });
  }
  function schedule() {
    clearTimeout(timer); clearInterval(countdown);
    var left = AUTO_MS / 1000;
    $("foot").textContent = "Checking again in " + left + "s";
    countdown = setInterval(function () { left -= 1; if (left > 0) $("foot").textContent = "Checking again in " + left + "s"; }, 1000);
    timer = setTimeout(function () { clearInterval(countdown); check(false); }, AUTO_MS);
  }
  $("retry").addEventListener("click", function () { clearTimeout(timer); clearInterval(countdown); check(true); });
  window.addEventListener("online", function () { clearTimeout(timer); clearInterval(countdown); check(false); });
  window.addEventListener("offline", function () { render(false, false); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { clearTimeout(timer); clearInterval(countdown); check(false); } });
  check(false);
})();
</script>
</body>
</html>`;
}
