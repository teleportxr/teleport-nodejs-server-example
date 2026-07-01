// SPDX-FileCopyrightText: 2025 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

'use strict';

// MicRouter — a minimal SFU broker for client microphone audio.
//
// Each WebRtcConnection in the teleportxr library exposes an inbound mic feed as
// the 'micFrame' event (clientId, frame) and an outbound RTCAudioSource as
// `_audioSource`. The frame shape produced by RTCAudioSink is accepted verbatim
// by RTCAudioSource.onData, so forwarding is a straight passthrough.
//
// This router subscribes to every live connection's 'micFrame' and forwards each
// frame to every OTHER live connection's audio source, applying loopback
// suppression by clientId. The default selection policy is "All".
//
// Connections are created lazily by the library (after the client acknowledges
// its SetupCommand), and there is no connection-created event on the manager, so
// the router reconciles against the manager's connection list on a short poll.

const DEFAULT_POLL_MS = 1000;

class MicRouter
{
    // connectionManager must expose getConnections() -> array of connections,
    // each with: id, EventEmitter on/removeListener, and an _audioSource with
    // an onData(frame) method (may be null until the media track is negotiated).
    constructor(connectionManager, options = {})
    {
        this.connectionManager = connectionManager;
        this.pollMs            = (options && options.pollMs) || DEFAULT_POLL_MS;
        // id -> bound micFrame handler, for the connections we have attached to.
        this.handlers          = new Map();
        this.intervalId        = null;
    }

    // Begin polling for new/removed connections and wiring their mic feeds.
    start(pollMs)
    {
        if (this.intervalId)
            return;
        if (pollMs)
            this.pollMs = pollMs;
        this.poll();
        this.intervalId = setInterval(() => this.poll(), this.pollMs);
    }

    // Stop polling and detach all mic-frame listeners.
    stop()
    {
        if (this.intervalId)
        {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        for (const conn of this._connections())
        {
            const handler = this.handlers.get(conn.id);
            if (handler && typeof conn.removeListener === 'function')
                conn.removeListener('micFrame', handler);
        }
        this.handlers.clear();
    }

    _connections()
    {
        if (!this.connectionManager || typeof this.connectionManager.getConnections !== 'function')
            return [];
        return this.connectionManager.getConnections() || [];
    }

    // Reconcile our attached set with the manager's current connections:
    // attach to ones we have not seen, drop ones that have gone away.
    poll()
    {
        const live    = this._connections();
        const liveIds = new Set();
        for (const conn of live)
        {
            liveIds.add(conn.id);
            this._attach(conn);
        }
        for (const id of [...this.handlers.keys()])
        {
            if (!liveIds.has(id))
                this.handlers.delete(id);
        }
    }

    _attach(connection)
    {
        if (!connection || this.handlers.has(connection.id))
            return;
        if (typeof connection.on !== 'function')
            return;
        const handler = (sourceId, frame) => this._forward(sourceId, frame);
        this.handlers.set(connection.id, handler);
        connection.on('micFrame', handler);
        console.log('MicRouter: attached to client ' + connection.id);
    }

    // Forward a single mic frame to every connection except the source.
    _forward(sourceId, frame)
    {
        for (const conn of this._connections())
        {
            if (conn.id === sourceId)
                continue; // loopback suppression
            const src = conn._audioSource;
            if (!src || typeof src.onData !== 'function')
                continue;
            try
            {
                src.onData(frame);
            }
            catch (e)
            {
                console.error('MicRouter: forward to ' + conn.id + ' failed: ' + e.message);
            }
        }
    }
}

module.exports = MicRouter;
