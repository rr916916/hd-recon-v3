/**
 * Hybrid Line Matcher for Bank Reconciliation
 *
 * Strategy: Fuzzy-first with Vector fallback
 * 1. Take one line from payment notes
 * 2. Search Historical table using:
 *    a) HANA fuzzy text search (fast, high precision)
 *    b) Vector embedding similarity (slower, high recall)
 * 3. Return best matches
 *
 * Performance optimization:
 * - Fuzzy search first (~10ms) for exact/near-exact matches
 * - Vector search fallback (~50ms) for semantic/difficult matches
 */

const cds = require('@sap/cds');

class LineMatcher {
  constructor() {
    this.name = 'Hybrid Line Matcher (Fuzzy + Vector)';
  }

  /**
   * Parallel Fuzzy + SAP Vector + OpenAI Vector Search with Merged Results
   *
   * CLERK WORKFLOW (v2.8.0):
   * 1. Run fuzzy, SAP vector, AND OpenAI vector searches in parallel
   * 2. Merge results and deduplicate by ID
   * 3. Keep only matches with confidence ≥ 85%
   * 4. Sort by confidence (highest first)
   *
   * This mirrors how clerks look at multiple sources to find the best match
   *
   * @param {string} lineText - One line from payment notes
   * @returns {Array} - Array of unique matches with confidence ≥ 85%
   */
  async searchLine(lineText) {
    if (!lineText || lineText.trim().length < 5) {
      console.log(`      ⏭️  Skipping search - line too short (${lineText?.length || 0} chars)`);
      return []; // Skip very short lines
    }

    // Log the search input
    console.log(`      📥 Search input: "${lineText.substring(0, 100)}${lineText.length > 100 ? '...' : ''}"`);
    console.log(`      📏 Input length: ${lineText.length} characters`);

    const db = await cds.connect.to('db');

    try {
      // Run ALL THREE searches in parallel
      console.log(`      🔍 Running fuzzy + SAP vector + OpenAI vector searches in parallel...`);

      const [fuzzyMatches, vectorMatches, openaiMatches] = await Promise.all([
        this.fuzzySearch(db, lineText).catch(err => {
          console.log(`         ⚠️  Fuzzy search error: ${err.message}`);
          return [];
        }),
        this.vectorSearch(db, lineText).catch(err => {
          console.log(`         ⚠️  SAP vector search error: ${err.message}`);
          return [];
        }),
        this.openaiEmbeddingSearch(db, lineText).catch(err => {
          console.log(`         ⚠️  OpenAI vector search error: ${err.message}`);
          return [];
        })
      ]);

      console.log(`      📊 Fuzzy: ${fuzzyMatches.length}, SAP Vector: ${vectorMatches.length}, OpenAI Vector: ${openaiMatches.length}`);

      // Merge results and deduplicate by ID
      const allMatches = [...fuzzyMatches, ...vectorMatches, ...openaiMatches];
      const uniqueMatches = this.deduplicateMatches(allMatches);

      // Filter by confidence threshold (≥85%)
      // After implementing BO text extraction, we can use 85% threshold
      // (extraction prevents long queries from diluting similarity)
      const MIN_CONFIDENCE = 85;
      const filteredMatches = uniqueMatches.filter(m => m.confidence >= MIN_CONFIDENCE);

      // Sort by confidence (highest first)
      filteredMatches.sort((a, b) => b.confidence - a.confidence);

      console.log(`      ✅ Merged to ${uniqueMatches.length} unique, ${filteredMatches.length} above ${MIN_CONFIDENCE}%`);

      if (filteredMatches.length > 0) {
        const topMatch = filteredMatches[0];
        console.log(`      🎯 Top match: ${topMatch.wireText?.substring(0, 50)}... (${topMatch.confidence}%, ${topMatch.matchStrategy})`);
      }

      return filteredMatches;

    } catch (error) {
      console.error(`   ❌ Error searching line "${lineText.substring(0, 50)}":`, error.message);
      return [];
    }
  }

  /**
   * Deduplicate matches by ID, keeping the one with highest confidence
   * @param {Array} matches - Array of match objects with ID and confidence
   * @returns {Array} - Deduplicated array
   */
  deduplicateMatches(matches) {
    const matchMap = new Map();

    for (const match of matches) {
      const id = match.ID;

      if (!matchMap.has(id)) {
        matchMap.set(id, match);
      } else {
        // Keep the match with higher confidence
        const existing = matchMap.get(id);
        if (match.confidence > existing.confidence) {
          matchMap.set(id, match);
        }
      }
    }

    return Array.from(matchMap.values());
  }


  /**
   * Vector Embedding Similarity Search
   * Uses HANA's native VECTOR_EMBEDDING() and COSINE_SIMILARITY()
   *
   * Asymmetric Search (DOCUMENT vs QUERY)
   * - Historical records use 'DOCUMENT' (corpus/knowledge base)
   * - Search queries use 'QUERY' (semantic intent, user query)
   *
   * TESTED: Symmetric Search (DOCUMENT vs DOCUMENT) - v2.7.0
   * - Result: No improvement in false positives (REPAIRCLINIC still 82% vs 81%)
   * - Reverted to QUERY mode for semantic search intent
   */
  async vectorSearch(db, lineText) {
    try {
      // VECTOR_EMBEDDING(text, type, model)
      // - text: search line text (parameter ?)
      // - type: QUERY (semantic search intent)
      // - model: SAP_GXY.20250407
      const query = `
        SELECT
          ID,
          wireText,
          postingKey,
          glAccount,
          customerNo,
          companyCode,
          costCentre,
          profitCentre,
          usageCount,
          successCount,
          lastUsedDate,
          COSINE_SIMILARITY(
            embedding,
            TO_REAL_VECTOR(VECTOR_EMBEDDING(?, 'QUERY', 'SAP_GXY.20250407'))
          ) as similarity
        FROM RECONCILIATION_HISTORICAL
        WHERE embedding IS NOT NULL
        ORDER BY similarity DESC
        LIMIT 10
      `;

      console.log(`         📝 Vector SQL: COSINE_SIMILARITY(embedding, VECTOR_EMBEDDING("${lineText.substring(0, 50)}...", QUERY)) LIMIT 10`);
      const startTime = Date.now();
      const results = await db.run(query, [lineText]);
      const elapsed = Date.now() - startTime;

      console.log(`         ⏱️  Vector search took ${elapsed}ms`);
      console.log(`         📊 Found ${results.length} vector matches`);

      return results.map((record, idx) => {
        // Convert cosine similarity (0-1) to confidence (60-95%)
        // Using 1 decimal place for better granularity (e.g., 85.3% vs 85%)
        const similarity = record.SIMILARITY || record.similarity || 0;
        const confidence = Math.round((60 + (similarity * 35)) * 10) / 10;

        if (idx < 3) {
          console.log(`         ${idx + 1}. ${record.WIRETEXT?.substring(0, 50) || record.wireText?.substring(0, 50)}... (sim: ${similarity.toFixed(3)}, conf: ${confidence}%)`);
        }

        return {
          ID: record.ID,
          wireText: record.WIRETEXT || record.wireText,
          confidence,
          matchStrategy: 'VECTOR_SEMANTIC',
          similarity,
          postingKey: record.POSTINGKEY || record.postingKey,
          glAccount: record.GLACCOUNT || record.glAccount,
          customerNo: record.CUSTOMERNO || record.customerNo,
          companyCode: record.COMPANYCODE || record.companyCode,
          costCentre: record.COSTCENTRE || record.costCentre,
          profitCentre: record.PROFITCENTRE || record.profitCentre,
          usageCount: record.USAGECOUNT || record.usageCount || 0,
          successCount: record.SUCCESSCOUNT || record.successCount || 0,
          lastUsedDate: record.LASTUSEDDATE || record.lastUsedDate
        };
      });

    } catch (error) {
      console.error('         ⚠️  Vector search error:', error.message);
      return [];
    }
  }

  /**
   * Fuzzy Text Search using HANA's CONTAINS()
   * Uses HANA's built-in fuzzy search with stemming and synonyms
   */
  async fuzzySearch(db, lineText) {
    try {
      // Use HANA's CONTAINS for fuzzy text search
      // CONTAINS supports fuzzy search, linguistic processing, and ranking
      const query = `
        SELECT
          ID,
          wireText,
          postingKey,
          glAccount,
          customerNo,
          companyCode,
          costCentre,
          profitCentre,
          usageCount,
          successCount,
          lastUsedDate,
          SCORE() as score
        FROM RECONCILIATION_HISTORICAL
        WHERE CONTAINS(wireText, ?, FUZZY(0.8))
        ORDER BY score DESC
        LIMIT 10
      `;

      console.log(`         📝 Fuzzy SQL: CONTAINS(wireText, "${lineText.substring(0, 50)}...", FUZZY(0.8)) LIMIT 10`);
      const startTime = Date.now();
      const results = await db.run(query, [lineText]);
      const elapsed = Date.now() - startTime;

      console.log(`         ⏱️  Fuzzy search took ${elapsed}ms`);
      console.log(`         📊 Found ${results.length} fuzzy matches`);

      return results.map((record, idx) => {
        // Convert HANA SCORE (0-1) to confidence (60-95%)
        // Using 1 decimal place for better granularity (e.g., 85.3% vs 85%)
        const score = record.SCORE || record.score || 0;
        const confidence = Math.round((60 + (score * 35)) * 10) / 10;

        if (idx < 3) {
          console.log(`         ${idx + 1}. ${record.WIRETEXT?.substring(0, 50) || record.wireText?.substring(0, 50)}... (score: ${score.toFixed(3)}, conf: ${confidence}%)`);
        }

        return {
          ID: record.ID,
          wireText: record.WIRETEXT || record.wireText,
          confidence,
          matchStrategy: 'FUZZY_TEXT',
          score,
          postingKey: record.POSTINGKEY || record.postingKey,
          glAccount: record.GLACCOUNT || record.glAccount,
          customerNo: record.CUSTOMERNO || record.customerNo,
          companyCode: record.COMPANYCODE || record.companyCode,
          costCentre: record.COSTCENTRE || record.costCentre,
          profitCentre: record.PROFITCENTRE || record.profitCentre,
          usageCount: record.USAGECOUNT || record.usageCount || 0,
          successCount: record.SUCCESSCOUNT || record.successCount || 0,
          lastUsedDate: record.LASTUSEDDATE || record.lastUsedDate
        };
      });

    } catch (error) {
      console.error('         ⚠️  Fuzzy search error:', error.message);
      return [];
    }
  }

  /**
   * OpenAI Embedding Search using HANA Remote Source
   * Uses HANA's VECTOR_EMBEDDING() function with OpenAI text-embedding-3-small model
   *
   * Prerequisites:
   * 1. Create remote source in HANA (already configured)
   * 2. Model: text-embedding-3-small (1536 dimensions)
   * 3. Usage: VECTOR_EMBEDDING('text', 'DOCUMENT', 'text-embedding-3-small."1"', MY_SERVICE_INSTANCE)
   *
   * Falls back gracefully if not configured
   */
  async openaiEmbeddingSearch(db, lineText) {
    try {
      // Check if OpenAI remote source is configured
      const remoteSourceName = process.env.OPENAI_REMOTE_SOURCE || 'MY_SERVICE_INSTANCE';

      console.log(`         🤖 Using OpenAI text-embedding-3-small via remote source: ${remoteSourceName}`);

      const startTime = Date.now();

      // Use HANA's VECTOR_EMBEDDING function with OpenAI model
      // The remote source handles the API call to OpenAI
      // IMPORTANT: Query using openaiEmbedding column (1536-dim), not embedding (768-dim)
      const query = `
        SELECT
          ID,
          wireText,
          postingKey,
          glAccount,
          customerNo,
          companyCode,
          costCentre,
          profitCentre,
          usageCount,
          successCount,
          lastUsedDate,
          COSINE_SIMILARITY(
            openaiEmbedding,
            TO_REAL_VECTOR(
              VECTOR_EMBEDDING(?, 'DOCUMENT', 'text-embedding-3-small."1"', ${remoteSourceName})
            )
          ) as similarity
        FROM RECONCILIATION_HISTORICAL
        WHERE openaiEmbedding IS NOT NULL
        ORDER BY similarity DESC
        LIMIT 10
      `;

      const results = await db.run(query, [lineText]);
      const totalTime = Date.now() - startTime;

      console.log(`         ⏱️  OpenAI embedding search took ${totalTime}ms`);
      console.log(`         📊 Found ${results.length} OpenAI embedding matches`);

      return results.map((record, idx) => {
        // Convert cosine similarity (0-1) to confidence (60-95%)
        // Using 1 decimal place for better granularity (e.g., 85.3% vs 85%)
        const similarity = record.SIMILARITY || record.similarity || 0;
        const confidence = Math.round((60 + (similarity * 35)) * 10) / 10;

        if (idx < 3) {
          console.log(`         ${idx + 1}. ${record.WIRETEXT?.substring(0, 50) || record.wireText?.substring(0, 50)}... (sim: ${similarity.toFixed(3)}, conf: ${confidence}%)`);
        }

        return {
          ID: record.ID,
          wireText: record.WIRETEXT || record.wireText,
          confidence,
          matchStrategy: 'OPENAI_EMBEDDING',
          similarity,
          postingKey: record.POSTINGKEY || record.postingKey,
          glAccount: record.GLACCOUNT || record.glAccount,
          customerNo: record.CUSTOMERNO || record.customerNo,
          companyCode: record.COMPANYCODE || record.companyCode,
          costCentre: record.COSTCENTRE || record.costCentre,
          profitCentre: record.PROFITCENTRE || record.profitCentre,
          usageCount: record.USAGECOUNT || record.usageCount || 0,
          successCount: record.SUCCESSCOUNT || record.successCount || 0,
          lastUsedDate: record.LASTUSEDDATE || record.lastUsedDate
        };
      });

    } catch (error) {
      console.error('         ⚠️  OpenAI embedding search error:', error.message);
      console.error('         💡 Check remote source configuration in HANA');
      return [];
    }
  }

  /**
   * ChatGPT Search via SAP AI Core (DISABLED - Not configured)
   * Uses ChatGPT model as a RE-RANKER for semantic matching
   *
   * Strategy:
   * 1. Use Vector search to get top 100 RELEVANT candidates (scans all records)
   * 2. Send top 20 candidates to ChatGPT for intelligent re-ranking
   * 3. ChatGPT provides confidence scores + reasoning
   *
   * This ensures we don't miss matches that are beyond first 100 records in DB.
   *
   * Prerequisites:
   * - SAP AI Core instance configured
   * - ChatGPT deployment set up
   * - Destination "AICORE" configured in BTP
   *
   * CURRENTLY DISABLED - Returns empty array
   */
  async chatgptSearch(db, lineText) {
    console.log('         ℹ️  ChatGPT reranker disabled - not configured');
    return [];
  }

  /**
   * Search using all methods and return comparison results
   * @param {string} lineText - One line from payment notes
   * @returns {Object} - Results from all search methods
   */
  async searchLineComparison(lineText) {
    if (!lineText || lineText.trim().length < 5) {
      return {
        vector: [],
        fuzzy: [],
        chatgpt: [],
        openaiEmbedding: []
      };
    }

    const db = await cds.connect.to('db');

    try {
      // Run all searches in parallel
      console.log(`      🔍 Running comparison: Vector (SAP) + Fuzzy + ChatGPT Reranker + OpenAI Embedding...`);

      const [vectorMatches, fuzzyMatches, chatgptMatches, openaiEmbeddingMatches] = await Promise.all([
        this.vectorSearch(db, lineText),
        this.fuzzySearch(db, lineText),
        this.chatgptSearch(db, lineText).catch(err => {
          console.log('         ℹ️  ChatGPT reranker skipped:', err.message);
          return [];
        }),
        this.openaiEmbeddingSearch(db, lineText).catch(err => {
          console.log('         ℹ️  OpenAI embedding skipped:', err.message);
          return [];
        })
      ]);

      return {
        vector: vectorMatches,
        fuzzy: fuzzyMatches,
        chatgpt: chatgptMatches,
        openaiEmbedding: openaiEmbeddingMatches
      };

    } catch (error) {
      console.error(`   ❌ Error in comparison search:`, error.message);
      return {
        vector: [],
        fuzzy: [],
        chatgpt: [],
        openaiEmbedding: []
      };
    }
  }

}

module.exports = new LineMatcher();
