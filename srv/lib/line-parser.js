/**
 * Line Parser for Bank Payment Notes
 *
 * Handles different line types (BO, ORDER, FR, etc.) and extracts
 * the relevant portion for matching.
 */

/**
 * Line Type Patterns
 * Note: Patterns now flexible with whitespace to handle various input formats
 */
const LINE_PATTERNS = {
  BO: /^BO\s*:/i,        // Buyer Order: BO:1000250198610 or BO :... or BO DUMMY:
  BO1: /BO1\s*:/i,       // Buyer Order Name (allows spaces before colon)
  BO2: /BO2\s*:/i,       // Buyer Order Additional (allows spaces before colon)
  ORDER: /^ORDER\s*:/i,  // Order reference
  BN: /^BN\s*:/i,        // Business Name
  FR: /^FR\s*:/i,        // From reference
  TO: /^TO\s*:/i,        // To reference
  OBI: /^OBI\s*:/i,      // Additional info
  OB: /^OB\s*:/i,        // Ordering Bank
  PY: /^PY\s*:/i,        // Payment reference
  BI: /^BI\s*:/i,        // Business ID
  CR: /^CR\s*:/i,        // Credit reference
  RF: /^RF\s*:/i,        // Reference number
  SENDING: /SENDING PERSON|SENDING CO/i,
  ROC: /^ROC\s*:/i,      // Remittance reference
  TRID: /^TRID\s*:/i,    // Transaction ID
  ENDT: /^ENDT\s*:/i     // End date
};

/**
 * Parse raw payment notes into structured lines
 * Handles both actual newlines and literal \n strings
 * Handles SAP line wrapping (continuation lines)
 */
function parsePaymentNotes(paymentNotesRaw) {
  if (!paymentNotesRaw) return [];

  // Handle both actual newlines and literal \n strings
  const normalized = paymentNotesRaw
    .replace(/\\n/g, '\n')  // Convert literal \n to actual newlines
    .replace(/\r\n/g, '\n') // Normalize Windows line endings
    .replace(/\r/g, '\n');  // Normalize Mac line endings

  const rawLines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // Merge continuation lines (lines that don't start with a known pattern)
  const mergedLines = mergeWrappedLines(rawLines);

  return mergedLines.map((lineText, index) => ({
    lineNo: index + 1,
    lineText,
    lineType: identifyLineType(lineText),
    searchText: extractSearchText(lineText),
    metadata: extractMetadata(lineText)
  }));
}

/**
 * Merge lines that are continuations of the previous line
 * SAP often wraps long text (e.g., "HIGHW" + "AY 19 N" = "HIGHWAY 19 N")
 *
 * IMPORTANT: We do NOT merge lines - each line is kept separate.
 * This allows us to pick only lines containing BO, BO1, or BO2.
 */
function mergeWrappedLines(rawLines) {
  // Simply return all lines as-is (no merging)
  return rawLines;
}

/**
 * Identify the type of line based on patterns
 */
function identifyLineType(lineText) {
  for (const [type, pattern] of Object.entries(LINE_PATTERNS)) {
    if (pattern.test(lineText)) {
      return type;
    }
  }
  return 'OTHER';
}

/**
 * Extract the portion of the line that should be used for matching
 *
 * CLERK WORKFLOW (v2.8.0):
 * - BO lines: Full line with BO:number BO1:name BO2:address etc (most important)
 * - ORDER lines: Full line with order reference (important alternative)
 * - SENDING lines: Full line with sender info (important alternative)
 * - All other lines: Skip (not useful for matching)
 *
 * This mirrors what clerks paste into Excel for historical matching
 */
function extractSearchText(lineText) {
  const lineType = identifyLineType(lineText);

  switch (lineType) {
    case 'BO':
    case 'BO1':
    case 'BO2':
      // ✅ BO lines - extract only BO + BO1 + BO2 (not BO3, BO4, extra address)
      // This prevents long merged lines from diluting similarity scores
      return extractBOText(lineText);

    case 'ORDER':
      // ✅ ORDER lines - use full lineText (alternative match key)
      return lineText;

    case 'SENDING PERSON':
      // ✅ SENDING lines - use full lineText (alternative match key)
      return lineText;

    case 'DETAILS':
    // ✅ DETAILS lines - use full lineText (alternative match key)
    return lineText;      

    case 'FR':
    case 'TO':
    case 'OBI':
    case 'ROC':
    case 'TRID':
    case 'ENDT':
    case 'BI':
    case 'CR':
    case 'RF':
    case 'BN':
    case 'PY':
    case 'OB':
      // ❌ Metadata and bank info lines - skip (not useful for matching)
      return null;

    default:
      // ❌ Unknown types - skip
      return null;
  }
}

/**
 * Extract BO-related text from a line
 *
 * Simple logic: If line contains BO:, BO1:, or BO2:, return the ENTIRE line.
 * We don't try to parse or truncate - just return the whole line as-is.
 *
 * Example:
 *   Input:  "BO:219062889 BO1:IMMANUEL CREATIONS INCORPORATED DBA BO2:SURP"
 *   Output: "BO:219062889 BO1:IMMANUEL CREATIONS INCORPORATED DBA BO2:SURP"
 */
function extractBOText(lineText) {
  // Simply return the full line if it contains BO, BO1, or BO2
  return lineText;
}

/**
 * Extract metadata from the line for potential future use
 */
function extractMetadata(lineText) {
  const metadata = {};

  // Extract transaction ID if present
  const tridMatch = lineText.match(/TRID:(\d+)/i);
  if (tridMatch) metadata.transactionId = tridMatch[1];

  // Extract amount if present (e.g., from account references)
  const amountMatch = lineText.match(/\$?([\d,]+\.\d{2})/);
  if (amountMatch) metadata.amount = amountMatch[1];

  // Extract date if present
  const dateMatch = lineText.match(/\d{8}/);
  if (dateMatch) metadata.date = dateMatch[0];

  return metadata;
}

/**
 * Should this line be used for matching?
 * Some lines are metadata only and shouldn't be matched
 */
function shouldMatchLine(parsedLine) {
  if (!parsedLine.searchText) return false;

  // Skip transaction metadata lines
  const skipTypes = ['TRID', 'ENDT', 'FR', 'TO', 'BI', 'CR', 'RF'];
  if (skipTypes.includes(parsedLine.lineType)) return false;

  // Skip very short lines (likely not useful)
  if (parsedLine.searchText.length < 5) return false;

  return true;
}

module.exports = {
  parsePaymentNotes,
  identifyLineType,
  extractSearchText,
  shouldMatchLine
};
