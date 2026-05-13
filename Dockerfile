FROM node:22-slim

# Bootstrap ca-certificates (required for HTTPS mirrors) using default sources
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Replace apt source with Tsinghua mirror
# RUN sed -i 's|URIs: http://deb.debian.org|URIs: https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources

# Install system dependencies
RUN apt-get update && apt-get install -y \
    jq \
    git \
    curl \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Set npm registry to domestic mirror
# RUN npm config set registry https://registry.npmmirror.com

# Install pi-coding-agent globally
RUN npm install -g @mariozechner/pi-coding-agent

# Create executor user
RUN useradd -m -s /bin/bash executor

# Copy project configurations
COPY pi/ /home/executor/.pi/
RUN mkdir -p /home/executor/.pi/agent/sessions && chown -R executor:executor /home/executor/.pi
COPY master.md /opt/master.md
COPY run.sh /opt/run.sh
RUN chmod +x /opt/run.sh
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

# Set user and workdir
USER executor
WORKDIR /workspace

ENTRYPOINT ["/opt/entrypoint.sh"]
