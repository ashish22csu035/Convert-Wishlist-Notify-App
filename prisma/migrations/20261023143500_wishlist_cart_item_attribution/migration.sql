ALTER TABLE `ActivityEvent`
  MODIFY COLUMN `type` ENUM(
    'WISHLIST_ADDED',
    'WISHLIST_ADDED_TO_CART',
    'WISHLIST_REMOVED',
    'WISHLIST_PRODUCT_CLICKED',
    'NOTIFY_SUBSCRIBED',
    'NOTIFY_UNSUBSCRIBED',
    'RESTOCK_EMAIL_SENT',
    'RESTOCK_EMAIL_CLICKED'
  ) NOT NULL;

ALTER TABLE `OrderAttribution`
  DROP INDEX `OrderAttribution_orderId_key`,
  DROP INDEX `OrderAttribution_orderId_shopId_key`,
  ADD UNIQUE INDEX `OrderAttribution_order_shop_feature_product_key`(`orderId`, `shopId`, `feature`, `matchedProductGid`);
