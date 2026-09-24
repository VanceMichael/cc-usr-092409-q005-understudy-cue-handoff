FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY contracts ./contracts
COPY src ./src
COPY test ./test
RUN npm test
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8082
CMD ["npm", "start"]
