# Two stages: build the client bundle and the Go binary, then ship neither
# toolchain. The result is a static binary plus the static files it serves.

FROM node:22-alpine AS assets
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY public ./public
RUN npm run build

FROM golang:1.26-alpine AS build
WORKDIR /src
# Dependencies first, so a source-only change reuses the module cache.
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
# CGO off keeps the binary static, which is what lets the final stage be
# distroless rather than a distribution with a libc.
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /server /app/server
COPY --from=assets /src/public /app/public
# Cloud Run injects PORT; the server honours it and falls back to 8080.
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/app/server"]
