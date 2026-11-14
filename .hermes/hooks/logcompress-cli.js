#!/usr/bin/env node
"use strict";
// Entry-time GC as a plain filter, for hosts that hand tool output to a plugin instead of
// running Claude Code hooks (the Hermes plugin's terminal-output hook):
//   some-command | node hooks/logcompress-cli.js
// stdout: the rewritten output, or nothing at all when the output should stay as it is.
// The note it appends names this copy's own bin/eso.js, so the restore command works
// where `eson` is not on PATH. Fail-open: any error prints nothing.
const fs = require("fs");
const path = require("path");

try {
  const { shrink } = require("./logcompress-entry");
  const eso = path.join(__dirname, "..", "bin", "eso.js").split(path.sep).join("/");
  const out = shrink(fs.readFileSync(0, "utf8"), `node "${eso}" retrieve`);
  if (out !== null) process.stdout.write(out);
} catch {}
