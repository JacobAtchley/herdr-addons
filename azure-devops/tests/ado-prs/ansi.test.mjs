import test from "node:test";
import assert from "node:assert/strict";
import { parseAnsi, isDarkTheme } from "../../mods/ado-prs/review/ansi.js";

test("truecolor and reset", () => {
  const lines = parseAnsi("\x1b[38;2;203;166;247mpublic\x1b[0m void\nx");
  assert.deepEqual(lines[0], [{ text: "public", color: "#cba6f7", bold: false }, { text: " void", color: null, bold: false }]);
  assert.deepEqual(lines[1], [{ text: "x", color: null, bold: false }]);
});
test("colour carries across lines until reset", () => {
  const lines = parseAnsi("\x1b[32m/* a\nb */\x1b[0m");
  assert.equal(lines[1][0].color, "ansi2");
});
test("line count matches input", () => assert.equal(parseAnsi("a\n\nb").length, 3));
test("isDarkTheme", () => {
  assert.equal(isDarkTheme({ background: "#1e1e2e" }), true);
  assert.equal(isDarkTheme({ background: "#eff1f5" }), false);
});
