const assert = require('node:assert/strict');
const test = require('node:test');

const pricing = require('../lib/pricing');
const orders = require('../lib/orders');
const invoice = require('../lib/invoice');
const reports = require('../lib/reports');

function billedOrder(items, coupon = '') {
  const totals = pricing.computeTotals(items, coupon);
  const db = { nextOrderId: 1001, orders: [] };

  return orders.add(db, {
    date: '01/01/2022',
    customer: 'Walk-in',
    items,
    coupon,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  });
}

test('invoice matches the billed GST split and total for an HSN-rated order', () => {
  const order = billedOrder([
    { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 640, qty: 1 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    { tax: figures.tax, cgst: figures.cgst, sgst: figures.sgst, total: figures.total },
    { tax: order.tax, cgst: 16, sgst: 16, total: order.total }
  );
  assert.equal(figures.rows[0].gstPercent, 5);
  assert.match(invoice.render(order), /Invoice Total<\/td><td class="r">₹672\.00/);
});

test('invoice uses the HSN slab when the order line has no gstRate', () => {
  const order = billedOrder([
    { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 100, qty: 1 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    { billedTax: order.tax, billedTotal: order.total },
    { billedTax: 5, billedTotal: 105 }
  );
  assert.deepEqual(
    { invoiceTax: figures.tax, cgst: figures.cgst, sgst: figures.sgst, invoiceTotal: figures.total },
    { invoiceTax: 5, cgst: 2.5, sgst: 2.5, invoiceTotal: 105 }
  );
  assert.equal(figures.rows[0].gstPercent, 5);
});

test('invoice keeps the billed percentage coupon cap and taxable GST', () => {
  const order = billedOrder([
    { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 2000, qty: 1 }
  ], 'SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    { billedDiscount: order.discount, billedTax: order.tax, billedTotal: order.total },
    { billedDiscount: 150, billedTax: 92.5, billedTotal: 1942.5 }
  );
  assert.deepEqual(
    { invoiceDiscount: figures.discount, invoiceTax: figures.tax, cgst: figures.cgst, sgst: figures.sgst, invoiceTotal: figures.total },
    { invoiceDiscount: 150, invoiceTax: 92.5, cgst: 46.25, sgst: 46.25, invoiceTotal: 1942.5 }
  );
  assert.match(invoice.render(order), /Invoice Total<\/td><td class="r">₹1942\.50/);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice:/);
});

test('invoice taxes the value after a flat coupon', () => {
  const order = billedOrder([
    { id: 2, sku: 'TEA', name: 'Tea', hsn: '0902', price: 500, qty: 1 }
  ], 'FLAT50');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    { billedDiscount: order.discount, billedTax: order.tax, billedTotal: order.total },
    { billedDiscount: 50, billedTax: 81, billedTotal: 531 }
  );
  assert.deepEqual(
    { invoiceDiscount: figures.discount, invoiceTax: figures.tax, cgst: figures.cgst, sgst: figures.sgst, invoiceTotal: figures.total },
    { invoiceDiscount: 50, invoiceTax: 81, cgst: 40.5, sgst: 40.5, invoiceTotal: 531 }
  );
});

test('reconciliation matches the invoice to an in-memory billed order', () => {
  const order = billedOrder([
    { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 100, qty: 1 }
  ]);
  const result = reports.getGstReconciliation({ orders: [order] });

  assert.equal(result.totalChecked, 1);
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.totalDelta, 0);
  assert.deepEqual(
    { ledgerTax: result.rows[0].ledgerTax, invoiceTax: result.rows[0].invoiceTax, delta: result.rows[0].delta, matched: result.rows[0].matched },
    { ledgerTax: 5, invoiceTax: 5, delta: 0, matched: true }
  );
});

test('reconciliation detects a stored tax or total that differs from the invoice calculation', () => {
  const order = billedOrder([
    { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 100, qty: 1 }
  ]);
  order.tax = 0;
  order.total = 100;

  const figures = invoice.computeInvoiceFigures(order);
  const result = reports.getGstReconciliation({ orders: [order] });

  assert.deepEqual({ tax: figures.tax, total: figures.total }, { tax: 5, total: 105 });
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.rows[0].delta, 5);
});

test('invoice uses the recorded discount when a historical coupon is no longer configured', () => {
  const order = billedOrder([
    { id: 2, sku: 'TEA', name: 'Tea', hsn: '0902', price: 500, qty: 1 }
  ], 'FLAT50');
  order.coupon = 'FORMER';

  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    { discount: figures.discount, lineTax: figures.rows[0].lineTax, tax: figures.tax, total: figures.total },
    { discount: 50, lineTax: 81, tax: 81, total: 531 }
  );
});
