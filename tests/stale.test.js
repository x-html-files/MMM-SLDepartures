const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup () {
	let now = 1000000;
	let tick;
	let definition;
	let sends = 0;
	let renders = 0;
	class FakeDate extends Date {
		static now () { return now; }
	}
	function element () {
		const node = { className: "", textContent: "", children: [], appendChild (child) { this.children.push(child); } };
		node.classList = { add: (name) => { node.className += ` ${name}`; } };
		return node;
	}
	const context = vm.createContext({
		Date: FakeDate,
		Module: { register: (_name, value) => { definition = value; } },
		Log: { error: () => {} },
		document: { createElement: element },
		setInterval: (callback, interval) => { assert.equal(interval, 1000); tick = callback; return 1; },
		clearInterval: () => {}
	});
	vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "MMM-SLDepartures.js"), "utf8"), context);
	const instance = {
		...definition,
		identifier: "one",
		config: definition.defaults,
		sendSocketNotification: () => { sends++; },
		updateDom: () => { renders++; }
	};
	instance.start();
	return { instance, tick: () => tick(), advance: (ms) => { now += ms; }, sends: () => sends, renders: () => renders };
}

function departure (timestamp, destination = "Märsta") {
	return { timestamp, destination, line: "41", time: "12:00", delayed: false, cancelled: false, deviations: [] };
}

test("error without successful data shows a dash", () => {
	const { instance } = setup();
	instance.socketNotificationReceived("SLDEP_ERROR", { identifier: "one", error: "HTTP 429" });
	assert.equal(instance.getDom().textContent, "—");
});

test("cached data is visibly stale, updates locally, expires, and recovers", () => {
	const app = setup();
	const { instance } = app;
	instance.socketNotificationReceived("SLDEP_DATA", { identifier: "one", departures: [departure(1061000)] });
	instance.socketNotificationReceived("SLDEP_ERROR", { identifier: "one", error: "HTTP 429" });
	let dom = instance.getDom();
	assert.match(dom.children[0].textContent, /outdated/);
	assert.equal(dom.children[1].children[0].children[3].textContent, "1 min");
	const renders = app.renders();
	app.advance(2000);
	app.tick();
	dom = instance.getDom();
	assert.equal(dom.children[1].children[0].children[3].textContent, "NOW");
	assert.ok(app.renders() > renders);
	assert.equal(app.sends(), 1, "countdown does not request the API");
	app.advance(60000);
	app.tick();
	dom = instance.getDom();
	assert.match(dom.children[0].textContent, /outdated/);
	assert.equal(dom.children[1].textContent, "—");
	instance.socketNotificationReceived("SLDEP_DATA", { identifier: "one", departures: [departure(2000000, "Bålsta")] });
	dom = instance.getDom();
	assert.equal(dom.children[0].className, "SLDEP-table");
	assert.equal(dom.children[0].children[0].children[1].textContent, "Bålsta");
});

test("helper cache restores after reload and unparseable cached times are hidden", () => {
	const { instance } = setup();
	instance.socketNotificationReceived("SLDEP_ERROR", {
		identifier: "one", error: "HTTP 429", departures: [departure(null), departure(1100000)]
	});
	const dom = instance.getDom();
	assert.match(dom.children[0].textContent, /outdated/);
	assert.equal(dom.children[1].children.length, 1);
});