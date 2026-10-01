// A lock shared ROUND-ROBIN across keys (AA 00047 P10, audit round 2 R2-1 / F-A2-1): the prover
// lane's lock, keyed by account.
//
// Waiters queue per key (first in, first out within a key), and the keys take turns: when the lock
// is released, the next grant goes to the key whose turn it is, and that key goes to the back of the
// rotation if it still has waiters. With one key it is a plain FIFO lock. So one account that keeps
// sending work gets one turn per round, never a run of turns in a row: a job of another account
// waits behind at most one job of each other key that has work waiting.

interface Waiter {
  id: string;
  key: string;
  grant: () => void;
}

export class FairLock {
  private holder: string | null = null;
  /** Waiters per key, oldest first. */
  private readonly byKey = new Map<string, Waiter[]>();
  /** The keys with waiters, in the order their turns come. */
  private readonly turns: string[] = [];

  /** Wait for the lock under `key`; resolves to its release function. */
  acquire(id: string, key = ''): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.holder = id;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.release(id);
        });
      };
      if (this.holder === null && this.turns.length === 0) {
        grant();
        return;
      }
      const list = this.byKey.get(key);
      if (list) list.push({ id, key, grant });
      else {
        this.byKey.set(key, [{ id, key, grant }]);
        this.turns.push(key);
      }
    });
  }

  private release(id: string): void {
    if (this.holder !== id) return;
    this.holder = null;
    const key = this.turns.shift();
    if (key === undefined) return;
    const list = this.byKey.get(key)!;
    const next = list.shift()!;
    if (list.length > 0) this.turns.push(key);
    else this.byKey.delete(key);
    next.grant();
  }

  /**
   * 1-based place of a waiter in the order the rotation would serve the CURRENT waiters; 0 for the
   * holder; undefined if unknown. (A key that starts waiting later joins the end of the rotation, so
   * a place can only move up or stay.)
   */
  position(id: string): number | undefined {
    if (this.holder === id) return 0;
    let mine: { turn: number; index: number } | null = null;
    for (let t = 0; t < this.turns.length; t++) {
      const i = this.byKey.get(this.turns[t]!)!.findIndex((w) => w.id === id);
      if (i !== -1) {
        mine = { turn: t, index: i };
        break;
      }
    }
    if (!mine) return undefined;
    // Rounds 0..index-1 serve up to `index` waiters of every key; round `index` serves the keys
    // whose turn comes before this one's first.
    let ahead = mine.index;
    for (let t = 0; t < this.turns.length; t++) {
      if (t === mine.turn) continue;
      const n = this.byKey.get(this.turns[t]!)!.length;
      ahead += Math.min(n, mine.index) + (t < mine.turn && n > mine.index ? 1 : 0);
    }
    return ahead + 1;
  }

  get running(): number {
    return this.holder === null ? 0 : 1;
  }

  get waiting(): number {
    let n = 0;
    for (const list of this.byKey.values()) n += list.length;
    return n;
  }

  get idle(): boolean {
    return this.holder === null && this.turns.length === 0;
  }
}
