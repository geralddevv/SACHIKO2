// ================= SIDEBAR TOGGLE WITH PERSISTENCE =================


(function () {
  const sideNav = document.querySelector(".side-nav");

  // Storage keys
  const SESSION_EXPIRES_HEADER = "x-session-expires-at";
  const SESSION_KEEPALIVE_MIN_INTERVAL_MS = 5 * 60 * 1000;

  // CSRF Protection Helpers
  const getCsrfToken = () => document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
  const getSessionExpiresAt = () => document.querySelector('meta[name="session-expires-at"]')?.getAttribute("content");
  let sessionTimeoutId = null;
  let sessionKeepAliveTimerId = null;
  let keepAliveInFlight = false;
  let lastKeepAliveAt = 0;

  const redirectToLogin = () => {
    // Operators sign in at their own portal; the layout tells us which one.
    const loginUrl =
      document.querySelector('meta[name="login-url"]')?.getAttribute("content") || "/sachiko/login";
    if (window.location.pathname === loginUrl) return;
    window.location.replace(`${loginUrl}?reason=session-ended`);
  };

  const clearSessionTimer = () => {
    if (sessionTimeoutId) {
      clearTimeout(sessionTimeoutId);
      sessionTimeoutId = null;
    }
  };

  const scheduleSessionLogout = (expiresAt) => {
    if (!expiresAt) return;

    const expiresDate = new Date(expiresAt);
    if (Number.isNaN(expiresDate.getTime())) return;

    clearSessionTimer();

    const delay = expiresDate.getTime() - Date.now();
    if (delay <= 0) {
      keepSessionAlive({ force: true });
      return;
    }

    sessionTimeoutId = setTimeout(() => {
      keepSessionAlive({ force: true });
    }, delay + 250);
  };

  const startSessionWatchdog = () => {
    if (window.location.pathname === "/sachiko/login") return;

    const sessionExpiresAt = getSessionExpiresAt();
    scheduleSessionLogout(sessionExpiresAt);
  };

  const keepSessionAlive = async ({ force = false } = {}) => {
    if (window.location.pathname === "/sachiko/login") return;
    if (!force && document.visibilityState === "hidden") return;
    if (keepAliveInFlight) return;

    const now = Date.now();
    if (!force && now - lastKeepAliveAt < SESSION_KEEPALIVE_MIN_INTERVAL_MS) {
      return;
    }

    keepAliveInFlight = true;

    try {
      const response = await window.fetch("/check-session", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
        },
      });

      if (response.status === 401) {
        redirectToLogin();
        return;
      }

      lastKeepAliveAt = now;

      const sessionExpiresAt = response.headers?.get?.(SESSION_EXPIRES_HEADER);
      if (sessionExpiresAt) {
        scheduleSessionLogout(sessionExpiresAt);
      } else {
        const payload = await response.json().catch(() => null);
        if (payload?.expiresAt) {
          scheduleSessionLogout(payload.expiresAt);
        }
      }
    } catch (err) {
      // Ignore transient connectivity issues and retry on the next activity pulse.
    } finally {
      keepAliveInFlight = false;
    }
  };

  const restartSessionKeepAlive = () => {
    if (sessionKeepAliveTimerId) {
      clearInterval(sessionKeepAliveTimerId);
      sessionKeepAliveTimerId = null;
    }

    if (window.location.pathname === "/sachiko/login") return;

    sessionKeepAliveTimerId = setInterval(() => {
      keepSessionAlive();
    }, SESSION_KEEPALIVE_MIN_INTERVAL_MS);
  };

  startSessionWatchdog();
  restartSessionKeepAlive();

  // Global Fetch Wrapper to include CSRF token
  const originalFetch = window.fetch;
  window.fetch = function (url, options = {}) {
    const requestUrl = typeof url === "string" ? url : url?.url || "";
    const token = getCsrfToken();
    if (token) {
      options.headers = options.headers || {};
      if (options.headers instanceof Headers) {
        if (!options.headers.has("X-CSRF-Token")) {
          options.headers.set("X-CSRF-Token", token);
        }
      } else if (Array.isArray(options.headers)) {
        if (!options.headers.some(([k]) => k.toLowerCase() === "x-csrf-token")) {
          options.headers.push(["X-CSRF-Token", token]);
        }
      } else {
        if (!options.headers["x-csrf-token"]) {
          options.headers["x-csrf-token"] = token;
        }
      }
    }
    return originalFetch(url, options).then((response) => {
      const isSessionCheck =
        requestUrl.includes("/check-session") || requestUrl.includes("/login") || requestUrl.includes("/logout");
      const looksLikeLoginRedirect = response.redirected && response.url && response.url.includes("/login");

      const sessionExpiresAt = response.headers?.get?.(SESSION_EXPIRES_HEADER);
      if (sessionExpiresAt) {
        scheduleSessionLogout(sessionExpiresAt);
      }

      if (!isSessionCheck && (response.status === 401 || looksLikeLoginRedirect)) {
        redirectToLogin();
      }

      return response;
    });
  };

  // Global Form Submit Interceptor to inject CSRF token
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (form && form.method && form.method.toLowerCase() === "post") {
      const token = getCsrfToken();
      if (token && !form.querySelector('input[name="_csrf"]')) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "_csrf";
        input.value = token;
        form.appendChild(input);
      }
    }
  });

  ["pointerdown", "keydown", "focus"].forEach((eventName) => {
    window.addEventListener(eventName, () => {
      keepSessionAlive({ force: eventName === "focus" });
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      keepSessionAlive({ force: true });
    }
  });



  // ================= GENERIC NAV GROUP TOGGLE =================

  function toggleNavGroup(wrapper) {
    const menu = wrapper.querySelector(".nav-labels-opt");
    if (!menu) return;

    const isOpen = menu.style.height && menu.style.height !== "0px";

    if (isOpen) {
      menu.style.height = "0px";
      wrapper.classList.remove("is-open");
    } else {
      const scrollH = menu.scrollHeight;
      menu.style.height = (scrollH > 0 ? scrollH : 500) + "px"; // Fallback to 500 if scrollHeight is 0
      wrapper.classList.add("is-open");
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".nav-opt-wrap").forEach((wrapper) => {
      const menu = wrapper.querySelector(".nav-labels-opt");
      if (!menu) return;

      // Disable animation for initial open
      menu.classList.add("no-transition");

      // Open a group on load when it holds the current page, or when the layout
      // marked it data-open-default (a role whose sidebar is just this group).
      if (menu.querySelector(".nav-items.active") || wrapper.hasAttribute("data-open-default")) {
        menu.style.height = menu.scrollHeight + "px";
        wrapper.classList.add("is-open");
      }


      // Re-enable animation AFTER paint
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          menu.classList.remove("no-transition");
        });
      });
    });
  });

  // Attach toggle to ALL nav groups
  document.querySelectorAll(".nav-opt-wrap").forEach((wrapper) => {
    const toggle = wrapper.querySelector(":scope > .nav-items");
    if (!toggle) return;

    toggle.addEventListener("click", (e) => {
      if (e.target.closest(".nav-labels-opt")) return;
      e.stopPropagation();
      toggleNavGroup(wrapper);
    });
  });

  // Prevent option clicks from closing the dropdown
  document.querySelectorAll(".nav-opt-wrap .nav-labels-opt").forEach((menu) => {
    menu.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  });

  // ================= INPUT UPPERCASE =================

  document.querySelectorAll("input[type='text']").forEach((input) => {
    input.addEventListener("input", function () {
      const start = this.selectionStart;
      const end = this.selectionEnd;
      const uppercased = this.value.toUpperCase();
      if (this.value !== uppercased) {
        this.value = uppercased;
        this.setSelectionRange(start, end);
      }
    });
  });

  // ================= CUSTOM NAV HISTORY =================

  (function () {
    const backBtn = document.getElementById("fdNavBack");
    const forwardBtn = document.getElementById("fdNavForward");
    if (!backBtn || !forwardBtn) return;

    const STACK_KEY = "fd_navStack";
    const FORWARD_KEY = "fd_navForwardStack";
    const LAST_KEY = "fd_navLast";
    const ACTION_KEY = "fd_navAction";

    const getLocationKey = () => window.location.pathname + window.location.search;

    const readStack = (key) => {
      try {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) : [];
      } catch (err) {
        return [];
      }
    };

    const writeStack = (key, arr) => {
      sessionStorage.setItem(key, JSON.stringify(arr));
    };

    const updateButtons = (backStack, forwardStack) => {
      const backDisabled = backStack.length === 0;
      const forwardDisabled = forwardStack.length === 0;

      backBtn.classList.toggle("disabled", backDisabled);
      forwardBtn.classList.toggle("disabled", forwardDisabled);
      backBtn.disabled = backDisabled;
      forwardBtn.disabled = forwardDisabled;
    };

    const current = getLocationKey();
    let backStack = readStack(STACK_KEY);
    let forwardStack = readStack(FORWARD_KEY);

    const last = sessionStorage.getItem(LAST_KEY);
    const actionRaw = sessionStorage.getItem(ACTION_KEY);
    let action = null;
    try {
      action = actionRaw ? JSON.parse(actionRaw) : null;
    } catch (err) {
      action = null;
    }

    if (action && action.target === current) {
      sessionStorage.removeItem(ACTION_KEY);
    } else if (last && last !== current) {
      if (!backStack.length || backStack[backStack.length - 1] !== last) {
        backStack.push(last);
      }
      forwardStack = [];
    } else if (!last) {
      try {
        const ref = document.referrer ? new URL(document.referrer) : null;
        if (ref && ref.origin === window.location.origin) {
          const refKey = ref.pathname + ref.search;
          if (refKey && refKey !== current) {
            backStack.push(refKey);
          }
        }
      } catch (err) {
        // ignore invalid referrer
      }
    }

    sessionStorage.setItem(LAST_KEY, current);
    writeStack(STACK_KEY, backStack);
    writeStack(FORWARD_KEY, forwardStack);
    updateButtons(backStack, forwardStack);

    backBtn.addEventListener("click", () => {
      if (!backStack.length) return;
      const target = backStack.pop();
      forwardStack.push(current);
      writeStack(STACK_KEY, backStack);
      writeStack(FORWARD_KEY, forwardStack);
      sessionStorage.setItem(ACTION_KEY, JSON.stringify({ target }));
      window.location.href = target;
    });

    forwardBtn.addEventListener("click", () => {
      if (!forwardStack.length) return;
      const target = forwardStack.pop();
      backStack.push(current);
      writeStack(STACK_KEY, backStack);
      writeStack(FORWARD_KEY, forwardStack);
      sessionStorage.setItem(ACTION_KEY, JSON.stringify({ target }));
      window.location.href = target;
    });
  })();
  // Shared helper to limit numeric input to two chars (moved from inline templates)
  window.limitToTwoChars = function(elem) {
    if (elem.value.length > 2) {
      elem.value = elem.value.slice(0, 2);
    }
  };
})();
