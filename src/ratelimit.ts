/**
 * A rolling-window limiter: at most `max` takes in any `windowMs` span.
 * In memory, per process; it resets when the process restarts.
 */
export class RollingLimiter {
  private stamps: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, now: () => number = () => Date.now()) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Records a use and returns true, or returns false when the window is full. */
  take(): boolean {
    this.prune();
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(this.now());
    return true;
  }

  /** How many takes are left in the current window. */
  remaining(): number {
    this.prune();
    return this.max - this.stamps.length;
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.stamps.length > 0 && (this.stamps[0] as number) <= cutoff) this.stamps.shift();
  }
}
