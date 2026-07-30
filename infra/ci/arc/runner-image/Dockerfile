FROM ghcr.io/actions/actions-runner:2.335.1@sha256:08c30b0a7105f64bddfc485d2487a22aa03932a791402393352fdf674bda2c29

USER root

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    clang \
    cmake \
    curl \
    docker-compose-v2 \
    git \
    jq \
    libglu1-mesa \
    libgtk-3-0 \
    libgtk-3-dev \
    ninja-build \
    pkg-config \
    unzip \
    xz-utils \
    zip \
  && rm -rf /var/lib/apt/lists/*

USER runner
