-- AlterTable
-- Additive and nullable. A NULL funnel column means "not calculated yet": the worker recalculates such a day and the
-- Product Funnel counts only the days that have the value. Nothing is dropped or rewritten.
ALTER TABLE `AnalyticsDaily` ADD COLUMN `wishlistAddedToCart` INTEGER NULL,
    ADD COLUMN `notifySubscriptionsCreated` INTEGER NULL,
    ADD COLUMN `wishlistCheckouts` INTEGER NULL,
    ADD COLUMN `notifyCheckouts` INTEGER NULL;

-- CreateTable
CREATE TABLE `CheckoutAttribution` (
    `id` CHAR(36) NOT NULL,
    `shopId` CHAR(36) NOT NULL,
    `actorId` CHAR(36) NOT NULL,
    `checkoutKey` VARCHAR(191) NOT NULL,
    `feature` ENUM('WISHLIST', 'NOTIFY_ME') NOT NULL,
    `touchEventId` CHAR(36) NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CheckoutAttribution_shopId_feature_startedAt_idx`(`shopId`, `feature`, `startedAt`),
    UNIQUE INDEX `CheckoutAttribution_shopId_checkoutKey_feature_key`(`shopId`, `checkoutKey`, `feature`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CheckoutAttribution` ADD CONSTRAINT `CheckoutAttribution_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CheckoutAttribution` ADD CONSTRAINT `CheckoutAttribution_actorId_shopId_fkey` FOREIGN KEY (`actorId`, `shopId`) REFERENCES `Actor`(`id`, `shopId`) ON DELETE CASCADE ON UPDATE CASCADE;
