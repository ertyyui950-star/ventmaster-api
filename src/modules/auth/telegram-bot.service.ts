import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly BOT_TOKEN: string;
  private isPolling = false;
  private lastUpdateId = 0;

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {
    this.BOT_TOKEN = this.config.get('telegramBotToken', '');
  }

  onModuleInit() {
    if (this.BOT_TOKEN) {
      this.startPolling();
    } else {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — bot disabled');
    }
  }

  startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;
    this.logger.log('Telegram bot polling started');
    this.poll();
  }

  stopPolling() {
    this.isPolling = false;
    this.logger.log('Telegram bot polling stopped');
  }

  async onModuleDestroy() {
    this.stopPolling();
  }

  private async poll() {
    while (this.isPolling) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.lastUpdateId = update.update_id;
          await this.handleUpdate(update);
        }
      } catch (error: any) {
        if (error.message?.includes('409') || error.message?.includes('Conflict')) {
          this.logger.error('Another bot instance detected. Stopping.');
          this.stopPolling();
          return;
        }
        this.logger.error(`Poll error: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  private async getUpdates(): Promise<any[]> {
    const url = `https://api.telegram.org/bot${this.BOT_TOKEN}/getUpdates`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset: this.lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ['message'],
      }),
    });
    const data = await response.json();
    if (!data.ok) {
      if (data.description?.includes('Conflict') || data.description?.includes('409')) {
        throw new Error('409 Conflict: another bot instance is running');
      }
      throw new Error(`Telegram API error: ${data.description}`);
    }
    return data.result || [];
  }

  private async handleUpdate(update: any) {
    try {
      if (update.message?.text) {
        const chatId = update.message.chat.id;
        const text = update.message.text.trim();
        const user = update.message.from;

        this.logger.log(`Message from ${user.id} (@${user.username}): ${text}`);

        if (text.startsWith('/start')) {
          const pin = await this.authService.generatePin({
            telegramId: user.id,
            firstName: user.first_name || 'Unknown',
            lastName: user.last_name,
            username: user.username,
          });

          const welcomeText =
            `Welcome to DropAuction!\n\n` +
            `Your login PIN: *${pin}*\n\n` +
            `Enter this PIN in the mobile app to log in.\n\n` +
            `⚠️ PIN expires in 5 minutes.\n` +
            `🔒 Keep it secret — do not share with anyone.`;

          await this.sendMessage(chatId, welcomeText);
          this.logger.log(`Sent PIN ${pin} to user ${user.id}`);
        } else if (text === '/help') {
          await this.sendMessage(
            chatId,
            `DropAuction Bot\n\n/start — Get a login PIN\n/help — Show this help`,
          );
        } else {
          await this.sendMessage(chatId, `Send /start to get a login PIN.`);
        }
      }
    } catch (error: any) {
      this.logger.error(`Handle update error: ${error.message}`);
    }
  }

  private async sendMessage(chatId: number, text: string) {
    const url = `https://api.telegram.org/bot${this.BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  }
}
