// SPDX-FileCopyrightText: 2025 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

'use strict';
// Tests for AvatarNodeManager: session-scoped avatar node lifecycle.
// Scene, ClientManager and clients are fakes so the test does not depend on
// the WebRTC stack; only scene/node.js is taken from the installed teleportxr
// package (setMeshComponent is a stable API).

const test                = require('node:test');
const assert              = require('node:assert');
const {AvatarNodeManager} = require('../src/avatar-nodes.js');

function makeFakeScene()
{
    const nodes = new Map();
    return {
        nodes,
        InsertNode(node) {
            nodes.set(node.uid, node);
            return node.uid;
        },
        RemoveNode(uid) {
            return nodes.delete(uid);
        },
    };
}

function makeFakeClient()
{
    return {
        geometryService : {
            streamed : [],
            unstreamed : [],
            StreamNode(uid) {
                this.streamed.push(uid);
            },
            UnstreamNode(uid) {
                this.unstreamed.push(uid);
            },
        },
    };
}

function makeManager(cfg)
{
    const scene         = makeFakeScene();
    const clientManager = {clients : new Map()};
    const mgr           = new AvatarNodeManager(scene, clientManager, cfg);
    return {mgr, scene, clientManager};
}

const cfg = {
    url : '/generic_avatar.vrm',
    position : [ 1, 2, 3 ]
};

test('createForClient inserts a mesh node with the configured pose and streams it', () => {
    const {mgr, scene} = makeManager(cfg);
    const client       = makeFakeClient();
    const uid          = mgr.createForClient('clientA', client);

    const node         = scene.nodes.get(uid);
    assert.ok(node, 'node must be in the scene');
    assert.strictEqual(node.name, 'Avatar_clientA');
    assert.deepStrictEqual(node.pose.position, {x : 1, y : 2, z : 3});
    assert.deepStrictEqual(client.geometryService.streamed, [ uid ]);
    // The mesh component references the VRM url.
    const meshComponents = node.components.filter(c => c.getType() === 2); // NodeDataType.Mesh
    assert.strictEqual(meshComponents.length, 1);
    assert.strictEqual(meshComponents[0].meshUrl, '/generic_avatar.vrm');
});

test('createForClient is idempotent per client', () => {
    const {mgr} = makeManager(cfg);
    const uid1  = mgr.createForClient('clientA', makeFakeClient());
    const uid2  = mgr.createForClient('clientA', makeFakeClient());
    assert.strictEqual(uid1, uid2);
});

test('destroyForClient removes the node and unstreams it for remaining clients', () => {
    const {mgr, scene, clientManager} = makeManager(cfg);
    const clientA                     = makeFakeClient();
    const uid                         = mgr.createForClient('clientA', clientA);

    const clientB                     = makeFakeClient();
    const clientC                     = makeFakeClient();
    clientManager.clients.set('clientB', clientB);
    clientManager.clients.set('clientC', clientC);

    mgr.destroyForClient('clientA');

    assert.ok(!scene.nodes.has(uid), 'node must be removed from the scene');
    assert.deepStrictEqual(clientB.geometryService.unstreamed, [ uid ]);
    assert.deepStrictEqual(clientC.geometryService.unstreamed, [ uid ]);
    // A second destroy is a harmless no-op.
    mgr.destroyForClient('clientA');
    assert.deepStrictEqual(clientB.geometryService.unstreamed, [ uid ]);
});

test('destroyForClient for a client with no avatar node is a no-op', () => {
    const {mgr} = makeManager(cfg);
    assert.doesNotThrow(() => mgr.destroyForClient('nobody'));
});
