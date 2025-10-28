const cds = require('@sap/cds');
const emailSync = require('./lib/email-sync');
const { generateEmbeddings } = require('../scripts/generate-embeddings');

module.exports = cds.service.impl(async function() {
  const { Historical, BankStatementHeader, BankStatementLine, LineMatch, EmailCache } = this.entities;

  /**
   * Add Statement Action Handler
   */
  this.on('addStatement', async (req) => {
    const { Bukrs, Hbkid, Hktid, Aznum, Azdat, Astat, Waers, Esnum, Kwbtr, Vb1ok, Vb2ok, Vwezw } = req.data;

    try {
      // Step 1: Parse payment notes (Vwezw) into lines
      const lines = parsePaymentNotes(Vwezw);
      console.log(`[addStatement] Parsed ${lines.length} lines from Vwezw`);

      // Step 2: Create statement header (Vwezw is NOT stored, only parsed into lines)
      const header = await INSERT.into(BankStatementHeader).entries({
        Bukrs, Hbkid, Hktid, Aznum, Azdat, Astat, Waers, Esnum, Kwbtr, Vb1ok, Vb2ok,
        matchStatus: 'PENDING'
      });

      const headerID = header.ID;
      console.log(`[addStatement] Created header with ID: ${headerID}`);

      // Step 3: Process each line and find matches
      let totalMatches = 0;
      let bestMatch = null;
      let bestConfidence = 0;

      for (const [index, lineText] of lines.entries()) {
        const crn = index + 1;

        // Insert line with association to header
        const line = await INSERT.into(BankStatementLine).entries({
          header_ID: headerID,
          crn,
          lineText,
          matched: false
        });

        const lineID = line.ID;

        // Search for matches using fuzzy text search
        const matches = await fuzzyTextSearch(lineText);

        if (matches && matches.length > 0) {
          totalMatches += matches.length;

          // Save top 3 matches
          for (let i = 0; i < Math.min(3, matches.length); i++) {
            const match = matches[i];
            await INSERT.into(LineMatch).entries({
              line_ID: lineID,
              rank: i + 1,
              historical_ID: match.ID,
              confidence: match.confidence,
              strategy: match.strategy,
              wireText: match.wireText,
              postingKey: match.postingKey,
              glAccount: match.glAccount,
              customerNo: match.customerNo,
              companyCode: match.companyCode,
              costCentre: match.costCentre,
              profitCentre: match.profitCentre,
              febanDescription: match.febanDescription,
              isSelected: false
            });

            // Track best match across all lines
            if (match.confidence > bestConfidence) {
              bestConfidence = match.confidence;
              bestMatch = {
                lineNo: crn,
                lineText,
                wireText: match.wireText,
                confidence: match.confidence,
                glAccount: match.glAccount,
                postingKey: match.postingKey
              };
            }
          }

          // Update line with best match
          const topMatch = matches[0];
          await UPDATE(BankStatementLine).set({
            matched: true,
            matchedHistorical_ID: topMatch.ID,
            matchConfidence: topMatch.confidence,
            matchStrategy: topMatch.strategy
          }).where({ ID: lineID });
        }
      }

      // Step 4: Update header with best match info
      if (bestMatch) {
        await UPDATE(BankStatementHeader).set({
          matchStatus: 'MATCHED',
          bestMatchedLineNo: bestMatch.lineNo
        }).where({ ID: headerID });
      } else {
        await UPDATE(BankStatementHeader).set({
          matchStatus: 'NO_MATCH'
        }).where({ ID: headerID });
      }

      return {
        Bukrs, Hbkid, Hktid, Aznum,
        message: `Statement processed successfully`,
        linesProcessed: lines.length,
        matchesFound: totalMatches,
        bestMatch
      };

    } catch (error) {
      console.error('[addStatement] Error:', error);
      throw new Error(`Failed to process statement: ${error.message}`);
    }
  });

  /**
   * Generate Embeddings Action Handler
   * Generates embeddings for both Historical records and EmailCache
   */
  this.on('generateEmbeddings', async () => {
    console.log('\n🤖 Admin: Generating embeddings for Historical and EmailCache...');
    try {
      const result = await generateEmbeddings();
      console.log('✅ Embeddings generated successfully');
      return result;
    } catch (error) {
      console.error('❌ Error generating embeddings:', error);
      throw error;
    }
  });

  /**
   * Sync Emails Action Handler
   * Fetches emails from Outlook and caches them locally with embeddings
   */
  this.on('syncEmails', async (req) => {
    const { daysBack } = req.data;
    const days = daysBack || 2;

    try {
      const db = await cds.connect.to('db');
      const result = await emailSync.syncEmails(db, days);

      return result;

    } catch (error) {
      console.error('❌ Email sync action failed:', error.message);
      return {
        success: false,
        message: 'Email sync failed',
        emailsFetched: 0,
        emailsStored: 0,
        emailsSkipped: 0,
        syncBatchId: null,
        startDate: null,
        endDate: null,
        duration: 0,
        error: error.message
      };
    }
  });

  /**
   * Delete All Statements Action Handler
   */
  this.on('deleteAllStatements', async (req) => {
    try {
      const matchesDeleted = await DELETE.from(LineMatch);
      const linesDeleted = await DELETE.from(BankStatementLine);
      const statementsDeleted = await DELETE.from(BankStatementHeader);

      return {
        message: 'All statements deleted successfully',
        statementsDeleted,
        linesDeleted,
        matchesDeleted
      };
    } catch (error) {
      console.error('[deleteAllStatements] Error:', error);
      throw new Error(`Failed to delete statements: ${error.message}`);
    }
  });

  /**
   * Delete All Emails Action Handler
   * Clears all cached emails for testing
   */
  this.on('deleteAllEmails', async (req) => {
    try {
      const db = await cds.connect.to('db');
      const count = await emailSync.deleteAllEmails(db);

      return {
        message: `Successfully deleted ${count} cached emails`,
        emailsDeleted: count
      };

    } catch (error) {
      console.error('❌ Delete emails action failed:', error.message);
      return {
        message: `Failed to delete emails: ${error.message}`,
        emailsDeleted: 0
      };
    }
  });

  /**
   * Parse payment notes into individual lines
   */
  function parsePaymentNotes(vwezw) {
    if (!vwezw) return [];

    // Split by newlines and filter empty lines
    const lines = vwezw
      .split(/[\r\n]+/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    return lines;
  }

  /**
   * Fuzzy Text Search using HANA CONTAINS
   */
  async function fuzzyTextSearch(lineText) {
    if (!lineText || lineText.trim().length === 0) {
      return [];
    }

    try {
      // Extract meaningful search terms (remove common prefixes like BO:, BN:, etc.)
      const searchText = lineText
        .replace(/^[A-Z]{1,4}:/g, '')  // Remove prefixes like BO:, BN:, etc.
        .trim();

      if (searchText.length < 3) {
        return [];
      }

      // Use HANA fuzzy search with CONTAINS
      const results = await SELECT.from(Historical)
        .where(`CONTAINS(wireText, '${searchText}', FUZZY(0.7))`)
        .limit(3);

      // Calculate confidence scores based on similarity
      return results.map(record => ({
        ID: record.ID,
        wireText: record.wireText,
        postingKey: record.postingKey,
        glAccount: record.glAccount,
        customerNo: record.customerNo,
        companyCode: record.companyCode,
        costCentre: record.costCentre,
        profitCentre: record.profitCentre,
        febanDescription: record.febanDescription,
        confidence: 75, // Default confidence for fuzzy matches
        strategy: 'FUZZY_TEXT'
      }));

    } catch (error) {
      console.error('[fuzzyTextSearch] Error:', error);
      return [];
    }
  }
});
