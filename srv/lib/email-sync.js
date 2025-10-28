/**
 * Email Sync Service
 *
 * Fetches emails from Microsoft Outlook via Graph API
 * Extracts metadata (amounts, companies, dates)
 * Stores locally with vector embeddings for smart search
 *
 * USAGE:
 * const emailSync = require('./lib/email-sync');
 * const result = await emailSync.syncEmails(db, 2); // Fetch last 2 days
 */

const emailSearch = require('./email-search');

/**
 * Sync emails from Outlook to local database
 *
 * @param {Object} db - CDS database service
 * @param {Number} daysBack - Number of days to fetch (default 2)
 * @returns {Promise<Object>} Sync results
 */
async function syncEmails(db, daysBack = 2) {
  const startTime = Date.now();
  const syncBatchId = `SYNC_${Date.now()}`;

  console.log(`\n📧 Starting email sync: Last ${daysBack} days`);
  console.log(`   Batch ID: ${syncBatchId}`);

  try {
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    console.log(`   Date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);

    // Fetch emails from Outlook
    console.log(`   📥 Fetching emails from Microsoft Graph API...`);
    const emails = await fetchEmailsFromOutlook(startDate, endDate);
    console.log(`   ✅ Fetched ${emails.length} emails`);

    if (emails.length === 0) {
      return {
        success: true,
        message: 'No emails found in date range',
        emailsFetched: 0,
        emailsStored: 0,
        emailsSkipped: 0,
        syncBatchId,
        startDate,
        endDate,
        duration: Date.now() - startTime,
        error: null
      };
    }

    // Check for duplicates (existing messageIds)
    const messageIds = emails.map(e => e.id);
    const existing = await db.run(
      SELECT.from('reconciliation.EmailCache')
        .columns('messageId')
        .where({ messageId: { in: messageIds } })
    );
    const existingIds = new Set(existing.map(e => e.messageId));

    const newEmails = emails.filter(e => !existingIds.has(e.id));
    console.log(`   📊 ${newEmails.length} new, ${existingIds.size} already cached`);

    // Extract metadata and prepare for storage
    console.log(`   🔍 Extracting metadata...`);
    const emailRecords = newEmails.map(email => prepareEmailRecord(email, syncBatchId));

    // Store emails in database
    if (emailRecords.length > 0) {
      console.log(`   💾 Storing ${emailRecords.length} emails...`);
      await db.run(INSERT.into('reconciliation.EmailCache').entries(emailRecords));
      console.log(`   ✅ Emails stored successfully`);

      // Generate embeddings for new emails
      console.log(`   🤖 Generating vector embeddings...`);
      const embeddingCount = await generateEmbeddings(db, syncBatchId);
      console.log(`   ✅ Generated ${embeddingCount} embeddings`);
    }

    const duration = Date.now() - startTime;
    console.log(`\n✅ Email sync complete: ${duration}ms`);

    return {
      success: true,
      message: `Successfully synced ${newEmails.length} new emails`,
      emailsFetched: emails.length,
      emailsStored: emailRecords.length,
      emailsSkipped: existingIds.size,
      syncBatchId,
      startDate,
      endDate,
      duration,
      error: null
    };

  } catch (error) {
    console.error('❌ Email sync failed:', error.message);
    console.error('   Error details:', error);

    return {
      success: false,
      message: 'Email sync failed',
      emailsFetched: 0,
      emailsStored: 0,
      emailsSkipped: 0,
      syncBatchId,
      startDate: null,
      endDate: null,
      duration: Date.now() - startTime,
      error: error.message
    };
  }
}

/**
 * Fetch emails from Outlook via Microsoft Graph API
 *
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @returns {Promise<Array>} Array of email messages
 */
async function fetchEmailsFromOutlook(startDate, endDate) {
  try {
    // Use existing email-search.js which already has Graph API setup
    // We'll fetch messages from inbox for the date range

    // Format dates for Graph API filter
    const startISO = startDate.toISOString();
    const endISO = endDate.toISOString();

    // Build Graph API query
    // Filter: receivedDateTime >= startDate AND receivedDateTime <= endDate
    const filter = `receivedDateTime ge ${startISO} and receivedDateTime le ${endISO}`;

    // Select fields we need
    const select = [
      'id',
      'conversationId',
      'subject',
      'from',
      'toRecipients',
      'receivedDateTime',
      'bodyPreview',
      'body'
    ].join(',');

    // Use emailSearch module's Graph API client
    const endpoint = `/me/messages?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=999`;
    const messages = await emailSearch.fetchFromGraphAPI(endpoint);

    return messages.value || [];

  } catch (error) {
    console.error('❌ Failed to fetch emails from Graph API:', error.message);
    throw new Error(`Graph API error: ${error.message}`);
  }
}

/**
 * Prepare email record for database storage
 * Extracts metadata and formats for EmailCache entity
 *
 * @param {Object} email - Graph API email message
 * @param {String} syncBatchId - Sync batch identifier
 * @returns {Object} Email record ready for database
 */
function prepareEmailRecord(email, syncBatchId) {
  // Extract dollar amounts from body
  const extractedAmounts = extractDollarAmounts(email.body?.content || email.bodyPreview || '');

  // Extract company names (basic pattern matching)
  const extractedCompanies = extractCompanyNames(email.body?.content || email.bodyPreview || '');

  // Extract dates mentioned
  const extractedDates = extractDates(email.body?.content || email.bodyPreview || '');

  // Get body text (prefer plain text, fallback to HTML)
  let bodyText = '';
  let bodyHtml = '';

  if (email.body?.contentType === 'text') {
    bodyText = email.body.content;
  } else if (email.body?.contentType === 'html') {
    bodyHtml = email.body.content;
    bodyText = stripHtmlTags(email.body.content);
  }

  return {
    messageId: email.id,
    conversationId: email.conversationId || email.id,
    subject: email.subject || '(No Subject)',
    fromAddress: email.from?.emailAddress?.address || 'unknown',
    fromName: email.from?.emailAddress?.name || 'Unknown',
    toAddresses: JSON.stringify(email.toRecipients || []),
    receivedDateTime: email.receivedDateTime,
    bodyPreview: email.bodyPreview || '',
    bodyText: bodyText || email.bodyPreview || '',
    bodyHtml: bodyHtml,
    extractedAmounts: JSON.stringify(extractedAmounts),
    extractedCompanies: JSON.stringify(extractedCompanies),
    extractedDates: JSON.stringify(extractedDates),
    syncBatchId,
    fetchedAt: new Date().toISOString(),
    matchedCount: 0
  };
}

/**
 * Extract dollar amounts from text
 * Finds patterns like $1,234.56 or 1234.56
 *
 * @param {String} text - Text to search
 * @returns {Array<Number>} Array of amounts found
 */
function extractDollarAmounts(text) {
  if (!text) return [];

  const amounts = [];

  // Pattern 1: $1,234.56
  const dollarPattern = /\$\s*([\d,]+\.?\d*)/g;
  let match;
  while ((match = dollarPattern.exec(text)) !== null) {
    const amount = parseFloat(match[1].replace(/,/g, ''));
    if (!isNaN(amount) && amount > 0) {
      amounts.push(amount);
    }
  }

  // Pattern 2: 1234.56 (standalone numbers that look like money)
  const numberPattern = /\b(\d{1,3}(,\d{3})*(\.\d{2})?)\b/g;
  while ((match = numberPattern.exec(text)) !== null) {
    const amount = parseFloat(match[1].replace(/,/g, ''));
    if (!isNaN(amount) && amount > 100 && amount < 1000000) {
      // Only include if looks like money amount
      if (!amounts.includes(amount)) {
        amounts.push(amount);
      }
    }
  }

  return amounts.slice(0, 10); // Limit to first 10
}

/**
 * Extract company names from text
 * Basic pattern matching for common company patterns
 *
 * @param {String} text - Text to search
 * @returns {Array<String>} Array of company names found
 */
function extractCompanyNames(text) {
  if (!text) return [];

  const companies = [];

  // Pattern: Words followed by LLC, Inc, Corp, etc.
  const suffixPattern = /([A-Z][A-Za-z0-9\s&]+?)\s+(LLC|Inc\.?|Corp\.?|Corporation|Ltd\.?|Limited|Co\.?|Company)/g;
  let match;
  while ((match = suffixPattern.exec(text)) !== null) {
    const company = match[1].trim();
    if (company.length > 2 && !companies.includes(company)) {
      companies.push(company);
    }
  }

  return companies.slice(0, 10); // Limit to first 10
}

/**
 * Extract dates from text
 * Finds common date patterns
 *
 * @param {String} text - Text to search
 * @returns {Array<String>} Array of dates found (ISO format)
 */
function extractDates(text) {
  if (!text) return [];

  const dates = [];

  // Pattern: MM/DD/YYYY or MM-DD-YYYY
  const datePattern = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/g;
  let match;
  while ((match = datePattern.exec(text)) !== null) {
    try {
      const date = new Date(match[1]);
      if (!isNaN(date.getTime())) {
        dates.push(date.toISOString());
      }
    } catch (e) {
      // Invalid date, skip
    }
  }

  return dates.slice(0, 5); // Limit to first 5
}

/**
 * Strip HTML tags from text
 * Basic HTML removal for plain text extraction
 *
 * @param {String} html - HTML string
 * @returns {String} Plain text
 */
function stripHtmlTags(html) {
  if (!html) return '';

  return html
    .replace(/<script[^>]*>.*?<\/script>/gi, '') // Remove scripts
    .replace(/<style[^>]*>.*?<\/style>/gi, '')   // Remove styles
    .replace(/<[^>]+>/g, '')                      // Remove tags
    .replace(/&nbsp;/g, ' ')                      // Replace &nbsp;
    .replace(/&amp;/g, '&')                       // Replace &amp;
    .replace(/&lt;/g, '<')                        // Replace &lt;
    .replace(/&gt;/g, '>')                        // Replace &gt;
    .replace(/\s+/g, ' ')                         // Normalize whitespace
    .trim();
}

/**
 * Generate vector embeddings for cached emails
 * Uses HANA VECTOR_EMBEDDING function (same as Historical data)
 *
 * @param {Object} db - CDS database service
 * @param {String} syncBatchId - Sync batch to generate embeddings for
 * @returns {Promise<Number>} Number of embeddings generated
 */
async function generateEmbeddings(db, syncBatchId) {
  try {
    // Get emails from this batch that need embeddings
    // Use raw SQL because CDS can't compare REAL_VECTOR with null
    const emails = await db.run(`
      SELECT * FROM "RECONCILIATION_EMAILCACHE"
      WHERE "SYNCBATCHID" = ? AND "EMBEDDING" IS NULL
    `, [syncBatchId]);

    if (emails.length === 0) {
      return 0;
    }

    console.log(`      Generating embeddings for ${emails.length} emails...`);

    // Use HANA VECTOR_EMBEDDING function (same model as Historical data)
    // Embed the concatenation of subject + bodyPreview for best semantic matching
    for (const email of emails) {
      const textToEmbed = `${email.SUBJECT} ${email.BODYPREVIEW}`.substring(0, 5000);

      const sql = `
        UPDATE "RECONCILIATION_EMAILCACHE"
        SET "EMBEDDING" = VECTOR_EMBEDDING('SAP_GXY.20250407', ?)
        WHERE "ID" = ?
      `;

      await db.run(sql, [textToEmbed, email.ID]);
    }

    return emails.length;

  } catch (error) {
    console.error('      ❌ Failed to generate embeddings:', error.message);
    // Don't fail the whole sync if embeddings fail
    return 0;
  }
}

/**
 * Delete all cached emails
 * For testing purposes
 *
 * @param {Object} db - CDS database service
 * @returns {Promise<Number>} Number of emails deleted
 */
async function deleteAllEmails(db) {
  try {
    console.log('\n🗑️  Deleting all cached emails...');

    const result = await db.run(DELETE.from('reconciliation.EmailCache'));
    const count = result.affectedRows || 0;

    console.log(`   ✅ Deleted ${count} emails`);

    return count;

  } catch (error) {
    console.error('❌ Failed to delete emails:', error.message);
    throw error;
  }
}

module.exports = {
  syncEmails,
  deleteAllEmails,
  fetchEmailsFromOutlook,
  prepareEmailRecord,
  extractDollarAmounts,
  extractCompanyNames,
  extractDates,
  generateEmbeddings
};
