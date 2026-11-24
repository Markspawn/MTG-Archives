import { notFound } from "next/navigation";
import PublicInventoryPage from "@/components/PublicInventoryPage";
import { getPublicInventoryMember } from "@/lib/public-inventory-member";
import { publicWishlistPageUsername } from "@/lib/public-inventory-link";

export const dynamic = "force-dynamic";

export default async function MemberInventoryPage({ params, searchParams }: {
  params: Promise<{ username: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await getPublicInventoryMember(publicWishlistPageUsername((await params).username));
  if (!member) notFound();
  return <PublicInventoryPage member={member} searchParams={searchParams} />;
}
