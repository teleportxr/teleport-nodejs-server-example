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
// client's session: created in the post-creation callback, destroyed in the
// disconnection callback, with a RemoveNodes payload queued for every
// remaining client so departed avatars disappear from their scenes.

const nd = require('teleportxr/scene/node');

class AvatarNodeManager
{
    // cfg: { url, position: [x, y, z] }
    constructor(scene, clientManager, cfg)
    {
        this.scene         = scene;
        this.clientManager = clientManager;
        this.cfg           = cfg;
        this.nodeByClient  = new Map(); // clientID -> avatar node uid
    }

    // Create (or return) the avatar node for a client and stream it to them.
    // The node lives in the shared scene, so every other client receives it
    // via the usual streaming pass as well. Returns the node uid.
    createForClient(clientID, client)
    {
        if (this.nodeByClient.has(clientID))
            return this.nodeByClient.get(clientID);
        const node         = new nd.Node('Avatar_' + clientID);
        const p            = this.cfg.position || [ 0, 0, 0 ];
        node.pose.position = {x : p[0], y : p[1], z : p[2]};
        node.setMeshComponent(this.cfg.url);
        const uid = this.scene.InsertNode(node);
        this.nodeByClient.set(clientID, uid);
        if (client)
            client.geometryService.StreamNode(uid);
        console.log('Avatar node ' + uid + ' (' + this.cfg.url + ') created for client ' +
                    clientID);
        return uid;
    }

    // Destroy the avatar node of a disconnected client: remove it from the
    // scene and unstream it for every remaining client, which queues a
    // RemoveNodes payload for their next streaming tick.
    destroyForClient(clientID)
    {
        const uid = this.nodeByClient.get(clientID);
        if (uid == null)
            return;
        this.nodeByClient.delete(clientID);
        this.scene.RemoveNode(uid);
        for (const [id, cl] of this.clientManager.clients)
        {
            cl.geometryService.UnstreamNode(uid);
        }
        console.log('Avatar node ' + uid + ' destroyed for disconnected client ' + clientID);
    }
}

module.exports = {AvatarNodeManager};
