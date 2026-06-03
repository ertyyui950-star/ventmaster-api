import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly BOT_TOKEN: string;
  private readonly isDev: boolean;

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {
    this.BOT_TOKEN = this.config.get('telegramBotToken', '');
    this.isDev = this.config.get('nodeEnv', 'development') === 'development';
  }

  async telegramAuth(payload: any) {
    const { hash, ...fields } = payload;

    // Verify Telegram hash (skip in dev mode with dev_mode hash)
    if (hash === 'dev_mode' && this.isDev) {
      this.logger.log('DEV MODE: skipping Telegram hash verification');
    } else if (!this.BOT_TOKEN) {
      throw new UnauthorizedException('Server not configured for Telegram auth');
    } else if (!this.verifyTelegramHash(hash, fields)) {
      throw new UnauthorizedException('Invalid Telegram authentication data');
    }

    // Check auth_date
    const authDate = Number(fields.auth_date);
    const now = Math.floor(Date.now() / 1000);
    if (isNaN(authDate) || now - authDate > 300) {
      throw new UnauthorizedException('Authentication data expired');
    }

    const telegramId = String(fields.id);
    let user = await this.prisma.user.findUnique({ where: { telegramId } });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          telegramId,
          telegramUsername: fields.username || null,
          firstName: fields.first_name || 'Unknown',
          lastName: fields.last_name || null,
          country: 'AM',
          registrationIp: payload.ipAddress || null,
        },
      });
      this.logger.log(`New user: ${user.id} (telegram: ${telegramId})`);
    } else {
      if (user.isBlocked) throw new UnauthorizedException('Account blocked');
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          telegramUsername: fields.username || user.telegramUsername,
          firstName: fields.first_name || user.firstName,
        },
      });
    }

    const tokens = await this.generateTokenPair(user.id, user.telegramId);
    return { ...tokens, user: { id: user.id, telegramId: user.telegramId, firstName: user.firstName, lastName: user.lastName, username: user.telegramUsername, isVerified: user.isVerified } };
  }

  async pinAuth(pin: string, ipAddress: string) {
    const pinRecord = await this.prisma.authPin.findUnique({ where: { pin } });
    if (!pinRecord) throw new UnauthorizedException('Invalid PIN');
    if (pinRecord.used) throw new UnauthorizedException('PIN already used');
    if (pinRecord.expiresAt < new Date()) {
      await this.prisma.authPin.delete({ where: { pin } });
      throw new UnauthorizedException('PIN expired');
    }

    await this.prisma.authPin.update({ where: { pin }, data: { used: true } });

    const telegramId = String(pinRecord.telegramId);
    let user = await this.prisma.user.findUnique({ where: { telegramId } });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          telegramId,
          telegramUsername: pinRecord.username || null,
          firstName: pinRecord.firstName || 'Unknown',
          lastName: pinRecord.lastName || null,
          country: 'AM',
          registrationIp: ipAddress || null,
        },
      });
      this.logger.log(`New user via PIN: ${user.id} (telegram: ${telegramId})`);
    }

    const tokens = await this.generateTokenPair(user.id, user.telegramId);
    return { ...tokens, user: { id: user.id, telegramId: user.telegramId, firstName: user.firstName, lastName: user.lastName, username: user.telegramUsername, isVerified: user.isVerified } };
  }

  async generatePin(data: { telegramId: number; firstName: string; lastName?: string; username?: string }): Promise<string> {
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    await this.prisma.authPin.create({
      data: {
        pin,
        telegramId: String(data.telegramId),
        firstName: data.firstName,
        lastName: data.lastName || null,
        username: data.username || null,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });
    return pin;
  }

  async refreshTokens(refreshToken: string) {
    try {
      const decoded = this.jwt.verify(refreshToken, { secret: this.config.get('jwtRefreshSecret') });
      const user = await this.prisma.user.findUnique({ where: { id: (decoded as any).sub } });
      if (!user || user.isBlocked) throw new UnauthorizedException('User not found');
      return this.generateTokenPair(user.id, user.telegramId);
    } catch { throw new UnauthorizedException('Invalid refresh token'); }
  }

  private verifyTelegramHash(hash: string, fields: Record<string, any>): boolean {
    if (!this.BOT_TOKEN) return true;
    if (!hash || typeof hash !== 'string') return false;
    const secretKey = crypto.createHash('sha256').update(this.BOT_TOKEN).digest();
    const dataCheckString = Object.keys(fields).filter(k => fields[k] !== undefined && fields[k] !== null && k !== 'hash').sort().map(k => `${k}=${fields[k]}`).join('\n');
    const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(hash, 'hex')); } catch { return false; }
  }

  private async generateTokenPair(userId: string, telegramId: string) {
    const payload = { sub: userId, telegramId };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, { secret: this.config.get('jwtSecret'), expiresIn: this.config.get('jwtAccessExpiration', '15m') }),
      this.jwt.signAsync(payload, { secret: this.config.get('jwtRefreshSecret'), expiresIn: this.config.get('jwtRefreshExpiration', '30d') }),
    ]);
    return { accessToken, refreshToken, expiresIn: 900 };
  }
}
