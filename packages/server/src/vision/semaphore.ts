export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error('Vision concurrency must be a positive integer.');
    }
    this.available = maximum;
  }

  async use<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.available += 1;
    else waiter();
  }
}
