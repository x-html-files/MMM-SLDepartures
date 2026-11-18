const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createServer } = require("../preview/server");

test("preview serves the real module and processes the offline fixture through the helper", async (t) => {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const base = `http://127.0.0.1:${server.address().port}`;
	const moduleResponse = await fetch(`${base}/MMM-SLDepartures.js`);
	assert.equal(moduleResponse.status, 200);
	assert.match(await moduleResponse.text(), /Module\.register\("MMM-SLDepartures"/);

	const config = {
		siteId: 9001,
		directionCode: 2,
		transportModes: ["TRAIN"],
		lines: [],
		maxDepartures: 6,
		showCancelled: true,
		showDeviations: true,
		minDeviationImportance: 3
	};
	const response = await fetch(`${base}/api/departures?fixture=1`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(config)
	});
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(result.notification, "SLDEP_DATA");
	assert.equal(result.payload.identifier, "preview");
	assert.ok(result.payload.departures.length > 0);
	assert.ok(result.payload.departures.length <= 6);
	assert.ok(result.payload.departures.every((departure) => /^\d\d:\d\d$/.test(departure.time)));
	assert.ok(result.payload.departures.every((departure) => Number.isFinite(departure.timestamp)));

	const invalid = await fetch(`${base}/api/departures`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ siteId: "../other" })
	});
	assert.equal(invalid.status, 400);
	assert.equal((await fetch(`${base}/node_helper.js`)).status, 404);
});

test("simulated disruptions render delayed and cancelled departures without fetching", () => {
	function element () {
		const node = {
			className: "",
			textContent: "",
			children: [],
			appendChild (child) { this.children.push(child); },
			replaceChildren () { this.children = []; }
		};
		node.classList = { add: (name) => { node.className += ` ${name}`; } };
		return node;
	}
	const mode = element();
	const container = element();
	let now = Date.parse("2026-07-15T10:00:00Z");
	let timer;
	class FakeDate extends Date {
		static now () { return now; }
	}
	const context = vm.createContext({
		console,
		Date: FakeDate,
		URLSearchParams,
		location: { search: "?demo=1" },
		document: {
			getElementById: (id) => id === "mode" ? mode : container,
			createElement: element
		},
		fetch: () => { throw new Error("Demo must not fetch"); },
		setInterval: (callback) => { timer = callback; }
	});
	for (const file of ["preview/preview.js", "MMM-SLDepartures.js"]) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
	}
	assert.match(mode.textContent, /simulated/);
	let rows = container.children[0].children[0].children;
	assert.equal(rows.length, 5);
	assert.equal(rows[0].children[3].textContent, "10 min");
	assert.match(rows[1].children[2].className, /SLDEP-delayed/);
	assert.equal(rows[1].children[3].textContent, "5 min");
	assert.match(rows[2].className, /SLDEP-cancelled/);
	assert.equal(rows[2].children[2].textContent, "—");
	assert.equal(rows[2].children[3].textContent, "");
	assert.equal(rows[3].children[3].textContent, "NOW");
	assert.equal(rows[4].children[3].textContent, "");
	now += 56000;
	timer();
	rows = container.children[0].children[0].children;
	assert.equal(rows[3].children[3].textContent, "", "passed departures do not stay NOW");
});

test("remaining-time boundaries and cancellation", () => {
	let definition;
	const context = vm.createContext({ Module: { register: (_name, module) => { definition = module; } } });
	vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "MMM-SLDepartures.js"), "utf8"), context);
	const remaining = (milliseconds, cancelled = false) => definition.remainingTime({ timestamp: milliseconds, cancelled }, 0);
	assert.equal(remaining(-1), "");
	assert.equal(remaining(0), "NOW");
	assert.equal(remaining(59999), "NOW");
	assert.equal(remaining(60000), "1 min");
	assert.equal(remaining(3599999), "59 min");
	assert.equal(remaining(3600000), "");
	assert.equal(remaining(60000, true), "");
	assert.equal(remaining(null), "");
});