const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";

export function logDbConnected(label) {
  console.log(`  ${GREEN}${BOLD}✓${RESET} ${label}`);
}
