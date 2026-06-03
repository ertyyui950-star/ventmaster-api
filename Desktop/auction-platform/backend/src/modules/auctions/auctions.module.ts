import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';
import { AuctionGateway } from './auction.gateway';
import { PriceEngineService } from './price-engine.service';
import { PurchaseService } from './purchase.service';
import { ParticipationService } from './participation.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [AuctionsController],
  providers: [AuctionsService, AuctionGateway, PriceEngineService, PurchaseService, ParticipationService],
  exports: [AuctionsService, PriceEngineService],
})
export class AuctionsModule {}
