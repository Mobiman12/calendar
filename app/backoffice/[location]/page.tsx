"use server";

import { redirect } from "next/navigation";

export default async function BackofficeLocationIndex({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location } = await params;
  redirect(`/backoffice/${location}/dashboard`);
}
