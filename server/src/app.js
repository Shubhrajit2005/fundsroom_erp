import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import swaggerUi from 'swagger-ui-express';
import { fileURLToPath } from 'node:url';
import { pool } from './db/pool.js';
import { authenticate, adminOnly, salesOnly, salesOrAdmin } from './auth.js';
import { calculateLine, money, assertQuotationCanConvert, assertQuotationTransition, assertOrderCanConfirm, assertReservationAvailable, assertOrderCanDispatch } from './domain.js';

export const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));

const openApiFile = fileURLToPath(new URL('../../docs/openapi.yaml', import.meta.url));
app.get('/api-docs/openapi.yaml', (_req, res) => res.type('text/yaml').sendFile(openApiFile));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(null, {
  customSiteTitle: 'ForgeFlow API documentation',
  swaggerOptions: { url: '/api-docs/openapi.yaml' }
}));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const nonempty = z.string().trim().min(1);
const lineItems = z.array(z.object({ productId: z.string().uuid(), quantity: z.coerce.number().int().positive() })).min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nextNumber = async (client, sequence, prefix) => {
  const { rows } = await client.query(`SELECT nextval('${sequence}') AS value`);
  return `${prefix}-${String(rows[0].value).padStart(6, '0')}`;
};
const withTransaction = async (handler) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
};
const badRequest = (message, status = 400) => Object.assign(new Error(message), { status });
const getLines = (items, schema) => {
  const result = schema.safeParse(items);
  if (!result.success) throw badRequest(result.error.issues.map((issue) => issue.message).join('; '));
  return result.data;
};

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
  if (!input.success) throw badRequest('Enter a valid email and password');
  const { rows } = await pool.query('SELECT id, full_name, email, password_hash, role FROM users WHERE lower(email)=lower($1) AND active=true', [input.data.email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(input.data.password, user.password_hash))) throw badRequest('Email or password is incorrect', 401);
  const token = jwt.sign({ role: user.role, name: user.full_name, email: user.email }, process.env.JWT_SECRET, { subject: user.id, expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
  res.json({ token, user: { id: user.id, name: user.full_name, email: user.email, role: user.role } });
}));

app.use('/api', authenticate);

app.get('/api/me', (req, res) => res.json({ user: req.user }));
app.get('/api/products', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT p.id,p.product_code,p.name,p.category,p.unit,p.base_price,
    i.physical_quantity,i.reserved_quantity,(i.physical_quantity-i.reserved_quantity) AS available_quantity
    FROM products p JOIN inventory i ON i.product_id=p.id WHERE p.active ORDER BY p.product_code`);
  res.json(rows);
}));
app.patch('/api/inventory/:productId', adminOnly, asyncRoute(async (req, res) => {
  const body = z.object({ physicalQuantity: z.coerce.number().int().nonnegative() }).safeParse(req.body);
  if (!body.success) throw badRequest('Physical quantity must be a non-negative whole number');
  const updated = await withTransaction(async (client) => {
    const current = await client.query('SELECT * FROM inventory WHERE product_id=$1 FOR UPDATE', [req.params.productId]);
    if (!current.rowCount) throw badRequest('Inventory record not found', 404);
    if (body.data.physicalQuantity < current.rows[0].reserved_quantity) throw badRequest(`Physical quantity cannot be below ${current.rows[0].reserved_quantity} units already reserved`, 409);
    return (await client.query(`UPDATE inventory SET physical_quantity=$2,updated_at=now() WHERE product_id=$1
      RETURNING *,physical_quantity-reserved_quantity AS available_quantity`, [req.params.productId,body.data.physicalQuantity])).rows[0];
  });
  res.json(updated);
}));

app.get('/api/customers', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT c.*,count(e.id)::int AS enquiry_count FROM customers c LEFT JOIN enquiries e ON e.customer_id=c.id GROUP BY c.id ORDER BY c.company_name`);
  res.json(rows);
}));
app.post('/api/customers', salesOnly, asyncRoute(async (req, res) => {
  const body = z.object({ companyName: nonempty.max(200), contactPerson: nonempty.max(120), mobile: nonempty.max(40), email: z.string().email().max(254), city: nonempty.max(120) }).safeParse(req.body);
  if (!body.success) throw badRequest(body.error.issues.map((issue) => issue.message).join('; '));
  const { companyName,contactPerson,mobile,email,city } = body.data;
  const { rows } = await pool.query(`INSERT INTO customers(company_name,contact_person,mobile,email,city,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [companyName,contactPerson,mobile.toLowerCase(),email.toLowerCase(),city,req.user.id]);
  res.status(201).json(rows[0]);
}));

app.get('/api/enquiries', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT e.*,c.company_name,c.contact_person,c.city,
    count(ei.id)::int AS product_count, COALESCE(sum(ei.quantity),0)::int AS units
    FROM enquiries e JOIN customers c ON c.id=e.customer_id LEFT JOIN enquiry_items ei ON ei.enquiry_id=e.id
    GROUP BY e.id,c.id ORDER BY e.created_at DESC`);
  res.json(rows);
}));
app.post('/api/enquiries', salesOnly, asyncRoute(async (req, res) => {
  const customerDetails = z.object({ companyName: nonempty, contactPerson: nonempty, mobile: nonempty, email: z.string().email(), city: nonempty });
  const body = z.object({ customerId: z.string().uuid().optional(), customer: customerDetails.optional(), enquiryDate: date.optional(), requiredDate: date.optional(), notes: z.string().max(2000).optional(), items: lineItems }).refine((input) => Boolean(input.customerId) !== Boolean(input.customer), { message: 'Select an existing customer or provide customer details' }).safeParse(req.body);
  if (!body.success) throw badRequest(body.error.issues.map((issue) => issue.message).join('; '));
  const input = body.data;
  const enquiry = await withTransaction(async (client) => {
    let customer;
    if (input.customerId) {
      const result = await client.query('SELECT * FROM customers WHERE id=$1', [input.customerId]);
      if (!result.rowCount) throw badRequest('Customer not found', 404);
      customer = result.rows[0];
    } else {
      const result = await client.query(`INSERT INTO customers(company_name,contact_person,mobile,email,city,created_by)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [input.customer.companyName,input.customer.contactPerson,input.customer.mobile,input.customer.email,input.customer.city,req.user.id]);
      customer = result.rows[0];
    }
    const number = await nextNumber(client, 'enquiry_number_seq', 'ENQ');
    const row = await client.query(`INSERT INTO enquiries(enquiry_number,customer_id,enquiry_date,required_date,notes,created_by)
      VALUES($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6) RETURNING *`, [number,customer.id,input.enquiryDate || null,input.requiredDate || null,input.notes || '',req.user.id]);
    for (const item of input.items) await client.query('INSERT INTO enquiry_items(enquiry_id,product_id,quantity) VALUES($1,$2,$3)', [row.rows[0].id,item.productId,item.quantity]);
    return { ...row.rows[0], company_name: customer.company_name };
  });
  res.status(201).json(enquiry);
}));
app.get('/api/enquiries/:id', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`SELECT e.*,c.company_name,c.contact_person,c.mobile,c.email,c.city FROM enquiries e JOIN customers c ON c.id=e.customer_id WHERE e.id=$1`, [req.params.id]);
  if (!rows.length) throw badRequest('Enquiry not found', 404);
  res.json(rows[0]);
}));
app.get('/api/enquiries/:id/items', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`SELECT ei.product_id,ei.quantity,p.product_code,p.name,p.unit FROM enquiry_items ei
    JOIN products p ON p.id=ei.product_id WHERE ei.enquiry_id=$1 ORDER BY p.product_code`, [req.params.id]);
  res.json(rows);
}));

app.get('/api/quotations', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT q.*,e.enquiry_number,c.company_name,count(qi.id)::int AS product_count
    FROM quotations q JOIN enquiries e ON e.id=q.enquiry_id JOIN customers c ON c.id=e.customer_id
    LEFT JOIN quotation_items qi ON qi.quotation_id=q.id GROUP BY q.id,e.id,c.id ORDER BY q.created_at DESC`);
  res.json(rows);
}));
app.post('/api/quotations', salesOnly, asyncRoute(async (req, res) => {
  const body = z.object({ enquiryId: z.string().uuid(), validUntil: date, items: z.array(z.object({ productId: z.string().uuid(), quantity: z.coerce.number().int().positive(), unitPrice: z.coerce.number().nonnegative(), discountPct: z.coerce.number().min(0).max(100).default(0), gstPct: z.coerce.number().min(0).max(100).default(18) })).min(1) }).safeParse(req.body);
  if (!body.success) throw badRequest(body.error.issues.map((issue) => issue.message).join('; '));
  const quote = await withTransaction(async (client) => {
    const enquiry = await client.query('SELECT id, customer_id, status FROM enquiries WHERE id=$1 FOR UPDATE', [body.data.enquiryId]);
    if (!enquiry.rowCount) throw badRequest('Enquiry not found', 404);
    if (enquiry.rows[0].status === 'LOST') throw badRequest('A lost enquiry cannot be quoted');
    const number = await nextNumber(client, 'quotation_number_seq', 'QUO');
    const head = await client.query(`INSERT INTO quotations(quotation_number,enquiry_id,valid_until,created_by)
      VALUES($1,$2,$3,$4) RETURNING *`, [number,body.data.enquiryId,body.data.validUntil,req.user.id]);
    let subtotal = 0, discountTotal = 0, taxTotal = 0, grandTotal = 0;
    for (const item of body.data.items) {
      const requested = await client.query('SELECT quantity FROM enquiry_items WHERE enquiry_id=$1 AND product_id=$2', [body.data.enquiryId,item.productId]);
      if (!requested.rowCount || item.quantity > requested.rows[0].quantity) throw badRequest('Quotation items must match the enquiry products and quantities');
      const amount = calculateLine(item.quantity,item.unitPrice,item.discountPct,item.gstPct);
      subtotal = money(subtotal + amount.baseAmount); discountTotal = money(discountTotal + amount.discountAmount); taxTotal = money(taxTotal + amount.taxAmount); grandTotal = money(grandTotal + amount.lineAmount);
      await client.query(`INSERT INTO quotation_items(quotation_id,product_id,quantity,unit_price,discount_pct,gst_pct,base_amount,discount_amount,tax_amount,line_amount)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [head.rows[0].id,item.productId,item.quantity,item.unitPrice,item.discountPct,item.gstPct,amount.baseAmount,amount.discountAmount,amount.taxAmount,amount.lineAmount]);
    }
    const updated = await client.query('UPDATE quotations SET subtotal=$2,total_discount=$3,total_tax=$4,grand_total=$5 WHERE id=$1 RETURNING *', [head.rows[0].id,subtotal,discountTotal,taxTotal,grandTotal]);
    await client.query("UPDATE enquiries SET status='QUOTED' WHERE id=$1 AND status='NEW'", [body.data.enquiryId]);
    return updated.rows[0];
  });
  res.status(201).json(quote);
}));
app.patch('/api/quotations/:id/status', salesOrAdmin, asyncRoute(async (req, res) => {
  const body = z.object({ status: z.enum(['SENT','ACCEPTED','REJECTED']) }).safeParse(req.body);
  if (!body.success) throw badRequest('Status must be SENT, ACCEPTED, or REJECTED');
  const quote = await withTransaction(async (client) => {
    const locked = await client.query('SELECT * FROM quotations WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!locked.rowCount) throw badRequest('Quotation not found', 404);
    try { assertQuotationTransition(locked.rows[0].status, body.data.status, req.user.role); }
    catch (error) { throw badRequest(error.message, 403); }
    const updated = await client.query('UPDATE quotations SET status=$2 WHERE id=$1 RETURNING *', [req.params.id,body.data.status]);
    if (body.data.status === 'ACCEPTED') await client.query("UPDATE enquiries SET status='WON' WHERE id=$1", [locked.rows[0].enquiry_id]);
    if (body.data.status === 'REJECTED') await client.query("UPDATE enquiries SET status='LOST' WHERE id=$1", [locked.rows[0].enquiry_id]);
    return updated.rows[0];
  });
  res.json(quote);
}));
app.post('/api/quotations/:id/convert', salesOnly, asyncRoute(async (req, res) => {
  const order = await withTransaction(async (client) => {
    const quote = await client.query(`SELECT q.*,e.customer_id FROM quotations q JOIN enquiries e ON e.id=q.enquiry_id WHERE q.id=$1 FOR UPDATE OF q`, [req.params.id]);
    if (!quote.rowCount) throw badRequest('Quotation not found', 404);
    const exists = await client.query('SELECT id FROM sales_orders WHERE quotation_id=$1', [req.params.id]);
    try { assertQuotationCanConvert(quote.rows[0].status, exists.rowCount > 0); }
    catch (error) { throw badRequest(error.message, exists.rowCount ? 409 : 400); }
    const number = await nextNumber(client,'order_number_seq','SO');
    const head = await client.query(`INSERT INTO sales_orders(order_number,quotation_id,customer_id,total_amount)
      VALUES($1,$2,$3,$4) RETURNING *`, [number,req.params.id,quote.rows[0].customer_id,quote.rows[0].grand_total]);
    await client.query(`INSERT INTO sales_order_items(sales_order_id,product_id,quantity,unit_price)
      SELECT $1,product_id,quantity,unit_price FROM quotation_items WHERE quotation_id=$2`, [head.rows[0].id,req.params.id]);
    return head.rows[0];
  });
  res.status(201).json(order);
}));

app.get('/api/sales-orders', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT so.*,c.company_name,q.quotation_number,d.dispatch_number,d.dispatch_date,d.vehicle_number,d.driver_name,
    count(soi.id)::int AS product_count, COALESCE(sum(soi.quantity),0)::int AS units
    FROM sales_orders so JOIN customers c ON c.id=so.customer_id JOIN quotations q ON q.id=so.quotation_id
    LEFT JOIN dispatches d ON d.sales_order_id=so.id LEFT JOIN sales_order_items soi ON soi.sales_order_id=so.id
    GROUP BY so.id,c.id,q.id,d.id ORDER BY so.created_at DESC`);
  res.json(rows);
}));
app.get('/api/sales-orders/:id', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`SELECT so.*,c.company_name,q.quotation_number FROM sales_orders so
    JOIN customers c ON c.id=so.customer_id JOIN quotations q ON q.id=so.quotation_id WHERE so.id=$1`, [req.params.id]);
  if (!rows.length) throw badRequest('Sales order not found', 404);
  const items = await pool.query(`SELECT soi.*,p.product_code,p.name,p.unit,i.physical_quantity,i.reserved_quantity,
    (i.physical_quantity-i.reserved_quantity) AS available_quantity FROM sales_order_items soi
    JOIN products p ON p.id=soi.product_id JOIN inventory i ON i.product_id=p.id WHERE soi.sales_order_id=$1 ORDER BY p.product_code`, [req.params.id]);
  res.json({ ...rows[0], items: items.rows });
}));
app.post('/api/sales-orders/:id/confirm', adminOnly, asyncRoute(async (req, res) => {
  const order = await withTransaction(async (client) => {
    const head = await client.query('SELECT * FROM sales_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!head.rowCount) throw badRequest('Sales order not found', 404);
    assertOrderCanConfirm(head.rows[0].status);
    const items = await client.query('SELECT product_id,quantity FROM sales_order_items WHERE sales_order_id=$1 ORDER BY product_id', [req.params.id]);
    const productIds = items.rows.map((item) => item.product_id);
    const stock = await client.query('SELECT * FROM inventory WHERE product_id=ANY($1::uuid[]) ORDER BY product_id FOR UPDATE', [productIds]);
    const byId = new Map(stock.rows.map((row) => [row.product_id,row]));
    for (const item of items.rows) {
      const inventory = byId.get(item.product_id);
      if (!inventory) throw badRequest('Inventory record is missing', 409);
      assertReservationAvailable(inventory.physical_quantity - inventory.reserved_quantity,item.quantity);
    }
    for (const item of items.rows) await client.query('UPDATE inventory SET reserved_quantity=reserved_quantity+$2,updated_at=now() WHERE product_id=$1', [item.product_id,item.quantity]);
    const updated = await client.query("UPDATE sales_orders SET status='CONFIRMED',confirmed_by=$2,confirmed_at=now() WHERE id=$1 RETURNING *", [req.params.id,req.user.id]);
    return updated.rows[0];
  });
  res.json(order);
}));
app.post('/api/sales-orders/:id/dispatch', adminOnly, asyncRoute(async (req, res) => {
  const body = z.object({ vehicleNumber: nonempty.max(40), driverName: nonempty.max(120) }).safeParse(req.body);
  if (!body.success) throw badRequest('Vehicle number and driver name are required');
  const dispatch = await withTransaction(async (client) => {
    const head = await client.query('SELECT * FROM sales_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!head.rowCount) throw badRequest('Sales order not found', 404);
    assertOrderCanDispatch(head.rows[0].status);
    const items = await client.query('SELECT product_id,quantity FROM sales_order_items WHERE sales_order_id=$1 ORDER BY product_id', [req.params.id]);
    const productIds = items.rows.map((item) => item.product_id);
    const stock = await client.query('SELECT * FROM inventory WHERE product_id=ANY($1::uuid[]) ORDER BY product_id FOR UPDATE', [productIds]);
    const byId = new Map(stock.rows.map((row) => [row.product_id,row]));
    for (const item of items.rows) if (!byId.has(item.product_id) || byId.get(item.product_id).reserved_quantity < item.quantity || byId.get(item.product_id).physical_quantity < item.quantity) throw badRequest('Reserved stock is insufficient for dispatch', 409);
    const number = await nextNumber(client,'dispatch_number_seq','DSP');
    const created = await client.query(`INSERT INTO dispatches(dispatch_number,sales_order_id,vehicle_number,driver_name,processed_by)
      VALUES($1,$2,$3,$4,$5) RETURNING *`, [number,req.params.id,body.data.vehicleNumber,body.data.driverName,req.user.id]);
    for (const item of items.rows) {
      await client.query('UPDATE inventory SET physical_quantity=physical_quantity-$2,reserved_quantity=reserved_quantity-$2,updated_at=now() WHERE product_id=$1', [item.product_id,item.quantity]);
      await client.query('INSERT INTO dispatch_items(dispatch_id,product_id,quantity) VALUES($1,$2,$3)', [created.rows[0].id,item.product_id,item.quantity]);
    }
    await client.query("UPDATE sales_orders SET status='DISPATCHED' WHERE id=$1", [req.params.id]);
    return created.rows[0];
  });
  res.status(201).json(dispatch);
}));

app.get('/api/dashboard', asyncRoute(async (_req, res) => {
  const [orders, counts, stock] = await Promise.all([
    pool.query(`SELECT so.id,so.order_number,so.status,so.total_amount,so.order_date,c.company_name FROM sales_orders so JOIN customers c ON c.id=so.customer_id ORDER BY so.created_at DESC LIMIT 6`),
    pool.query(`SELECT (SELECT count(*) FROM enquiries) AS enquiries,(SELECT count(*) FROM quotations) AS quotations,(SELECT count(*) FROM sales_orders WHERE status='PENDING') AS pending_orders,(SELECT count(*) FROM sales_orders WHERE status='CONFIRMED') AS to_dispatch`),
    pool.query(`SELECT p.name,p.product_code,i.physical_quantity,i.reserved_quantity,(i.physical_quantity-i.reserved_quantity) AS available_quantity FROM inventory i JOIN products p ON p.id=i.product_id ORDER BY available_quantity,p.name LIMIT 6`)
  ]);
  res.json({ counts: counts.rows[0], orders: orders.rows, lowStock: stock.rows });
}));

app.use((error, _req, res, _next) => {
  if (error.code === '23505') return res.status(409).json({ error: 'A record with this value already exists' });
  if (error.code === '23503') return res.status(400).json({ error: 'Referenced record does not exist' });
  if (error.code === '23514' || error.code === '22P02') return res.status(400).json({ error: 'Invalid data supplied' });
  console.error(error);
  return res.status(error.status || 500).json({ error: error.status ? error.message : 'Internal server error' });
});

export { withTransaction, badRequest, getLines };
