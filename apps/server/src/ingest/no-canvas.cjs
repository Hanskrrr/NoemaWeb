// Stands in for the native "@napi-rs/canvas" package when pdf.js is loaded
// to read text (see pdf-worker.ts): pdf.js loads it for drawing pages, which
// Noema never does, and a native package can fail to load in a server.
module.exports = {};
