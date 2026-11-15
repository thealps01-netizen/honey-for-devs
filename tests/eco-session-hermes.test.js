#!/usr/bin/env node
// scripts/eco-session.js on Hermes: reads the session and its subagent sessions from a
// Hermes state.db instead of a Claude Code transcript. Skipped on a Node whose built-in
// node:sqlite is flagged or ignores readOnly (before 22.13 / 23.4).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
const DatabaseSync = supported ? require('node:sqlite').DatabaseSync : null;
const skip = !supported && 'node:sqlite needs Node 22.13+ or 23.4+';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'eco-session.js');

function fixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honey-eco-hermes-'));
  const file = path.join(dir, 'state.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, model TEXT, output_tokens INTEGER)');
  const add = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)');
  add.run('root', null, 'claude-opus-5-5', 1000);
  add.run('child', 'root', 'claude-sonnet-5-5', 300);
  add.run('grandchild', 'child', 'claude-sonnet-5-5', 200);
  add.run('other', null, 'claude-opus-5-5', 99999);
  db.close();
  return { dir, file };
}

function run(args, env) {
  const clean = { ...process.env };
  delete clean.HERMES_SESSION_ID;
  delete clean.HERMES_HOME;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...clean, ...env } });
}

test('Hermes: counts the session and every session below it, nothing else', { skip }, () => {
  const { dir } = fixtureDb();
  const r = run([], { HERMES_SESSION_ID: 'root', HERMES_HOME: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /session\s+: root/);
  assert.match(r.stdout, /claude-opus-5-5\s+1000 tok/);
  assert.match(r.stdout, /claude-sonnet-5-5\s+500 tok/);
  assert.match(r.stdout, /output tok : 1\D?500\n/);
  assert.match(r.stdout, /mode\s+: full/);
});

test('Hermes: --hermes-db and --session override the environment', { skip }, () => {
  const { file } = fixtureDb();
  const r = run(['--hermes-db', file, '--session', 'child']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /output tok : 500/);
});

test('Hermes: an unknown session reports no tokens and exits 1', { skip }, () => {
  const { dir } = fixtureDb();
  const r = run([], { HERMES_SESSION_ID: 'missing', HERMES_HOME: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no output tokens found/);
});

test('Hermes: a missing state.db is named, not a stack trace', { skip }, () => {
  const r = run([], { HERMES_SESSION_ID: 'root', HERMES_HOME: path.join(os.tmpdir(), 'honey-no-such-home') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no Hermes state\.db at /);
});
