export const ROLES = Object.freeze({ ADMIN: 'ADMIN', SALES: 'SALES' });
export const QUOTATION_STATUS = Object.freeze({ DRAFT: 'DRAFT', SENT: 'SENT', ACCEPTED: 'ACCEPTED', REJECTED: 'REJECTED' });
export const ORDER_STATUS = Object.freeze({ PENDING: 'PENDING', CONFIRMED: 'CONFIRMED', DISPATCHED: 'DISPATCHED', CANCELLED: 'CANCELLED' });

export function calculateLine(quantity, unitPrice, discountPct = 0, gstPct = 0) {
  const values = [quantity, unitPrice, discountPct, gstPct].map(Number);
  if (values.some((value) => !Number.isFinite(value)) || values[0] <= 0 || values[1] < 0 || values[2] < 0 || values[2] > 100 || values[3] < 0 || values[3] > 100) {
    throw new Error('Invalid quantity, price, discount, or GST');
  }
  const [qty, price, discount, gst] = values;
  const base = qty * price;
  const taxable = base * (1 - discount / 100);
  return { baseAmount: money(base), discountAmount: money(base - taxable), taxAmount: money(taxable * gst / 100), lineAmount: money(taxable * (1 + gst / 100)) };
}

export const money = (amount) => Math.round((Number(amount) + Number.EPSILON) * 100) / 100;

export function quotationCanConvert(status) {
  if (status !== QUOTATION_STATUS.ACCEPTED) throw new Error('Only accepted quotations can be converted into a sales order');
}

export function assertQuotationCanConvert(status, existingOrder) {
  quotationCanConvert(status);
  if (existingOrder) throw new Error('This quotation already has a sales order');
}

export function assertQuotationTransition(status, nextStatus, role) {
  if (role === ROLES.SALES && status === QUOTATION_STATUS.DRAFT && nextStatus === QUOTATION_STATUS.SENT) return;
  if (role === ROLES.ADMIN && status === QUOTATION_STATUS.SENT && [QUOTATION_STATUS.ACCEPTED, QUOTATION_STATUS.REJECTED].includes(nextStatus)) return;
  throw new Error(`${role} cannot change ${status} quotation to ${nextStatus}`);
}

export function assertOrderCanConfirm(status) {
  if (status !== ORDER_STATUS.PENDING) throw new Error('Only pending sales orders can be confirmed');
}

export function assertReservationAvailable(available, requested) {
  if (Number(requested) <= 0 || Number(requested) > Number(available)) throw new Error(`Insufficient available stock (available: ${available}, requested: ${requested})`);
}

export function assertOrderCanDispatch(status) {
  if (status !== ORDER_STATUS.CONFIRMED) throw new Error('Only confirmed sales orders can be dispatched');
}
