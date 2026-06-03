import { IsNumber, IsString, IsOptional, IsBoolean } from 'class-validator';

export class TelegramAuthDto {
  @IsOptional() @IsString() id?: string;
  @IsOptional() @IsNumber() id_number?: number;
  @IsString() first_name: string;
  @IsOptional() @IsString() last_name?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() photo_url?: string;
  @IsOptional() @IsString() auth_date?: string;
  @IsOptional() @IsNumber() auth_date_number?: number;
  @IsString() hash: string;
  @IsOptional() @IsString() deviceFingerprint?: string;
}

export class RefreshTokenDto {
  @IsString() refreshToken: string;
}
