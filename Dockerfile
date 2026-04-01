# Use Node 20 as the base for building
FROM node:20 as builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Build the React frontend and the Express backend
RUN npm run build

# Use a lighter Node image for production
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/package*.json ./
RUN npm install --production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/data ./data
# Ensure the data directory exists
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "dist/server.cjs"]
