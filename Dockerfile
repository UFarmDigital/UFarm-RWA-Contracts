FROM node:24.12-alpine AS build
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run compile -- --build-profile production

FROM node:24.12-alpine AS production
WORKDIR /usr/src/app

COPY --from=build --chown=node /usr/src/app .

CMD ["sleep", "infinity"]
