# SQLite va integrado en Node, así que no hay módulos nativos que compilar:
# basta la imagen "slim" y la build es cuestión de segundos.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Las dependencias en su propia capa: mientras no cambie package.json,
# Docker reutiliza la caché y no vuelve a descargarlas.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# La base de datos vive en un volumen, nunca dentro de la imagen: si estuviera
# en la imagen, se perdería en cada actualización del contenedor.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

# Sin esto el proceso correría como root dentro del contenedor.
USER node

ENV PORT=8080 \
    HOST=0.0.0.0 \
    DATABASE_FILE=/data/booktrack.db

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
