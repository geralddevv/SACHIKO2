/**
 * Security utilities for the FairDesk application.
 */

/**
 * Escapes special characters in a string for use in a regular expression.
 * Prevents NoSQL injection when user input is used in regex queries.
 * @param {string} str
 * @returns {string}
 */
export function escapeRegex(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Safely stringifies an object for injection into a <script> tag in EJS.
 * Prevents XSS by escaping HTML-sensitive characters inside the JSON string.
 * @param {any} obj
 * @returns {string}
 */
export function safeJson(obj) {
  return JSON.stringify(obj || {})
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\//g, "\\u002f")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
