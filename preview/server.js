/* Local-only MagicMirror adapter. The real helper still owns fetching and
 * formatting; only its MagicMirror dependencies and socket are replaced. */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "..");
const helperPath = path.join(root, "node_helper.js");
const helperRequire = createRequire(helperPath);
const helperFactory = vm.runInThisContext(
	`(function (require, module, exports, fetch) {\n${fs.readFileSync(helperPath, "utf8")}\n})`,
	{ filename: helperPath }
);
const fixture = fs.readFileSync(path.join(root, "tests", "fixture-tcentralen.json"), "utf8");
const files = {
	"/": ["preview/index.html", "text/html; charset=utf-8"],
	"/preview.js": ["preview/preview.js", "text/javascript; charset=utf-8"],
	"/MMM-SLDepartures.js": ["MMM-SLDepartures.js", "text/javascript; charset=utf-8"],
	"/MMM-SLDepartures.css": ["MMM-SLDepartures.css", "text/css; charset=utf-8"]
};

function createHelper (send, useFixture) {
	const helperModule = { exports: {} };
	const localRequire = (name) => {
		if (name === "node_helper") return { create: (helper) => helper };
		if (name === "logger") return console;
		return helperRequire(name);
	};
	const previewFetch = useFixture
		? async () => ({ ok: true, json: async () => JSON.parse(fixture) })
		: fetch;
	helperFactory(localRequire, helperModule, helperModule.exports, previewFetch);
	helperModule.exports.sendSocketNotification = send;
	return helperModule.exports;
}

function createServer () {
	return http.createServer((req, res) => {
		const url = new URL(req.url, "http://localhost");
		if (req.method === "GET" && files[url.pathname]) {
			const [file, type] = files[url.pathname];
			res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
			fs.createReadStream(path.join(root, file)).pipe(res);
			return;
		}

		if (req.method !== "POST" || url.pathname !== "/api/departures") {
			res.writeHead(404).end();
			return;
		}

		// Only accept JSON; do not allow arbitrary websites to submit form requests.
		if (req.headers["content-type"] !== "application/json") {
			res.writeHead(415).end();
			return;
		}
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > 16384) req.destroy();
		});
		req.on("end", () => {
			let config;
			try {
				config = JSON.parse(body);
				if (!config || !Number.isSafeInteger(config.siteId) || config.siteId < 1) throw new Error("Invalid siteId");
			} catch {
				res.writeHead(400).end("Invalid configuration");
				return;
			}
			const helper = createHelper((notification, payload) => {
				res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				res.end(JSON.stringify({ notification, payload }));
			}, url.searchParams.get("fixture") === "1");
			helper.fetchDepartures({ identifier: "preview", config });
		});
	});
}

if (require.main === module) {
	const port = Number(process.env.PORT || 8080);
	createServer().listen(port, "127.0.0.1", () => {
		console.log(`Preview: http://127.0.0.1:${port}/`);
		console.log(`Offline fixture: http://127.0.0.1:${port}/?fixture=1`);
	});
}

module.exports = { createServer };