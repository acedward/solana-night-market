// The claims store's lock (AA 00047 P7.4): only a lock file that already exists (EEXIST) held by a
// live process means "in use by another relay". Every other failure is reported as what it is, with
// the path, the errno, the relay's uid/gid and the fix. A data dir the relay's user cannot write
// (EACCES) once looked like a lock conflict, and the relay exited 78 in a restart loop.
//
// EACCES cannot be produced with chmod when the tests run as root (the Docker check does), so it is
// injected through node:fs; ENAMETOOLONG and ENOTDIR are real failures under any user. The real
// EACCES of a volume owned by another uid is the deploy bundle's container check (CI deploy-bundle).

import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaimsStoreError, DemoTokenClaims } from '../src/demo/claims.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, openSync: vi.fn(actual.openSync), readFileSync: vi.fn(actual.readFileSync) };
});

const actualFs = await vi.importActual<typeof fs>('node:fs');

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'nm-claims-lock-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.mocked(fs.openSync).mockReset();
  vi.mocked(fs.readFileSync).mockReset();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The pid a lock file names (AA 00047 P10, F-A2-7: the lock is JSON with the pid, host and a token). */
const lockPid = (file: string): number => (JSON.parse(readFileSync(`${file}.lock`, 'utf8')) as { pid: number }).pid;

/** An error shaped as node:fs throws it. */
const errno = (code: string, syscall: string, path: string) =>
  Object.assign(new Error(`${code}: simulated, ${syscall} '${path}'`), { code, syscall, path });

const ids = `uid ${process.getuid?.()} gid ${process.getgid?.()}`;

/** The error `fn` throws, which must be a ClaimsStoreError. */
function thrown(fn: () => void): ClaimsStoreError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ClaimsStoreError);
    return e as ClaimsStoreError;
  }
  throw new Error('expected a ClaimsStoreError');
}

describe('the claims lock', () => {
  it('EEXIST with a live holder: in use by another relay, naming the lock, the holder and the way out', () => {
    const file = join(tmp(), 'claims.json');
    writeFileSync(`${file}.lock`, `${process.ppid}\n`); // a live process that is not us
    const e = thrown(() => new DemoTokenClaims({ file, dailyCap: 1 }).lock());
    expect(e.kind).toBe('held');
    expect(e.code).toBe('EEXIST');
    expect(e.path).toBe(`${file}.lock`);
    expect(e.message).toMatch(/in use by another relay/);
    expect(e.message).toContain(`holder ${process.ppid}`);
    expect(e.message).toContain('One relay per data dir');
    // The live relay's lock is left alone.
    expect(readFileSync(`${file}.lock`, 'utf8').trim()).toBe(String(process.ppid));
  });

  it('EEXIST with a lock no pid can be read from: held, "holder unknown", and how to clear it', () => {
    const file = join(tmp(), 'claims.json');
    for (const body of ['', 'not-a-pid\n']) {
      writeFileSync(`${file}.lock`, body);
      const e = thrown(() => new DemoTokenClaims({ file, dailyCap: 1 }).lock());
      expect(e.kind).toBe('held');
      expect(e.message).toContain(body.trim() ? `holder ${body.trim()}` : 'holder unknown');
      expect(e.message).toContain(`remove ${file}.lock`);
    }
  });

  it('a stale lock is taken over: a pid that no longer exists, or our own pid (a restarted container)', () => {
    const file = join(tmp(), 'claims.json');
    for (const stale of ['999999999', String(process.pid)]) {
      writeFileSync(`${file}.lock`, `${stale}\n`);
      const c = new DemoTokenClaims({ file, dailyCap: 1 });
      c.lock();
      expect(lockPid(file)).toBe(process.pid);
      c.unlock();
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    }
  });

  it('a lock released between our attempt and our read is simply taken', () => {
    const file = join(tmp(), 'claims.json');
    // The first create reports EEXIST, but the file is gone when we read it (the holder released it).
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw errno('EEXIST', 'open', `${file}.lock`);
    });
    const c = new DemoTokenClaims({ file, dailyCap: 1 });
    c.lock();
    expect(lockPid(file)).toBe(process.pid);
    c.unlock();
  });

  it('EACCES creating the lock is NOT a lock conflict: path, errno, uid/gid, owner and the fix', () => {
    const dir = tmp();
    const file = join(dir, 'claims.json');
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw errno('EACCES', 'open', `${file}.lock`);
    });
    const c = new DemoTokenClaims({ file, dailyCap: 1 });
    const e = thrown(() => c.lock());
    expect(e.kind).toBe('filesystem');
    expect(e.code).toBe('EACCES');
    expect(e.path).toBe(`${file}.lock`);
    expect(e.message).not.toMatch(/in use by another relay/);
    expect(e.message).toContain('cannot create its lock file');
    expect(e.message).toContain(`${file}.lock`);
    expect(e.message).toContain('EACCES');
    expect(e.message).toContain(`The relay runs as ${ids}`);
    expect(e.message).toMatch(new RegExp(`${dir} is owned by uid \\d+ gid \\d+, mode [0-7]+`));
    expect(e.message).toContain('RELAY_USER');
    expect(e.message).toContain('relay-data-init');
    expect(e.message).toContain(`chown -R ${process.getuid?.()}:${process.getgid?.()} ${dir}`);
    // Nothing was taken or left behind, and a later attempt (the directory fixed) succeeds.
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    c.unlock();
    c.lock();
    expect(lockPid(file)).toBe(process.pid);
    c.unlock();
  });

  it('EROFS and ENOSPC name their own fixes', () => {
    const file = join(tmp(), 'claims.json');
    for (const [code, fix] of [
      ['EROFS', /read-only file system: mount a writable volume at RELAY_DATA_DIR/],
      ['ENOSPC', /free space on the file system/],
    ] as const) {
      vi.mocked(fs.openSync).mockImplementationOnce(() => {
        throw errno(code, 'open', `${file}.lock`);
      });
      const e = thrown(() => new DemoTokenClaims({ file, dailyCap: 1 }).lock());
      expect(e).toMatchObject({ kind: 'filesystem', code });
      expect(e.message).toMatch(fix);
      expect(e.message).not.toMatch(/in use by another relay/);
    }
  });

  it('a real non-EEXIST failure of the lock file itself (ENAMETOOLONG) is reported as such', () => {
    const file = join(tmp(), `${'n'.repeat(250)}.json`); // the name fits; with ".lock" it does not
    const e = thrown(() => new DemoTokenClaims({ file, dailyCap: 1 }).lock());
    expect(e).toMatchObject({ kind: 'filesystem', code: 'ENAMETOOLONG', path: `${file}.lock` });
    expect(e.message).not.toMatch(/in use by another relay/);
  });

  it('a data dir that is not a directory (a real ENOTDIR or EEXIST from mkdir) says so', () => {
    const notADir = join(tmp(), 'data');
    writeFileSync(notADir, 'a file, not a directory');
    const e = thrown(() => new DemoTokenClaims({ file: join(notADir, 'claims.json'), dailyCap: 1 }).lock());
    expect(e.kind).toBe('filesystem');
    expect(['ENOTDIR', 'EEXIST']).toContain(e.code);
    expect(e.message).toMatch(/set RELAY_DATA_DIR to a directory/);
  });

  it('an existing lock that cannot be read (EACCES) is a filesystem problem, not "holder unknown"', () => {
    const file = join(tmp(), 'claims.json');
    writeFileSync(`${file}.lock`, '999999999\n');
    vi.mocked(fs.readFileSync).mockImplementation(((p: string, options: never) => {
      if (p === `${file}.lock`) throw errno('EACCES', 'open', p);
      return actualFs.readFileSync(p, options);
    }) as typeof fs.readFileSync);
    const e = thrown(() => new DemoTokenClaims({ file, dailyCap: 1 }).lock());
    expect(e).toMatchObject({ kind: 'filesystem', code: 'EACCES', path: `${file}.lock` });
    expect(e.message).toContain('cannot read its lock file');
    expect(e.message).not.toMatch(/holder unknown|in use by another relay/);
  });

  it('a claims file that cannot be read at start (EACCES) says so with the fix', () => {
    const file = join(tmp(), 'claims.json');
    writeFileSync(file, '{"format":"night-market-demo-token-claims/1","claims":[]}\n');
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw errno('EACCES', 'open', file);
    });
    // The file is read once the lock is held (AA 00047 P9, audit C8 / F-B8): `lock()` reports it.
    const e = thrown(() => new DemoTokenClaims({ file, dailyCap: 1 }).lock());
    expect(e).toMatchObject({ kind: 'filesystem', code: 'EACCES', path: file });
    expect(e.message).toContain('cannot read its claims file');
    expect(e.message).toContain(`The relay runs as ${ids}`);
  });
});

// AA 00047 P10, audit round 2 R2-9 (F-A2-7.3): "a lock holding the relay's own pid is taken over as
// stale, so two relay containers on one data volume (both pid 1) both open the store". The lock now
// names its holder's pid, host and a token, and the live relay touches it (a heartbeat).
describe('the claims lock across containers (R2-9)', () => {
  it('a fresh lock of another host is held, even with the same pid (two containers on one volume)', () => {
    const file = join(tmp(), 'claims.json');
    const a = new DemoTokenClaims({ file, dailyCap: 1, hostname: 'container-a', heartbeatSeconds: 0 });
    a.lock();
    const b = new DemoTokenClaims({ file, dailyCap: 1, hostname: 'container-b', heartbeatSeconds: 0 });
    const e = thrown(() => b.lock());
    expect(e.kind).toBe('held');
    expect(e.message).toContain(`holder ${process.pid} on host container-a`);
    expect(a.open).toBe(true);
    a.unlock();
  });

  it('the same host and pid with another token is a restarted relay: taken over at once', () => {
    const file = join(tmp(), 'claims.json');
    const before = new DemoTokenClaims({ file, dailyCap: 1, hostname: 'h1', heartbeatSeconds: 0 });
    before.lock(); // ... and the process dies without unlocking
    const after = new DemoTokenClaims({ file, dailyCap: 1, hostname: 'h1', heartbeatSeconds: 0 });
    after.lock();
    expect(lockPid(file)).toBe(process.pid);
    after.unlock();
  });

  it('a lock untouched for staleSeconds is taken over; the old holder notices and stops writing', () => {
    const file = join(tmp(), 'claims.json');
    let lost = 0;
    const a = new DemoTokenClaims({
      file,
      dailyCap: 5,
      hostname: 'container-a',
      heartbeatSeconds: 0,
      onLockLost: () => lost++,
    });
    a.lock();
    expect(a.heartbeat()).toBe(true);
    // container-a froze: its lock is three minutes old.
    const old = new Date(Date.now() - 180_000);
    fs.utimesSync(`${file}.lock`, old, old);
    const b = new DemoTokenClaims({ file, dailyCap: 5, hostname: 'container-b', heartbeatSeconds: 0 });
    b.lock();
    const r = b.reserve('01'.repeat(32), 'ab'.repeat(32));
    expect(r.ok).toBe(true);
    const fileBefore = readFileSync(file, 'utf8');
    // container-a wakes up: its heartbeat sees another token; it writes nothing more.
    expect(a.heartbeat()).toBe(false);
    expect(lost).toBe(1);
    expect(a.open).toBe(false);
    expect(a.reserve('02'.repeat(32), 'ab'.repeat(32))).toMatchObject({ ok: false, code: 'store-unavailable' });
    expect(readFileSync(file, 'utf8')).toBe(fileBefore);
    a.unlock(); // does not remove b's lock
    expect(JSON.parse(readFileSync(`${file}.lock`, 'utf8'))).toMatchObject({ host: 'container-b' });
    b.unlock();
  });

  it('a write after the lock was taken over refuses instead of overwriting the other relay’s file', () => {
    const file = join(tmp(), 'claims.json');
    const a = new DemoTokenClaims({ file, dailyCap: 5, hostname: 'h', heartbeatSeconds: 0 });
    a.lock();
    const r = a.reserve('01'.repeat(32), 'ab'.repeat(32));
    expect(r.ok).toBe(true);
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.ppid, host: 'other', token: 't' }));
    if (r.ok) expect(() => r.confirm(['aa'.repeat(32)])).toThrow(/taken over/);
    expect(a.open).toBe(false);
  });
});
