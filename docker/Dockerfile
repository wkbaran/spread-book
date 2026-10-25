FROM node:26-alpine

RUN apk add --no-cache bash aws-cli supercronic tzdata

ENV TZ=America/Denver \
    NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY *.js *.css run.sh fetch.sh report.sh publish.sh publish-paper.sh ./
COPY docker/crontab ./
RUN chmod +x run.sh fetch.sh report.sh publish.sh publish-paper.sh

# Not root: node is uid 1000, which owns the bind-mounted directories on the host and the one shared with
# equity-watch. The app's own files stay root's, so the jobs can read them but not change them.
USER node

# data/ and reports/ persist between runs so daily-pnl.js has prior snapshots to compare
VOLUME ["/app/data", "/app/reports"]

CMD ["supercronic", "/app/crontab"]
