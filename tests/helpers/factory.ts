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
      { barcode: 'LKA001450097', description: 'Power bank 20000mAh', qty: 1, weightLb: 1.06, lengthIn: 10, widthIn: 7, heightIn: 5 },
      { barcode: 'LKA001450626', description: 'USB-C cable 2m', qty: 2, weightLb: 0.26 },
    ],
    ...overrides,
  };
}
