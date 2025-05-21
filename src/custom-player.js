
const sc = require('teleportxr/scene/scene');
const nd = require('teleportxr/scene/node');
const cl = require('teleportxr/client/client');

var sign2_uid = 0n;

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
		//sign2_uid = this.scene.GetNodeUidByName("sign2");
	}
	PostSceneInit()
	{
		var node_uids=this.scene.GetAllNodeUids();
		for (let uid of node_uids)
		{
			this.geometryService.StreamNode(uid);
		}
	}
	Update()
	{
		console.log("Update player")
	}
	ProcessNodePoses(headPose,numPoses,nodePoses)
	{
		super.ProcessNodePoses(headPose,numPoses,nodePoses);
		//console.log("CustomClient: ProcessNodePoses ", numPoses, " poses.");
		if(!sign2_uid)
		{			
			sign2_uid = this.scene.GetNodeUidByName("sign2");
		}
		if(sign2_uid)
		{
			const d=headPose.position;
			const dist=Math.sqrt(d.x*d.x+d.y*d.y+d.z*d.z);
			if(dist>3.0)
			{
				// unstream sign2
				this.geometryService.UnstreamNode(sign2_uid);
			}
			if(dist<2.0)
			{
				// stream sign2
				this.geometryService.StreamNode(sign2_uid);
			}
		}
	}
};

module.exports = {CustomPlayerNode,CustomClient};
