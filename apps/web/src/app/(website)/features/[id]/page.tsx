import { notFound } from "next/navigation";
import { productRegistryV1 } from "@aurelia/core";
import { FeatureDetailPage } from "@/components/website/product-pages";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!productRegistryV1.features.some((feature) => feature.id === id))
    notFound();
  return <FeatureDetailPage id={id} />;
}
