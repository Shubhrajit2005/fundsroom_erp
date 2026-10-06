import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { assertReservationAvailable } from '../src/domain.js';

const { Pool } = pg;

test('simultaneous reservations cannot reserve more than available inventory', {
  skip: !process.env.DATABASE_URL && 'Set DATABASE_URL to run PostgreSQL concurrency tests'
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const schema = `reservation_test_${randomUUID().replaceAll('-', '')}`;
  const first = await pool.connect();
  const second = await pool.connect();
  let schemaCreated = false;

  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    await pool.query(`CREATE TABLE ${schema}.inventory (id integer PRIMARY KEY, physical integer NOT NULL, reserved integer NOT NULL)`);
    await pool.query(`INSERT INTO ${schema}.inventory VALUES (1, 10, 0)`);

    await first.query('BEGIN');
    const firstRead = await first.query(`SELECT * FROM ${schema}.inventory WHERE id=1 FOR UPDATE`);
    assertReservationAvailable(firstRead.rows[0].physical - firstRead.rows[0].reserved, 7);
    await first.query(`UPDATE ${schema}.inventory SET reserved=reserved+7 WHERE id=1`);

    await second.query('BEGIN');
    const contender = second.query(`SELECT * FROM ${schema}.inventory WHERE id=1 FOR UPDATE`);
    let lockObserved = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { rows } = await pool.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE wait_event_type='Lock' AND query LIKE $1`, [`%${schema}.inventory%`]);
      if (rows[0].waiting > 0) {
        lockObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(lockObserved, true, 'second reservation should wait for the first row lock');

    await first.query('COMMIT');
    const secondRead = await contender;
    assert.throws(
      () => assertReservationAvailable(secondRead.rows[0].physical - secondRead.rows[0].reserved, 7),
      /Insufficient available stock/
    );
    await second.query('ROLLBACK');

    const { rows } = await pool.query(`SELECT physical, reserved FROM ${schema}.inventory WHERE id=1`);
    assert.deepEqual(rows[0], { physical: 10, reserved: 7 });
  } finally {
    if (first) {
      try { await first.query('ROLLBACK'); } catch {}
      first.release();
    }
    if (second) {
      try { await second.query('ROLLBACK'); } catch {}
      second.release();
    }
    if (schemaCreated) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});
