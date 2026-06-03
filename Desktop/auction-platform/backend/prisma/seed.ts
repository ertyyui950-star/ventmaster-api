import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Categories
  const electronics = await prisma.category.upsert({
    where: { id: 'cat-electronics' },
    update: {},
    create: {
      id: 'cat-electronics',
      name: 'Electronics',
      icon: '📱',
      sortOrder: 1,
    },
  });

  const fashion = await prisma.category.upsert({
    where: { id: 'cat-fashion' },
    update: {},
    create: {
      id: 'cat-fashion',
      name: 'Fashion',
      icon: '👗',
      sortOrder: 2,
    },
  });

  const home = await prisma.category.upsert({
    where: { id: 'cat-home' },
    update: {},
    create: {
      id: 'cat-home',
      name: 'Home & Garden',
      icon: '🏠',
      sortOrder: 3,
    },
  });

  const cars = await prisma.category.upsert({
    where: { id: 'cat-cars' },
    update: {},
    create: {
      id: 'cat-cars',
      name: 'Cars',
      icon: '🚗',
      sortOrder: 4,
    },
  });

  // Demo user
  const demoUser = await prisma.user.upsert({
    where: { telegramId: '000000001' },
    update: {},
    create: {
      telegramId: '000000001',
      firstName: 'Demo',
      lastName: 'User',
      birthDate: new Date('1995-06-15'),
      country: 'AM',
      isVerified: true,
    },
  });

  await prisma.userSettings.upsert({
    where: { userId: demoUser.id },
    update: {},
    create: { userId: demoUser.id, language: 'ru' },
  });

  // Demo auctions
  const now = new Date();

  await prisma.auction.upsert({
    where: { id: 'auction-demo-1' },
    update: {},
    create: {
      id: 'auction-demo-1',
      title: 'iPhone 15 Pro Max 256GB',
      description: 'Brand new iPhone 15 Pro Max in perfect condition. Full package.',
      categoryId: electronics.id,
      organizerId: demoUser.id,
      marketPrice: 500000,
      participationFee: 2000,
      startPrice: 498000,
      currentPrice: 498000,
      minPrice: 150000,
      priceDropInterval: 60,
      priceDropAmount: 2000,
      status: 'ACTIVE',
      country: 'AM',
      actualStart: now,
      maxParticipants: 100,
      images: { create: [
        { url: 'https://picsum.photos/seed/iphone1/800/600', order: 0 },
        { url: 'https://picsum.photos/seed/iphone2/800/600', order: 1 },
      ]},
    },
  });

  await prisma.auction.upsert({
    where: { id: 'auction-demo-2' },
    update: {},
    create: {
      id: 'auction-demo-2',
      title: 'MacBook Pro 14" M3',
      description: 'MacBook Pro 14 inch with M3 chip. Like new.',
      categoryId: electronics.id,
      organizerId: demoUser.id,
      marketPrice: 800000,
      participationFee: 3000,
      startPrice: 797000,
      currentPrice: 797000,
      minPrice: 240000,
      priceDropInterval: 60,
      priceDropAmount: 3000,
      status: 'ACTIVE',
      country: 'AM',
      actualStart: now,
      maxParticipants: 50,
      images: { create: [
        { url: 'https://picsum.photos/seed/macbook1/800/600', order: 0 },
      ]},
    },
  });

  await prisma.auction.upsert({
    where: { id: 'auction-demo-3' },
    update: {},
    create: {
      id: 'auction-demo-3',
      title: 'Rolex Submariner',
      description: 'Authentic Rolex Submariner watch. Certificate included.',
      categoryId: fashion.id,
      organizerId: demoUser.id,
      marketPrice: 1500000,
      participationFee: 5000,
      startPrice: 1495000,
      currentPrice: 1495000,
      minPrice: 450000,
      priceDropInterval: 30,
      priceDropAmount: 5000,
      status: 'SCHEDULED',
      country: 'AM',
      scheduledStart: new Date(now.getTime() + 3600000),
      maxParticipants: 200,
      images: { create: [
        { url: 'https://picsum.photos/seed/rolex1/800/600', order: 0 },
      ]},
    },
  });

  console.log('Seed completed!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
