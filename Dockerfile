# Dockerfile for InstaBox Bridge development
# Build: docker build -t instabox-bridge .
# Run: docker run -it --rm instabox-bridge

FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm ci --only=production

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy source
COPY plugin/ ./plugin/
COPY package.json ./
COPY README.md ./

# Create state directory
RUN mkdir -p /data/instabox-bridge

ENV NODE_ENV=production

CMD ["node", "--test", "tests/integration/*.test.js"]