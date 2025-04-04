const teleport_server	= require('teleport-server')
const client_manager	= require('teleport-server/client/client_manager');
const scene				= require("teleport-server/scene/scene");

// Create a scene, so we can fill it with stuff.
var sc					= new scene.Scene();

// Load our scene.json into the scene.
const path				= require('path');
const assetsPath		= path.join(__dirname,'assets');
sc.Load(path.join(assetsPath,'scene.json'));

// The client manager allows us to set callbacks for when client events happen:
var cm					= client_manager.getInstance();

// This is our app's callback for when a new client is to be created.
// It must return the origin uid for the client.
function createNewClient(clientID) {
	var origin_uid		=sc.CreateNode("Player");
	return origin_uid;
}
cm.SetNewClientCallback(createNewClient);

// This will be called AFTER a client has been created, so we can access it from the clientManager.
function onClientPostCreate(clientID) {
	var client			=cm.GetClient(clientID);
	client.SetScene(sc);
}
cm.SetClientPostCreationCallback(onClientPostCreate);

// Having set up the callbacks, we start the server running.
teleport_server.initServer();

// Create a simple http server for scene management:
var http = require('http');
http.createServer(function (req, res) {
  res.writeHead(200, {'Content-Type': 'text/html'});
  res.write("<div>");
  	res.write(sc.writeState());
  res.write("</div>");
  res.write("<div>");
  	res.write(cm.writeState());
  res.write("</div>");
  res.end();
}).listen(9000); 