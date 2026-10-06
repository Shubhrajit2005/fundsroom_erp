import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLine, assertQuotationCanConvert, assertQuotationTransition, assertReservationAvailable, assertOrderCanConfirm, assertOrderCanDispatch } from '../src/domain.js';
import { allowRoles } from '../src/auth.js';

test('quotation line total applies discount before GST and rounds currency', () => {
  const line = calculateLine(3, 1000, 10, 18);
  assert.deepEqual(line, { baseAmount: 3000, discountAmount: 300, taxAmount: 486, lineAmount: 3186 });
});

test('draft and rejected quotations cannot become sales orders', () => {
  assert.throws(() => assertQuotationCanConvert('DRAFT', false), /Only accepted quotations/);
  assert.throws(() => assertQuotationCanConvert('REJECTED', false), /Only accepted quotations/);
});

test('the same accepted quotation cannot create a second sales order', () => {
  assert.doesNotThrow(() => assertQuotationCanConvert('ACCEPTED', false));
  assert.throws(() => assertQuotationCanConvert('ACCEPTED', true), /already has a sales order/);
});

test('sales submits quotations and only admin can accept or reject them', () => {
  assert.doesNotThrow(() => assertQuotationTransition('DRAFT', 'SENT', 'SALES'));
  assert.throws(() => assertQuotationTransition('SENT', 'ACCEPTED', 'SALES'), /SALES cannot change SENT quotation/);
  assert.throws(() => assertQuotationTransition('SENT', 'REJECTED', 'SALES'), /SALES cannot change SENT quotation/);
  assert.doesNotThrow(() => assertQuotationTransition('SENT', 'ACCEPTED', 'ADMIN'));
  assert.doesNotThrow(() => assertQuotationTransition('SENT', 'REJECTED', 'ADMIN'));
  assert.throws(() => assertQuotationTransition('DRAFT', 'ACCEPTED', 'ADMIN'), /ADMIN cannot change DRAFT quotation/);
  assert.throws(() => assertQuotationTransition('DRAFT', 'SENT', 'ADMIN'), /ADMIN cannot change DRAFT quotation/);
});

test('reservation rejects quantities greater than currently available stock', () => {
  assert.doesNotThrow(() => assertReservationAvailable(70, 60));
  assert.throws(() => assertReservationAvailable(70, 80), /Insufficient available stock/);
  assert.throws(() => assertReservationAvailable(0, 1), /Insufficient available stock/);
});

test('sales roles are blocked from admin-only operations', () => {
  let nextCalled = false;
  let statusCode = 200;
  let responseBody;
  const res = { status(code) { statusCode = code; return this; }, json(body) { responseBody = body; return this; } };
  allowRoles('ADMIN')({ user: { role: 'SALES' } }, res, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.equal(responseBody.error, 'You do not have permission to perform this action');
  assert.equal(nextCalled, false);
});

test('quotation management is restricted to sales users', () => {
  let salesAllowed = false;
  const pass = { status() { throw new Error('Sales role was rejected'); }, json() { throw new Error('Sales role was rejected'); } };
  allowRoles('SALES')({ user: { role: 'SALES' } }, pass, () => { salesAllowed = true; });
  assert.equal(salesAllowed, true);

  let statusCode = 200;
  let adminAllowed = false;
  const response = { status(code) { statusCode = code; return this; }, json() { return this; } };
  allowRoles('SALES')({ user: { role: 'ADMIN' } }, response, () => { adminAllowed = true; });
  assert.equal(statusCode, 403);
  assert.equal(adminAllowed, false);
});

test('dispatch is only valid after confirmation and confirmation only from pending', () => {
  assert.doesNotThrow(() => assertOrderCanConfirm('PENDING'));
  assert.throws(() => assertOrderCanConfirm('CONFIRMED'), /Only pending/);
  assert.doesNotThrow(() => assertOrderCanDispatch('CONFIRMED'));
  assert.throws(() => assertOrderCanDispatch('CANCELLED'), /Only confirmed/);
});
