using { reconciliation } from '../db/schema';

/**
 * Bank Reconciliation Service
 * Simple line-by-line text matching service
 */
service ReconciliationService {

  // Historical data (read-only for matching)
  // Exclude embedding field - Vector type not supported in OData
  @readonly entity Historical as projection on reconciliation.Historical excluding { embedding };

  // Cached emails (read-only for viewing)
  // Exclude embedding field - Vector type not supported in OData
  @readonly entity CachedEmails as projection on reconciliation.EmailCache excluding { embedding };

  // Bank statements
  entity Statements as projection on reconciliation.BankStatementHeader;
  entity StatementLines as projection on reconciliation.BankStatementLine;
  entity LineMatches as projection on reconciliation.LineMatch;

  /**
   * Add Statement Action
   * Input: Statement details + full payment note text from SAP (Vwezw field)
   * Process: Split into lines, search each line, save matches
   */
  action addStatement(
    Bukrs : String,
    Hbkid : String,
    Hktid : String,
    Aznum : String,
    Azdat : Date,
    Astat : String,
    Waers : String,
    Esnum : String,
    Kwbtr : Decimal,
    Vb1ok : String,
    Vb2ok : String,
    Vwezw : String    // Full multi-line payment note text
  ) returns {
    Bukrs           : String;
    Hbkid           : String;
    Hktid           : String;
    Aznum           : String;
    message         : String;
    linesProcessed  : Integer;
    matchesFound    : Integer;
    bestMatch       : {
      lineNo      : Integer;
      lineText    : String;
      wireText    : String;
      confidence  : Decimal;
      glAccount   : String;
      postingKey  : String;
    };
  };

  /**
   * Generate Embeddings Action
   * Generates vector embeddings for all historical records and cached emails
   * Uses HANA's VECTOR_EMBEDDING function with SAP_GXY.20250407 model
   */
  action generateEmbeddings() returns {
    mode              : String;
    recordsProcessed  : Integer;
    duration          : Integer;
    coverage          : String;
  };

  /**
   * Email Sync Action: Sync Emails from Outlook
   * Fetches emails from last N days via Microsoft Graph API
   * Stores locally with embeddings for smart search
   */
  action syncEmails(
    daysBack : Integer  // Number of days to fetch (default 2)
  ) returns {
    success         : Boolean;
    message         : String;
    emailsFetched   : Integer;
    emailsStored    : Integer;
    emailsSkipped   : Integer;  // Already cached
    syncBatchId     : String;
    startDate       : DateTime;
    endDate         : DateTime;
    duration        : Integer;  // milliseconds
    error           : String;
  };

  /**
   * Admin Action: Delete All Statements
   * Deletes all bank statements and their line items for testing purposes
   */
  action deleteAllStatements() returns {
    message           : String;
    statementsDeleted : Integer;
    linesDeleted      : Integer;
    matchesDeleted    : Integer;
  };

  /**
   * Admin Action: Delete All Cached Emails
   * Clears all cached emails for testing purposes
   */
  action deleteAllEmails() returns {
    message         : String;
    emailsDeleted   : Integer;
  };

  /**
   * Search Inbox Action: Search Outlook emails for matching company and amount
   * Searches Microsoft Outlook inbox using Graph API
   * Helps find payment details by searching emails with company name + amount
   */
  action searchInbox(
    companyName : String,
    amount      : Decimal,
    valueDate   : Date,
    daysBefore  : Integer,  // Days before value date to search (default: 3)
    daysAfter   : Integer   // Days after value date to search (default: 3)
  ) returns {
    success       : Boolean;
    message       : String;
    emailsFound   : Integer;
    searchQuery   : String;
    dateRange     : String;
    emails        : array of {
      subject         : String;
      sender          : String;
      receivedDate    : DateTime;
      bodyPreview     : String;
      hasAttachments  : Boolean;
      relevanceScore  : Decimal;
      amountMatch     : Boolean;
    };
  };
}
