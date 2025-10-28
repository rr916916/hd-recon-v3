#!/usr/bin/env node
/**
 * Generate Embeddings for Historical Records
 * Uses HANA's native VECTOR_EMBEDDING function with SAP_GXY.20250407 model
 */

const cds = require('@sap/cds');

async function generateEmbeddings() {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║        HANA Native Embedding Generation                       ║');
  console.log('║        SAP_GXY.20250407 (768d)');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  try {
    const db = await cds.connect.to('db');

    // Test if NLP/VECTOR_EMBEDDING is available
    console.log('🔍 Checking NLP configuration...\n');
    try {
      await db.run(`SELECT VECTOR_EMBEDDING('test', 'DOCUMENT', 'SAP_GXY.20250407') FROM DUMMY`);
      console.log('✅ NLP is enabled');
      console.log('✅ VECTOR_EMBEDDING function available\n');
    } catch (error) {
      console.log('❌ NLP is NOT enabled in HANA Cloud\n');
      console.log('To enable NLP:');
      console.log('   1. Open HANA Cloud Central');
      console.log('   2. Select your HANA instance');
      console.log('   3. Go to Configuration > Natural Language Processing');
      console.log('   4. Enable NLP and restart instance\n');
      return { mode: 'nlp-not-enabled' };
    }

    const startTime = new Date();

    // ============================================================
    // STEP 1: Generate SAP_GXY embeddings (768 dimensions)
    // ============================================================
    console.log('📊 Step 1: Generating SAP_GXY embeddings...\n');
    console.log('   Model: SAP_GXY.20250407');
    console.log('   Dimensions: 768\n');

    const sapUpdateSQL = `
      UPDATE RECONCILIATION_HISTORICAL
      SET embedding = VECTOR_EMBEDDING(wireText, 'DOCUMENT', 'SAP_GXY.20250407')
      WHERE wireText IS NOT NULL
        AND LENGTH(wireText) > 5
    `;

    console.log('🤖 Executing SAP_GXY embedding generation...\n');
    const sapResult = await db.run(sapUpdateSQL);
    console.log(`✅ SAP_GXY embeddings generated: ${sapResult || 0} records\n`);

    const duration = Math.round((new Date() - startTime) / 1000);

    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║        EMBEDDING GENERATION COMPLETE ✅                       ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log(`\n   Duration: ${duration} seconds\n`);

    // ============================================================
    // STEP 2: Generate EmailCache embeddings (768 dimensions)
    // ============================================================
    console.log('📧 Step 2: Generating EmailCache embeddings...\n');
    console.log('   Model: SAP_GXY.20250407');
    console.log('   Dimensions: 768\n');

    const emailUpdateSQL = `
      UPDATE RECONCILIATION_EMAILCACHE
      SET embedding = VECTOR_EMBEDDING(
        subject || ' ' || COALESCE(bodyPreview, '') || ' ' || COALESCE(bodyText, ''),
        'DOCUMENT',
        'SAP_GXY.20250407'
      )
      WHERE (subject IS NOT NULL OR bodyText IS NOT NULL)
        AND LENGTH(COALESCE(subject, '') || COALESCE(bodyText, '')) > 5
    `;

    console.log('🤖 Executing EmailCache embedding generation...\n');
    const emailResult = await db.run(emailUpdateSQL);
    console.log(`✅ EmailCache embeddings generated: ${emailResult || 0} records\n`);

    // Verify embeddings for Historical
    console.log('🔍 Verifying Historical embeddings...\n');
    const historicalVerification = await db.run(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as with_sap_embedding
      FROM RECONCILIATION_HISTORICAL
    `);

    const histTotalRecords = historicalVerification[0].TOTAL;
    const histWithEmbeddings = historicalVerification[0].WITH_SAP_EMBEDDING;
    const histPercentage = histTotalRecords > 0 ? (histWithEmbeddings / histTotalRecords * 100).toFixed(2) : 0;

    console.log(`   Historical total: ${histTotalRecords}`);
    console.log(`   With embeddings: ${histWithEmbeddings} (${histPercentage}%)\n`);

    // Verify embeddings for EmailCache
    console.log('🔍 Verifying EmailCache embeddings...\n');
    const emailVerification = await db.run(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as with_email_embedding
      FROM RECONCILIATION_EMAILCACHE
    `);

    const emailTotalRecords = emailVerification[0].TOTAL;
    const emailWithEmbeddings = emailVerification[0].WITH_EMAIL_EMBEDDING;
    const emailPercentage = emailTotalRecords > 0 ? (emailWithEmbeddings / emailTotalRecords * 100).toFixed(2) : 0;

    console.log(`   EmailCache total: ${emailTotalRecords}`);
    console.log(`   With embeddings: ${emailWithEmbeddings} (${emailPercentage}%)\n`);

    if (histPercentage >= 99 && (emailTotalRecords === 0 || emailPercentage >= 99)) {
      console.log('✅ All embeddings successfully generated!\n');
    } else {
      console.log(`⚠️  Some records missing embeddings\n`);
    }

    return {
      mode: 'hana-native',
      recordsProcessed: (sapResult || 0) + (emailResult || 0),
      duration,
      coverage: `Historical: ${histPercentage}%, EmailCache: ${emailPercentage}%`
    };

  } catch (error) {
    console.error('\n❌ EMBEDDING GENERATION FAILED:', error.message);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  generateEmbeddings()
    .then((result) => {
      if (result.mode === 'nlp-not-enabled') {
        console.log('⚠️  Vector search will not work without NLP enabled.\n');
        process.exit(0);
      } else {
        console.log(`✅ Success! Coverage: ${result.coverage}%\n`);
        process.exit(0);
      }
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { generateEmbeddings };
