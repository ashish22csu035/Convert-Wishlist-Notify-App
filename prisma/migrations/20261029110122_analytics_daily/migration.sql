-- CreateTable
CREATE TABLE `AnalyticsDaily` (
    `id` CHAR(36) NOT NULL,
    `shopId` CHAR(36) NOT NULL,
    `day` DATE NOT NULL,
    `wishlistAdded` INTEGER NOT NULL DEFAULT 0,
    `wishlistRemoved` INTEGER NOT NULL DEFAULT 0,
    `wishlistProductClicked` INTEGER NOT NULL DEFAULT 0,
    `notifySubscribed` INTEGER NOT NULL DEFAULT 0,
    `restockEmailSent` INTEGER NOT NULL DEFAULT 0,
    `wishlistSessions` INTEGER NULL,
    `notifyMeSessions` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AnalyticsDaily_shopId_day_key`(`shopId`, `day`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AnalyticsDaily` ADD CONSTRAINT `AnalyticsDaily_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
