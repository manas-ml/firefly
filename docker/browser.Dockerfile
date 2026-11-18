# syntax=docker/dockerfile:1
# Chromium + Playwright. Its version must match playwright-core below.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /opt/browser
RUN echo '{"type":"module","private":true}' > package.json \
  && npm install --omit=dev --no-audit --no-fund playwright-core@1.63.0 \
  && npm cache clean --force
COPY browser/server.ts ./server.ts
RUN mkdir -p /profile && chown pwuser:pwuser /profile
ENV NODE_NO_WARNINGS=1 PROFILE_DIR=/profile
USER pwuser
EXPOSE 7071
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7071/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.ts"]
