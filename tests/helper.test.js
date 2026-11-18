const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "node_helper.js"), "utf8");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture-tcentralen.json"), "utf8"));
const config = {
	siteId: 9001,
	directionCode: 2,
	transportModes: ["TRAIN"],
	lines: [],
	maxDepartures: 6,
	showCancelled: true,
	showDeviations: true,
	minDeviationImportance: 3,
	updateInterval: 1000
};

function deferred () {
	let resolve;
	let reject;
	const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
	return { promise, resolve, reject };
}

function success (destination) {
	const body = JSON.parse(JSON.stringify(fixture));
	if (destination) {
		for (const departure of body.departures) departure.destination = destination;
	}
	return { ok: true, status: 200, json: async () => body };
}

function limited (value) {
	return { ok: false, status: 429, statusText: "Too Many Requests", headers: { get: () => value } };
}

async function flush () {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

function harness () {
	let now = Date.parse("2026-11-18T12:00:00Z");
	let nextTimer = 1;
	const timers = new Map();
	const calls = [];
	const notifications = [];
	const responses = [];
	class FakeDate extends Date {
		static now () { return now; }
	}
	const context = vm.createContext({
		module: { exports: {} },
		require (name) {
			if (name === "node_helper") return { create: (definition) => definition };
			if (name === "logger") return { error () {} };
			if (name === "./lib/departures") return require("../lib/departures");
			throw new Error(`Unexpected require: ${name}`);
		},
		fetch (url, options) {
			calls.push({ url, options, at: now });
			const response = responses.shift();
			return response ? response.promise : Promise.resolve(success());
		},
		Date: FakeDate,
		AbortController,
		setTimeout (callback, delay) {
			const id = nextTimer++;
			timers.set(id, { callback, at: now + delay });
			return id;
		},
		clearTimeout: (id) => timers.delete(id)
	});
	vm.runInContext(source, context, { filename: "node_helper.js" });
	const helper = context.module.exports;
	helper.sendSocketNotification = (name, payload) => notifications.push({ name, payload });
	return {
		helper, calls, notifications, responses, timers,
		now: () => now,
		register (identifier, settings = config) {
			helper.socketNotificationReceived("SLDEP_CONFIG", { identifier, config: settings });
		},
		async advance (ms) {
			const end = now + ms;
			await flush();
			while (true) {
				const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > end) break;
				now = next[1].at;
				timers.delete(next[0]);
				next[1].callback();
				await flush();
			}
			now = end;
			await flush();
		}
	};
}

test("429 seconds sets a shared cooldown across registrations, polling, and concurrent successes", async () => {
	const h = harness();
	h.helper.start();
	const rateLimit = deferred();
	const other = deferred();
	h.responses.push(rateLimit, other);
	h.register("one");
	h.register("two");
	assert.equal(h.calls.length, 2);
	rateLimit.resolve(limited("30"));
	await flush();
	other.resolve(success());
	await flush();
	assert.equal(h.notifications.find((n) => n.payload.identifier === "one").name, "SLDEP_ERROR");
	assert.equal(h.helper.retryAt, h.now() + 30000);
	h.register("three");
	h.register("one");
	await h.helper.fetchDepartures({ identifier: "two", config });
	await h.advance(29999);
	assert.equal(h.calls.length, 2, "no instance may retry before the shared deadline");
	await h.advance(1);
	assert.equal(h.calls.length, 5, "all three registered instances resume at the deadline");
	assert.ok(h.calls.slice(2).every((call) => call.at >= h.helper.retryAt));
	h.helper.stop();
});

test("HTTP-date Retry-After is respected and missing or invalid values back off", async () => {
	for (const value of ["Wed, 18 Nov 2026 12:01:05 GMT", null, "invalid", "3.5"]) {
		const h = harness();
		const response = deferred();
		h.responses.push(response);
		h.register("one");
		response.resolve(limited(value));
		await flush();
		const delay = value === "Wed, 18 Nov 2026 12:01:05 GMT" ? 65000 : 60000;
		assert.equal(h.helper.retryAt, h.now() + delay);
		await h.advance(delay - 1);
		assert.equal(h.calls.length, 1);
		await h.advance(1);
		assert.equal(h.calls.length, 2);
		h.helper.stop();
	}
});

test("a cooldown extends already scheduled polls and cannot be shortened by another 429", async () => {
	const h = harness();
	const a = deferred();
	const b = deferred();
	const c = deferred();
	h.responses.push(a, b, c);
	h.register("one");
	h.register("two");
	h.register("three");
	a.resolve(success());
	await flush(); // one has a timer due at 1 second
	b.resolve(limited("30"));
	await flush();
	c.resolve(limited("5"));
	await flush();
	assert.equal(h.helper.retryAt, h.now() + 30000);
	await h.advance(29999);
	assert.equal(h.calls.length, 3);
	await h.advance(1);
	assert.equal(h.calls.length, 6);
	h.helper.stop();
});

test("very long retry delays are not shortened by timer overflow", async () => {
	const h = harness();
	const response = deferred();
	h.responses.push(response);
	h.register("one");
	response.resolve(limited("9999999999999999999999999"));
	await flush();
	assert.equal(h.helper.retryAt, Number.MAX_SAFE_INTEGER);
	await h.advance(2147483647);
	assert.equal(h.calls.length, 1);
	h.helper.stop();
});

test("failure and reload expose config-scoped stale cache; success replaces it", async () => {
	const h = harness();
	const first = deferred();
	h.responses.push(first);
	h.register("one");
	first.resolve(success("First"));
	await flush();
	const original = h.notifications.at(-1).payload.departures;
	assert.ok(original.length > 0);
	assert.equal(original[0].destination, "First");
	const failure = deferred();
	h.responses.push(failure);
	await h.advance(1000);
	failure.reject(new Error("network down"));
	await flush();
	let error = h.notifications.at(-1);
	assert.equal(error.name, "SLDEP_ERROR");
	assert.equal(error.payload.error, "network down");
	assert.equal(error.payload.stale, true);
	assert.equal(error.payload.departures[0].destination, "First");
	assert.equal(error.payload.cachedAt, h.now() - 1000);
	const replacement = deferred();
	h.responses.push(replacement);
	// An equivalent config with reordered keys still recovers the cached data.
	h.register("one", { updateInterval: 1000, ...config });
	error = h.notifications.at(-1);
	assert.equal(error.name, "SLDEP_ERROR");
	assert.equal(error.payload.departures[0].destination, "First");
	replacement.resolve(success("Second"));
	await flush();
	assert.equal(h.notifications.at(-1).name, "SLDEP_DATA");
	assert.equal(h.notifications.at(-1).payload.departures[0].destination, "Second");
	const limitedResponse = deferred();
	h.responses.push(limitedResponse);
	await h.advance(1000);
	limitedResponse.resolve(limited("20"));
	await flush();
	assert.equal(h.notifications.at(-1).payload.departures[0].destination, "Second");
	h.register("one");
	assert.equal(h.notifications.at(-1).payload.departures[0].destination, "Second");
	assert.equal(h.notifications.at(-1).payload.retryAt, h.now() + 20000);
	const changed = { ...config, siteId: 9002 };
	h.register("one", changed);
	assert.equal(h.notifications.at(-1).name, "SLDEP_ERROR");
	assert.equal(h.notifications.at(-1).payload.departures, undefined, "different configs never inherit stale departures");
	h.register("one", config);
	assert.equal(h.notifications.at(-1).payload.departures[0].destination, "Second", "returning to a config restores its cache");
	h.register("other", config);
	assert.equal(h.notifications.at(-1).payload.departures, undefined, "another identifier has a separate cache");
	h.helper.stop();
});

test("an unresolved response body remains in flight across reloads", async () => {
	const h = harness();
	const body = deferred();
	const response = deferred();
	h.responses.push(response);
	h.register("one");
	response.resolve({ ok: true, status: 200, json: () => body.promise });
	await flush();
	h.register("one");
	assert.equal(h.calls.length, 1);
	body.resolve(fixture);
	await flush();
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0].name, "SLDEP_DATA");
	h.helper.stop();
});

test("a timed-out fetch is aborted, reported, and polling resumes", async () => {
	const h = harness();
	const pending = deferred();
	h.responses.push(pending);
	h.register("one");
	const signal = h.calls[0].options.signal;
	signal.addEventListener("abort", () => pending.reject(new Error("request aborted")));
	await h.advance(14999);
	assert.equal(signal.aborted, false);
	assert.equal(h.calls.length, 1);
	await h.advance(1);
	assert.equal(signal.aborted, true);
	assert.equal(h.notifications.at(-1).name, "SLDEP_ERROR");
	assert.match(h.notifications.at(-1).payload.error, /aborted/);
	await h.advance(1000);
	assert.equal(h.calls.length, 2);
	assert.equal(h.notifications.at(-1).name, "SLDEP_DATA");
	h.helper.stop();
});

test("requests are serialized and superseded responses never update data or cache", async () => {
	const h = harness();
	const a = deferred();
	const b = deferred();
	const c = deferred();
	h.responses.push(a, b, c);
	h.register("one");
	h.register("one");
	const changed = { ...config, siteId: 9002, forecast: 120 };
	h.register("one", changed);
	assert.equal(h.calls.length, 1, "reload and config changes do not overlap an in-flight request");
	a.resolve(success("Obsolete A"));
	await flush();
	assert.equal(h.calls.length, 2);
	assert.match(h.calls[1].url, /sites\/9002\/departures\?forecast=120$/);
	assert.equal(h.notifications.length, 0, "obsolete A must not notify");
	h.register("one", config);
	assert.equal(h.calls.length, 2);
	b.resolve(success("Obsolete B"));
	await flush();
	assert.equal(h.calls.length, 3);
	assert.equal(h.notifications.length, 0, "obsolete B must not notify");
	c.resolve(success("Current A"));
	await flush();
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0].payload.departures[0].destination, "Current A");
	await h.advance(1000);
	assert.equal(h.calls.length, 4, "only the newest registration retains a polling timer");
	h.helper.stop();
});

test("an obsolete 429 still delays the queued new config and other instances", async () => {
	const h = harness();
	const first = deferred();
	h.responses.push(first);
	h.register("one");
	h.register("one", { ...config, siteId: 9002 });
	first.resolve(limited("10"));
	await flush();
	assert.equal(h.calls.length, 1);
	assert.equal(h.notifications.at(-1).payload.identifier, "one");
	assert.match(h.notifications.at(-1).payload.error, /429/);
	h.register("two");
	await h.advance(9999);
	assert.equal(h.calls.length, 1);
	await h.advance(1);
	assert.equal(h.calls.length, 3);
	h.helper.stop();
});

test("direct fetching works without start and stop suppresses late responses", async () => {
	const h = harness();
	const pending = deferred();
	h.responses.push(pending);
	const request = h.helper.fetchDepartures({ identifier: "preview", config });
	const duplicate = h.helper.fetchDepartures({ identifier: "preview", config });
	assert.equal(h.calls.length, 1);
	pending.resolve(success());
	await Promise.all([request, duplicate]);
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0].name, "SLDEP_DATA");
	const late = deferred();
	h.responses.push(late);
	h.register("preview");
	await flush();
	const count = h.notifications.length;
	h.helper.stop();
	assert.equal(h.calls.at(-1).options.signal.aborted, true);
	late.resolve(success());
	await flush();
	assert.equal(h.notifications.length, count);
	assert.equal(h.timers.size, 0);
});