import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

@WebSocketGateway({ cors: { origin: '*' }, namespace: 'auctions', pingInterval: 10000, pingTimeout: 5000 })
export class AuctionGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(AuctionGateway.name);

  constructor(private redis: RedisService, private jwt: JwtService, private prisma: PrismaService) {}

  afterInit() {
    this.logger.log('WS Gateway ready');
    setInterval(() => this.tick(), 1000);
  }

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token || client.handshake.query?.token;
      if (!token) { client.disconnect(true); return; }
      const decoded = this.jwt.verify(token as string, { secret: process.env.JWT_SECRET });
      client.data.userId = (decoded as any).sub;
    } catch { client.disconnect(true); }
  }

  handleDisconnect() {}

  private broadcast(auctionId: string, price: string) {
    this.server.to(`auction:${auctionId}`).emit('priceUpdate', { auctionId, price, timestamp: Date.now() });
  }

  private async tick() {
    try {
      const ids = await this.redis.getActiveAuctions();
      for (const id of ids) {
        const a = await this.prisma.auction.findUnique({ where: { id } });
        if (!a || a.status !== 'ACTIVE') { await this.redis.removeActiveAuction(id); continue; }
        const elapsed = Math.floor((Date.now() - a.actualStart!.getTime()) / 1000);
        const intervals = Math.floor(elapsed / a.priceDropInterval);
        const newPrice = Number(a.startPrice) - (intervals * Number(a.priceDropAmount));

        if (newPrice <= Number(a.minPrice)) {
          await this.prisma.auction.update({ where: { id }, data: { status: 'EXPIRED', endTime: new Date() } });
          await this.redis.removeActiveAuction(id);
          this.broadcast(id, 'EXPIRED');
          continue;
        }

        const cached = await this.redis.getAuctionPrice(id);
        const current = cached ? parseFloat(cached) : Number(a.currentPrice);
        if (newPrice < current) {
          await Promise.all([
            this.prisma.auction.update({ where: { id }, data: { currentPrice: newPrice } }),
            this.redis.setAuctionPrice(id, String(newPrice)),
          ]);
          this.broadcast(id, String(newPrice));
        }
      }
    } catch (err: any) {
      this.logger.error(`Tick error: ${err.message}`);
    }
  }
}
