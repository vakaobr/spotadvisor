FROM node:20-slim  

WORKDIR /app

# No need to install build dependencies here, Debian images have most of them already

# Copy package files
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Create data directory
RUN mkdir -p data

# Expose port
EXPOSE 3000

# Run the application
CMD ["node", "server.js"]
