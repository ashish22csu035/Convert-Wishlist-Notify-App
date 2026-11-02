-- AlterTable
-- Additive and nullable: existing ShopSettings rows get NULL, which the app reads as "default button and email, with the
-- older email columns as a fallback". No existing column, key or row is touched.
ALTER TABLE `ShopSettings` ADD COLUMN `notifyMeSettings` JSON NULL;
