-- Billing foundation: two new tables (ShopSubscription, PlanRecommendation) and nothing else. No existing table, column,
-- key or row is touched, and no row is created: a shop without a ShopSubscription row is treated as Basic by the app.

-- CreateTable
CREATE TABLE `ShopSubscription` (
    `id` CHAR(36) NOT NULL,
    `shopId` CHAR(36) NOT NULL,
    `plan` ENUM('BASIC', 'ADVANCE', 'ENTERPRISE') NOT NULL DEFAULT 'BASIC',
    `status` ENUM('ACTIVE', 'PENDING', 'CANCELLED', 'FROZEN', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
    `shopifySubscriptionGid` VARCHAR(191) NULL,
    `planHandle` VARCHAR(100) NULL,
    `verificationSource` VARCHAR(32) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `currentPeriodStart` DATETIME(3) NULL,
    `currentPeriodEnd` DATETIME(3) NULL,
    `nextVerificationAt` DATETIME(3) NULL,
    `verificationFailures` INTEGER NOT NULL DEFAULT 0,
    `lastVerificationError` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ShopSubscription_shopId_key`(`shopId`),
    INDEX `ShopSubscription_status_nextVerificationAt_idx`(`status`, `nextVerificationAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlanRecommendation` (
    `id` CHAR(36) NOT NULL,
    `shopId` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'NEEDS_ACCESS') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `errorCode` VARCHAR(64) NULL,
    `sessions30d` INTEGER NULL,
    `periodStart` DATETIME(3) NULL,
    `periodEnd` DATETIME(3) NULL,
    `fetchedAt` DATETIME(3) NULL,
    `recommendedPlan` ENUM('BASIC', 'ADVANCE', 'ENTERPRISE') NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PlanRecommendation_shopId_key`(`shopId`),
    INDEX `PlanRecommendation_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ShopSubscription` ADD CONSTRAINT `ShopSubscription_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlanRecommendation` ADD CONSTRAINT `PlanRecommendation_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;



-- Hand-written CHECK constraints (Prisma cannot express these), in the style of the earlier migrations.
-- A session count is a real, non-negative number or NULL: a failed or empty answer can never be stored as 0 by mistake
-- because SUCCEEDED requires the count, the fetch time and the period, and a count requires its recommendation.
ALTER TABLE `PlanRecommendation`
    ADD CONSTRAINT `chk_PlanRecommendation_counters` CHECK (`attempts` >= 0 AND (`sessions30d` IS NULL OR `sessions30d` >= 0)),
    ADD CONSTRAINT `chk_PlanRecommendation_succeeded` CHECK (`status` <> 'SUCCEEDED' OR (`sessions30d` IS NOT NULL AND `fetchedAt` IS NOT NULL AND `periodStart` IS NOT NULL AND `periodEnd` IS NOT NULL AND `recommendedPlan` IS NOT NULL)),
    ADD CONSTRAINT `chk_PlanRecommendation_advice` CHECK ((`sessions30d` IS NULL) = (`recommendedPlan` IS NULL)),
    ADD CONSTRAINT `chk_PlanRecommendation_period` CHECK (`periodStart` IS NULL OR `periodEnd` IS NULL OR `periodStart` < `periodEnd`);

ALTER TABLE `ShopSubscription`
    ADD CONSTRAINT `chk_ShopSubscription_counters` CHECK (`verificationFailures` >= 0),
    ADD CONSTRAINT `chk_ShopSubscription_period` CHECK (`currentPeriodStart` IS NULL OR `currentPeriodEnd` IS NULL OR `currentPeriodStart` < `currentPeriodEnd`);
