import { describe, it, expect } from 'vitest';
import { mapOptimisedOrder, seconds } from '../src/modules/routing/routing.google.js';

/**
 * The two pure pieces of the Google client, tested without a network call.
 *
 * `mapOptimisedOrder` is the one place a silent, plausible-looking bug can lose a
 * delivery: Google answers with positions among the intermediates, our callers
 * index the whole array, and reading it the wrong way round produces a valid
 * permutation that visits the wrong stops in the wrong order.
 */

describe('seconds', () => {
  it('parses the protobuf duration string', () => {
    expect(seconds('1234s')).toBe(1234);
    expect(seconds('0s')).toBe(0);
    expect(seconds('12.5s')).toBe(12.5);
  });

  it('passes a plain number through and never returns NaN', () => {
    expect(seconds(90)).toBe(90);
    expect(seconds('nonsense')).toBe(0);
    expect(seconds(undefined)).toBe(0);
    expect(seconds(null)).toBe(0);
    expect(seconds(Number.NaN)).toBe(0);
  });
});

describe('mapOptimisedOrder with a fixed end', () => {
  // points = [start, A, B, C, end] — 5 total, 3 intermediates.
  it('shifts intermediate positions past the start and pins both ends', () => {
    expect(mapOptimisedOrder([0, 1, 2], 5, true)).toEqual([0, 1, 2, 3, 4]);
    expect(mapOptimisedOrder([2, 0, 1], 5, true)).toEqual([0, 3, 1, 2, 4]);
  });

  it('rejects a count that does not match the intermediates', () => {
    expect(mapOptimisedOrder([0, 1], 5, true)).toBeNull();
    expect(mapOptimisedOrder([0, 1, 2, 3], 5, true)).toBeNull();
  });
});

describe('mapOptimisedOrder with an open end', () => {
  // points = [start, A, B, C] — 4 total, 3 intermediates, nothing pinned at the end.
  it('keeps every stop and never appends a destination', () => {
    expect(mapOptimisedOrder([0, 1, 2], 4, false)).toEqual([0, 1, 2, 3]);
    expect(mapOptimisedOrder([1, 2, 0], 4, false)).toEqual([0, 2, 3, 1]);
  });

  it('rejects a count meant for a fixed end', () => {
    expect(mapOptimisedOrder([0, 1], 4, false)).toBeNull();
  });
});

describe('mapOptimisedOrder refuses anything it cannot trust', () => {
  it('rejects a duplicate, rather than dropping a stop', () => {
    // Two visits to the same intermediate means one delivery vanishes from the
    // plan — better no plan at all.
    expect(mapOptimisedOrder([0, 0, 1], 5, true)).toBeNull();
  });

  it('rejects an out-of-range or non-integer index', () => {
    expect(mapOptimisedOrder([0, 1, 3], 5, true)).toBeNull();
    expect(mapOptimisedOrder([0, 1, -1], 5, true)).toBeNull();
    expect(mapOptimisedOrder([0, 1, 1.5], 5, true)).toBeNull();
  });

  it('returns a permutation of exactly the input indices', () => {
    const order = mapOptimisedOrder([3, 1, 0, 2], 6, true);
    expect(order).not.toBeNull();
    expect([...order!].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
