FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci
RUN npx prisma generate
COPY . .
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
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy || npx prisma db push && node dist/src/main.js"]
