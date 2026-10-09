// PWA behaviour: service worker + update prompt, Install App, Desktop/Mobile
// layout switch (installed app only), offline banner.
(function () {
  const standalone =
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true;

  const safeGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  const bar = (id, html, bg) => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.style.cssText =
        "position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:100000;" +
        "display:flex;align-items:center;gap:12px;padding:10px 16px;border-radius:10px;" +
        "color:#fff;font:600 14px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3);max-width:92vw;";
      document.body.appendChild(el);
    }
    el.style.background = bg;
    el.innerHTML = html;
    return el;
  };

  // ---- Service worker + "new version" prompt -------------------------------
  if ("serviceWorker" in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    let prompted = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || prompted) return; // first install, not an update
      prompted = true;
      const el = bar("pwaUpdateBar", '<span>A new version is ready.</span><button type="button" style="border:0;border-radius:6px;padding:4px 12px;font-weight:700;cursor:pointer;color:#044a78;background:#fff">Reload</button>', "#044a78");
      el.querySelector("button").addEventListener("click", () => location.reload());
    });
  }

  // ---- Install App ----------------------------------------------------------
  const installBtn = document.getElementById("fdInstallApp");
  let deferredPrompt = null;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (installBtn && !standalone) {
    if (isIos) {
      installBtn.style.display = "flex";
      installBtn.addEventListener("click", () => {
        alert("To install: tap the Share button, then 'Add to Home Screen'.");
      });
    }
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.style.display = "flex";
    });
    installBtn.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) {}
      deferredPrompt = null;
      installBtn.style.display = "none";
    });
    window.addEventListener("appinstalled", () => { installBtn.style.display = "none"; });
  }

  // ---- Desktop / Mobile layout (installed app only) -------------------------
  const layoutBtn = document.getElementById("fdLayoutToggle");
  if (layoutBtn && standalone) {
    const mobile = safeGet("pwaLayout") === "mobile";
    layoutBtn.style.display = "flex";
    layoutBtn.querySelector("span").textContent = mobile ? "Switch to Desktop Layout" : "Switch to Mobile Layout";
    layoutBtn.querySelector("i").className = mobile ? "fa-solid fa-desktop" : "fa-solid fa-mobile-screen";
    layoutBtn.addEventListener("click", () => {
      safeSet("pwaLayout", mobile ? "desktop" : "mobile");
      location.reload();
    });
  }

  // ---- Offline banner ---------------------------------------------------------
  const syncOnline = () => {
    const existing = document.getElementById("pwaOfflineBar");
    if (navigator.onLine) { existing?.remove(); return; }
    bar("pwaOfflineBar", '<i class="fa-solid fa-wifi" style="opacity:.9"></i><span>You are offline - changes cannot be saved.</span>', "#b45309");
  };
  window.addEventListener("online", syncOnline);
  window.addEventListener("offline", syncOnline);
  syncOnline();
})();
