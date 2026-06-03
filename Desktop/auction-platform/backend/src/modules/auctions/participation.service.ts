import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

// SQLite schema uses String fields for status, not Prisma enums
const ParticipationStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  WON: 'WON',
  LOST: 'LOST',
  REFUNDED: 'REFUNDED',
} as const;

const PaymentStatus = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
} as const;

const PaymentType = {
  PARTICIPATION_FEE: 'PARTICIPATION_FEE',
  PURCHASE: 'PURCHASE',
  REFUND: 'REFUND',
} as const;

const PaymentProvider = {
  IDRAM: 'IDRAM',
  TELCELL: 'TELCELL',
  STRIPE: 'STRIPE',
  PAYPAL: 'PAYPAL',
} as const;

@Injectable()
export class ParticipationService {
  constructor(private prisma: PrismaService, private redis: RedisService) {}

  async joinAuction(userId: string, auctionId: string, provider: string) {
    const auction = await this.prisma.auction.findUnique({ where: { id: auctionId } });
    if (!auction || auction.status !== 'ACTIVE') throw new Error('Auction is not active');

    if (auction.maxParticipants) {
      const count = await this.prisma.auctionParticipant.count({ where: { auctionId, status: ParticipationStatus.ACTIVE } });
      if (count >= auction.maxParticipants) throw new Error('Max participants reached');
    }

    const existing = await this.prisma.auctionParticipant.findUnique({
      where: { auctionId_userId: { auctionId, userId } },
    });

    if (existing?.status === ParticipationStatus.ACTIVE) throw new Error('Already participating');

    if (existing) {
      await this.prisma.auctionParticipant.update({ where: { id: existing.id }, data: { status: ParticipationStatus.ACTIVE } });
      return { status: 'ACTIVE' };
    }

    const payment = await this.prisma.payment.create({
      data: {
        userId, amount: auction.participationFee, currency: auction.country === 'RU' ? 'RUB' : 'AMD',
        provider, type: PaymentType.PARTICIPATION_FEE, status: PaymentStatus.PENDING,
        metadata: JSON.stringify({ auctionId }),
      },
    });

    await this.prisma.auctionParticipant.create({
      data: { auctionId, userId, status: ParticipationStatus.PENDING, paymentId: payment.id },
    });

    return { paymentId: payment.id, amount: auction.participationFee.toString(), currency: auction.country === 'RU' ? 'RUB' : 'AMD', provider };
  }
}
