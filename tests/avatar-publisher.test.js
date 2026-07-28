// SPDX-FileCopyrightText: 2026 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

// Tests for the Phase-4 avatar re-hosting store.

'use strict';

const test              = require('node:test');
const assert            = require('node:assert');

const {AvatarPublisher} = require('../src/avatar-publisher.js');

const    HASH           = 'a'.repeat(64);
const    HASH2          = 'b'.repeat(64);

function fakeRes()
{
    return {
        headers : {},
        statusCode : 200,
        body : null,
        ended : false,
        setHeader(k, v) {
            this.headers[k.toLowerCase()] = v;
        },
        status(c) {
            this.statusCode = c;
            return this;
        },
        send(b) {
            this.body = b;
            return this;
        },
        end() {
            this.ended = true;
            return this;
        },
    };
}

test('publish returns a content-addressed URL and stores the bytes', () => {
    const p    = new AvatarPublisher();
    const body = Buffer.from('glb-bytes');
    const url  = p.publish({body, contentHash : 'sha256:' + HASH, format : 'glb'});
    assert.strictEqual(url, '/avatars/' + HASH + '.glb');
    assert.strictEqual(p.size, 1);
    assert.strictEqual(p.get(HASH + '.glb').body, body);
    assert.strictEqual(p.get(HASH + '.glb').contentType, 'model/gltf-binary');
});

test('publish is idempotent for identical content', () => {
    const p = new AvatarPublisher();
    const a = p.publish({body : Buffer.from('x'), contentHash : 'sha256:' + HASH, format : 'glb'});
    const b = p.publish({body : Buffer.from('x'), contentHash : 'sha256:' + HASH, format : 'glb'});
    assert.strictEqual(a, b);
    assert.strictEqual(p.size, 1);
});

test('publish picks the extension and content type from the format', () => {
    const p = new AvatarPublisher();
    assert.ok(p.publish({body : Buffer.from('x'), contentHash : 'sha256:' + HASH, format : 'vrm'})
                  .endsWith('.vrm'));
    const gltfUrl =
        p.publish({body : Buffer.from('{}'), contentHash : 'sha256:' + HASH2, format : 'gltf'});
    assert.ok(gltfUrl.endsWith('.gltf'));
    assert.strictEqual(p.get(HASH2 + '.gltf').contentType, 'model/gltf+json');
});

test('publish refuses anything that is not a bare sha-256 digest', () => {
    const p    = new AvatarPublisher();
    const body = Buffer.from('x');
    for (const bad of ['../../etc/passwd', 'sha256:../x',
                       'sha256:' +
                           'A'.repeat(64),
                       'sha256:zz', '', null])
        assert.throws(() => p.publish({body, contentHash : bad, format : 'glb'}),
                      /bad content hash/);
});

test('publish refuses an empty or non-buffer body', () => {
    const p = new AvatarPublisher();
    assert.throws(() => p.publish({body : Buffer.alloc(0), contentHash : 'sha256:' + HASH}),
                  /no body/);
    assert.throws(() => p.publish({body : 'not-a-buffer', contentHash : 'sha256:' + HASH}),
                  /no body/);
});

test('the store is bounded and evicts oldest-first', () => {
    const p      = new AvatarPublisher({maxEntries : 2});
    const hashes = [ '1', '2', '3' ].map((c) => c.repeat(64));
    for (const h of hashes)
        p.publish({body : Buffer.from(h), contentHash : 'sha256:' + h, format : 'glb'});
    assert.strictEqual(p.size, 2);
    assert.strictEqual(p.get(hashes[0] + '.glb'), null);
    assert.ok(p.get(hashes[2] + '.glb'));
});

test('handleRequest serves a published avatar as immutable', () => {
    const p    = new AvatarPublisher();
    const body = Buffer.from('glb-bytes');
    p.publish({body, contentHash : 'sha256:' + HASH, format : 'glb'});
    const res = fakeRes();
    p.handleRequest({params : {name : HASH + '.glb'}}, res);
    assert.strictEqual(res.body, body);
    assert.strictEqual(res.headers['content-type'], 'model/gltf-binary');
    assert.match(res.headers['cache-control'], /immutable/);
    assert.strictEqual(res.headers['etag'], '"' + HASH + '.glb"');
});

test('handleRequest 404s an unknown name', () => {
    const p   = new AvatarPublisher();
    const res = fakeRes();
    p.handleRequest({params : {name : 'nope.glb'}}, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.ended, true);
    assert.strictEqual(res.body, null);
});
