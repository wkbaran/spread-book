FROM node:24-alpine

RUN apk add --no-cache bash aws-cli supercronic tzdata

ENV TZ=America/Denver \
    NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY *.js *.css run.sh fetch.sh report.sh publish.sh ./
COPY docker/crontab ./
RUN chmod +x run.sh fetch.sh report.sh publish.sh

# data/ and reports/ persist between runs so daily-pnl.js has prior snapshots to compare
VOLUME ["/app/data", "/app/reports"]

CMD ["supercronic", "/app/crontab"]
