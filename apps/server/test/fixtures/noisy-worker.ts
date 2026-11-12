// A PDF worker with something else on its port first, as Node posts under
// `node --watch` (the modules a worker loads): the reader must not take it
// for an answer.
import { parentPort } from 'node:worker_threads';

parentPort?.postMessage({ 'watch:import': ['file:///somewhere.ts'] });
parentPort?.postMessage({ ok: false });
await import('../../src/ingest/pdf-worker.ts');
