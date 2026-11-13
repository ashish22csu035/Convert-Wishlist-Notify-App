-- Subscription status details for the merchant's Plan and usage page. Forward-only and additive: two nullable columns, no existing row changes.
-- NULL means "not known" (the app never guesses): trialEndsAt = the end of a running trial, cancelAtPeriodEnd = the subscription will be
-- cancelled when the current billing cycle ends. Both are written only by a successful Shopify App Pricing verification.
ALTER TABLE `ShopSubscription` ADD COLUMN `trialEndsAt` DATETIME(3) NULL,
    ADD COLUMN `cancelAtPeriodEnd` BOOLEAN NULL;
