namespace reconciliation;

using { cuid, managed } from '@sap/cds/common';

/**
 * Historical Reconciliation Data
 * Source: Excel file maintained by clerks
 * Contains successful past matches with SAP posting information
 */
@cds.search: { wireText }
entity Historical : cuid, managed {
  // What the clerk searches (from Excel "Wire Text" column)
  wireText         : String(1000);

  // SAP Posting Information (from Excel columns)
  postingKey       : String(50);      // "Pst Key"
  glAccount        : String(100);     // "GL A/c No"
  customerNo       : String(500);     // "Customer No"
  companyCode      : String(100);     // "Comp Code"
  costCentre       : String(50);      // "Cost Centre"
  profitCentre     : String(50);      // "Profit Centre"
  febanDescription : String(200);     // "FEBAN Description"
  comments         : LargeString;     // "Comments"

  // Vector embeddings for semantic search (SAP_GXY.20250407)
  embedding        : Vector(768);     // 768-dim vectors from SAP_GXY.20250407 model
}

/**
 * Cached Email Messages
 * Emails synced from Outlook via Microsoft Graph API
 * Used for smart matching when no historical match found
 */
@cds.search: { subject, bodyPreview }
entity EmailCache : cuid, managed {
  // Email metadata from Graph API
  messageId        : String(500);     // Unique Graph API message ID (for deduplication)
  conversationId   : String(500);     // Thread grouping

  // Email headers
  subject          : String(1000);    // Email subject line
  fromAddress      : String(500);     // Sender email
  fromName         : String(500);     // Sender display name
  toAddresses      : LargeString;     // Recipients (JSON array)
  receivedDateTime : DateTime;        // When email was received

  // Email content
  bodyPreview      : String(1000);    // First 255 chars of body
  bodyText         : LargeString;     // Plain text body (for search/embedding)
  bodyHtml         : LargeString;     // HTML body (for display)

  // Extracted metadata (populated during sync)
  extractedAmounts : LargeString;     // JSON array of dollar amounts found
  extractedCompanies : LargeString;   // JSON array of company names found
  extractedDates   : LargeString;     // JSON array of dates mentioned

  // Vector embeddings for semantic search (SAP_GXY.20250407)
  embedding        : Vector(768);     // 768-dim vectors from SAP_GXY.20250407 model

  // Sync tracking
  syncBatchId      : String(50);      // Which sync batch this came from
  fetchedAt        : DateTime;        // When we fetched this email

  // Match usage tracking
  matchedCount     : Integer default 0;  // How many times used in matching
  lastMatchedDate  : DateTime;           // Last time this helped a match
}

/**
 * Bank Statement Header
 * From SAP FEBRE worklist - all SAP fields stored here
 * Simplified with cuid, managed - no composite keys
 */
entity BankStatementHeader : cuid, managed {
  // SAP Fields (all as regular fields, not keys)
  Bukrs : String(4);          // Company Code
  Hbkid : String(5);          // House Bank
  Hktid : String(5);          // Account ID
  Aznum : String(18);         // Statement Number
  Azdat : Date;               // Statement Date
  Astat : String(1);          // Status
  Waers : String(5);          // Currency
  Esnum : String(5);          // External Statement Number
  Kwbtr : Decimal(15,3);      // Amount
  Vb1ok : String(1);          // Flag 1
  Vb2ok : String(1);          // Flag 2

  // Child lines parsed from Vwezw
  lines : Composition of many BankStatementLine on lines.header = $self;

  // Overall matching status
  matchStatus       : String(20);     // PENDING, MATCHED, NO_MATCH, POSTED
  bestMatchedLineNo : Integer;        // Which line had the best match
  processedBy       : String(100);
}

/**
 * Bank Statement Lines
 * Each line parsed from the Vwezw payment note field
 * Simplified with cuid, managed and association to header
 */
entity BankStatementLine : cuid, managed {
  // Association to parent statement
  header   : Association to BankStatementHeader;

  // Line details
  crn      : Integer;         // Line number (1, 2, 3... from parsing order)
  lineText : String(500);     // The actual line text from Vwezw

  // All match results for this line (top 3)
  matches : Composition of many LineMatch on matches.line = $self;

  // Clerk's selection (after review)
  selectedMatch     : Association to LineMatch;
  reviewedBy        : String(100);
  reviewedAt        : DateTime;

  // Legacy single match fields (kept for backward compatibility)
  matched           : Boolean default false;
  matchedHistorical : Association to Historical;
  matchConfidence   : Decimal(5,2);
  matchStrategy     : String(50);     // FUZZY_TEXT, VECTOR_SEMANTIC
}

/**
 * Line Match Results
 * Stores the top 3 matches found for each statement line
 * Simplified with association to line
 */
entity LineMatch : cuid, managed {
  // Association to parent line
  line : Association to BankStatementLine;

  // Match ranking
  rank : Integer;             // 1 = top match, 2 = second best, 3 = third best

  // Reference to historical record that matched
  historical : Association to Historical;

  // Match quality metrics
  confidence : Decimal(5,2);  // 0-100 percentage
  strategy   : String(50);    // VECTOR_SEMANTIC, FUZZY_TEXT, etc.

  // Denormalized posting fields (for quick display without joins)
  wireText         : String(1000);
  postingKey       : String(50);
  glAccount        : String(100);
  customerNo       : String(500);
  companyCode      : String(100);
  costCentre       : String(50);
  profitCentre     : String(50);
  wbsElement       : String(50);
  febanDescription : String(200);

  // Selection tracking
  isSelected       : Boolean default false;
  selectedAt       : DateTime;
  selectedBy       : String(100);
}
