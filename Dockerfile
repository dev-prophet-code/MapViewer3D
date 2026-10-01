# MapViewer3D live data for Dune Docker hosts.
#
#   target "agent": mvagent, built from the MapViewer3D sources at MV_REF
#   target "gate":  mvgate, the authenticated front door (this repository)
#
# Both are static Go binaries on a distroless base without a shell.

ARG GO_VERSION=1.26

FROM golang:${GO_VERSION}-alpine AS build-agent
RUN apk add --no-cache git
ARG MV_REPO=https://github.com/dev-prophet-code/MapViewer3D.git
# a release tag of MapViewer3D (main branch); pin it, do not use a branch
ARG MV_REF=beta.15
RUN git clone --depth 1 --branch "${MV_REF}" "${MV_REPO}" /src
WORKDIR /src/backend
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mvagent ./cmd/mvagent \
 && /out/mvagent -version

FROM golang:${GO_VERSION}-alpine AS build-gate
WORKDIR /src
COPY gate/ ./
RUN CGO_ENABLED=0 go test ./... \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mvgate .

# mvagent must run as root: it reads /proc/<pid>/mem of the game servers.
FROM gcr.io/distroless/static-debian12 AS agent
COPY --from=build-agent /out/mvagent /usr/local/bin/mvagent
EXPOSE 8796
ENTRYPOINT ["/usr/local/bin/mvagent"]
CMD ["-addr", "0.0.0.0:8796", "-allow-open"]

FROM gcr.io/distroless/static-debian12:nonroot AS gate
COPY --from=build-gate /out/mvgate /usr/local/bin/mvgate
EXPOSE 8797
HEALTHCHECK --interval=30s --timeout=6s --start-period=10s CMD ["/usr/local/bin/mvgate", "-healthcheck"]
ENTRYPOINT ["/usr/local/bin/mvgate"]
