import { IsString, Length, Matches } from 'class-validator';

export class PinAuthDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'PIN must be 6 digits' })
  pin: string;
}
