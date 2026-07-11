FROM node:20-alpine

WORKDIR /app

# Install git (needed by baileys npm package)
RUN apk add --no-cache git

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source
COPY . .

# Create sessions directory
RUN mkdir -p sessions

# Expose port
EXPOSE 3001

# Start
CMD ["node", "src/server.js"]
