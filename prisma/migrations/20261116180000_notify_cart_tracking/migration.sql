-- AlterTable
-- Additive. NOTIFY_ADDED_TO_CART is a new event kind; emailDeliveryId (UNIQUE) ties it to the restock email it came from and
-- makes a repeated report a no-op. cartTokenHash is the hash of the opaque token in the email's product link: NULL on every
-- email sent before this migration, so those emails simply have no cart tracking. notifyAddedToCart is NULL until the
-- worker has calculated the day. Nothing is dropped or rewritten.
ALTER TABLE `ActivityEvent`
  MODIFY COLUMN `type` ENUM(
    'WISHLIST_ADDED',
    'WISHLIST_ADDED_TO_CART',
    'WISHLIST_REMOVED',
    'WISHLIST_PRODUCT_CLICKED',
    'NOTIFY_SUBSCRIBED',
    'NOTIFY_UNSUBSCRIBED',
    'RESTOCK_EMAIL_SENT',
    'RESTOCK_EMAIL_CLICKED',
    'NOTIFY_ADDED_TO_CART'
  ) NOT NULL,
  ADD COLUMN `emailDeliveryId` CHAR(36) NULL,
  ADD UNIQUE INDEX `ActivityEvent_emailDeliveryId_key`(`emailDeliveryId`);

-- AlterTable
ALTER TABLE `EmailDelivery` ADD COLUMN `cartTokenHash` CHAR(64) NULL,
  ADD UNIQUE INDEX `EmailDelivery_cartTokenHash_key`(`cartTokenHash`);

-- AlterTable
ALTER TABLE `AnalyticsDaily` ADD COLUMN `notifyAddedToCart` INTEGER NULL;

-- AddForeignKey
ALTER TABLE `ActivityEvent` ADD CONSTRAINT `ActivityEvent_emailDeliveryId_fkey` FOREIGN KEY (`emailDeliveryId`) REFERENCES `EmailDelivery`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
