// tests/feeCalculator.test.js
const { computeFee } = require('../src/utils/feeCalculator');

describe('computeFee', () => {
  it('applies percentage + fixed fee with no merchant override', () => {
    // 100000 minor units, default 1.5% (150 bps) + 10000 fixed
    const { feeAmount, netAmount } = computeFee(100000);
    expect(feeAmount).toBe(Math.floor((100000 * 150) / 10000) + 10000);
    expect(netAmount).toBe(100000 - feeAmount);
  });

  it('respects a per-merchant fee override', () => {
    const merchant = { fees: { percentageBps: 100, fixedMinor: 5000, capMinor: 0 } };
    const { feeAmount } = computeFee(1000000, merchant);
    expect(feeAmount).toBe(Math.floor((1000000 * 100) / 10000) + 5000);
  });

  it('caps the fee at capMinor even for large amounts', () => {
    const merchant = { fees: { percentageBps: 500, fixedMinor: 0, capMinor: 1000 } };
    const { feeAmount } = computeFee(10_000_000, merchant);
    expect(feeAmount).toBe(1000);
  });

  it('never lets the fee exceed the amount it is taken from', () => {
    const merchant = { fees: { percentageBps: 0, fixedMinor: 999999, capMinor: 0 } };
    const { feeAmount, netAmount } = computeFee(100, merchant);
    expect(feeAmount).toBe(100);
    expect(netAmount).toBe(0);
  });

  it('rejects non-integer or negative amounts', () => {
    expect(() => computeFee(-5)).toThrow('invalid_fee_base_amount');
    expect(() => computeFee(1.5)).toThrow('invalid_fee_base_amount');
  });
});
