# MapViewer3D live data for Dune Docker hosts.
#
#   target "agent": mvagent, built from the MapViewer3D sources at MV_REF,
#                   verified against MV_COMMIT
#   target "gate":  mvgate (securelink: TLS 1.3, pinned key, mutual token proof)
#
# Static Go binaries on distroless bases without a shell. Base images are
# pinned by digest.

ARG GO_IMAGE=golang:1.26-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c
ARG RUN_IMAGE=gcr.io/distroless/static-debian12@sha256:d75cdd72874d4790092fcb1b058493ecf6bb5bf2b2b897045b00ff01d91843f2
ARG RUN_IMAGE_NONROOT=gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

FROM ${GO_IMAGE} AS build-agent
RUN apk add --no-cache git
ARG MV_REPO=https://github.com/dev-prophet-code/MapViewer3D.git
# release tag of MapViewer3D and the commit it must point to (supply chain:
# a moved tag stops the build)
ARG MV_REF=beta.15
ARG MV_COMMIT=7e1a73044023da89d42c9ea3ab3dba133904e8c1
RUN git clone --depth 1 --branch "${MV_REF}" "${MV_REPO}" /src \
 && test "$(git -C /src rev-parse HEAD)" = "${MV_COMMIT}" \
 || { echo "MV_REF ${MV_REF} is not commit ${MV_COMMIT}" >&2; exit 1; }
WORKDIR /src/backend
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mvagent ./cmd/mvagent \
 && /out/mvagent -version

FROM ${GO_IMAGE} AS build-gate
WORKDIR /src
COPY gate/ ./
RUN CGO_ENABLED=0 go vet ./... && CGO_ENABLED=0 go test ./... \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mvgate ./cmd/mvgate \
 && mkdir -p /out/data

# mvagent must run as root: it reads /proc/<pid>/mem of the game servers.
FROM ${RUN_IMAGE} AS agent
COPY --from=build-agent /out/mvagent /usr/local/bin/mvagent
EXPOSE 8796
ENTRYPOINT ["/usr/local/bin/mvagent"]
CMD ["-addr", "0.0.0.0:8796", "-allow-open"]

FROM ${RUN_IMAGE_NONROOT} AS gate
COPY --from=build-gate /out/mvgate /usr/local/bin/mvgate
# key, certificate and token live here (named volume, owned by nonroot)
COPY --from=build-gate --chown=65532:65532 --chmod=700 /out/data /data
VOLUME /data
EXPOSE 8797
HEALTHCHECK --interval=30s --timeout=8s --start-period=10s CMD ["/usr/local/bin/mvgate", "-healthcheck"]
ENTRYPOINT ["/usr/local/bin/mvgate"]
