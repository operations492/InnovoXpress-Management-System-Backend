import { describe, it, expect } from 'vitest';
import { ConsignmentStatus } from '@prisma/client';
import {
  MANUAL_STATUS_TARGETS,
  canTransition,
  gateFor,
  isEditable,
} from '../src/constants/statusFlow.js';

describe('status flow', () => {
  it('walks the happy path with the right gate at each step', () => {
    expect(canTransition('UNASSIGNED', 'ASSIGNED', 'ASSIGNMENT')).toBe(true);
    expect(canTransition('ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'MANUAL')).toBe(true);
    expect(canTransition('EN_ROUTE_TO_PICKUP', 'AT_PICKUP', 'MANUAL')).toBe(true);
    expect(canTransition('AT_PICKUP', 'PICKED_UP', 'POD')).toBe(true);
    expect(canTransition('PICKED_UP', 'EN_ROUTE_TO_DELIVERY', 'MANUAL')).toBe(true);
    expect(canTransition('EN_ROUTE_TO_DELIVERY', 'AT_DELIVERY', 'MANUAL')).toBe(true);
    expect(canTransition('AT_DELIVERY', 'DELIVERED', 'POD')).toBe(true);
  });

  it('refuses the right edge through the wrong gate', () => {
    // The whole point: proof cannot be bypassed by a plain status change.
    expect(canTransition('AT_PICKUP', 'PICKED_UP', 'MANUAL')).toBe(false);
    expect(canTransition('AT_DELIVERY', 'DELIVERED', 'MANUAL')).toBe(false);
    expect(canTransition('UNASSIGNED', 'ASSIGNED', 'MANUAL')).toBe(false);
  });

  it('never lets a manual change reach a POD-gated or assignment-gated state', () => {
    const manualTargets = new Set<string>(MANUAL_STATUS_TARGETS);
    expect(manualTargets.has('PICKED_UP')).toBe(false);
    expect(manualTargets.has('DELIVERED')).toBe(false);
    expect(manualTargets.has('ASSIGNED')).toBe(false);
    expect(manualTargets.has('UNASSIGNED')).toBe(false);
  });

  it('allows unassigning only before the run starts', () => {
    expect(canTransition('ASSIGNED', 'UNASSIGNED', 'ASSIGNMENT')).toBe(true);
    expect(canTransition('EN_ROUTE_TO_PICKUP', 'UNASSIGNED', 'ASSIGNMENT')).toBe(false);
    expect(canTransition('PICKED_UP', 'UNASSIGNED', 'ASSIGNMENT')).toBe(false);
  });

  it('treats DELIVERED as terminal', () => {
    for (const to of Object.values(ConsignmentStatus)) {
      expect(gateFor('DELIVERED', to)).toBeUndefined();
    }
  });

  it('rejects skipping a step', () => {
    expect(gateFor('UNASSIGNED', 'AT_PICKUP')).toBeUndefined();
    expect(gateFor('ASSIGNED', 'PICKED_UP')).toBeUndefined();
    expect(gateFor('PICKED_UP', 'DELIVERED')).toBeUndefined();
  });

  it('permits editing only before the goods move', () => {
    expect(isEditable('UNASSIGNED')).toBe(true);
    expect(isEditable('ASSIGNED')).toBe(true);
    expect(isEditable('EN_ROUTE_TO_PICKUP')).toBe(false);
    expect(isEditable('DELIVERED')).toBe(false);
  });
});
