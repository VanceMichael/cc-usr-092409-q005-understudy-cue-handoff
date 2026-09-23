FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
RUN npm test
EXPOSE 8082
CMD ["npm", "start"]
