/**
 * Email Matcher - Vector Search for Cached Emails
 *
 * Searches locally cached emails using vector similarity
 * Much faster than real-time Graph API calls
 * Combines semantic search with business logic (company name, amount, date)
 */

/**
 * Search cached emails using vector similarity + filters
 *
 * @param {Object} db - CDS database service
 * @param {String} companyName - Company name to search for
 * @param {Number} amount - Payment amount
 * @param {Date} valueDate - Payment value date
 * @param {Number} daysBefore - Days before value date (default 7)
 * @param {Number} daysAfter - Days after value date (default 7)
 * @returns {Promise<Array>} Matching emails with relevance scores
 */
async function searchCachedEmails(db, companyName, amount, valueDate, daysBefore = 7, daysAfter = 7) {
  if (!companyName) {
    throw new Error('Company name is required for email search');
  }

  try {
    console.log(`📧 Searching cached emails for: "${companyName}" with amount ${amount}`);

    // Calculate date range
    const startDate = new Date(valueDate);
    startDate.setDate(startDate.getDate() - daysBefore);

    const endDate = new Date(valueDate);
    endDate.setDate(endDate.getDate() + daysAfter);

    console.log(`   Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

    // Generate embedding for search query
    const searchText = `${companyName} payment ${amount}`;
    console.log(`   Generating embedding for: "${searchText}"`);

    // Get search embedding using HANA function
    const embeddingResult = await db.run(`
      SELECT TO_VECTOR(VECTOR_EMBEDDING('SAP_GXY.20250407', ?)) AS "embedding"
      FROM DUMMY
    `, [searchText]);

    const searchEmbedding = embeddingResult[0]?.embedding;

    if (!searchEmbedding) {
      throw new Error('Failed to generate search embedding');
    }

    // Vector similarity search with filters
    // Using COSINE_SIMILARITY for semantic matching
    const sql = `
      SELECT
        "ID",
        "messageId",
        "subject",
        "fromAddress",
        "fromName",
        "receivedDateTime",
        "bodyPreview",
        "bodyText",
        "extractedAmounts",
        "extractedCompanies",
        COSINE_SIMILARITY("embedding", TO_VECTOR(?)) AS "similarity"
      FROM "RECONCILIATION_EMAILCACHE"
      WHERE
        "receivedDateTime" BETWEEN ? AND ?
        AND "embedding" IS NOT NULL
      ORDER BY "similarity" DESC
      LIMIT 25
    `;

    const results = await db.run(sql, [
      JSON.stringify(searchEmbedding),
      startDate.toISOString(),
      endDate.toISOString()
    ]);

    console.log(`   Found ${results.length} emails via vector search`);

    // Calculate enhanced relevance scores
    const scored = results.map(email => ({
      ...email,
      relevanceScore: calculateRelevanceScore(email, companyName, amount, searchEmbedding)
    }));

    // Re-sort by combined score
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // Return top 10
    return scored.slice(0, 10);

  } catch (error) {
    console.error('❌ Error searching cached emails:', error.message);
    throw error;
  }
}

/**
 * Calculate relevance score combining vector similarity with business logic
 *
 * @param {Object} email - Email record from database
 * @param {String} companyName - Company name being searched
 * @param {Number} amount - Payment amount
 * @param {Array} searchEmbedding - Search vector embedding
 * @returns {Number} Relevance score (0-100)
 */
function calculateRelevanceScore(email, companyName, amount, searchEmbedding) {
  let score = 0;

  // Base score from vector similarity (0-50 points)
  const similarity = email.similarity || 0;
  score += similarity * 50;

  const subject = (email.subject || '').toLowerCase();
  const bodyPreview = (email.bodyPreview || '').toLowerCase();
  const companyLower = companyName.toLowerCase();

  // Company name exact match in subject (+20 points)
  if (subject.includes(companyLower)) {
    score += 20;
  }

  // Company name exact match in body (+10 points)
  if (bodyPreview.includes(companyLower)) {
    score += 10;
  }

  // Extracted companies match (+15 points)
  try {
    const extractedCompanies = JSON.parse(email.extractedCompanies || '[]');
    if (extractedCompanies.some(c => c.toLowerCase().includes(companyLower))) {
      score += 15;
    }
  } catch (e) {
    // Invalid JSON, skip
  }

  // Amount match in extracted amounts (+20 points)
  if (amount) {
    try {
      const extractedAmounts = JSON.parse(email.extractedAmounts || '[]');
      const tolerance = amount * 0.01; // 1% tolerance

      const hasMatch = extractedAmounts.some(extracted =>
        Math.abs(extracted - amount) <= tolerance
      );

      if (hasMatch) {
        score += 20;
      }
    } catch (e) {
      // Invalid JSON, skip
    }
  }

  // From address/name contains company (+10 points)
  const fromName = (email.fromName || '').toLowerCase();
  const fromAddress = (email.fromAddress || '').toLowerCase();
  if (fromName.includes(companyLower) || fromAddress.includes(companyLower)) {
    score += 10;
  }

  return Math.min(score, 100); // Cap at 100
}

/**
 * Format cached email results for display
 * Similar format to real-time email search results
 *
 * @param {Array} emails - Array of email search results
 * @returns {Array} Formatted email results
 */
function formatCachedEmailResults(emails) {
  return emails.map(email => ({
    id: email.ID,
    messageId: email.messageId,
    subject: email.subject,
    from: email.fromName || email.fromAddress,
    fromAddress: email.fromAddress,
    receivedDate: email.receivedDateTime,
    preview: email.bodyPreview?.substring(0, 150) + '...',
    fullBody: email.bodyText, // Include full body for display
    score: Math.round(email.relevanceScore),
    similarity: Math.round((email.similarity || 0) * 100),
    extractedAmounts: safeParseJSON(email.extractedAmounts),
    extractedCompanies: safeParseJSON(email.extractedCompanies)
  }));
}

/**
 * Safely parse JSON string
 */
function safeParseJSON(jsonString) {
  try {
    return JSON.parse(jsonString || '[]');
  } catch (e) {
    return [];
  }
}

/**
 * Get full email body by ID
 * For displaying complete email content to clerk
 *
 * @param {Object} db - CDS database service
 * @param {String} emailId - Email ID (UUID)
 * @returns {Promise<Object>} Complete email record
 */
async function getEmailById(db, emailId) {
  try {
    const result = await db.run(
      SELECT.from('reconciliation.EmailCache').where({ ID: emailId })
    );

    if (result.length === 0) {
      throw new Error(`Email not found: ${emailId}`);
    }

    const email = result[0];

    return {
      id: email.ID,
      messageId: email.messageId,
      subject: email.subject,
      from: {
        name: email.fromName,
        address: email.fromAddress
      },
      to: safeParseJSON(email.toAddresses),
      receivedDateTime: email.receivedDateTime,
      bodyPreview: email.bodyPreview,
      bodyText: email.bodyText,
      bodyHtml: email.bodyHtml,
      extractedAmounts: safeParseJSON(email.extractedAmounts),
      extractedCompanies: safeParseJSON(email.extractedCompanies),
      extractedDates: safeParseJSON(email.extractedDates)
    };

  } catch (error) {
    console.error('❌ Error fetching email:', error.message);
    throw error;
  }
}

module.exports = {
  searchCachedEmails,
  calculateRelevanceScore,
  formatCachedEmailResults,
  getEmailById
};
