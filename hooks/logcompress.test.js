"use strict";
// Tests for LogCompressor + its PostToolUse hook. No API.
//   node hooks/logcompress.test.js
const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { compress, expand } = require("./logcompress");

let n = 0;
const ok = (name, cond) => { n++; if (!cond) { console.error(`FAIL: ${name}`); process.exitCode = 1; } };

// --- pure compressor ---------------------------------------------------------
const storm =
  "[12:00:00] INFO start\n" +
  Array.from({ length: 26 }, (_, i) => `[12:00:${String(i + 1).padStart(2, "0")}] WARN db refused, retrying`).join("\n") +
  "\n[12:00:27] ERROR gave up: host=db-primary\n[12:00:28] INFO ok\n";
const { view, dropped } = compress(storm);
ok("collapses timestamped run", dropped === 25); // 26 WARN → 1 + (×26)
ok("view is smaller", view.length < storm.length);
ok("count recoverable via expand", (expand(view).match(/\bWARN\b/g) || []).length === 26);
ok("keeps non-collapsed lines", view.includes("ERROR gave up: host=db-primary"));
ok("strips ANSI", !compress("\x1b[31m" + storm).view.includes("\x1b["));

// below size gate → only ANSI strip, no collapse
const small = "\x1b[32mline\x1b[0m\na\na\na\n";
ok("small output not collapsed", compress(small).dropped === 0);
ok("small output ANSI stripped", !compress(small).view.includes("\x1b["));

// distinct lines (a real stack trace / test output) are untouched
const trace = Array.from({ length: 30 }, (_, i) => `  File "app/x${i}.py", line ${i}, in f${i}`).join("\n");
ok("distinct lines untouched", compress(trace).dropped === 0);

// Lines that differ in their body are data, whatever the difference looks like. Each case is
// padded past the size gate with lines that do not repeat.
const pad = Array.from({ length: 30 }, (_, i) => `step ${i} ok`).join("\n") + "\n";
const kept = (name, rows) => {
  const { view: v, dropped: d } = compress(pad + rows.join("\n"));
  ok(`${name} untouched`, d === 0 && rows.every((r) => v.includes(r)));
};
const uuid = (i) => `8548f1c0-2a41-4d61-9be4-b43d661de${String(i).padStart(3, "0")}`;
kept("files named by UUID", Array.from({ length: 12 }, (_, i) => `${uuid(i)}.tmp`));
kept("rows that differ in a date inside the line",
  Array.from({ length: 8 }, (_, i) => `{'ts': '2026-09-${10 + i}T02:44:43.385899+00:00', 'actor': 'agent', 'action': 'patch'}`));
kept("rows that differ in a clock time inside the line",
  Array.from({ length: 8 }, (_, i) => `job nightly finished at 06:1${i}:00 status ok`));
kept("lines that differ in a hex value", Array.from({ length: 8 }, (_, i) => `freed block at 0x7ffd00${i}0`));
kept("log lines whose body differs",
  Array.from({ length: 8 }, (_, i) => `2026-10-27 15:24:0${i}.158 W request ${uuid(i)} failed`));
// ...while identical lines, and log lines that differ in the leading timestamp only, collapse.
const same = (name, rows) => ok(`${name} collapse`, compress(pad + rows.join("\n")).dropped === rows.length - 1);
same("identical lines", Array(40).fill("retrying connection to db:5432"));
same("date-time prefixed log lines", Array.from({ length: 9 }, (_, i) => `2026-10-27 15:24:0${i}.158 W Get coolers actual RPMs failed.`));
same("ISO prefixed log lines", Array.from({ length: 9 }, (_, i) => `2026-10-27T15:24:0${i},120+03:00 retrying`));
same("indented clock-time prefixed lines", Array.from({ length: 9 }, (_, i) => `  09:15:0${i} waiting for lock`));

// --- hook: ultra-gated, fail-open, emits updatedToolOutput -------------------
const HOOK = path.join(__dirname, "logcompress-hook.js");
const run = (payload, env) =>
  execFileSync("node", [HOOK], { input: JSON.stringify(payload), env: { ...process.env, ...env }, encoding: "utf8" });

const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "honey-cfg-"));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), "honey-cache-"));
fs.writeFileSync(path.join(cfg, ".honey-active"), "ultra");
const envUltra = { CLAUDE_CONFIG_DIR: cfg, HONEY_CCR_DIR: cache };

const bashStorm = { tool_name: "Bash", tool_response: storm };
const out = run(bashStorm, envUltra);
ok("hook emits updatedToolOutput on storm", out.includes("updatedToolOutput") && out.includes("×26"));
const handle = JSON.parse(out).hookSpecificOutput.updatedToolOutput.stdout.match(/eson retrieve (\w+)/)[1];
ok("hook stashed original", fs.readFileSync(path.join(cache, `${handle}.json`), "utf8") === storm);

// any active mode fires; off → no output (passthrough)
fs.writeFileSync(path.join(cfg, ".honey-active"), "full");
ok("full mode fires too", run(bashStorm, envUltra).includes("updatedToolOutput"));
fs.writeFileSync(path.join(cfg, ".honey-active"), "off");
ok("off passes through", run(bashStorm, envUltra) === "");
fs.writeFileSync(path.join(cfg, ".honey-active"), "ultra");

// non-Bash tool → passthrough
ok("non-Bash passes through", run({ tool_name: "Read", tool_response: storm }, envUltra) === "");
// non-repetitive Bash → passthrough (nothing collapsed)
ok("non-repetitive passes through", run({ tool_name: "Bash", tool_response: trace }, envUltra) === "");
// malformed input → fail open (no throw, no output)
ok("malformed fails open", execFileSync("node", [HOOK], { input: "not json", encoding: "utf8" }) === "");

console.log(`logcompress: ${n} checks, ${process.exitCode ? "FAILED" : "all passed"}`);
