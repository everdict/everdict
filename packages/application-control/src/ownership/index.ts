// Subpath barrel (review §28): `@everdict/application-control/ownership` — namespace clarity without
// package fragmentation (the /wire precedent). The root barrel keeps exporting everything; imports
// through this subpath additionally SAY which subdomain they collaborate with.
export * from "./checkpoint-service.js";
