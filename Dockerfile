ARG RUST_VERSION=1.97
ARG NODE_VERSION=24
ARG PNPM_VERSION=10.33.0

FROM --platform=${BUILDPLATFORM} node:${NODE_VERSION}-bookworm-slim AS frontend-build

ARG PNPM_VERSION

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /workspace
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/
RUN pnpm --dir frontend install --frozen-lockfile
COPY frontend frontend
COPY scripts scripts
RUN pnpm --dir frontend build

FROM rust:${RUST_VERSION}-bookworm AS rust-build

WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY migration migration
COPY src src
COPY templates templates
RUN cargo build --locked --release

FROM gcr.io/distroless/cc-debian12:nonroot AS runtime

WORKDIR /app
COPY --from=rust-build --chown=nonroot:nonroot /workspace/target/release/map-travel /usr/local/bin/map-travel
COPY --from=frontend-build --chown=nonroot:nonroot /workspace/frontend/dist frontend/dist
COPY --from=frontend-build --chown=nonroot:nonroot /workspace/vendor/protomaps vendor/protomaps

USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/map-travel"]
