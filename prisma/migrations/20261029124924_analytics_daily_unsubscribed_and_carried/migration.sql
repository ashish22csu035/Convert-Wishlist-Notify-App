-- AlterTable
-- Additive and nullable. notifyUnsubscribed stays NULL on the rows written before this migration: the Analytics page
-- ignores such a row and the worker recalculates it. Nothing is dropped or rewritten.
ALTER TABLE `AnalyticsDaily` ADD COLUMN `notifyUnsubscribed` INTEGER NULL,
    ADD COLUMN `wishlistSessionsCarried` INTEGER NULL,
    ADD COLUMN `notifyMeSessionsCarried` INTEGER NULL;
