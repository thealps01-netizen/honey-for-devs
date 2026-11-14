#!/usr/bin/env node
"use strict";
// Entry-time GC as a plain filter, for hosts that hand tool output to a plugin instead of
// running Claude Code hooks (the Hermes plugin's terminal-output hook):
//   some-command | node hooks/logcompress-cli.js
// stdout: the rewritten output, or nothing at all when the output should stay as it is.
// The note it appends names this copy's own bin/eso.js and the stash folder, so the
// restore command works where `eson` is not on PATH and where the shell that runs it has
// another temp folder than this process. Fail-open: any error prints nothing.
const fs = require("fs");
const path = require("path");

try {
  const { shrink, stashDir } = require("./logcompress-entry");
  const posix = (p) => p.split(path.sep).join("/"); // backslashes do not survive shell quotes
  const eso = posix(path.join(__dirname, "..", "bin", "eso.js"));
  const out = shrink(fs.readFileSync(0, "utf8"), `HONEY_CCR_DIR="${posix(stashDir())}" node "${eso}" retrieve`);
  if (out !== null) process.stdout.write(out);
} catch {}
