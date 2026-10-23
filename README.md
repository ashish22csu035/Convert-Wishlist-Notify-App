# Shopify App Template - React Router

This is a template for building a [Shopify app](https://shopify.dev/docs/apps/getting-started) using [React Router](https://reactrouter.com/). It was forked from the [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix) and converted to React Router.

Rather than cloning this repo, follow the [Quick Start steps](https://github.com/Shopify/shopify-app-template-react-router#quick-start).

Visit the [`shopify.dev` documentation](https://shopify.dev/docs/api/shopify-app-react-router) for more details on the React Router app package.

## Upgrading from Remix

If you have an existing Remix app that you want to upgrade to React Router, please follow the [upgrade guide](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix). Otherwise, please follow the quick start guide below.

## Quick start

### Prerequisites

Before you begin, you'll need to [download and install the Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started) if you haven't already.

### Setup

```shell
shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router
```

### Local Development

```shell
shopify app dev
```

Press P to open the URL to your app. Once you click install, you can start development.

Local development is powered by [the Shopify CLI](https://shopify.dev/docs/apps/tools/cli). It logs into your account, connects to an app, provides environment variables, updates remote config, creates a tunnel and provides commands to generate extensions.

### Authenticating and querying data

To authenticate and query data you can use the `shopify` const that is exported from `/app/shopify.server.js`:

```js
export async function loader({ request }) {
  const { admin } = await shopify.authenticate.admin(request);

  const response = await admin.graphql(`
    {
      products(first: 25) {
        nodes {
          title
          description
        }
      }
    }`);

  const {
    data: {
      products: { nodes },
    },
  } = await response.json();

  return nodes;
}
```

This template comes pre-configured with examples of:

1. Setting up your Shopify app in [/app/shopify.server.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/shopify.server.ts)
2. Querying data using Graphql. Please see: [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx).
3. Responding to webhooks. Please see [/app/routes/webhooks.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/webhooks.app.uninstalled.tsx).
4. Using metafields, metaobjects, and declarative custom data definitions. Please see [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx) and [shopify.app.toml](https://github.com/Shopify/shopify-app-template-react-router/blob/main/shopify.app.toml).

Please read the [documentation for @shopify/shopify-app-react-router](https://shopify.dev/docs/api/shopify-app-react-router) to see what other API's are available.

## Notify Me restock emails (worker)

Restock emails are sent by a separate process, never by the web server or the webhook handler.

1. **Webhook (app server, `npm run dev`)**: Shopify's `inventory_levels/update` webhook runs `processRestock`, which raises the variant's restock cycle and queues one `PENDING` `EmailDelivery` per eligible subscription.
2. **Worker (`npm run worker`, run on demand)**: sends every queued email that is due now, then **exits**. It re-checks that each job is still valid, reads the current product from Shopify, and sends the email. It never polls Shopify for inventory and does not keep running waiting for restocks.

Run the app, then run the worker whenever you want queued mail sent:

```shell
# terminal 1: the app (also registers the webhook)
npm run dev

# terminal 2, after a restock has queued mail: sends what is due, then exits
npm run worker
```

**`npm run worker` changed from a continuous loop to a one-shot run** (same command, same script). It processes the jobs that are due when it starts and any that become due while it works, prints a summary, and exits:

- A job whose retry is scheduled for later (a transient SMTP or Shopify error: 1, 4, 16, 64 minutes, then 2 hours) is **not** waited for and not retried in the same run. The worker says how many are scheduled and when the next is due; **run it again after that time**.
- `UNKNOWN`, `FAILED`, `SKIPPED` and `SENT` jobs are never touched. The worker reports how many `UNKNOWN` jobs need a person to look at them.
- Ctrl+C / SIGTERM: it finishes the email being sent, claims nothing new, closes the connections and exits (exit code 130 / 143). Remaining jobs stay queued for the next run.
- Running two workers at once is safe: every job is claimed by a single conditional update, so none is sent twice.
- To run it regularly, schedule `npm run worker` (cron, Windows Task Scheduler).

### Webhook diagnostics

The app server prints one line per `inventory_levels/update` delivery (no secrets or customer data):

- no `[restock] inventory webhook` line at all: Shopify did not deliver to this server. Check that `shopify app dev` is running and its tunnel URL is the current one.
- `rejected before processing {"status":401}`: it arrived but failed signature verification.
- `handled … "outcome":"untracked"`: it arrived for an item nobody subscribed to.
- `handled … "outcome":"processed"`: it arrived and was processed.
- `failed`: it arrived but processing failed; Shopify retries it.

### Settings

Put these in `.env` (never commit it) or in the environment. The worker refuses to start, and changes no queued job, if any required one is missing; it names the variables, never their values.

| Variable | Required | Meaning |
|---|---|---|
| `SMTP_HOST`, `SMTP_PORT` | yes | e.g. `smtp.gmail.com` and `465` (or `587`) |
| `SMTP_USER`, `SMTP_PASS` | yes | for Gmail, the address and a Google **app password** (needs 2-step verification), not the account password |
| `MAIL_FROM` | yes | sender address; Gmail only sends as the authenticated account |
| `SMTP_SECURE` | no | `true`/`false`; defaults to `true` for port 465 |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | yes | the worker reads current product details with the shop's Admin token (`shopify app env show` prints them) |
| `APP_PUBLIC_URL` (or `SHOPIFY_APP_URL`) | yes | **public https URL of the app server**, used for the unsubscribe link. In development this is the current tunnel URL, which changes whenever `shopify app dev` restarts; links in emails already sent point at the old one |
| `WORKER_INTERVAL_MS` | no | only used by the optional timed loop (`createWorker().start()`); `npm run worker` ignores it |

### Delivery rules

- One email per subscription per restock cycle: enforced by `UNIQUE(subscriptionId, restockCycle)`, by the claim being a single conditional update, and by the subscription becoming `FULFILLED` once the mail is accepted.
- A job is skipped (`SKIPPED`) if the customer unsubscribed or was already notified, the item sold out again, there is no valid recipient, or the product is no longer available.
- Retryable SMTP failures (connection or login problems, 4xx replies) are retried with 1, 4, 16 and 64 minute delays, then marked `FAILED`. A 5xx refusal fails immediately.
- If the connection breaks while the message is being sent, nobody can know whether it arrived, so the job becomes `UNKNOWN` and is **never sent again automatically**. Look at these rows by hand.
- Every email has a one-click unsubscribe link (`/notify/unsubscribe?t=...`) built from a random token; only its hash is stored.

## Orders and revenue attribution

The Dashboard's **Attributed revenue** card (Overall / Wishlist / Notify Me) is built from real orders.

**What is collected.** Two verified webhooks, declared in `shopify.app.toml`, need one new scope, `read_orders`:

| Topic | Why |
|---|---|
| `orders/paid` | the moment an order becomes eligible (only paid orders are attributed) |
| `orders/updated` | every later change arrives with the whole current order: edits, cancellation, refunds, financial status. One idempotent upsert keeps the stored order and its attribution right, so `refunds/create`, `orders/cancelled` and `orders/edited` are not needed |

Stored per order (existing `ShopifyOrder`, `ShopifyOrderLineItem`, `OrderAttribution` tables, no migration): order id, timestamps, shop-currency totals, financial status, the verified **customer id** and, per line, product id, variant id, quantity, line total (price x quantity minus the line's discounts) and refunded amount. No email, phone, name or address is stored. Duplicate deliveries do nothing; an older version of an order never overwrites a newer one.

**Attribution rule** (PRD): last touch within the 7 days before the order, one feature per order.

- The order's verified customer id must belong to a customer who used Wishlist or Notify Me in that shop. Guest orders are never attributed.
- **Wishlist** touch: a save or a product open from the Wishlist for the *product* bought (any variant), if it was still saved when the order was placed (removing it first cancels it).
- **Notify Me** touch: a restock email that the mail server *accepted* (not queued, not failed, not just subscribed) for the *variant* bought.
- The most recent touch wins. Revenue is only the line items matched by the winning feature's touches, net of refunds on those lines; the full order total is kept separately and never credited. A cancelled or fully refunded order is kept but no longer counted.
- This shows association, not proof that the app caused the purchase.

**Manual step: approve the new permission.** The app now asks for `read_orders`. Existing installs must approve it before order webhooks are delivered:

1. `shopify app dev` (or `shopify app deploy`, when you choose to release) pushes the new scope and webhook subscriptions.
2. Open the app in the store's Shopify admin and approve the permission prompt.
3. Public apps also need Shopify's *protected customer data* access for order webhooks (Partner Dashboard, app, API access requests). Development stores are exempt.
4. Until then the card says **Set up**; once approved but before the first order it says **Waiting for orders**; after that zero means a real zero.

Webhooks are logged one line per delivery as `[orders] webhook handled …` (no order contents), so "not delivered", "rejected" and "processed" can be told apart like the inventory webhook.

## Shopify Dev MCP

This template is configured with the Shopify Dev MCP. This instructs [Cursor](https://cursor.com/), [GitHub Copilot](https://github.com/features/copilot) and [Claude Code](https://claude.com/product/claude-code) and [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) to use the Shopify Dev MCP.

For more information on the Shopify Dev MCP please read [the documentation](https://shopify.dev/docs/apps/build/devmcp).

## Deployment

### Application Storage

This template uses [Prisma](https://www.prisma.io/) to store session data, by default using an [SQLite](https://www.sqlite.org/index.html) database.
The database is defined as a Prisma schema in `prisma/schema.prisma`.

This use of SQLite works in production if your app runs as a single instance.
The database that works best for you depends on the data your app needs and how it is queried.
Here’s a short list of databases providers that provide a free tier to get started:

| Database   | Type             | Hosters                                                                                                                                                                                                                                    |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MySQL      | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mysql), [Planet Scale](https://planetscale.com/), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/mysql) |
| PostgreSQL | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-postgresql), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/postgres)                                   |
| Redis      | Key-value        | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-redis), [Amazon MemoryDB](https://aws.amazon.com/memorydb/)                                                                                                        |
| MongoDB    | NoSQL / Document | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mongodb), [MongoDB Atlas](https://www.mongodb.com/atlas/database)                                                                                                  |

To use one of these, you can use a different [datasource provider](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#datasource) in your `schema.prisma` file, or a different [SessionStorage adapter package](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md).

### Build

Build the app by running the command below with the package manager of your choice:

Using yarn:

```shell
yarn build
```

Using npm:

```shell
npm run build
```

Using pnpm:

```shell
pnpm run build
```

## Hosting

When you're ready to set up your app in production, you can follow [our deployment documentation](https://shopify.dev/docs/apps/launch/deployment) to host it externally. From there, you have a few options:

- [Google Cloud Run](https://shopify.dev/docs/apps/launch/deployment/deploy-to-google-cloud-run): This tutorial is written specifically for this example repo, and is compatible with the extended steps included in the subsequent [**Build your app**](tutorial) in the **Getting started** docs. It is the most detailed tutorial for taking a React Router-based Shopify app and deploying it to production. It includes configuring permissions and secrets, setting up a production database, and even hosting your apps behind a load balancer across multiple regions.
- [Fly.io](https://fly.io/docs/js/shopify/): Leverages the Fly.io CLI to quickly launch Shopify apps to a single machine.
- [Render](https://render.com/docs/deploy-shopify-app): This tutorial guides you through using Docker to deploy and install apps on a Dev store.
- [Manual deployment guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service): This resource provides general guidance on the requirements of deployment including environment variables, secrets, and persistent data.

When you reach the step for [setting up environment variables](https://shopify.dev/docs/apps/deployment/web#set-env-vars), you also need to set the variable `NODE_ENV=production`.

## Gotchas / Troubleshooting

### Database tables don't exist

If you get an error like:

```
The table `main.Session` does not exist in the current database.
```

Create the database for Prisma. Run the `setup` script in `package.json` using `npm`, `yarn` or `pnpm`.

### Navigating/redirecting breaks an embedded app

Embedded apps must maintain the user session, which can be tricky inside an iFrame. To avoid issues:

1. Use `Link` from `react-router` or `@shopify/polaris`. Do not use `<a>`.
2. Use `redirect` returned from `authenticate.admin`. Do not use `redirect` from `react-router`
3. Use `useSubmit` from `react-router`.

This only applies if your app is embedded, which it will be by default.

### Webhooks: shop-specific webhook subscriptions aren't updated

If you are registering webhooks in the `afterAuth` hook, using `shopify.registerWebhooks`, you may find that your subscriptions aren't being updated.

Instead of using the `afterAuth` hook declare app-specific webhooks in the `shopify.app.toml` file. This approach is easier since Shopify will automatically sync changes every time you run `deploy` (e.g: `npm run deploy`). Please read these guides to understand more:

1. [app-specific vs shop-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions)
2. [Create a subscription tutorial](https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started?deliveryMethod=https)

If you do need shop-specific webhooks, keep in mind that the package calls `afterAuth` in 2 scenarios:

- After installing the app
- When an access token expires

During normal development, the app won't need to re-authenticate most of the time, so shop-specific subscriptions aren't updated. To force your app to update the subscriptions, uninstall and reinstall the app. Revisiting the app will call the `afterAuth` hook.

### Webhooks: Admin created webhook failing HMAC validation

Webhooks subscriptions created in the [Shopify admin](https://help.shopify.com/en/manual/orders/notifications/webhooks) will fail HMAC validation. This is because the webhook payload is not signed with your app's secret key.

The recommended solution is to use [app-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions) defined in your toml file instead. Test your webhooks by triggering events manually in the Shopify admin(e.g. Updating the product title to trigger a `PRODUCTS_UPDATE`).

### Webhooks: Admin object undefined on webhook events triggered by the CLI

When you trigger a webhook event using the Shopify CLI, the `admin` object will be `undefined`. This is because the CLI triggers an event with a valid, but non-existent, shop. The `admin` object is only available when the webhook is triggered by a shop that has installed the app. This is expected.

Webhooks triggered by the CLI are intended for initial experimentation testing of your webhook configuration. For more information on how to test your webhooks, see the [Shopify CLI documentation](https://shopify.dev/docs/apps/tools/cli/commands#webhook-trigger).

### Incorrect GraphQL Hints

By default the [graphql.vscode-graphql](https://marketplace.visualstudio.com/items?itemName=GraphQL.vscode-graphql) extension for will assume that GraphQL queries or mutations are for the [Shopify Admin API](https://shopify.dev/docs/api/admin). This is a sensible default, but it may not be true if:

1. You use another Shopify API such as the storefront API.
2. You use a third party GraphQL API.

If so, please update [.graphqlrc.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/.graphqlrc.ts).

### Using Defer & await for streaming responses

By default the CLI uses a cloudflare tunnel. Unfortunately cloudflare tunnels wait for the Response stream to finish, then sends one chunk. This will not affect production.

To test [streaming using await](https://reactrouter.com/api/components/Await#await) during local development we recommend [localhost based development](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options#localhost-based-development).

### "nbf" claim timestamp check failed

This is because a JWT token is expired. If you are consistently getting this error, it could be that the clock on your machine is not in sync with the server. To fix this ensure you have enabled "Set time and date automatically" in the "Date and Time" settings on your computer.

### Using MongoDB and Prisma

If you choose to use MongoDB with Prisma, there are some gotchas in Prisma's MongoDB support to be aware of. Please see the [Prisma SessionStorage README](https://www.npmjs.com/package/@shopify/shopify-app-session-storage-prisma#mongodb).

### Unable to require(`C:\...\query_engine-windows.dll.node`).

Unable to require(`C:\...\query_engine-windows.dll.node`).
The Prisma engines do not seem to be compatible with your system.

query_engine-windows.dll.node is not a valid Win32 application.

**Fix:** Set the environment variable:

```shell
PRISMA_CLIENT_ENGINE_TYPE=binary
```

This forces Prisma to use the binary engine mode, which runs the query engine as a separate process and can work via emulation on Windows ARM64.

## Resources

React Router:

- [React Router docs](https://reactrouter.com/home)

Shopify:

- [Intro to Shopify apps](https://shopify.dev/docs/apps/getting-started)
- [Shopify App React Router docs](https://shopify.dev/docs/api/shopify-app-react-router)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- [Shopify App Bridge](https://shopify.dev/docs/api/app-bridge-library).
- [Polaris Web Components](https://shopify.dev/docs/api/app-home/polaris-web-components).
- [App extensions](https://shopify.dev/docs/apps/app-extensions/list)
- [Shopify Functions](https://shopify.dev/docs/api/functions)

Internationalization:

- [Internationalizing your app](https://shopify.dev/docs/apps/best-practices/internationalization/getting-started)
