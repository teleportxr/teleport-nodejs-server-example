// SPDX-FileCopyrightText: 2025 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

// ============================================================================
// Resource URL Configuration
// ============================================================================
// The server automatically configures resource URLs for clients based on:
//
// 1. TELEPORT_RESOURCE_URL environment variable (if set to a URL)
//    Used for explicit configuration or CDN URLs
//    Example: TELEPORT_RESOURCE_URL=https://cdn.example.com
//    Special value: TELEPORT_RESOURCE_URL=auto (enables auto-detection)
//
// 2. Auto-detection from client's Host header (default or when set to "auto")
//    When a client connects, its Host header is captured and used
//    This works correctly with:
//    - Direct connections: Uses client's address
//    - Reverse proxies: Uses X-Forwarded-Host if available, or Host header
//    - Custom domains: Uses whatever domain the client used to connect
//    Protocol is chosen automatically: http for loopback/LAN, https for public hosts.
//
// 3. TELEPORT_RESOURCE_PROTOCOL environment variable (optional override)
//    Forces the protocol used for the resource URL, regardless of the host.
//    Accepted values: "http" or "https"
//    Useful when the auto-detection heuristic is wrong for your network setup.
//    Example: TELEPORT_RESOURCE_PROTOCOL=https  (force https even on a LAN)
//             TELEPORT_RESOURCE_PROTOCOL=http   (force http even on a public host)
//
// 4. Fallback to localhost (used during startup before client connects)
//    Used when auto-detection is enabled but no client has connected yet
//
// The resource URL is sent to clients so they know where to download
// resources (meshes, textures, etc.) from the Express HTTP server.
// ============================================================================

const teleport_server = require('teleportxr')
const client_manager  = require('teleportxr/client/client_manager');
const client          = require('teleportxr/client/client');
const scene           = require("teleportxr/scene/scene");
const resources       = require("teleportxr/scene/resources");
const signaling       = require("teleportxr/signaling");
const avatars_proto   = require("teleportxr/protocol/avatars");
const express         = require('express');
const http            = require('http');
const socketIo        = require('socket.io');
const custom_player   = require('./custom-player.js');
const config          = require('./config.js');

const WebSocketServer = require("ws");

// Log the version of teleportxr being used
const fs              = require('fs');
const path_module     = require('path');
try
{
    // Read package.json from node_modules directly to get the teleportxr version
    const teleportPkgPath = path_module.join(__dirname, '../node_modules/teleportxr/package.json');
    const teleportPkgJson = JSON.parse(fs.readFileSync(teleportPkgPath, 'utf8'));
    console.log(`[Startup] TeleportXR version: ${teleportPkgJson.version}`);
}
catch (e)
{
    console.warn(`[Startup] Could not read TeleportXR version: ${e.message}`);
}

// Create a scene, so we can fill it with stuff.
var sc           = new scene.Scene();

// Load our scene.json into the scene.
const path       = require('path');
const assetsPath = path.join(__dirname, '../assets');
sc.SetAssetsPath(assetsPath);
const publicPath = path.join(__dirname, '../http_resources');
sc.SetPublicPath(publicPath);
sc.Load('scene.json');

// The client manager allows us to set callbacks for when client events happen:
var cm = client_manager.getInstance();

// This is our app's callback for when a new client is to be created.
function createNewClient(clientID, sigSend)
{
    var c = new custom_player.CustomClient(clientID, sigSend);
    return c;
}
cm.SetCreateClientCallback(createNewClient);

// It must return the origin uid for the client.
function createNewClientNode(clientID)
{
    var player     = new custom_player.CustomPlayerNode();
    var origin_uid = sc.CreateNode("Player");
    return origin_uid;
}
cm.SetNewClientNodeCallback(createNewClientNode);

// Monotonic per-process policy id used to tag every avatar-policy issued.
// BigInt because the wire field is uint64; starts at 1 so 0 always means
// "no policy in flight" on both ends.
var nextAvatarPolicyId = 1n;

// Build an AvatarPolicy from the static example-server config block.
// Pulled out of onClientPostCreate so it's trivial to unit-test in
// isolation if/when we add tests for the example server.
function buildAvatarPolicyForClient(clientID)
{
    const a = config.avatars;
    return new avatars_proto.AvatarPolicy({
        policy_id : nextAvatarPolicyId++,
        requirement : a.requirement,
        default_available : a.default_available,
        requirements : a.requirements,
        proof : a.proof,
    });
}

// This will be called AFTER a client has been created, so we can access it from the clientManager.
function onClientPostCreate(clientID)
{
    // The WebSocket upgrade captured the Host header before this callback fires,
    // so auto-detection has the data it needs. Update the resource URL now,
    // before the client builds its SetupCommand and starts streaming resources.
    updateResourceUrlIfNeeded();
    var client = cm.GetClient(clientID);
    client.SetScene(sc);
    client.PostSceneInit();
    // Issue an avatar policy if the operator has opted in via config /
    // TELEPORT_AVATARS_ENABLED. Phase 2 of the avatar rollout: the
    // AvatarService rounds the offer back as `using_default` regardless
    // of what the client supplies (see plans/avatars_implementation.md §3).
    if (config.avatars.enabled && client.avatarService)
    {
        const policy = buildAvatarPolicyForClient(clientID);
        console.log("Issuing avatar policy " + policy.policy_id + " to client " + clientID +
                    " (requirement=" + policy.requirement +
                    ", default_available=" + policy.default_available + ")");
        client.avatarService.sendPolicy(policy);
    }
}
cm.SetClientPostCreationCallback(onClientPostCreate);

// Having set up the callbacks, we start the server running.

const signaling_port    = process.env.PORT || 8081;

// Resource URL configuration:
// 1. TELEPORT_RESOURCE_URL environment variable (highest priority) - for CDN or explicit
// configuration
//    Set to "auto" to use auto-detection, or provide an explicit URL like "https://cdn.example.com"
// 2. Auto-detected from client's Host header (after first client connects)
// 3. Fallback to localhost (for local testing only)
const resourceUrlConfig = process.env.TELEPORT_RESOURCE_URL;
const useAutoDetection  = !resourceUrlConfig || resourceUrlConfig.toLowerCase() === 'auto';
const explicitResourceUrl =
    (resourceUrlConfig && resourceUrlConfig.toLowerCase() !== 'auto') ? resourceUrlConfig : null;

// TELEPORT_RESOURCE_PROTOCOL overrides automatic http/https selection.
// Accepted values: "http" or "https". Unset means use the auto-detection heuristic.
const resourceProtocolOverride = (() => {
    const v = (process.env.TELEPORT_RESOURCE_PROTOCOL || '').toLowerCase();
    if (v === 'http' || v === 'https')
        return v;
    if (v)
        console.error(
            `TELEPORT_RESOURCE_PROTOCOL must be "http" or "https"; ignoring value "${v}".`);
    return null;
})();

// TELEPORT_REQUIRE_TLS=1 makes the server reject any WebSocket upgrade whose
// X-Forwarded-Proto is not "https". Use this on Heroku (or behind any reverse
// proxy) to refuse plain ws:// connections that arrived on port 80.
const requireTls               = (() => {
    const v = (process.env.TELEPORT_REQUIRE_TLS || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
})();

// Strip common default ports (80 and 443) from the host string.
// This ensures we don't produce non-standard URLs like https://hostname:80
// when a reverse proxy passes through the original Host header incorrectly.
function stripDefaultPort(host)
{
    return host.replace(/:(80|443)$/, '');
}

// Function to get the appropriate resource URL
function getResourceUrl()
{
    // If explicitly configured (and not "auto"), use that
    if (explicitResourceUrl)
    {
        return explicitResourceUrl;
    }
    // If auto-detection is enabled (either no config or "auto" was set)
    if (useAutoDetection)
    {
        const autoDetectedHost = signaling.getClientHostHeader();
        if (autoDetectedHost)
        {
            // Protocol priority:
            //   1. TELEPORT_RESOURCE_PROTOCOL env-var override
            //   2. X-Forwarded-Proto header (set by reverse proxies)
            //   3. 'http' — the server itself never terminates TLS
            const forwardedProto =
                signaling.getClientProtoHeader ? signaling.getClientProtoHeader() : '';
            const protocol = resourceProtocolOverride || forwardedProto || 'http';
            const host     = stripDefaultPort(autoDetectedHost);
            return `${protocol}://${host}`;
        }
    }
    // Fallback to localhost (always http for local, unless overridden)
    const protocol = resourceProtocolOverride || 'http';
    return `${protocol}://localhost:${signaling_port}`;
}

// Default ICE configuration: STUN only. We deliberately do NOT ship shared TURN
// credentials as a default any more — relying on a free-tier shared TURN means
// every production deployment that forgets to configure ICE ends up routing all
// media through the same relay (with the latency, quota and reliability that
// implies; sessions tend to drop after ~50 s when the allocation is reclaimed).
//
// Operators that need TURN must set TELEPORT_ICE_SERVERS to a JSON array, e.g.
//   TELEPORT_ICE_SERVERS='[
//     {"urls":"stun:stun.l.google.com:19302"},
//     {"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}
//   ]'
// Strip whitespace (spaces, tabs, CR, LF) that sits OUTSIDE of JSON string
// literals, so a value pasted into a config UI with pretty-printed indentation
// and line breaks still parses. Whitespace inside "..." is preserved verbatim,
// so URLs / usernames / credentials containing spaces are not corrupted.
function stripJsonWhitespaceOutsideStrings(s)
{
    let out    = '';
    let inStr  = false;
    let escape = false;
    for (let i = 0; i < s.length; i++)
    {
        const c = s[i];
        if (inStr)
        {
            out += c;
            if (escape)
                escape = false;
            else if (c === '\\')
                escape = true;
            else if (c === '"')
                inStr = false;
            continue;
        }
        if (c === '"')
        {
            inStr = true;
            out += c;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r')
            continue;
        out += c;
    }
    return out;
}

let iceServers           = [ {urls : "stun:stun.l.google.com:19302"} ];
let iceServersConfigured = false;
if (process.env.TELEPORT_ICE_SERVERS)
{
    // Strip a leading UTF-8 BOM if present, then collapse external whitespace.
    let raw = process.env.TELEPORT_ICE_SERVERS;
    if (raw.charCodeAt(0) === 0xFEFF)
        raw = raw.slice(1);
    const normalised = stripJsonWhitespaceOutsideStrings(raw);
    try
    {
        const parsed = JSON.parse(normalised);
        if (Array.isArray(parsed))
        {
            iceServers           = parsed;
            iceServersConfigured = true;
        }
        else
        {
            console.error("TELEPORT_ICE_SERVERS must be a JSON array; ignoring.");
        }
    }
    catch (e)
    {
        console.error("Failed to parse TELEPORT_ICE_SERVERS: " + e.toString() + "; ignoring.");
    }
}
const hasTurn = iceServers.some(s => {
    const urls = Array.isArray(s.urls) ? s.urls : [ s.urls ];
    return urls.some(u => u && (u.startsWith('turn:') || u.startsWith('turns:')));
});
if (!hasTurn)
{
    console.warn(
        "ICE: no TURN server configured" +
        (iceServersConfigured ? " in TELEPORT_ICE_SERVERS" : " (STUN-only default)") +
        " — clients behind symmetric NAT or with UDP blocked will fail to connect. " +
        "Set TELEPORT_ICE_SERVERS to a JSON array including a turn:/turns: entry to enable TURN.");
}

let iceTransportPolicy;
if (process.env.TELEPORT_ICE_TRANSPORT_POLICY)
{
    const v = process.env.TELEPORT_ICE_TRANSPORT_POLICY;
    if (v === 'all' || v === 'relay')
        iceTransportPolicy = v;
    else
        console.error("TELEPORT_ICE_TRANSPORT_POLICY must be 'all' or 'relay'; ignoring.");
}

const wss         = teleport_server.initServer(undefined, {iceServers, iceTransportPolicy});

// Create a simple http server for scene management and display.
// This will be accessible at localhost:9000 via a browser.
// The dashboard uses the writeState functions of the teleport server classes
// to send html summaries of their state to the dashboard.
const express_app = express();
// Log every incoming HTTP request so we can confirm whether resource fetches
// (e.g. textures referenced by TexturePointer payloads) actually reach Express.
express_app.use(function(req, res, next) {
    const start = Date.now();
    res.on('finish', function() {
        const elapsed         = Date.now() - start;
        const ifNoneMatch     = req.headers['if-none-match'];
        const ifModifiedSince = req.headers['if-modified-since'];
        const logMsg = `HTTP ${req.method} ${req.originalUrl} -> ${res.statusCode} (${elapsed}ms)`;
        if (ifNoneMatch)
        {
            console.log(`  [IF-NONE-MATCH] ${ifNoneMatch}`);
        }
        if (ifModifiedSince)
        {
            console.log(`  [IF-MODIFIED-SINCE] ${ifModifiedSince}`);
        }
        console.log(logMsg);
    });
    next();
});
// CORS: every static asset is referenced by uid from a TexturePointer /
// MeshPointer chunk and fetched by the browser-based client from a different
// origin (the page is hosted on the consumer's site, not on this server).
// Without an explicit Access-Control-Allow-Origin the browser blocks the
// response. The protocol's HTTP service is intended to be cross-origin
// readable; allow it from anywhere. No credentials are involved so the
// wildcard is safe.
express_app.use(function(req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, If-None-Match, If-Modified-Since');
    res.setHeader('Access-Control-Expose-Headers', 'ETag, Last-Modified, Content-Length');
    if (req.method === 'OPTIONS')
    {
        res.status(204).end();
        return;
    }
    next();
});
express_app.use(express.static('dashboard_public'));
// Also serve any static 3D resources when requested. Use absolute path so it works
// regardless of the directory node was started from.

// Conditional-request validator for the public resources directory.
// TELEPORT_HTTP_CACHE_VALIDATOR selects the strategy:
//   "etag"  (default) — strong ETag from SHA-256 of file content. Survives
//                       Heroku redeploys (which rewrite file mtimes) so the
//                       client's cached copies stay valid when content is
//                       unchanged. Costs one hash per file (cached in memory).
//   "mtime"            — Last-Modified / If-Modified-Since based on file mtime.
//                       Cheaper but invalidates on every redeploy.
const cacheValidator = (process.env.TELEPORT_HTTP_CACHE_VALIDATOR || 'etag').toLowerCase();
if (cacheValidator !== 'etag' && cacheValidator !== 'mtime')
{
    console.error(`TELEPORT_HTTP_CACHE_VALIDATOR must be 'etag' or 'mtime'; got '${
        cacheValidator}', defaulting to 'etag'.`);
}
const useEtag = cacheValidator !== 'mtime';
console.log(`HTTP cache validator: ${useEtag ? 'etag (content hash)' : 'mtime (Last-Modified)'}`);

if (useEtag)
{
    const    crypto    = require('crypto');
    const    etagCache = new Map(); // absolute path -> { mtimeMs, size, etag }

    function computeETag(filePath, stats)
    {
        const cached = etagCache.get(filePath);
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size)
        {
            return cached.etag;
        }
        const hash = crypto.createHash('sha256');
        hash.update(fs.readFileSync(filePath));
        const etag = '"' + hash.digest('hex') + '"';
        etagCache.set(filePath, {mtimeMs : stats.mtimeMs, size : stats.size, etag});
        return etag;
    }

    express_app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD')
        {
            return next();
        }
        const filePath = path_module.join(publicPath, req.path);
        let   stats;
        try
        {
            stats = fs.statSync(filePath);
            if (!stats.isFile())
                return next();
        }
        catch (err)
        {
            return next();
        }
        const etag = computeETag(filePath, stats);
        res.setHeader('ETag', etag);
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === etag)
        {
            return res.status(304).end();
        }
        next();
    });

    // Disable express.static's default (mtime-based) ETag and Last-Modified so
    // only the content-hash ETag set above is used for conditional requests.
    express_app.use(express.static(publicPath, {etag : false, lastModified : false}));
}
else
{
    // express.static handles If-Modified-Since natively when lastModified is on.
    // Disable its weak ETag so only Last-Modified drives conditional responses.
    express_app.use(express.static(publicPath, {etag : false, lastModified : true}));
}
// Don't pass express_app to createServer - that would cause it to initalize before websockets is
// connected
const http_server = express_app.listen(signaling_port);
// Only forward genuine WebSocket upgrades to the signaling server. Other Upgrade
// requests (e.g. h2c from curl/HTTP-2 capable clients) must be rejected so the
// underlying TCP connection can fall back to a normal HTTP/1.1 request that
// Express can then serve via express.static.
http_server.on('upgrade', function upgrade(request, socket, head) {
    const upgradeHeader  = (request.headers.upgrade || '').toLowerCase();
    const forwardedProto = (request.headers['x-forwarded-proto'] || '').toLowerCase();
    console.log("HTTP upgrade request received: " + upgradeHeader + " " + request.url);
    console.log("  Host header: " + request.headers.host);
    console.log("  X-Forwarded-Host header: " + request.headers['x-forwarded-host']);
    console.log("  X-Forwarded-Proto header: " + forwardedProto);
    if (upgradeHeader !== 'websocket')
    {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
    }
    // When TELEPORT_REQUIRE_TLS is set, refuse plain ws:// upgrades. Only requests
    // forwarded by the proxy as https are accepted; clients hitting port 80 will
    // see a 403 and must reconnect via wss:// on port 443.
    if (requireTls && forwardedProto !== 'https')
    {
        console.warn("Rejecting non-TLS WebSocket upgrade (X-Forwarded-Proto=\"" + forwardedProto +
                     "\")");
        socket.write(
            'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nTLS required (use wss://)');
        socket.destroy();
        return;
    }
    const {pathname} = new URL(request.url, 'wss://base.url');
    wss.handleUpgrade(request, socket, head, function done(ws) {
        wss.emit('connection', ws, request);
    });
});

// Set initial resource URL
let currentResourceUrl = getResourceUrl();
resources.Resource.SetDefaultPathRoot(currentResourceUrl);
if (explicitResourceUrl)
{
    console.log(`Resource URL: ${currentResourceUrl} (explicitly configured)`);
}
else
{
    console.log(`Resource URL: ${
        currentResourceUrl} (using auto-detection, will update when first client connects)`);
}

// Recompute the resource URL using the current auto-detected host header.
// Called from onClientPostCreate so the update is event-driven rather than polled.
function updateResourceUrlIfNeeded()
{
    if (!useAutoDetection || explicitResourceUrl)
        return;
    const newResourceUrl = getResourceUrl();
    if (newResourceUrl !== currentResourceUrl)
    {
        currentResourceUrl = newResourceUrl;
        resources.Resource.SetDefaultPathRoot(currentResourceUrl);
        console.log(`Updated resource URL to: ${currentResourceUrl}`);
    }
}

function logErrors(err, req, res, next)
{
    console.error(err.stack)
    next(err)
}

express_app.use(logErrors)
/*
express_io.on('connection', (socket) => {
    console.log('A dashboard client connected');
    setInterval(() => {
      socket.emit('scene', sc.writeState());
      socket.emit('client_manager', cm.writeState());
    }, 1000);
});*/

if (config.avatars.enabled)
{
    console.log("Avatars: enabled (requirement=" + config.avatars.requirement +
                ", default_available=" + config.avatars.default_available +
                ", formats=" + JSON.stringify(config.avatars.requirements.formats) + ")");
}
else
{
    console.log("Avatars: disabled (set TELEPORT_AVATARS_ENABLED=1 to opt in)");
}

console.log(`Dashboard: http://localhost:${signaling_port}`);
