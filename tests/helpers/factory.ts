/** A valid create-consignment payload; override anything per test. */
export function buildConsignment(clientId: string, overrides: Record<string, unknown> = {}) {
  return {
    clientId,
    taskType: 'DELIVERY',
    priority: 'NORMAL',
    sender: {
      name: 'Daraz Fulfilment Centre',
      phone: '+92 42 3529 8800',
      line1: 'Warehouse 4, Sundar Industrial Estate',
      area: 'Raiwind Road',
      city: 'Lahore',
      postcode: '54000',
    },
    receiver: {
      name: 'Sana Yousaf',
      phone: '+92 300 4471129',
      line1: 'House 214, Street 8, Block C',
      area: 'DHA Phase 5',
      city: 'Lahore',
      postcode: '54792',
    },
    generalNote: 'Handle with care',
    items: [
      { description: 'Power bank 20000mAh', qty: 1, weightKg: 0.48, packageType: 'BOX' },
      { description: 'USB-C cable 2m', qty: 2, weightKg: 0.12, packageType: 'ENVELOPE' },
    ],
    ...overrides,
  };
}
