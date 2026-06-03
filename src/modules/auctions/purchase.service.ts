import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { Prisma } from '@prisma/client';

// SQLite schema uses String fields for status, not Prisma enums
const PurchaseStatus = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED',
} as const;

const ParticipationStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  WON: 'WON',
  LOST: 'LOST',
  REFUNDED: 'REFUNDED',
} as const;

const AuctionStatus = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  WON: 'WON',
  CANCELLED: 'CANCELLED',
} as const;

@Injectable()
export class PurchaseService {
  private readonly logger = new Logger(PurchaseService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  async purchaseNow(auctionId: string, userId: string) {
    const lockValue = await this.redis.acquirePurchaseLock(auctionId, 5000);
    if (!lockValue) {
      throw new BadRequestException('Purchase in progress by another user. Please try again.');
    }

    try {
      return await this.executePurchase(auctionId, userId);
    } finally {
      await this.redis.releasePurchaseLock(auctionId, lockValue);
    }
  }

  private async executePurchase(auctionId: string, userId: string) {
    return await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<any[]>`
        SELECT id, status, current_price, market_price, participation_fee
        FROM auctions WHERE id = ${auctionId} FOR UPDATE NOWAIT
      `.catch(() => { throw new BadRequestException('Auction is being processed'); });

      if (!rows || rows.length === 0) throw new BadRequestException('Auction not found');
      const a = rows[0];
      if (a.status !== 'ACTIVE') throw new BadRequestException(`Auction is not active (status: ${a.status})`);

      const participation = await tx.auctionParticipant.findUnique({
        where: { auctionId_userId: { auctionId, userId } },
      });
      if (!participation || participation.status !== ParticipationStatus.ACTIVE) {
        throw new BadRequestException('You must pay participation fee before purchasing');
      }

      const existing = await tx.purchase.findFirst({
        where: { auctionId, status: PurchaseStatus.COMPLETED },
      });
      if (existing) throw new BadRequestException('This auction has already been purchased');

      const purchase = await tx.purchase.create({
        data: { auctionId, userId, purchasePrice: a.current_price, status: PurchaseStatus.COMPLETED },
      });

      await tx.auction.update({
        where: { id: auctionId },
        data: { status: AuctionStatus.WON, endTime: new Date() },
      });

      await tx.auctionParticipant.update({
        where: { id: participation.id },
        data: { status: ParticipationStatus.WON },
      });

      await tx.auctionParticipant.updateMany({
        where: { auctionId, userId: { not: userId } },
        data: { status: ParticipationStatus.LOST },
      });

      await this.redis.removeActiveAuction(auctionId);

      this.logger.log(`Auction ${auctionId} purchased by ${userId} for ${a.current_price}`);

      return { purchaseId: purchase.id, price: a.current_price, message: 'Congratulations! You won!' };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5000,
      timeout: 10000,
    });
  }
}
