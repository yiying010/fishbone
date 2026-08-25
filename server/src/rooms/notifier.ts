import { EventEmitter } from "node:events";

/**
 * Wakes held long-poll requests when a room changes.
 *
 * This is in-process only. The hold loop in routes/rooms.ts also re-checks the
 * database on a timer, so running more than one replica still converges: the
 * notifier just makes the common single-container case instant instead of
 * costing up to one probe interval.
 */
export class RoomNotifier {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per waiting client; a class of 40 on one room is normal.
    this.emitter.setMaxListeners(0);
  }

  notify(code: string, revision: number): void {
    this.emitter.emit(key(code), revision);
  }

  /** Resolves with the new revision, or null if nothing happened within `timeoutMs`. */
  wait(code: string, timeoutMs: number, signal: AbortSignal): Promise<number | null> {
    return new Promise((resolve) => {
      const channel = key(code);
      let settled = false;
      const done = (value: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emitter.off(channel, onChange);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onChange = (revision: number) => done(revision);
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);

      this.emitter.on(channel, onChange);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}

function key(code: string): string {
  return `room:${code.toLowerCase()}`;
}
