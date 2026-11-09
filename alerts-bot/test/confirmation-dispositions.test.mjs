import assert from 'node:assert/strict';
import test from 'node:test';
import { indexConfirmationDispositions, reconcileConfirmationDisposition } from '../lib/confirmation-dispositions.mjs';

test('joins historical terminal dispositions without rewriting outcome evidence', () => {
  const dispositions = indexConfirmationDispositions([
    { type: 'unrelated', id: 'candidate-1', status: 'IGNORED' },
    { type: 'confirmation_disposition', id: 'candidate-1', status: 'REGIME_SUPPRESSED', reason: 'risk_off' },
  ]);
  const original = { id: 'candidate-1', status: 'confirmation-passed' };
  const reconciled = reconcileConfirmationDisposition(original, dispositions);
  assert.equal(reconciled.confirmationDisposition.status, 'REGIME_SUPPRESSED');
  assert.equal(reconciled.confirmationDisposition.reason, 'risk_off');
  assert.equal(original.confirmationDisposition, undefined);
});

test('preserves an outcome annotation when one is already present', () => {
  const dispositions = indexConfirmationDispositions([{ type: 'confirmation_disposition', id: 'candidate-1', status: 'OLD' }]);
  const record = { id: 'candidate-1', confirmationDisposition: { status: 'PUBLISHED' } };
  assert.equal(reconcileConfirmationDisposition(record, dispositions), record);
});
