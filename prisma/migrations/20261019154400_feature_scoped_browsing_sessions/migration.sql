-- Existing sessions are Wishlist sessions. Preserve every row and default it
-- to WISHLIST before requiring each activity event to match its session feature.
ALTER TABLE `BrowsingSession`
    ADD COLUMN `feature` ENUM('WISHLIST', 'NOTIFY_ME') NOT NULL DEFAULT 'WISHLIST';

CREATE UNIQUE INDEX `BrowsingSession_id_shopId_feature_key`
    ON `BrowsingSession`(`id`, `shopId`, `feature`);

ALTER TABLE `ActivityEvent`
    DROP FOREIGN KEY `ActivityEvent_browsingSessionId_shopId_fkey`;

ALTER TABLE `ActivityEvent`
    ADD CONSTRAINT `ActivityEvent_browsingSessionId_shopId_feature_fkey`
    FOREIGN KEY (`browsingSessionId`, `shopId`, `feature`)
    REFERENCES `BrowsingSession`(`id`, `shopId`, `feature`)
    ON DELETE CASCADE ON UPDATE CASCADE;
