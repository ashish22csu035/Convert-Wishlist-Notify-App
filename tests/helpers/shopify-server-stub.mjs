// Stand-in for "@shopify/shopify-app-react-router/server" when route components are bundled for the
// jsdom tests: only the error boundary helper is referenced, and tests never trigger it.
export const boundary = { error: (error) => String(error), headers: () => ({}) };
