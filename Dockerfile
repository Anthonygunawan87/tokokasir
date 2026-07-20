# TokoKasir — zero-dependency Node app (butuh node:sqlite → Node 24)
FROM node:24-alpine
WORKDIR /app
COPY . .
RUN mkdir -p data
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
