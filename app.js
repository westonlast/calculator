const http = require("http");
const static = require("node-static");
const atomize = require('atomize-server');

var staticServer = new static.Server();
const httpServer = http.createServer((req, res) => {
	if(req.url.substring(1) !== "atomize"){
		staticServer.serve(req, res);
	}
});
atomize.create(httpServer, '[/]atomize');
console.log(" [*] Listening on 0.0.0.0:" + 9999);
httpServer.listen(9999, '0.0.0.0');

