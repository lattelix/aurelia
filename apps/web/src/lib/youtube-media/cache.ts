/** Bounded process-local cache. Never stores account cookies or user identities. */
export class MediaCache<T> {
  private values = new Map<string, { expires: number; value: T }>();
  private pending = new Map<string, Promise<T>>();
  constructor(private readonly maximum = 128) {}
  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return;
    if (entry.expires <= Date.now()) {
      this.values.delete(key);
      return;
    }
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, ttl: number) {
    this.values.delete(key);
    this.values.set(key, { value, expires: Date.now() + ttl });
    while (this.values.size > this.maximum)
      this.values.delete(this.values.keys().next().value!);
  }
  delete(key: string) {
    this.values.delete(key);
  }
  async resolve(
    key: string,
    ttl: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    // Bound concurrent distinct requests as well as completed entries.
    if (this.pending.size >= 24) throw new Error("Media service is busy");
    const task = loader().then((value) => {
      this.set(key, value, ttl);
      return value;
    });
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
}
