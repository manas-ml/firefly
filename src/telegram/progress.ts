/**
 * Coalesces status updates so the status message is edited at most once per
 * interval: the first update goes out immediately, later ones within the window
 * are merged and sent at the end of it (latest text wins).
 */
export class Throttle {
  private lastSent = Number.NEGATIVE_INFINITY;
  private pending: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastText: string | undefined;
  private closed = false;

  constructor(
    private readonly intervalMs: number,
    private readonly send: (text: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  update(text: string): void {
    if (this.closed || text === this.lastText) return;
    const wait = this.lastSent + this.intervalMs - this.now();
    if (wait <= 0 && !this.timer) {
      this.flushText(text);
      return;
    }
    this.pending = text;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.pending !== undefined) this.flushText(this.pending);
      }, Math.max(wait, 0));
    }
  }

  private flushText(text: string): void {
    this.pending = undefined;
    if (text === this.lastText) return;
    this.lastText = text;
    this.lastSent = this.now();
    this.send(text);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
}
