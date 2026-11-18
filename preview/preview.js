/* Change these overrides to match your MagicMirror configuration. */
const previewConfig = {
	// siteId: 9001,
	// directionCode: 2,
	// transportModes: ["TRAIN"],
	// header: "Departures"
};

const params = new URLSearchParams(globalThis.location.search);
const demoMode = params.get("demo") === "1";
const fixtureMode = params.get("fixture") === "1";
document.getElementById("mode").textContent = demoMode
	? "(simulated: normal, delayed, cancelled, now, over an hour; not real departures)"
	: fixtureMode ? "(captured data; times are not current)" : "(live SL data)";

// Already formatted like a helper response so these examples always render,
// regardless of site and filters. Edit them to try different display states.
const sampleClock = new Intl.DateTimeFormat("sv-SE", {
	timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
const sampleNow = Date.now();
const sampleDepartures = [
	{ line: "41", destination: "Märsta", timestamp: sampleNow + 630000, delayed: false, cancelled: false, deviations: [] },
	{ line: "43", destination: "Bålsta", timestamp: sampleNow + 330000, delayed: true, cancelled: false, deviations: ["Delayed by 6 minutes"] },
	{ line: "40", destination: "Uppsala C", timestamp: sampleNow + 900000, delayed: false, cancelled: true, deviations: ["Departure cancelled"] },
	{ line: "41", destination: "Södertälje", timestamp: sampleNow + 55000, delayed: false, cancelled: false, deviations: [] },
	{ line: "43", destination: "Kungsängen", timestamp: sampleNow + 3900000, delayed: false, cancelled: false, deviations: [] }
].map((departure) => ({ ...departure, time: sampleClock.format(departure.timestamp) }));

// Implement only the MagicMirror APIs this module uses. Its actual getDom(),
// defaults and socket notification handler are loaded unchanged below.
globalThis.Log = console;
globalThis.Module = {
	register (_name, definition) {
		const instance = {
			...definition,
			identifier: "preview",
			config: { ...definition.defaults, ...previewConfig },
			updateDom () {
				const container = document.getElementById("module");
				container.replaceChildren();
				const header = this.getHeader();
				if (header) {
					const element = document.createElement("div");
					element.className = "module-header";
					element.textContent = header;
					container.appendChild(element);
				}
				container.appendChild(this.getDom());
			},
			sendSocketNotification (_notification, payload) {
				if (demoMode) {
					this.socketNotificationReceived("SLDEP_DATA", {
						identifier: this.identifier,
						departures: sampleDepartures.map((departure) => ({
							...departure,
							deviations: payload.config.showDeviations ? departure.deviations : []
						}))
					});
					return;
				}
				const refresh = async () => {
					try {
						const response = await fetch(`/api/departures${fixtureMode ? "?fixture=1" : ""}`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(payload.config)
						});
						if (!response.ok) throw new Error(`Preview server: HTTP ${response.status}`);
						const result = await response.json();
						this.socketNotificationReceived(result.notification, result.payload);
					} catch (error) {
						this.socketNotificationReceived("SLDEP_ERROR", { identifier: this.identifier, error: error.message });
					}
				};
				refresh();
				setInterval(refresh, payload.config.updateInterval);
			}
		};
		instance.start();
		instance.updateDom();
	}
};