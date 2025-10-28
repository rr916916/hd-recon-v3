/**
 * Email Search Service
 *
 * Searches Microsoft Outlook inbox using Graph API when vector matching fails
 * Helps clerks find payment details by searching emails with company name + amount
 */

const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

/**
 * Search emails in Outlook inbox
 *
 * @param {String} companyName - Company name extracted from BO1
 * @param {Number} amount - Payment amount
 * @param {Number} daysBefore - Days before value date to search (default: 3)
 * @param {Number} daysAfter - Days after value date to search (default: 3)
 * @param {Date} valueDate - Payment value date
 * @returns {Array} - Array of email results with relevance scores
 */
async function searchInbox(companyName, amount, valueDate, daysBefore = 3, daysAfter = 3) {
  if (!companyName) {
    throw new Error('Company name is required for email search');
  }

  try {
    // Calculate date range for search
    const startDate = new Date(valueDate);
    startDate.setDate(startDate.getDate() - daysBefore);

    const endDate = new Date(valueDate);
    endDate.setDate(endDate.getDate() + daysAfter);

    console.log(`📧 Searching emails for: "${companyName}" with amount ${amount}`);
    console.log(`   Subject filter: "SAP HACKATHON"`);
    console.log(`   Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

    // Build query parameters
    // Include both company name AND subject filter "SAP HACKATHON"
    const searchQuery = `"${companyName}" AND subject:"SAP HACKATHON"`; // Graph API search requires quotes

    // Build URL with properly encoded parameters
    // Note: $search and $filter cannot be used together, so we'll use $search with $top
    // Note: $orderby cannot be used with $search in Graph API
    const queryParams = new URLSearchParams({
      '$search': searchQuery,
      '$top': '25',
      '$select': 'subject,from,receivedDateTime,bodyPreview,body,hasAttachments'
    });

    // Get mailbox from environment or use default
    // For app-only authentication, we must specify which mailbox to search
    // This should be configured in BTP environment variables
    // const mailboxEmail = process.env.GRAPH_MAILBOX_EMAIL || 'junoinvoices@resolvetech.com';
    const mailboxEmail =  'fin_api_support@homedepot.com';


    console.log(`   Searching mailbox: ${mailboxEmail}`);

    // Call Microsoft Graph API using SAP Cloud SDK
    // This automatically handles destination lookup and OAuth token retrieval
    // Note: Using /users/{email}/messages instead of /me/messages for app-only auth
    const response = await executeHttpRequest(
      {
        destinationName: 'MicrosoftGraphAPI',
        timeout: 30000  // 30 second timeout
      },
      {
        method: 'GET',
        url: `/v1.0/users/${mailboxEmail}/messages?${queryParams.toString()}`,
        timeout: 30000  // 30 second timeout
      }
    );

    const emails = response.data?.value || [];

    console.log(`   Found ${emails.length} email(s)`);

    // Calculate relevance scores
    const results = emails.map(email => ({
      subject: email.subject,
      from: email.from?.emailAddress?.name || email.from?.emailAddress?.address,
      fromAddress: email.from?.emailAddress?.address,
      receivedDate: email.receivedDateTime,
      preview: email.bodyPreview,
      bodyText: email.body?.content || email.bodyPreview,  // Use full body text, fallback to preview
      hasAttachments: email.hasAttachments,
      relevanceScore: calculateRelevance(email, companyName, amount)
    }));

    // Sort by relevance score
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return results;

  } catch (error) {
    console.error('❌ Error searching emails:', error.message);

    // Log more details if available
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Error details:', JSON.stringify(error.response.data || {}, null, 2));
    }

    // If Graph API destination not configured, return empty results with warning
    if (error.message.includes('not found') || error.message.includes('destination')) {
      console.warn('⚠️  MicrosoftGraphAPI destination not configured - email search unavailable');
      return [];
    }

    throw error;
  }
}

/**
 * Build search query for Microsoft Graph API
 */
function buildSearchQuery(companyName, amount, startDate, endDate) {
  // Simple query: company name
  // Graph API will search in subject, body, and attachments
  return companyName;
}

/**
 * Calculate relevance score for an email
 * Higher score = more likely to be the right email
 */
function calculateRelevance(email, companyName, amount) {
  let score = 0;

  const subject = (email.subject || '').toLowerCase();
  const preview = (email.bodyPreview || '').toLowerCase();
  const companyLower = companyName.toLowerCase();

  // Company name in subject (highest weight)
  if (subject.includes(companyLower)) {
    score += 50;
  }

  // Company name in body
  if (preview.includes(companyLower)) {
    score += 30;
  }

  // Amount mentioned in subject or body
  if (amount) {
    const amountStr = amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); // Add commas
    const amountPlain = amount.toString();

    if (subject.includes(amountStr) || subject.includes(amountPlain)) {
      score += 30;
    }
    if (preview.includes(amountStr) || preview.includes(amountPlain)) {
      score += 20;
    }
  }

  // Has attachments (might contain invoice/receipt)
  if (email.hasAttachments) {
    score += 10;
  }

  // From address contains company name
  const fromName = (email.from?.emailAddress?.name || '').toLowerCase();
  const fromAddress = (email.from?.emailAddress?.address || '').toLowerCase();
  if (fromName.includes(companyLower) || fromAddress.includes(companyLower)) {
    score += 20;
  }

  return score;
}

/**
 * Format email results for display in UI
 */
function formatEmailResults(emails) {
  return emails.map(email => ({
    subject: email.subject,
    from: email.from,
    date: new Date(email.receivedDate).toLocaleDateString(),
    preview: email.preview?.substring(0, 150) + '...',
    score: email.relevanceScore,
    hasAttachments: email.hasAttachments ? 'Yes' : 'No'
  }));
}

/**
 * Fetch data from Microsoft Graph API (generic helper)
 * Used by email-sync for batch fetching
 *
 * @param {String} endpoint - Graph API endpoint (e.g., '/me/messages?$filter=...')
 * @returns {Promise<Object>} Response data from Graph API
 */
async function fetchFromGraphAPI(endpoint) {
  try {
    // const mailboxEmail = process.env.GRAPH_MAILBOX_EMAIL || 'junoinvoices@resolvetech.com';
    const mailboxEmail = 'fin_api_support@homedepot.com';


    // Replace /me/ with /users/{email}/ for app-only auth
    const url = endpoint.startsWith('/me/')
      ? `/v1.0/users/${mailboxEmail}${endpoint.substring(3)}`
      : `/v1.0${endpoint}`;

    const response = await executeHttpRequest(
      {
        destinationName: 'MicrosoftGraphAPI',
        timeout: 30000  // 30 second timeout
      },
      {
        method: 'GET',
        url,
        timeout: 30000  // 30 second timeout
      }
    );

    return response.data;

  } catch (error) {
    console.error('❌ Graph API request failed:', error.message);
    throw error;
  }
}

module.exports = {
  searchInbox,
  formatEmailResults,
  fetchFromGraphAPI
};
