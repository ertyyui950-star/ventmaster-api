import { Controller, Get, Post, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { AuctionsService } from './auctions.service';
import { PurchaseService } from './purchase.service';
import { ParticipationService } from './participation.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';

@Controller('auctions')
export class AuctionsController {
  constructor(
    private auctions: AuctionsService,
    private purchaseSvc: PurchaseService,
    private participationSvc: ParticipationService,
  ) {}

  @Public()
  @Get()
  findAll(@Query() query: any) {
    return this.auctions.findAll(query);
  }

  @Public()
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.auctions.findOne(id);
  }

  @Public()
  @Get(':id/price-history')
  getPriceHistory(@Param('id') id: string) {
    return this.auctions.getPriceHistory(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: any, @Req() req: any) {
    return this.auctions.create(dto, req.user.sub);
  }

  @Post(':id/start')
  @UseGuards(JwtAuthGuard)
  start(@Param('id') id: string) {
    return this.auctions.start(id);
  }

  @Post(':id/participate')
  @UseGuards(JwtAuthGuard)
  participate(@Param('id') id: string, @Body('provider') provider: string, @Req() req: any) {
    return this.participationSvc.joinAuction(req.user.sub, id, provider || 'IDRAM');
  }

  @Post(':id/purchase')
  @UseGuards(JwtAuthGuard)
  purchase(@Param('id') id: string, @Req() req: any) {
    return this.purchaseSvc.purchaseNow(id, req.user.sub);
  }
}
