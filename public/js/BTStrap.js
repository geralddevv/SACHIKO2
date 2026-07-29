// Bootstrap form validation + AJAX submission with toast notifications.
(() => {
  "use strict";

  /* ================= REUSABLE TOAST ================= */
  function showToast(message, type = true) {
    // 1. Map input to standard types: "success" or "error"
    // Handle both boolean (BTStrap style) and string (Boilerplate style)
    const isError = type === true || type === "error";
    const finalType = isError ? "error" : "success";

    const fdToast = document.getElementById("fd-toast");
    const fdMsg = document.getElementById("fd-toast-msg");

    if (fdToast && fdMsg) {
      const icon =
        finalType === "success"
          ? '<i class="fa-solid fa-circle-check" style="margin-right: 8px;"></i>'
          : '<i class="fa-solid fa-triangle-exclamation" style="margin-right: 8px;"></i>';

      fdMsg.innerHTML = icon + message;
      fdToast.className = `toast-notification toast-${finalType}`;
      fdToast.style.display = "block";
      fdToast.style.animation = "slideIn 0.5s forwards";

      // Use the global hide function if defined in boilerplate
      if (typeof window.hideFdToast === "function") {
        setTimeout(window.hideFdToast, 4000);
      } else {
        setTimeout(() => {
          fdToast.style.animation = "slideOut 0.5s forwards";
          setTimeout(() => { fdToast.style.display = "none"; }, 500);
        }, 4000);
      }
      return;
    }

    // 2. Fallback: Create a new toast element if boilerplate container is missing
    const existing = document.getElementById("client-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "client-toast";
    toast.className = `toast-notification toast-${finalType}`;
    toast.innerHTML = `
      <span>${message}</span>
      <span class="toast-close" onclick="this.parentElement.remove()">×</span>
    `;

    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.style.animation = "slideOut 0.5s forwards";
        setTimeout(() => toast.remove(), 500);
      }
    }, 5000);
  }

  // Expose globally
  window.showToast = showToast;

  /* ================= FORM HANDLING ================= */
  const forms = document.querySelectorAll(".needs-validation");

  Array.from(forms).forEach((form) => {
    form.addEventListener(
      "submit",
      async (event) => {
        // 1. HTML5 validation first
        if (!form.checkValidity()) {
          event.preventDefault();
          event.stopPropagation();
          form.classList.add("was-validated");
          showToast("Please fill in all required fields correctly.", true);
          return;
        }

        form.classList.add("was-validated");

        // 2. If the form has a custom onsubmit guard that returned false, skip
        //    (handled by the browser before this listener fires)

        // 3. Prevent normal submit — we'll use fetch
        event.preventDefault();

        const submitBtn = form.querySelector('button[type="submit"]');
        const originalText = submitBtn ? submitBtn.textContent : "";

        try {
          // Disable button to prevent double submit
          if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "Saving...";
          }

          // Build request body
          const isMultipart = form.enctype === "multipart/form-data";
          let body;
          let headers = {};

          if (isMultipart) {
            body = new FormData(form);
            // Don't set Content-Type — browser sets it with boundary
          } else {
            body = new URLSearchParams(new FormData(form)).toString();
            headers["Content-Type"] = "application/x-www-form-urlencoded";
          }

          const response = await fetch(form.action, {
            method: form.method || "POST",
            headers,
            body,
          });

          // Try to parse JSON
          let data;
          const contentType = response.headers.get("content-type") || "";

          if (contentType.includes("application/json")) {
            data = await response.json();
          } else {
            // Server sent a redirect (302) that fetch followed, or plain HTML
            // This means the server didn't return JSON — likely old-style redirect
            // Follow the redirect by reloading
            if (response.redirected) {
              window.location.href = response.url;
              return;
            }
            // If we got HTML back, just reload
            window.location.reload();
            return;
          }

          if (data.success) {
            // Redirect to the success page (flash toast will show there)
            if (data.redirect) {
              window.location.href = data.redirect;
            } else {
              window.location.reload();
            }
          } else {
            // Show error toast without reloading — form data is preserved!
            showToast(data.message || "Something went wrong.", true);
          }
        } catch (err) {
          console.error("Form submission error:", err);
          showToast("Network error. Please try again.", true);
        } finally {
          // Re-enable button
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
          }
        }
      },
      false,
    );

    // Real-time validation on blur and input to show Bootstrap validation UI before submit
    const inputs = form.querySelectorAll("input, select, textarea");
    inputs.forEach((input) => {
      input.addEventListener("blur", () => {
        if (!input.checkValidity()) {
          input.classList.add("is-invalid");
          input.classList.remove("is-valid");
        } else {
          input.classList.add("is-valid");
          input.classList.remove("is-invalid");
        }
      });

      input.addEventListener("input", () => {
        // Only re-validate on input if we already started showing validation UI for this field
        if (input.classList.contains("is-invalid") || input.classList.contains("is-valid")) {
          if (!input.checkValidity()) {
            input.classList.add("is-invalid");
            input.classList.remove("is-valid");
          } else {
            input.classList.add("is-valid");
            input.classList.remove("is-invalid");
          }
        }
      });
    });
  });
})();
