# Replica ORDER-domain schema snapshot (A0) — 2026-07-01
Source: FreshTrack read-replica (public.order / order_version / order_item). READ-ONLY.

## public.order — 21192 rows, 40 columns
```
  id                             uuid  NOT NULL
  type                           character varying  NOT NULL
  order_no                       character varying  NOT NULL
  sales_order_no                 character varying  NOT NULL
  po_no                          character varying  NOT NULL
  scheduled_pickup_on            timestamp with time zone
  actual_pickup_on               timestamp with time zone
  scheduled_delivery_on          timestamp with time zone
  actual_delivery_on             timestamp with time zone
  is_archived                    boolean  NOT NULL
  created_on                     timestamp with time zone  NOT NULL
  last_modified_on               timestamp with time zone  NOT NULL
  consignee_id                   uuid
  consignor_id                   uuid
  market_area_id                 uuid
  marketer_id                    uuid
  load_description               text  NOT NULL
  comment                        text  NOT NULL
  state_id                       uuid  NOT NULL
  attached_document_count        integer  NOT NULL
  edi_status                     character varying
  gs1_order_type                 character varying
  parent_id                      uuid
  shed_id                        uuid
  supplier_id                    uuid
  highlights                     text  NOT NULL
  is_edi                         boolean  NOT NULL
  delivery_contact_id            uuid
  b2b_integration_id             uuid
  allocation_percentage          numeric
  production_percentage          numeric
  total_ordered                  integer
  info                           text  NOT NULL
  pallet_overview                text  NOT NULL
  sale_entity_id                 uuid
  priority                       smallint
  discount_currency              character varying  NOT NULL
  discount_percentage            numeric
  discount_value                 numeric
  payment_term_id                uuid
```

## public.order_version — 35900 rows, 6 columns
```
  id                             uuid  NOT NULL
  version_no                     integer  NOT NULL
  received_on                    timestamp with time zone
  created_on                     timestamp with time zone  NOT NULL
  last_modified_on               timestamp with time zone  NOT NULL
  order_id                       uuid  NOT NULL
```

## public.order_item — 73212 rows, 32 columns
```
  id                             uuid  NOT NULL
  pallet_count                   integer  NOT NULL
  boxes_per_pallet               integer  NOT NULL
  price_value                    numeric
  price_currency                 character varying  NOT NULL
  price_per                      character varying  NOT NULL
  total_box_count                integer
  total_price_value              numeric
  created_on                     timestamp with time zone  NOT NULL
  last_modified_on               timestamp with time zone  NOT NULL
  product_id                     uuid  NOT NULL
  order_version_id               uuid  NOT NULL
  remitted_price_currency        character varying  NOT NULL
  remitted_price_value           numeric
  bottom_hi                      integer
  ti                             integer
  is_split                       boolean  NOT NULL
  top_hi                         integer
  unsplit_hi                     integer
  hand_stack                     integer  NOT NULL
  line_no                        integer
  shed_id                        uuid
  ean13                          character varying
  ean14                          character varying
  item_no                        character varying
  dispatch_load_id               uuid
  proposed_price_currency        character varying  NOT NULL
  proposed_price_value           numeric
  proposed_quantity              integer
  discount_currency              character varying  NOT NULL
  discount_percentage            numeric
  discount_value                 numeric
```

## A0 depended-on columns
  order_item.total_box_count         PRESENT
  order_item.price_value             PRESENT
  order_item.price_currency          PRESENT
  order_item.price_per               PRESENT
  order_item.total_price_value       PRESENT
  order.total_price_value            **ABSENT**
  order.latest_version_no            **ABSENT**
  order.total_ordered                PRESENT
  order.last_modified_on             PRESENT
  order_version.last_modified_on     PRESENT
  order_item.last_modified_on        PRESENT
  order_item.dispatch_load_id        PRESENT
  order_version.version_no           PRESENT
  order_version.order_id             PRESENT

## order.type distribution
  S: 21192

## order_item.price_currency distribution
  AUD: 73212

## order_item.price_per distribution
  BOX: 73194
  WEIGHT_UNIT: 18

## versioning
  orders with versions: 21184; with >1 version: 8274; max versions on one order: 15
  order_item rows with no resolvable order_version: 0
  order_item lines: 73212 total; 35967 on the latest version (rest superseded)

## reconciliation identity (current-version line rollup; N=200 sample sell orders)
  sample orders: 200
  Σ total_box_count: 88220
  Σ native line total_price_value: 834654.30
  Σ derived (BOX→boxes×price, PALLET→pallets×price, else native): 834654.30
  orders where derived == native (±0.01): 200/200

## non-AUD order_item price rows: 0

## test entities on replica (code ILIKE %TEST)
  ANNRTEST active=false consignor=0196cd8e-45e8-5404-46c6-edbc24616938 consignee=0196cd8e-45ef-24e1-a377-d0185cf49648 marketer=∅
  LARATEST active=false consignor=0196cd8d-8298-e55a-6c14-aaab4cbae095 consignee=0196cd8d-829e-c4a2-990b-568eeaabc37b marketer=∅
  TRUGTEST active=false consignor=0196ccf2-b8d1-15c4-06ae-c09a10e8f722 consignee=0196ccf2-b8d7-8a7d-e641-e5efbfd71a67 marketer=∅

