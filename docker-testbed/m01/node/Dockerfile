FROM node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/noderag/m01
COPY m01/node/package.json m01/node/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY m01/node/src ./src
COPY m01/contracts ./contracts
COPY m01/model-manifest.json ./model-manifest.json

# An empty named volume inherits this directory's ownership on first mount.
RUN install -d -o node -g node -m 0700 /probe-volume

USER node
ENTRYPOINT ["node"]
