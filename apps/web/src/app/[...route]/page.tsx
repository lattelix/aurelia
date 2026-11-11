import { notFound } from "next/navigation";
// Known legacy player URLs redirect in next.config.ts; unknown paths stay 404.
export default function Page() {
  notFound();
}
