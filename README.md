# HD Recon V3

Bank Reconciliation Service built with SAP Cloud Application Programming Model (CAP).

## Overview

This application provides bank statement reconciliation functionality with fuzzy text matching against historical data. Simplified data model using `cuid, managed` for all entities with association-based relationships.

## Key Features

- Process bank statements from SAP with new field structure
- Parse payment notes (Vwezw field) into individual lines
- Fuzzy text search against historical reconciliation data
- Match tracking with confidence scores
- Simplified data model with no composite keys

## Data Model

All entities use `cuid, managed` for simplified key management and auditing.

### Entities

- **Historical**: Historical reconciliation records with wire text and posting information (cuid, managed)
- **BankStatementHeader**: Main statement records with SAP fields as regular fields, no Vwezw stored (cuid, managed)
- **BankStatementLine**: Individual lines parsed from Vwezw, associated to header via ID (cuid, managed)
- **LineMatch**: Top 3 match results for each statement line, associated to line via ID (cuid, managed)

### Key Simplifications

1. **No composite keys**: All entities use `cuid` (UUID) as primary key
2. **Association-based**: Relationships managed via associations instead of composite foreign keys
3. **Vwezw not stored**: Payment notes are parsed into lines immediately, not stored in header
4. **SAP fields as data**: Bukrs, Hbkid, Hktid, Aznum are regular fields, not keys

## API Actions

### addStatement
Add a new bank statement and process matches
- Input: All SAP fields including Vwezw (payment notes)
- Process: Creates header, parses Vwezw into lines, searches for matches
- Output: Processing results with best matches

### deleteAllStatements
Delete all statements (for testing)

## Getting Started

### Install Dependencies
```bash
npm install
```

### Development (SQLite)
```bash
npm run watch
```

### Hybrid Mode (HANA Cloud)
For vector search and production-like testing:
```bash
cds watch --profile hybrid
```

### Build & Deploy to Cloud Foundry
```bash
mbt build
cf deploy mta_archives/hd-recon-v3_1.0.0.mtar
```

## Project Structure

```
hd-recon-v3/
├── db/
│   └── schema.cds                   # Simplified data model
├── srv/
│   ├── service.cds                  # Service definition
│   └── reconciliation-service.js    # Service implementation
├── mta.yaml                         # Multi-Target Application descriptor
└── package.json                     # CAP configuration with profiles
```

## Configuration Profiles

- **development**: SQLite (default for `npm run watch`)
- **hybrid**: HANA Cloud (for local testing with HANA)
- **production**: HANA Cloud (auto-detected on Cloud Foundry)

## Field Mapping

Old structure → New structure:
- `stmtNo` + `mrNo` → Regular fields in header (Bukrs, Hbkid, Hktid, Aznum)
- Composite keys → Single `ID` (cuid) for all entities
- `paymentNotesRaw` → `Vwezw` (parsed, not stored)
- `amount` → `Kwbtr`
- `valueDate` → `Azdat`
- `currency` → `Waers`

## Notes

- Vector search requires HANA Cloud (not available in SQLite)
- For local development without HANA, fuzzy search will be limited
- Use hybrid profile to test with HANA Cloud locally
