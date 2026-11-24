import PublicInventoryPage from "@/components/PublicInventoryPage";
export const dynamic = "force-dynamic";
export default function PublicInventoryIndex({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <PublicInventoryPage searchParams={searchParams} />;
}
