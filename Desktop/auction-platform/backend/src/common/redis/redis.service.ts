import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';

/**
 * In-memory Redis mock — works without Redis server
 * Supports all methods used in the auction platform
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private store = new Map<string, { value: string; expiresAt?: number }>();
  private subscribers = new Map<string, Set<(channel: string, message: string) => void>>();

  constructor() {
    this.logger.log('Using in-memory Redis (no Redis server needed)');
    // Cleanup expired keys every 60s
    setInterval(() => this.cleanup(), 60000);
  }

  async onModuleDestroy() {
    this.store.clear();
    this.subscribers.clear();
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.store.delete(key);
      }
    }
  }

  private isExpired(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return true;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return true;
    }
    return false;
  }

  async get(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null;
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: any[]): Promise<void> {
    let expiresAt: number | undefined;
    // Handle SET key value EX seconds
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      expiresAt = Date.now() + args[1] * 1000;
    } else if (args[0] === 'PX' && typeof args[1] === 'number') {
      expiresAt = Date.now() + args[1];
    }
    // Handle SET key value NX
    if (args.includes('NX') && this.store.has(key) && !this.isExpired(key)) {
      return;
    }
    this.store.set(key, { value, expiresAt });
  }

  async setex(key: string, seconds: number, value: string): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(key: string): Promise<number> {
    const val = await this.get(key);
    const newVal = (val ? parseInt(val, 10) : 0) + 1;
    this.store.set(key, { value: String(newVal) });
    return newVal;
  }

  async expire(key: string, seconds: number): Promise<void> {
    const entry = this.store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + seconds * 1000;
    }
  }

  // Set operations
  async sadd(key: string, ...members: string[]): Promise<number> {
    const val = await this.get(key);
    const set = new Set(val ? JSON.parse(val) : []);
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) { set.add(m); added++; }
    }
    await this.set(key, JSON.stringify([...set]));
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const val = await this.get(key);
    if (!val) return 0;
    const set = new Set(JSON.parse(val));
    let removed = 0;
    for (const m of members) {
      if (set.has(m)) { set.delete(m); removed++; }
    }
    await this.set(key, JSON.stringify([...set]));
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    const val = await this.get(key);
    return val ? JSON.parse(val) : [];
  }

  async scard(key: string): Promise<number> {
    const members = await this.smembers(key);
    return members.length;
  }

  // Pub/sub
  async publish(channel: string, message: string): Promise<void> {
    const subs = this.subscribers.get(channel);
    if (subs) {
      for (const cb of subs) cb(channel, message);
    }
  }

  subscribe(channel: string, callback: (channel: string, message: string) => void): void {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    this.subscribers.get(channel)!.add(callback);
  }

  // Application-specific methods
  async getAuctionPrice(auctionId: string): Promise<string | null> {
    return this.get(`auction:${auctionId}:price`);
  }

  async setAuctionPrice(auctionId: string, price: string): Promise<void> {
    await this.set(`auction:${auctionId}:price`, price);
  }

  async getActiveAuctions(): Promise<string[]> {
    return this.smembers('auctions:active');
  }

  async addActiveAuction(auctionId: string): Promise<void> {
    await this.sadd('auctions:active', auctionId);
  }

  async removeActiveAuction(auctionId: string): Promise<void> {
    await this.srem('auctions:active', auctionId);
    await this.del(`auction:${auctionId}:price`);
  }

  async acquirePurchaseLock(auctionId: string, ttlMs: number): Promise<string | null> {
    const lockValue = `lock_${Date.now()}_${Math.random()}`;
    const key = `lock:purchase:${auctionId}`;
    await this.set(key, lockValue, 'PX', ttlMs, 'NX');
    const val = await this.get(key);
    return val === lockValue ? lockValue : null;
  }

  async releasePurchaseLock(auctionId: string, lockValue: string): Promise<void> {
    const key = `lock:purchase:${auctionId}`;
    const current = await this.get(key);
    if (current === lockValue) await this.del(key);
  }

  async storeSession(token: string, data: any, ttlSeconds: number): Promise<void> {
    await this.setex(`session:${token}`, ttlSeconds, JSON.stringify(data));
  }

  async getSession(token: string): Promise<any | null> {
    const data = await this.get(`session:${token}`);
    return data ? JSON.parse(data) : null;
  }

  async trackDevice(fingerprint: string, userId: string): Promise<void> {
    await this.sadd(`device:${fingerprint}:users`, userId);
  }

  async getDeviceUserCount(fingerprint: string): Promise<number> {
    return this.scard(`device:${fingerprint}:users`);
  }

  async checkRateLimit(key: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    const current = await this.incr(key);
    if (current === 1) await this.expire(key, windowSeconds);
    return current <= maxRequests;
  }

  async publishPriceUpdate(auctionId: string, price: string): Promise<void> {
    await this.publish('price:updates', JSON.stringify({ auctionId, price, timestamp: Date.now() }));
  }

  async addParticipant(auctionId: string, userId: string): Promise<void> {
    await this.sadd(`auction:${auctionId}:participants`, userId);
  }

  async getParticipantCount(auctionId: string): Promise<number> {
    return this.scard(`auction:${auctionId}:participants`);
  }
}
