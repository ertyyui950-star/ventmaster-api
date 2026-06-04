import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TelegramBotService } from './telegram-bot.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('jwtSecret'),
        signOptions: { expiresIn: config.get('jwtAccessExpiration', '15m') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TelegramBotService],
  exports: [AuthService],
})
export class AuthModule {}
