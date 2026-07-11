FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies (no package-lock.json yet → use npm install)
RUN npm install --omit=dev

# Copy source
COPY . .

# Create sessions directory
RUN mkdir -p sessions

# Expose port
EXPOSE 3001

# Start
CMD ["node", "src/server.js"]
