/** A valid create-consignment payload; override anything per test. */
const HOUR = 3_600_000;

export function buildConsignment(clientId: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    clientId,
    taskType: 'DELIVERY',
    priority: 'NORMAL',
    sender: {
      name: 'Daraz Fulfilment Centre',
      phone: '+92 42 3529 8800',
      line1: 'Warehouse 4, Sundar Industrial Estate',
      province: 'ON',
      city: 'Lahore',
      postcode: '54000',
    },
    receiver: {
      name: 'Sana Yousaf',
      phone: '+92 300 4471129',
      line1: 'House 214, Street 8, Block C',
      province: 'ON',
      city: 'Lahore',
      postcode: '54792',
    },
    // Required, and relative to now rather than hard-coded: the dispatch map and
    // the list both filter on `deliverBefore`, so a fixture stuck in the past
    // would quietly drop out of those windows.
    pickupAfter: new Date(now + HOUR).toISOString(),
    pickupBefore: new Date(now + 3 * HOUR).toISOString(),
    deliverAfter: new Date(now + 4 * HOUR).toISOString(),
    deliverBefore: new Date(now + 8 * HOUR).toISOString(),
    generalNote: 'Handle with care',
    items: [
      { barcode: 'LKA001450097', description: 'Power bank 20000mAh', qty: 1, weightLb: 1.06, lengthIn: 10, widthIn: 7, heightIn: 5 },
      { barcode: 'LKA001450626', description: 'USB-C cable 2m', qty: 2, weightLb: 0.26 },
    ],
    ...overrides,
  };
}
