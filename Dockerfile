# Use Node.js 20 LTS Alpine (更小更快)
FROM node:20-alpine

# Install only necessary dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++ 

# Set working directory
WORKDIR /app

# Copy package files first (利用 Docker 缓存)
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

# Expose port for dashboard
EXPOSE 3000

# Initialize database and start
CMD npm run db:init && npm start
