FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install dependencies using npm ci for clean and fast install
RUN npm ci

# Bundle app source
COPY . .

# Set environment variables
ENV HOST=0.0.0.0
ENV PORT=7890

# Expose port
EXPOSE 7890

# Start the application
CMD [ "npm", "start" ]
