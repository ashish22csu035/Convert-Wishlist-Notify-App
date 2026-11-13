-- Billing enforcement support. Forward-only and additive: three nullable columns and one index, no existing row is changed.
--
-- EmailDelivery.planAtSend / reservedAt: which plan an email's quota was reserved under (set when a worker claims the row, written
-- again with the SENT update) and when it was reserved. NULL planAtSend = an email recorded before this migration (legacy): the
-- app counts it against Basic and never against a paid plan. The index serves the per-shop quota count.
ALTER TABLE `EmailDelivery` ADD COLUMN `planAtSend` ENUM('BASIC', 'ADVANCE', 'ENTERPRISE') NULL,
    ADD COLUMN `reservedAt` DATETIME(3) NULL;

CREATE INDEX `EmailDelivery_shopId_status_planAtSend_idx` ON `EmailDelivery`(`shopId`, `status`, `planAtSend`);

-- ShopSubscription.verificationLeaseExpiresAt: the claim of the verification worker. NULL or in the past = claimable, so a
-- crashed worker's claim expires by itself.
ALTER TABLE `ShopSubscription` ADD COLUMN `verificationLeaseExpiresAt` DATETIME(3) NULL;
