import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private bot: any;

  constructor(private config: ConfigService) {
    const token = this.config.get('telegramBotToken');
    if (token) {
      try {
        const { Telegraf } = require('telegraf');
        this.bot = new Telegraf(token);
      } catch {
        this.logger.warn('Telegraf not installed');
      }
    }
  }

  async notifyAuctionWon(telegramId: string, auctionId: string) {
    await this.sendTelegram(telegramId, '🎉 You won the auction!');
  }

  async notifyAuctionLost(telegramId: string, auctionId: string) {
    await this.sendTelegram(telegramId, '😔 You lost the auction. Better luck next time!');
  }

  async notifyPriceDrop(telegramId: string, auctionId: string, newPrice: number) {
    await this.sendTelegram(telegramId, `📉 Price dropped to ${newPrice} ֏!`);
  }

  private async sendTelegram(telegramId: string, message: string) {
    if (!this.bot) return;
    try {
      await this.bot.telegram.sendMessage(telegramId, message);
    } catch (err: any) {
      this.logger.error(`Telegram send failed: ${err.message}`);
    }
  }
}
