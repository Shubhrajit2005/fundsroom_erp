# forgeflow Operations

A small PERN application for the case study workflow: customer enquiry → quotation → sales order → inventory reservation → dispatch.

## Stack  

- PostgreSQL relational schema with constraints, foreign keys, and row-level transactions
- Node.js and Express REST API
- React 19 and Vite client
- JWT authentication, bcrypt password hashes, and backend role authorization

## Requirements

- Node.js 20.19+ or 22.12+
- PostgreSQL 14+

## Setup

1. Create a PostgreSQL database, for example `forgeflow`.
2. Copy `.env.example` to `.env` and set the values described in [Environment variables](#environment-variables).
3. Install dependencies: `npm install`.
4. Create the schema: `npm run db:migrate`.
5. Add demo users and product master data: `npm run db:seed`.
6. Start client and API together with `npm run dev`. To run separately, open two terminals and use `npm run dev:server` in one and `npm run dev:client` in the other.
7. Open [http://localhost:5173](http://localhost:5173). API runs on port 4000; Swagger UI is at [http://localhost:4000/api-docs](http://localhost:4000/api-docs).

The Vite development server proxies `/api` calls to Express. For separate deployment, set `CLIENT_ORIGIN` to the deployed client origin and serve the built client with your chosen static host.

## Environment variables

Set these in the root `.env` file before starting the API:

| Variable | Purpose | Example/default |
| --- | --- | --- |
| `PORT` | Express API port | `4000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:postgres@localhost:5432/forgeflow` |
| `JWT_SECRET` | Secret used to sign access tokens; replace with a long random value | No safe production default |
| `JWT_EXPIRES_IN` | Token lifetime accepted by `jsonwebtoken` | `8h` |
| `CLIENT_ORIGIN` | Allowed browser origin for CORS | `http://localhost:5173` |
## Demo logins

| Role  | Email                  | Password    |
| ----- | ---------------------- | ----------- |
| Admin | `admin@forgeflow.test` | `Admin123!` |
| Sales | `sales@forgeflow.test` | `Sales123!` |

These are local demonstration credentials only. Replace them before any shared or deployed use.

## Run tests

`npm test` runs the Node test suite covering server-side price calculation, quotation state rules, one-order conversion, stock availability, role protection, order state transitions, and a PostgreSQL-backed simultaneous reservation check. The concurrency check requires a reachable database from `DATABASE_URL`.

## API and database docs

- Swagger UI: [http://localhost:4000/api-docs](http://localhost:4000/api-docs)
- OpenAPI specification: [docs/openapi.yaml](docs/openapi.yaml) (also served at `http://localhost:4000/api-docs/openapi.yaml`)
- ER diagram: [docs/ER_DIAGRAM.md](docs/ER_DIAGRAM.md)
- Workflow, transaction explanation, and step-by-step change procedure: [docs/IMPLEMENTATION_GUIDE.md](docs/IMPLEMENTATION_GUIDE.md)
- PostgreSQL schema: [server/src/db/schema.sql](server/src/db/schema.sql)

## Core consistency decisions

- Enquiry, quote, order, and dispatch lines are relational tables, not JSON workflow blobs.
- Quote totals are recomputed on the server from quantity, price, discount, and GST.
- `UNIQUE(quotation_id)` prevents repeat order creation for one accepted quotation.
- Confirmation locks the order and affected inventory rows in stable order, validates every line, then reserves all stock in one transaction. Physical stock is unchanged at reservation time.
- Dispatch is allowed once for a confirmed order. It records the dispatch and decrements physical and reserved quantities atomically.
- Admin-only stock adjustment locks inventory and rejects physical quantity below reserved quantity.
- JWT authentication is applied before protected API routes. Sales submits quotations, Admin accepts or rejects them, and Sales converts accepted quotations; role restrictions are enforced in Express, not only hidden in React.

## Development commands

- `npm run dev` — client and API in watch mode
- `npm run build` — production client build
- `npm start` — API server
- `npm run db:migrate` — idempotently create schema/tables/indexes
- `npm run db:seed` — upsert demo accounts and eight products
- `npm test` — automated rule tests

## Customer master

Sales users can use **Add customer** from the Enquiries screen to save a customer once. New enquiries select a saved customer from the database and store its `customer_id`; the customer record can be reused across enquiries. The API also supports listing customers and adding a customer directly from the enquiry form.
