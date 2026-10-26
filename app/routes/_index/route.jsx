import { authenticate } from "../../shopify.server";

export const loader = async ({ request }) => {
  const { redirect } = await authenticate.admin(request);

  // Send the authenticated merchant to the existing Dashboard.
  return redirect("/app");
};

export default function AppIndex() {
  // The loader redirects before this component needs to render.
  return null;
}