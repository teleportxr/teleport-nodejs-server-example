// SPDX-FileCopyrightText: 2025 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

// Server-provided avatar nodes. One node per connected client, carrying a
// MeshComponent whose URL points at a VRM file served from http_resources.
// The client fetches the VRM over HTTP and instantiates it as a subscene of
// the node (the .vrm extension decodes as GLTF_BINARY and creates a child
// geometry cache — no extra protocol work is needed).
//
// The node is static for now; how it moves is TBD. Its lifetime is the
// client's session: created in the post-creation callback and registered with
// the client-node registry, which destroys it when the client's grace period
// expires. Every remaining client's next streaming pass then finds it gone from
// its visible set and queues a RemoveNodes payload of its own accord.

const nd           = require('teleportxr/scene/node');
const client_nodes = require('teleportxr/client/client_nodes');

class AvatarNodeManager
{
    // cfg: { url, position: [x, y, z], sendOwnAvatar }
    constructor(scene, clientManager, cfg)
    {
        this.scene         = scene;
        this.clientManager = clientManager;
        this.cfg           = cfg;
        this.nodeByClient  = new Map(); // clientID -> avatar node uid
    }

    // The client-node registry, if the client manager has one.
    _registry()
    {
        return (this.clientManager && this.clientManager.clientNodes)
                   ? this.clientManager.clientNodes
                   : null;
    }

    // Create (or return) the avatar node for a client, parented under that
    // client's origin node so it follows the client's local space. The node
    // lives in the shared scene, so every other client receives it via the
    // usual streaming pass. Returns the node uid.
    createForClient(clientID, client)
    {
        if (this.nodeByClient.has(clientID))
            return this.nodeByClient.get(clientID);
        const node         = new nd.Node('Avatar_' + clientID);
        const p            = this.cfg.position || [ 0, 0, 0 ];
        node.pose.position = {x : p[0], y : p[1], z : p[2]};
        node.parent_uid    = (client && client.origin_uid) ? client.origin_uid : 0;
        node.setMeshComponent(this.cfg.url);
        const uid = this.scene.InsertNode(node);
        this.nodeByClient.set(clientID, uid);
        const sendOwn  = this.cfg.sendOwnAvatar !== false;
        const registry = this._registry();
        if (registry)
        {
            registry.register(clientID, uid, {
                role : 'avatar',
                visibility : sendOwn ? client_nodes.NodeVisibility.Everyone
                                     : client_nodes.NodeVisibility.PeersOnly,
            });
        }
        if (sendOwn && client)
            client.geometryService.StreamNode(uid);
        console.log('Avatar node ' + uid + ' (' + this.cfg.url + ') created for client ' +
                    clientID);
        return uid;
    }

    // Forget the avatar node of a disconnected client. The registry has already
    // taken it out of the scene by the time this runs; removing it again is a
    // no-op, and is here so the manager still works without a registry.
    destroyForClient(clientID)
    {
        const uid = this.nodeByClient.get(clientID);
        if (uid == null)
            return;
        this.nodeByClient.delete(clientID);
        const registry = this._registry();
        if (registry)
            registry.unregister(uid);
        this.scene.RemoveNode(uid);
        console.log('Avatar node ' + uid + ' destroyed for disconnected client ' + clientID);
    }
}

module.exports = {AvatarNodeManager};
