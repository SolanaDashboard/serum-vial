from node:16-slim

ENV PORT 8000

WORKDIR /usr/src/app

ADD . /usr/src/app/
#RUN npm install -g npm@8.1.4
RUN npm ci

ENV NODE_ENV production

RUN npm run build

EXPOSE $PORT

# run it
CMD ["node", "./bin/serum-vial.js", "--log-level=info", "--endpoint=http://solana-api-gamma.tt-prod.net"]
