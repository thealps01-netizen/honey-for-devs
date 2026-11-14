#!/usr/bin/env node
"use strict";
// PostToolUse hook — context GC at entry. Big Bash output is compressed BEFORE it
// lands in context (history is immutable once it's in — no hook can rewrite it later),
// and the original is stashed so any detail stays retrievable via `eson retrieve <hash>`.
// What gets rewritten, and when it is left alone, is decided in logcompress-entry.js.
// Loaded via logcompress-hook.js (ES5 guard — keeps old node from parsing the `??` here);
// fires only while Honey mode is active (`/honey off` disables).
// Emits `updatedToolOutput` (replaces the tool result the model sees). For Bash it MUST
// be Bash's output object ({stdout, stderr, interrupted, …}); a bare string is silently
// dropped (anthropics/claude-code#68951, closed as working-as-designed). Fail-open
// everywhere: any uncertainty → no output → the original result reaches the model unchanged.
const fs = require("fs");
const { shrink } = require("./logcompress-entry");

// Replace only stdout; keep the tool's own fields so the object still matches Bash's shape.
function emit(resp, stdout) {
  const base = resp && typeof resp === "object" ? resp : { stderr: "", interrupted: false };
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { ...base, stdout } },
  }));
}
function passthrough() { process.exit(0); } // no output → original result is kept

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if ((input.tool_name || input.toolName) !== "Bash") passthrough();

  // gate: any active Honey mode — same flag honey-session.js reads
  const mode = require("./honey-state.js").activeMode(input.cwd);
  if (!mode) passthrough();

  const resp = input.tool_response ?? input.toolResponse ?? input.tool_result;
  const text = typeof resp === "string" ? resp
    : resp && typeof resp === "object" ? (resp.stdout ?? resp.output ?? resp.content ?? "") : "";

  const out = shrink(text);
  if (out === null) passthrough();
  emit(resp, out);
} catch {
  passthrough(); // fail open — never corrupt a tool result
}
