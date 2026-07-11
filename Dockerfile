FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --production

# Copy source
COPY . .

# Create sessions directory
RUN mkdir -p sessions

# Expose port
EXPOSE 3001

# Start
CMD ["node", "src/server.js"]
