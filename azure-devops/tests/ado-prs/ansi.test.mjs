import test from "node:test";
import assert from "node:assert/strict";
import { parseAnsi, isDarkTheme, fitLines } from "../../mods/ado-prs/review/ansi.js";

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

const first = (s) => parseAnsi(s)[0][0];
test("256-colour below 16 maps to ansiN", () => assert.equal(first("\x1b[38;5;9mx").color, "ansi9"));
test("256-colour at or above 16 maps to hex", () => {
  assert.equal(first("\x1b[38;5;196mx").color, "#ff0000");
  assert.equal(first("\x1b[38;5;240mx").color, "#585858");
});
test("bold on and 22 off", () => {
  const [a, b] = parseAnsi("\x1b[1ma\x1b[22mb")[0];
  assert.equal(a.bold, true);
  assert.equal(b.bold, false);
});
test("bright 90-97 map to ansi8-15", () => {
  assert.equal(first("\x1b[90mx").color, "ansi8");
  assert.equal(first("\x1b[97mx").color, "ansi15");
});
test("combined params in one sequence", () => {
  assert.deepEqual(first("\x1b[1;38;2;1;2;3mx"), { text: "x", color: "#010203", bold: true });
});
test("background params leave the foreground alone", () => {
  assert.equal(first("\x1b[32m\x1b[48;2;9;9;9mx").color, "ansi2");
  assert.equal(first("\x1b[32;41mx").color, "ansi2");
});
test("CR is stripped", () => assert.deepEqual(parseAnsi("a\r\nb"), [[{ text: "a", color: null, bold: false }], [{ text: "b", color: null, bold: false }]]));
test("empty input is one empty line", () => assert.deepEqual(parseAnsi(""), [[]]));
test("fitLines trims, pads and empties", () => {
  assert.deepEqual(fitLines([[1], [2], []], 2), [[1], [2]]);
  assert.deepEqual(fitLines([[1]], 3), [[1], [], []]);
  assert.deepEqual(fitLines([[]], 0), []);
});
