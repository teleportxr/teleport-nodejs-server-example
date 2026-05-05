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
const express         = require('express');
const http            = require('http');
const socketIo        = require('socket.io');
const custom_player   = require('./custom-player.js');

const WebSocketServer = require("ws");

// Create a scene, so we can fill it with stuff.
var sc                = new scene.Scene();

// Load our scene.json into the scene.
const path            = require('path');
const assetsPath      = path.join(__dirname, '../assets');
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

// Returns true if the given host string refers to a loopback or LAN address.
// LAN ranges (RFC 1918 + link-local + loopback) are treated as local so the
// example server uses plain http, while public addresses use https.
function isLocalOrLanHost(host)
{
    const h = host.split(':')[0]; // strip any port
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1')
        return true;
    // IPv4 private/link-local ranges
    const m = h.match(/^([0-9]+)\.([0-9]+)\.[0-9]+\.[0-9]+$/);
    if (m)
    {
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        if (a === 10)
            return true; // 10.0.0.0/8
        if (a === 172 && b >= 16 && b <= 31)
            return true; // 172.16.0.0/12
        if (a === 192 && b === 168)
            return true; // 192.168.0.0/16
        if (a === 169 && b === 254)
            return true; // 169.254.0.0/16
        if (a === 127)
            return true; // 127.0.0.0/8
    }
    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
    const lower = h.toLowerCase();
    if (lower.startsWith('fc') || lower.startsWith('fd'))
        return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') ||
        lower.startsWith('feb'))
        return true;
    // Hostnames without a dot are typically LAN names (e.g. "myhost", "myhost.local")
    if (!h.includes('.'))
        return true;
    if (lower.endsWith('.local'))
        return true;
    return false;
}

// Selects the protocol for a given host, respecting any TELEPORT_RESOURCE_PROTOCOL override.
function protocolForHost(host)
{
    if (resourceProtocolOverride)
        return resourceProtocolOverride;
    return isLocalOrLanHost(host) ? 'http' : 'https';
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
            return `${protocolForHost(autoDetectedHost)}://${autoDetectedHost}`;
        }
    }
    // Fallback to localhost (always http for local, unless overridden)
    const protocol = resourceProtocolOverride || 'http';
    return `${protocol}://localhost:${signaling_port}`;
}

// Default STUN/TURN servers for the example. Mixes UDP, TCP and TLS transports
// so ICE has multiple paths to try when UDP egress is blocked (e.g. Heroku).
// Override at runtime by setting TELEPORT_ICE_SERVERS to a JSON array. The
// metered.ca TURN credentials below are placeholders; replace them with your
// own (or set TELEPORT_ICE_SERVERS) for any non-trivial deployment.
let iceServers = [
    {urls : "stun:stun.l.google.com:19302"}, {urls : "stun:stun.relay.metered.ca:80"}, {
        urls : "turn:global.relay.metered.ca:80",
        username : "83c1c2d5812f27ae1744dfcc",
        credential : "5T/RNHuNmGmq1/pj"
    },
    {
        urls : "turn:global.relay.metered.ca:80?transport=tcp",
        username : "83c1c2d5812f27ae1744dfcc",
        credential : "5T/RNHuNmGmq1/pj"
    },
    {
        urls : "turn:global.relay.metered.ca:443",
        username : "83c1c2d5812f27ae1744dfcc",
        credential : "5T/RNHuNmGmq1/pj"
    },
    {
        urls : "turns:global.relay.metered.ca:443?transport=tcp",
        username : "83c1c2d5812f27ae1744dfcc",
        credential : "5T/RNHuNmGmq1/pj"
    }
];
if (process.env.TELEPORT_ICE_SERVERS)
{
    try
    {
        const parsed = JSON.parse(process.env.TELEPORT_ICE_SERVERS);
        if (Array.isArray(parsed))
            iceServers = parsed;
        else
            console.error("TELEPORT_ICE_SERVERS must be a JSON array; ignoring.");
    }
    catch (e)
    {
        console.error("Failed to parse TELEPORT_ICE_SERVERS: " + e.toString() + "; ignoring.");
    }
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
        console.log(
            `HTTP ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
});
express_app.use(express.static('dashboard_public'));
// Also serve any static 3D resources when requested. Use absolute path so it works
// regardless of the directory node was started from.
express_app.use(express.static(publicPath));
// Don't pass express_app to createServer - that would cause it to initalize before websockets is
// connected
const http_server = express_app.listen(signaling_port);
// Only forward genuine WebSocket upgrades to the signaling server. Other Upgrade
// requests (e.g. h2c from curl/HTTP-2 capable clients) must be rejected so the
// underlying TCP connection can fall back to a normal HTTP/1.1 request that
// Express can then serve via express.static.
http_server.on('upgrade', function upgrade(request, socket, head) {
    const upgradeHeader = (request.headers.upgrade || '').toLowerCase();
    console.log("HTTP upgrade request received: " + upgradeHeader + " " + request.url);
    console.log("  Host header: " + request.headers.host);
    console.log("  X-Forwarded-Host header: " + request.headers['x-forwarded-host']);
    if (upgradeHeader !== 'websocket')
    {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
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

console.log(`Dashboard: http://localhost:${signaling_port}`);
