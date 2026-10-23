-- Primary keys and foreign keys of ten tables move from INT to UUID v4 (CHAR(36)).
--
-- Migrated primary keys: Shop, Actor, BrowsingSession, ActivityEvent, WishlistItem, ShopSettings,
-- NotifySubscription, EmailDelivery, VariantAvailability, WebhookEvent.
-- Tables whose own key stays INT but whose foreign keys move: ShopifyOrder, ShopifyOrderLineItem, OrderAttribution.
-- Shopify identifiers (GIDs, webhook ids, dedupe keys) and the Shopify auth Session table are not touched.
--
-- Existing rows are kept: every old numeric id is given a random UUID v4 (RANDOM_BYTES, not UUID(), which is
-- version 1), every foreign key is rewritten through the new id of its parent, and the old-to-new mapping is
-- kept in IdMapping. Nothing is dropped and re-created from scratch; the CHECK constraints are untouched.
-- Steps: 1 new id columns, 2 mapping, 3 new foreign-key columns, 4 drop foreign keys, 5 drop old columns and
-- the indexes on them, 6 rename the new columns and re-create keys and indexes, 7 re-create foreign keys.


-- 1. new id columns -----------------------------------------------------------------------------
ALTER TABLE `Shop` ADD COLUMN `uuid` CHAR(36) NULL;
ALTER TABLE `ShopSettings` ADD COLUMN `uuid` CHAR(36) NULL;
ALTER TABLE `Actor` ADD COLUMN `uuid` CHAR(36) NULL;
ALTER TABLE `BrowsingSession` ADD COLUMN `uuid` CHAR(36) NULL;
ALTER TABLE `ActivityEvent` ADD COLUMN `uuid` CHAR(36) NULL;
ALTER TABLE `WishlistItem` ADD COLUMN `uuid` CHAR(36) NULL;
ALTER TABLE `NotifySubscription` ADD COLUMN `uuid` CHAR(36) NULL;
ALTER TABLE `EmailDelivery` ADD COLUMN `uuid` CHAR(36) NULL;
ALTER TABLE `VariantAvailability` ADD COLUMN `uuid` CHAR(36) NULL;
ALTER TABLE `WebhookEvent` ADD COLUMN `uuid` CHAR(36) NULL;
UPDATE `Shop` SET `uuid` = LOWER(CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4', SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', ELT(1 + (ORD(RANDOM_BYTES(1)) & 3), '8', '9', 'a', 'b'), SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', HEX(RANDOM_BYTES(6))));
UPDATE `ShopSettings` SET `uuid` = LOWER(CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4', SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', ELT(1 + (ORD(RANDOM_BYTES(1)) & 3), '8', '9', 'a', 'b'), SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', HEX(RANDOM_BYTES(6))));
UPDATE `Actor` SET `uuid` = LOWER(CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4', SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', ELT(1 + (ORD(RANDOM_BYTES(1)) & 3), '8', '9', 'a', 'b'), SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', HEX(RANDOM_BYTES(6))));
UPDATE `BrowsingSession` SET `uuid` = LOWER(CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4', SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', ELT(1 + (ORD(RANDOM_BYTES(1)) & 3), '8', '9', 'a', 'b'), SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', HEX(RANDOM_BYTES(6))));
UPDATE `ActivityEvent` SET `uuid` = LOWER(CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4', SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', ELT(1 + (ORD(RANDOM_BYTES(1)) & 3), '8', '9', 'a', 'b'), SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', HEX(RANDOM_BYTES(6))));
UPDATE `WishlistItem` SET `uuid` = LOWER(CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4', SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', ELT(1 + (ORD(RANDOM_BYTES(1)) & 3), '8', '9', 'a', 'b'), SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', HEX(RANDOM_BYTES(6))));
UPDATE `NotifySubscription` SET `uuid` = LOWER(CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4', SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', ELT(1 + (ORD(RANDOM_BYTES(1)) & 3), '8', '9', 'a', 'b'), SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', HEX(RANDOM_BYTES(6))));
UPDATE `EmailDelivery` SET `uuid` = LOWER(CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4', SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', ELT(1 + (ORD(RANDOM_BYTES(1)) & 3), '8', '9', 'a', 'b'), SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', HEX(RANDOM_BYTES(6))));
UPDATE `VariantAvailability` SET `uuid` = LOWER(CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4', SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', ELT(1 + (ORD(RANDOM_BYTES(1)) & 3), '8', '9', 'a', 'b'), SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', HEX(RANDOM_BYTES(6))));
UPDATE `WebhookEvent` SET `uuid` = LOWER(CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4', SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', ELT(1 + (ORD(RANDOM_BYTES(1)) & 3), '8', '9', 'a', 'b'), SUBSTRING(HEX(RANDOM_BYTES(2)), 2), '-', HEX(RANDOM_BYTES(6))));

-- 2. mapping of every old id to its new id ---------------------------------------------------------
CREATE TABLE `IdMapping` (
  `tableName` VARCHAR(64) NOT NULL,
  `oldId` INTEGER NOT NULL,
  `newId` CHAR(36) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`tableName`, `oldId`),
  UNIQUE INDEX `IdMapping_newId_key`(`newId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `IdMapping` (`tableName`, `oldId`, `newId`) SELECT 'Shop', `id`, `uuid` FROM `Shop`;
INSERT INTO `IdMapping` (`tableName`, `oldId`, `newId`) SELECT 'ShopSettings', `id`, `uuid` FROM `ShopSettings`;
INSERT INTO `IdMapping` (`tableName`, `oldId`, `newId`) SELECT 'Actor', `id`, `uuid` FROM `Actor`;
INSERT INTO `IdMapping` (`tableName`, `oldId`, `newId`) SELECT 'BrowsingSession', `id`, `uuid` FROM `BrowsingSession`;
INSERT INTO `IdMapping` (`tableName`, `oldId`, `newId`) SELECT 'ActivityEvent', `id`, `uuid` FROM `ActivityEvent`;
INSERT INTO `IdMapping` (`tableName`, `oldId`, `newId`) SELECT 'WishlistItem', `id`, `uuid` FROM `WishlistItem`;
INSERT INTO `IdMapping` (`tableName`, `oldId`, `newId`) SELECT 'NotifySubscription', `id`, `uuid` FROM `NotifySubscription`;
INSERT INTO `IdMapping` (`tableName`, `oldId`, `newId`) SELECT 'EmailDelivery', `id`, `uuid` FROM `EmailDelivery`;
INSERT INTO `IdMapping` (`tableName`, `oldId`, `newId`) SELECT 'VariantAvailability', `id`, `uuid` FROM `VariantAvailability`;
INSERT INTO `IdMapping` (`tableName`, `oldId`, `newId`) SELECT 'WebhookEvent', `id`, `uuid` FROM `WebhookEvent`;

-- 3. new foreign-key columns, filled through the parent mapping -----------------------------------
ALTER TABLE `ShopSettings` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `Actor` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `BrowsingSession` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `BrowsingSession` ADD COLUMN `actorId_uuid` CHAR(36) NULL;
ALTER TABLE `ActivityEvent` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `ActivityEvent` ADD COLUMN `actorId_uuid` CHAR(36) NULL;
ALTER TABLE `ActivityEvent` ADD COLUMN `browsingSessionId_uuid` CHAR(36) NULL;
ALTER TABLE `WishlistItem` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `WishlistItem` ADD COLUMN `actorId_uuid` CHAR(36) NULL;
ALTER TABLE `NotifySubscription` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `NotifySubscription` ADD COLUMN `actorId_uuid` CHAR(36) NULL;
ALTER TABLE `EmailDelivery` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `EmailDelivery` ADD COLUMN `subscriptionId_uuid` CHAR(36) NULL;
ALTER TABLE `VariantAvailability` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `WebhookEvent` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `ShopifyOrder` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `ShopifyOrderLineItem` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `OrderAttribution` ADD COLUMN `shopId_uuid` CHAR(36) NULL;
ALTER TABLE `OrderAttribution` ADD COLUMN `touchEventId_uuid` CHAR(36) NULL;
UPDATE `ShopSettings` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `Actor` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `BrowsingSession` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `BrowsingSession` c JOIN `Actor` p ON c.`actorId` = p.`id` SET c.`actorId_uuid` = p.`uuid`;
UPDATE `ActivityEvent` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `ActivityEvent` c JOIN `Actor` p ON c.`actorId` = p.`id` SET c.`actorId_uuid` = p.`uuid`;
UPDATE `ActivityEvent` c JOIN `BrowsingSession` p ON c.`browsingSessionId` = p.`id` SET c.`browsingSessionId_uuid` = p.`uuid`;
UPDATE `WishlistItem` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `WishlistItem` c JOIN `Actor` p ON c.`actorId` = p.`id` SET c.`actorId_uuid` = p.`uuid`;
UPDATE `NotifySubscription` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `NotifySubscription` c JOIN `Actor` p ON c.`actorId` = p.`id` SET c.`actorId_uuid` = p.`uuid`;
UPDATE `EmailDelivery` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `EmailDelivery` c JOIN `NotifySubscription` p ON c.`subscriptionId` = p.`id` SET c.`subscriptionId_uuid` = p.`uuid`;
UPDATE `VariantAvailability` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `WebhookEvent` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `ShopifyOrder` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `ShopifyOrderLineItem` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `OrderAttribution` c JOIN `Shop` p ON c.`shopId` = p.`id` SET c.`shopId_uuid` = p.`uuid`;
UPDATE `OrderAttribution` c JOIN `ActivityEvent` p ON c.`touchEventId` = p.`id` SET c.`touchEventId_uuid` = p.`uuid`;

-- 4. drop the foreign keys that touch a migrated column --------------------------------------------
ALTER TABLE `ShopSettings` DROP FOREIGN KEY `ShopSettings_shopId_fkey`;
ALTER TABLE `Actor` DROP FOREIGN KEY `Actor_shopId_fkey`;
ALTER TABLE `BrowsingSession` DROP FOREIGN KEY `BrowsingSession_actorId_shopId_fkey`;
ALTER TABLE `ActivityEvent` DROP FOREIGN KEY `ActivityEvent_actorId_shopId_fkey`;
ALTER TABLE `ActivityEvent` DROP FOREIGN KEY `ActivityEvent_browsingSessionId_shopId_feature_fkey`;
ALTER TABLE `WishlistItem` DROP FOREIGN KEY `WishlistItem_actorId_shopId_fkey`;
ALTER TABLE `NotifySubscription` DROP FOREIGN KEY `NotifySubscription_actorId_shopId_fkey`;
ALTER TABLE `EmailDelivery` DROP FOREIGN KEY `EmailDelivery_subscriptionId_shopId_fkey`;
ALTER TABLE `VariantAvailability` DROP FOREIGN KEY `VariantAvailability_shopId_fkey`;
ALTER TABLE `WebhookEvent` DROP FOREIGN KEY `WebhookEvent_shopId_fkey`;
ALTER TABLE `ShopifyOrder` DROP FOREIGN KEY `ShopifyOrder_shopId_fkey`;
ALTER TABLE `ShopifyOrderLineItem` DROP FOREIGN KEY `ShopifyOrderLineItem_orderId_shopId_fkey`;
ALTER TABLE `OrderAttribution` DROP FOREIGN KEY `OrderAttribution_orderId_shopId_fkey`;
ALTER TABLE `OrderAttribution` DROP FOREIGN KEY `OrderAttribution_touchEventId_fkey`;

-- 5. drop the indexes on, and then the old versions of, the migrated columns ----------------------
ALTER TABLE `Shop`
  DROP PRIMARY KEY,
  DROP COLUMN `id`;
ALTER TABLE `ShopSettings`
  DROP INDEX `ShopSettings_shopId_key`,
  DROP PRIMARY KEY,
  DROP COLUMN `id`,
  DROP COLUMN `shopId`;
ALTER TABLE `Actor`
  DROP INDEX `Actor_id_shopId_key`,
  DROP INDEX `Actor_shopId_customerGid_key`,
  DROP PRIMARY KEY,
  DROP COLUMN `id`,
  DROP COLUMN `shopId`;
ALTER TABLE `BrowsingSession`
  DROP INDEX `BrowsingSession_id_shopId_key`,
  DROP INDEX `BrowsingSession_id_shopId_feature_key`,
  DROP INDEX `BrowsingSession_actorId_expiresAt_idx`,
  DROP INDEX `BrowsingSession_shopId_startedAt_idx`,
  DROP INDEX `BrowsingSession_actorId_shopId_fkey`,
  DROP PRIMARY KEY,
  DROP COLUMN `id`,
  DROP COLUMN `shopId`,
  DROP COLUMN `actorId`;
ALTER TABLE `ActivityEvent`
  DROP INDEX `ActivityEvent_shopId_occurredAt_idx`,
  DROP INDEX `ActivityEvent_shopId_type_occurredAt_idx`,
  DROP INDEX `ActivityEvent_actorId_type_occurredAt_idx`,
  DROP INDEX `ActivityEvent_browsingSessionId_idx`,
  DROP INDEX `ActivityEvent_actorId_shopId_fkey`,
  DROP INDEX `ActivityEvent_browsingSessionId_shopId_feature_fkey`,
  DROP PRIMARY KEY,
  DROP COLUMN `id`,
  DROP COLUMN `shopId`,
  DROP COLUMN `actorId`,
  DROP COLUMN `browsingSessionId`;
ALTER TABLE `WishlistItem`
  DROP INDEX `WishlistItem_actorId_variantGid_key`,
  DROP INDEX `WishlistItem_shopId_productGid_idx`,
  DROP INDEX `WishlistItem_shopId_createdAt_idx`,
  DROP INDEX `WishlistItem_actorId_shopId_fkey`,
  DROP INDEX `WishlistItem_actorId_productGid_idx`,
  DROP PRIMARY KEY,
  DROP COLUMN `id`,
  DROP COLUMN `shopId`,
  DROP COLUMN `actorId`;
ALTER TABLE `NotifySubscription`
  DROP INDEX `NotifySubscription_id_shopId_key`,
  DROP INDEX `NotifySubscription_shopId_actorId_variantGid_key`,
  DROP INDEX `NotifySubscription_shopId_variantGid_status_idx`,
  DROP INDEX `NotifySubscription_actorId_shopId_fkey`,
  DROP PRIMARY KEY,
  DROP COLUMN `id`,
  DROP COLUMN `shopId`,
  DROP COLUMN `actorId`;
ALTER TABLE `EmailDelivery`
  DROP INDEX `EmailDelivery_subscriptionId_restockCycle_key`,
  DROP INDEX `EmailDelivery_shopId_createdAt_idx`,
  DROP INDEX `EmailDelivery_subscriptionId_shopId_fkey`,
  DROP PRIMARY KEY,
  DROP COLUMN `id`,
  DROP COLUMN `shopId`,
  DROP COLUMN `subscriptionId`;
ALTER TABLE `VariantAvailability`
  DROP INDEX `VariantAvailability_shopId_variantGid_key`,
  DROP INDEX `VariantAvailability_shopId_inventoryItemGid_idx`,
  DROP INDEX `VariantAvailability_shopId_productGid_idx`,
  DROP PRIMARY KEY,
  DROP COLUMN `id`,
  DROP COLUMN `shopId`;
ALTER TABLE `WebhookEvent`
  DROP INDEX `WebhookEvent_shopId_fkey`,
  DROP PRIMARY KEY,
  DROP COLUMN `id`,
  DROP COLUMN `shopId`;
ALTER TABLE `ShopifyOrder`
  DROP INDEX `ShopifyOrder_id_shopId_key`,
  DROP INDEX `ShopifyOrder_shopId_orderGid_key`,
  DROP INDEX `ShopifyOrder_shopId_placedAt_idx`,
  DROP INDEX `ShopifyOrder_shopId_customerGid_placedAt_idx`,
  DROP COLUMN `shopId`;
ALTER TABLE `ShopifyOrderLineItem`
  DROP INDEX `ShopifyOrderLineItem_shopId_variantGid_idx`,
  DROP INDEX `ShopifyOrderLineItem_shopId_productGid_idx`,
  DROP INDEX `ShopifyOrderLineItem_orderId_shopId_fkey`,
  DROP COLUMN `shopId`;
ALTER TABLE `OrderAttribution`
  DROP INDEX `OrderAttribution_orderId_shopId_key`,
  DROP INDEX `OrderAttribution_shopId_feature_attributedAt_idx`,
  DROP INDEX `OrderAttribution_touchEventId_idx`,
  DROP COLUMN `shopId`,
  DROP COLUMN `touchEventId`;

-- 6. final column names, primary keys and indexes -------------------------------------------------
ALTER TABLE `Shop`
  CHANGE COLUMN `uuid` `id` CHAR(36) NOT NULL,
  ADD PRIMARY KEY (`id`);
ALTER TABLE `ShopSettings`
  CHANGE COLUMN `uuid` `id` CHAR(36) NOT NULL,
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NOT NULL,
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE INDEX `ShopSettings_shopId_key`(`shopId`);
ALTER TABLE `Actor`
  CHANGE COLUMN `uuid` `id` CHAR(36) NOT NULL,
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NOT NULL,
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE INDEX `Actor_id_shopId_key`(`id`, `shopId`),
  ADD UNIQUE INDEX `Actor_shopId_customerGid_key`(`shopId`, `customerGid`);
ALTER TABLE `BrowsingSession`
  CHANGE COLUMN `uuid` `id` CHAR(36) NOT NULL,
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NOT NULL,
  CHANGE COLUMN `actorId_uuid` `actorId` CHAR(36) NOT NULL,
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE INDEX `BrowsingSession_id_shopId_key`(`id`, `shopId`),
  ADD UNIQUE INDEX `BrowsingSession_id_shopId_feature_key`(`id`, `shopId`, `feature`),
  ADD INDEX `BrowsingSession_actorId_expiresAt_idx`(`actorId`, `expiresAt`),
  ADD INDEX `BrowsingSession_shopId_startedAt_idx`(`shopId`, `startedAt`),
  ADD INDEX `BrowsingSession_actorId_shopId_fkey`(`actorId`, `shopId`);
ALTER TABLE `ActivityEvent`
  CHANGE COLUMN `uuid` `id` CHAR(36) NOT NULL,
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NOT NULL,
  CHANGE COLUMN `actorId_uuid` `actorId` CHAR(36) NOT NULL,
  CHANGE COLUMN `browsingSessionId_uuid` `browsingSessionId` CHAR(36) NULL,
  ADD PRIMARY KEY (`id`),
  ADD INDEX `ActivityEvent_shopId_occurredAt_idx`(`shopId`, `occurredAt`),
  ADD INDEX `ActivityEvent_shopId_type_occurredAt_idx`(`shopId`, `type`, `occurredAt`),
  ADD INDEX `ActivityEvent_actorId_type_occurredAt_idx`(`actorId`, `type`, `occurredAt`),
  ADD INDEX `ActivityEvent_browsingSessionId_idx`(`browsingSessionId`),
  ADD INDEX `ActivityEvent_actorId_shopId_fkey`(`actorId`, `shopId`),
  ADD INDEX `ActivityEvent_browsingSessionId_shopId_feature_fkey`(`browsingSessionId`, `shopId`, `feature`);
ALTER TABLE `WishlistItem`
  CHANGE COLUMN `uuid` `id` CHAR(36) NOT NULL,
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NOT NULL,
  CHANGE COLUMN `actorId_uuid` `actorId` CHAR(36) NOT NULL,
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE INDEX `WishlistItem_actorId_variantGid_key`(`actorId`, `variantGid`),
  ADD INDEX `WishlistItem_shopId_productGid_idx`(`shopId`, `productGid`),
  ADD INDEX `WishlistItem_shopId_createdAt_idx`(`shopId`, `createdAt`),
  ADD INDEX `WishlistItem_actorId_shopId_fkey`(`actorId`, `shopId`),
  ADD INDEX `WishlistItem_actorId_productGid_idx`(`actorId`, `productGid`);
ALTER TABLE `NotifySubscription`
  CHANGE COLUMN `uuid` `id` CHAR(36) NOT NULL,
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NOT NULL,
  CHANGE COLUMN `actorId_uuid` `actorId` CHAR(36) NOT NULL,
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE INDEX `NotifySubscription_id_shopId_key`(`id`, `shopId`),
  ADD UNIQUE INDEX `NotifySubscription_shopId_actorId_variantGid_key`(`shopId`, `actorId`, `variantGid`),
  ADD INDEX `NotifySubscription_shopId_variantGid_status_idx`(`shopId`, `variantGid`, `status`),
  ADD INDEX `NotifySubscription_actorId_shopId_fkey`(`actorId`, `shopId`);
ALTER TABLE `EmailDelivery`
  CHANGE COLUMN `uuid` `id` CHAR(36) NOT NULL,
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NOT NULL,
  CHANGE COLUMN `subscriptionId_uuid` `subscriptionId` CHAR(36) NOT NULL,
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE INDEX `EmailDelivery_subscriptionId_restockCycle_key`(`subscriptionId`, `restockCycle`),
  ADD INDEX `EmailDelivery_shopId_createdAt_idx`(`shopId`, `createdAt`),
  ADD INDEX `EmailDelivery_subscriptionId_shopId_fkey`(`subscriptionId`, `shopId`);
ALTER TABLE `VariantAvailability`
  CHANGE COLUMN `uuid` `id` CHAR(36) NOT NULL,
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NOT NULL,
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE INDEX `VariantAvailability_shopId_variantGid_key`(`shopId`, `variantGid`),
  ADD INDEX `VariantAvailability_shopId_inventoryItemGid_idx`(`shopId`, `inventoryItemGid`),
  ADD INDEX `VariantAvailability_shopId_productGid_idx`(`shopId`, `productGid`);
ALTER TABLE `WebhookEvent`
  CHANGE COLUMN `uuid` `id` CHAR(36) NOT NULL,
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NULL,
  ADD PRIMARY KEY (`id`),
  ADD INDEX `WebhookEvent_shopId_fkey`(`shopId`);
ALTER TABLE `ShopifyOrder`
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NOT NULL,
  ADD UNIQUE INDEX `ShopifyOrder_id_shopId_key`(`id`, `shopId`),
  ADD UNIQUE INDEX `ShopifyOrder_shopId_orderGid_key`(`shopId`, `orderGid`),
  ADD INDEX `ShopifyOrder_shopId_placedAt_idx`(`shopId`, `placedAt`),
  ADD INDEX `ShopifyOrder_shopId_customerGid_placedAt_idx`(`shopId`, `customerGid`, `placedAt`);
ALTER TABLE `ShopifyOrderLineItem`
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NOT NULL,
  ADD INDEX `ShopifyOrderLineItem_shopId_variantGid_idx`(`shopId`, `variantGid`),
  ADD INDEX `ShopifyOrderLineItem_shopId_productGid_idx`(`shopId`, `productGid`),
  ADD INDEX `ShopifyOrderLineItem_orderId_shopId_fkey`(`orderId`, `shopId`);
ALTER TABLE `OrderAttribution`
  CHANGE COLUMN `shopId_uuid` `shopId` CHAR(36) NOT NULL,
  CHANGE COLUMN `touchEventId_uuid` `touchEventId` CHAR(36) NULL,
  ADD UNIQUE INDEX `OrderAttribution_orderId_shopId_key`(`orderId`, `shopId`),
  ADD INDEX `OrderAttribution_shopId_feature_attributedAt_idx`(`shopId`, `feature`, `attributedAt`),
  ADD INDEX `OrderAttribution_touchEventId_idx`(`touchEventId`);

-- 7. foreign keys, under their original names -------------------------------------------------------
ALTER TABLE `ShopSettings` ADD CONSTRAINT `ShopSettings_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `Actor` ADD CONSTRAINT `Actor_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `BrowsingSession` ADD CONSTRAINT `BrowsingSession_actorId_shopId_fkey` FOREIGN KEY (`actorId`, `shopId`) REFERENCES `Actor`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ActivityEvent` ADD CONSTRAINT `ActivityEvent_actorId_shopId_fkey` FOREIGN KEY (`actorId`, `shopId`) REFERENCES `Actor`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ActivityEvent` ADD CONSTRAINT `ActivityEvent_browsingSessionId_shopId_feature_fkey` FOREIGN KEY (`browsingSessionId`, `shopId`, `feature`) REFERENCES `BrowsingSession`(`id`, `shopId`, `feature`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `WishlistItem` ADD CONSTRAINT `WishlistItem_actorId_shopId_fkey` FOREIGN KEY (`actorId`, `shopId`) REFERENCES `Actor`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `NotifySubscription` ADD CONSTRAINT `NotifySubscription_actorId_shopId_fkey` FOREIGN KEY (`actorId`, `shopId`) REFERENCES `Actor`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `EmailDelivery` ADD CONSTRAINT `EmailDelivery_subscriptionId_shopId_fkey` FOREIGN KEY (`subscriptionId`, `shopId`) REFERENCES `NotifySubscription`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `VariantAvailability` ADD CONSTRAINT `VariantAvailability_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `WebhookEvent` ADD CONSTRAINT `WebhookEvent_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `ShopifyOrder` ADD CONSTRAINT `ShopifyOrder_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ShopifyOrderLineItem` ADD CONSTRAINT `ShopifyOrderLineItem_orderId_shopId_fkey` FOREIGN KEY (`orderId`, `shopId`) REFERENCES `ShopifyOrder`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OrderAttribution` ADD CONSTRAINT `OrderAttribution_orderId_shopId_fkey` FOREIGN KEY (`orderId`, `shopId`) REFERENCES `ShopifyOrder`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `OrderAttribution` ADD CONSTRAINT `OrderAttribution_touchEventId_fkey` FOREIGN KEY (`touchEventId`) REFERENCES `ActivityEvent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
