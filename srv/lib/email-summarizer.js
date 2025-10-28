/**
 * Email Summarizer - LLM Analysis
 *
 * Uses configured LLM (GPT-5, Claude, etc.) to analyze matching emails and extract reconciliation-relevant information
 * Helps clerks quickly understand what action to take
 *
 * Model configuration is centralized in llm-client.js
 */

const { createLLMClient, getModelInfo } = require('./llm-client');

/**
 * Summarize emails for bank reconciliation
 * Uses configured LLM to extract key information that helps clerks match payments
 *
 * @param {Array} emails - Array of matching email objects
 * @param {String} companyName - Company name being reconciled
 * @param {Number} amount - Payment amount
 * @returns {Promise<Object>} Summary with AI insights
 */
async function summarizeEmailsForReconciliation(emails, companyName, amount) {
  if (!emails || emails.length === 0) {
    return {
      success: false,
      summary: null,
      error: 'No emails to summarize'
    };
  }

  try {
    const modelInfo = getModelInfo();
    console.log(`🤖 LLM (${modelInfo.modelName}) analyzing ${emails.length} emails for reconciliation...`);

    // Prepare email context for ChatGPT
    const emailContext = emails.slice(0, 5).map((email, index) => {
      // Use full body text if available, otherwise use preview
      const emailBody = email.bodyText || email.bodyPreview || email.preview || '';

      // Limit body to first 2000 chars to avoid token limits
      const bodyTruncated = emailBody.length > 2000
        ? emailBody.substring(0, 2000) + '...'
        : emailBody;

      return `
EMAIL ${index + 1}:
Subject: ${email.subject}
From: ${email.fromName || email.from} <${email.fromAddress}>
Date: ${new Date(email.receivedDateTime || email.receivedDate).toLocaleDateString()}
Body: ${bodyTruncated}
Extracted Amounts: ${JSON.stringify(email.extractedAmounts || [])}
Extracted Companies: ${JSON.stringify(email.extractedCompanies || [])}
      `.trim();
    }).join('\n\n---\n\n');

    // Simplified prompt focused on extracting EBS accounting fields
    const prompt = `You are analyzing emails for bank reconciliation. These emails match the company name "${companyName}" and amount $${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.

EMAILS:
${emailContext}

TASK:
Find and extract these EBS accounting fields from the emails (if present):
- Cost Center (e.g., 19090001)
- Company Code (e.g., 1400)
- GL Account (e.g., 6003010)

FORMAT YOUR RESPONSE EXACTLY AS:
**Cost Center**: [number or "Not found"]
**Company Code**: [number or "Not found"]
**GL Account**: [number or "Not found"]
**Invoice/Reference**: [invoice number or "Not found"]
**Notes**: [Any relevant details about the transaction in 1-2 sentences]

IMPORTANT: Only extract actual numbers you find. If a field is not mentioned, write "Not found".`;

    // Use centralized LLM client (model configured in llm-client.js)
    const client = createLLMClient();

    const response = await client.chatCompletion({
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const summary = response.getContent();

    console.log(`✅ LLM summary generated`);

    return {
      success: true,
      summary: summary.trim(),
      emailsAnalyzed: emails.slice(0, 5).length,
      companyName,
      amount,
      error: null
    };

  } catch (error) {
    console.error('❌ LLM summarization failed:', error.message);

    return {
      success: false,
      summary: null,
      emailsAnalyzed: 0,
      companyName,
      amount,
      error: error.message
    };
  }
}

/**
 * Extract accounting fields from LLM summary
 * Parses LLM response to extract structured EBS data
 *
 * @param {String} summary - LLM summary text
 * @returns {Object} Structured accounting fields
 */
function parseActionItems(summary) {
  if (!summary) {
    return {
      costCenter: null,
      companyCode: null,
      glAccount: null,
      invoice: null,
      notes: null
    };
  }

  try {
    const costCenterMatch = summary.match(/\*\*Cost Center\*\*:\s*(.+)/i);
    const companyCodeMatch = summary.match(/\*\*Company Code\*\*:\s*(.+)/i);
    const glAccountMatch = summary.match(/\*\*GL Account\*\*:\s*(.+)/i);
    const invoiceMatch = summary.match(/\*\*Invoice\/Reference\*\*:\s*(.+)/i);
    const notesMatch = summary.match(/\*\*Notes\*\*:\s*(.+)/i);

    // Clean up values - convert "Not found" to null
    const cleanValue = (value) => {
      if (!value) return null;
      const trimmed = value.trim();
      return (trimmed.toLowerCase() === 'not found' || trimmed === '-') ? null : trimmed;
    };

    return {
      costCenter: cleanValue(costCenterMatch ? costCenterMatch[1] : null),
      companyCode: cleanValue(companyCodeMatch ? companyCodeMatch[1] : null),
      glAccount: cleanValue(glAccountMatch ? glAccountMatch[1] : null),
      invoice: cleanValue(invoiceMatch ? invoiceMatch[1] : null),
      notes: cleanValue(notesMatch ? notesMatch[1] : null)
    };

  } catch (error) {
    console.error('⚠️  Failed to parse accounting fields:', error.message);
    return {
      costCenter: null,
      companyCode: null,
      glAccount: null,
      invoice: null,
      notes: summary.substring(0, 200)
    };
  }
}

module.exports = {
  summarizeEmailsForReconciliation,
  parseActionItems
};
