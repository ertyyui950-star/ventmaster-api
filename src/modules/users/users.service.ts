import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: { settings: true },
    });
  }

  async findByTelegramId(telegramId: string) {
    return this.prisma.user.findUnique({
      where: { telegramId },
      include: { settings: true },
    });
  }

  async updateProfile(id: string, data: any) {
    return this.prisma.user.update({ where: { id }, data });
  }

  async getParticipations(userId: string) {
    return this.prisma.auctionParticipant.findMany({
      where: { userId },
      include: { auction: { include: { images: { take: 1 } } } },
      orderBy: { joinedAt: 'desc' },
    });
  }

  async getPurchases(userId: string) {
    return this.prisma.purchase.findMany({
      where: { userId },
      include: { auction: { include: { images: { take: 1 } } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPayments(userId: string) {
    return this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
