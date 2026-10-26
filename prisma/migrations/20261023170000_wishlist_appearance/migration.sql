-- AlterTable
-- Additive and nullable: existing ShopSettings rows get NULL, which the app reads as "today's look".
-- No UUID key, foreign key, switch or email column is touched.
ALTER TABLE `ShopSettings` ADD COLUMN `wishlistAppearance` JSON NULL;
