# Simplified Dockerfile for Conway
FROM node:20-alpine

# Install Python and build tools
RUN apk add --no-cache python3 py3-pip build-base python3-dev

# Set working directory
WORKDIR /app

# Copy package files and install frontend deps
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copy all source files
COPY . .

# Build frontend
RUN npm run build

# Install backend deps
WORKDIR /app/backend
RUN npm install --legacy-peer-deps

# Install Python ML service deps
WORKDIR /app/backend/ml-service
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Back to app root
WORKDIR /app

# Environment
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Create data directory for SQLite
RUN mkdir -p /app/data

# Copy startup script
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Start all services via startup script
WORKDIR /app/backend
CMD ["/app/start.sh"]
