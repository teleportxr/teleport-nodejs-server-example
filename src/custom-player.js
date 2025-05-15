
const sc = require('teleportxr/scene/scene');
const nd = require('teleportxr/scene/node');
const cl = require('teleportxr/client/client');

class CustomPlayerNode extends nd.Node {
	constructor( name = "") {
		super(name);
	}
	Update()
	{
		console.log("Update player")
	}
};

class CustomClient extends cl.Client {
	constructor(cid, sigSend) {
		super(cid, sigSend);
		sign2_uid = this.scene.GetNodeUidByName("sign2");
	}
	Update()
	{
		console.log("Update player")
	}
	ProcessNodePoses(headPose,numPoses,nodePoses)
	{
		super.ProcessNodePoses(headPose,numPoses,nodePoses);
		console.log("CustomClient: ProcessNodePoses ", numPoses, " poses.");
		if(headPose.position.x<-2.0)
		{
			// unstream sign2
			this.geometryService.UnstreamNode(sign2_uid);
		}
		if(headPose.position.x>0.0)
		{
			// stream sign2
			this.geometryService.StreamNode(sign2_uid);
		}
		sign2
	}
};

module.exports = {CustomPlayerNode,CustomClient};
