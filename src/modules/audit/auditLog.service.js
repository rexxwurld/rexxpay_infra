// src/modules/audit/auditLog.service.js
const AuditLog = require('./auditLog.model');

// Fire-and-forget by design: a failure to WRITE an audit log must never
// block or fail the underlying business operation. Log the failure to
// stderr instead so an ops alert can catch it.
async function record({ actorType, actorRef, action, entityType, entityRef, ip, metadata, severity }) {
  try {
    await AuditLog.create({ actorType, actorRef, action, entityType, entityRef, ip, metadata, severity });
  } catch (err) {
    console.error('[audit] failed to write audit log:', err.message, { action });
  }
}

module.exports = { record };
