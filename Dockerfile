# syntax=docker/dockerfile:1

# Shared base
FROM node:24-alpine AS base

RUN apk add --no-cache openssl

WORKDIR /app


# Stage 1: Install all dependencies and build the application
FROM base AS build

COPY package.json package-lock.json ./

# Vite and other build tools are needed during compilation.
RUN npm ci --include=dev

COPY . .

# Generate Prisma Client without connecting to a real database.
RUN DATABASE_URL="mysql://build:build@127.0.0.1:3306/build" \
    npm exec -- prisma generate

RUN npm run build


# Stage 2: Install production dependencies only
FROM base AS production-deps

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm ci --omit=dev

# Generate a client matching the actual application schema.
RUN DATABASE_URL="mysql://build:build@127.0.0.1:3306/build" \
    npm exec -- prisma generate

RUN npm cache clean --force


# Stage 3: Production runtime
FROM base AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

COPY --chown=node:node package.json package-lock.json ./

COPY --from=production-deps --chown=node:node \
    /app/node_modules ./node_modules

COPY --from=build --chown=node:node \
    /app/build ./build

# The one-shot worker imports source modules at runtime.
COPY --from=build --chown=node:node \
    /app/app ./app

COPY --from=build --chown=node:node \
    /app/scripts ./scripts

COPY --from=build --chown=node:node \
    /app/prisma ./prisma

USER node

EXPOSE 3000

# The web container runs only the web server.
CMD ["npm", "run", "start"]