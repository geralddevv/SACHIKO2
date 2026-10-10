/* Shared "Verified" badge helpers -- see VERIFICATION.md.
   Load with <script src="/js/verification.js"></script> before the page script. */
(function () {
  function escHtml(v) {
    return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // "Approved by Gerald on 10/10/2026, 2:24:24 pm" (plain text, not escaped)
  window.verifiedText = function (doc) {
    return "Approved by " + (doc.verifiedBy || "—") +
      (doc.verifiedAt ? " on " + new Date(doc.verifiedAt).toLocaleString("en-IN") : "");
  };

  // Instagram-style scalloped blue seal with a white tick; `tip` shows on hover.
  window.verifiedBadge = function (tip, size) {
    const px = size || 22;
    return '<svg class="verified-badge" width="' + px + '" height="' + px + '" viewBox="0 0 24 24" role="img" aria-label="Verified" style="flex-shrink:0;display:block;"><title>' + escHtml(tip) + '</title>' +
      '<path fill="#0095f6" d="M22.5 12.5c0-1.58-.88-2.95-2.18-3.66.55-1.4.36-3.04-.7-4.2-1.06-1.17-2.65-1.58-4.07-1.18C14.9 2.2 13.55 1.3 12 1.3s-2.9.9-3.55 2.16c-1.42-.4-3.01.01-4.07 1.18-1.06 1.16-1.25 2.8-.7 4.2C2.38 9.55 1.5 10.92 1.5 12.5s.88 2.95 2.18 3.66c-.55 1.4-.36 3.04.7 4.2 1.06 1.17 2.65 1.58 4.07 1.18C9.1 22.8 10.45 23.7 12 23.7s2.9-.9 3.55-2.16c1.42.4 3.01-.01 4.07-1.18 1.06-1.16 1.25-2.8.7-4.2 1.3-.71 2.18-2.08 2.18-3.66z"/>' +
      '<path fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M7.6 12.6l3.1 3.1 5.7-6.3"/></svg>';
  };

  // Badge for a record, or "" when it isn't verified.
  window.verifiedBadgeFor = function (doc, size) {
    return doc && doc.verified ? window.verifiedBadge(window.verifiedText(doc), size) : "";
  };

  // Tabulator formatter for a record's name/code column: escaped text + badge.
  //   { title: "Family Name", field: "familyName", formatter: verifiedNameFormatter }
  window.verifiedNameFormatter = function (cell) {
    const d = cell.getRow().getData();
    return '<span style="display:inline-flex;align-items:center;gap:5px;">' + escHtml(cell.getValue()) + window.verifiedBadgeFor(d, 16) + '</span>';
  };

  // Footer "Approved by …" text for the add/edit dialogs of the masters pages.
  window.setVerifiedDialogState = function (prefix, doc) {
    const cb = document.getElementById(prefix + "Verified");
    const note = document.getElementById(prefix + "VerifiedNote");
    if (cb) cb.checked = !!(doc && doc.verified);
    if (note) {
      note.textContent = doc && doc.verified ? window.verifiedText(doc) : "";
      note.style.display = doc && doc.verified ? "block" : "none";
    }
  };
})();
