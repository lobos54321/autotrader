# Use Node.js 20 LTS with Debian for Playwright support
FROM node:20-slim

# Install dependencies for better-sqlite3 and Playwright
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    # Playwright dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (利用 Docker 缓存)
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Install Playwright browsers
RUN npx playwright install chromium --with-deps || true

# Copy application code
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

# Expose port for dashboard
EXPOSE 3000

# Initialize database and start
CMD npm run db:init && npm start
