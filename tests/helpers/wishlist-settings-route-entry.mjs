// Entry point for bundling the Wishlist Settings route in the jsdom tests: the route itself plus the shared error-boundary
// helpers, bundled together so they share ONE copy of the module-level "app rendered" state (as in the browser).
export * from "../../app/routes/app.wishlist-settings.jsx";
export { default } from "../../app/routes/app.wishlist-settings.jsx"; // `export *` does not re-export the default
export { authResponseBoundary, setAppRendered } from "../../app/components/merchant-ui.jsx";
