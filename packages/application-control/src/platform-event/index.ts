// Subpath barrel (review §28): `@everdict/application-control/platform-event` — namespace clarity without
// package fragmentation (the /wire precedent). The root barrel keeps exporting everything; imports
// through this subpath additionally SAY which subdomain they collaborate with.
export * from "./event-consumer-runner.js";
export * from "./fact-projection.js";
export * from "./outbox.js";
export * from "./platform-event-service.js";
export * from "./registry-facts.js";
export * from "./subscription-reaction-consumer.js";
