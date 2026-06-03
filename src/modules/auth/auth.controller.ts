import { Controller, Post, Body, HttpCode, HttpStatus, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { TelegramAuthDto } from './dto/telegram-auth.dto';
import { PinAuthDto } from './dto/pin-auth.dto';
import { Public } from '../../common/decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('telegram')
  @HttpCode(HttpStatus.OK)
  async telegramAuth(@Body() dto: TelegramAuthDto, @Req() req: any) {
    return this.authService.telegramAuth({
      ...dto,
      ipAddress: req.ip,
    });
  }

  @Public()
  @Post('pin')
  @HttpCode(HttpStatus.OK)
  async pinAuth(@Body() dto: PinAuthDto, @Req() req: any) {
    return this.authService.pinAuth(dto.pin, req.ip);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body('refreshToken') refreshToken: string) {
    return this.authService.refreshTokens(refreshToken);
  }
}
