# Database schema and ER diagram

The canonical PostgreSQL schema, including constraints and indexes, is [`server/src/db/schema.sql`](../server/src/db/schema.sql). This diagram summarizes its core relationships.

```mermaid
erDiagram
  USERS ||--o{ CUSTOMERS : creates
  USERS ||--o{ ENQUIRIES : creates
  USERS ||--o{ QUOTATIONS : creates
  USERS ||--o{ SALES_ORDERS : confirms
  USERS ||--o{ DISPATCHES : processes
  CUSTOMERS ||--o{ ENQUIRIES : submits
  PRODUCTS ||--|| INVENTORY : stocked_as
  ENQUIRIES ||--|{ ENQUIRY_ITEMS : requests
  PRODUCTS ||--o{ ENQUIRY_ITEMS : requested
  ENQUIRIES ||--o{ QUOTATIONS : priced_as
  QUOTATIONS ||--|{ QUOTATION_ITEMS : contains
  PRODUCTS ||--o{ QUOTATION_ITEMS : priced
  QUOTATIONS ||--o| SALES_ORDERS : converts_to
  CUSTOMERS ||--o{ SALES_ORDERS : orders
  SALES_ORDERS ||--|{ SALES_ORDER_ITEMS : contains
  PRODUCTS ||--o{ SALES_ORDER_ITEMS : ordered
  SALES_ORDERS ||--o| DISPATCHES : fulfilled_by
  DISPATCHES ||--|{ DISPATCH_ITEMS : contains
  PRODUCTS ||--o{ DISPATCH_ITEMS : dispatched

  USERS {
    uuid id PK
    text full_name
    text email UK
    text password_hash
    text role
  }
  CUSTOMERS {
    uuid id PK
    text company_name
    text contact_person
    text mobile
    text email
    text city
  }
  PRODUCTS {
    uuid id PK
    text product_code UK
    text name
    text category
    text unit
    numeric base_price
  }
  INVENTORY {
    uuid product_id PK,FK
    integer physical_quantity
    integer reserved_quantity
  }
  ENQUIRIES {
    uuid id PK
    text enquiry_number UK
    uuid customer_id FK
    date enquiry_date
    date required_date
    text status
  }
  ENQUIRY_ITEMS {
    uuid id PK
    uuid enquiry_id FK
    uuid product_id FK
    integer quantity
  }
  QUOTATIONS {
    uuid id PK
    text quotation_number UK
    uuid enquiry_id FK
    date valid_until
    text status
    numeric grand_total
  }
  QUOTATION_ITEMS {
    uuid id PK
    uuid quotation_id FK
    uuid product_id FK
    integer quantity
    numeric unit_price
    numeric discount_pct
    numeric gst_pct
    numeric line_amount
  }
  SALES_ORDERS {
    uuid id PK
    text order_number UK
    uuid quotation_id FK,UK
    uuid customer_id FK
    text status
    numeric total_amount
  }
  SALES_ORDER_ITEMS {
    uuid id PK
    uuid sales_order_id FK
    uuid product_id FK
    integer quantity
  }
  DISPATCHES {
    uuid id PK
    text dispatch_number UK
    uuid sales_order_id FK,UK
    text vehicle_number
    text driver_name
  }
  DISPATCH_ITEMS {
    uuid id PK
    uuid dispatch_id FK
    uuid product_id FK
    integer quantity
  }
```

`UNIQUE(sales_orders.quotation_id)` ensures an accepted quotation creates at most one sales order. `UNIQUE(dispatches.sales_order_id)` permits at most one dispatch per order. Inventory availability is derived as `physical_quantity - reserved_quantity`; database checks prevent negative or over-reserved quantities. See the [implementation guide](IMPLEMENTATION_GUIDE.md) for the workflow and change steps.