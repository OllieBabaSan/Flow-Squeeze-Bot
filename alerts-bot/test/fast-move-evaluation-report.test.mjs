import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeFastMoveEvaluations } from '../lib/fast-move-evaluation-report.mjs';

test('summarizes qualification and every observed rejection reason by candidate', () => {
  const summary = summarizeFastMoveEvaluations([
    { signalId: 'a', qualified: false, confirmationAction: 'REJECT', evaluation: { lastReason: 'MOVE_TOO_SMALL', reasonCounts: { MOVE_TOO_SMALL: 2, SPREAD_TOO_WIDE: 1 } } },
    { signalId: 'b', qualified: true, confirmationAction: 'PUBLISH', evaluation: { lastReason: 'QUALIFIED', reasonCounts: { MOVE_TOO_SMALL: 1 } } },
  ]);
  assert.equal(summary.candidates, 2);
  assert.equal(summary.qualified, 1);
  assert.deepEqual(summary.byConfirmationAction, { REJECT: 1, PUBLISH: 1 });
  assert.deepEqual(summary.rejectionReasonOccurrences, { MOVE_TOO_SMALL: 3, SPREAD_TOO_WIDE: 1 });
  assert.deepEqual(summary.candidatesByRejectionReason, { MOVE_TOO_SMALL: 2, SPREAD_TOO_WIDE: 1 });
});

test('deduplicates repeated terminal records by signal id', () => {
  const summary = summarizeFastMoveEvaluations([
    { signalId: 'a', qualified: false, evaluation: { lastReason: 'OLD' } },
    { signalId: 'a', qualified: true, evaluation: { lastReason: 'QUALIFIED' } },
  ]);
  assert.equal(summary.candidates, 1);
  assert.equal(summary.qualified, 1);
});
