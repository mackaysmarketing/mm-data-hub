# Revenue-class checkpoint — full settled charge list (SPRINT chunk 1)

Generated from the hub (settled = `gp_schedule_id IS NOT NULL`, deductible only).

**Mark each charge** with one of: `commission` / `ripening` / `other_service` /
`cost_recovery` / `pass_through` / `na`. Only `ct_scope = 'WH - Ripening'` is
PRE-PROPOSED (per SPRINT); everything else is deliberately unproposed — nothing was guessed.
Mackays revenue = classes {commission, ripening, other_service}.

Ripening tie anchor: ct_scope 'WH - Ripening' settled deductible sum = **$6379588.03** across 9663 applied rows.

| # | charge name | ct_scope | ct_code | account_code | category | subcategory | applied rows | applied $ | PROPOSED | **TIM: revenue_class** |
|---|---|---|---|---|---|---|---:|---:|---|---|
| 1 | Freight | FR - Fatigue Levy | 100000 | 611201-611202-260-710-509-03 | FR | Fatigue Levy | 19337 | 9276483.16 |  | |
| 2 | FR - Blenners - Outside Market Delivery Fee | Freight | 100000 | 611275-611276-260-710-509-03 | FR | Blenners - Outside Market Delivery Fee | 2 | 1795.20 |  | |
| 3 | FR - Blenners - Fatigue Levy - DO NOT USE | FREIGHT | 100000 | 611274-611275-260-710-509-03 | FR | Blenners - Fatigue Levy - DO NOT USE | 2 | 10.00 |  | |
| 4 | LA - Freight - Blenners | MD-Load Adjustment | 500000 | 611274-611275-260-710-509-03 | LA | Load Adjustment | 12 | 9630.20 |  | |
| 5 | LA - Papaya Sales | MD-Load Adjustment | 500000 | 641260-641261-260-710-509-02 | LA | Load Adjustment | 5 | 3770.00 |  | |
| 6 | LA - Ripening - Truganina Banana 15kg | MD-Load Adjustment | 500000 | 641321-641322-260-515-521-03 | LA | Load Adjustment | 3 | 2821.50 |  | |
| 7 | LA - Commission - 4.5% | MD-Load Adjustment | 500000 | 611298-418045-260-710-509-03 | LA | Load Adjustment | 12 | 2785.23 |  | |
| 8 | LA - Retail Rebate - Coles 2.5% | MD-Load Adjustment | 500000 | 611202-611201-260-710-509-04 | LA | Load Adjustment | 5 | 1612.62 |  | |
| 9 | LA - Packaging Fees - Coles Band Fee Bananas | MD-Load Adjustment | 500000 | 611298-611251-260-710-509-03 | LA | Load Adjustment | 1 | 1531.20 |  | |
| 10 | LA - Ripening - Truganina - Coles Kids Packs | MD-Load Adjustment | 500000 | 641321-641322-260-515-521-03 | LA | Load Adjustment | 1 | 1188.00 |  | |
| 11 | LA - Freight - Other | MD-Load Adjustment | 500000 | 611271-418070-260-710-509-03 | LA | Load Adjustment | 4 | 721.92 |  | |
| 12 | LA - Freight - Coles Collect | MD-Load Adjustment | 500000 | 611278-611279-260-710-509-03 | LA | Load Adjustment | 5 | 665.63 |  | |
| 13 | LA - Banana Compulsory | MD-Load Adjustment | 500000 | 611298-611225-260-710-509-04 | LA | Load Adjustment | 5 | 549.46 |  | |
| 14 | LA - Panama Voluntary | MD-Load Adjustment | 500000 | 611298-611237-260-710-509-03 | LA | Load Adjustment | 5 | 317.63 |  | |
| 15 | LA-Commission-3% | MD-Load Adjustment | 500000 | 611298-418045-260-710-509-03 | LA | Load Adjustment | 12 | 184.59 |  | |
| 16 | LA - SQBR Unloading Fee | MD-Load Adjustment | 500000 | 611298-611253-260-710-509-03 | LA | Load Adjustment | 2 | 105.81 |  | |
| 17 | LA - WH - Quarantine Netting - Truganina - Coles Tasmania per pallet | MD-Load Adjustment | 500000 | 641324-641325-260-515-521-03 | LA | Load Adjustment | 1 | 99.00 |  | |
| 18 | LA - Load Adjustment - Levy ABGC | MD-Load Adjustment | 500000 | 611298-611221-260-710-509-03 | LA | Load Adjustment | 3 | 55.36 |  | |
| 19 | LA - Load Adjustment - Labelling Truganina - Semi Ripe 15kg | MD-Load Adjustment | 500000 | 641324-641325-260-515-521-03 | LA | Load Adjustment | 2 | 6.73 |  | |
| 20 | LA - Banana Import Levy | MD-Load Adjustment | 500000 | 611233 -611234--260-710-509-04 | LA | Load Adjustment | 2 | -4.55 |  | |
| 21 | LA - Freight Credit - Blenners | MD-Load Adjustment | 500000 | 611274-611275-260-710-509-03 | LA | Load Adjustment | 1 | -66.07 |  | |
| 22 | LA - Ripening - QPI Banana 15kg | MD-Load Adjustment | 500000 | 641321-641322-260-710-509-03 | LA | Load Adjustment | 1 | -185.50 |  | |
| 23 | LA - Commission - Agent | MD-Load Adjustment | 500000 | 611298-418045-260-710-509-03 | LA | Load Adjustment | 8 | -1825.20 |  | |
| 24 | LA - Banana Sales | MD-Load Adjustment | 500000 | 641210-641211-260-710-509-02 | LA | Load Adjustment | 27 | -43980.76 |  | |
| 25 | MD - Commission - Coles 4.5% | MD - Commission | 310000 | 611298-418045-260-710-509-03 | MD | Commission | 6960 | 4057249.49 |  | |
| 26 | MD - Commission - Woolworths 4.5% | MD - Commission | 310000 | 611298-418045-260-710-509-03 | MD | Commission | 4103 | 2455159.41 |  | |
| 27 | MD - Retail Rebate - Coles 2.5% | MD - Retail Rebate | 330000 | 611202-611201-260-710-509-04 | MD | Retail Rebate | 7244 | 2351887.37 |  | |
| 28 | MD - Retail Rebate - Woolworths 2.5% | MD - Retail Rebate | 330000 | 611202-611201-260-710-509-04 | MD | Retail Rebate | 4103 | 1398941.43 |  | |
| 29 | MD - Levy - Banana Compulsory | MD- Levy C | 320000 | 611298-611225-260-710-509-04 | MD | Levy C | 6813 | 1338289.22 |  | |
| 30 | MD - Packaging Fees - Coles Band Fee Bananas | MD - Packaging | 340000 | 611298-611251-260-710-509-03 | MD | Packaging | 1782 | 754081.20 |  | |
| 31 | MD - Levy - Panama Voluntary | MD- Levy | 320000 | 611298-611237-260-710-509-03 | MD | Levy | 5840 | 616094.41 |  | |
| 32 | MD - Commission - Aldi 4.5% | MD - Commission | 310000 | 611298-418045-260-710-509-03 | MD | Commission | 2096 | 595232.96 |  | |
| 33 | MD - Packaging Fees - WOW Collar Fee - Bananas | MD - Packaging | 340000 | 611298-611251-260-710-509-03 | MD | Packaging | 784 | 490304.67 |  | |
| 34 | MD - Commission - Wholesale 3% | MD - Commission | 310000 | 611298-418045-260-710-509-03 | MD | Commission | 4021 | 401144.74 |  | |
| 35 | MD - Levy - ABGC | MD- Levy | 320000 | 611298-611221-260-710-509-03 | MD | Levy | 5330 | 89338.79 |  | |
| 36 | MD - Levy - Banana Import Voluntary | MD- Levy | 320000 | 611298-611233-260-710-509-04 | MD | Levy | 2267 | 85992.79 |  | |
| 37 | MD - Levy - Avocado Compulsory | MD- Levy C | 320000 | 611298-611223-260-710-509-04 | MD | Levy C | 1295 | 61947.83 |  | |
| 38 | MD - Commission - Agent | MD - Commission | 310000 | 611298-418045-260-710-509-03 | MD | Commission | 177 | 53562.58 |  | |
| 39 | MD - Levy - Papaya Compulsory | MD- Levy C | 320000 | 611298-611227-260-710-509-04 | MD | Levy C | 2490 | 47179.54 |  | |
| 40 | MD - Inspection Fee - WA DAWR Inspection Fee | MD - Inspection Fees | 360000 | 611262-611261-260-710-509-04 | MD | Inspection Fees | 210 | 15633.55 |  | |
| 41 | MD - Promotion - Aldi Camp Quality Donation | MD - Promotion | 350000 | 611241-611279-260-710-509-04 | MD | Promotion | 5 | 14520.00 |  | |
| 42 | MD - Promotion - Coles Little Athletics Incentive | MD - Promotion | 350000 | 611298-611243-260-710-509-04 | MD | Promotion | 9 | 9915.32 |  | |
| 43 | MD - Levy - Passionfruit 5kg | MD- Levy P | 320000 | 611298-611299-260-710-509-04 | MD | Levy P | 148 | 4203.20 |  | |
| 44 | MD - Commission - Woolworths Avos 4% | MD - Commission | 310000 | 611298-418045-260-710-509-03 | MD | Commission | 14 | 1600.13 |  | |
| 45 | MD - Retail Rebate - Woolworths 3% - Avocado | MD - Retail Rebate | 330000 | 611202-611201-260-710-509-04 | MD | Retail Rebate | 14 | 1237.23 |  | |
| 46 | MD - Promotion - WOW Hass Promotional Levy | MD - Promotion | 350000 | 611298-611245-260-710-509-03 | MD | Promotion | 15 | 840.40 |  | |
| 47 | MD - Promotion - WOW Banana Promotional Levy | MD - Promotion | 350000 | 611298-611245-260-710-509-03 | MD | Promotion | 2 | 740.00 |  | |
| 48 | MI - Brismark Testing | MI - | 410000 | 611298-611255-260-710-509-03 | MI | Brismark Testing | 58 | 10762.45 |  | |
| 49 | WH - Ripening - Truganina - Banana 15kg | WH - Ripening | 210000 | 641321-641322-260-515-521-03 | WH | Ripening | 2637 | 3925803.57 | ripening | |
| 50 | WH - Ripening - Larapinta - Banana 15kg | WH - Ripening | 210000 | 641321-641322-260-515-511-03 | WH | Ripening | 1099 | 743604.76 | ripening | |
| 51 | WH - Ripening - Ann Rd - Banana 15kg | WH - Ripening | 210000 | 641321-641322-260-515-508-03 | WH | Ripening | 2259 | 642210.09 | ripening | |
| 52 | WH - Ripening - Truganina - Coles Kids Packs | WH - Ripening | 210000 | 641321-641322-260-515-521-03 | WH | Ripening | 1400 | 525017.25 | ripening | |
| 53 | WH - Ripening - QPI - Banana 15kg | WH - Ripening | 210000 | 641321-641322-260-710-509-03 | WH | Ripening | 365 | 152666.50 | ripening | |
| 54 | WH - Ripening - Ann Rd - WOW Collars | WH - Ripening | 210000 | 641321-641322-260-515-508-03 | WH | Ripening | 384 | 97428.13 | ripening | |
| 55 | WH - Handling - Larapinta - Papaya 10kg | WH - Handling | 220000 | 641361-641362-260-515-511-03 | WH | Handling | 378 | 84355.17 |  | |
| 56 | WH - Ripening - Truganina - Avocado Trays | WH - Ripening | 210000 | 641306-641307-260-515-521-03 | WH | Ripening | 361 | 78424.36 | ripening | |
| 57 | WH - Ripening - Ann Rd - Coles Kids Packs | WH - Ripening | 210000 | 641321-641322-260-515-508-03 | WH | Ripening | 381 | 73781.35 | ripening | |
| 58 | WH - Handling - Larapinta - Papaya 6kg | WH - Handling | 220000 | 641361-641362-260-515-511-03 | WH | Handling | 658 | 67959.54 |  | |
| 59 | WH - Ripening - Ann Rd - Avocado Trays | WH - Ripening | 210000 | 641306-641307-260-515-508-03 | WH | Ripening | 239 | 45156.10 | ripening | |
| 60 | WH - Handling - Truganina - Papaya 6kg | WH - Handling | 220000 | 641361-641362-260-515-521-03 | WH | Handling | 173 | 37052.19 |  | |
| 61 | WH - Labelling - Truganina - Semi Ripe 15kg | WH - Labelling | 230000 | 641324-641325-260-515-521-03 | WH | Labelling | 658 | 34055.24 |  | |
| 62 | WH - Packing - Simply Fruits - Im Perfect - Hass | WH - Packing | 240000 | 611298-611257-260-710-509-03 | WH | Packing | 57 | 26545.50 |  | |
| 63 | WH - Handling - APP EC - Papaya 6kg | WH - Handling | 220000 | 611298-611253-260-710-509-03 | WH | Handling | 256 | 26140.00 |  | |
| 64 | WH - Handling - Simply Fruits - Papaya 6kg | WH - Handling | 220000 | 611298-611253-260-710-509-03 | WH | Handling | 394 | 25384.00 |  | |
| 65 | WH - Packing - Murray Bros -Avocado 5 Pack - Shepard | WH - Packing | 240000 | 611298-611257-260-710-509-03 | WH | Packing | 47 | 24740.64 |  | |
| 66 | WH - Ripening - Larapinta - Banana 13kg | WH - Ripening | 210000 | 641321-641322-260-515-511-03 | WH | Ripening | 61 | 23714.88 | ripening | |
| 67 | WH - Handling - Larapinta - Passionfruit 5kg | WH - Handling | 220000 | 641364-641365-260-515-511-03 | WH | Handling | 193 | 20203.04 |  | |
| 68 | WH - Ripening - Larapinta - WOW Collars | WH - Ripening | 210000 | 641321-641322-260-515-511-03 | WH | Ripening | 32 | 19758.60 | ripening | |
| 69 | WH - Quarantine Netting - Truganina - Coles Tasmania per pallet | WH - Packaging | 260000 | 641324-641325-260-515-521-03 | WH | Packaging | 291 | 18325.50 |  | |
| 70 | WH - Handling - Ann Rd - Papaya 10kg | WH - Handling | 220000 | 641361-641362-260-515-508-03 | WH | Handling | 345 | 18311.44 |  | |
| 71 | WH - Packing - Simply Fruits - Avocado 5 Pack - Hass | WH - Packing | 240000 | 611298-611257-260-710-509-03 | WH | Packing | 31 | 16779.00 |  | |
| 72 | WH - Ripening - Larapinta - Avocado Trays | WH - Ripening | 210000 | 641306-641307-260-515-511-03 | WH | Ripening | 65 | 15694.90 | ripening | |
| 73 | WH - Packing - Murray Bros -Im Perfect - Shepard | WH - Packing | 240000 | 611298-611257-260-710-509-03 | WH | Packing | 46 | 15603.84 |  | |
| 74 | WH - Handling - Ann Rd - Papaya 6kg | WH - Handling | 220000 | 641361-641362-260-515-508-03 | WH | Handling | 235 | 12184.16 |  | |
| 75 | WH - Ripening - Epping - Banana 15kg | WH - Ripening | 210000 | 641321-641322-260-515-526-03 | WH | Ripening | 6 | 8268.00 | ripening | |
| 76 | WH - Ripening - Ann Rd - Banana 10kg | WH - Ripening | 210000 | 641321-641322-260-515-508-03 | WH | Ripening | 155 | 7529.76 | ripening | |
| 77 | WH - Ripening - Ann Rd - Banana 13kg | WH - Ripening | 210000 | 641321-641322-260-515-508-03 | WH | Ripening | 102 | 7009.92 | ripening | |
| 78 | WH - Ripening - Ann Rd - Lady Fingers | WH - Ripening | 210000 | 641321-641322-260-515-508-03 | WH | Ripening | 90 | 6769.68 | ripening | |
| 79 | WH - Handling - APP Eastern Creek - Hourly Labour Charge - Papaya | WH  - Handling | 220000 | 611298-611253-260-710-509-03 | WH | Handling | 12 | 5430.00 |  | |
| 80 | WH - Handling - Truganina - Mumford Wholesalers | WH - Handling | 220000 | 611298-641253-260-515-521-03 | WH | Handling | 18 | 4448.40 |  | |
| 81 | WH - Ripening - Truganina - Banana 13kg | WH - Ripening | 210000 | 641321-641322-260-515-521-03 | WH | Ripening | 4 | 3415.50 | ripening | |
| 82 | WH - Storage - Fruit Wheels - Fruit WheelsCold Storage | WH - Storage | 250000 | 611298-511055-260-710-509-03 | WH | Storage | 117 | 2878.01 |  | |
| 83 | WH - Ripening - DBM - Coles Bands | WH - Ripening | 210000 | 641321-641322-260-710-509-03 | WH | Ripening | 2 | 1749.00 | ripening | |
| 84 | WH - Handling - Larapinta - Banana 15kg (Green) | WH - Handling | 220000 | 641324-641325-260-515-511-03 | WH | Handling | 1 | 1216.44 |  | |
| 85 | WH - Ripening - Epping - Banana 13kg | WH - Ripening | 210000 | 641321-641322-260-515-526-03 | WH | Ripening | 3 | 1049.40 | ripening | |
| 86 | WH - Handling - Larapinta - Hourly Labour Charge - Bananas | WH  - Handling | 220000 | 641324-641325-260-515-511-03 | WH | Handling | 2 | 1000.00 |  | |
| 87 | WH - Handling - Truganina - Cross Dock Bananas | WH - Handling | 220000 | 641324-641325-260-515-521-03 | WH | Handling | 4 | 860.00 |  | |
| 88 | WH - Ripening - Ann Rd - Organics 10kg | WH - Ripening | 210000 | 641321-641322-260-515-508-03 | WH | Ripening | 18 | 536.28 | ripening | |
| 89 | WH - Handling - Costas Adelaide - Cooling Fee - Prepacks | WH - Handling | 220000 | 611298-611253-260-710-509-03 | WH | Handling | 3 | 243.54 |  | |
| 90 | WH - Labelling - Larapinta - Eat Later 15kg | WH - Labelling | 230000 | 641324-641325-260-515-511-03 | WH | Labelling | 1 | 235.44 |  | |
| 91 | WH - Handling - Truganina - Papaya 10kg | WH - Handling | 220000 | 641361-641362-260-515-521-03 | WH | Handling | 3 | 146.16 |  | |
| 92 | WH - Handling - Truganina - Cross Dock Avocados | WH - Handling | 220000 | 641324-641325-260-515-521-03 | WH | Handling | 1 | 120.00 |  | |
| 93 | WH - Handling - Costas Adelaide - Cooling Fee - 15kg | WH - Handling | 220000 | 611298-611253-260-710-509-03 | WH | Handling | 1 | 118.80 |  | |
| 94 | WH - Handling - SQBR - SQBR Unloading Fee 15kg | WH - Handling | 220000 | 611298-611253-260-710-509-03 | WH | Handling | 1 | 86.00 |  | |
| 95 | WH - Handling - SQBR - SQBR Unloading Fee 13kg | WH - Handling | 220000 | 611298-611253-260-710-509-03 | WH | Handling | 1 | 85.00 |  | |
| 96 | WH - Handling - Ann Rd - Cross Dock Bananas | WH - Handling | 220000 | 641324-641325-260-515-508-03 | WH | Handling | 1 | 80.00 |  | |

## Settled applied rows with NO charge_id (cannot carry revenue_class — it lives on the charge dim)

These classify by line account_code only. If any must count as Mackays revenue,
that needs a separate account-code rule — flag it in the marking.

| account_code | sample label | applied rows | applied $ |
|---|---|---:|---:|
| 121035 | FR - Blenners - Road - Lakeland to Victoria  - Chilled per 15kg carton Split 100.0% 15kg Carton | 42 | 182756.30 |
| 121023 | FR - Blenners - Road - Tully to Perth - Chilled per 15kg carton   Split 100.0% 15kg Carton | 25 | 152461.16 |
| 103003 | FR - Coles Collect - Road - Truganina to Adelaide - Chilled per Space  Split 100.0% 15kg Carton | 164 | 121819.56 |
| 121010 | FR - Blenners - Road - Tully to Brisbane - Chilled per 15kg carton   Split 100.0% 15kg Carton | 48 | 116318.73 |
| 121034 | FR - Blenners - Road - Lakeland to Victoria   Split 25.0% 5kg Carton | 37 | 115452.94 |
| 121030 | FR - Blenners - Road - Lakeland to Brisbane - Chilled per 15kg carton   Split 100.0% 15kg Carton | 25 | 86643.56 |
| 121020 | FR - Blenners - Road - Tully to Victoria - Chilled per 15kg carton   Split 100.0% 15kg Carton | 20 | 81552.96 |
| 121008 | FR - Blenners - Road - Tully to Townsville - Chilled per Space   Split 0.9% Avo Tray | 658 | 74016.86 |
| 103001 | FR - Coles Collect - Road - Truganina to Truganina - Chilled per Space  Split 0.4% 15kg Carton | 691 | 73746.49 |
| 121016 | FR - Blenners - Road - Tully to Sydney - Chilled per 13kg carton   Split 100.0% 13kg Carton | 41 | 50265.51 |
| 121019 | FR - Blenners - Road - Tully to Victoria - Chilled per 13kg carton   Split 100.0% Coles Bands | 21 | 48968.95 |
| 116004 | FR - DDS - Road - Larapinta  to Brendale  - Chilled per Space  Split 1.6% 6kg Tray - Papaya | 202 | 43708.47 |
| 121002 | FR - Blenners - Rail - Tully to Brisbane - Chilled per 15kg Carton Split 100.0% 15kg Carton | 14 | 42925.17 |
| 102007 | FR - Followmont Transport - Road - Tully to Melbourne - Chilled per Space Split 0.8% 10kg Carton | 129 | 42684.92 |
| 121037 | FR - Blenners - Road - Lakeland to Perth - Chilled per 15kg carton   Split 100.0% 15kg Carton | 8 | 35275.38 |
| 121028 | FR - Blenners - Road - Lakeland to Townsville  - Chilled per Space Split 100.0% 15kg Carton | 28 | 31020.00 |
| 121039 | FR - Blenners - Road - Lakeland to Adelaide - Chilled per 15kg carton   Split 100.0% 15kg Carton | 12 | 26849.27 |
| 102004 | FR - Followmont Transport - Road - Tully to Sydney - Chilled per Space Split 0.7% 10kg Carton | 103 | 26240.50 |
| 121022 | FR - Blenners - Road - Tully to Perth - Chilled per 13kg carton   Split 100.0% 13kg Carton | 10 | 25942.96 |
| 121036 | FR - Blenners - Road - Lakeland to Perth - Chilled per 13kg carton   Split 100.0% 13kg Carton | 8 | 23451.24 |
| 121032 | FR - Blenners - Road - Lakeland to Sydney - Chilled per 13kg carton   Split 100.0% 13kg Carton | 8 | 17491.84 |
| 121049 | FR - Blenners - Rail - Lakeland to Brisbane - Chilled per Space Split 100.0% 15kg Carton | 6 | 17185.52 |
| 116005 | FR - DDS - Road - Larapinta  to Stapylton  - Chilled per Space Split 10.4% 15kg Carton | 105 | 17052.32 |
| 121031 | FR - Blenners - Road - Lakeland to Brisbane  - Chilled per Space Split 10.0% 5kg Carton | 19 | 16147.26 |
| 121011 | FR - Blenners - Road - Tully to Brisbane - Chilled per Space   Split 0.7% 10kg Carton | 44 | 15534.22 |
| 121017 | FR - Blenners - Road - Tully to Sydney - Chilled per 15kg carton   Split 100.0% 15kg Carton | 4 | 13416.58 |
| 121033 | FR - Blenners - Road - Lakeland to Sydney - Chilled per 15kg carton   Split 100.0% 15kg Carton | 7 | 11550.15 |
| 121009 | FR - Blenners - Road - Tully to Brisbane - Chilled per 13kg carton   Split 100.0% 13kg Carton | 19 | 10946.17 |
| 121005 | FR - Blenners - Road - Tully to Tully - Chilled per Hourly Body Truck Split 1.4% 10kg Carton | 168 | 10818.59 |
| 121098 | FR - Blenners - Road - Chilled per Space Outside Market Fee Split 1.4% 10kg Carton | 67 | 6031.03 |
| 121029 | FR - Blenners - Road - Lakeland to Brisbane - Chilled per 13kg carton   Split 100.0% 13kg Carton | 6 | 5271.17 |
| 102002 | FR - Followmont Transport - Road - Tully to Brisbane - Chilled per Space Split 1.4% 10kg Carton | 35 | 5214.88 |
| 102010 | FR - Followmont Transport - Road - Tully to Adelaide - Chilled per Space Split 16.7% 10kg Carton | 6 | 4077.51 |
| 101146 | FR - Lindsay Transport - Road - Larapinta  to Melbourne - Chilled per Space Papaya Split 100.0% 10kg Carton | 27 | 3813.26 |
| 121026 | FR - Blenners - Road - Lakeland to Tully - Chilled per Space   Split 100.0% 15kg Carton | 5 | 3396.23 |
| 121012 | FR - Blenners - Road - Tully to Labrador - Chilled per Space  Split 0.7% 10kg Carton | 13 | 3186.48 |
| 121099 | FR - Blenners - Road - Chilled per Container/ Truck Fatigue Levy Split 0.6% 10kg Carton | 1234 | 3155.45 |
| 116001 | FR - DDS - Road - Larapinta  to Larapinta  - Chilled per Space Split 0.5% 10kg Carton | 83 | 3085.26 |
| 102011 | FR - Followmont Transport - Road - Melbourne to Melbourne - Chilled per Space Split 1.4% 10kg Carton | 77 | 2533.29 |
| 120006 | FR - Woolworths Primary Connect -Road - Tasmania to Melbourne Markets - Chilled per Space  Split 100.0% 15kg Carton | 1 | 2460.62 |
| 121091 | FR - Blenners - Road - Tully  to Townsville  - Chilled per Space  Avocado Split 100.0% Avo Tray | 27 | 1660.70 |
| 101002 | FR - Lindsay Transport - Road - Larapinta  to Eastern Creek - Chilled per Space  Split 100.0% 5kg Carton | 18 | 1533.98 |
| 101001 | FR - Lindsay Transport - Road - Larapinta  to Sydney   - Chilled per Space  Split 100.0% 5kg Carton | 10 | 1530.00 |
| 107001 | FR - Own Transport - Road - Melbourne to Melbourne - Chilled per Space Simply Fruits Split 100.0% 6kg Tray - Papaya | 69 | 1500.02 |
| 101147 | FR - Lindsay Transport - Road - Larapinta to Townsville - Chilled per Space  Split 100.0% 15kg Carton | 1 | 1450.15 |
| 102008 | FR - Followmont Transport - Road - Tully to Melbourne - Chilled per Papaya Carton Split 0.8% 10kg Carton | 17 | 1251.03 |
| 103002 | FR - Coles Collect - Road - Truganina to Tasmania - Chilled per Space Split 100.0% Coles Bands | 58 | 1161.60 |
| 108003 | FR - Fruit Wheels - Road - Sydney Markets  to Minchinbury  - Chilled per Space Split 0.7% 10kg Carton | 42 | 1091.67 |
| 116006 | FR - DDS - Road - Larapinta  to Brisbane Markets - Chilled per Space SGBNE Split 100.0% 15kg Carton | 28 | 990.00 |
| 107003 | FR - Own Transport - Road - Melbourne to Melbourne - Chilled per Space Simply Fruits - Coles Im Perfect Split 100.0% Coles Im Perfect Crate | 21 | 868.76 |
| 121083 | FR - Blenners - Road - Lakeland  to Brisbane  - Chilled per Space  Passionfruit Split 29.2% 5kg Carton | 4 | 849.60 |
| 108001 | FR - Fruit Wheels - Road - Sydney Markets  to Eastern Creek - Chilled per Space Split 100.0% 6kg Tray - Papaya | 24 | 739.83 |
| 101003 | FR - Lindsay Transport - Road - Larapinta  to Minchinbury  - Chilled per Space  Split 100.0% 5kg Carton | 9 | 723.37 |
| 116002 | FR - DDS - Road - Larapinta  to Parkinson  - Chilled per Space Split 100.0% 5kg Carton | 36 | 705.55 |
| 102013 | FR - Followmont Transport - Road - Chilled per Space Pallet fee Split 0.2% 10kg Carton | 279 | 584.70 |
| 116007 | FR - DDS - Road - Larapinta  to Labrador - Chilled per Space  Split 100.0% 15kg Carton | 1 | 566.25 |
| 107002 | FR - Own Transport - Road - Melbourne to Melbourne - Chilled per Space Simply Fruits - Coles Split 100.0% Coles 5 Pack Crate | 9 | 450.00 |
| 121041 | FR - Blenners - Road - Brisbane to Brisbane - Chilled per Space Split 100.0% 15kg Carton | 1 | 421.18 |
| 121001 | FR - Blenners - Road - Tully to Brisbane - Chilled per Space  Split 50.0% 6kg Tray - Papaya | 2 | 368.16 |
| 102009 | FR - Followmont Transport - Road - Tully to Melbourne - Chilled per Papaya Tray Split 100.0% 6kg Tray - Papaya | 1 | 353.89 |
| 111006 | FR - Robinson's Fresh Solutions - Road - Truganina to Melbourne Markets - Chilled per Space (1-4 Spaces) Split 100.0% 15kg Carton | 2 | 230.14 |
| 121069 | FR - Blenners - Road - Chilled per Container/ Truck Fatigue Levy Split 10.0% 15kg Carton | 78 | 138.97 |
| 121100 | FR - Blenners -per Pallet Public Holiday Rate Split 100.0% 15kg Carton | 3 | 135.00 |
| 116003 | FR - DDS - Road - Larapinta  to Brisbane Markets - Chilled per Space Split 100.0% 15kg Carton | 5 | 108.00 |
| 107004 | FR - Own Transport - Road - Eastern Creek to Sydney Markets  - Chilled per Space  - APP Split 46.2% 6kg Tray - Papaya | 2 | 45.00 |
| 111011 | FR - Robinson's Fresh Solutions - Road - Truganina to Melbourne Markets - Chilled per Space Passionfruit Split 100.0% 5kg Carton | 1 | 37.59 |
