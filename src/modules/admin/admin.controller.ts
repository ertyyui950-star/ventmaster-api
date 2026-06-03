import { Controller, Get, Put, Param, Query, UseGuards, Req, Logger } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(private prisma: PrismaService) {}

  @Get('users')
  async getUsers(@Query('page') page = 1, @Query('limit') limit = 20, @Query('search') search?: string) {
    const where = search
      ? { OR: [{ firstName: { contains: search } }, { lastName: { contains: search } }] }
      : {};
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.user.count({ where }),
    ]);
    return { data: users, meta: { page, limit, total } };
  }

  @Put('users/:id/block')
  async blockUser(@Param('id') id: string) {
    return this.prisma.user.update({ where: { id }, data: { isBlocked: true } });
  }

  @Put('users/:id/unblock')
  async unblockUser(@Param('id') id: string) {
    return this.prisma.user.update({ where: { id }, data: { isBlocked: false } });
  }

  @Get('stats')
  async getStats() {
    const [totalUsers, totalAuctions, activeAuctions, revenue] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.auction.count(),
      this.prisma.auction.count({ where: { status: 'ACTIVE' } }),
      this.prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'COMPLETED' } }),
    ]);
    return { totalUsers, totalAuctions, activeAuctions, totalRevenue: revenue._sum.amount || 0 };
  }

  @Get('health')
  async health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
