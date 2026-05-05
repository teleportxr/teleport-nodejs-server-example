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
//
// 3. Fallback to localhost (used during startup before client connects)
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
            return `http://${autoDetectedHost}`;
        }
    }
    // Fallback to localhost
    return `http://localhost:${signaling_port}`;
}

// Default STUN/TURN servers for the example. Mixes UDP, TCP and TLS transports
// so ICE has multiple paths to try when UDP egress is blocked (e.g. Heroku).
// Override at runtime by setting TELEPORT_ICE_SERVERS to a JSON array.
let iceServers = [
    {urls : "stun:stun.l.google.com:19302"}, {urls : "turn:turn01.hubl.in?transport=udp"},
    {urls : "turn:turn02.hubl.in?transport=tcp"},
    {urls : "turn:numb.viagenie.ca", username : "webrtc@live.com", credential : "muazkh"}, {
        urls : "turn:192.158.29.39:3478?transport=udp",
        username : "28224511:1379330808",
        credential : "JZEOEt2V3Qb0y27GRntt2u2PAYA="
    },
    {
        urls : "turn:192.158.29.39:3478?transport=tcp",
        username : "28224511:1379330808",
        credential : "JZEOEt2V3Qb0y27GRntt2u2PAYA="
    },
    {urls : "turn:turn.bistri.com:80", username : "homeo", credential : "homeo"}, {
        urls : "turn:turn.anyfirewall.com:443?transport=tcp",
        username : "webrtc",
        credential : "webrtc"
    },
    {urls : "stun:stun.relay.metered.ca:80"}, {
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
