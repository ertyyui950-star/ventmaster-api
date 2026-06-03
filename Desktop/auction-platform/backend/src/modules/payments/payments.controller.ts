import { Controller, Post, Body, Param, UseGuards, Req, Logger } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';

// Prisma enums not available in SQLite provider — use local constants
const PaymentStatus = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
} as const;

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private prisma: PrismaService) {}

  @Post('callback/:provider')
  async handleCallback(@Param('provider') provider: string, @Body() data: any) {
    this.logger.log(`Payment callback from ${provider}`);
    return { received: true };
  }

  @Post(':id/confirm')
  @UseGuards(JwtAuthGuard)
  async confirmPayment(@Param('id') id: string) {
    return this.prisma.payment.update({
      where: { id },
      data: { status: PaymentStatus.COMPLETED, providerTxId: `confirmed_${Date.now()}` },
    });
  }
}
