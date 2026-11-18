/* MMM-SLDepartures — server side.
 *
 * The fetch lives here rather than in the browser for two reasons: the SL
 * Transport API sends no CORS headers, and doing it once on the server means
 * one request per interval no matter how many clients are attached.
 */

const NodeHelper = require("node_helper");
const Log = require("logger");
const { filterDepartures, formatTime, departureTimestamp, isDelayed, isCancelled, deviationMessages } = require("./lib/departures");

const API_BASE = "https://transport.integration.sl.se/v1";
const DEFAULT_RETRY_MS = 60000;
const MAX_TIMEOUT_MS = 2147483647;

// Socket payloads are JSON. Sort keys so a reload with equivalent configuration
// does not miss the cache merely because object properties arrived in a new order.
function configKey (value) {
	if (Array.isArray(value)) return `[${value.map(configKey).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${configKey(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function retryDeadline (response) {
	const value = response.headers?.get?.("retry-after")?.trim();
	const now = Date.now();
	if (value && /^\d+$/.test(value)) {
		const delay = Number(value) * 1000;
		return Math.min(Number.MAX_SAFE_INTEGER, now + delay);
	} else if (value && /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)(?:,| )/i.test(value)) {
		const date = Date.parse(value);
		if (Number.isFinite(date)) return Math.max(now, date);
	}
	return now + DEFAULT_RETRY_MS;
}

module.exports = NodeHelper.create({
	start () {
		this.instances = new Map();
		this.retryAt = 0;
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "SLDEP_CONFIG") {
			const registered = { identifier: payload.identifier, config: JSON.parse(JSON.stringify(payload.config)) };
			const state = this.getInstance(registered);
			if (state.timer) clearTimeout(state.timer);
			const registration = ++state.registration;
			const cached = state.cache.get(state.key);
			if (cached && (state.inFlight || Date.now() >= this.retryAt)) {
				this.notifyError(registered.identifier, state, state.lastError || "Refreshing departures");
			}
			this.poll(registered, state, registration);
		}
	},

	getInstance (payload) {
		// The preview invokes fetchDepartures directly without calling start().
		if (!this.instances) this.instances = new Map();
		if (!Number.isFinite(this.retryAt)) this.retryAt = 0;
		let state = this.instances.get(payload.identifier);
		if (!state) {
			state = { cache: new Map(), key: null, version: 0, registration: 0, timer: null, inFlight: null, lastError: null };
			this.instances.set(payload.identifier, state);
		}
		const key = configKey(payload.config);
		if (key !== state.key) {
			state.key = key;
			state.version++;
			state.lastError = null;
		}
		return state;
	},

	notifyError (identifier, state, message) {
		const cached = state.cache.get(state.key);
		const payload = { identifier, error: message };
		if (cached) Object.assign(payload, { departures: cached.departures, cachedAt: cached.cachedAt, stale: true });
		if (this.retryAt > Date.now()) payload.retryAt = this.retryAt;
		this.sendSocketNotification("SLDEP_ERROR", payload);
	},

	async poll (payload, state, registration) {
		await this.fetchDepartures(payload);
		if (this.instances?.get(payload.identifier) !== state || state.registration !== registration) return;
		const interval = Number(payload.config.updateInterval);
		const delay = Math.max(Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_RETRY_MS, this.retryAt - Date.now());
		const schedule = () => {
			if (this.instances?.get(payload.identifier) !== state || state.registration !== registration) return;
			const remaining = Math.max(0, deadline - Date.now(), this.retryAt - Date.now());
			if (remaining > 0) state.timer = setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT_MS));
			else this.poll(payload, state, registration);
		};
		const deadline = Date.now() + delay;
		state.timer = setTimeout(schedule, Math.min(delay, MAX_TIMEOUT_MS));
	},

	async fetchDepartures (payload) {
		const { identifier } = payload;
		// Snapshot the config used by this request and cache key.
		const config = JSON.parse(JSON.stringify(payload.config));
		const state = this.getInstance({ identifier, config });
		const version = state.version;
		if (state.inFlight) {
			const sameConfig = state.inFlight.version === version;
			await state.inFlight.promise;
			if (!sameConfig && this.instances?.get(identifier) === state && state.version === version) {
				return this.fetchDepartures({ identifier, config });
			}
			return;
		}
		if (Date.now() < this.retryAt) {
			state.lastError = "HTTP 429: retry later";
			this.notifyError(identifier, state, state.lastError);
			return;
		}

		const request = this.requestDepartures(identifier, config, state, version);
		state.inFlight = { version, promise: request };
		try {
			await request;
		} finally {
			if (state.inFlight?.promise === request) state.inFlight = null;
		}
	},

	async requestDepartures (identifier, config, state, version) {
		/* forecast = how many minutes ahead SL should look. The API defaults to 60,
		 * which off-peak returns fewer departures than maxDepartures asks for, so
		 * the list renders short. Omit the parameter when unset to preserve the
		 * previous behaviour exactly. */
		const forecast = Number(config.forecast);
		const query = Number.isFinite(forecast) && forecast > 0 ? `?forecast=${forecast}` : "";
		const url = `${API_BASE}/sites/${config.siteId}/departures${query}`;

		try {
			// Bound the wait so a hanging request cannot stall the refresh cycle.
			const ac = new AbortController();
			state.controller = ac;
			const timeout = setTimeout(() => ac.abort(), 15000);
			try {
				const res = await fetch(url, { signal: ac.signal, headers: { Accept: "application/json" } });
				if (res.status === 429) this.retryAt = Math.max(this.retryAt, retryDeadline(res));
				if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());

				const body = await res.json();
				const departures = filterDepartures(body, config).map((d) => ({
					time: formatTime(d),
					timestamp: departureTimestamp(d),
					line: d.line?.designation ?? "",
					destination: d.destination ?? "",
					delayed: isDelayed(d),
					cancelled: isCancelled(d),
					scheduled: formatTime({ expected: null, scheduled: d.scheduled }),
					deviations: config.showDeviations ? deviationMessages(d, config.minDeviationImportance) : []
				}));

				if (this.instances?.get(identifier) !== state || state.version !== version) return;
				state.cache.set(state.key, { departures, cachedAt: Date.now() });
				state.lastError = null;
				this.sendSocketNotification("SLDEP_DATA", { identifier, departures });
			} finally {
				clearTimeout(timeout);
				if (state.controller === ac) state.controller = null;
			}
		} catch (error) {
			if (this.instances?.get(identifier) !== state || state.version !== version) return;
			Log.error(`[MMM-SLDepartures] fetch failed for site ${config.siteId}: ${error.message}`);
			state.lastError = error.message;
			this.notifyError(identifier, state, error.message);
		}
	},

	stop () {
		for (const state of this.instances?.values() || []) {
			if (state.timer) clearTimeout(state.timer);
			state.controller?.abort();
		}
		this.instances = new Map();
	}
});
