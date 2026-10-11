import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTokenRisk, clearTokenRiskCache, evaluateTokenSecurity } from '../lib/token-risk.mjs';

test('hard contract controls classify a token as high risk', () => {
  const result = evaluateTokenSecurity({ is_honeypot: '0', is_mintable: '1', owner_change_balance: '1', is_open_source: '1' });
  assert.equal(result.blocked, true);
  assert.equal(result.riskLevel, 'HIGH');
  assert.ok(result.blockers.includes('owner can change holder balances'));
});

test('mintable and proxy alone warn without blocking', () => {
  const result = evaluateTokenSecurity({ is_mintable: '1', is_proxy: '1', is_open_source: '1', buy_tax: '0', sell_tax: '0' });
  assert.equal(result.blocked, false);
  assert.equal(result.riskLevel, 'ELEVATED');
});

test('excessive transaction tax blocks a token', () => {
  assert.equal(evaluateTokenSecurity({ is_open_source: '1', sell_tax: '0.15' }).blocked, true);
});

test('OMI-style Base owner balance control is discarded', async () => {
  clearTokenRiskCache();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { '0x3792dbdd07e87413247df995e692806aa13d3299': { is_honeypot: '0', is_mintable: '1', owner_change_balance: '1', is_open_source: '1' } } }) });
  const result = await checkTokenRisk({ contracts: [{ platform: 'Base', address: '0x3792DBDD07e87413247DF995e692806aa13D3299' }] }, { fetchImpl });
  assert.equal(result.blocked, true);
  assert.match(result.blockers[0], /Base: owner can change holder balances/);
});

test('native assets are not blocked by an inapplicable contract check', async () => {
  const result = await checkTokenRisk({ contracts: [], contractStatus: 'native' });
  assert.equal(result.blocked, false);
  assert.equal(result.riskLevel, 'NOT_APPLICABLE');
});

test('checks multiple contract chains concurrently', async () => {
  clearTokenRiskCache();
  let started = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => {
    started += 1;
    if (started === 2) release();
    await gate;
    return { ok: true, json: async () => ({ result: { token: { is_open_source: '1', is_honeypot: '0' } } }) };
  };
  const result = await Promise.race([
    checkTokenRisk({ contracts: [
      { platform: 'Ethereum', address: '0x1111111111111111111111111111111111111111' },
      { platform: 'Base', address: '0x2222222222222222222222222222222222222222' },
    ] }, { fetchImpl }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('contract checks did not run concurrently')), 500)),
  ]);
  assert.equal(started, 2);
  assert.equal(result.blocked, false);
});

test('secondary-chain controls warn without suppressing a canonical token catalyst', async () => {
  clearTokenRiskCache();
  const fetchImpl = async url => {
    const isOptimism = url.includes('/10?');
    return {
      ok: true,
      json: async () => ({
        result: {
          token: isOptimism
            ? { is_open_source: '1', owner_change_balance: '1' }
            : { is_open_source: '1', is_honeypot: '0' },
        },
      }),
    };
  };
  const result = await checkTokenRisk({
    primaryPlatform: 'Ethereum',
    contracts: [
      { platform: 'Ethereum', address: '0x1111111111111111111111111111111111111111' },
      { platform: 'Optimism', address: '0x2222222222222222222222222222222222222222' },
    ],
  }, { fetchImpl });
  assert.equal(result.blocked, false);
  assert.equal(result.riskLevel, 'ELEVATED');
  assert.deepEqual(result.blockers, []);
  assert.match(result.warnings[0], /Optimism secondary contract: owner can change holder balances/);
});

test('canonical contract controls still suppress a high-risk token', async () => {
  clearTokenRiskCache();
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ result: { token: { is_open_source: '1', is_blacklisted: '1' } } }),
  });
  const result = await checkTokenRisk({
    primaryPlatform: 'Ethereum',
    contracts: [{ platform: 'Ethereum', address: '0x3333333333333333333333333333333333333333' }],
  }, { fetchImpl });
  assert.equal(result.blocked, true);
  assert.match(result.blockers[0], /Ethereum: blacklist controls/);
});
