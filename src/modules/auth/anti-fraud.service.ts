import { Injectable } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';

@Injectable()
export class AntiFraudService {
  constructor(private redis: RedisService) {}

  async check(input: { telegramId: string; ipAddress?: string; fingerprint?: string }) {
    let score = 0;

    if (input.fingerprint) {
      const count = await this.redis.getDeviceUserCount(input.fingerprint);
      if (count >= 3) return { blocked: true, score: 100, reason: 'Too many accounts from same device' };
      if (count >= 2) score += 30;
    }

    if (input.ipAddress) {
      const allowed = await this.redis.checkRateLimit(`ratelimit:auth:${input.ipAddress}`, 5, 3600);
      if (!allowed) return { blocked: true, score: 80, reason: 'Rate limit exceeded' };
    }

    const blocked = await this.redis.get(`blocked:${input.telegramId}`);
    if (blocked) return { blocked: true, score: 100, reason: 'Telegram ID previously blocked' };

    return { blocked: false, score };
  }
}
