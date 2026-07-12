# AR remittance reconciliation (Coles) — 2026-07-12

## 1. Parser checksum
  payment_no | header_total | line_sum | lines
  3300004309 | 1898521.87 | 1898521.87 | 72
  3300005573 | 1169.41 | 1169.41 | 2
PASS  Σ line payment == header total (every advice) — 2 advice(s)

## 2. Reconciliation buckets
  recon_status | lines | document_amount
  matched | 71 | 1952198.17
  claim | 2 | -4171.20
  unmatched | 1 | 374.40
PASS  every line classified (no null recon_status) — null recon_status = 0

### Investigate list (claim / unmatched / amount_mismatch)
  payment_no | invoice_no | doc_type | recon_status | doc_amt | our_inv_amt | variance | customer
  3300004309 | 1295067 | LJ | claim | -4996.2 | ∅ | ∅ | ∅
  3300005573 | REV1294074 | LJ | claim | 825 | ∅ | ∅ | ∅
  3300005573 | FT003402A | KD | unmatched | 374.4 | ∅ | ∅ | ∅

## 3. Matched lines: variance vs our invoice + Coles settlement discount
  matched_lines | total_abs_variance | exact_ties | avg_discount_pct
  71 | 0.00 | 71 | 2.500
PASS  all matched lines tie to our invoice amount (variance ≈ 0) — matched=71 exact=71
PASS  Coles settlement discount ≈ 2.5% — avg discount = 2.500%

## 4. Matched-invoice NetSuite paid-status corroboration
  invoice_paid_status | lines
  paid | 71