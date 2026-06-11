// spine/asyncqueue.ts — a minimal push/pull async queue backing AsyncIterable subscribers.
export class AsyncQueue<T> {
  private buf: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.buf.push(v);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as unknown as T, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          if (this.buf.length) resolve({ value: this.buf.shift()!, done: false });
          else if (this.closed) resolve({ value: undefined as unknown as T, done: true });
          else this.waiters.push(resolve);
        }),
    };
  }
}
