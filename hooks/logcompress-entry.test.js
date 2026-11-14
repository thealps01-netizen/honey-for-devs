"use strict";
// The entry-time GC decision (logcompress-entry.js) and its plain-filter form
// (logcompress-cli.js): rewrite only when the result is shorter, and stay restorable.
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "logcompress-cli.js");
const filter = (input) => {
  const ccrDir = fs.mkdtempSync(path.join(os.tmpdir(), "honey-gc-entry-"));
  const env = { ...process.env, HONEY_CCR_DIR: ccrDir };
  return { out: execFileSync("node", [CLI], { input, env, encoding: "utf8" }), env, ccrDir };
};
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("\n");

test("a collapse that saves less than its note leaves the output alone", () => {
  // 30 distinct lines with one run of three blank lines: collapsing drops 2 chars, the note adds ~90
  const text = lines(14, (i) => `step ${i} ok`) + "\n\n\n\n" + lines(14, (i) => `check ${i} ok`);
  const { out, ccrDir } = filter(text);
  assert.strictEqual(out, "");
  assert.deepStrictEqual(fs.readdirSync(ccrDir), [], "nothing rewritten, nothing stashed");
});

test("a retry storm is collapsed, shorter, and restorable with the command in the note", () => {
  const text = lines(60, () => "2026-01-01T00:00:00Z retrying connection to db:5432") + "\ndone";
  const { out, env } = filter(text);
  assert.ok(out && out.length < text.length);
  const cmd = out.match(/`node "([^"]+)" retrieve ([0-9a-f]{16})`/);
  assert.ok(cmd, out);
  assert.ok(fs.existsSync(cmd[1]), "the note names an eso.js that exists");
  assert.strictEqual(execFileSync("node", [cmd[1], "retrieve", cmd[2]], { env, encoding: "utf8" }), text);
});

test("output with nothing to collapse prints nothing", () => {
  assert.strictEqual(filter(lines(40, (i) => `line ${i}`)).out, "");
  assert.strictEqual(filter("short").out, "");
});
