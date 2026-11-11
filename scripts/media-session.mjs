await import("./media-gateway.ts");

// npm can forward a terminal signal the gateway already received. Its first stop
// handler starts a bounded shutdown; keep repeats handled until that shutdown exits.
const ignoreRepeatedStop = () => {};
process.on("SIGINT", ignoreRepeatedStop);
process.on("SIGTERM", ignoreRepeatedStop);
