// Stand-in for "@shopify/shopify-app-react-router/server" when route components are bundled for the jsdom tests: only the
// error boundary helpers are referenced.
//
// `boundary.error` behaves like the real library (node_modules/@shopify/shopify-app-react-router/.../boundary/error.mjs):
// a route error that is an ErrorResponse (a thrown Response: 401, 410, Shopify's bounce page...) is rendered with
// dangerouslySetInnerHTML, which in a browser never executes the <script> inside it; any other error is rethrown.
import { createElement } from "react";

export const boundary = {
  error: (error) => {
    if (error?.constructor?.name === "ErrorResponse" || error?.constructor?.name === "ErrorResponseImpl") {
      return createElement("div", { dangerouslySetInnerHTML: { __html: error.data || "Handling response" } });
    }
    throw error;
  },
  headers: () => ({}),
};
