// SPDX-FileCopyrightText: 2025 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

'use strict';

const test         = require('node:test');
const assert       = require('node:assert');
const EventEmitter = require('node:events');
const MicRouter    = require('../src/mic-router.js');

// A stand-in for a WebRtcConnection: an EventEmitter that emits 'micFrame' and
// carries an _audioSource whose onData records the frames it is handed.
class FakeConnection extends EventEmitter
{
    constructor(id)
    {
        super();
        this.id           = id;
        this.received     = [];
        this._audioSource = {onData : (frame) => this.received.push(frame)};
    }
}

// A stand-in for the WebRtcConnectionManager singleton.
class FakeManager
{
    constructor(connections)
    {
        this.connections = connections;
    }
    getConnections()
    {
        return this.connections;
    }
}

test('forwards a mic frame to peers but not back to the source', () => {
    const a      = new FakeConnection('A');
    const b      = new FakeConnection('B');
    const c      = new FakeConnection('C');
    const router = new MicRouter(new FakeManager([ a, b, c ]));
    router.poll(); // attach to all three

    const frame = {samples : new Int16Array([ 1, 2, 3 ]), sampleRate : 48000};
    a.emit('micFrame', 'A', frame);

    assert.strictEqual(a.received.length, 0, 'source must not receive its own frame');
    assert.strictEqual(b.received.length, 1, 'peer B should receive the frame');
    assert.strictEqual(c.received.length, 1, 'peer C should receive the frame');
    assert.strictEqual(b.received[0], frame);
});

test('does not attach twice to the same connection', () => {
    const a      = new FakeConnection('A');
    const b      = new FakeConnection('B');
    const router = new MicRouter(new FakeManager([ a, b ]));
    router.poll();
    router.poll(); // second reconcile must be a no-op for existing connections

    a.emit('micFrame', 'A', {samples : new Int16Array([ 0 ])});
    assert.strictEqual(b.received.length, 1, 'frame must be forwarded exactly once');
});

test('drops handlers for connections that have gone away', () => {
    const a       = new FakeConnection('A');
    const b       = new FakeConnection('B');
    const manager = new FakeManager([ a, b ]);
    const router  = new MicRouter(manager);
    router.poll();

    manager.connections = [ b ]; // A disconnected
    router.poll();
    assert.ok(!router.handlers.has('A'), 'handler for departed connection should be dropped');
});

test('tolerates a connection whose audio source is not yet ready', () => {
    const a        = new FakeConnection('A');
    const b        = new FakeConnection('B');
    b._audioSource = null; // media track not negotiated yet
    const router   = new MicRouter(new FakeManager([ a, b ]));
    router.poll();

    assert.doesNotThrow(() => a.emit('micFrame', 'A', {samples : new Int16Array([ 0 ])}));
});
