-- AlterTable
-- Additive and nullable: existing ShopSettings rows get NULL, which the app reads as "nothing confirmed, not dismissed".
-- No existing column, key or row is touched.
ALTER TABLE `ShopSettings` ADD COLUMN `onboarding` JSON NULL;
