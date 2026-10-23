// Constants shared by the merchant screens (browser) and their server code. No server imports here.

export const RANGE_DAYS = [7, 30, 90];
export const DEFAULT_DAYS = 30;
export const PAGE_SIZE = 25;

// The limits buildRestockEmail applies when it builds an email, so what is saved is what is used.
export const SETTING_LIMITS = { senderName: 100, replyToEmail: 320, emailSubject: 150, emailBody: 1000, buttonLabel: 40 };

export const WISHLIST_SORTS = { saves: "Most saved", recent: "Recently saved", name: "Name (A–Z)" };
export const CUSTOMER_SORTS = { recent: "Recently active", saved: "Most saved items", activity: "Most activity" };
export const SUBSCRIPTION_FILTERS = { all: "All", ACTIVE: "Active", FULFILLED: "Notified", UNSUBSCRIBED: "Unsubscribed" };
export const DELIVERY_FILTERS = { all: "All", PENDING: "Queued", SENDING: "Sending", SENT: "Sent", FAILED: "Failed", UNKNOWN: "Unknown", SKIPPED: "Skipped" };
export const WISHLIST_ACTIVITY_FILTERS = { all: "All activity", WISHLIST_ADDED: "Added", WISHLIST_REMOVED: "Removed", WISHLIST_PRODUCT_CLICKED: "Opened" };
