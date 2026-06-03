import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

// SQLite schema uses String fields for status, not Prisma enums
const AuctionStatus = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  WON: 'WON',
  CANCELLED: 'CANCELLED',
} as const;

@Injectable()
export class PriceEngineService {
  private readonly logger = new Logger(PriceEngineService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  calculateMinPrice(marketPrice: number, participationFee: number): number {
    const assumedCost = marketPrice * 0.60;
    return Math.max(marketPrice * 0.10, assumedCost * 1.05, participationFee * 3);
  }

  async processPriceDrops() {
    const activeIds = await this.redis.getActiveAuctions();
    for (const auctionId of activeIds) {
      try {
        await this.dropPrice(auctionId);
      } catch (err: any) {
        this.logger.error(`Price drop failed for ${auctionId}: ${err.message}`);
      }
    }
  }

  private async dropPrice(auctionId: string) {
    const auction = await this.prisma.auction.findUnique({ where: { id: auctionId } });
    if (!auction || auction.status !== AuctionStatus.ACTIVE) {
      await this.redis.removeActiveAuction(auctionId);
      return;
    }

    if (!auction.actualStart) return;

    const elapsed = Math.floor((Date.now() - auction.actualStart.getTime()) / 1000);
    const intervals = Math.floor(elapsed / auction.priceDropInterval);
    const newPrice = Number(auction.startPrice) - (intervals * Number(auction.priceDropAmount));

    if (newPrice <= Number(auction.minPrice)) {
      await this.prisma.auction.update({
        where: { id: auctionId },
        data: { status: AuctionStatus.EXPIRED, endTime: new Date() },
      });
      await this.redis.removeActiveAuction(auctionId);
      this.logger.log(`Auction expired: ${auctionId}`);
      return;
    }

    const cached = await this.redis.getAuctionPrice(auctionId);
    const current = cached ? parseFloat(cached) : Number(auction.currentPrice);

    if (newPrice < current) {
      await Promise.all([
        this.prisma.auction.update({ where: { id: auctionId }, data: { currentPrice: newPrice } }),
        this.prisma.priceHistory.create({ data: { auctionId, price: newPrice } }),
        this.redis.setAuctionPrice(auctionId, String(newPrice)),
        this.redis.publishPriceUpdate(auctionId, String(newPrice)),
      ]);
    }
  }
}
