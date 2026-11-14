"use strict";
// Entry-time GC decision, shared by every host adapter: the Claude Code PostToolUse hook
// (logcompress-hook-impl.js) and logcompress-cli.js for hosts that pipe tool output through
// a filter (the Hermes plugin). Two transforms, tried in order:
//   1. uniform JSON array (≥20 items, ≥2k chars) → CCR crush: endpoints + anomalies +
//      head/tail sample + sentinel hash (measured -38..-84% on ≥5-item arrays)
//   2. repetitive text (≥25 lines) → collapse consecutive same-template lines ⟨×N⟩
//      (measured 0.4% on typical coding output — real wins are retry storms/installers)
// The original is stashed first, so any dropped detail stays retrievable by hash.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { compress } = require("./logcompress");
const { crush } = require("../eso/ccr");

// Forced (hook) crush is more conservative than the model-invoked `eson crush`:
// the model can't veto it, so only clearly-bulk arrays qualify.
const CRUSH_MIN_ITEMS = 20;
const CRUSH_MIN_CHARS = 2000;

// Where originals are stashed; bin/eso.js resolves the same folder for `retrieve`.
const stashDir = () => process.env.HONEY_CCR_DIR || path.join(os.tmpdir(), "honey-ccr");

// Tool output can carry credentials: keep the stash readable by its owner only.
function stash(text, hash) {
  fs.mkdirSync(stashDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stashDir(), `${hash}.json`), text, { mode: 0o600 });
}

// shrink(text, retrieve) -> the replacement output, or null to leave the output alone.
// `retrieve` is the command that restores a stash on this host; the hash is appended.
function shrink(text, retrieve = "eson retrieve") {
  if (typeof text !== "string" || !text) return null;
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  let out = null;

  // 1. uniform JSON array → CCR crush
  if (text.length >= CRUSH_MIN_CHARS && text.trimStart().startsWith("[")) {
    let array;
    try { array = JSON.parse(text); } catch {}
    if (Array.isArray(array) && array.length >= CRUSH_MIN_ITEMS) {
      const { view, dropped } = crush(array);
      if (dropped > 0) {
        out = JSON.stringify(view) +
          `\n[honey: kept ${array.length - dropped} of ${array.length} rows. Full array: \`${retrieve} ${hash}\`]`;
      }
    }
  }

  // 2. repetitive text → collapse consecutive repeats
  if (out === null) {
    const { view, dropped } = compress(text);
    if (dropped < 1) return null; // nothing collapsed → leave it
    out = view + `\n[honey: collapsed ${dropped} repeated line(s). Full output: \`${retrieve} ${hash}\`]`;
  }

  // The note costs about 90 chars. A rewrite that is not shorter than the original (three
  // collapsed blank lines) would add tokens and hide lines for nothing: leave the output alone.
  if (out.length >= text.length) return null;

  stash(text, hash);
  return out;
}

module.exports = { shrink, stashDir, CRUSH_MIN_ITEMS, CRUSH_MIN_CHARS };
