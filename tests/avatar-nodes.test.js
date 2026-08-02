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

test('destroyForClient removes the node from the scene, which is what makes clients drop it',
     () => {
         const {mgr, scene, clientManager} = makeManager(cfg);
         const clientA                     = makeFakeClient();
         const uid                         = mgr.createForClient('clientA', clientA);

         const clientB                     = makeFakeClient();
         const clientC                     = makeFakeClient();
         clientManager.clients.set('clientB', clientB);
         clientManager.clients.set('clientC', clientC);

         mgr.destroyForClient('clientA');

         assert.ok(!scene.nodes.has(uid), 'node must be removed from the scene');
         // Each client's next UpdateVisibleNodes pass finds the node gone from
         // its visible set and queues its own RemoveNodes payload. The manager
         // must NOT reach into other clients' geometry services to do it by hand.
         assert.deepStrictEqual(clientB.geometryService.unstreamed, []);
         assert.deepStrictEqual(clientC.geometryService.unstreamed, []);
         // A second destroy is a harmless no-op.
         assert.doesNotThrow(() => mgr.destroyForClient('clientA'));
     });

test('the avatar node is registered to its client, parented under its origin', () => {
    const {ClientNodeRegistry, NodeVisibility} = require('teleportxr/client/client_nodes');
    const scene                                = makeFakeScene();
    // The registry stamps ownership onto the scene node, so it needs GetNode.
    scene.GetNode = (uid) => scene.nodes.get(uid) || null;
    const registry         = new ClientNodeRegistry(scene);
    const clientManager    = {clients : new Map(), clientNodes : registry};
    const mgr              = new AvatarNodeManager(scene, clientManager, cfg);
    const client           = makeFakeClient();
    client.origin_uid      = 4242n;

    const uid              = mgr.createForClient('clientA', client);
    assert.strictEqual(scene.nodes.get(uid).parent_uid, 4242n,
                       'the avatar must follow its owner\'s local space');
    assert.strictEqual(registry.ownerOf(uid), 'clientA');
    assert.strictEqual(registry.roleOf(uid), 'avatar');
    assert.strictEqual(registry.visibilityOf(uid), NodeVisibility.Everyone);

    mgr.destroyForClient('clientA');
    assert.strictEqual(registry.ownerOf(uid), 0);
});

test('sendOwnAvatar=false keeps a client from being sent its own avatar', () => {
    const {ClientNodeRegistry} = require('teleportxr/client/client_nodes');
    const scene                = makeFakeScene();
    scene.GetNode = (uid) => scene.nodes.get(uid) || null;
    const registry         = new ClientNodeRegistry(scene);
    const mgr    = new AvatarNodeManager(scene, {clients : new Map(), clientNodes : registry},
                                         Object.assign({}, cfg, {sendOwnAvatar : false}));
    const client = makeFakeClient();

    const uid    = mgr.createForClient('clientA', client);
    assert.strictEqual(registry.isVisibleTo(uid, 'clientA'), false);
    assert.strictEqual(registry.isVisibleTo(uid, 'clientB'), true);
    assert.deepStrictEqual(client.geometryService.streamed, []);
});

test('destroyForClient for a client with no avatar node is a no-op', () => {
    const {mgr} = makeManager(cfg);
    assert.doesNotThrow(() => mgr.destroyForClient('nobody'));
});
