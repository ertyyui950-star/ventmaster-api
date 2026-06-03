import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { PriceEngineService } from './price-engine.service';
import { Prisma } from '@prisma/client';

// Prisma enums not available in SQLite provider — use local constants
const AuctionStatus = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  WON: 'WON',
  CANCELLED: 'CANCELLED',
} as const;

type AuctionStatusType = (typeof AuctionStatus)[keyof typeof AuctionStatus];

@Injectable()
export class AuctionsService {
  private readonly logger = new Logger(AuctionsService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private priceEngine: PriceEngineService,
  ) {}

  async create(dto: any, organizerId: string) {
    const startPrice = Number(dto.marketPrice) - Number(dto.participationFee);
    const minPrice = this.priceEngine.calculateMinPrice(Number(dto.marketPrice), Number(dto.participationFee));

    if (startPrice <= minPrice) {
      throw new BadRequestException(
        `Start price (${startPrice}) must be > min price (${minPrice})`,
      );
    }

    const auction = await this.prisma.auction.create({
      data: {
        title: dto.title,
        description: dto.description,
        categoryId: dto.categoryId,
        marketPrice: dto.marketPrice,
        participationFee: dto.participationFee,
        startPrice,
        currentPrice: startPrice,
        minPrice,
        priceDropInterval: dto.priceDropInterval || 60,
        priceDropAmount: dto.participationFee,
        scheduledStart: dto.scheduledStart ? new Date(dto.scheduledStart) : null,
        status: dto.scheduledStart ? AuctionStatus.SCHEDULED : AuctionStatus.DRAFT,
        country: dto.country || 'AM',
        maxParticipants: dto.maxParticipants,
        organizerId,
        images: { create: (dto.images || []).map((url: string, i: number) => ({ url, order: i })) },
        videos: { create: (dto.videos || []).map((url: string) => ({ url })) },
      },
      include: { images: true, videos: true },
    });

    this.logger.log(`Auction created: ${auction.id}`);
    return auction;
  }

  async findAll(params: { status?: string; country?: string; categoryId?: string; search?: string; page?: number; limit?: number }) {
    const { status, country, categoryId, search, page = 1, limit = 20 } = params;
    const where: Prisma.AuctionWhereInput = {
      ...(status && { status }),
      ...(country && { country }),
      ...(categoryId && { categoryId }),
    };

    const [auctions, total] = await Promise.all([
      this.prisma.auction.findMany({
        where,
        include: {
          images: { orderBy: { order: 'asc' }, take: 1 },
          _count: { select: { participations: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auction.count({ where }),
    ]);

    return {
      data: auctions.map(a => ({ ...a, participantsCount: a._count.participations, _count: undefined })),
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      include: {
        images: { orderBy: { order: 'asc' } },
        videos: true,
        _count: { select: { participations: true } },
      },
    });
    if (!auction) throw new NotFoundException('Auction not found');

    if (auction.status === AuctionStatus.ACTIVE) {
      const cachedPrice = await this.redis.getAuctionPrice(id);
      if (cachedPrice) auction.currentPrice = Number(cachedPrice) as any;
    }

    return { ...auction, participantsCount: auction._count?.participations || 0 };
  }

  async start(auctionId: string) {
    const auction = await this.prisma.auction.findUnique({ where: { id: auctionId } });
    if (!auction) throw new NotFoundException('Auction not found');

    await this.prisma.auction.update({
      where: { id: auctionId },
      data: { status: AuctionStatus.ACTIVE, actualStart: new Date(), currentPrice: Number(auction.startPrice) },
    });

    await this.redis.addActiveAuction(auctionId);
    await this.redis.setAuctionPrice(auctionId, auction.startPrice.toString());

    this.logger.log(`Auction started: ${auctionId}`);
    return { id: auctionId, status: 'ACTIVE' };
  }

  async getPriceHistory(auctionId: string) {
    return this.prisma.priceHistory.findMany({
      where: { auctionId },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });
  }
}
