import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let Database = null;
try { const loaded = require('better-sqlite3'); Database = loaded.default ?? loaded; } catch {}
const localLocks = new Map();
const recoveryLocks = new Map();

function writeAllSync(fd, content, label) {
  const bytes = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error(`${label} made no progress`);
    offset += written;
  }
  if (fstatSync(fd).size !== bytes.length) throw new Error(`${label} size verification failed`);
}

export function processStartIdentity(pid) {
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(pid)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); const end = stat.lastIndexOf(')'); const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/); return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null; }
    catch (error) { return error?.code === 'ENOENT' ? 'absent' : null; }
  }
  if (process.platform === 'darwin') {
    try { const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } }); if (result.status === 0 && result.stdout) { const time = new Date(result.stdout.trim()).getTime(); if (!Number.isNaN(time)) return String(time); } } catch {}
  }
  if (process.platform === 'win32') {
    try { const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p -and $p.StartTime) { $p.StartTime.ToUniversalTime().Ticks }`], { encoding: 'utf8', timeout: 3000, windowsHide: true }); const ticks = result.status === 0 ? result.stdout.trim().match(/^\d+$/)?.[0] : null; if (ticks) return `ticks:${ticks}`; } catch {}
  }
  try { process.kill(pid, 0); return null; } catch (error) { return error?.code === 'ESRCH' ? 'absent' : null; }
}

function mutationDbPath(lockPath) { let current = dirname(lockPath); while (basename(current) !== 'state') { const parent = dirname(current); if (parent === current) return join(dirname(lockPath), '.state-mutation-locks.db'); current = parent; } return join(current, '.state-mutation-locks.db'); }
function canonicalKey(lockPath) { try { return resolve(realpathSync(dirname(lockPath)), basename(lockPath)); } catch { return resolve(lockPath); } }
function openMutationDb(lockPath) { if (!Database) return null; let db = null; try { const dbPath = mutationDbPath(lockPath); for (const sidecar of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) { try { const stat = statSync(sidecar); if (!stat.isFile() || stat.nlink !== 1) return null; } catch (error) { if (error?.code !== 'ENOENT') return null; } } db = new Database(dbPath); db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 2000'); db.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)'); return db; } catch { try { db?.close(); } catch {} return null; } }
function readOwner(path) { try { const value = JSON.parse(readFileSync(path, 'utf8')); const pid = value.pid; if (value.version !== 1 || !Number.isSafeInteger(pid) || pid <= 0 || typeof value.processStart !== 'string' || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return null; return value; } catch (error) { return error?.code === 'ENOENT' ? 'absent' : null; } }
function ownerLive(owner) { const current = processStartIdentity(owner.pid); return current === null ? null : current === 'absent' ? false : current === owner.processStart; }
function sameOwner(left, right) { return left && left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce; }
function publishOwner(path, owner) { const tempPath = `${path}.${owner.pid}.${owner.nonce}.tmp`; let fd; try { mkdirSync(dirname(path), { recursive: true }); fd = openSync(tempPath, 'wx', 0o600); writeAllSync(fd, JSON.stringify(owner), 'lock owner publication'); fsyncSync(fd); closeSync(fd); fd = undefined; linkSync(tempPath, path); unlinkSync(tempPath); return true; } catch { try { if (fd !== undefined) closeSync(fd); } catch {} try { unlinkSync(tempPath); } catch {} return false; } }

export function isStateFileLockingSupported() { return Boolean(Database); }
export function acquireStateFileLockSync(filePath, attempts = 50, requireExclusive = false) {
  void requireExclusive;
  const lockPath = `${filePath}.mutation.lock`; mkdirSync(dirname(lockPath), { recursive: true });
  const key = canonicalKey(lockPath); const held = localLocks.get(key); if (held) { held.depth += 1; return held; }
  const processStart = processStartIdentity(process.pid); if (!processStart || processStart === 'absent') return null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const db = openMutationDb(lockPath); if (!db) return null;
    const owner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
    try {
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('SELECT version, pid, process_start, created_at, nonce FROM state_mutation_locks WHERE lock_key = ?').get(key);
      if (row) { if (row.version !== 1 || !Number.isSafeInteger(row.pid) || typeof row.process_start !== 'string' || typeof row.created_at !== 'string' || typeof row.nonce !== 'string') { db.exec('ROLLBACK'); db.close(); return null; } const live = ownerLive({ pid: row.pid, processStart: row.process_start }); if (live === null || live) { db.exec('ROLLBACK'); db.close(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue; } db.prepare('DELETE FROM state_mutation_locks WHERE lock_key = ?').run(key); }
      const artifact = readOwner(lockPath); if (artifact !== 'absent') { if (!artifact) { db.exec('ROLLBACK'); db.close(); console.error(`[omc-lock] state_mutation_lock_unverifiable: ${lockPath}`); return null; } const live = ownerLive(artifact); if (live === null || live) { db.exec('ROLLBACK'); db.close(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue; } try { unlinkSync(lockPath); } catch { db.exec('ROLLBACK'); db.close(); return null; } }
      db.prepare('INSERT INTO state_mutation_locks VALUES (?,1,?,?,?,?)').run(key, owner.pid, owner.processStart, owner.createdAt, owner.nonce); if (!publishOwner(lockPath, owner)) throw new Error('owner publication failed'); db.exec('COMMIT'); const lock = { db, lockPath, owner, key, depth: 1 }; localLocks.set(key, lock); return lock;
    } catch { try { db.exec('ROLLBACK'); } catch {} try { db.close(); } catch {} return null; }
  }
  return null;
}
export function releaseStateFileLockSync(lock) { if (!lock || lock.unlocked) return; if (lock.depth > 1) { lock.depth -= 1; return; } localLocks.delete(lock.key); try { lock.db.exec('BEGIN IMMEDIATE'); const row = lock.db.prepare('SELECT version, pid, process_start, created_at, nonce FROM state_mutation_locks WHERE lock_key = ?').get(lock.key); const current = readOwner(lock.lockPath); if (row && row.version === 1 && row.pid === lock.owner.pid && row.process_start === lock.owner.processStart && row.nonce === lock.owner.nonce) lock.db.prepare('DELETE FROM state_mutation_locks WHERE lock_key = ?').run(lock.key); if (sameOwner(current === 'absent' ? null : current, lock.owner)) unlinkSync(lock.lockPath); lock.db.exec('COMMIT'); } catch { try { lock.db.exec('ROLLBACK'); } catch {} } finally { try { lock.db.close(); } catch {} } }
export function withStateFileLockSync(filePath, callback, requireExclusive = false) { const lock = acquireStateFileLockSync(filePath, 50, requireExclusive); if (!lock) return { acquired: false, value: undefined }; try { return { acquired: true, value: callback() }; } finally { releaseStateFileLockSync(lock); } }

export function acquireRecoveryClaim(path) {
  const lock = acquireStateFileLockSync(path, 50, true);
  if (!lock) return null;
  const existing = readOwner(path);
  if (existing !== 'absent') {
    if (!existing || ownerLive(existing) !== false) { releaseStateFileLockSync(lock); return null; }
    try { unlinkSync(path); } catch { releaseStateFileLockSync(lock); return null; }
  }
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') { releaseStateFileLockSync(lock); return null; }
  const owner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
  if (!publishOwner(path, owner)) { releaseStateFileLockSync(lock); return null; }
  return owner;
}
export function readRecoveryClaim(path) { const owner = readOwner(path); return owner === 'absent' ? null : owner; }
export function releaseRecoveryClaim(path, owner) {
  const lock = localLocks.get(canonicalKey(`${path}.mutation.lock`));
  if (!lock) return;
  try {
    const current = readRecoveryClaim(path);
    if (sameOwner(current, owner)) unlinkSync(path);
  } finally {
    releaseStateFileLockSync(lock);
  }
}
export function sameRecoveryClaim(left, right) { return sameOwner(left, right); }
export function isEmergencyOwnerLive(owner) { return ownerLive(owner) !== false; }
