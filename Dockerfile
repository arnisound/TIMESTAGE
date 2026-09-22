FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY shared ./shared
COPY public ./public

ENV PORT=3000
EXPOSE 3000
# Les salles sont gardees en memoire ; monter un volume sur /app/data pour
# qu'elles survivent a un redemarrage.
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
