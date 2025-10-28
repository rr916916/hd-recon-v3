/**
 * Company Name Extractor
 *
 * Extracts company names from payment notes for email search
 * when vector matching fails to find good matches
 *
 * STRATEGIES:
 * 1. ChatGPT extraction (NEW v2.7.0) - AI-powered extraction from full payment notes
 * 2. BO1 extraction (v2.6.0) - Pattern-based extraction from Beneficiary Order Name
 *
 * The payer name is generally in BO1 but could be in any field.
 * ChatGPT analyzes the full payment notes to extract the most likely payer name.
 */

const cds = require('@sap/cds');
const { createLLMClient, getModelInfo } = require('./llm-client');

/**
 * Extract company/payer name using LLM via SAP AI Core
 *
 * Uses configured LLM (GPT-5, Claude, etc.) to intelligently extract the payer name from payment notes.
 * The payer name is generally in BO1 but could be in any field.
 *
 * Model configuration is centralized in llm-client.js
 *
 * @param {String} paymentNotesRaw - Raw payment notes text
 * @returns {Promise<Object|null>} - { companyName, source: 'CHATGPT', confidence: 90 } or null
 */
async function extractCompanyNameWithChatGPT(paymentNotesRaw) {
  if (!paymentNotesRaw || typeof paymentNotesRaw !== 'string') {
    return null;
  }

  try {

    // Craft the prompt for ChatGPT
    const prompt = `Analyze the following bank payment notes and extract the payer/company name.

Payment Notes:
${paymentNotesRaw}

Instructions:
- The payer name is generally in the BO1 field, but it could be in any field (BO2, BO3, OB1, BN, etc.)
- Return ONLY the clean company/payer name
- Remove business suffixes like LLC, Inc, INC, Corp, Ltd, Co, Corporation, Incorporated, Limited
- Remove any address information, city, state, zip codes
- Do not include any field labels (like "BO1:", "BO2:", etc.)
- Return just the core business name for easy email searching
- If no clear payer name is found, return the text "NONE"

Example:
Input: "BO1:ACME CORPORATION LLC BO2:123 MAIN ST"
Output: ACME CORPORATION

Extract the payer name:`;

    const modelInfo = getModelInfo();
    console.log(`🤖 Calling LLM (${modelInfo.modelName}) to extract company name...`);

    // Use centralized LLM client (model configured in llm-client.js)
    const client = createLLMClient();

    const response = await client.chatCompletion({
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const extractedText = response.getContent();

    // Clean up the response
    const companyName = extractedText.trim();

    // Validate the result
    if (!companyName || companyName === 'NONE' || companyName.length < 2) {
      console.log(`⚠️  LLM could not extract a valid company name`);
      return null;
    }

    console.log(`✅ LLM extracted company name: "${companyName}"`);

    return {
      companyName,
      source: 'CHATGPT',
      confidence: 90,
      rawPaymentNotes: paymentNotesRaw
    };

  } catch (error) {
    console.error('❌ LLM extraction failed:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', JSON.stringify(error.response.data));
    }
    if (error.request) {
      console.error('   Request config:', JSON.stringify({
        url: error.request.path,
        method: error.request.method
      }));
    }
    if (error.cause) {
      console.error('   Error cause:', error.cause);
    }
    console.error('   Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    console.error('   Falling back to pattern-based extraction...');
    return null;
  }
}

/**
 * Extract company name from parsed payment note lines
 *
 * @param {Array} parsedLines - Array of parsed line objects from line-parser
 * @param {Number} amount - Payment amount for context
 * @returns {Object} - { companyName, source, confidence, amount }
 */
function extractCompanyName(parsedLines, amount) {
  if (!parsedLines || parsedLines.length === 0) {
    return null;
  }

  try {
    // ✅ ACTIVE: Extract from BO1 (Beneficiary Order - most reliable)
    const boLine = parsedLines.find(line => line.lineType === 'BO');
    if (boLine && boLine.lineText) {
      // Strategy 1: Try to extract BO1 value with robust pattern
      // Handles both "BO1:COMPANY BO2:..." and "BO1:COMPANYBO2:..." (missing space)
      // Changed \s+ to \s* to allow zero or more spaces before BO2/BO3
      const bo1Match = boLine.lineText.match(/BO1\s*:\s*(.+?)(?:\s*BO[23]\s*:|$)/i);

      if (bo1Match) {
        let companyName = bo1Match[1].trim();

        // Defensive cleanup: Remove any BO2/BO3 remnants that might have been captured
        // This handles edge cases where the regex captured partial BO2/BO3 text
        companyName = companyName
          .replace(/\s*BO[23]\s*:.*$/i, '')  // Remove BO2/BO3 and everything after
          .replace(/^BO[0-9]+\s*:\s*/i, '')  // Remove any BO prefix if captured
          .trim();

        // Validate: Company name should not be empty after cleaning
        if (!companyName || companyName.length === 0) {
          console.warn('⚠️  Company name extraction resulted in empty string');
          return null;
        }

        // Validate: Company name should not contain control characters or be too short
        if (companyName.length < 2) {
          console.warn(`⚠️  Company name too short: "${companyName}"`);
          return null;
        }

        console.log(`✅ Extracted company name: "${companyName}" from BO1`);

        return {
          companyName,
          source: 'BO1',
          confidence: 95,
          amount,
          fullLine: boLine.lineText
        };
      }
    }
  } catch (error) {
    // Never let company extraction break the system
    console.error('❌ Error extracting company name:', error.message);
    console.error('   Continuing without company extraction...');
    return null;
  }

  // 🚫 DISABLED: Other extraction strategies (commented for future use)

  // Strategy 2: Extract from OB1 (Ordering Bank Beneficiary)
  // ISSUE: OB can contain bank info, not always customer name
  // const obLine = parsedLines.find(line => line.lineType === 'OB');
  // if (obLine) {
  //   const ob1Match = obLine.lineText.match(/OB1:([^OB2]+?)(?:\s+OB[234]:|$)/i);
  //   if (ob1Match) {
  //     const companyName = ob1Match[1].trim();
  //     return { companyName, source: 'OB1', confidence: 80, amount, fullLine: obLine.lineText };
  //   }
  // }

  // Strategy 3: Extract from BN (Business Name)
  // ISSUE: BN can be "Home Depot" (sender), not the customer receiving payment
  // const bnLine = parsedLines.find(line => line.lineType === 'BN');
  // if (bnLine) {
  //   const bnMatch = bnLine.lineText.match(/BN:(.+)/i);
  //   if (bnMatch) {
  //     const companyName = bnMatch[1].trim();
  //     return { companyName, source: 'BN', confidence: 75, amount, fullLine: bnLine.lineText };
  //   }
  // }

  // Strategy 4: Extract from ORDER
  // const orderLine = parsedLines.find(line => line.lineType === 'ORDER');
  // if (orderLine) {
  //   const orderMatch = orderLine.lineText.match(/ORDER:(.+)/i);
  //   if (orderMatch) {
  //     const companyName = orderMatch[1].trim();
  //     return { companyName, source: 'ORDER', confidence: 70, amount, fullLine: orderLine.lineText };
  //   }
  // }

  // FUTURE: Add more extraction strategies here
  // - PY: Payment reference patterns
  // - Pattern-based extraction (common formats)
  // - LLM-based extraction for edge cases

  return null;
}

/**
 * Clean company name for search
 * Removes common noise words and normalizes format
 */
function cleanCompanyName(companyName) {
  if (!companyName) return '';

  return companyName
    .replace(/\s+LLC$/i, '')
    .replace(/\s+INC\.?$/i, '')
    .replace(/\s+CORP\.?$/i, '')
    .replace(/\s+LTD\.?$/i, '')
    .replace(/\s+CO\.?$/i, '')
    .trim();
}

module.exports = {
  extractCompanyName,
  extractCompanyNameWithChatGPT,
  cleanCompanyName
};
