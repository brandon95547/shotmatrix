# Shot Matrix, the web service (server.mjs), as it runs on the prod box.
#
# Playwright's own image, at the SAME version package.json pins. The npm package and the
# browser builds have to agree — that disagreement is what broke WebKit on macOS 14 — and
# this image is the only way to have all three engines on that box at all: CentOS 8's
# glibc (2.28) is too old for Playwright's WebKit build.
FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY lib ./lib
COPY server.mjs shot.mjs ./

# Where runs are written, owned by the unprivileged user the service runs as. Created
# here so the named volume mounted on it inherits that ownership.
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
ENV HOST=0.0.0.0 PORT=4700 DATA_DIR=/data HOME=/tmp
EXPOSE 4700
CMD ["node", "server.mjs"]
