# teleport-nodejs-server-example

Example Node.js server for [TeleportXR](https://github.com/teleportxr/teleport-nodejs).

## Running

```
npm install
node src/server.js
```

## Environment variables

All variables are optional. Boolean-like values accept `1`, `true`, or `yes`
(case-insensitive) for "on"; anything else is treated as "off".

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8081` | TCP port the signaling/Express HTTP server listens on. Heroku and similar platforms set this automatically. |
| `TELEPORT_REQUIRE_TLS` | _unset_ (off) | When on, the server rejects any WebSocket upgrade whose `X-Forwarded-Proto` is not `https`. Use behind a reverse proxy (e.g. Heroku) to refuse plain `ws://` connections that arrived on port 80. |

### Resource URL advertised to clients

The server tells each client where to fetch resources (meshes, textures, etc.)
from. The URL is resolved in this order:

1. `TELEPORT_RESOURCE_URL` if set to an explicit URL.
2. Auto-detection from the client's `Host` / `X-Forwarded-Host` header
   (also used when `TELEPORT_RESOURCE_URL=auto`).
3. Fallback to `http://localhost:$PORT` before any client has connected.

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEPORT_RESOURCE_URL` | _unset_ (auto-detect) | Explicit base URL clients should use to download resources, e.g. `https://cdn.example.com`. Set to `auto` to force auto-detection from the client's `Host` header. |
| `TELEPORT_RESOURCE_PROTOCOL` | _unset_ (auto) | Forces the protocol of the auto-detected resource URL. Must be `http` or `https`. Useful when the auto-detection heuristic picks the wrong scheme for your network setup. |

### HTTP cache validator

Controls how the static-resource HTTP server answers conditional requests
(`If-Modified-Since` / `If-None-Match`) for files under the public resources
directory.

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEPORT_HTTP_CACHE_VALIDATOR` | `etag` | `etag` — strong ETag from the SHA-256 of file content. Survives redeploys (e.g. Heroku rewriting file mtimes), so client-side caches stay valid when the bytes are unchanged. Costs one hash per file (cached in memory, recomputed only when `mtime`/`size` changes). `mtime` — `Last-Modified` / `If-Modified-Since` only. Cheaper, but invalidates on every redeploy. |

### ICE / WebRTC

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEPORT_ICE_SERVERS` | `[{"urls":"stun:stun.l.google.com:19302"}]` | JSON array of ICE server entries passed to the WebRTC peer connection. Operators that need TURN must set this to a JSON array including a `turn:`/`turns:` entry, e.g. `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`. Whitespace outside JSON string literals is stripped, so pretty-printed values pasted into a config UI parse correctly. A leading UTF-8 BOM is also tolerated. |
| `TELEPORT_ICE_TRANSPORT_POLICY` | _unset_ (`all`) | Forces the `iceTransportPolicy` of the peer connection. Must be `all` or `relay`. Set to `relay` to force all media through TURN (useful for testing TURN configuration). |

### Library variables

The server example also inherits any environment variables read by the
`teleportxr` library itself; see the
[teleport-nodejs README](https://github.com/teleportxr/teleport-nodejs#environment-variables)
for the current list (currently `WEBRTC_CONNECT_TIMEOUT_MS`).


### Dependencies

ktx
