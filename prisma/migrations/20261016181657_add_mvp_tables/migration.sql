-- CreateTable
CREATE TABLE `Shop` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `domain` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `currencyCode` VARCHAR(3) NOT NULL,
    `timezone` VARCHAR(64) NULL,
    `status` ENUM('ACTIVE', 'UNINSTALLED') NOT NULL DEFAULT 'ACTIVE',
    `installedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `uninstalledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Shop_domain_key`(`domain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShopSettings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `wishlistEnabled` BOOLEAN NOT NULL DEFAULT true,
    `notifyMeEnabled` BOOLEAN NOT NULL DEFAULT true,
    `senderName` VARCHAR(100) NULL,
    `replyToEmail` VARCHAR(320) NULL,
    `emailSubject` VARCHAR(255) NULL,
    `emailBody` TEXT NULL,
    `buttonLabel` VARCHAR(64) NULL,
    `activityRetentionDays` INTEGER NOT NULL DEFAULT 180,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ShopSettings_shopId_key`(`shopId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Actor` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `customerGid` VARCHAR(191) NOT NULL,
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Actor_id_shopId_key`(`id`, `shopId`),
    UNIQUE INDEX `Actor_shopId_customerGid_key`(`shopId`, `customerGid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BrowsingSession` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `actorId` INTEGER NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `BrowsingSession_actorId_expiresAt_idx`(`actorId`, `expiresAt`),
    INDEX `BrowsingSession_shopId_startedAt_idx`(`shopId`, `startedAt`),
    UNIQUE INDEX `BrowsingSession_id_shopId_key`(`id`, `shopId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WishlistItem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `actorId` INTEGER NOT NULL,
    `productGid` VARCHAR(191) NOT NULL,
    `variantGid` VARCHAR(191) NULL,
    `productTitle` VARCHAR(191) NOT NULL,
    `productHandle` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WishlistItem_shopId_productGid_idx`(`shopId`, `productGid`),
    INDEX `WishlistItem_shopId_createdAt_idx`(`shopId`, `createdAt`),
    UNIQUE INDEX `WishlistItem_actorId_productGid_key`(`actorId`, `productGid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotifySubscription` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `actorId` INTEGER NOT NULL,
    `productGid` VARCHAR(191) NOT NULL,
    `variantGid` VARCHAR(191) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `status` ENUM('ACTIVE', 'FULFILLED', 'UNSUBSCRIBED') NOT NULL DEFAULT 'ACTIVE',
    `consentedAt` DATETIME(3) NOT NULL,
    `consentSource` VARCHAR(64) NOT NULL,
    `baselineCycle` INTEGER NOT NULL DEFAULT 0,
    `unsubscribedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `NotifySubscription_shopId_variantGid_status_idx`(`shopId`, `variantGid`, `status`),
    INDEX `NotifySubscription_status_updatedAt_idx`(`status`, `updatedAt`),
    UNIQUE INDEX `NotifySubscription_id_shopId_key`(`id`, `shopId`),
    UNIQUE INDEX `NotifySubscription_shopId_actorId_variantGid_key`(`shopId`, `actorId`, `variantGid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VariantAvailability` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `variantGid` VARCHAR(191) NOT NULL,
    `productGid` VARCHAR(191) NOT NULL,
    `inventoryItemGid` VARCHAR(191) NOT NULL,
    `isInStock` BOOLEAN NOT NULL,
    `restockCycle` INTEGER NOT NULL DEFAULT 0,
    `sourceUpdatedAt` DATETIME(3) NULL,
    `lastSyncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `VariantAvailability_shopId_inventoryItemGid_idx`(`shopId`, `inventoryItemGid`),
    INDEX `VariantAvailability_shopId_productGid_idx`(`shopId`, `productGid`),
    UNIQUE INDEX `VariantAvailability_shopId_variantGid_key`(`shopId`, `variantGid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ActivityEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `actorId` INTEGER NOT NULL,
    `browsingSessionId` INTEGER NULL,
    `type` ENUM('WISHLIST_ADDED', 'WISHLIST_REMOVED', 'WISHLIST_PRODUCT_CLICKED', 'NOTIFY_SUBSCRIBED', 'NOTIFY_UNSUBSCRIBED', 'RESTOCK_EMAIL_SENT', 'RESTOCK_EMAIL_CLICKED') NOT NULL,
    `feature` ENUM('WISHLIST', 'NOTIFY_ME') NOT NULL,
    `productGid` VARCHAR(191) NULL,
    `variantGid` VARCHAR(191) NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ActivityEvent_shopId_occurredAt_idx`(`shopId`, `occurredAt`),
    INDEX `ActivityEvent_shopId_type_occurredAt_idx`(`shopId`, `type`, `occurredAt`),
    INDEX `ActivityEvent_actorId_type_occurredAt_idx`(`actorId`, `type`, `occurredAt`),
    INDEX `ActivityEvent_browsingSessionId_idx`(`browsingSessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailDelivery` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `subscriptionId` INTEGER NOT NULL,
    `restockCycle` INTEGER NOT NULL,
    `variantGid` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `sentAt` DATETIME(3) NULL,
    `outboundMessageId` VARCHAR(191) NULL,
    `linkTokenHash` CHAR(64) NULL,
    `errorCode` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EmailDelivery_outboundMessageId_key`(`outboundMessageId`),
    UNIQUE INDEX `EmailDelivery_linkTokenHash_key`(`linkTokenHash`),
    INDEX `EmailDelivery_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `EmailDelivery_shopId_createdAt_idx`(`shopId`, `createdAt`),
    UNIQUE INDEX `EmailDelivery_subscriptionId_restockCycle_key`(`subscriptionId`, `restockCycle`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebhookEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopDomain` VARCHAR(191) NOT NULL,
    `shopId` INTEGER NULL,
    `topic` VARCHAR(100) NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `webhookId` VARCHAR(191) NOT NULL,
    `resourceGid` VARCHAR(191) NULL,
    `triggeredAt` DATETIME(3) NULL,
    `status` ENUM('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED') NOT NULL DEFAULT 'RECEIVED',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `errorCode` VARCHAR(64) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,

    INDEX `WebhookEvent_receivedAt_idx`(`receivedAt`),
    INDEX `WebhookEvent_status_receivedAt_idx`(`status`, `receivedAt`),
    UNIQUE INDEX `WebhookEvent_shopDomain_topic_dedupeKey_key`(`shopDomain`, `topic`, `dedupeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShopifyOrder` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `orderGid` VARCHAR(191) NOT NULL,
    `orderName` VARCHAR(64) NOT NULL,
    `customerGid` VARCHAR(191) NULL,
    `placedAt` DATETIME(3) NOT NULL,
    `cancelledAt` DATETIME(3) NULL,
    `financialStatus` VARCHAR(32) NOT NULL,
    `currencyCode` VARCHAR(3) NOT NULL,
    `totalPrice` DECIMAL(19, 4) NOT NULL,
    `totalRefunded` DECIMAL(19, 4) NOT NULL DEFAULT 0,
    `shopifyUpdatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ShopifyOrder_shopId_placedAt_idx`(`shopId`, `placedAt`),
    INDEX `ShopifyOrder_shopId_customerGid_placedAt_idx`(`shopId`, `customerGid`, `placedAt`),
    UNIQUE INDEX `ShopifyOrder_id_shopId_key`(`id`, `shopId`),
    UNIQUE INDEX `ShopifyOrder_shopId_orderGid_key`(`shopId`, `orderGid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShopifyOrderLineItem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `orderId` INTEGER NOT NULL,
    `lineItemGid` VARCHAR(191) NOT NULL,
    `productGid` VARCHAR(191) NOT NULL,
    `variantGid` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL,
    `lineTotal` DECIMAL(19, 4) NOT NULL,
    `refundedAmount` DECIMAL(19, 4) NOT NULL DEFAULT 0,

    INDEX `ShopifyOrderLineItem_shopId_variantGid_idx`(`shopId`, `variantGid`),
    INDEX `ShopifyOrderLineItem_shopId_productGid_idx`(`shopId`, `productGid`),
    UNIQUE INDEX `ShopifyOrderLineItem_orderId_lineItemGid_key`(`orderId`, `lineItemGid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderAttribution` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `orderId` INTEGER NOT NULL,
    `feature` ENUM('WISHLIST', 'NOTIFY_ME') NOT NULL,
    `touchEventId` INTEGER NULL,
    `touchedAt` DATETIME(3) NOT NULL,
    `matchedProductGid` VARCHAR(191) NOT NULL,
    `matchedVariantGid` VARCHAR(191) NULL,
    `grossAmount` DECIMAL(19, 4) NOT NULL,
    `refundedAmount` DECIMAL(19, 4) NOT NULL DEFAULT 0,
    `currencyCode` VARCHAR(3) NOT NULL,
    `status` ENUM('ACTIVE', 'REVERSED') NOT NULL DEFAULT 'ACTIVE',
    `attributedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OrderAttribution_orderId_key`(`orderId`),
    INDEX `OrderAttribution_shopId_feature_attributedAt_idx`(`shopId`, `feature`, `attributedAt`),
    INDEX `OrderAttribution_touchEventId_idx`(`touchEventId`),
    UNIQUE INDEX `OrderAttribution_orderId_shopId_key`(`orderId`, `shopId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ShopSettings` ADD CONSTRAINT `ShopSettings_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Actor` ADD CONSTRAINT `Actor_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BrowsingSession` ADD CONSTRAINT `BrowsingSession_actorId_shopId_fkey` FOREIGN KEY (`actorId`, `shopId`) REFERENCES `Actor`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WishlistItem` ADD CONSTRAINT `WishlistItem_actorId_shopId_fkey` FOREIGN KEY (`actorId`, `shopId`) REFERENCES `Actor`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NotifySubscription` ADD CONSTRAINT `NotifySubscription_actorId_shopId_fkey` FOREIGN KEY (`actorId`, `shopId`) REFERENCES `Actor`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VariantAvailability` ADD CONSTRAINT `VariantAvailability_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ActivityEvent` ADD CONSTRAINT `ActivityEvent_actorId_shopId_fkey` FOREIGN KEY (`actorId`, `shopId`) REFERENCES `Actor`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ActivityEvent` ADD CONSTRAINT `ActivityEvent_browsingSessionId_shopId_fkey` FOREIGN KEY (`browsingSessionId`, `shopId`) REFERENCES `BrowsingSession`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailDelivery` ADD CONSTRAINT `EmailDelivery_subscriptionId_shopId_fkey` FOREIGN KEY (`subscriptionId`, `shopId`) REFERENCES `NotifySubscription`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebhookEvent` ADD CONSTRAINT `WebhookEvent_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShopifyOrder` ADD CONSTRAINT `ShopifyOrder_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShopifyOrderLineItem` ADD CONSTRAINT `ShopifyOrderLineItem_orderId_shopId_fkey` FOREIGN KEY (`orderId`, `shopId`) REFERENCES `ShopifyOrder`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderAttribution` ADD CONSTRAINT `OrderAttribution_orderId_shopId_fkey` FOREIGN KEY (`orderId`, `shopId`) REFERENCES `ShopifyOrder`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderAttribution` ADD CONSTRAINT `OrderAttribution_touchEventId_fkey` FOREIGN KEY (`touchEventId`) REFERENCES `ActivityEvent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written CHECK constraints (Prisma cannot express these).
-- ---------------------------------------------------------------------------

-- A browsing session lasts exactly 30 minutes from its start; activity never extends it.
ALTER TABLE `BrowsingSession`
    ADD CONSTRAINT `chk_BrowsingSession_expiry_30min`
    CHECK (`expiresAt` = `startedAt` + INTERVAL 30 MINUTE);

-- Counters and money amounts are never negative.
ALTER TABLE `NotifySubscription`
    ADD CONSTRAINT `chk_NotifySubscription_baselineCycle` CHECK (`baselineCycle` >= 0);

ALTER TABLE `VariantAvailability`
    ADD CONSTRAINT `chk_VariantAvailability_restockCycle` CHECK (`restockCycle` >= 0);

ALTER TABLE `EmailDelivery`
    ADD CONSTRAINT `chk_EmailDelivery_counters` CHECK (`restockCycle` >= 0 AND `attempts` >= 0);

ALTER TABLE `ShopifyOrder`
    ADD CONSTRAINT `chk_ShopifyOrder_money` CHECK (`totalPrice` >= 0 AND `totalRefunded` >= 0);

ALTER TABLE `ShopifyOrderLineItem`
    ADD CONSTRAINT `chk_ShopifyOrderLineItem_money` CHECK (`lineTotal` >= 0 AND `refundedAmount` >= 0 AND `quantity` >= 0);

ALTER TABLE `OrderAttribution`
    ADD CONSTRAINT `chk_OrderAttribution_money` CHECK (`grossAmount` >= 0 AND `refundedAmount` >= 0);

ALTER TABLE `ShopSettings`
    ADD CONSTRAINT `chk_ShopSettings_retention` CHECK (`activityRetentionDays` BETWEEN 30 AND 365);
