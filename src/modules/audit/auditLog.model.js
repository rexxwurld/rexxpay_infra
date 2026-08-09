// src/modules/audit/auditLog.model.js
//
// An append-only trail of security-relevant and money-relevant events.
// Regulators, dispute resolution, and incident response all eventually
// need "who did what, when, from where" - and it has to exist BEFORE the
// incident, not be reconstructed after from scattered console.logs.

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    actorType: { type: String, enum: ['merchant', 'system', 'bank_partner', 'admin'], required: true },
    actorRef: { type: String }, // merchant id, "webhook", "reconciliation_job", etc.

    action: { type: String, required: true }, // e.g. "merchant.login", "webhook.signature_invalid", "payout.created"
    entityType: { type: String }, // e.g. "Transaction", "Payout", "Merchant"
    entityRef: { type: String },

    ip: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed }, // small, non-sensitive context only - never store secrets/PII here

    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
  },
  { timestamps: true }
);

auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityRef: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
