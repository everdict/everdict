// Subpath barrel (review §28): `@everdict/application-control/notification` — namespace clarity without
// package fragmentation (the /wire precedent). The root barrel keeps exporting everything; imports
// through this subpath additionally SAY which subdomain they collaborate with.
export * from "./feed-consumers.js";
export * from "./mattermost-consumer.js";
export * from "./notification-service.js";
export * from "./tracker-update-consumer.js";
