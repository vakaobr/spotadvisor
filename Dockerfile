FROM node:20-slim

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the application source code
COPY . .

RUN chown -R node:node /app
USER node

# Expose the port
EXPOSE 3000

# Start the application
CMD [ "node", "server.js" ]
