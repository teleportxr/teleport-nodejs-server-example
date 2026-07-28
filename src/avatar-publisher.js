// SPDX-FileCopyrightText: 2026 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

// Re-hosting for accepted avatars (Phase 4 of
// plans/avatars_implementation.md). When a client's avatar passes
// validation the server serves the validated bytes itself, so peers fetch
// the asset from us and never see the owner's original URL — which may
// carry a bearer token (plans/avatars_plan.md §8).
//
// Entries are content-addressed by the SHA-256 the validator computed, so
// the same asset offered by two clients is stored once, and the resulting
// URL is immutable and cacheable forever. The store is bounded and evicts
// oldest-first; an evicted avatar is simply re-published the next time a
// client offers it.

'use strict';

const DEFAULT_MAX_ENTRIES = 256;

class AvatarPublisher
{
    constructor(opts = {})
    {
        this.maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;
        this.basePath   = opts.basePath || '/avatars/';
        // Map preserves insertion order, so the first key is the oldest.
        this.entries    = new Map(); // name -> { body, contentType }
    }

    // Store the validated bytes and return the server-relative URL peers
    // should fetch. Shaped as the `publish` callback DefaultAvatarImporter
    // expects: ({ body, contentHash, format }) -> url.
    publish({body, contentHash, format})
    {
        const hex = String(contentHash || '').replace(/^sha256:/, '');
        // The name goes straight into a URL and is matched by the Express
        // route, so it must be exactly a hex digest — never client input.
        if (!/^[0-9a-f]{64}$/.test(hex))
            throw new Error('AvatarPublisher: bad content hash');
        if (!Buffer.isBuffer(body) || body.length === 0)
            throw new Error('AvatarPublisher: no body to publish');
        const ext  = format === 'gltf' ? 'gltf' : (format === 'vrm' ? 'vrm' : 'glb');
        const name = hex + '.' + ext;
        if (!this.entries.has(name))
        {
            while (this.entries.size >= this.maxEntries)
                this.entries.delete(this.entries.keys().next().value);
            this.entries.set(name, {
                body : body,
                contentType : format === 'gltf' ? 'model/gltf+json' : 'model/gltf-binary',
            });
        }
        return this.basePath + name;
    }

    get(name)
    {
        return this.entries.get(name) || null;
    }

    get size()
    {
        return this.entries.size;
    }

    // Express handler for GET <basePath>:name. Responses are immutable
    // because the name is a hash of the content.
    handleRequest(req, res)
    {
        const entry = this.get(req.params.name);
        if (!entry)
        {
            res.status(404).end();
            return;
        }
        res.setHeader('Content-Type', entry.contentType);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('ETag', '"' + req.params.name + '"');
        res.send(entry.body);
    }
}

module.exports = {
    AvatarPublisher,
    DEFAULT_MAX_ENTRIES
};
