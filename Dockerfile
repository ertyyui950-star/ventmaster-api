FROM node:20-alpine AS builder
WORKDIR /app
COPY Desktop/auction-platform/backend/package*.json ./
COPY Desktop/auction-platform/backend/prisma ./prisma/
RUN npm ci
RUN npx prisma generate
COPY Desktop/auction-platform/backend/ .
RUN npm run build
RUN npm prune --production

FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache curl openssl
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
RUN mkdir -p /app/data
ENV DATABASE_URL="file:/app/data/prod.db"
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/src/main.js"]
