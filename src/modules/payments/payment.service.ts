import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class PaymentService {
  constructor(private prisma: PrismaService) {}

  async findByUserId(userId: string) {
    return this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    return this.prisma.payment.findUnique({ where: { id } });
  }

  async updateStatus(id: string, status: string, providerTxId?: string) {
    return this.prisma.payment.update({
      where: { id },
      data: { status, ...(providerTxId && { providerTxId }) },
    });
  }
}
