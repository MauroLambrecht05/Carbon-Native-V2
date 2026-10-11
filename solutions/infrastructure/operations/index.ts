// @carbon/operations — what a running service tells its operators.
//
//   redaction   what may never appear in a log line, and how a path is named
//   metrics     counters, gauges and histograms in the Prometheus text format
//   readiness   whether a service can do its work, checked without changing anything
//   observe     one log line and one set of measurements per request
//
// Vendor-neutral: nothing here knows a log shipper, a metrics server or a
// tracing product. A deployment points its own at the output.

export { redact, routeOf, SECRET_SHAPES } from "./adapters/redaction.ts";
export { Metrics, type Sample } from "./adapters/metrics.ts";
export { allowNewerSchema, migrationStatus, prepareSchema, readiness, schemaServable, type MigrationStatus, type ReadinessCheck } from "./adapters/readiness.ts";
export { observe, operationsRoutes, type OperationsConfig, type RequestLog } from "./adapters/observe.ts";
