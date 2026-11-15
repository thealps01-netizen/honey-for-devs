#!/usr/bin/env node
// Zero-dependency session CO2 report — the same numbers the statusline badge
// shows, on demand and not tied to stdin. Reuses the committed EcoLogits port
// (hooks/eco.js) so the figure matches the badge exactly. For the authoritative
// breakdown (embodied + ADPe + primary energy) run scripts/eco_report.py, which
// calls the real ecologits package.
//
//   node scripts/eco-session.js [--transcript PATH] [--mode lite|full|ultra]
//   node scripts/eco-session.js --hermes-db PATH [--session ID]     (Hermes)
//
// Without --transcript it picks the newest *.jsonl under ~/.claude/projects.
// Without --mode it reads the active mode flag, falling back to full.
//
// Hermes keeps no transcript file: when HERMES_SESSION_ID is set (Hermes sets it for
// the agent's commands) or --hermes-db is given, the session and its subagent sessions
// are read from Hermes' state.db (sessions.model, sessions.output_tokens) through Node's
// built-in node:sqlite (Node 22.13+ or 23.4+). Hermes holds the Honey level in its own process,
// so --mode defaults to full there.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const eco = require(path.join(__dirname, "..", "hooks", "eco.js"));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function newestTranscript() {
  const base = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let newest = null, newestMtime = -1;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        let m;
        try { m = fs.statSync(p).mtimeMs; } catch { continue; } // rotated away mid-walk
        if (m > newestMtime) { newestMtime = m; newest = p; }
      }
    }
  };
  walk(base);
  return newest;
}

function activeMode() {
  return require(path.join(__dirname, "..", "hooks", "honey-state.js")).readMode() || "full";
}

// Unflagged node:sqlite with a honoured readOnly option: Node 22.13+ on 22.x, 23.4+ on 23.x,
// any later major. Earlier builds need --experimental-sqlite and open the file read-write.
function nodeHasReadOnlySqlite(version) {
  const [major, minor] = version.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
}

// Output tokens per model for one Hermes session and every session below it
// (subagents, continuations), read-only from state.db.
function hermesPerModel(dbPath, sessionId) {
  if (!nodeHasReadOnlySqlite(process.versions.node)) {
    console.error(`reading Hermes' state.db needs Node 22.13+ or 23.4+ (built-in node:sqlite); this is Node ${process.versions.node}`);
    process.exit(1);
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `WITH RECURSIVE tree(id) AS (SELECT id FROM sessions WHERE id = ?
         UNION SELECT s.id FROM sessions s JOIN tree t ON s.parent_session_id = t.id)
       SELECT model, SUM(COALESCE(output_tokens, 0)) AS out FROM sessions
       WHERE id IN (SELECT id FROM tree) GROUP BY model`
    ).all(sessionId);
    const perModel = {};
    for (const r of rows) perModel[r.model || "unknown"] = Number(r.out);
    return perModel;
  } finally {
    db.close();
  }
}

const hermesDb = arg("--hermes-db") ||
  (!arg("--transcript") && process.env.HERMES_SESSION_ID && process.env.HERMES_HOME
    ? path.join(process.env.HERMES_HOME, "state.db") : undefined);

let source, perModel = {}, mode;
if (hermesDb) {
  const sid = arg("--session") || process.env.HERMES_SESSION_ID;
  if (!sid) { console.error("no Hermes session id: pass --session ID or run inside Hermes"); process.exit(1); }
  if (!fs.existsSync(hermesDb)) { console.error(`no Hermes state.db at ${hermesDb}`); process.exit(1); }
  perModel = hermesPerModel(hermesDb, sid);
  source = `session    : ${sid}  (Hermes ${hermesDb})`;
  mode = arg("--mode") || "full";
} else {
  const tx = arg("--transcript") || newestTranscript();
  if (!tx || !fs.existsSync(tx)) { console.error("no transcript found"); process.exit(1); }
  for (const line of fs.readFileSync(tx, "utf8").split("\n")) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (!m || m.role !== "assistant" || !m.usage) continue;
    perModel[m.model] = (perModel[m.model] || 0) + (m.usage.output_tokens || 0);
  }
  source = `transcript : ${tx}`;
  mode = arg("--mode") || activeMode();
}

const cfg = eco.loadConfig();
let gco2 = 0, ceiling = 0, tokens = 0, concurrency = 1, topModel = null, topTokens = 0;
console.log(source);
console.log(`mode       : ${mode}`);
for (const [model, out] of Object.entries(perModel)) {
  if (!out) continue;
  const e = eco.estimate(model, out, cfg);
  gco2 += e.gco2; ceiling += e.gco2Ceiling; tokens += out; concurrency = e.concurrency;
  if (out > topTokens) { topTokens = out; topModel = model; }
  console.log(`  ${model.padEnd(28)} ${String(out).padStart(8)} tok  -> ${e.gco2.toFixed(2)} g`);
}
if (!tokens) { console.error("no output tokens found"); process.exit(1); }

console.log(`output tok : ${tokens.toLocaleString()}`);
console.log(`CO2eq      : ${gco2.toFixed(2)} g  (served, usage + embodied, JS port)`);

// The CO2-per-token figure above is computed from this session. The savings figure is
// NOT — it is a modelled counterfactual from a committed bench stamp, so it is labelled
// as one, and omitted entirely when no stamp covers this session's model.
const sv = eco.savingsInfo(cfg, mode, topModel);
if (sv) {
  console.log(`saved      : ~${(gco2 * sv.k).toFixed(2)} g CO2eq  (assumes ${Math.round(sv.R * 100)}% fewer output tokens than a no-Honey run)`);
  console.log(`  basis    : ${sv.label}`);
} else {
  console.log(`saved      : —  (no committed bench stamp covers ${topModel || "this model"}; run bench/ on it rather than extrapolating)`);
}

console.log(`ceiling    : ${ceiling.toFixed(2)} g  (EcoLogits single-stream, /${concurrency} batching -> served)`);
console.log(`\nParams are speculative; served = single-stream ceiling / ${concurrency} (continuous batching). Treat as a range, not a meter reading.`);
