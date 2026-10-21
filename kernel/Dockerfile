# Cross-build environment for the Jet mainline kernel (runs natively on the arm64 Docker VM).
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    crossbuild-essential-armhf build-essential bc bison flex libssl-dev libelf-dev \
    kmod cpio xz-utils wget ca-certificates python3 git u-boot-tools file \
    && rm -rf /var/lib/apt/lists/*
ENV ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-
WORKDIR /src
