# Use Node 20 as the base for building
FROM node:20 AS builder

WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm install
RUN npx prisma generate
COPY . .
# Build the React frontend and the Express backend
RUN npm run build

# Use a lighter Node image for production
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma/
RUN npm install --production
RUN npx prisma generate
COPY --from=builder /app/dist ./dist

EXPOSE 3000
# Push schema to DB then start server
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/server.cjs"]
