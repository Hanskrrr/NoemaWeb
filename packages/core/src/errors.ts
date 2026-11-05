// Named errors, said plainly. The UI shows these instead of stack traces.

import type { ErrorKind } from './contract.ts';

const TEXT: Record<ErrorKind, string> = {
  auth: 'The model provider rejected the API key. Check it in Model settings.',
  rate_limit: 'The model provider is limiting requests. Wait a moment, then retry.',
  quota: 'The model provider account is out of credit or over its quota.',
  unavailable: 'The model provider is unavailable right now. Retry in a minute.',
  bad_request: 'The model provider refused the request.',
  timeout: 'The model took too long to respond.',
  network: 'Could not reach the model provider. Check the connection.',
  aborted: 'The answer was stopped.',
  context_too_large: 'This question is too long for the model. Shorten it or split it.',
  not_configured: 'No model is connected yet. Add an API key in Model settings.',
  internal: 'Something went wrong inside Noema. The details are in the server log.',
};

export function describeError(kind: ErrorKind): string {
  return TEXT[kind];
}

/** Whether retrying the same request later could succeed. */
export function isRetryable(kind: ErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'unavailable' || kind === 'timeout' || kind === 'network';
}
