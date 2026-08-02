// SPDX-FileCopyrightText: 2025 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

const                          sc        = require('teleportxr/scene/scene');
const                          nd        = require('teleportxr/scene/node');
const                          cl        = require('teleportxr/client/client');

var                            sign2_uid = 0n;

class CustomPlayerNode extends nd.Node{
    constructor(name = "")
    {
        super(name);
    } Update()
    {
        console.log("Update player")
    }
};

class CustomClient extends cl.Client{
    constructor(cid, sigSend)
    {
        super(cid, sigSend);
        // sign2_uid = this.scene.GetNodeUidByName("sign2");
    } PostSceneInit()
    {
        // Nothing to do: the streaming pass derives what this client should see
        // from the scene and the client-node registry on every tick, including
        // the first. Streaming everything by hand here would only fight it.
    } Update()
    {
        console.log("Update player")
    } ProcessNodePoses(headPose, numPoses, nodePoses)
    {
        super.ProcessNodePoses(headPose, numPoses, nodePoses);
        // console.log("CustomClient: ProcessNodePoses ", numPoses, " poses.");
        if (!sign2_uid)
        {
            sign2_uid = this.scene.GetNodeUidByName("sign2");
        }
        if (sign2_uid)
        {
            const d    = headPose.position;
            const dist = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
            if (dist > 3.0)
            {
                // unstream sign2
                this.geometryService.UnstreamNode(sign2_uid);
            }
            if (dist < 2.0)
            {
                // stream sign2
                this.geometryService.StreamNode(sign2_uid);
            }
        }
    }
};

module.exports = {
    CustomPlayerNode,
    CustomClient
};
