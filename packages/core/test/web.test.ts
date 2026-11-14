import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWebPlan, WEB_PLAN_PROMPT, webPlanRequest } from '../src/index.ts';

test('whether to search the web: asked with the room, read with care (two searches at most)', () => {
  const req = webPlanRequest('Why is backprop memory-bound?', { title: 'ML systems', brief: 'Activations fill memory.' });
  assert.equal(req[0]?.content, WEB_PLAN_PROMPT);
  assert.equal(req[1]?.content, 'The learner\'s room “ML systems”: Activations fill memory.\n\nThe question:\nWhy is backprop memory-bound?');
  assert.deepEqual(readWebPlan('{"queries":["activation memory backprop", "  gradient   checkpointing ", "third", "x"]}'), [
    'activation memory backprop',
    'gradient checkpointing',
  ]);
  assert.deepEqual(readWebPlan('{"queries":[]}'), []);
  assert.deepEqual(readWebPlan('{"queries":[1, "", "a"]}'), ['a']);
  assert.deepEqual(readWebPlan('nope'), []);
  assert.equal(readWebPlan(`{"queries":["${'x'.repeat(300)}"]}`)[0]?.length, 128);
});
