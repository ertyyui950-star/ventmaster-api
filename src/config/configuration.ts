import { config } from 'dotenv';
config();

export default () => ({
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',
  jwtSecret: process.env.JWT_SECRET || 'change-this-secret-in-production-32chars!',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'change-this-refresh-secret-32chars!!',
  jwtAccessExpiration: process.env.JWT_ACCESS_EXPIRATION || '15m',
  jwtRefreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '30d',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  corsOrigins: process.env.CORS_ORIGINS || '*',
});
