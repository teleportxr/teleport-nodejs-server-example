// SPDX-FileCopyrightText: 2025 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

// Where the scene comes from, and how it is swapped for a newer one.
//
// The example server used to call scene.Load() once, on a file that had to
// already exist in assets/. Managed hosting boots this server unmodified, so
// both halves of that were a problem: the scene had to be downloaded by a boot
// script before node started, and publishing an edit meant restarting the
// machine. This module makes both expressible as environment variables —
// TELEPORT_SCENE_URL and TELEPORT_SCENE_RELOAD — with the on-disk
// TELEPORT_SCENE_PATH as the fallback whenever the URL cannot be used.
//
// Reloading works without any support from the teleportxr library because each
// client's streaming pass re-derives what it should see from the scene every
// tick (GeometryService.UpdateVisibleNodes): nodes that have appeared are
// streamed, nodes that have gone are queued as a RemoveNodes payload. All this
// module has to do is remember which nodes the last load created, so it removes
// exactly those and never a client-specific node (a client's origin node, its
// avatar) that happens to be in the scene at the time.

'use strict';

const fs                    = require('fs');
const path                  = require('path');
const crypto                = require('crypto');

// Name of the file a fetched scene is written to, without the .json extension.
// It lives in the assets directory because Scene.Load resolves font-atlas paths
// relative to the scene file's own directory — a scene downloaded to a temp dir
// would lose its fonts. Gitignored.
const REMOTE_SCENE_BASENAME = '_remote_scene';

class SceneSource
{
    // scene          — the teleportxr Scene to load into.
    // assetsPath     — absolute path of the assets directory (scene.SetAssetsPath).
    // path           — TELEPORT_SCENE_PATH, without the .json extension.
    // url            — TELEPORT_SCENE_URL, or null for file-only.
    // fetchTimeoutMs — wall-clock budget for the whole fetch.
    // maxBytes       — cap on the fetched body.
    constructor({scene, assetsPath, path: scenePath, url, fetchTimeoutMs, maxBytes})
    {
        this.scene          = scene;
        this.assetsPath     = assetsPath;
        this.path           = scenePath;
        this.url            = url || null;
        this.fetchTimeoutMs = fetchTimeoutMs || 15000;
        this.maxBytes       = maxBytes || 16000000;
        // Uids of the nodes the last load created. Everything else in the scene
        // belongs to somebody else and must survive a reload.
        this.loadedUids     = [];
        // SHA-256 of the bytes last loaded, so a reload that fetches identical
        // content can do nothing instead of churning every client's scene.
        this.digest         = null;
        this.reloading      = false;
    }

    // First load. Throws only if neither the URL nor the file yields a scene,
    // which is fatal — a server with no scene has nothing to serve.
    async load()
    {
        const acquired = await this.acquire();
        this.apply(acquired);
        return {source : acquired.source, file : acquired.file};
    }

    // Re-acquire and swap. Returns {changed, reason}. A failure to acquire
    // leaves the running scene exactly as it was, so a transient outage at the
    // scene host cannot empty a live session.
    async reload()
    {
        if (this.reloading)
            return {changed : false, reason : 'a reload is already in progress'};
        this.reloading = true;
        try
        {
            const acquired = await this.acquire();
            if (this.digest && acquired.digest === this.digest)
                return {changed : false, reason : 'content unchanged'};
            // Scene.Load only assigns the environment paths when the new JSON
            // has an "environment" block, so clear them first: a scene that
            // drops its cubemaps should not inherit the previous one's.
            this.scene.backgroundTexturePath = '';
            this.scene.diffuseCubemapPath    = '';
            this.scene.specularCubemapPath   = '';
            for (const uid of this.loadedUids)
            {
                this.scene.RemoveNode(uid);
            }
            this.apply(acquired);
            return {
                changed : true,
                reason : 'content changed',
                source : acquired.source,
                file : acquired.file
            };
        }
        finally
        {
            this.reloading = false;
        }
    }

    // Load the acquired file and record which nodes it created.
    apply(acquired)
    {
        const before = new Set(this.scene.GetAllNodeUids());
        this.scene.Load(acquired.file);
        this.loadedUids = this.scene.GetAllNodeUids().filter((uid) => !before.has(uid));
        this.digest     = acquired.digest;
    }

    // Get the scene onto disk under assetsPath and return where it landed.
    // The URL is tried first when configured; any failure falls back to the
    // configured path, as requested by hosting.
    async acquire()
    {
        if (this.url)
        {
            try
            {
                return await this.acquireFromUrl();
            }
            catch (err)
            {
                console.warn('scene: could not load from ' + this.url + ' (' + err.message +
                             '); falling back to ' + this.path + '.json');
            }
        }
        return this.acquireFromFile();
    }

    async acquireFromUrl()
    {
        let parsed;
        try
        {
            parsed = new URL(this.url);
        }
        catch (err)
        {
            throw new Error('not a valid URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            throw new Error('unsupported protocol ' + parsed.protocol);

        const response = await fetch(this.url, {
            signal : AbortSignal.timeout(this.fetchTimeoutMs),
            headers : {'Accept' : 'application/json'},
        });
        if (!response.ok)
            throw new Error('HTTP ' + response.status + ' ' + response.statusText);
        // Reject an over-large body before downloading it where the server says
        // how big it is; check again afterwards for the servers that do not.
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > this.maxBytes)
            throw new Error('scene is ' + declared + ' bytes, over the ' + this.maxBytes +
                            '-byte limit');
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > this.maxBytes)
            throw new Error('scene is ' + body.length + ' bytes, over the ' + this.maxBytes +
                            '-byte limit');
        // Parse before writing: a truncated or HTML error page must not replace
        // the last good scene file on disk.
        JSON.parse(body.toString('utf8'));

        const file = REMOTE_SCENE_BASENAME + '.json';
        fs.writeFileSync(path.join(this.assetsPath, file), body);
        return {source : 'url', file, digest : digestOf(body)};
    }

    acquireFromFile()
    {
        const file = this.path + '.json';
        const full = path.join(this.assetsPath, file);
        const body = fs.readFileSync(full);
        // Same reason as above: fail before the scene is touched rather than
        // half-way through Scene.Load.
        JSON.parse(body.toString('utf8'));
        return {source : 'file', file, digest : digestOf(body)};
    }
}

function digestOf(buffer)
{
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Express's "trust proxy" setting, from TELEPORT_TRUST_PROXY. Lives here rather
// than in config.js only to keep the env-parsing helpers together with the tests
// that cover them; see config.js for how it is used.
//   unset          -> null  (leave Express's own default alone)
//   true/yes/on    -> true  (trust every hop)
//   false/no/off   -> false
//   an integer     -> that many hops
//   anything else  -> passed through verbatim, so Express's 'loopback',
//                     'uniquelocal' and comma-separated IP/CIDR forms work.
//
// Deliberately NOT boolean-like, unlike the rest of this server's variables:
// "1" is one proxy hop, not "on". Trusting every hop lets any client forge
// X-Forwarded-For, and silently upgrading a "1" meant as a hop count into that
// is exactly the mistake this setting exists to avoid. Write "true" to mean it.
function parseTrustProxy(value)
{
    if (value == null || value === '')
        return null;
    const s     = String(value).trim();
    const lower = s.toLowerCase();
    if (lower === 'true' || lower === 'yes' || lower === 'on')
        return true;
    if (lower === 'false' || lower === 'no' || lower === 'off')
        return false;
    if (/^\d+$/.test(s))
        return Number(s);
    return s;
}

module.exports = {
    SceneSource,
    parseTrustProxy,
    REMOTE_SCENE_BASENAME
};
