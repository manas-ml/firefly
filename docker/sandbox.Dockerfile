# syntax=docker/dockerfile:1
# Debian slim with Node (for the exec server and for the agent's own use) and common CLI tools.
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     bash coreutils findutils grep sed gawk diffutils procps tini \
     git curl ca-certificates jq ripgrep less file zip unzip tree \
     python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1001 --shell /bin/bash sandbox \
  && mkdir -p /workspace /opt/sandbox \
  && chown sandbox:sandbox /workspace
COPY sandbox/server.ts /opt/sandbox/server.ts
ENV NODE_NO_WARNINGS=1 HOME=/home/sandbox USER=sandbox
USER sandbox
WORKDIR /workspace
EXPOSE 7070
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7070/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/sandbox/server.ts"]
