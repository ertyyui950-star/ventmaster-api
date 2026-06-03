import { Controller, Get, Put, UseGuards, Req, Body } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private prisma: PrismaService, private crypto: CryptoService) {}

  @Get('me')
  async getProfile(@Req() req: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.sub },
      include: { settings: true },
    });
    return user;
  }

  @Put('me')
  async updateProfile(@Req() req: any, @Body() dto: any) {
    const data: any = {};
    if (dto.firstName) data.firstName = dto.firstName;
    if (dto.lastName) data.lastName = dto.lastName;
    if (dto.middleName) data.middleName = dto.middleName;
    if (dto.birthDate) data.birthDate = new Date(dto.birthDate);
    if (dto.phone) data.phone = dto.phone;
    if (dto.email) data.email = dto.email;
    if (dto.passportNumber) {
      const enc = this.crypto.encrypt(dto.passportNumber);
      data.passportEncrypted = enc.encrypted;
      data.passportIv = enc.iv;
      data.passportTag = enc.tag;
    }

    return this.prisma.user.update({ where: { id: req.user.sub }, data });
  }

  @Get('me/participations')
  async getParticipations(@Req() req: any) {
    return this.prisma.auctionParticipant.findMany({
      where: { userId: req.user.sub },
      include: { auction: { include: { images: { take: 1 } } } },
      orderBy: { joinedAt: 'desc' },
    });
  }

  @Get('me/purchases')
  async getPurchases(@Req() req: any) {
    return this.prisma.purchase.findMany({
      where: { userId: req.user.sub },
      include: { auction: { include: { images: { take: 1 } } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get('me/payments')
  async getPayments(@Req() req: any) {
    return this.prisma.payment.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: 'desc' },
    });
  }
}
