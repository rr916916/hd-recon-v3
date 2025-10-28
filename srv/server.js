const cds = require('@sap/cds');

// Explicitly connect service implementation
cds.on('served', async () => {
  const { ReconciliationService } = cds.services;

  if (ReconciliationService) {
    console.log('[Server] Connecting ReconciliationService implementation...');
    const impl = require('./reconciliation-service');
    impl.call(ReconciliationService);
  }
});

module.exports = cds.server;
