-- A wishlist item is now a specific product VARIANT, so one customer can save several
-- variants of the same product (Small and Large) but never the same variant twice.
--
-- Safe for existing data:
--   * No row is read, changed or deleted.
--   * Older rows saved without a variant keep variantGid = NULL. MySQL allows any number
--     of NULLs in a UNIQUE index, so they stay valid. The application never creates new
--     rows without a variant.
--   * The foreign key WishlistItem_actorId_shopId_fkey has its own index, so dropping the
--     old product-level unique index does not affect it.
--   * The new unique index is created BEFORE the old one is dropped, so a duplicate is
--     never possible in between. (If existing data contained duplicate (actor, variant)
--     pairs this statement would fail and change nothing; the audit found none.)

-- CreateIndex: one entry per customer per variant
CREATE UNIQUE INDEX `WishlistItem_actorId_variantGid_key` ON `WishlistItem`(`actorId`, `variantGid`);

-- CreateIndex: keeps "this customer's entries for this product" lookups fast
CREATE INDEX `WishlistItem_actorId_productGid_idx` ON `WishlistItem`(`actorId`, `productGid`);

-- DropIndex: the product-level uniqueness that blocked a second variant of a product
DROP INDEX `WishlistItem_actorId_productGid_key` ON `WishlistItem`;
