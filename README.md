# teleport-nodejs-server-example

Example Node.js server for [TeleportXR](https://docs.teleportxr.io).

Host from anywhere that supports Node.js. Better connection if it allows UDP ports, but not required.

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

### Avatars

When avatars are enabled the server sends each connecting client an
`avatar-policy`, validates whatever avatar the client offers back
(downloading it under strict size, time and SSRF limits, then measuring the
glTF/VRM against the requirements below), and adds it as a node in the shared
scene so every other client sees it. A client that offers nothing acceptable
gets the server's default avatar instead.

Peers receive an accepted avatar as an ordinary scene node whose mesh is a
pointer to a URL they fetch themselves. They are never told the node is an
avatar, whose it is, or where it came from. Which URL that pointer carries
depends on the delivery mode:

* **Relay** (the default) — the client's own avatar URL. Peers fetch straight
  from the avatar host, and this server serves none of the bytes. **The URL is
  therefore visible to every other client in the session.** If your avatar
  URLs carry bearer tokens, set `TELEPORT_AVATARS_ALLOW_RELAY=0`.
* **Import** — the validated bytes re-hosted here under
  `/avatars/<sha256>.glb`, so the client's own URL is never forwarded. Used
  when relay is disabled, when the client sets `"allow_relay": false` on its
  offer, when the offered URL has no `.glb`/`.vrm`/`.gltf` extension (clients
  choose a decoder by extension), and for any single peer that reports it
  could not fetch the relayed URL — a CORS-less avatar host, for instance.
  That last fallback is per-peer and silent: the avatar's owner is not told,
  and other peers keep using the relayed URL.

The bundled default avatar (`http_resources/placeholder_avatar.glb`) is a
blocky humanoid authored from scratch by `tools/make-placeholder-avatar.js`
and covered by this project's MIT licence — regenerate it with
`node tools/make-placeholder-avatar.js`. It is deliberately not the bundled
`generic_avatar.vrm`, whose own embedded VRM metadata declares
`licenseName: "Redistribution_Prohibited"` and `allowedUserName: "OnlyAuthor"`.
Point `TELEPORT_AVATARS_DEFAULT_URL` at your own licensed asset for anything
better-looking.

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEPORT_AVATARS_ENABLED` | `1` (on) | Master switch for avatar negotiation. When off, the server falls back to the legacy static subscene avatar node. |
| `TELEPORT_AVATARS_VALIDATE` | `1` (on) | Fetch, hash and measure offered avatars. When off, every offer is answered with `using_default` without a download. |
| `TELEPORT_AVATARS_DEFAULT_URL` | `/placeholder_avatar.glb` | Server-relative URL of the default avatar used for `using_default` results. |
| `TELEPORT_AVATARS_REQUIREMENT` | `optional` | `optional`, `required` or `forbidden` — whether clients must supply an avatar. |
| `TELEPORT_AVATARS_DEFAULT_AVAILABLE` | `1` (on) | Whether the server will substitute its default. With this off and `REQUIREMENT=required`, unacceptable offers are rejected outright. |
| `TELEPORT_AVATARS_ALLOW_RELAY` | `1` (on) | Whether accepted avatar URLs may be handed to other clients to fetch. Off means every avatar is re-hosted here — slower and more bandwidth, but no client's URL ever reaches another client. |
| `TELEPORT_AVATARS_FORMATS` | `glb,vrm` | Comma-separated allow-list of asset formats. A VRM is detected by its glTF extensions, so `glb` alone does **not** admit VRM files. |
| `TELEPORT_AVATARS_MAX_FILE_BYTES` | `8000000` | Hard cap on the downloaded asset, enforced mid-stream. |
| `TELEPORT_AVATARS_MAX_TRIANGLES` | `80000` | Triangle budget, summed across all mesh primitives. |
| `TELEPORT_AVATARS_MAX_HEIGHT_M` | `2.5` | Bounding-box height limit in metres. |
| `TELEPORT_AVATARS_MAX_WIDTH_M` | `2.5` | Larger horizontal bounding-box extent, in metres. Do not set this below the height limit: a T-posed humanoid's arm span is roughly its height. |
| `TELEPORT_AVATARS_MAX_TEXTURES` | `8` | Maximum number of embedded images. |
| `TELEPORT_AVATARS_MAX_TEXTURE_PIXELS` | `1048576` | Per-image pixel budget (width × height), read from PNG/JPEG/KTX2 headers. |
| `TELEPORT_AVATARS_LICENCE_TAGS` | _unset_ (not enforced) | Comma-separated allow-list of licence tags, e.g. `cc0,cc-by`. Read from VRM metadata; assets with no declared licence are refused when this is set. |
| `TELEPORT_AVATARS_SKELETON` | _unset_ (not enforced) | Required skeleton, e.g. `humanoid-mixamo`. VRM assets must carry a humanoid bone map; plain glTF assets must be skinned. |
| `TELEPORT_AVATARS_FETCH_TIMEOUT_MS` | `15000` | Wall-clock budget for the whole fetch, hash and measure step. |

### Library variables

The server example also inherits any environment variables read by the
`teleportxr` library itself; see the
[teleport-nodejs README](https://github.com/teleportxr/teleport-nodejs#environment-variables)
for the current list (currently `WEBRTC_CONNECT_TIMEOUT_MS`).


## Microphone forwarding (SFU)

The server forwards each connected client's microphone audio to every other
client, demonstrating the SFU topology in `docs/protocol/audio.rst`. This is
handled by a small [`MicRouter`](src/mic-router.js) wired up in `src/server.js`:
it subscribes to the `micFrame` event of every live `WebRtcConnection` and pushes
each frame to the other connections' outbound audio sources, with loopback
suppression so a client never hears itself. The default policy forwards to all
peers; replace `MicRouter` (or its `_forward` method) to implement a custom
selection policy. Run `npm test` to exercise the router against stub connections.

### Dependencies

ktx
