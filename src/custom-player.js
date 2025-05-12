
const nd = require('teleportxr/scene/node');

class CustomPlayer extends nd.Node {
	constructor( name = "") {
		super(name);
	}
	Update()
	{
		console.log("Update player")
	}
};

module.exports = {CustomPlayer};
