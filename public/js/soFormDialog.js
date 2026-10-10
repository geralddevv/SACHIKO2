// Form dialogs in the form style (formStyle.md, "Dialogs" / "Form-dialog
// behaviour"). Any <form class="so-dialog" data-so-form> gets:
//   - validation on submit: every [required] input / select / textarea must be
//     non-blank once trimmed (a lone space passes the browser's `required`);
//     failures get .so-invalid and one toast naming them, and nothing is sent;
//   - fetch submit with Accept: application/json -- multipart when the form
//     has enctype="multipart/form-data", urlencoded otherwise (match the
//     route: only routes with a multipart parser can read multipart);
//   - on { success, redirect } -> go to redirect (the route's flash toasts
//     there); on { success: false, message } -> showToast(message) and stay;
//     the submit button is disabled with a spinner while saving;
//   - the full text as a tooltip on any label / field cut short with "…".
// A form inside a .so-dialog-backdrop is a modal:
//   soDialog.open(id)  -- id of the backdrop; resets the form to what the
//                         page rendered (form.reset()) and focuses the field
//                         marked data-so-autofocus, else the first editable
//                         one;
//   soDialog.close(id) -- only Cancel / Esc close it (never a backdrop click),
//                         and not while it's saving.
//
// Load it after the markup it binds (the dialog partials include it at their
// end). Safe to load more than once: each form is bound once. Uses the
// layout's global showToast().
(function () {
  "use strict";

  if (!window.soDialog) {
    const openStack = [];
    const backdropOf = (ref) => (typeof ref === "string" ? document.getElementById(ref) : ref?.closest?.(".so-dialog-backdrop"));
    const isSaving = (backdrop) => backdrop?.querySelector("form[data-so-form]")?.dataset.soSaving === "1";

    window.soDialog = {
      open(ref) {
        const backdrop = backdropOf(ref);
        if (!backdrop) return;
        const form = backdrop.querySelector("form[data-so-form]");
        if (form) {
          form.reset();
          form.querySelectorAll(".so-invalid").forEach((el) => el.classList.remove("so-invalid"));
        }
        backdrop.style.display = "flex";
        backdrop.setAttribute("aria-hidden", "false");
        if (!openStack.includes(backdrop)) openStack.push(backdrop);
        const first = form?.querySelector("[data-so-autofocus]") || form?.querySelector(
          "input:not([type=hidden]):not([readonly]):not([disabled]), select:not([disabled]), textarea:not([readonly]):not([disabled])",
        );
        setTimeout(() => first?.focus(), 30);
      },
      close(ref) {
        const backdrop = backdropOf(ref);
        if (!backdrop || isSaving(backdrop)) return;
        backdrop.style.display = "none";
        backdrop.setAttribute("aria-hidden", "true");
        const i = openStack.indexOf(backdrop);
        if (i >= 0) openStack.splice(i, 1);
      },
    };

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !openStack.length) return;
      window.soDialog.close(openStack[openStack.length - 1]);
    });
  }

  const labelOf = (form, field) =>
    (form.querySelector(`label[for="${field.id}"]`)?.textContent || field.name || "This field").replace(/\*/g, "").trim();

  function bind(form) {
    form.dataset.soBound = "1";
    const saveBtn = form.querySelector('button[type="submit"]');
    const saveBtnHtml = saveBtn ? saveBtn.innerHTML : "";
    const setSaving = (on) => {
      form.dataset.soSaving = on ? "1" : "0";
      if (!saveBtn) return;
      saveBtn.disabled = on;
      saveBtn.innerHTML = on ? '<i class="fa-solid fa-spinner fa-spin"></i> Saving...' : saveBtnHtml;
    };

    const clearOne = (e) => e.target.classList?.remove("so-invalid");
    form.addEventListener("input", clearOne);
    form.addEventListener("change", clearOne);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (form.dataset.soSaving === "1") return;

      form.querySelectorAll(".so-invalid").forEach((el) => el.classList.remove("so-invalid"));
      const missing = [...form.querySelectorAll("input[required], select[required], textarea[required]")]
        .filter((el) => !el.disabled && !String(el.value || "").trim());
      if (missing.length) {
        missing.forEach((el) => el.classList.add("so-invalid"));
        showToast(`Please fill in ${missing.map((el) => labelOf(form, el)).join(", ")}.`, true);
        missing[0].focus();
        return;
      }

      const multipart = form.enctype === "multipart/form-data";
      const body = multipart ? new FormData(form) : new URLSearchParams(new FormData(form));

      setSaving(true);
      try {
        const res = await fetch(form.action, {
          method: "POST",
          headers: { Accept: "application/json" },
          body,
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.success) {
          window.location.href = data.redirect || window.location.href;
          return;
        }
        showToast(data?.message || "Could not save. Please try again.", true);
      } catch (err) {
        console.error("FORM DIALOG SAVE ERROR:", err);
        showToast("Network error. Please try again.", true);
      }
      setSaving(false);
    });

    // Full text on hover, only while it's actually cut off (formStyle.md,
    // Long text).
    form.addEventListener("mouseover", (e) => {
      const el = e.target instanceof Element ? e.target.closest(".so-dialog__field > label, input, select") : null;
      if (!el) return;
      const full = (el.matches("input")
        ? el.value
        : el.matches("select")
          ? el.options[el.selectedIndex]?.text || ""
          : el.textContent
      ).replace(/\s+/g, " ").trim();
      if (el.scrollWidth > el.clientWidth + 1 && full) {
        el.title = full;
        el.dataset.soTip = "1";
      } else if (el.dataset.soTip) {
        el.removeAttribute("title");
        delete el.dataset.soTip;
      }
    });
  }

  document.querySelectorAll("form[data-so-form]:not([data-so-bound])").forEach(bind);
})();
