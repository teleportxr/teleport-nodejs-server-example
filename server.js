const teleport_server	= require('teleportxr')
const client_manager	= require('teleportxr/client/client_manager');
const scene				= require("teleportxr/scene/scene");
const resources			= require("teleportxr/scene/resources");
const open = require('open');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const WebSocketServer = require("ws");

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

const wss=teleport_server.initServer();
const dashboard_port = process.env.PORT || 9000;

// Create a simple http server for scene management and display.
// This will be accessible at localhost:9000 via a browser.
// The dashboard uses the writeState functions of the teleport server classes
// to send html summaries of their state to the dashboard.
const express_app = express();
express_app.use(express.static('dashboard_public'));
// Also serve any static 3D resources when requested.
express_app.use(express.static('http_resources'));
// Don't pass express_app to createServer - that would cause it to initalize before websockets is connected
const http_server = express_app.listen(dashboard_port);
// Also mount the app here
http_server.on('upgrade', function upgrade(request, socket, head) {
	const { pathname } = new URL(request.url, 'wss://base.url');
	 wss.handleUpgrade(request, socket, head, function done(ws) {
		wss.emit('connection', ws, request);
  });
});

resources.Resource.SetDefaultPathRoot("http://localhost:9000")

express_app.use(express.static('dashboard_public'));
/*
express_io.on('connection', (socket) => {
	console.log('A dashboard client connected');
	setInterval(() => {
	  socket.emit('scene', sc.writeState());
	  socket.emit('client_manager', cm.writeState());
	}, 1000);
});*/
  

// opens the url in the default browser if running locally (port 9000)
if(dashboard_port==9000)
	open('http://localhost:9000');

// Create a second http server, the Content Server. This is to 
// Create a simple http server for scene management:
////const fileserver = require('./file-server.js');
//fileserver.startStaticFileServer("http_resources");
