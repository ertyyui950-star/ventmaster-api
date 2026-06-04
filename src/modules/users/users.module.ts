import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [JwtModule.register({}), CryptoModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
