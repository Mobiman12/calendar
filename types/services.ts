import type { ColorDurationConfig } from "@/lib/color-consultation";

export type StaffOption = {
  id: string;
  name: string;
  color: string;
};

export type ServiceListEntry = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  duration: number;
  priceVisible: boolean;
  showDurationOnline: boolean;
  onlineBookable: boolean;
  tillhubProductId?: string | null;
  colorConsultationDurations?: ColorDurationConfig | null;
  staffIds: string[];
  addOnServiceIds: string[];
  tags: string[];
  category?: {
    id: string;
    name: string;
    slug: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type ServiceCategoryOption = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  color?: string | null;
};

export type ServiceCategoryListEntry = ServiceCategoryOption & {
  createdAt: string;
  updatedAt: string;
  serviceCount: number;
};

export type ServiceCreateInput = {
  name: string;
  price: number;
  description?: string;
  duration: number;
  staffIds: string[];
  priceVisible: boolean;
  showDurationOnline: boolean;
  onlineBookable: boolean;
  tillhubProductId?: string | null;
  colorConsultationDurations?: ColorDurationConfig | null;
  addOnServiceIds: string[];
  categoryId: string;
  tags: string[];
};

export type ServiceCreateResult = { success: true } | { success: false; error: string };

export type ServiceCategoryCreateInput = {
  name: string;
  description?: string;
  color?: string;
};

export type ServiceCategoryCreateResult = { success: true } | { success: false; error: string };
