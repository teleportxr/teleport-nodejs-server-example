// SPDX-FileCopyrightText: 2025 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

'use strict';

// MicRouter — a per-source SFU broker for client microphone audio.
//
// Each WebRtcConnection exposes an inbound mic feed as the 'micFrame' event
// (clientId, frame). For spatial audio, every listener must receive each other
// participant's voice on its OWN track, bound to the emitting node by the track's
// SDP mid = that participant's origin node uid (see docs/protocol/audio.rst). So
// this router asks each listener connection for a dedicated sendonly voice track
// per source (connection.addNodeAudioSource(nodeUid) -> RTCAudioSource), renegotiates,
// and forwards each source's micFrame only into the matching per-source track.
//
// Selection policy is configurable: "All" forwards every other participant (with
// loopback suppression); "Proximity" forwards the nearest `maxInboundStreams`
// sources within `proximityRadiusMetres`, using each client's head position (from
// its NodePosesMessage). A source dropping out of the selected set is retained for
// `evictionGraceMs` (hysteresis) to avoid churn at the selection boundary.
// Connections are created lazily by the library and there is no connection-created
// event, so we reconcile on a short poll.

const DEFAULT_POLL_MS = 1000;

class MicRouter
{
    // connectionManager: exposes getConnections() -> [connection], each with
    //   id, EventEmitter, addNodeAudioSource(nodeUid), removeNodeAudioSource(nodeUid),
    //   getNodeAudioSourceUids(), renegotiate().
    // clientManager: exposes GetClient(clientId) -> { currentOriginState:{originClientHas} },
    //   used to resolve each participant's origin node uid (the voice's mid).
    constructor(connectionManager, clientManager, options = {})
    {
        options                    = options || {};
        this.connectionManager     = connectionManager;
        this.clientManager         = clientManager;
        this.pollMs                = options.pollMs || DEFAULT_POLL_MS;
        // 'All' or 'Proximity'.
        this.selectionPolicy       = options.selectionPolicy || 'All';
        this.maxInboundStreams     = options.maxInboundStreams || 0;     // 0 = no cap
        this.proximityRadiusMetres = options.proximityRadiusMetres || 0; // 0 = no radius limit
        this.evictionGraceMs       = options.evictionGraceMs || 0;       // grace before dropping
        this.handlers              = new Map(); // connId -> micFrame handler
        this.routes       = new Map(); // sourceConnId -> Map(listenerConnId -> RTCAudioSource)
        this.pendingEvict = new Map(); // listenerId -> Map(uid -> sinceMs)
        this.intervalId   = null;
    }

    start(pollMs)
    {
        if (this.intervalId)
            return;
        if (pollMs)
            this.pollMs = pollMs;
        this.poll();
        this.intervalId = setInterval(() => this.poll(), this.pollMs);
    }

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
        this.routes.clear();
    }

    _connections()
    {
        if (!this.connectionManager || typeof this.connectionManager.getConnections !== 'function')
            return [];
        return this.connectionManager.getConnections() || [];
    }

    // The origin node uid for a connection's client, as a BigInt (0n if unknown).
    _originUid(connId)
    {
        const c = (this.clientManager && typeof this.clientManager.GetClient === 'function')
                      ? this.clientManager.GetClient(connId)
                      : null;
        if (!c || !c.currentOriginState)
            return 0n;
        try
        {
            return BigInt(c.currentOriginState.originClientHas || 0);
        }
        catch (e)
        {
            return 0n;
        }
    }

    // The head position {x,y,z} for a connection's client in the server's GLOBAL
    // space, or null if unknown. Clients report their head in their own stage
    // space, so the raw pose is only comparable between two clients when both
    // origins coincide — proximity selection needs the global position.
    _position(connId)
    {
        const c = (this.clientManager && typeof this.clientManager.GetClient === 'function')
                      ? this.clientManager.GetClient(connId)
                      : null;
        if (!c)
            return null;
        if (typeof c.GetGlobalHeadPosition === 'function')
            return c.GetGlobalHeadPosition();
        return (typeof c.GetHeadPosition === 'function') ? c.GetHeadPosition() : null;
    }

    // Choose which sources `listener` should hear. Returns Map(originUid(BigInt) -> source).
    // Loopback-suppressed; honours selectionPolicy, proximityRadiusMetres and
    // maxInboundStreams. Sources with an unknown position are kept (fail-open) so audio
    // is not lost before poses arrive, but sort last under Proximity.
    _selectDesired(listener, live)
    {
        const lp     = this._position(listener.id);
        const scored = [];
        for (const source of live)
        {
            if (source.id === listener.id)
                continue;
            const uid = this._originUid(source.id);
            if (!uid)
                continue;
            const sp   = this._position(source.id);
            let   dist = Infinity;
            if (lp && sp)
                dist = Math.hypot(sp.x - lp.x, sp.y - lp.y, sp.z - lp.z);
            scored.push({uid, source, dist});
        }
        let eligible = scored;
        if (this.selectionPolicy === 'Proximity')
        {
            if (this.proximityRadiusMetres > 0)
                eligible =
                    eligible.filter(s => !isFinite(s.dist) || s.dist <= this.proximityRadiusMetres);
            eligible.sort((a, b) => a.dist - b.dist);
        }
        if (this.maxInboundStreams > 0 && eligible.length > this.maxInboundStreams)
            eligible = eligible.slice(0, this.maxInboundStreams);
        const out = new Map();
        for (const e of eligible)
            out.set(e.uid, e.source);
        return out;
    }

    // Reconcile mic-frame subscriptions and per-listener voice tracks against the
    // current connection set.
    poll()
    {
        const live    = this._connections();
        const liveIds = new Set(live.map(c => c.id));

        for (const conn of live)
            this._attach(conn);

        // For each listener, reconcile its per-source tracks against the selected set,
        // keyed by each source's origin node uid (loopback suppressed).
        const now = Date.now();
        for (const listener of live)
        {
            if (typeof listener.addNodeAudioSource !== 'function')
                continue;

            const desired = this._selectDesired(listener, live);
            const current = new Set(listener.getNodeAudioSourceUids());
            let   pend    = this.pendingEvict.get(listener.id);
            let   changed = false;

            // Add newly-selected sources; cancel any pending eviction for them.
            for (const [uid, source] of desired)
            {
                if (pend)
                    pend.delete(uid);
                if (current.has(uid))
                    continue;
                const audioSource = listener.addNodeAudioSource(uid);
                if (audioSource)
                {
                    this._route(source.id, listener.id, audioSource);
                    changed = true;
                }
            }
            // Evict sources no longer selected, after the grace period (hysteresis).
            for (const uid of current)
            {
                if (desired.has(uid))
                    continue;
                if (this.evictionGraceMs > 0)
                {
                    if (!pend)
                    {
                        pend = new Map();
                        this.pendingEvict.set(listener.id, pend);
                    }
                    const since = pend.get(uid);
                    if (since === undefined)
                    {
                        pend.set(uid, now);
                        continue;
                    } // start grace
                    if (now - since < this.evictionGraceMs)
                        continue; // still in grace
                }
                listener.removeNodeAudioSource(uid);
                this._unroute(listener.id, uid, live);
                if (pend)
                    pend.delete(uid);
                changed = true;
            }

            if (changed && typeof listener.renegotiate === 'function')
                Promise.resolve(listener.renegotiate())
                    .catch(e => console.error('MicRouter: renegotiate ' + listener.id +
                                              ' failed: ' + e.message));
        }

        // Drop handlers and routes belonging to connections that have gone away.
        for (const id of [...this.handlers.keys()])
            if (!liveIds.has(id))
                this.handlers.delete(id);
        for (const id of [...this.pendingEvict.keys()])
            if (!liveIds.has(id))
                this.pendingEvict.delete(id);
        for (const srcId of [...this.routes.keys()])
        {
            if (!liveIds.has(srcId))
            {
                this.routes.delete(srcId);
                continue;
            }
            const listeners = this.routes.get(srcId);
            for (const lid of [...listeners.keys()])
                if (!liveIds.has(lid))
                    listeners.delete(lid);
        }
    }

    _route(srcId, listenerId, audioSource)
    {
        if (!this.routes.has(srcId))
            this.routes.set(srcId, new Map());
        this.routes.get(srcId).set(listenerId, audioSource);
    }

    // Remove the route feeding `listenerId` for the source whose origin uid is `uid`.
    _unroute(listenerId, uid, live)
    {
        for (const source of live)
        {
            if (this._originUid(source.id) === uid && this.routes.has(source.id))
            {
                this.routes.get(source.id).delete(listenerId);
                return;
            }
        }
    }

    _attach(connection)
    {
        if (!connection || this.handlers.has(connection.id) || typeof connection.on !== 'function')
            return;
        const handler = (sourceId, frame) => this._forward(sourceId, frame);
        this.handlers.set(connection.id, handler);
        connection.on('micFrame', handler);
        console.log('MicRouter: attached to client ' + connection.id);
    }

    // Forward one source's mic frame into each listener's per-source voice track.
    _forward(sourceId, frame)
    {
        const listeners = this.routes.get(sourceId);
        if (!listeners)
            return;
        for (const audioSource of listeners.values())
        {
            try
            {
                audioSource.onData(frame);
            }
            catch (e)
            { /* track may be tearing down */
            }
        }
    }
}

module.exports = MicRouter;
