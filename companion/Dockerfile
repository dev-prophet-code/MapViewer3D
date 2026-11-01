# Build-Kontext ist das Repo-Root:  docker build -f companion/Dockerfile -t mapviewer3d-companion .
FROM node:22-alpine
WORKDIR /app
COPY VERSION ./VERSION
COPY companion/package.json companion/server.mjs ./companion/
COPY companion/lib ./companion/lib
COPY companion/public ./companion/public
USER node
WORKDIR /app/companion
ENV NODE_ENV=production PORT=8799 BIND=0.0.0.0
EXPOSE 8799
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
