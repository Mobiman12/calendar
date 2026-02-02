import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { getSessionOrNull } from "@/lib/session";

export default async function BackofficeLayout({ children }: { children: ReactNode }) {
  const session = await getSessionOrNull();
  if (!session) {
    redirect("/auth/login");
  }
  return <div className="backoffice-shell">{children}</div>;
}
